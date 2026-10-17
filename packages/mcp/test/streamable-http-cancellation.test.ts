import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AuthProvider,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpClient,
	type McpFetch,
	StreamableHttpTransport,
} from "../src/index.ts";

type TestRequest = JsonRpcRequest & { params?: Record<string, unknown> };

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function reply(id: number | string, result: unknown = { content: [] }): Response {
	return Response.json({ jsonrpc: "2.0", id, result });
}

async function connect(fetch: McpFetch, authProvider?: AuthProvider) {
	const transport = new StreamableHttpTransport({
		url: "https://mcp.example.test/mcp",
		openGetStream: false,
		reconnect: { initialDelayMs: 10 },
		authProvider,
		fetch: async (input, init) => {
			if (init?.method === "POST") {
				const message = JSON.parse(String(init.body)) as TestRequest;
				if (message.method === "initialize") {
					return reply(message.id, {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: {},
						serverInfo: { name: "test", version: "1" },
					});
				}
				if (message.id === undefined) return new Response(null, { status: 202 });
			}
			return fetch(input, init);
		},
	});
	const client = new McpClient({ name: "test", version: "1" });
	await client.connect(transport);
	return client;
}

afterEach(() => vi.useRealTimers());

describe("request-owned HTTP cancellation", () => {
	it("does not dispatch a POST after cancellation during token lookup", async () => {
		const entered = gate();
		const release = gate();
		const sent: string[] = [];
		let delayToken = false;
		const client = await connect(
			async (_input, init) => {
				const message = JSON.parse(String(init?.body)) as JsonRpcRequest;
				sent.push(String((message.params as Record<string, unknown>)?.name));
				return reply(message.id);
			},
			{
				token: async () => {
					if (delayToken) {
						delayToken = false;
						entered.resolve();
						await release.promise;
					}
					return "test-token";
				},
			},
		);
		try {
			delayToken = true;
			const controller = new AbortController();
			const result = client
				.callTool("cancelled", {}, { signal: controller.signal })
				.catch((error: unknown) => error);
			await entered.promise;
			controller.abort();
			expect(await result).toMatchObject({ name: "AbortError" });
			release.resolve();
			await client.callTool("unrelated");
			expect(sent).toEqual(["unrelated"]);
		} finally {
			release.resolve();
			await client.close();
		}
	});

	it("cancels one auth retry without cancelling another request's shared authorization", async () => {
		const release = gate();
		const entered = gate();
		let waiters = 0;
		let authorized = false;
		const sent: string[] = [];
		const client = await connect(
			async (_input, init) => {
				const message = JSON.parse(String(init?.body)) as JsonRpcRequest;
				sent.push(`${String((message.params as Record<string, unknown>)?.name)}:${authorized}`);
				return authorized ? reply(message.id) : new Response(null, { status: 401 });
			},
			{
				token: async () => "test-token",
				onUnauthorized: async () => {
					if (++waiters === 2) entered.resolve();
					await release.promise;
					authorized = true;
				},
			},
		);
		try {
			const controller = new AbortController();
			const cancelled = client
				.callTool("cancelled", {}, { signal: controller.signal })
				.catch((error: unknown) => error);
			const unrelated = client.callTool("unrelated");
			await entered.promise;
			controller.abort();
			expect(await cancelled).toMatchObject({ name: "AbortError" });
			release.resolve();
			await unrelated;
			expect(sent).toEqual(["cancelled:false", "unrelated:false", "unrelated:true"]);
		} finally {
			release.resolve();
			await client.close();
		}
	});

	it.each([
		["application/json", "abort"],
		["text/event-stream", "abort"],
		["application/json", "timeout"],
		["text/event-stream", "timeout"],
	])("cancels a stalled %s body on %s without closing other requests", async (type, reason) => {
		vi.useFakeTimers();
		const reading = gate();
		const cancel = vi.fn();
		let requestSignal: AbortSignal | null | undefined;
		const body = new ReadableStream<Uint8Array>({
			pull() {
				reading.resolve();
			},
			cancel,
		});
		const client = await connect(async (_input, init) => {
			const message = JSON.parse(String(init?.body)) as JsonRpcRequest;
			if ((message.params as Record<string, unknown>)?.name === "unrelated") return reply(message.id);
			requestSignal = init?.signal;
			return new Response(body, { headers: { "content-type": type } });
		});
		try {
			const controller = new AbortController();
			const result = client
				.callTool("stalled", {}, { signal: controller.signal, timeoutMs: 50 })
				.catch((error: unknown) => error);
			await reading.promise;
			await vi.advanceTimersByTimeAsync(0);
			if (reason === "abort") controller.abort();
			else await vi.advanceTimersByTimeAsync(50);
			expect(await result).toMatchObject({ name: reason === "abort" ? "AbortError" : "McpTimeoutError" });
			await vi.advanceTimersByTimeAsync(0);
			expect.soft(requestSignal?.aborted).toBe(true);
			expect.soft(cancel).toHaveBeenCalledTimes(1);
			expect.soft(body.locked).toBe(false);
			expect(await client.callTool("unrelated")).toEqual({ content: [] });
		} finally {
			await client.close();
		}
	});

	it("does not deliver more events from an already buffered chunk after cancellation", async () => {
		const controller = new AbortController();
		const errors: Error[] = [];
		const client = await connect(async (_input, init) => {
			const message = JSON.parse(String(init?.body)) as JsonRpcRequest;
			const cancel = JSON.stringify({ jsonrpc: "2.0", method: "cancel-now" });
			const result = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } });
			return new Response(`data: ${cancel}\n\ndata: ${result}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		});
		client.onError((error) => errors.push(error));
		client.onNotification("cancel-now", () => controller.abort());
		try {
			await expect(client.callTool("cancelled", {}, { signal: controller.signal })).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(errors).toEqual([]);
		} finally {
			await client.close();
		}
	});

	it.each([false, true])("stops response resumption (GET already started: %s)", async (getStarted) => {
		vi.useFakeTimers();
		let gets = 0;
		let getSignal: AbortSignal | null | undefined;
		const client = await connect(async (_input, init) => {
			if (init?.method === "GET") {
				gets++;
				getSignal = init.signal;
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				});
			}
			return new Response("id: resumable\n\n", { headers: { "content-type": "text/event-stream" } });
		});
		try {
			const controller = new AbortController();
			const result = client.callTool("stalled", {}, { signal: controller.signal }).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(getStarted ? 10 : 0);
			expect(gets).toBe(getStarted ? 1 : 0);
			controller.abort();
			expect(await result).toMatchObject({ name: "AbortError" });
			await vi.advanceTimersByTimeAsync(100);
			expect(gets).toBe(getStarted ? 1 : 0);
			if (getStarted) expect(getSignal?.aborted).toBe(true);
		} finally {
			await client.close();
		}
	});
});
