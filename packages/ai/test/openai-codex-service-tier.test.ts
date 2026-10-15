import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream,
	streamSimple,
} from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamSimpleOpenAI } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.4",
	name: "Test Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://codex.example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 8, output: 16, cacheRead: 2, cacheWrite: 4 },
	contextWindow: 400000,
	maxTokens: 128000,
};
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const apiKey = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
).toString("base64")}.bbb`;

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function terminalEvent(reported: string | null | undefined, id = "resp_1") {
	return {
		type: "response.completed",
		response: {
			id,
			status: "completed",
			...(reported !== undefined ? { service_tier: reported } : {}),
			usage: {
				input_tokens: 1_000_000,
				output_tokens: 500_000,
				total_tokens: 1_500_000,
				input_tokens_details: { cached_tokens: 250_000, cache_write_tokens: 125_000 },
			},
		},
	};
}

function sseResponse(reported: string | null | undefined): Response {
	return new Response(`data: ${JSON.stringify(terminalEvent(reported))}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function decodeBody(body: RequestInit["body"]): Record<string, unknown> {
	if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8")) as Record<string, unknown>;
	}
	throw new Error("Unexpected request body");
}

function mockWebSocket(onSend: (body: Record<string, unknown>, index: number) => unknown[], onConnect?: () => void) {
	const bodies: Record<string, unknown>[] = [];
	class MockWebSocket extends EventTarget {
		readyState = 1;
		constructor() {
			super();
			onConnect?.();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		send(data: string) {
			const body = JSON.parse(data) as Record<string, unknown>;
			bodies.push(body);
			queueMicrotask(() => {
				for (const event of onSend(body, bodies.length)) {
					this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
				}
			});
		}
		close() {
			this.readyState = 3;
		}
	}
	vi.stubGlobal("WebSocket", MockWebSocket);
	return bodies;
}

function expectCost(result: AssistantMessage, multiplier: number) {
	expect(result.stopReason).toBe("stop");
	expect(result.usage.cost).toEqual({
		input: 5 * multiplier,
		output: 8 * multiplier,
		cacheRead: 0.5 * multiplier,
		cacheWrite: 0.5 * multiplier,
		total: 14 * multiplier,
	});
}

const requestedTiers = [undefined, "default", "fast", "priority"] as const;
const reportedTiers = [undefined, null, "default", "fast", "priority"] as const;

describe.each([
	["stream", stream],
	["streamSimple", streamSimple],
] as const)("Codex %s tier observations", (_name, adapter) => {
	it.each(requestedTiers.flatMap((requested) => reportedTiers.map((reported) => ({ requested, reported }))))(
		"keeps requested=$requested, final sent and reported=$reported distinct",
		async ({ requested, reported }) => {
			let body: Record<string, unknown> | undefined;
			const result = await adapter(model, context, {
				apiKey,
				transport: "sse",
				serviceTier: requested,
				sessionId: "session-id",
				promptCacheKey: "prompt-key",
				fetch: async (_url, init) => {
					body = decodeBody(init?.body);
					return sseResponse(reported);
				},
			}).result();
			const sent = requested === "fast" ? "priority" : requested;
			const accelerated = reported === "fast" || reported === "priority" || sent === "priority";
			expect(body?.service_tier).toBe(sent);
			if (sent === undefined) expect(body).not.toHaveProperty("service_tier");
			expect(body).toMatchObject({ model: model.id, prompt_cache_key: "prompt-key", tool_choice: "auto" });
			expect(body?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
			expect(result.serviceTier).toEqual({
				...(requested !== undefined ? { requested, sent } : {}),
				...(reported !== undefined ? { reported } : {}),
				...(accelerated || reported == null ? { costEstimated: true } : {}),
			});
			// Optional observations must not introduce explicit undefined into durable JSON.
			expect(JSON.parse(JSON.stringify(result.serviceTier))).toEqual(result.serviceTier);
			expectCost(result, accelerated ? 2 : 1);
		},
	);
});

describe("Codex final payload tier", () => {
	it.each(["sse", "websocket"] as const)(
		"uses hook replacements for metadata and pricing over %s",
		async (transport) => {
			for (const replacement of [undefined, null, "default", "fast", "priority"] as const) {
				let body: Record<string, unknown> | undefined;
				const wsBodies = mockWebSocket(() => [terminalEvent("default")]);
				const options: SimpleStreamOptions = {
					apiKey,
					transport,
					serviceTier: "fast",
					onPayload: async (payload) => {
						expect((payload as Record<string, unknown>).service_tier).toBe("priority");
						// Changing caller options during the hook must not change the request observation.
						options.serviceTier = "default";
						return { ...(payload as Record<string, unknown>), service_tier: replacement };
					},
					fetch: async (_url, init) => {
						body = decodeBody(init?.body);
						return sseResponse("default");
					},
				};
				const result = await streamSimple(model, context, options).result();
				if (transport === "websocket") body = wsBodies[0];
				const sent = replacement === "fast" ? "priority" : replacement;
				expect(body?.service_tier).toBe(sent);
				expect(result.serviceTier).toEqual({
					requested: "fast",
					...(sent !== undefined ? { sent } : {}),
					reported: "default",
					...(sent === "priority" ? { costEstimated: true } : {}),
				});
				expectCost(result, sent === "priority" ? 2 : 1);
			}
		},
	);

	it("snapshots tier before asynchronous websocket setup", async () => {
		let hookedPayload: Record<string, unknown> | undefined;
		const bodies = mockWebSocket(
			() => [terminalEvent("default")],
			() => {
				if (hookedPayload) hookedPayload.service_tier = "default";
			},
		);
		const result = await streamSimple(model, context, {
			apiKey,
			transport: "websocket",
			serviceTier: "fast",
			onPayload: (payload) => {
				hookedPayload = payload as Record<string, unknown>;
			},
		}).result();
		expect(hookedPayload?.service_tier).toBe("default");
		expect(bodies[0]?.service_tier).toBe("priority");
		expect(result.serviceTier).toEqual({
			requested: "fast",
			sent: "priority",
			reported: "default",
			costEstimated: true,
		});
		expectCost(result, 2);
	});

	it("observes in-place hook mutations without replacing the payload", async () => {
		const result = await stream(model, context, {
			apiKey,
			serviceTier: "priority",
			transport: "sse",
			onPayload: (payload) => {
				(payload as Record<string, unknown>).service_tier = "default";
			},
			fetch: async () => sseResponse(undefined),
		}).result();
		expect(result.serviceTier).toEqual({ requested: "priority", sent: "default", costEstimated: true });
		expectCost(result, 1);
	});

	it.each([null, "auto", "scale", "flex"] as const)("retains low-level SDK tier %s", async (serviceTier) => {
		let body: Record<string, unknown> | undefined;
		const result = await stream(model, context, {
			apiKey,
			serviceTier,
			transport: "sse",
			fetch: async (_url, init) => {
				body = decodeBody(init?.body);
				return sseResponse("default");
			},
		}).result();
		expect(body?.service_tier).toBe(serviceTier);
		expect(result.serviceTier).toMatchObject({ requested: serviceTier, sent: serviceTier, reported: "default" });
		expectCost(result, serviceTier === "flex" ? 0.5 : 1);
	});

	it("does not add tier fields or metadata to another provider's simple adapter", async () => {
		let body: Record<string, unknown> | undefined;
		const result = await streamSimpleOpenAI({ ...model, api: "openai-responses", provider: "openai" }, context, {
			apiKey: "test-key",
			serviceTier: "fast",
			fetch: async (_url, init) => {
				body = decodeBody(init?.body);
				return sseResponse("priority");
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(body).not.toHaveProperty("service_tier");
		expect(result).not.toHaveProperty("serviceTier");
	});
});

describe("Codex tier transports", () => {
	it.each(reportedTiers)("retains raw websocket response tier %s", async (reported) => {
		const bodies = mockWebSocket(() => [terminalEvent(reported)]);
		const result = await streamSimple(model, context, {
			apiKey,
			serviceTier: "fast",
			transport: "websocket",
		}).result();
		expect(bodies[0]?.service_tier).toBe("priority");
		expect(result.serviceTier).toEqual({
			requested: "fast",
			sent: "priority",
			...(reported !== undefined ? { reported } : {}),
			costEstimated: true,
		});
		expectCost(result, 2);
	});

	it.each([
		["gpt-5.5", 2.5],
		["gpt-6.1-sol", 2],
	] as const)("retains existing estimated Fast multiplier for %s", async (id, multiplier) => {
		const result = await stream({ ...model, id }, context, {
			apiKey,
			transport: "sse",
			fetch: async () => sseResponse("fast"),
		}).result();
		expect(result.serviceTier).toEqual({ reported: "fast", costEstimated: true });
		expectCost(result, multiplier);
	});

	it("reuses a cached connection but invalidates continuation when final sent tier changes", async () => {
		const bodies = mockWebSocket((_body, index) => [terminalEvent("default", `resp_${index}`)]);
		const current: Context = { messages: [...context.messages] };
		for (const [index, requested] of ["fast", "priority", "default", "fast", "fast"].entries()) {
			const result = await streamSimple(model, current, {
				apiKey,
				sessionId: "tier-switch",
				transport: "websocket-cached",
				serviceTier: requested as SimpleStreamOptions["serviceTier"],
				onPayload: index === 3 ? (payload) => ({ ...(payload as object), service_tier: "default" }) : undefined,
			}).result();
			expectCost(result, index === 2 || index === 3 ? 1 : 2);
			expect(result.serviceTier?.sent).toBe(index === 2 || index === 3 ? "default" : "priority");
			current.messages.push(result, { role: "user", content: `next ${index}`, timestamp: index + 2 });
		}
		expect(bodies.map((body) => body.service_tier)).toEqual([
			"priority",
			"priority",
			"default",
			"default",
			"priority",
		]);
		expect(bodies.map((body) => body.previous_response_id)).toEqual([
			undefined,
			"resp_1",
			undefined,
			"resp_3",
			undefined,
		]);
		expect(bodies.map((body) => (body.input as unknown[]).length)).toEqual([1, 1, 3, 1, 5]);
		expect(getOpenAICodexWebSocketDebugStats("tier-switch")).toMatchObject({
			connectionsCreated: 1,
			connectionsReused: 4,
			fullContextRequests: 3,
			deltaRequests: 2,
		});
	});

	it("keeps the final hook tier through websocket fallback and SSE retry", async () => {
		vi.useFakeTimers();
		const bodies = mockWebSocket(() => []);
		const fetchedBodies: Record<string, unknown>[] = [];
		const hook = vi.fn((payload: unknown) => ({ ...(payload as object), service_tier: "fast" }));
		const pending = streamSimple(model, context, {
			apiKey,
			sessionId: "fallback-tier",
			serviceTier: "default",
			transport: "auto",
			timeoutMs: 10,
			maxRetries: 1,
			onPayload: hook,
			fetch: async (_url, init) => {
				fetchedBodies.push(decodeBody(init?.body));
				return fetchedBodies.length === 1
					? new Response("retry", { status: 503, headers: { "retry-after-ms": "1" } })
					: sseResponse(null);
			},
		}).result();
		await vi.advanceTimersByTimeAsync(11);
		const result = await pending;
		expect(hook).toHaveBeenCalledOnce();
		expect(bodies[0]?.service_tier).toBe("priority");
		expect(fetchedBodies).toHaveLength(2);
		expect(fetchedBodies.every((body) => body.service_tier === "priority")).toBe(true);
		expect(result.serviceTier).toEqual({
			requested: "default",
			sent: "priority",
			reported: null,
			costEstimated: true,
		});
		expectCost(result, 2);
	});

	it.each(["sse", "websocket"] as const)(
		"preserves failure tier reports over %s without a Standard retry",
		async (transport) => {
			const event = {
				type: "response.failed",
				response: {
					status: "failed",
					service_tier: "default",
					error: { code: "tier_denied", message: "not eligible" },
				},
			};
			const bodies = mockWebSocket(() => [event]);
			const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify(event)}\n\n`));
			const result = await streamSimple(model, context, { apiKey, transport, serviceTier: "fast", fetch }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("not eligible");
			expect(result.serviceTier).toEqual({ requested: "fast", sent: "priority", reported: "default" });
			expect(fetch).toHaveBeenCalledTimes(transport === "sse" ? 1 : 0);
			expect(bodies).toHaveLength(transport === "websocket" ? 1 : 0);
		},
	);
});
