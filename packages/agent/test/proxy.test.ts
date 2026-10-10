import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";
import type { AgentTool } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it.each([
		{ itemComplete: true, abortAfterEnd: false, expectedExecutions: 1 },
		{ itemComplete: false, abortAfterEnd: false, expectedExecutions: 0 },
		{ itemComplete: undefined, abortAfterEnd: false, expectedExecutions: 0 },
		{ itemComplete: true, abortAfterEnd: true, expectedExecutions: 0 },
	])(
		"retains completed items after EOF without executing incomplete or cancelled calls: $itemComplete/$abortAfterEnd",
		async ({ itemComplete, abortAfterEnd, expectedExecutions }) => {
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "lookup result" }],
				details: {},
			}));
			const tool: AgentTool = {
				name: "lookup",
				label: "Lookup",
				description: "Look up a value",
				parameters: Type.Object({}),
				execute,
			};
			const events: ProxyAssistantMessageEvent[] = [
				{ type: "start" },
				{ type: "toolcall_start", contentIndex: 0, id: "call-eof", toolName: "lookup" },
				{
					type: "toolcall_end",
					contentIndex: 0,
					itemComplete,
					toolCall: { type: "toolCall", id: "call-eof", name: "lookup", arguments: {} },
				},
			];
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))),
			);
			const agent = new Agent({
				initialState: { model, tools: [tool] },
				streamFn: (requestModel, context, options) =>
					streamProxy(requestModel, context, {
						authToken: "test",
						proxyUrl: "https://proxy.example.com",
						signal: options?.signal,
					}),
			});
			agent.subscribe((event) => {
				if (
					abortAfterEnd &&
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "toolcall_end"
				) {
					agent.abort();
				}
			});

			await agent.prompt("look up the value");

			expect(execute).toHaveBeenCalledTimes(expectedExecutions);
			const checkpoints = agent.state.messages.filter(
				(message) => message.role === "assistant" && message.isResponseCheckpoint,
			);
			expect(checkpoints).toHaveLength(expectedExecutions);
			const results = agent.state.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(expectedExecutions);
			if (expectedExecutions) {
				expect(results[0]).toMatchObject({ toolCallId: "call-eof", isError: false });
			}
			const lastAssistant = agent.state.messages.filter((message) => message.role === "assistant").at(-1);
			expect(lastAssistant?.stopReason).toBe(abortAfterEnd ? "aborted" : "error");
		},
	);

	it.each(["\n\n", "\n", ""])("settles after a done event with trailing %j", async (trailing) => {
		const start = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		const done = `data: ${JSON.stringify({ type: "done", reason: "stop", usage })}`;
		const body = start + done + trailing;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.example.com" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		// At EOF the result must already be settled, not left pending after iteration ends.
		const result = await Promise.race([stream.result(), Promise.resolve(null)]);

		expect(result, "result() must settle at EOF").not.toBeNull();
		expect(result?.stopReason).toBe("stop");
		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
	});

	it("preserves an unterminated error terminal event", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						`data: ${JSON.stringify({ type: "error", reason: "error", errorMessage: "Provider failed", usage })}`,
					),
			),
		);
		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.example.com" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await Promise.race([stream.result(), Promise.resolve(null)]);

		expect(result, "result() must settle at EOF").not.toBeNull();
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "Provider failed", usage });
		expect(events.map((event) => event.type)).toEqual(["error"]);
	});

	it.each(["\n\n", ""])("settles mid-response EOF and retains completed blocks with trailing %j", async (trailing) => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{
				type: "thinking_end",
				contentIndex: 0,
				content: "Complete thinking",
				contentSignature: "thinking-signature",
				itemComplete: true,
			},
			{ type: "text_start", contentIndex: 1 },
			{ type: "text_delta", contentIndex: 1, delta: "Hello" },
			{ type: "text_end", contentIndex: 1, contentSignature: "text-signature", itemComplete: true },
			{ type: "toolcall_start", contentIndex: 2, id: "call_test|fc_test", toolName: "lookup" },
			{
				type: "toolcall_end",
				contentIndex: 2,
				itemComplete: true,
				toolCall: {
					type: "toolCall",
					id: "call_test|fc_test",
					name: "lookup",
					arguments: { value: "hello" },
					namespace: "dynamic_tools",
				},
			},
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + trailing;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.example.com" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await Promise.race([stream.result(), Promise.resolve(null)]);

		expect(result, "result() must settle at EOF").not.toBeNull();
		expect(result?.stopReason).toBe("error");
		expect(result?.errorMessage).toContain("Connection closed by proxy server before the response completed");
		expect(events.map((event) => event.type)).toEqual([...proxyEvents.map((event) => event.type), "error"]);
		expect(events.filter((event) => event.type === "error")).toHaveLength(1);
		for (const type of ["thinking_end", "text_end", "toolcall_end"]) {
			expect(events.find((event) => event.type === type)).toMatchObject({ itemComplete: true });
		}
		expect(result?.content).toEqual([
			{ type: "thinking", thinking: "Complete thinking", thinkingSignature: "thinking-signature" },
			{ type: "text", text: "Hello", textSignature: "text-signature" },
			{
				type: "toolCall",
				id: "call_test|fc_test",
				name: "lookup",
				arguments: { value: "hello" },
				namespace: "dynamic_tools",
			},
		]);
	});

	it("preserves caller abort instead of processing a buffered terminal event at EOF", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const body = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Complete" },
			{ type: "text_end", contentIndex: 0, contentSignature: "text-signature", itemComplete: true },
			{ type: "done", reason: "stop", usage },
		]
			.map((event) => `data: ${JSON.stringify(event)}`)
			.join("\n\n");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				expect(init?.signal).toBe(controller.signal);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(streamController) {
							streamController.enqueue(new TextEncoder().encode(body));
						},
						cancel,
					}),
				);
			}),
		);
		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.example.com",
				signal: controller.signal,
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
			if (event.type === "text_end") controller.abort();
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request aborted by user");
		expect(result.content[0]).toMatchObject({ type: "text", text: "Complete", textSignature: "text-signature" });
		expect(events.find((event) => event.type === "text_end")).toMatchObject({ itemComplete: true });
		expect(events.some((event) => event.type === "done")).toBe(false);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("reconciles thinking text supplied by an end snapshot", async () => {
		const body = [
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "Partial" },
			{ type: "thinking_end", contentIndex: 0, content: "Complete thinking" },
			{ type: "done", reason: "stop", usage },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.example.com" });
		expect((await stream.result()).content[0]).toMatchObject({ thinking: "Complete thinking" });
	});

	it("preserves tool-call metadata received only on toolcall_end", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test|fc_test", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"hello"}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				itemComplete: true,
				toolCall: {
					type: "toolCall",
					id: "call_test|fc_test",
					name: "lookup",
					arguments: { value: "hello" },
					namespace: "dynamic_tools",
				},
			},
			{ type: "done", reason: "toolUse", usage },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const endEvent = events.find((event) => event.type === "toolcall_end");

		expect(endEvent).toMatchObject({
			type: "toolcall_end",
			itemComplete: true,
			toolCall: { namespace: "dynamic_tools" },
		});
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { value: "hello" },
			namespace: "dynamic_tools",
		});
	});

	it.each(["text", "thinking"] as const)("preserves %s completion markers without inventing them", async (kind) => {
		for (const itemComplete of [true, false, undefined]) {
			const body = [
				{ type: "start" },
				{ type: `${kind}_start`, contentIndex: 0 },
				{ type: `${kind}_delta`, contentIndex: 0, delta: "complete" },
				{ type: `${kind}_end`, contentIndex: 0, itemComplete },
				{ type: "error", reason: "error", errorMessage: "Network connection lost", usage },
			]
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join("");
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body)),
			);
			const stream = streamProxy(
				model,
				{ messages: [] },
				{ authToken: "test", proxyUrl: "https://proxy.example.com" },
			);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			expect(events.find((event) => event.type === `${kind}_end`)).toMatchObject({ itemComplete });
		}
	});

	it("forwards promptCacheKey independently from sessionId", async () => {
		let requestOptions: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requestOptions = JSON.parse(String(init?.body)).options as Record<string, unknown>;
				return new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`, {
					status: 200,
				});
			}),
		);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
				promptCacheKey: "shared-agent-prefix",
				sessionId: "transport-session",
			},
		);
		await stream.result();

		expect(requestOptions?.promptCacheKey).toBe("shared-agent-prefix");
		expect(requestOptions?.sessionId).toBe("transport-session");
	});
});
