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
import type { AgentToolCall, StreamFn, ToolExecutionInfo } from "../../src/types.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

interface FakeToolOptions {
	contract?: HarnessTool["contract"];
	replay?: "never" | "safe";
	execute: (info: ToolExecutionInfo | undefined) => Promise<string>;
}

function fakeTool(options: FakeToolOptions): HarnessTool & { calls: number; infos: (ToolExecutionInfo | undefined)[] } {
	const tool = {
		calls: 0,
		infos: [] as (ToolExecutionInfo | undefined)[],
		name: "fake_tool",
		label: "Fake Tool",
		description: "test tool",
		parameters: Type.Object({ path: Type.String() }),
		...(options.replay ? { replay: options.replay } : {}),
		...(options.contract ? { contract: options.contract } : {}),
		execute: async (_id: string, _params: { path: string }) => {
			tool.calls += 1;
			tool.infos.push(undefined);
			const text = await options.execute(undefined);
			return { content: [{ type: "text" as const, text }], details: {} };
		},
		executeWithInfo: async (
			_id: string,
			_params: { path: string },
			_signal: unknown,
			_onUpdate: unknown,
			info: ToolExecutionInfo,
		) => {
			tool.calls += 1;
			tool.infos.push(info);
			const text = await options.execute(info);
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	};
	return tool as HarnessTool & { calls: number; infos: (ToolExecutionInfo | undefined)[] };
}

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
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

function createHarness(session: Session, streamFn: StreamFn, tools: HarnessTool[]) {
	return AgentHarness.create({
		session,
		models: createModels(),
		model: getModel("google", "gemini-2.5-flash"),
		streamFn,
		tools,
	});
}

const call: AgentToolCall = { type: "toolCall", id: "call-1", name: "fake_tool", arguments: { path: "/x" } };

describe("AgentHarness tool gateway (T-003)", () => {
	it("passes a stable execution identity into execute and records operationId", async () => {
		const session = createSession();
		const tool = fakeTool({ execute: async () => "ok" });
		const { harness } = await createHarness(
			session,
			scripted(
				() => toolCallMessage(call),
				() => assistantMessage("done"),
			),
			[tool],
		);
		const result = await harness.prompt("go");
		expect(result.ok && result.value.kind).toBe("completed");
		if (!result.ok) return;

		expect(tool.calls).toBe(1);
		const info = tool.infos[0];
		expect(info).toBeDefined();
		expect(info!.runId).toBe(result.value.runId);
		expect(info!.toolCallId).toBe("call-1");
		expect(info!.attempt).toBe(1);
		expect(info!.operationId).toContain(result.value.runId);

		const started = (await session.findRecords({ lane: "main", type: "tool_started" }))[0];
		expect(started?.operationId).toBe(info!.operationId);
	});

	it("retries an idempotent tool with incrementing attempts and one logical result", async () => {
		const session = createSession();
		let failures = 1;
		const tool = fakeTool({
			contract: { idempotent: true, retry: { maxRetries: 2 } },
			execute: async () => {
				if (failures > 0) {
					failures -= 1;
					throw new Error("transient");
				}
				return "recovered";
			},
		});
		const { harness } = await createHarness(
			session,
			scripted(
				() => toolCallMessage(call),
				() => assistantMessage("done"),
			),
			[tool],
		);
		const result = await harness.prompt("go");
		expect(result.ok && result.value.kind).toBe("completed");
		expect(tool.calls).toBe(2);
		expect(tool.infos.map((info) => info?.attempt)).toEqual([1, 2]);
		// Same logical operation across attempts.
		expect(tool.infos[0]?.operationId).toBe(tool.infos[1]?.operationId);

		const entries = await session.findEntries({ order: "oldestFirst" });
		const results = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(results).toHaveLength(1);
		if (results[0]?.type === "message" && results[0].message.role === "toolResult") {
			expect(results[0].message.isError).toBe(false);
			expect(results[0].message.content).toEqual([{ type: "text", text: "recovered" }]);
		}
	});

	it("never retries a side-effecting non-idempotent tool", async () => {
		const session = createSession();
		const tool = fakeTool({
			contract: { sideEffects: "filesystem", retry: { maxRetries: 3 } },
			execute: async () => {
				throw new Error("disk exploded");
			},
		});
		const { harness } = await createHarness(
			session,
			scripted(
				() => toolCallMessage(call),
				() => assistantMessage("done"),
			),
			[tool],
		);
		const result = await harness.prompt("go");
		expect(result.ok).toBe(true);
		expect(tool.calls).toBe(1);
		const results = (await session.findEntries({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(results).toHaveLength(1);
		if (results[0]?.type === "message" && results[0].message.role === "toolResult") {
			expect(results[0].message.isError).toBe(true);
			expect(JSON.stringify(results[0].message.content)).toContain("disk exploded");
		}
	});

	it("a tool timeout becomes an unknown-outcome result, not a silent failure", async () => {
		const session = createSession();
		const tool = fakeTool({
			contract: { timeoutMs: 20 },
			execute: async () => new Promise<string>(() => undefined),
		});
		const { harness } = await createHarness(
			session,
			scripted(
				() => toolCallMessage(call),
				() => assistantMessage("done"),
			),
			[tool],
		);
		const result = await harness.prompt("go");
		expect(result.ok && result.value.kind).toBe("completed");
		const results = (await session.findEntries({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(results).toHaveLength(1);
		if (results[0]?.type === "message" && results[0].message.role === "toolResult") {
			expect(results[0].message.isError).toBe(true);
			expect(JSON.stringify(results[0].message.content)).toMatch(/timeout|unknown/i);
		}
	});

	it("approval-required tools fail closed without an approval channel and never execute", async () => {
		const session = createSession();
		const tool = fakeTool({
			contract: { approval: "required" },
			execute: async () => "should never run",
		});
		const { harness } = await createHarness(
			session,
			scripted(
				() => toolCallMessage(call),
				() => assistantMessage("done"),
			),
			[tool],
		);
		const result = await harness.prompt("go");
		expect(result.ok && result.value.kind).toBe("completed");
		expect(tool.calls).toBe(0);
		expect((await session.findRecords({ lane: "main", type: "tool_started" })).length).toBe(0);
		const results = (await session.findEntries({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		if (results[0]?.type === "message" && results[0].message.role === "toolResult") {
			expect(results[0].message.isError).toBe(true);
			expect(JSON.stringify(results[0].message.content)).toMatch(/approval/i);
		} else {
			expect.unreachable("blocked result entry must exist");
		}
	});

	it("derives replay:'safe' from a read-only contract when replay is not explicit", async () => {
		const session = createSession();
		let crash = true;
		const tool = fakeTool({
			contract: { readOnly: true },
			execute: async () => {
				if (crash) {
					crash = false;
					throw new HarnessFault("simulated crash after dispatch", undefined);
				}
				return "read data";
			},
		});
		const first = await createHarness(
			session,
			scripted(() => toolCallMessage(call)),
			[tool],
		);
		await expect(first.harness.prompt("go")).rejects.toBeInstanceOf(HarnessFault);
		expect(tool.calls).toBe(1);

		const started = (await session.findRecords({ lane: "main", type: "tool_started" }))[0];
		expect(started?.replay).toBe("safe");

		const recovered = await createHarness(
			session,
			scripted(() => assistantMessage("done")),
			[tool],
		);
		const resumed = await recovered.harness.resume();
		expect(resumed.ok).toBe(true);
		// Read-only contract → replay-safe → executed again after the crash.
		expect(tool.calls).toBe(2);
	});
});
