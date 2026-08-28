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
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import type { AgentToolCall, StreamFn } from "../../src/types.ts";

/**
 * Fault-injection matrix for the durable driver (methodology §14):
 * crash at every safe point, duplicate delivery, cancel before/after dispatch,
 * and resume idempotence. Each scenario asserts the durable log stays
 * consistent and no semantic item is duplicated.
 */

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
	return { ...assistantMessage("calling"), content: [call], stopReason: "toolUse" };
}

function scripted(...handlers: (() => AssistantMessage)[]): StreamFn {
	let index = 0;
	return () => {
		const handler = handlers[Math.min(index, handlers.length - 1)]!;
		index += 1;
		const stream = createAssistantMessageEventStream();
		stream.end(handler());
		return stream;
	};
}

function countingTool(replay?: "never" | "safe"): HarnessTool & { calls: number } {
	const tool = {
		calls: 0,
		name: "fake_tool",
		label: "Fake",
		description: "d",
		parameters: Type.Object({ path: Type.String() }),
		...(replay ? { replay } : {}),
		execute: async () => {
			tool.calls += 1;
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
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

const call: AgentToolCall = { type: "toolCall", id: "call-1", name: "fake_tool", arguments: { path: "/x" } };

describe("durable driver fault-injection matrix", () => {
	it("crash after intent commit but before the first model request resumes cleanly", async () => {
		const session = createSession();
		// Seed exactly the post-intent / pre-step prefix, as a crash would leave it.
		await session.appendRecord({
			type: "operation_started",
			id: "run-seeded",
			lane: "main",
			sourceLeafId: null,
			intent: {
				kind: "run",
				originalPrompt: [{ role: "user", content: [{ type: "text", text: "seeded" }], timestamp: 1 }],
				initialMessages: [
					{
						type: "message",
						id: "seeded-user",
						message: { role: "user", content: [{ type: "text", text: "seeded" }], timestamp: 1 },
					},
				],
			},
		});
		const { harness, suspended } = await createHarness(
			session,
			scripted(() => assistantMessage("after crash")),
		);
		expect(suspended).toHaveLength(1);
		const resumed = await harness.resume();
		expect(resumed.ok && resumed.value.kind).toBe("completed");
		// The initial message was applied exactly once, then the assistant answered.
		const entries = await session.findEntries({ order: "oldestFirst" });
		expect(entries.map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual([
			"user",
			"assistant",
		]);
	});

	it("cancel before any tool dispatch produces no tool_started records", async () => {
		const session = createSession();
		const tool = countingTool("safe");
		let entered = false;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const streamFn: StreamFn = async () => {
			entered = true;
			await gate;
			const stream = createAssistantMessageEventStream();
			stream.end(toolCallMessage(call));
			return stream;
		};
		const { harness } = await createHarness(session, streamFn, [tool]);
		const running = harness.prompt("go");
		while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
		await harness.abort();
		release();
		const result = await running;
		expect(result.ok && result.value.kind).toBe("aborted");
		expect((await session.findRecords({ lane: "main", type: "tool_started" })).length).toBe(0);
		expect(tool.calls).toBe(0);
	});

	it("resume after a crash between final entry and finish record commits exactly one terminal record", async () => {
		const session = createSession();
		// Seed: run whose final assistant entry is committed but operation_finished is missing.
		await session.appendEntry(
			{
				type: "message",
				id: "seeded-user",
				message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 },
			},
			"main",
		);
		await session.appendRecord({
			type: "operation_started",
			id: "run-almost-done",
			lane: "main",
			sourceLeafId: "seeded-user",
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		});
		await session.appendRecord({
			type: "step_attempt",
			id: "attempt-1",
			lane: "main",
			runId: "run-almost-done",
			step: "assistant",
			attempt: 1,
			resultEntryId: "seeded-assistant",
		});
		await session.appendEntry(
			{ type: "message", id: "seeded-assistant", message: assistantMessage("final") },
			"main",
		);
		const { harness, suspended } = await createHarness(
			session,
			scripted(() => assistantMessage("should not be called")),
		);
		expect(suspended).toHaveLength(1);
		const resumed = await harness.resume();
		expect(resumed.ok && resumed.value.kind).toBe("completed");
		const entries = await session.findEntries({ order: "oldestFirst" });
		// No duplicate assistant entry; the only new record is operation_finished.
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(1);
		const finishes = await session.findRecords({ lane: "main", type: "operation_finished" });
		expect(finishes).toHaveLength(1);
	});

	it("a committed tool result is never re-executed or duplicated on resume", async () => {
		const session = createSession();
		const tool = countingTool("safe");
		let first = true;
		const streamFn: StreamFn = () => {
			if (first) {
				first = false;
				const stream = createAssistantMessageEventStream();
				stream.end(toolCallMessage(call));
				return stream;
			}
			// Deliberately thrown to simulate a process crash before continuation.
			throw new HarnessFault("crash before continuation", undefined);
		};
		const { harness } = await createHarness(session, streamFn, [tool]);
		await expect(harness.prompt("go")).rejects.toBeInstanceOf(HarnessFault);
		expect(tool.calls).toBe(1);

		const recovered = await createHarness(
			session,
			scripted(() => assistantMessage("done")),
			[tool],
		);
		const resumed = await recovered.harness.resume();
		expect(resumed.ok && resumed.value.kind).toBe("completed");
		// The result was already committed before the crash: no re-execution, no duplicate.
		expect(tool.calls).toBe(1);
		const results = (await session.findEntries({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(results).toHaveLength(1);
	});

	it("duplicate prompt submission is rejected while the first is active; both queues reject duplicates safely", async () => {
		const session = createSession();
		const pending = createAssistantMessageEventStream();
		const { harness } = await createHarness(session, () => pending);
		const first = harness.prompt("one");
		const duplicate = await harness.prompt("one");
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) expect(duplicate.error._tag).toBe("LaneBusy");
		const queued = await harness.steer("note");
		expect(queued.ok).toBe(true);
		if (!queued.ok) return;
		const cancel1 = await harness.cancelQueued(queued.value.entryId);
		const cancel2 = await harness.cancelQueued(queued.value.entryId);
		expect(cancel1.ok && cancel1.value.outcome).toBe("cancelled");
		expect(cancel2.ok && cancel2.value.outcome).toBe("already_cleared");
		pending.end(assistantMessage("done"));
		await first;
	});
});
