import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import { NodeExecutionEnv } from "../src/harness/env/nodejs.ts";
import { createBashTool } from "../src/harness/tools/bash.ts";
import { type AgentEvent, type AgentTool, AgentToolError, type ToolExecutionMode } from "../src/types.ts";
import { createTempDir } from "./harness/session-test-utils.ts";

async function executeFailure<T extends TSchema, D>(
	tool: AgentTool<T, D>,
	args: Record<string, unknown>,
	mode: ToolExecutionMode,
) {
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
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "toolCall", id: "call", name: tool.name, arguments: args }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
	const events: AgentEvent[] = [];
	let hookDetails: unknown;
	const messages = await runAgentLoop(
		[{ role: "user", content: "Execute the test tool", timestamp: 0 }],
		{ systemPrompt: "", messages: [], tools: [tool] },
		{
			model,
			toolExecution: mode,
			convertToLlm: (messages) =>
				messages.filter(
					(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				),
			shouldStopAfterTurn: () => true,
			afterToolCall: async ({ result, isError }) => {
				expect(isError).toBe(true);
				hookDetails = result.details;
				return undefined;
			},
		},
		(event) => {
			events.push(event);
		},
		undefined,
		() => {
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => (event.type === "done" ? event.message : message),
			);
			stream.push({ type: "done", reason: "toolUse", message });
			return stream;
		},
	);
	return {
		result: messages.find((message) => message.role === "toolResult"),
		end: events.find((event) => event.type === "tool_execution_end"),
		hookDetails,
	};
}

describe.each(["parallel", "sequential"] as const)("structured tool errors (%s)", (mode) => {
	it("preserves explicitly safe details in hooks, events, and tool messages", async () => {
		const details = { exitCode: 7, timedOut: false };
		const tool: AgentTool = {
			name: "failure",
			label: "failure",
			description: "test",
			parameters: Type.Object({}),
			execute: async () => {
				throw new AgentToolError("Command exited with code 7", details);
			},
		};
		const result = await executeFailure(tool, {}, mode);
		expect(result.result).toMatchObject({
			isError: true,
			details,
			content: [{ type: "text", text: "Command exited with code 7" }],
		});
		expect(result.end).toMatchObject({ isError: true, result: { details } });
		expect(result.hookDetails).toEqual(details);
	});

	it("does not expose arbitrary details or cause fields on ordinary errors", async () => {
		const tool: AgentTool = {
			name: "failure",
			label: "failure",
			description: "test",
			parameters: Type.Object({}),
			execute: async () => {
				throw Object.assign(new Error("ordinary error", { cause: new Error("internal") }), {
					details: { internal: "not public" },
				});
			},
		};
		const result = await executeFailure(tool, {}, mode);
		expect(result.result).toMatchObject({
			isError: true,
			details: {},
			content: [{ type: "text", text: "ordinary error" }],
		});
		expect(result.hookDetails).toEqual({});
	});

	it("retains the unified Bash exit status on a real failed command", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const bash = createBashTool();
		const result = await executeFailure(
			{
				...bash,
				execute: (id, input, signal, onUpdate) => bash.execute(id, input, signal, onUpdate, { env }),
			},
			{ command: "printf failure; exit 7" },
			mode,
		);
		expect(result.result).toMatchObject({
			isError: true,
			details: { exitCode: 7, terminationReason: "exit" },
			content: [{ text: "failure\n\nCommand exited with code 7" }],
		});
	});
});
