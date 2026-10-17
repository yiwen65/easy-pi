import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAuthRequiredError,
	McpClient,
	type McpFetch,
	McpHttpError,
	McpSessionExpiredError,
	StreamableHttpTransport,
} from "../src/index.ts";

function setup(fetch: McpFetch, openGetStream = false) {
	const transport = new StreamableHttpTransport({
		url: "https://mcp.example.test/mcp",
		openGetStream,
		reconnect: { initialDelayMs: 10, maxRetries: 2 },
		fetch: async (input, init) => {
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			if (init?.method === "POST") {
				const message = JSON.parse(String(init.body)) as JsonRpcRequest;
				if (message.method === "initialize") {
					return Response.json(
						{
							jsonrpc: "2.0",
							id: message.id,
							result: {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: {},
								serverInfo: { name: "test", version: "1" },
							},
						},
						{ headers: { "mcp-session-id": "established-session" } },
					);
				}
				if (message.id === undefined) return new Response(null, { status: 202 });
			}
			return fetch(input, init);
		},
	});
	const client = new McpClient({ name: "test", version: "1" });
	return { client, transport };
}

function failingBody(partial: boolean) {
	let pulls = 0;
	return new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (partial && pulls++ === 0) controller.enqueue(new TextEncoder().encode("partial diagnostic"));
				else controller.error(new TypeError("terminated"));
			},
		},
		{ highWaterMark: 0 },
	);
}

const statuses = [
	{ status: 401, errorType: McpAuthRequiredError },
	{ status: 404, errorType: McpSessionExpiredError },
	{ status: 503, errorType: McpHttpError },
];

afterEach(() => vi.useRealTimers());

describe("HTTP status survives an unreadable error body", () => {
	describe.each([false, true])("partial diagnostic prefix: %s", (partial) => {
		it.each(statuses)("preserves $status for a pending client request", async ({ status, errorType }) => {
			const body = failingBody(partial);
			const { client, transport } = setup(
				async () => new Response(body, { status, headers: { "www-authenticate": "Bearer" } }),
			);
			await client.connect(transport);
			try {
				expect(transport.sessionId).toBe("established-session");
				const error = await client.listTools().catch((error: unknown) => error);
				expect.soft(error).toBeInstanceOf(errorType);
				expect.soft(error).toMatchObject({ status, body: "" });
				if (status === 401) expect.soft(error).toMatchObject({ wwwAuthenticate: "Bearer" });
				expect(body.locked).toBe(false);
			} finally {
				await client.close();
			}
		});
	});

	it.each(statuses)("still propagates caller cancellation while reading a $status body", async ({ status }) => {
		let reading = () => {};
		const entered = new Promise<void>((resolve) => {
			reading = resolve;
		});
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ pull: reading, cancel }, { highWaterMark: 0 });
		const { client, transport } = setup(async () => new Response(body, { status }));
		await client.connect(transport);
		try {
			const controller = new AbortController();
			const result = transport
				.send({ jsonrpc: "2.0", id: 99, method: "ping" }, controller.signal)
				.catch((error: unknown) => error);
			await entered;
			const reason = new Error("caller stopped");
			controller.abort(reason);
			expect(await result).toBe(reason);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(body.locked).toBe(false);
		} finally {
			await client.close();
		}
	});

	it.each(statuses)(
		"uses status $status, not the body TypeError, for GET retry policy",
		async ({ status, errorType }) => {
			vi.useFakeTimers();
			let gets = 0;
			const body = failingBody(true);
			const { client, transport } = setup(async (_input, init) => {
				expect(init?.method).toBe("GET");
				gets++;
				return gets === 1 ? new Response(body, { status }) : new Response(null, { status: 405 });
			}, true);
			const errors: Error[] = [];
			client.onError((error) => errors.push(error));
			await client.connect(transport);
			try {
				await vi.advanceTimersByTimeAsync(100);
				expect.soft(gets).toBe(status === 503 ? 2 : 1);
				if (status === 503) expect(errors).toEqual([]);
				else {
					expect.soft(errors).toHaveLength(1);
					expect.soft(errors[0]).toBeInstanceOf(errorType);
				}
				expect(body.locked).toBe(false);
			} finally {
				await client.close();
			}
		},
	);
});
