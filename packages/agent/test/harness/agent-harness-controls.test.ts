import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	type Message,
	type Usage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentHarness, HarnessFault, type HarnessTool } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import type { AgentMessage, AgentToolCall, StreamFn } from "../../src/types.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api" as AssistantMessage["api"],
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolCallMessage(call: AgentToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [call],
		api: "test-api" as AssistantMessage["api"],
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function streamFrom(handler: () => AssistantMessage): ReturnType<StreamFn> {
	const stream = createAssistantMessageEventStream();
	stream.end(handler());
	return stream;
}

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

function createHarness(
	session: Session,
	streamFn: StreamFn,
	options: {
		tools?: HarnessTool[];
		steeringMode?: "all" | "one-at-a-time";
		followUpMode?: "all" | "one-at-a-time";
	} = {},
) {
	return AgentHarness.create({
		session,
		models: createModels(),
		model: getModel("google", "gemini-2.5-flash"),
		streamFn,
		tools: options.tools ?? [],
		steeringMode: options.steeringMode,
		followUpMode: options.followUpMode,
	});
}

async function messageRoles(session: Session): Promise<string[]> {
	const entries = await session.findEntries({ order: "oldestFirst" });
	return entries.map((entry) => (entry.type === "message" ? entry.message.role : entry.type));
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block?.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return "";
}

describe("AgentHarness control command ledger (slice 2)", () => {
	it("delivers a steering message at the post-tool safe point, before the next model request", async () => {
		const session = createSession();
		let harnessRef: AgentHarness | undefined;
		const contexts: string[][] = [];
		const tool: HarnessTool & { calls: number } = {
			calls: 0,
			name: "fake_read",
			label: "Fake Read",
			description: "test tool",
			parameters: Type.Object({ path: Type.String() }),
			replay: "safe",
			execute: async () => {
				tool.calls += 1;
				// Steering arrives while the tool batch is still executing.
				await harnessRef!.steer("adjust course");
				return { content: [{ type: "text" as const, text: "data" }], details: {} };
			},
		} as HarnessTool & { calls: number };
		const call: AgentToolCall = { type: "toolCall", id: "call-1", name: "fake_read", arguments: { path: "/x" } };
		let step = 0;
		const streamFn: StreamFn = (_model, context) => {
			step += 1;
			contexts.push(context.messages.map((m: Message) => m.role));
			return streamFrom(() => (step === 1 ? toolCallMessage(call) : assistantMessage("adjusted")));
		};
		const { harness } = await createHarness(session, streamFn, { tools: [tool] });
		harnessRef = harness;

		const result = await harness.prompt("start");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("completed");

		// The steer became a durable user entry between the tool result and the next assistant.
		expect(await messageRoles(session)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
		// The second model request observed the steering message.
		expect(contexts[1]?.filter((role) => role === "user")).toHaveLength(2);

		// Queue record exists and its target entry is committed (consumed).
		const enqueued = await session.findRecords({ lane: "main", type: "queue_enqueued" });
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]).toMatchObject({ queue: "steer" });
		if (enqueued[0]?.type === "queue_enqueued") {
			expect(await session.getEntry(enqueued[0].target.id)).toBeDefined();
		}
	});

	it("drains one steering message per assistant turn in one-at-a-time mode", async () => {
		const session = createSession();
		let harnessRef: AgentHarness | undefined;
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls += 1;
			if (calls === 1) {
				const stream = createAssistantMessageEventStream();
				// Two steers arrive while the first response is streaming.
				void (async () => {
					await harnessRef!.steer("first steer");
					await harnessRef!.steer("second steer");
				})();
				stream.end(assistantMessage("answer 1"));
				return stream;
			}
			return streamFrom(() => assistantMessage(`answer ${calls}`));
		};
		const { harness } = await createHarness(session, streamFn, { steeringMode: "one-at-a-time" });
		harnessRef = harness;
		const result = await harness.prompt("start");
		expect(result.ok).toBe(true);
		// one-at-a-time: each steer gets its own assistant turn → user/assistant pairs interleave.
		expect(await messageRoles(session)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
	});

	it("delivers all queued steering messages at once in all mode", async () => {
		const session = createSession();
		let harnessRef: AgentHarness | undefined;
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls += 1;
			if (calls === 1) {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					await harnessRef!.steer("first steer");
					await harnessRef!.steer("second steer");
				})();
				stream.end(assistantMessage("answer 1"));
				return stream;
			}
			return streamFrom(() => assistantMessage(`answer ${calls}`));
		};
		const { harness } = await createHarness(session, streamFn, { steeringMode: "all" });
		harnessRef = harness;
		const result = await harness.prompt("start");
		expect(result.ok).toBe(true);
		expect(await messageRoles(session)).toEqual(["user", "assistant", "user", "user", "assistant"]);
	});

	it("delivers a follow-up only when the run would stop, then completes", async () => {
		const session = createSession();
		let harnessRef: AgentHarness | undefined;
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls += 1;
			if (calls === 1) {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					await harnessRef!.followUp("after that, summarize");
				})();
				stream.end(assistantMessage("answer 1"));
				return stream;
			}
			return streamFrom(() => assistantMessage("summary"));
		};
		const { harness } = await createHarness(session, streamFn);
		harnessRef = harness;
		const result = await harness.prompt("start");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("completed");
		expect(await messageRoles(session)).toEqual(["user", "assistant", "user", "assistant"]);
		const enqueued = await session.findRecords({ lane: "main", type: "queue_enqueued" });
		expect(enqueued[0]).toMatchObject({ queue: "followUp" });
	});

	it("captures nextRun items as the first messages of the next prompt", async () => {
		const session = createSession();
		const { harness } = await createHarness(session, () => streamFrom(() => assistantMessage("ok")));
		const queued = await harness.nextRun("queued while idle");
		expect(queued.ok).toBe(true);
		const result = await harness.prompt("go");
		expect(result.ok).toBe(true);
		expect(await messageRoles(session)).toEqual(["user", "user", "assistant"]);
		if (queued.ok) expect(await session.getEntry(queued.value.entryId)).toBeDefined();
	});

	it("cancelQueued reports cancelled / already_cleared / already_consumed / unknown", async () => {
		const session = createSession();
		const { harness } = await createHarness(session, () => streamFrom(() => assistantMessage("ok")));

		const unknown = await harness.cancelQueued("missing");
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error._tag).toBe("UnknownQueueItem");

		const first = await harness.nextRun("kept");
		const second = await harness.nextRun("cancelled");
		if (!first.ok || !second.ok) throw new Error("nextRun failed");

		const cancelled = await harness.cancelQueued(second.value.entryId);
		expect(cancelled.ok && cancelled.value.outcome).toBe("cancelled");
		const again = await harness.cancelQueued(second.value.entryId);
		expect(again.ok && again.value.outcome).toBe("already_cleared");

		await harness.prompt("go");
		const consumed = await harness.cancelQueued(first.value.entryId);
		expect(consumed.ok && consumed.value.outcome).toBe("already_consumed");
		// Only the kept nextRun item was captured.
		expect(await messageRoles(session)).toEqual(["user", "user", "assistant"]);
	});

	it("abort drains queued messages, returns them, and never dispatches them", async () => {
		const session = createSession();
		const pending = createAssistantMessageEventStream();
		let streamEntered: () => void = () => undefined;
		const streamCalled = new Promise<void>((resolve) => {
			streamEntered = resolve;
		});
		const { harness } = await createHarness(session, () => {
			streamEntered();
			return pending;
		});
		const running = harness.prompt("start");
		// Wait until the driver is blocked inside the provider call, so the queued
		// commands are guaranteed to be undelivered when abort lands.
		await streamCalled;

		const steer = await harness.steer("steer text");
		const followUp = await harness.followUp("follow-up text");
		expect(steer.ok && followUp.ok).toBe(true);

		const aborted = await harness.abort();
		expect(aborted.ok).toBe(true);
		if (!aborted.ok) return;
		expect(aborted.value.steer.map(messageText)).toEqual(["steer text"]);
		expect(aborted.value.followUp.map(messageText)).toEqual(["follow-up text"]);

		pending.end(assistantMessage("late"));
		const result = await running;
		expect(result.ok && result.value.kind).toBe("aborted");

		// The queued messages were never committed as entries; cancellations are durable.
		expect(await messageRoles(session)).toEqual(["user", "assistant"]);
		const cancellations = await session.findRecords({ lane: "main", type: "queue_cancelled" });
		expect(cancellations).toHaveLength(2);
	});

	it("rejects steer/followUp without an active run", async () => {
		const { harness } = await createHarness(createSession(), () => streamFrom(() => assistantMessage("ok")));
		const steer = await harness.steer("nowhere");
		expect(steer.ok).toBe(false);
		if (!steer.ok) expect(steer.error._tag).toBe("NoActiveRun");
		const followUp = await harness.followUp("nowhere");
		expect(followUp.ok).toBe(false);
		if (!followUp.ok) expect(followUp.error._tag).toBe("NoActiveRun");
	});

	it("a steering command queued before a crash is consumed by resume", async () => {
		const session = createSession();
		let releaseCrash: () => void = () => undefined;
		const crashGate = new Promise<void>((resolve) => {
			releaseCrash = resolve;
		});
		const crashingStreamFn: StreamFn = async () => {
			await crashGate;
			throw new HarnessFault("simulated crash", undefined);
		};
		const first = await createHarness(session, crashingStreamFn);
		const running = first.harness.prompt("start");
		const steer = await first.harness.steer("remember this");
		expect(steer.ok).toBe(true);
		releaseCrash();
		await expect(running).rejects.toBeInstanceOf(HarnessFault);

		let sawSteer = false;
		const streamFn: StreamFn = (_model, context) => {
			if (JSON.stringify(context.messages).includes("remember this")) sawSteer = true;
			return streamFrom(() => assistantMessage("resumed"));
		};
		const recovered = await createHarness(session, streamFn);
		expect(recovered.suspended).toHaveLength(1);
		const resumed = await recovered.harness.resume();
		expect(resumed.ok).toBe(true);
		expect(sawSteer).toBe(true);
		expect(await messageRoles(session)).toEqual(["user", "user", "assistant"]);
	});
});
