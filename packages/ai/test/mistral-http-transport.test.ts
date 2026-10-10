import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { getModel } from "../src/compat.ts";
import type { Context, FetchFunction, ProviderResponse } from "../src/types.ts";

function createSseResponse(events: unknown[], headers?: Record<string, string>): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\r\n\r\n")}\r\n\r\ndata: [DONE]\r\n\r\n`;
	return new Response(body, {
		headers: { "content-type": "text/event-stream", ...headers },
	});
}

function createBytewiseSseResponse(event: unknown): Response {
	const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`);
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function createTerminalEvent(finishReason = "stop") {
	return {
		id: "mistral-response-id",
		model: "mistral-large-latest",
		choices: [{ index: 0, finish_reason: finishReason, delta: {} }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

describe("Mistral HTTP transport", () => {
	it("serializes SDK-style payloads to the Mistral wire format", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const context: Context = {
			systemPrompt: "Be precise",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
			tools: [
				{
					name: "lookup",
					description: "Look something up",
					parameters: Type.Object({ query: Type.String() }),
				},
			],
		};
		let requestUrl: string | undefined;
		let requestInit: RequestInit | undefined;
		let callbackPayload: Record<string, unknown> | undefined;
		let callbackResponse: ProviderResponse | undefined;
		const fetch: FetchFunction = async (input, init) => {
			requestUrl = String(input);
			requestInit = init;
			return createSseResponse([createTerminalEvent()], { "x-request-id": "request-1" });
		};

		const message = await streamMistral(model, context, {
			apiKey: "secret",
			fetch,
			headers: { "x-custom": "value" },
			maxTokens: 123,
			promptMode: "reasoning",
			reasoningEffort: "high",
			toolChoice: { type: "function", function: { name: "lookup" } },
			promptCacheKey: "shared-agent-prefix",
			sessionId: "session-1",
			onPayload: (payload) => {
				callbackPayload = payload as Record<string, unknown>;
				return {
					...callbackPayload,
					topP: 0.9,
					randomSeed: 42,
					responseFormat: {
						type: "json_schema",
						jsonSchema: {
							name: "result",
							schemaDefinition: {
								type: "object",
								properties: { maxTokens: { type: "number" } },
							},
						},
					},
					presencePenalty: 0.1,
					frequencyPenalty: 0.2,
					parallelToolCalls: true,
					safePrompt: true,
				};
			},
			onResponse: (response) => {
				callbackResponse = response;
			},
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requestUrl).toBe("https://api.mistral.ai/v1/chat/completions");
		const headers = new Headers(requestInit?.headers);
		expect(headers.get("authorization")).toBe("Bearer secret");
		expect(headers.get("accept")).toBe("text/event-stream");
		expect(headers.get("x-affinity")).toBe("session-1");
		expect(headers.get("x-custom")).toBe("value");
		expect(callbackPayload?.maxTokens).toBe(123);
		expect(callbackPayload?.promptMode).toBe("reasoning");
		expect(callbackPayload?.promptCacheKey).toBe("shared-agent-prefix");
		expect(callbackResponse).toEqual({
			status: 200,
			headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
		});

		const wirePayload = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
		expect(wirePayload.max_tokens).toBe(123);
		expect(wirePayload.prompt_mode).toBe("reasoning");
		expect(wirePayload.reasoning_effort).toBe("high");
		expect(wirePayload.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
		expect(wirePayload.prompt_cache_key).toBe("shared-agent-prefix");
		expect(wirePayload.top_p).toBe(0.9);
		expect(wirePayload.random_seed).toBe(42);
		expect(wirePayload.presence_penalty).toBe(0.1);
		expect(wirePayload.frequency_penalty).toBe(0.2);
		expect(wirePayload.parallel_tool_calls).toBe(true);
		expect(wirePayload.safe_prompt).toBe(true);
		expect(wirePayload.response_format).toEqual({
			type: "json_schema",
			json_schema: {
				name: "result",
				schema: {
					type: "object",
					properties: { maxTokens: { type: "number" } },
				},
			},
		});
		expect(wirePayload).not.toHaveProperty("maxTokens");
		expect(wirePayload).not.toHaveProperty("promptMode");
		expect(wirePayload).not.toHaveProperty("promptCacheKey");
		expect(wirePayload.messages).toEqual([
			{ role: "system", content: "Be precise" },
			{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image_url", image_url: "data:image/png;base64,aGVsbG8=" },
				],
			},
		]);
	});

	it("serializes assistant thinking, tool calls, and tool results for replay", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const context: Context = {
			messages: [
				{
					role: "assistant",
					api: "mistral-conversations",
					provider: "mistral",
					model: model.id,
					content: [
						{ type: "thinking", thinking: "reason" },
						{ type: "text", text: "answer" },
						{ type: "toolCall", id: "abc123456", name: "lookup", arguments: { query: "pi" } },
					],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "abc123456",
					toolName: "lookup",
					content: [
						{ type: "text", text: "found" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 2,
				},
			],
		};
		let requestInit: RequestInit | undefined;
		const fetch: FetchFunction = async (_input, init) => {
			requestInit = init;
			return createSseResponse([createTerminalEvent()]);
		};

		const message = await streamMistral(model, context, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("stop");
		const wirePayload = JSON.parse(String(requestInit?.body)) as { messages: unknown[] };
		expect(wirePayload.messages).toEqual([
			{
				role: "assistant",
				prefix: false,
				content: [
					{ type: "thinking", thinking: [{ type: "text", text: "reason" }] },
					{ type: "text", text: "answer" },
				],
				tool_calls: [
					{
						id: "abc123456",
						type: "function",
						function: { name: "lookup", arguments: '{"query":"pi"}' },
						index: 0,
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "abc123456",
				name: "lookup",
				content: [
					{ type: "text", text: "found" },
					{ type: "image_url", image_url: "data:image/png;base64,aGVsbG8=" },
				],
			},
		]);
	});

	it("parses native thinking, text, fragmented tool calls, and cached-token usage", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const events = [
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: null,
						delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "reason" }] }] },
					},
				],
			},
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: null,
						delta: { content: [{ type: "text", text: "answer" }] },
					},
				],
			},
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: null,
						delta: {
							tool_calls: [
								{
									id: "abc123456",
									index: 0,
									function: { name: "lookup", arguments: '{"query":' },
								},
							],
						},
					},
				],
			},
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: "tool_calls",
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { name: "", arguments: '"pi"}' },
								},
							],
						},
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 4,
					total_tokens: 14,
					prompt_tokens_details: { cached_tokens: 3 },
				},
			},
		];
		const fetch: FetchFunction = async () => createSseResponse(events);

		const message = await streamMistral(model, context, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.rawStopReason).toBe("tool_calls");
		expect(message.responseId).toBe("response-1");
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "reason" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "abc123456", name: "lookup", arguments: { query: "pi" } },
		]);
		expect(message.usage).toMatchObject({ input: 7, output: 4, cacheRead: 3, cacheWrite: 0, totalTokens: 14 });
	});

	it("keeps interleaved indexed tool calls separate and preserves their first IDs and names", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const context: Context = { messages: [] };
		const fetch: FetchFunction = async () =>
			createSseResponse([
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: "abc123456", function: { name: "lookup", arguments: '{"query":' } },
									{ index: 1, id: "def123456", function: { name: "count", arguments: '{"limit":' } },
								],
							},
						},
					],
				},
				{
					choices: [
						{
							finish_reason: "tool_calls",
							delta: {
								tool_calls: [
									{ index: 1, function: { name: "", arguments: "2}" } },
									{ index: 0, id: "changedid", function: { name: "changed_name", arguments: '"pi"}' } },
								],
							},
						},
					],
				},
			]);
		const response = streamMistral(model, context, { apiKey: "test", fetch });
		const toolEvents: Array<{ type: string; contentIndex: number }> = [];
		for await (const event of response) {
			if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
				toolEvents.push({ type: event.type, contentIndex: event.contentIndex });
			}
		}
		const message = await response.result();

		expect(message.content).toEqual([
			{ type: "toolCall", id: "abc123456", name: "lookup", arguments: { query: "pi" } },
			{ type: "toolCall", id: "def123456", name: "count", arguments: { limit: 2 } },
		]);
		expect(toolEvents.filter((event) => event.type === "toolcall_start").map((event) => event.contentIndex)).toEqual([
			0, 1,
		]);
		expect(toolEvents.filter((event) => event.type === "toolcall_delta").map((event) => event.contentIndex)).toEqual([
			0, 1, 1, 0,
		]);
		expect(toolEvents.filter((event) => event.type === "toolcall_end").map((event) => event.contentIndex)).toEqual([
			0, 1,
		]);
	});

	it("uses IDs to merge tool fragments when indexes are absent", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const fetch: FetchFunction = async () =>
			createSseResponse([
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ id: "abc123456", function: { name: "lookup", arguments: '{"query":' } },
									{ id: "def123456", function: { name: "count", arguments: '{"limit":' } },
								],
							},
						},
					],
				},
				{
					choices: [
						{
							finish_reason: "tool_calls",
							delta: {
								tool_calls: [
									{ id: "def123456", function: { name: "", arguments: "2}" } },
									{ id: "abc123456", function: { name: "", arguments: '"pi"}' } },
								],
							},
						},
					],
				},
			]);

		const message = await streamMistral(model, { messages: [] }, { apiKey: "test", fetch }).result();

		expect(message.content).toEqual([
			{ type: "toolCall", id: "abc123456", name: "lookup", arguments: { query: "pi" } },
			{ type: "toolCall", id: "def123456", name: "count", arguments: { limit: 2 } },
		]);
	});

	it.each([undefined, "null"])("merges anonymous tool fragments without indexes (ID: %s)", async (id) => {
		const model = getModel("mistral", "mistral-large-latest");
		const fetch: FetchFunction = async () =>
			createSseResponse([
				{ choices: [{ delta: { tool_calls: [{ id, function: { name: "lookup", arguments: '{"query":' } }] } }] },
				{
					choices: [
						{
							finish_reason: "tool_calls",
							delta: { tool_calls: [{ id, function: { name: "", arguments: '"pi"}' } }] },
						},
					],
				},
			]);

		const message = await streamMistral(model, { messages: [] }, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{
				type: "toolCall",
				id: expect.stringMatching(/^[a-zA-Z0-9]{9}$/),
				name: "lookup",
				arguments: { query: "pi" },
			},
		]);
	});

	it("parses SSE and UTF-8 sequences split across transport chunks", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const fetch: FetchFunction = async () =>
			createBytewiseSseResponse({
				id: "response-bytewise",
				model: model.id,
				choices: [{ index: 0, finish_reason: "stop", delta: { content: "héllo 🌍" } }],
				usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
			});

		const message = await streamMistral(model, context, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "héllo 🌍" }]);
	});

	it("honors case-insensitive header overrides and explicit affinity suppression", async () => {
		const model = {
			...getModel("mistral", "mistral-large-latest"),
			headers: { Authorization: "Bearer model-key", "X-Affinity": "model-affinity" },
		};
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		let requestHeaders: Headers | undefined;
		const fetch: FetchFunction = async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return createSseResponse([createTerminalEvent()]);
		};

		await streamMistral(model, context, {
			apiKey: "request-key",
			fetch,
			sessionId: "automatic-affinity",
			headers: { authorization: null, "x-affinity": null },
		}).result();

		expect(requestHeaders?.has("authorization")).toBe(false);
		expect(requestHeaders?.has("x-affinity")).toBe(false);
	});

	it("aborts while waiting for an SSE chunk", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const controller = new AbortController();
		const fetch: FetchFunction = async () =>
			new Response(
				new ReadableStream({
					start() {},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);

		const result = streamMistral(model, context, {
			apiKey: "test",
			fetch,
			signal: controller.signal,
		}).result();
		controller.abort();
		const message = await result;

		expect(message.stopReason).toBe("aborted");
	});

	describe("response header deadline", () => {
		let headerTimeoutSignal: AbortSignal;

		beforeEach(() => {
			vi.useFakeTimers();
			vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
				const controller = new AbortController();
				headerTimeoutSignal = controller.signal;
				vi.spyOn(headerTimeoutSignal, "addEventListener");
				vi.spyOn(headerTimeoutSignal, "removeEventListener");
				setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), timeoutMs);
				return headerTimeoutSignal;
			});
		});

		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		it("times out stalled response headers with a provider diagnostic and cleans up listeners", async () => {
			const model = getModel("mistral", "mistral-large-latest");
			const fetch: FetchFunction = (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				});
			const result = streamMistral(model, { messages: [] }, { apiKey: "test", fetch, timeoutMs: 20 }).result();

			await vi.advanceTimersByTimeAsync(20);
			const message = await result;

			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toBe("Mistral response headers timed out after 20ms");
			expect(headerTimeoutSignal.removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
		});

		it.each([false, true])(
			"keeps a signal-bound active body past the deadline (caller signal: %s)",
			async (withCaller) => {
				const model = getModel("mistral", "mistral-large-latest");
				const caller = withCaller ? new AbortController() : undefined;
				let fetchSignal: AbortSignal | null | undefined;
				const fetchAborted = vi.fn();
				const encoder = new TextEncoder();
				const fetch: FetchFunction = async (_input, init) => {
					fetchSignal = init?.signal;
					let timer: ReturnType<typeof setTimeout>;
					let onAbort: () => void;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								onAbort = () => {
									fetchAborted();
									clearTimeout(timer);
									controller.error(fetchSignal?.reason);
								};
								fetchSignal?.addEventListener("abort", onAbort, { once: true });
								if (fetchSignal?.aborted) {
									onAbort();
									return;
								}
								let count = 0;
								const send = () => {
									if (count++ < 5) {
										controller.enqueue(
											encoder.encode(
												`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`,
											),
										);
										timer = setTimeout(send, 10);
									} else {
										fetchSignal?.removeEventListener("abort", onAbort);
										controller.enqueue(encoder.encode(`data: ${JSON.stringify(createTerminalEvent())}\n\n`));
										controller.close();
									}
								};
								timer = setTimeout(send, 10);
							},
							cancel() {
								clearTimeout(timer);
								fetchSignal?.removeEventListener("abort", onAbort);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				};
				const result = streamMistral(
					model,
					{ messages: [] },
					{
						apiKey: "test",
						fetch,
						signal: caller?.signal,
						timeoutMs: 20,
					},
				).result();

				await vi.advanceTimersByTimeAsync(60);
				const message = await result;

				expect(headerTimeoutSignal.aborted).toBe(true);
				expect(fetchSignal?.aborted).toBe(false);
				expect(fetchAborted).not.toHaveBeenCalled();
				expect(message.stopReason).toBe("stop");
				expect(message.content).toEqual([{ type: "text", text: "xxxxx" }]);
				expect(headerTimeoutSignal.removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
			},
		);

		it("cancels while awaiting headers without misclassifying caller abort as timeout", async () => {
			const model = getModel("mistral", "mistral-large-latest");
			const caller = new AbortController();
			vi.spyOn(caller.signal, "removeEventListener");
			const fetch: FetchFunction = (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				});
			const result = streamMistral(
				model,
				{ messages: [] },
				{
					apiKey: "test",
					fetch,
					signal: caller.signal,
					timeoutMs: 20,
				},
			).result();

			await vi.advanceTimersByTimeAsync(0);
			caller.abort(new Error("Caller cancelled headers"));
			const message = await result;

			expect(message.stopReason).toBe("aborted");
			expect(message.errorMessage).toBe("Caller cancelled headers");
			expect(headerTimeoutSignal.removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
			expect(caller.signal.removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
		});

		it("passes an already aborted caller signal to fetch", async () => {
			const model = getModel("mistral", "mistral-large-latest");
			const caller = new AbortController();
			caller.abort(new Error("Already cancelled"));
			const fetch: FetchFunction = async (_input, init) => {
				expect(init?.signal?.aborted).toBe(true);
				throw init?.signal?.reason;
			};

			const message = await streamMistral(
				model,
				{ messages: [] },
				{
					apiKey: "test",
					fetch,
					signal: caller.signal,
					timeoutMs: 20,
				},
			).result();

			expect(message.stopReason).toBe("aborted");
			expect(message.errorMessage).toBe("Already cancelled");
			expect(headerTimeoutSignal.addEventListener).not.toHaveBeenCalled();
		});

		it("cancels a blocked reader after headers and removes caller listeners", async () => {
			const model = getModel("mistral", "mistral-large-latest");
			const caller = new AbortController();
			vi.spyOn(caller.signal, "addEventListener");
			vi.spyOn(caller.signal, "removeEventListener");
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>({ cancel });
			const fetch: FetchFunction = async () => new Response(body);
			const result = streamMistral(
				model,
				{ messages: [] },
				{
					apiKey: "test",
					fetch,
					signal: caller.signal,
					timeoutMs: 20,
				},
			).result();

			await vi.advanceTimersByTimeAsync(30);
			expect(body.locked).toBe(true);
			caller.abort(new Error("Caller cancelled body"));
			const message = await result;

			expect(message.stopReason).toBe("aborted");
			expect(message.errorMessage).toBe("Caller cancelled body");
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
			expect(caller.signal.addEventListener).toHaveBeenCalledTimes(2);
			expect(caller.signal.removeEventListener).toHaveBeenCalledTimes(2);
		});

		it("preserves transport body idle timeouts after the header deadline", async () => {
			const model = getModel("mistral", "mistral-large-latest");
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					setTimeout(() => controller.error(new Error("Mistral transport body idle timeout")), 40);
				},
			});
			const fetch: FetchFunction = async () => new Response(body);
			const result = streamMistral(model, { messages: [] }, { apiKey: "test", fetch, timeoutMs: 20 }).result();

			await vi.advanceTimersByTimeAsync(40);
			const message = await result;

			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toBe("Mistral transport body idle timeout");
			expect(body.locked).toBe(false);
		});
	});

	it("preserves HTTP status and response bodies in errors", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const fetch: FetchFunction = async () =>
			new Response('{"message":"blocked by gateway"}', { status: 403, statusText: "Forbidden" });

		const message = await streamMistral(model, context, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe('Mistral API error (403): {"message":"blocked by gateway"}');
	});
});
