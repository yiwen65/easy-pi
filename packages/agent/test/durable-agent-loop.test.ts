import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentOptions } from "../src/agent.ts";
import { Agent } from "../src/agent.ts";
import { ResourceScheduler } from "../src/resource-scheduler.ts";
import type { AgentTool, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "offline",
	name: "offline",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};
const schema = Type.Object({});

function assistant(ids: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: id, arguments: {} })),
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		stopReason: ids.length ? "toolUse" : "stop",
		usage: {
			input: 0,
			output: 0,
			totalTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
		},
	};
}

function tool(name: string, execute: () => Promise<void>): AgentTool<typeof schema, undefined> {
	return {
		name,
		label: name,
		description: name,
		parameters: schema,
		async execute() {
			await execute();
			return { content: [{ type: "text", text: name }], details: undefined };
		},
	};
}

function provider(first: AssistantMessage): StreamFn {
	let calls = 0;
	return () => {
		const stream = createAssistantMessageEventStream();
		const message = calls++ ? assistant() : first;
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		return stream;
	};
}

describe("durable agent boundaries", () => {
	it("persists a fast result before a slow parallel call finishes, preserving transcript order", async () => {
		let releaseSlow: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let resolveFast: () => void = () => {};
		const fastPersisted = new Promise<void>((resolve) => {
			resolveFast = resolve;
		});
		const persisted: string[] = [];
		const agent = new Agent({
			initialState: { model, tools: [tool("slow", () => slow), tool("fast", async () => {})] },
			streamFn: provider(assistant(["slow", "fast"])),
			onToolResult(message) {
				persisted.push(message.toolCallId);
				if (message.toolCallId === "fast") resolveFast();
			},
		});
		const run = agent.prompt("go");
		await fastPersisted;
		expect(persisted).toEqual(["fast"]);
		expect(agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
		releaseSlow();
		await run;
		expect(persisted).toEqual(["fast", "slow"]);
		expect(
			agent.state.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
		).toEqual(["slow", "fast"]);
	});

	it("does not dispatch when its durable dispatch record fails", async () => {
		let effects = 0;
		const scheduler = new ResourceScheduler(1);
		const agent = new Agent({
			initialState: {
				model,
				tools: [
					tool("effect", async () => {
						effects++;
					}),
				],
			},
			streamFn: provider(assistant(["effect"])),
			executionScheduler: scheduler,
			beforeToolDispatch() {
				expect(scheduler.runningCount).toBe(1);
				throw new Error("disk unavailable");
			},
		});
		await agent.prompt("go");
		expect(effects).toBe(0);
		expect(agent.state.errorMessage).toBe("disk unavailable");
		expect(scheduler.runningCount).toBe(0);
	});

	it("drains outstanding parallel completions after a durable result failure", async () => {
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		let failed: () => void = () => {};
		const failure = new Promise<void>((resolve) => {
			failed = resolve;
		});
		const persisted: string[] = [];
		const agent = new Agent({
			initialState: { model, tools: [tool("fast", async () => {}), tool("slow", () => slow)] },
			streamFn: provider(assistant(["fast", "slow"])),
			onToolResult(message) {
				if (message.toolCallId === "fast") {
					failed();
					throw new Error("result commit failed");
				}
				persisted.push(message.toolCallId);
			},
		});
		const run = agent.prompt("go");
		await failure;
		expect(agent.state.isStreaming).toBe(true);
		release();
		await run;
		expect(persisted).toEqual(["slow"]);
		expect(agent.state.errorMessage).toBe("result commit failed");
	});

	it.each(["sequential", "parallel"] as const)("persists preflight errors in %s mode", async (toolExecution) => {
		const persisted: ToolResultMessage[] = [];
		const agent = new Agent({
			initialState: { model },
			streamFn: provider(assistant(["missing"])),
			toolExecution,
			onToolResult(message) {
				persisted.push(message);
			},
		});
		await agent.prompt("go");
		expect(persisted).toHaveLength(1);
		expect(persisted[0].isError).toBe(true);
		expect(agent.state.messages.find((message) => message.role === "toolResult")).toBe(persisted[0]);
	});

	it("awaits completed item persistence before UI delivery and aborts on persistence failure", async () => {
		const message = assistant(["effect"]);
		let effects = 0;
		let updates = 0;
		const agent = new Agent({
			initialState: {
				model,
				tools: [
					tool("effect", async () => {
						effects++;
					}),
				],
			},
			streamFn() {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				const call = message.content[0];
				if (call.type !== "toolCall") throw new Error("fixture");
				stream.push({
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: call,
					partial: message,
					itemComplete: true,
				});
				stream.push({ type: "done", reason: "toolUse", message });
				return stream;
			},
			onCompletedOutputItem() {
				throw new Error("checkpoint write failed");
			},
		});
		agent.subscribe((event) => {
			if (event.type === "message_update") updates++;
		});
		await agent.prompt("go");
		expect(effects).toBe(0);
		expect(updates).toBe(0);
		expect(agent.state.errorMessage).toBe("checkpoint write failed");
	});

	it("recovers only missing calls and feeds the provider source-ordered results", async () => {
		const message = assistant(["missing", "done"]);
		const done: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "done",
			toolName: "done",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 2,
		};
		const executed: string[] = [];
		let providerIds: string[] = [];
		const persisted: string[] = [];
		const options: AgentOptions = {
			initialState: {
				model,
				messages: [{ role: "user", content: "go", timestamp: 0 }, message, done],
				tools: [
					tool("missing", async () => {
						executed.push("missing");
					}),
					tool("done", async () => {
						executed.push("done");
					}),
				],
			},
			streamFn(_model, context) {
				providerIds = context.messages
					.filter((entry) => entry.role === "toolResult")
					.map((entry) => entry.toolCallId);
				return provider(assistant())(_model, context);
			},
			onToolResult(result) {
				persisted.push(result.toolCallId);
			},
		};
		const agent = new Agent(options);
		await expect(agent.resumeToolCalls(message, [])).rejects.toThrow("Invalid recovered tool results");
		expect(agent.state.messages).toEqual(options.initialState?.messages);
		expect(executed).toEqual([]);
		await agent.resumeToolCalls(message, [done]);
		expect(executed).toEqual(["missing"]);
		expect(persisted).toEqual(["missing"]);
		expect(providerIds).toEqual(["missing", "done"]);
		expect(
			agent.state.messages.filter((entry) => entry.role === "toolResult").map((entry) => entry.toolCallId),
		).toEqual(["missing", "done"]);
	});
});
