import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

interface CapturedResponsesPayload {
	input?: ResponseCreateParamsStreaming["input"];
	prompt_cache_options?: ResponseCreateParamsStreaming["prompt_cache_options"];
	prompt_cache_retention?: ResponseCreateParamsStreaming["prompt_cache_retention"];
	prompt_cache_key?: string;
	session_id?: string;
	tools?: Array<{ name?: string; strict?: boolean }>;
}

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
	model: Model<"openai-responses"> = getModel("openai", "gpt-5.4"),
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	xSessionId: string | null;
	payload: CapturedResponsesPayload | undefined;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		xSessionId: null as string | null,
		payload: undefined as CapturedResponsesPayload | undefined,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		if (typeof init?.body === "string") captured.payload = JSON.parse(init.body);
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		captured.xSessionId = getHeader(init?.headers, "x-session-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = getModel("github-copilot", "gpt-5-mini");
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it("forwards required tool choice", async () => {
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				messages: [
					{
						role: "user",
						content: "Do not call ping. Respond with text instead.",
						timestamp: Date.now(),
					},
				],
				tools: [
					{
						name: "ping",
						description: "Ping",
						parameters: Type.Object({ value: Type.String() }),
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "required",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			tool_choice: "required",
			tools: [expect.objectContaining({ name: "ping" })],
		});
	});

	it("sets strict mode explicitly for Cloudflare OpenAI Responses tools", async () => {
		const model = getModel("cloudflare-ai-gateway", "gpt-5.6-sol");
		let capturedPayload: CapturedResponsesPayload | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				messages: [{ role: "user", content: "Use a tool.", timestamp: Date.now() }],
				tools: [
					{
						name: "ordinary",
						description: "An ordinary tool",
						parameters: Type.Object({
							path: Type.String(),
							offset: Type.Optional(Type.Number()),
						}),
					},
					{
						name: "constrained",
						description: "A constrained tool",
						parameters: Type.Object({ value: Type.String() }),
						constrainedSampling: { type: "json_schema", strict: "prefer" },
					},
				],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(model.compat?.supportsStrictMode).toBe(true);
		expect(capturedPayload?.tools).toEqual([
			expect.objectContaining({ name: "ordinary", strict: false }),
			expect.objectContaining({ name: "constrained", strict: true }),
		]);
	});

	it.each([
		"gpt-5.1",
		"gpt-5.2",
		"gpt-5.3-codex",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.4-nano",
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
	] as const)("sends none reasoning effort for OpenAI %s when no reasoning is requested", async (modelId) => {
		const model = getModel("openai", modelId);
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			reasoning: { effort: "none" },
		});
	});

	it.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const)(
		"omits reasoning effort for OpenAI %s when off is unsupported",
		async (modelId) => {
			const model = getModel("openai", modelId);
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).not.toMatchObject({
				reasoning: expect.anything(),
			});
		},
	);

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("uses promptCacheKey for cache identity without changing session-affinity headers", async () => {
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "transport-session",
			promptCacheKey: "shared-agent-prefix",
			onPayload: (payload) => {
				capturedPayload = payload as CapturedResponsesPayload;
			},
		});

		expect(captured.sessionId).toBe("transport-session");
		expect(captured.clientRequestId).toBe("transport-session");
		expect(capturedPayload?.prompt_cache_key).toBe("shared-agent-prefix");
	});

	it("bounds prompt_cache_key at 64 code points while preserving suffix identity", async () => {
		const sessionId = "x".repeat(67);
		let capturedPayload: Pick<CapturedResponsesPayload, "prompt_cache_key"> | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				sessionId,
				onPayload: (payload) => {
					capturedPayload = payload as Pick<CapturedResponsesPayload, "prompt_cache_key">;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(Array.from(capturedPayload?.prompt_cache_key ?? "")).toHaveLength(64);
		expect(capturedPayload?.prompt_cache_key).toContain("~");
		expect(capturedPayload?.prompt_cache_key).not.toBe("x".repeat(64));
	});

	it("sets cache-affinity headers for proxy OpenAI Responses requests with a sessionId", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("uses OpenRouter session-affinity header when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openrouter" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-proxy");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("auto-detects OpenRouter session-affinity header for OpenRouter Responses endpoints", async () => {
		const openRouterModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-openrouter",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			openRouterModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-openrouter");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-openrouter");
	});

	it("uses OpenAI no-session format when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-proxy");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("uses OpenAI no-session format for OpenCode Responses models", async () => {
		const model = getModel("opencode", "gpt-5.4");
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-opencode",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			model,
		);

		expect(model.compat?.sessionAffinityFormat).toBe("openai-nosession");
		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-opencode");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.prompt_cache_key).toBe("session-opencode");
	});

	it("can omit OpenAI session_id header while preserving other affinity data", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-123",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-123");
		expect(capturedPayload?.prompt_cache_key).toBe("session-123");
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
	});

	it("omits OpenAI cache-affinity headers when cacheRetention is none", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"uses native 30m cache TTL for %s with default, short, and long retention",
		async (modelId) => {
			const model = getModel("openai", modelId);
			expect(model.compat?.supportsExplicitPromptCacheMode).toBe(true);

			for (const cacheRetention of [undefined, "short", "long"] as const) {
				const captured = await captureOpenAIResponseHeaders(
					{
						cacheRetention,
						env: { PI_CACHE_RETENTION: "short" },
						sessionId: "transport-session",
						promptCacheKey: "shared-agent-prefix",
					},
					model,
				);

				expect(captured.payload?.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
				expect(captured.payload?.prompt_cache_retention).toBeUndefined();
				expect(captured.payload?.prompt_cache_key).toBe("shared-agent-prefix");
				expect(captured.payload?.input).toEqual([
					expect.objectContaining({
						content: [{ type: "input_text", text: "sys", prompt_cache_breakpoint: { mode: "explicit" } }],
					}),
					expect.objectContaining({ role: "user" }),
				]);
				expect(captured.sessionId).toBe("transport-session");
				expect(captured.clientRequestId).toBe("transport-session");
			}
		},
	);

	it("uses native 30m cache TTL for explicit-cache models with scoped long retention", async () => {
		const { payload } = await captureOpenAIResponseHeaders(
			{ env: { PI_CACHE_RETENTION: "long" } },
			getModel("openai", "gpt-5.6-sol"),
		);

		expect(payload?.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"disables cache writes, breakpoints, keys, and affinity for %s with none retention",
		async (modelId) => {
			const captured = await captureOpenAIResponseHeaders(
				{
					cacheRetention: "none",
					env: { PI_CACHE_RETENTION: "long" },
					sessionId: "transport-session",
					promptCacheKey: "shared-agent-prefix",
				},
				getModel("openai", modelId),
			);

			expect(captured.payload?.prompt_cache_options).toEqual({ mode: "explicit" });
			expect(captured.payload?.prompt_cache_retention).toBeUndefined();
			expect(captured.payload?.prompt_cache_key).toBeUndefined();
			expect(captured.payload?.input).toEqual([
				expect.objectContaining({ content: "sys" }),
				expect.objectContaining({ role: "user" }),
			]);
			expect(captured.sessionId).toBeNull();
			expect(captured.clientRequestId).toBeNull();
			expect(captured.xSessionId).toBeNull();
		},
	);

	it.each([true, false])(
		"preserves legacy long retention when supportsLongCacheRetention is %s",
		async (supported) => {
			const base = getModel("openai", "gpt-5.4");
			const model: Model<"openai-responses"> = {
				...base,
				compat: { ...base.compat, supportsLongCacheRetention: supported },
			};
			const { payload } = await captureOpenAIResponseHeaders({ cacheRetention: "long" }, model);

			expect(model.compat?.supportsExplicitPromptCacheMode).not.toBe(true);
			expect(payload?.prompt_cache_options).toBeUndefined();
			expect(payload?.prompt_cache_retention).toBe(supported ? "24h" : undefined);
			expect(payload?.input).toEqual([
				expect.objectContaining({ content: "sys" }),
				expect.objectContaining({ role: "user" }),
			]);
		},
	);

	it("preserves samplingParams overrides of native cache fields", async () => {
		const cacheOptions = { mode: "explicit", ttl: "24h" };
		let observedPayload: unknown;
		const { payload } = await captureOpenAIResponseHeaders(
			{
				cacheRetention: "long",
				samplingParams: { prompt_cache_options: cacheOptions, prompt_cache_key: "custom-key" },
				onPayload: (params) => {
					observedPayload = params;
				},
			},
			getModel("openai", "gpt-5.6-sol"),
		);

		expect(observedPayload).toMatchObject({ prompt_cache_options: cacheOptions, prompt_cache_key: "custom-key" });
		expect(payload?.prompt_cache_options).toEqual(cacheOptions);
		expect(payload?.prompt_cache_key).toBe("custom-key");
	});

	it.each([{ ttl: "30m" }, { mode: "explicit", ttl: "24h" }])(
		"preserves opaque onPayload replacements with cache options %j",
		async (cacheOptions) => {
			const model = getModel("openai", "gpt-5.6-sol");
			const replacement = {
				model: model.id,
				input: "replacement prompt",
				stream: true,
				prompt_cache_options: cacheOptions,
				custom_cache_hint: "opaque-provider-option",
			};
			const { payload } = await captureOpenAIResponseHeaders(
				{ cacheRetention: "long", onPayload: async () => replacement },
				model,
			);

			expect(payload).toEqual(replacement);
		},
	);

	it.each([
		["gpt-5.4", undefined, "fast", 2],
		["gpt-5.5", undefined, "fast", 2.5],
		["gpt-5.4", "fast", undefined, 2],
		["gpt-5.5", "fast", undefined, 2.5],
		["gpt-5.4", "flex", "fast", 2],
		["gpt-5.5", "flex", "fast", 2.5],
		["gpt-5.4", "fast", "priority", 2],
		["gpt-5.5", "fast", "priority", 2.5],
		["gpt-5.4", "fast", "default", 1],
		["gpt-5.5", "fast", "default", 1],
		["gpt-5.4", "fast", "flex", 0.5],
		["gpt-5.5", "fast", "flex", 0.5],
		["gpt-5.4", "priority", undefined, 2],
		["gpt-5.5", "priority", undefined, 2.5],
		["gpt-5.4", "flex", undefined, 0.5],
		["gpt-5.5", "flex", undefined, 0.5],
		["gpt-5.4", undefined, undefined, 1],
		["gpt-5.5", undefined, undefined, 1],
	] as const)(
		"prices %s request tier %s / response tier %s at %sx exactly once",
		async (modelId, requestTier, responseTier, multiplier) => {
			const model: Model<"openai-responses"> = {
				...getModel("openai", modelId),
				// Nonzero deterministic rates exercise every cost component, including cache writes.
				cost: { input: 8, output: 16, cacheRead: 2, cacheWrite: 4 },
			};
			const sse = `data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: responseTier,
					usage: {
						input_tokens: 1_000_000,
						output_tokens: 500_000,
						total_tokens: 1_500_000,
						input_tokens_details: { cached_tokens: 250_000, cache_write_tokens: 125_000 },
					},
				},
			})}\n\n`;
			let capturedPayload: ResponseCreateParamsStreaming | undefined;
			const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				if (typeof init?.body === "string") capturedPayload = JSON.parse(init.body);
				return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
			});

			const stream = streamOpenAIResponses(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{ apiKey: "test-key", serviceTier: requestTier },
			);
			const eventTypes: string[] = [];
			for await (const event of stream) eventTypes.push(event.type);
			const result = await stream.result();

			expect(fetch).toHaveBeenCalledOnce();
			expect(capturedPayload?.service_tier).toBe(requestTier);
			expect(eventTypes).toEqual(["start", "done"]);
			expect(result.stopReason).toBe("stop");
			expect(result.usage).toEqual({
				input: 625_000,
				output: 500_000,
				cacheRead: 250_000,
				cacheWrite: 125_000,
				reasoning: 0,
				totalTokens: 1_500_000,
				cost: {
					input: 5 * multiplier,
					output: 8 * multiplier,
					cacheRead: 0.5 * multiplier,
					cacheWrite: 0.5 * multiplier,
					total: 14 * multiplier,
				},
			});
		},
	);

	it.each([
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.5", "flex", 0.5],
	] as const)("applies %s %s service-tier cost multiplier", async (modelId, serviceTier, multiplier) => {
		const model = getModel("openai", modelId);
		const tokenCount = 100_000;
		const tokenScale = tokenCount / 1_000_000;
		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: serviceTier,
					usage: {
						input_tokens: tokenCount,
						output_tokens: tokenCount,
						total_tokens: tokenCount * 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", serviceTier },
		);

		const result = await stream.result();

		expect(result.usage.cost.input).toBe(model.cost.input * multiplier * tokenScale);
		expect(result.usage.cost.output).toBe(model.cost.output * multiplier * tokenScale);
		expect(result.usage.cost.total).toBe((model.cost.input + model.cost.output) * multiplier * tokenScale);
	});
});
