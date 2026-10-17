import { describe, expect, it, vi } from "vitest";
import { type JsonRpcMessage, StreamableHttpTransport } from "../src/index.ts";
import { consumeSseStream } from "../src/transports/streamable-http.ts";

function countedBody(text: string, chunkBytes: number) {
	const bytes = new TextEncoder().encode(text);
	let consumedBytes = 0;
	let pulls = 0;
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (consumedBytes === bytes.length) {
					controller.close();
					return;
				}
				const chunk = bytes.subarray(consumedBytes, consumedBytes + chunkBytes);
				consumedBytes += chunk.byteLength;
				pulls++;
				controller.enqueue(chunk);
			},
			cancel,
		},
		{ highWaterMark: 0 },
	);
	return { body, cancel, stats: () => ({ consumedBytes, pulls, totalBytes: bytes.byteLength }) };
}

const request = { jsonrpc: "2.0", id: 1, method: "ping" } as const;

describe("HTTP consumption bounds", () => {
	it("stops JSON consumption at maxMessageBytes instead of buffering the entire response", async () => {
		const source = countedBody(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(4096) }), 64);
		const transport = new StreamableHttpTransport({
			url: "https://mcp.example.test",
			maxMessageBytes: 256,
			fetch: async () => new Response(source.body, { headers: { "content-type": "application/json" } }),
		});
		const messages: JsonRpcMessage[] = [];
		transport.onMessage((message) => messages.push(message));
		await transport.start();
		try {
			const error = await transport.send(request).catch((error: unknown) => error);
			console.log("JSON bounded consumption", source.stats(), "cancellations", source.cancel.mock.calls.length);
			expect.soft(error).toBeInstanceOf(Error);
			expect.soft(String(error)).toContain("exceeds 256 bytes");
			expect.soft(messages).toEqual([]);
			expect.soft(source.stats().consumedBytes).toBeLessThanOrEqual(320);
			expect(source.cancel).toHaveBeenCalledTimes(1);
			expect(source.body.locked).toBe(false);
		} finally {
			await transport.close();
		}
	});

	it("limits error bodies to 8 KiB while preserving the HTTP failure", async () => {
		const source = countedBody("é".repeat(64 * 1024), 1024);
		const transport = new StreamableHttpTransport({
			url: "https://mcp.example.test",
			fetch: async () => new Response(source.body, { status: 400 }),
		});
		await transport.start();
		try {
			const error = await transport.send(request).catch((error: unknown) => error);
			console.log("error bounded consumption", source.stats(), "cancellations", source.cancel.mock.calls.length);
			expect.soft(error).toMatchObject({ name: "McpHttpError", status: 400, body: "é".repeat(4096) });
			expect.soft(source.stats().consumedBytes).toBe(8192);
			expect(source.cancel).toHaveBeenCalledTimes(1);
			expect(source.body.locked).toBe(false);
		} finally {
			await transport.close();
		}
	});

	it("cancels an unread SSE body on overflow", async () => {
		const source = countedBody("data: xxxxxxxxxxxxxxxx\n".repeat(1024), 22);
		await expect(consumeSseStream(source.body, { maxEventBytes: 256, onEvent: () => {} })).rejects.toThrow(
			"MCP SSE event exceeds 256 bytes",
		);
		console.log("SSE bounded consumption", source.stats(), "cancellations", source.cancel.mock.calls.length);
		expect(source.cancel).toHaveBeenCalledTimes(1);
		expect(source.stats().consumedBytes).toBeLessThan(400);
		expect(source.body.locked).toBe(false);
	});

	it("accepts JSON at the byte boundary, including split UTF-8", async () => {
		const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "é" });
		const source = countedBody(text, 1);
		const transport = new StreamableHttpTransport({
			url: "https://mcp.example.test",
			maxMessageBytes: Buffer.byteLength(text),
			fetch: async () => new Response(source.body, { headers: { "content-type": "application/json" } }),
		});
		const messages: JsonRpcMessage[] = [];
		transport.onMessage((message) => messages.push(message));
		await transport.start();
		try {
			await transport.send(request);
			expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: "é" }]);
			expect(source.cancel).not.toHaveBeenCalled();
			expect(source.body.locked).toBe(false);
		} finally {
			await transport.close();
		}
	});
});
