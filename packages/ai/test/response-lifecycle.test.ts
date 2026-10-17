import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as mistral } from "../src/api/mistral-conversations.ts";
import { stream as codex } from "../src/api/openai-codex-responses.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import { stream as pi } from "../src/api/pi-messages.ts";
import type { Api, AssistantMessageEvent, Model, StreamOptions } from "../src/types.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test-model",
		name: "Test",
		api,
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 32000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}
const token = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }))}.signature`;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const options: StreamOptions = { apiKey: token, transport: "sse", maxRetries: 0 };
const adapters = [
	{
		name: "Anthropic",
		call: (extra: StreamOptions) =>
			anthropic(model("anthropic-messages"), { messages: [] }, { ...options, ...extra }),
	},
	{
		name: "Codex",
		call: (extra: StreamOptions) =>
			codex(model("openai-codex-responses"), { messages: [] }, { ...options, ...extra }),
	},
	{
		name: "Mistral",
		call: (extra: StreamOptions) =>
			mistral(model("mistral-conversations"), { messages: [] }, { ...options, ...extra }),
	},
	{
		name: "OpenAI Responses",
		call: (extra: StreamOptions) => responses(model("openai-responses"), { messages: [] }, { ...options, ...extra }),
	},
	{
		name: "OpenAI Completions",
		call: (extra: StreamOptions) =>
			completions(model("openai-completions"), { messages: [] }, { ...options, ...extra }),
	},
	{
		name: "pi-messages",
		call: (extra: StreamOptions) => pi(model("pi-messages"), { messages: [] }, { ...options, ...extra }),
	},
];
const encoder = new TextEncoder();
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
async function collect(source: AssistantMessageEventStream) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of source) events.push(event);
	return { events, message: await source.result() };
}
function piFrames(events: unknown[]) {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
const partialPiEvents = [
	{ type: "start" },
	{ type: "text_start", contentIndex: 0 },
	{ type: "text_delta", contentIndex: 0, delta: "partial" },
];

afterEach(() => vi.restoreAllMocks());

describe.each(adapters)("$name response hook ownership", ({ call }) => {
	it("cancels the unconsumed body when onResponse throws", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const source = call({
			fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
			onResponse: () => {
				throw new Error("hook failed");
			},
		});
		const { message, events } = await collect(source);
		try {
			expect(message.errorMessage).toContain("hook failed");
			expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(body.locked).toBe(false);
		} finally {
			await body.cancel().catch(() => {});
		}
	});
});

describe.each(adapters.filter(({ name }) => name === "Codex" || name === "Mistral"))(
	"$name error body ownership",
	({ call }) => {
		it.each([401, 503])("cancels a stalled %i diagnostic body after headers", async (status) => {
			const caller = new AbortController();
			const reading = deferred();
			const cancel = vi.fn();
			let bodyController!: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						bodyController = controller;
					},
					pull() {
						reading.resolve();
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			const source = call({
				timeoutMs: 10000,
				signal: caller.signal,
				fetch: async () => new Response(body, { status }),
			});
			await reading.promise;
			caller.abort(new Error("cancel diagnostics"));
			const cancelledOnAbort = cancel.mock.calls.length;
			// Release the fixture on the broken implementation too, avoiding timeout-based reproduction.
			if (cancelledOnAbort === 0) bodyController.close();
			const { message, events } = await collect(source);
			expect(message.stopReason).toBe("aborted");
			expect(cancelledOnAbort).toBe(1);
			expect(body.locked).toBe(false);
			expect(events.filter((event) => event.type === "error")).toHaveLength(1);
		});

		it("bounds error body consumption and cancels unread bytes", async () => {
			let bytesRead = 0;
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						if (bytesRead === 12000) {
							controller.close();
							return;
						}
						bytesRead += 1000;
						controller.enqueue(encoder.encode("x".repeat(1000)));
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			const { message } = await collect(call({ fetch: async () => new Response(body, { status: 400 }) }));
			expect(message.stopReason).toBe("error");
			expect(bytesRead).toBe(4000);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(body.locked).toBe(false);
		});
	},
);

describe("Anthropic SSE newline and body ownership", () => {
	const events = [
		{
			type: "message_start",
			message: { id: "msg_test", model: "test-model", usage: { input_tokens: 2, output_tokens: 0 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello 世界" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];
	it.each(["\n", "\r\n", "\r"])("parses bytewise %j including multiline data and EOF", async (newline) => {
		const payload = events
			.map(
				(event) =>
					`event: ${event.type}${newline}${JSON.stringify(event, null, 2)
						.split("\n")
						.map((line) => `data: ${line}`)
						.join(newline)}`,
			)
			.join(newline + newline);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of encoder.encode(payload)) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		});
		const { message, events: output } = await collect(adapters[0].call({ fetch: async () => new Response(body) }));
		expect(message.stopReason, message.errorMessage).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "hello 世界" }]);
		expect(output.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
	});

	it.each(["error frame", "malformed event"])("cancels an open body on %s", async (kind) => {
		const cancel = vi.fn();
		const payload =
			kind === "error frame"
				? 'event: error\ndata: {"error":"failed"}\n\n'
				: "event: message_delta\ndata: not-json\n\n";
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(payload));
			},
			cancel,
		});
		const { message } = await collect(adapters[0].call({ fetch: async () => new Response(body) }));
		try {
			expect(message.stopReason).toBe("error");
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(body.locked).toBe(false);
		} finally {
			await body.cancel();
		}
	});
});

describe("pi-messages partial results and early exits", () => {
	it.each(["done", "error"])("cancels an open body on terminal %s", async (type) => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						piFrames([...partialPiEvents, { type, reason: type === "done" ? "stop" : "error", usage }]),
					),
				);
			},
			cancel,
		});
		const { message, events } = await collect(adapters[5].call({ fetch: async () => new Response(body) }));
		// The terminal event is delivered before the producer's finally runs.
		await Promise.resolve();
		try {
			expect(message.content).toEqual([{ type: "text", text: "partial" }]);
			expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(body.locked).toBe(false);
		} finally {
			await body.cancel().catch(() => {});
		}
	});

	it.each(["EOF", "malformed frame", "abort"])(
		"retains text, thinking and partial tool arguments after %s",
		async (failure) => {
			const caller = new AbortController();
			let body!: ReadableStreamDefaultController<Uint8Array>;
			const partial = piFrames([
				...partialPiEvents,
				{ type: "thinking_start", contentIndex: 1 },
				{ type: "thinking_delta", contentIndex: 1, delta: "reason" },
				{ type: "toolcall_start", contentIndex: 2, id: "call", toolName: "lookup" },
				{ type: "toolcall_delta", contentIndex: 2, delta: '{"query":"partial"' },
			]);
			const response = new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						body = controller;
						controller.enqueue(encoder.encode(partial));
						if (failure === "malformed frame") controller.enqueue(encoder.encode("data: not-json\n\n"));
						if (failure !== "abort") controller.close();
					},
				}),
			);
			// A signal-aware transport reproduces loss of already emitted content, independently of body cancellation.
			caller.signal.addEventListener("abort", () => body.error(new Error("Request aborted")));
			const source = adapters[5].call({ signal: caller.signal, fetch: async () => response });
			const events: AssistantMessageEvent[] = [];
			for await (const event of source) {
				events.push(event);
				if (failure === "abort" && event.type === "toolcall_delta") caller.abort();
			}
			const message = await source.result();
			expect(message.stopReason).toBe(failure === "abort" ? "aborted" : "error");
			expect(message.content).toEqual([
				{ type: "text", text: "partial" },
				{ type: "thinking", thinking: "reason" },
				{ type: "toolCall", id: "call", name: "lookup", arguments: { query: "partial" } },
			]);
			expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
		},
	);
});
