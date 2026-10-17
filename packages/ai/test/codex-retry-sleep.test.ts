import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "codex-test",
	name: "Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 32000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const token = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }))}.signature`;

function retryingFetch(failure: "http" | "network") {
	return vi
		.fn<typeof globalThis.fetch>()
		.mockImplementationOnce(async () => {
			if (failure === "network") throw new TypeError("fetch failed");
			return new Response("retry later", { status: 503, headers: { "retry-after-ms": "1000" } });
		})
		.mockImplementationOnce(
			async () =>
				new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
				),
		);
}

function start(fetch: typeof globalThis.fetch, signal: AbortSignal) {
	return stream(model, { messages: [] }, { apiKey: token, transport: "sse", maxRetries: 1, fetch, signal });
}

async function collect(source: ReturnType<typeof stream>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of source) events.push(event);
	return { events, message: await source.result() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Codex retry sleep listener ownership", () => {
	it.each(["http", "network"] as const)(
		"returns to the caller listener baseline after 8 successful %s retries",
		async (failure) => {
			const caller = new AbortController();
			const existingListener = vi.fn();
			caller.signal.addEventListener("abort", existingListener);
			const baseline = getEventListeners(caller.signal, "abort").length;
			const settledCounts: number[] = [];
			for (let run = 0; run < 8; run++) {
				const fetch = retryingFetch(failure);
				const result = collect(start(fetch, caller.signal));
				await vi.advanceTimersByTimeAsync(0);
				expect(vi.getTimerCount()).toBe(1);
				await vi.advanceTimersByTimeAsync(999);
				expect(fetch).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(1);
				const { message, events } = await result;
				expect(message.stopReason).toBe("stop");
				expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
				expect(fetch).toHaveBeenCalledTimes(2);
				expect(vi.getTimerCount()).toBe(0);
				settledCounts.push(getEventListeners(caller.signal, "abort").length);
			}
			expect(baseline).toBe(1);
			expect(settledCounts).toEqual(Array(8).fill(baseline));
			caller.abort();
			expect(existingListener).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["http", "network"] as const)(
		"removes the listener and retry timer after %s cancellation (8 repetitions)",
		async (failure) => {
			const settledCounts: number[] = [];
			for (let run = 0; run < 8; run++) {
				const caller = new AbortController();
				const existingListener = vi.fn();
				caller.signal.addEventListener("abort", existingListener);
				const fetch = retryingFetch(failure);
				const result = collect(start(fetch, caller.signal));
				await vi.advanceTimersByTimeAsync(0);
				expect(getEventListeners(caller.signal, "abort")).toHaveLength(2);
				expect(vi.getTimerCount()).toBe(1);
				caller.abort(new Error("Caller cancelled"));
				const { message, events } = await result;
				expect(message.stopReason).toBe("aborted");
				expect(message.errorMessage).toBe("Request was aborted");
				expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
				expect(vi.getTimerCount()).toBe(0);
				expect(existingListener).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(1000);
				expect(fetch).toHaveBeenCalledTimes(1);
				settledCounts.push(getEventListeners(caller.signal, "abort").length);
			}
			expect(settledCounts).toEqual(Array(8).fill(1));
		},
	);

	it.each(["abort-first", "timeout-first"] as const)(
		"cleans both resources for same-tick %s settlement (8 schedules)",
		async (order) => {
			const settledCounts: number[] = [];
			for (let run = 0; run < 8; run++) {
				const caller = new AbortController();
				if (order === "abort-first") setTimeout(() => caller.abort(), 1000);
				const fetch = retryingFetch("http");
				const result = collect(start(fetch, caller.signal));
				await vi.advanceTimersByTimeAsync(0);
				if (order === "timeout-first") setTimeout(() => caller.abort(), 1000);
				// Run both timer callbacks before promise continuations, fixing their settlement order.
				vi.advanceTimersByTime(1000);
				const { message, events } = await result;
				expect(message.stopReason).toBe("aborted");
				expect(message.errorMessage).toBe("Request was aborted");
				expect(events.filter((event) => event.type === "error")).toHaveLength(1);
				expect(fetch).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(0);
				settledCounts.push(getEventListeners(caller.signal, "abort").length);
			}
			expect(settledCounts).toEqual(Array(8).fill(0));
		},
	);
});
