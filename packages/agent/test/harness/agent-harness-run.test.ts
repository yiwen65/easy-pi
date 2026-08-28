import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	type Usage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentHarness, HarnessFault, type HarnessTool } from "../../src/harness/agent-harness.ts";
import { RecordLogCorruption } from "../../src/harness/reducer.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import type { AgentToolCall, StreamFn } from "../../src/types.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api" as AssistantMessage["api"],
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason,
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

function staticStreamFn(message: () => AssistantMessage): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		stream.end(message());
		return stream;
	};
}

function scriptedStreamFn(...handlers: (() => AssistantMessage)[]): StreamFn {
	let index = 0;
	return () => {
		const handler = handlers[Math.min(index, handlers.length - 1)]!;
		index += 1;
		const stream = createAssistantMessageEventStream();
		stream.end(handler());
		return stream;
	};
}

interface FakeToolOptions {
	replay?: "never" | "safe";
	execute: (params: { path: string }) => Promise<string>;
}

function fakeTool(options: FakeToolOptions): HarnessTool & { calls: number } {
	const tool = {
		calls: 0,
		name: "fake_read",
		label: "Fake Read",
		description: "test tool",
		parameters: Type.Object({ path: Type.String() }),
		replay: options.replay,
		execute: async (_id: string, params: { path: string }) => {
			tool.calls += 1;
			const text = await options.execute(params);
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	};
	return tool as HarnessTool & { calls: number };
}

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

function createHarness(session: Session, streamFn: StreamFn, tools: HarnessTool[] = []) {
	return AgentHarness.create({
		session,
		models: createModels(),
		model: getModel("google", "gemini-2.5-flash"),
		streamFn,
		tools,
	});
}

describe("AgentHarness durable run (slice 1)", () => {
	it("completes a simple prompt and persists the full record chain", async () => {
		const session = createSession();
		const { harness, suspended } = await createHarness(
			session,
			staticStreamFn(() => assistantMessage("hello back")),
		);
		expect(suspended).toEqual([]);

		const events: string[] = [];
		harness.events.on("run_start", () => {
			events.push("start");
		});
		harness.events.on("run_end", () => {
			events.push("end");
		});

		const result = await harness.prompt("hello");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("completed");
		if (result.value.kind !== "completed") return;
		expect(result.value.finalMessage.content).toEqual([{ type: "text", text: "hello back" }]);
		expect(events).toEqual(["start", "end"]);

		const entries = await session.findEntries({ order: "oldestFirst" });
		expect(entries.map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual([
			"user",
			"assistant",
		]);
		const records = (await session.findRecords({ lane: "main" })).reverse();
		expect(records.map((record) => record.type)).toEqual([
			"operation_started",
			"step_attempt",
			"usage",
			"operation_finished",
		]);
		expect(await harness.getLeafId()).toBe(result.value.finalEntryId);
	});

	it("executes a tool call, persists started/result, and continues to completion", async () => {
		const session = createSession();
		const tool = fakeTool({ replay: "safe", execute: async (params) => `data:${params.path}` });
		const call: AgentToolCall = { type: "toolCall", id: "call-1", name: "fake_read", arguments: { path: "/x" } };
		const streamFn = scriptedStreamFn(
			() => toolCallMessage(call),
			() => assistantMessage("done"),
		);
		const { harness } = await createHarness(session, streamFn, [tool]);

		const result = await harness.prompt("read something");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("completed");
		expect(tool.calls).toBe(1);

		const records = (await session.findRecords({ lane: "main" })).reverse();
		const toolStarted = records.find((record) => record.type === "tool_started");
		expect(toolStarted).toMatchObject({
			runId: result.value.runId,
			toolCallId: "call-1",
			toolName: "fake_read",
			effectiveArgs: { path: "/x" },
			replay: "safe",
		});
		const attempts = records.filter((record) => record.type === "step_attempt");
		expect(attempts).toHaveLength(2);

		const entries = await session.findEntries({ order: "oldestFirst" });
		const roles = entries.map((entry) => (entry.type === "message" ? entry.message.role : entry.type));
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const toolResult = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(toolResult).toMatchObject({ type: "message" });
		if (toolResult?.type === "message" && toolResult.message.role === "toolResult") {
			expect(toolResult.message.content).toEqual([{ type: "text", text: "data:/x" }]);
			expect(toolResult.message.isError).toBe(false);
		}
	});

	it("rejects a second prompt while a run is active", async () => {
		const session = createSession();
		const pending = createAssistantMessageEventStream();
		const { harness } = await createHarness(session, () => pending);
		const first = harness.prompt("first");
		const second = await harness.prompt("second");
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error._tag).toBe("LaneBusy");
		pending.end(assistantMessage("done"));
		const finished = await first;
		expect(finished.ok).toBe(true);
	});

	it("restores a crashed run and resumes the same logical step", async () => {
		const session = createSession();
		const crashing: StreamFn = () => {
			throw new HarnessFault("simulated crash", undefined);
		};
		const first = await createHarness(session, crashing);
		await expect(first.harness.prompt("hello")).rejects.toBeInstanceOf(HarnessFault);

		const recovered = await createHarness(
			session,
			staticStreamFn(() => assistantMessage("recovered")),
		);
		expect(recovered.suspended).toHaveLength(1);
		expect(recovered.suspended[0]).toMatchObject({ lane: "main", kind: "run", reason: "crash" });

		const resumed = await recovered.harness.resume();
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.operation).toBe("run");
		expect(resumed.value.kind).toBe("completed");

		// The logical step was retried as attempt 2 with the SAME result entry id;
		// exactly one assistant entry exists — no duplicate semantic items.
		const records = (await session.findRecords({ lane: "main" })).reverse();
		const attempts = records.filter((record) => record.type === "step_attempt");
		expect(attempts).toHaveLength(2);
		if (attempts[0]?.type === "step_attempt" && attempts[1]?.type === "step_attempt") {
			expect(attempts[0].attempt).toBe(1);
			expect(attempts[1].attempt).toBe(2);
			expect(attempts[0].resultEntryId).toBe(attempts[1].resultEntryId);
		}
		const entries = await session.findEntries({ order: "oldestFirst" });
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(1);
	});

	it("does not replay a replay:'never' tool after a crash; the result records the unknown outcome", async () => {
		const session = createSession();
		const crashingTool = fakeTool({
			replay: "never",
			execute: async () => {
				throw new HarnessFault("simulated crash after dispatch", undefined);
			},
		});
		const call: AgentToolCall = { type: "toolCall", id: "call-1", name: "fake_read", arguments: { path: "/x" } };
		const first = await createHarness(
			session,
			staticStreamFn(() => toolCallMessage(call)),
			[crashingTool],
		);
		await expect(first.harness.prompt("go")).rejects.toBeInstanceOf(HarnessFault);
		expect(crashingTool.calls).toBe(1);

		const recovered = await createHarness(
			session,
			staticStreamFn(() => assistantMessage("recovered")),
			[crashingTool],
		);
		const resumed = await recovered.harness.resume();
		expect(resumed.ok).toBe(true);
		// Not replayed: the tool still ran exactly once.
		expect(crashingTool.calls).toBe(1);

		const entries = await session.findEntries({ order: "oldestFirst" });
		const toolResult = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		if (toolResult?.type === "message" && toolResult.message.role === "toolResult") {
			expect(toolResult.message.isError).toBe(true);
			expect(JSON.stringify(toolResult.message.content)).toMatch(/unknown|not replay/i);
		} else {
			expect.unreachable("tool result entry must exist");
		}
	});

	it("re-executes a replay:'safe' tool after a crash with the same result entry id", async () => {
		const session = createSession();
		let crash = true;
		const tool = fakeTool({
			replay: "safe",
			execute: async (params) => {
				if (crash) {
					crash = false;
					throw new HarnessFault("simulated crash after dispatch", undefined);
				}
				return `data:${params.path}`;
			},
		});
		const call: AgentToolCall = { type: "toolCall", id: "call-1", name: "fake_read", arguments: { path: "/x" } };
		const first = await createHarness(
			session,
			staticStreamFn(() => toolCallMessage(call)),
			[tool],
		);
		await expect(first.harness.prompt("go")).rejects.toBeInstanceOf(HarnessFault);
		expect(tool.calls).toBe(1);

		const recovered = await createHarness(
			session,
			scriptedStreamFn(() => assistantMessage("after tool")),
			[tool],
		);
		const resumed = await recovered.harness.resume();
		expect(resumed.ok).toBe(true);
		expect(tool.calls).toBe(2);

		const records = (await session.findRecords({ lane: "main" })).reverse();
		const started = records.find((record) => record.type === "tool_started");
		expect(started?.type === "tool_started" && started.replay === "safe").toBe(true);
		const toolResults = (await session.findEntries({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(toolResults).toHaveLength(1);
		if (started?.type === "tool_started") expect(toolResults[0]?.id).toBe(started.resultEntryId);
	});

	it("abort during a run finishes the operation as aborted", async () => {
		const session = createSession();
		let harnessRef: AgentHarness | undefined;
		const streamFn: StreamFn = () => {
			void harnessRef?.abort();
			const stream = createAssistantMessageEventStream();
			stream.end(assistantMessage("late answer"));
			return stream;
		};
		const { harness } = await createHarness(session, streamFn);
		harnessRef = harness;
		const result = await harness.prompt("hello");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("aborted");
		const records = (await session.findRecords({ lane: "main" })).reverse();
		expect(records.some((record) => record.type === "abort_requested")).toBe(true);
		expect(records.at(-1)).toMatchObject({ type: "operation_finished", outcome: "aborted" });
	});

	it("resume without an open operation returns NothingToResume", async () => {
		const { harness } = await createHarness(
			session0(),
			staticStreamFn(() => assistantMessage("x")),
		);
		const result = await harness.resume();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error._tag).toBe("NothingToResume");
	});

	it("create rejects a corrupted record log (record after finish)", async () => {
		const session = createSession();
		await session.appendRecord({
			type: "operation_started",
			id: "run-1",
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		});
		await session.appendRecord({
			type: "operation_finished",
			id: "fin-1",
			lane: "main",
			runId: "run-1",
			outcome: "completed",
		});
		// A record that follows its operation's finish is corruption the reducer
		// must refuse to repair or continue.
		await session.appendRecord({
			type: "usage",
			id: "usage-1",
			lane: "main",
			cause: "adjustment",
			runId: "run-1",
			usage,
		});
		await expect(
			createHarness(
				session,
				staticStreamFn(() => assistantMessage("x")),
			),
		).rejects.toBeInstanceOf(RecordLogCorruption);
	});
});

function session0(): Session {
	return createSession("idle");
}
