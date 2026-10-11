import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { runAgentLoop, runAgentLoopResumeTools } from "../src/agent-loop.ts";
import type { AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "Mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "http://localhost.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function user(content: string): Message {
	return { role: "user", content, timestamp: Date.now() };
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
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
		timestamp: Date.now(),
	};
}

function response(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse" | "length", message });
		}
	});
	return stream;
}

const convertToLlm = (messages: AgentMessage[]): Message[] =>
	messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);

const echoParameters = Type.Object({ value: Type.String() });

function echo(executed: string[], tag: string): AgentTool<typeof echoParameters> {
	return {
		name: "echo",
		label: "Echo",
		description: tag,
		parameters: echoParameters,
		execute: async (_id, args) => {
			executed.push(`${tag}:${args.value}`);
			return { content: [{ type: "text", text: tag }], details: {} };
		},
	};
}

describe("prepareRequest boundary", () => {
	it("awaits selected input events before first and queued requests without polling extra input", async () => {
		const order: string[] = [];
		const requests: Context[] = [];
		let steeringPolls = 0;
		let followUpPolls = 0;
		let queuedDuringPreparation = false;
		const signal = new AbortController().signal;
		const config: AgentLoopConfig = {
			model,
			convertToLlm,
			getSteeringMessages: async () => {
				steeringPolls++;
				if (steeringPolls === 1) return [user("selected steering")];
				if (queuedDuringPreparation) {
					queuedDuringPreparation = false;
					return [user("late steering")];
				}
				return [];
			},
			getFollowUpMessages: async () => (++followUpPolls === 1 ? [user("follow up")] : []),
			prepareRequest: async ({ context, model: currentModel, thinkingLevel }, requestSignal) => {
				expect(requestSignal).toBe(signal);
				expect(currentModel).toBe(model);
				expect(thinkingLevel).toBe("off");
				order.push(`prepare:${context.messages.length}`);
				if (requests.length === 0) queuedDuringPreparation = true;
				await Promise.resolve();
			},
		};
		await runAgentLoop(
			[user("prompt")],
			{ systemPrompt: "", messages: [] },
			config,
			async (event) => {
				if (event.type === "message_end" && event.message.role === "user") {
					await Promise.resolve();
					order.push(`persist:${event.message.content}`);
				}
			},
			signal,
			(_model, context) => {
				requests.push(structuredClone(context));
				order.push("provider");
				return response(assistant([{ type: "text", text: "done" }]));
			},
		);
		expect(order).toEqual([
			"persist:prompt",
			"persist:selected steering",
			"prepare:2",
			"provider",
			"persist:late steering",
			"prepare:4",
			"provider",
			"persist:follow up",
			"prepare:6",
			"provider",
		]);
		expect(
			requests[0].messages.filter((message) => message.role === "user").map((message) => message.content),
		).toEqual(["prompt", "selected steering"]);
		expect(steeringPolls).toBe(4);
		expect(followUpPolls).toBe(2);
	});

	it("binds the updated model, thinking and tool schema/handler only after preparation", async () => {
		const executed: string[] = [];
		const firstTool = echo(executed, "old");
		const preparedTool = echo(executed, "prepared");
		const nextModel = { ...model, id: "prepared-model" };
		let requests = 0;
		const agent = new Agent({
			initialState: { model, tools: [firstTool] },
			prepareRequest: ({ context }) => ({
				context: { ...context, systemPrompt: "prepared system", tools: [preparedTool] },
				model: nextModel,
				thinkingLevel: requests === 0 ? "high" : "off",
			}),
			streamFn: (requestModel, context, options) => {
				expect(requestModel.id).toBe("prepared-model");
				expect(context.systemPrompt).toBe("prepared system");
				expect(context.tools?.[0].description).toBe("prepared");
				expect(options?.reasoning).toBe(requests === 0 ? "high" : undefined);
				// Mutating the source after the request starts must not replace this step's binding.
				preparedTool.execute = firstTool.execute;
				return response(
					++requests === 1
						? assistant([{ type: "toolCall", id: "call", name: "echo", arguments: { value: "ok" } }], "toolUse")
						: assistant([{ type: "text", text: "done" }]),
				);
			},
		});
		// Agent-backed requests resolve the live system layer separately.
		agent.state.systemPrompt = "prepared system";
		await agent.prompt("run");
		expect(requests).toBe(2);
		expect(executed).toEqual(["prepared:ok"]);
	});

	it("prepares retry and text-only checkpoint continuations without adding input", async () => {
		let preparations = 0;
		let requests = 0;
		const agent = new Agent({
			initialState: { model },
			prepareRequest: ({ context }) => {
				preparations++;
				expect(context.messages.filter((message) => message.role === "user")).toHaveLength(1);
			},
			streamFn: () =>
				response(
					++requests === 1
						? { ...assistant([], "error"), errorMessage: "socket disconnected" }
						: assistant([{ type: "text", text: "done" }]),
				),
		});
		await agent.prompt("initial input");
		agent.state.messages = agent.state.messages.slice(0, -1);
		await agent.continue();
		const checkpoint: AssistantMessage = {
			...assistant([{ type: "text", text: "completed item" }]),
			isResponseCheckpoint: true,
		};
		agent.state.messages = [user("initial input"), checkpoint];
		await agent.continue();
		expect(preparations).toBe(3);
		expect(requests).toBe(3);
	});

	it("prepares the provider call after recovered results persist without replaying completed tools", async () => {
		const executed: string[] = [];
		const recovered = assistant(
			[
				{ type: "toolCall", id: "done", name: "echo", arguments: { value: "done" } },
				{ type: "toolCall", id: "pending", name: "echo", arguments: { value: "pending" } },
			],
			"toolUse",
		);
		const completed = {
			role: "toolResult" as const,
			toolCallId: "done",
			toolName: "echo",
			content: [],
			isError: false,
			timestamp: Date.now(),
		};
		const order: string[] = [];
		const streamFn: StreamFn = (_model, context) => {
			order.push("provider");
			expect(
				context.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
			).toEqual(["done", "pending"]);
			return response(assistant([{ type: "text", text: "resumed" }]));
		};
		await runAgentLoopResumeTools(
			{ systemPrompt: "", messages: [user("run"), recovered, completed], tools: [echo(executed, "recovery")] },
			recovered,
			[completed],
			{
				model,
				convertToLlm,
				prepareNextTurn: () => {
					order.push("next turn");
					return undefined;
				},
				prepareRequest: ({ context }) => {
					order.push("prepare");
					expect(context.messages.at(-1)?.role).toBe("toolResult");
				},
				onToolResult: (message) => {
					order.push(`persist:${message.toolCallId}`);
				},
			},
			() => {},
			undefined,
			streamFn,
		);
		expect(executed).toEqual(["recovery:pending"]);
		expect(order).toEqual(["persist:pending", "next turn", "prepare", "provider"]);
	});

	it.each(["error", "aborted"] as const)(
		"does not prepare a continuation after a %s hard exit",
		async (stopReason) => {
			let preparations = 0;
			let requests = 0;
			const agent = new Agent({
				initialState: { model },
				prepareRequest: () => {
					preparations++;
				},
				streamFn: () => {
					requests++;
					return response(assistant([], stopReason));
				},
			});
			agent.followUp(user("leave queued"));
			await agent.prompt("run");
			expect(preparations).toBe(1);
			expect(requests).toBe(1);
			expect(agent.hasQueuedMessages()).toBe(true);
		},
	);
});
