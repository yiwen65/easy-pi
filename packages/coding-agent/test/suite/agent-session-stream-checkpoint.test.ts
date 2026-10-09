import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamCodex } from "../../../ai/src/api/openai-codex-responses.ts";
import { createHarness, type Harness } from "./harness.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "Offline checkpoint test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "http://127.0.0.1:1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
};
const token = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-checkpoint" } }),
).toString("base64")}.bbb`;

function toolItem(callId: string, text: string, status = "completed"): unknown {
	return {
		type: "response.output_item.done",
		output_index: 1,
		item: {
			type: "function_call",
			id: `fc_${callId}`,
			call_id: callId,
			name: "record",
			arguments: JSON.stringify({ text }),
			status,
		},
	};
}

function textItem(text: string): unknown {
	return {
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "message",
			id: "msg_complete",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text }],
		},
	};
}

function installStreams(harness: Harness, streams: unknown[][], contexts: Context[]): void {
	const fallback = harness.session.agent.streamFunction;
	harness.session.agent.streamFunction = (requestModel, context, options) => {
		contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
		const frames = streams.shift();
		if (!frames) return fallback(requestModel, context, options);
		return streamCodex(model, context, {
			apiKey: token,
			transport: "sse",
			maxRetries: 0,
			signal: options?.signal,
			fetch: async () =>
				new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				}),
		});
	};
}

describe("AgentSession completed stream item recovery", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("persists complete calls before execution, excludes incomplete calls, and retries from tool results", async () => {
		const runs: string[] = [];
		let harness: Harness;
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Record a test effect",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, args) => {
				expect(harness.sessionManager.getEntries()).toContainEqual(
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({ stopReason: "toolUse", isResponseCheckpoint: true }),
					}),
				);
				const text = typeof args === "object" && args !== null && "text" in args ? String(args.text) : "";
				runs.push(text);
				return { content: [{ type: "text", text: `recorded:${text}` }], details: {} };
			},
		};
		harness = await createHarness({
			tools: [tool],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const contexts: Context[] = [];
		installStreams(
			harness,
			[
				[
					textItem("completed plan"),
					toolItem("a", "A"),
					{
						type: "response.output_item.added",
						output_index: 2,
						item: {
							type: "function_call",
							id: "fc_b",
							call_id: "b",
							name: "record",
							arguments: "",
							status: "in_progress",
						},
					},
					{ type: "response.function_call_arguments.delta", output_index: 2, delta: '{"text":"B"' },
				],
			],
			contexts,
		);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("tool_execution_end")).toMatchObject([{ isError: false }]);
		expect(runs).toEqual(["A"]);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.messages.at(-1)).toMatchObject({
			role: "toolResult",
			toolCallId: "a|fc_a",
			content: [{ text: "recorded:A" }],
		});
		expect(JSON.stringify(contexts[1])).not.toContain('"fc_b"');
		expect(
			contexts[1]?.messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("retains complete text and continues without replaying the unfinished text", async () => {
		const harness = await createHarness({
			tools: [],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);
		harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
				event.assistantMessageEvent.partial.usage.input = 7;
				event.assistantMessageEvent.partial.usage.output = 3;
				event.assistantMessageEvent.partial.usage.totalTokens = 10;
			}
		});
		const contexts: Context[] = [];
		installStreams(
			harness,
			[
				[
					textItem("finished item"),
					{
						type: "response.output_item.added",
						output_index: 1,
						item: { type: "message", id: "msg_partial", role: "assistant", content: [], status: "in_progress" },
					},
					{ type: "response.output_text.delta", output_index: 1, delta: "unfinished item" },
					{ type: "error", error: { code: "rate_limit_exceeded", message: "429 too many requests" } },
				],
			],
			contexts,
		);

		await harness.session.prompt("test");

		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ text: "finished item" }],
			isResponseCheckpoint: true,
		});
		expect(JSON.stringify(contexts[1])).not.toContain("unfinished item");
		const artifacts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.provider === model.provider
					? [entry.message]
					: [],
			);
		expect(artifacts).toHaveLength(2);
		expect(artifacts[0]?.usage.totalTokens).toBe(0);
		expect(artifacts[1]?.usage.totalTokens).toBe(10);
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({
					stopReason: "error",
					content: [{ type: "text", text: "unfinished item" }],
				}),
			}),
		);
	});

	it("does not reset the failure budget when another failed attempt contains complete text", async () => {
		const harness = await createHarness({
			tools: [],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const contexts: Context[] = [];
		const failure = { type: "error", error: { code: "rate_limit_exceeded", message: "429 too many requests" } };
		installStreams(
			harness,
			[
				[textItem("first checkpoint"), failure],
				[textItem("second checkpoint"), failure],
			],
			contexts,
		);

		await harness.session.prompt("test");

		expect(contexts).toHaveLength(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({ success: false, attempt: 1 });
		expect(harness.session.isIdle).toBe(true);
	});

	it("waits for tool completion and persistence before the retry starts", async () => {
		let started!: () => void;
		let finish!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const toolFinished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Wait for test release",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				started();
				await toolFinished;
				return { content: [{ type: "text", text: "recorded" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [tool],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", content: [{ text: "recorded" }] });
				expect(harness.sessionManager.getEntries()).toContainEqual(
					expect.objectContaining({ type: "message", message: expect.objectContaining({ role: "toolResult" }) }),
				);
				return fauxAssistantMessage("done");
			},
		]);
		const contexts: Context[] = [];
		installStreams(harness, [[toolItem("a", "A")]], contexts);
		const prompt = harness.session.prompt("test");
		try {
			await toolStarted;
			expect(contexts).toHaveLength(1);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
			expect(harness.session.isIdle).toBe(false);
		} finally {
			finish();
			await prompt;
		}
		expect(contexts).toHaveLength(2);
	});

	it.each(["incomplete", "in_progress"])(
		"does not execute a call marked %s even if its arguments parse",
		async (status) => {
			let runs = 0;
			const tool: AgentTool = {
				name: "record",
				label: "Record",
				description: "Test",
				parameters: Type.Object({ text: Type.String() }),
				execute: async () => {
					runs++;
					return { content: [], details: {} };
				},
			};
			const harness = await createHarness({
				tools: [tool],
				hfCompaction: { mode: "off" },
				settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("done")]);
			const contexts: Context[] = [];
			installStreams(harness, [[toolItem("a", "A", status)]], contexts);
			await harness.session.prompt("test");
			expect(runs).toBe(0);
			expect(contexts[1]?.messages.at(-1)?.role).toBe("user");
		},
	);

	it.each([
		{
			name: "quota error",
			terminal: { type: "error", error: { code: "insufficient_quota", message: "billing quota exceeded" } },
		},
		{
			name: "output limit",
			terminal: {
				type: "response.incomplete",
				response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
			},
		},
	])("does not execute recovery tools after $name", async ({ terminal }) => {
		let runs = 0;
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Test",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				runs++;
				return { content: [], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [tool],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		const contexts: Context[] = [];
		installStreams(harness, [[toolItem("a", "A"), terminal]], contexts);
		await harness.session.prompt("test");
		expect(runs).toBe(0);
		expect(contexts).toHaveLength(terminal.type === "response.incomplete" ? 2 : 1);
		if (terminal.type === "response.incomplete") {
			expect(contexts[1]?.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
		}
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it("does not execute or retry after cancellation at an item boundary", async () => {
		let runs = 0;
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Test",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				runs++;
				return { content: [], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [tool],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end")
				harness.session.agent.abort();
		});
		const contexts: Context[] = [];
		installStreams(harness, [[toolItem("a", "A")]], contexts);
		await harness.session.prompt("test");
		expect(runs).toBe(0);
		expect(contexts).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it("preserves the completed snapshot when the provider message is later mutated", async () => {
		const runs: string[] = [];
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Test",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, args) => {
				runs.push(typeof args === "object" && args !== null && "text" in args ? String(args.text) : "");
				return { content: [], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [tool],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
				event.assistantMessageEvent.toolCall.arguments.text = "mutated";
			}
		});
		const contexts: Context[] = [];
		installStreams(harness, [[toolItem("a", "A")]], contexts);
		await harness.session.prompt("test");
		expect(runs).toEqual(["A"]);
	});

	it("does not replay an isolated completed reasoning item", async () => {
		const harness = await createHarness({
			tools: [],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const contexts: Context[] = [];
		installStreams(
			harness,
			[
				[
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "reasoning",
							id: "rs_orphan",
							status: "completed",
							summary: [],
							encrypted_content: "synthetic",
						},
					},
				],
			],
			contexts,
		);
		await harness.session.prompt("test");
		expect(contexts[1]?.messages.at(-1)?.role).toBe("user");
		expect(JSON.stringify(contexts[1])).not.toContain("rs_orphan");
	});

	it("honors a terminating recovered tool without retrying the failed response", async () => {
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Stop after the tool",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "stop" }], details: {}, terminate: true }),
		};
		const harness = await createHarness({
			tools: [tool],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		const contexts: Context[] = [];
		installStreams(harness, [[toolItem("a", "A")]], contexts);
		await harness.session.prompt("test");
		expect(contexts).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "aborted" });
		expect(harness.session.isIdle).toBe(true);
	});

	it("preserves reasoning signatures with a following completed text item", async () => {
		const harness = await createHarness({
			tools: [],
			hfCompaction: { mode: "off" },
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const contexts: Context[] = [];
		installStreams(
			harness,
			[
				[
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "reasoning",
							id: "rs_complete",
							status: "completed",
							summary: [],
							encrypted_content: "synthetic",
						},
					},
					textItem("complete answer"),
				],
			],
			contexts,
		);
		await harness.session.prompt("test");
		expect(contexts[1]?.messages.at(-1)).toMatchObject({
			content: [
				{ type: "thinking", thinkingSignature: expect.stringContaining("rs_complete") },
				{ type: "text", text: "complete answer" },
			],
		});
	});
});
