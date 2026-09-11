import { zstdDecompressSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	streamSimple,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model, SimpleStreamOptions, Transport } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "synthetic-codex",
	name: "Synthetic Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = { messages: [{ role: "user", content: "synthetic prefix", timestamp: 1 }] };
const apiKey = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64")}.test`;

function response(text: string): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${text}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${text}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: `resp_${text}`,
				status: "completed",
				usage: {
					input_tokens: 100,
					output_tokens: 1,
					total_tokens: 101,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function body(init?: RequestInit): Record<string, unknown> {
	const value = init?.body;
	return JSON.parse(typeof value === "string" ? value : zstdDecompressSync(value as Uint8Array).toString());
}

afterEach(() => {
	vi.unstubAllGlobals();
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
});

test.each<Transport>(["sse", "auto", "websocket", "websocket-cached"])(
	"cache affinity forces SSE without sharing request or WS identity (%s)",
	async (transport) => {
		const websocket = vi.fn(() => {
			throw new Error("WebSocket must not be opened");
		});
		vi.stubGlobal("WebSocket", websocket);
		const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			requests.push({ headers: new Headers(init?.headers), body: body(init) });
			return response(new Headers(init?.headers).get("x-client-request-id")!);
		};
		const results = await Promise.all(
			["child-a", "child-b"].map((sessionId) =>
				streamSimple(model, context, {
					apiKey,
					fetch,
					transport,
					sessionId,
					cacheAffinityId: "parent-affinity",
					promptCacheKey: "parent-key",
				}).result(),
			),
		);
		expect(results.map((result) => result.stopReason)).toEqual(["stop", "stop"]);
		expect(results.map((result) => result.content)).toEqual([
			[expect.objectContaining({ type: "text", text: "child-a" })],
			[expect.objectContaining({ type: "text", text: "child-b" })],
		]);
		expect(websocket).not.toHaveBeenCalled();
		expect(requests.map((request) => request.headers.get("session-id"))).toEqual([
			"parent-affinity",
			"parent-affinity",
		]);
		expect(requests.map((request) => request.headers.get("x-client-request-id"))).toEqual(["child-a", "child-b"]);
		expect(requests.map((request) => request.body.prompt_cache_key)).toEqual(["parent-key", "parent-key"]);
		for (const request of requests) expect(request.body.previous_response_id).toBeUndefined();
		for (const id of ["parent-affinity", "child-a", "child-b"])
			expect(getOpenAICodexWebSocketDebugStats(id)).toBeUndefined();
	},
);

test("cache none suppresses inherited cache headers/key and still avoids shared WebSockets", async () => {
	const websocket = vi.fn(() => {
		throw new Error("Unexpected WebSocket");
	});
	vi.stubGlobal("WebSocket", websocket);
	let headers: Headers | undefined;
	let sent: Record<string, unknown> | undefined;
	const result = await streamSimple(model, context, {
		apiKey,
		sessionId: "child",
		cacheAffinityId: "parent",
		promptCacheKey: "parent-key",
		cacheRetention: "none",
		transport: "auto",
		fetch: async (_url, init) => {
			headers = new Headers(init?.headers);
			sent = body(init);
			return response("none");
		},
	}).result();
	expect(result.stopReason).toBe("stop");
	expect(websocket).not.toHaveBeenCalled();
	expect(headers?.has("session-id")).toBe(false);
	expect(headers?.has("x-client-request-id")).toBe(false);
	expect(sent?.prompt_cache_key).toBeUndefined();
});

test("default identity is unchanged; long affinity is bounded independently", async () => {
	const headers: Headers[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		headers.push(new Headers(init?.headers));
		return response("ok");
	};
	await streamSimple(model, context, { apiKey, fetch, sessionId: "own", transport: "sse" }).result();
	await streamSimple(model, context, {
		apiKey,
		fetch,
		sessionId: "own",
		cacheAffinityId: "p".repeat(100),
		transport: "sse",
	}).result();
	expect(headers[0].get("session-id")).toBe("own");
	expect(headers[0].get("x-client-request-id")).toBe("own");
	expect(headers[1].get("session-id")).not.toBe("own");
	expect(headers[1].get("session-id")!.length).toBeLessThanOrEqual(64);
	expect(headers[1].get("x-client-request-id")).toBe("own");
});

test("aborting one shared-affinity request does not abort or contaminate its sibling", async () => {
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const abort = new AbortController();
	const siblingAbort = new AbortController();
	const signals: AbortSignal[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		const headers = new Headers(init?.headers);
		expect(headers.get("session-id")).toBe("parent-affinity");
		if (init?.signal) signals.push(init.signal);
		if (headers.get("x-client-request-id") === "cancelled-child") {
			entered();
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("Request was aborted")), { once: true });
			});
		}
		return response("sibling-only");
	};
	const options = {
		apiKey,
		fetch,
		transport: "sse",
		cacheAffinityId: "parent-affinity",
		promptCacheKey: "key",
	} satisfies SimpleStreamOptions;
	const cancelled = streamSimple(model, context, {
		...options,
		sessionId: "cancelled-child",
		signal: abort.signal,
	}).result();
	try {
		await started;
		const sibling = await streamSimple(model, context, {
			...options,
			sessionId: "sibling",
			signal: siblingAbort.signal,
		}).result();
		abort.abort();
		expect((await cancelled).stopReason).toBe("aborted");
		expect(sibling.stopReason).toBe("stop");
		expect(sibling.content).toEqual([expect.objectContaining({ type: "text", text: "sibling-only" })]);
		expect(signals[0]).not.toBe(signals[1]);
		expect(signals[1].aborted).toBe(false);
	} finally {
		abort.abort();
	}
});
