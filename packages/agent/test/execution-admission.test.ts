import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { ResourceScheduler } from "../src/resource-scheduler.ts";
import type { AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done",
			() => message,
		);
		queueMicrotask(() =>
			this.push({
				type: "done",
				reason: "stop",
				message,
			}),
		);
	}
}

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "ok" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const toolSchema = Type.Object({ value: Type.String() });

function createTool(executed: string[]): AgentTool<typeof toolSchema> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo",
		parameters: toolSchema,
		executionResource: { key: "workspace", mode: "exclusive" },
		execute: async (_id, args) => {
			executed.push(args.value);
			return { content: [{ type: "text", text: args.value }], details: {} };
		},
	};
}

describe("final execution admission", () => {
	it("denies after asynchronous policy evaluation without invoking the handler", async () => {
		const executed: string[] = [];
		const observations: Array<{ phase: string; outcome?: string; toolCallId?: string; stepId?: string }> = [];
		let streamCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "run", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [createTool(executed)] },
			{
				model,
				convertToLlm: (messages) =>
					messages.filter(
						(message): message is Message =>
							message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					),
				admitToolCall: async () => ({ allow: false, reason: "authority revoked" }),
				onExecutionEvent: (event) => observations.push(event),
			},
			undefined,
			() => {
				streamCalls++;
				return new MockAssistantStream(
					streamCalls === 1
						? assistantToolCall()
						: {
								...assistantToolCall(),
								content: [{ type: "text", text: "done" }],
								stopReason: "stop",
							},
				);
			},
		);

		const messages = await stream.result();
		expect(executed).toEqual([]);
		expect(observations.some((event) => event.phase === "provider_request" && event.outcome === "started")).toBe(
			true,
		);
		expect(observations).toContainEqual(
			expect.objectContaining({
				phase: "tool_admission",
				outcome: "denied",
				stepId: "run-step-1",
				toolPlanRevision: 1,
				toolCallId: "call-1",
			}),
		);
		expect(observations).toContainEqual(
			expect.objectContaining({ phase: "execution_result", outcome: "denied", stepId: "run-step-1" }),
		);
		expect(observations).not.toContainEqual(expect.objectContaining({ args: expect.anything() }));
		expect(messages).toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				content: [{ type: "text", text: "authority revoked" }],
				isError: true,
			}),
		);
	});

	it("bounds parallel tools through the injected scheduler", async () => {
		let active = 0;
		let maximumActive = 0;
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: toolSchema,
			executionResource: { key: "workspace", mode: "exclusive" },
			execute: async () => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				await Promise.resolve();
				active--;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		let streamCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "run", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model,
				convertToLlm: (messages) =>
					messages.filter(
						(message): message is Message =>
							message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					),
				executionScheduler: new ResourceScheduler(2),
			},
			undefined,
			() => {
				streamCalls++;
				const message =
					streamCalls === 1
						? {
								...assistantToolCall(),
								content: [
									{ type: "toolCall" as const, id: "call-1", name: "echo", arguments: { value: "one" } },
									{ type: "toolCall" as const, id: "call-2", name: "echo", arguments: { value: "two" } },
								],
							}
						: {
								...assistantToolCall(),
								content: [{ type: "text" as const, text: "done" }],
								stopReason: "stop" as const,
							};
				return new MockAssistantStream(message);
			},
		);

		await stream.result();
		expect(maximumActive).toBe(1);
	});
});
