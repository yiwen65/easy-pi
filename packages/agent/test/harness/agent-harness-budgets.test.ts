import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	type Usage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentHarness, type HarnessTool } from "../../src/harness/agent-harness.ts";
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

function errorMessage(text: string): AssistantMessage {
	return { ...assistantMessage(text), stopReason: "error", errorMessage: text };
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

function okTool(): HarnessTool & { calls: number } {
	const tool = {
		calls: 0,
		name: "fake_tool",
		label: "Fake",
		description: "d",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => {
			tool.calls += 1;
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
	return tool as HarnessTool & { calls: number };
}

function failingTool(): HarnessTool {
	return {
		name: "fake_tool",
		label: "Fake",
		description: "d",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => {
			throw new Error("same failure");
		},
	} as HarnessTool;
}

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

function createHarness(
	session: Session,
	streamFn: StreamFn,
	options: {
		tools?: HarnessTool[];
		budgets?: { maxTokens?: number; maxToolCalls?: number; maxDurationMs?: number; maxSteps?: number };
		retry?: { enabled: boolean; maxRetries: number; baseDelayMs: number };
	} = {},
) {
	return AgentHarness.create({
		session,
		models: createModels(),
		model: getModel("google", "gemini-2.5-flash"),
		streamFn,
		tools: options.tools ?? [],
		...(options.budgets ? { budgets: options.budgets } : {}),
		...(options.retry ? { retry: options.retry } : {}),
	});
}

const call: AgentToolCall = { type: "toolCall", id: "call-1", name: "fake_tool", arguments: { path: "/x" } };

describe("AgentHarness budgets, progress, retry, pause (T-004)", () => {
	it("stops with budget_exceeded when the step budget is exhausted", async () => {
		const session = createSession();
		const tool = okTool();
		const { harness } = await createHarness(
			session,
			scripted(() => toolCallMessage(call)),
			{
				tools: [tool],
				budgets: { maxSteps: 2 },
			},
		);
		const result = await harness.prompt("loop forever");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("failed");
		if (result.value.kind !== "failed") return;
		expect(result.value.error.code).toBe("budget_exceeded");
		const attempts = (await session.findRecords({ lane: "main", type: "step_attempt" })).length;
		expect(attempts).toBe(2);
	});

	it("stops with budget_exceeded when the tool-call budget is exhausted", async () => {
		const session = createSession();
		const tool = okTool();
		const { harness } = await createHarness(
			session,
			scripted(() => toolCallMessage(call)),
			{
				tools: [tool],
				budgets: { maxToolCalls: 1 },
			},
		);
		const result = await harness.prompt("loop");
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "failed") throw new Error("expected failed");
		expect(result.value.error.code).toBe("budget_exceeded");
		expect(tool.calls).toBe(1);
	});

	it("stops with budget_exceeded when the duration budget is already exhausted", async () => {
		const session = createSession();
		const { harness } = await createHarness(
			session,
			scripted(() => assistantMessage("done")),
			{
				budgets: { maxDurationMs: 0 },
			},
		);
		const result = await harness.prompt("anything");
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "failed") throw new Error("expected failed");
		expect(result.value.error.code).toBe("budget_exceeded");
		// No provider call happened.
		expect((await session.findRecords({ lane: "main", type: "step_attempt" })).length).toBe(0);
	});

	it("stops with no_progress when the same plan and error repeat", async () => {
		const session = createSession();
		const { harness } = await createHarness(
			session,
			scripted(() => toolCallMessage(call)),
			{
				tools: [failingTool()],
			},
		);
		const result = await harness.prompt("loop");
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "failed") throw new Error("expected failed");
		expect(result.value.error.code).toBe("no_progress");
	});

	it("stops with no_progress when repeats differ only in volatile provider fields and prose", async () => {
		const session = createSession();
		let turn = 0;
		const { harness } = await createHarness(
			session,
			scripted(() => {
				turn += 1;
				const message = toolCallMessage({ ...call, id: `call-${turn}` });
				message.content.unshift({ type: "text", text: `narration for attempt ${turn}` });
				message.responseId = `resp-${turn}`;
				message.usage = { ...usage, input: turn, totalTokens: turn + 1 };
				return message;
			}),
			{
				tools: [failingTool()],
			},
		);
		const result = await harness.prompt("loop");
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "failed") throw new Error("expected failed");
		expect(result.value.error.code).toBe("no_progress");
	});

	it("retries a transient provider error with a bounded backoff and one logical result", async () => {
		const session = createSession();
		const { harness } = await createHarness(
			session,
			scripted(
				() => errorMessage("529 overloaded"),
				() => assistantMessage("recovered"),
			),
			{ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		);
		const result = await harness.prompt("hello");
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "completed") throw new Error("expected completed");

		const records = (await session.findRecords({ lane: "main" })).reverse();
		const attempts = records.filter((record) => record.type === "step_attempt");
		expect(attempts).toHaveLength(2);
		if (attempts[0]?.type === "step_attempt" && attempts[1]?.type === "step_attempt") {
			expect(attempts[1].attempt).toBe(2);
			expect(attempts[0].resultEntryId).toBe(attempts[1].resultEntryId);
		}
		// The transient error message is never persisted as an entry.
		const assistants = (await session.findEntries({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
	});

	it("persists the error and fails after the retry budget is exhausted", async () => {
		const session = createSession();
		const { harness } = await createHarness(
			session,
			scripted(() => errorMessage("still overloaded")),
			{
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			},
		);
		const result = await harness.prompt("hello");
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "failed") throw new Error("expected failed");
		expect(result.value.error.code).toBe("step_failed");
		expect((await session.findRecords({ lane: "main", type: "step_attempt" })).length).toBe(2);
		const assistants = (await session.findEntries({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
	});

	it("pause suspends the run at a safe point and resume continues it", async () => {
		const session = createSession();
		let enteredSecond = false;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const streamFn: StreamFn = async () => {
			calls += 1;
			if (calls === 2) {
				enteredSecond = true;
				await gate;
			}
			const stream = createAssistantMessageEventStream();
			stream.end(calls === 1 ? toolCallMessage(call) : assistantMessage("finished"));
			return stream;
		};
		const tool = okTool();
		const { harness } = await createHarness(session, streamFn, { tools: [tool] });
		const running = harness.prompt("start");
		// Wait for the driver to be inside the second provider call, then pause.
		while (!enteredSecond) await new Promise((resolve) => setTimeout(resolve, 1));
		const paused = await harness.pause();
		expect(paused.ok).toBe(true);
		release();
		const first = await running;
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.kind).toBe("paused");
		// The operation is still open and resumable.
		const lanes = await harness.lanes();
		expect(lanes[0]?.operation).toMatchObject({ kind: "run", status: "suspended" });

		const resumed = await harness.resume();
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.kind).toBe("completed");
	});

	it("abort wins over pause", async () => {
		const session = createSession();
		let entered = false;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const streamFn: StreamFn = async () => {
			entered = true;
			await gate;
			const stream = createAssistantMessageEventStream();
			stream.end(assistantMessage("late"));
			return stream;
		};
		const { harness } = await createHarness(session, streamFn);
		const running = harness.prompt("start");
		while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
		await harness.pause();
		await harness.abort();
		release();
		const result = await running;
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("aborted");
	});
});
