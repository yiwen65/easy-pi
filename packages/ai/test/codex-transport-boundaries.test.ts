import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { AssistantMessageEvent, Model, ProviderEnv, StreamOptions } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "codex-test",
	name: "Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://first.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 32000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const token = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "same-account" } }))}.signature`;
const complete = {
	type: "response.completed",
	response: { id: "response-1", status: "completed", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
};
const context = { messages: [] };
const encoder = new TextEncoder();
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
async function collect(source: ReturnType<typeof stream>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of source) events.push(event);
	return { events, message: await source.result() };
}
function success() {
	return new Response(`data: ${JSON.stringify(complete)}\n\n`);
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

class Socket {
	static instances: Socket[] = [];
	url: string;
	headers: Record<string, string>;
	readyState = 1;
	requests: Record<string, unknown>[] = [];
	listeners = new Map<string, Set<(event: unknown) => void>>();
	close = vi.fn(() => {
		this.readyState = 3;
	});
	constructor(url: string, options: { headers: Record<string, string> }) {
		this.url = url;
		this.headers = options.headers;
		Socket.instances.push(this);
		queueMicrotask(() => this.emit("open", {}));
	}
	addEventListener(type: string, listener: (event: unknown) => void) {
		let listeners = this.listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}
	removeEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.get(type)?.delete(listener);
	}
	emit(type: string, event: unknown) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
	send(body: string) {
		this.requests.push(JSON.parse(body));
		queueMicrotask(() => this.emit("message", { data: JSON.stringify(complete) }));
	}
}

describe("Codex cached socket handshake identity", () => {
	it.each(["endpoint", "token", "tenant header", "proxy"])(
		"does not reuse a socket or continuation after %s changes",
		async (change) => {
			Socket.instances = [];
			vi.stubGlobal("WebSocket", Socket);
			const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Unexpected SSE fallback"));
			const env: ProviderEnv = { https_proxy: "http://proxy-one.invalid", no_proxy: "", NO_PROXY: "unused.invalid" };
			const options: StreamOptions = {
				apiKey: token,
				sessionId: "same-session",
				transport: "websocket-cached",
				headers: { "X-Tenant": "one" },
				env,
				fetch,
			};
			expect((await stream(model, context, options).result()).stopReason).toBe("stop");
			const nextModel = change === "endpoint" ? { ...model, baseUrl: "https://second.invalid" } : model;
			const next = {
				...options,
				apiKey: change === "token" ? token.replace(/signature$/, "rotated") : token,
				headers: { "x-tenant": change === "tenant header" ? "two" : "one" },
				env: change === "proxy" ? { ...env, https_proxy: "http://proxy-two.invalid" } : env,
			};
			expect((await stream(nextModel, context, next).result()).stopReason).toBe("stop");
			expect(fetch).not.toHaveBeenCalled();
			expect(Socket.instances).toHaveLength(2);
			expect(Socket.instances[0].close).toHaveBeenCalledTimes(1);
			expect(Socket.instances[1].requests[0]).not.toHaveProperty("previous_response_id");
			expect(Socket.instances[1].url).toContain(change === "endpoint" ? "second.invalid" : "first.invalid");
			expect(Socket.instances[1].headers.authorization).toBe(`Bearer ${next.apiKey}`);
			expect(Socket.instances[1].headers["x-tenant"]).toBe(next.headers["x-tenant"]);
		},
	);

	it("keeps an active socket isolated while a different handshake runs (10 controlled schedules)", async () => {
		vi.stubGlobal("WebSocket", Socket);
		for (let run = 0; run < 10; run++) {
			Socket.instances = [];
			const options: StreamOptions = {
				apiKey: token,
				sessionId: `busy-${run}`,
				transport: "websocket-cached",
				headers: { "x-tenant": "one" },
				env: { no_proxy: "*" },
			};
			await stream(model, context, options).result();
			const cached = Socket.instances[0];
			const sent = deferred();
			cached.send = (body) => {
				cached.requests.push(JSON.parse(body));
				sent.resolve();
			};
			const active = stream(model, context, options);
			await sent.promise;
			const changed = { ...options, headers: { "x-tenant": "two" } };
			const concurrent = await stream(model, context, changed).result();
			expect(concurrent.stopReason).toBe("stop");
			expect(cached.close).not.toHaveBeenCalled();
			expect(Socket.instances[1].headers["x-tenant"]).toBe("two");
			expect(Socket.instances[1].requests[0]).not.toHaveProperty("previous_response_id");
			expect(Socket.instances[1].close).toHaveBeenCalledTimes(1);
			cached.emit("message", { data: JSON.stringify(complete) });
			expect((await active.result()).stopReason).toBe("stop");
			expect((await stream(model, context, changed).result()).stopReason).toBe("stop");
			expect(Socket.instances).toHaveLength(3);
			expect(cached.close).toHaveBeenCalledTimes(1);
			closeOpenAICodexWebSocketSessions(options.sessionId);
		}
	});

	it("reuses equivalent case-normalized handshake headers and continuation", async () => {
		Socket.instances = [];
		vi.stubGlobal("WebSocket", Socket);
		const options: StreamOptions = {
			apiKey: token,
			sessionId: "same-session",
			transport: "websocket-cached",
			headers: { "X-Tenant": "one" },
			env: { no_proxy: "*" },
		};
		await stream(model, context, options).result();
		const result = await stream(model, context, { ...options, headers: { "x-tenant": "one" } }).result();
		expect(result.stopReason).toBe("stop");
		expect(Socket.instances).toHaveLength(1);
		expect(Socket.instances[0].requests[1]).toHaveProperty("previous_response_id", "response-1");
	});
});

describe("Codex SSE request lifetime and retries", () => {
	it("detaches the header deadline without a caller signal", async () => {
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const headersSeen = deferred();
		let requestSignal: AbortSignal | null | undefined;
		let body!: ReadableStreamDefaultController<Uint8Array>;
		const source = stream(model, context, {
			apiKey: token,
			transport: "sse",
			timeoutMs: 20,
			fetch: async (_input, init) => {
				requestSignal = init?.signal;
				const response = new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							body = controller;
						},
					}),
				);
				requestSignal?.addEventListener("abort", () => body.error(new Error("Header deadline reached the body")));
				return response;
			},
			onResponse: () => headersSeen.resolve(),
		});
		await headersSeen.promise;
		timeout.abort();
		if (!requestSignal?.aborted) body.enqueue(encoder.encode(`data: ${JSON.stringify(complete)}\n\n`));
		const { message, events } = await collect(source);
		expect(requestSignal?.aborted).toBe(false);
		expect(message.stopReason).toBe("stop");
		expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
	});

	it.each([400, 401, 403])("does not retry terminal HTTP %i", async (status) => {
		vi.useFakeTimers();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(async () => new Response("bad request", { status }));
		const result = collect(stream(model, context, { apiKey: token, transport: "sse", maxRetries: 2, fetch }));
		await vi.runAllTimersAsync();
		const { message, events } = await result;
		expect(message.stopReason).toBe("error");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(events.filter((event) => event.type === "error")).toHaveLength(1);
	});

	it("does not retry a failing onResponse after an accepted POST", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => success());
		const onResponse = vi.fn(() => {
			throw new Error("Hook failed");
		});
		const result = collect(
			stream(model, context, { apiKey: token, transport: "sse", maxRetries: 2, fetch, onResponse }),
		);
		await vi.runAllTimersAsync();
		expect((await result).message.errorMessage).toContain("Hook failed");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledTimes(1);
	});

	it("does not retry a transport cancellation error", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Request was aborted"));
		const result = collect(stream(model, context, { apiKey: token, transport: "sse", maxRetries: 2, fetch }));
		await vi.runAllTimersAsync();
		expect((await result).message.errorMessage).toContain("Request was aborted");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([429, 503, "network"] as const)("preserves transient %s retries", async (status) => {
		vi.useFakeTimers();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce(async () => {
				if (status === "network") throw new TypeError("fetch failed");
				return new Response("retry", { status, headers: { "retry-after-ms": "1" } });
			})
			.mockImplementation(async () => success());
		const result = collect(stream(model, context, { apiKey: token, transport: "sse", maxRetries: 1, fetch }));
		await vi.runAllTimersAsync();
		expect((await result).message.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

describe("Codex SSE line endings", () => {
	it.each(["\r\n", "\r"])("finishes a %j terminal frame without waiting for EOF", async (newline) => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(complete)}${newline}${newline}`));
			},
			cancel,
		});
		const { message } = await collect(
			stream(model, context, { apiKey: token, transport: "sse", fetch: async () => new Response(body) }),
		);
		expect(message.stopReason).toBe("stop");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(body.locked).toBe(false);
	});

	it.each(["\n", "\r\n", "\r"])(
		"parses %j lines in bytewise chunks with multiline data and an EOF frame",
		async (newline) => {
			const frames = [
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_1", role: "assistant", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "hello 世界" },
				complete,
			];
			const payload = frames
				.map((event) =>
					JSON.stringify(event, null, 2)
						.split("\n")
						.map((line) => `data: ${line}`)
						.join(newline),
				)
				.join(newline + newline);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const byte of encoder.encode(payload)) controller.enqueue(Uint8Array.of(byte));
					controller.close();
				},
			});
			const { message, events } = await collect(
				stream(model, context, { apiKey: token, transport: "sse", fetch: async () => new Response(body) }),
			);
			expect(message.stopReason, message.errorMessage).toBe("stop");
			expect(message.content[0]).toMatchObject({ type: "text", text: "hello 世界" });
			expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
		},
	);
});
