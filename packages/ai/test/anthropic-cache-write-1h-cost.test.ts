import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: { create: () => ({ asResponse: async () => response }) },
	} as unknown as Anthropic;
}

function eventsWithCacheCreation(
	cacheCreation: Record<string, number> | undefined,
	deltaUsage: Record<string, unknown> = {},
): Array<{ event: string; data: string }> {
	const startUsage: Record<string, unknown> = {
		input_tokens: 100,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 1_000_000,
	};
	if (cacheCreation) startUsage.cache_creation = cacheCreation;
	return [
		{
			event: "message_start",
			data: JSON.stringify({ type: "message_start", message: { id: "msg_test", usage: startUsage } }),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 100,
					output_tokens: 5,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 1_000_000,
					...deltaUsage,
				},
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

// claude-opus-4-8: input 5, cacheWrite (5m) 6.25 per Mtok. 1h write = 2x input = 10.
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

describe("Anthropic 1h cache write cost", () => {
	it("prices the 1h portion at 2x input and the rest at the 5m rate", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const response = createSseResponse(
			eventsWithCacheCreation({ ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000 }),
		);
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		expect(result.usage.cacheWrite).toBe(1_000_000);
		expect(result.usage.cacheWrite1h).toBe(400_000);
		// 600k * 6.25/Mtok + 400k * 10/Mtok = 3.75 + 4.0 = 7.75
		expect(result.usage.cost.cacheWrite).toBeCloseTo(7.75, 10);
	});

	it("prices mixed 1h and 5m writes reported only in a Vercel message_delta", async () => {
		const model = getModel("vercel-ai-gateway", "anthropic/claude-haiku-4.5");
		const response = createSseResponse(
			eventsWithCacheCreation(undefined, {
				input_tokens: 3,
				output_tokens: 4,
				cache_read_input_tokens: 17,
				cache_creation: { ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000 },
				output_tokens_details: { thinking_tokens: 2 },
			}),
		);
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
		expect(result.usage).toMatchObject({ input: 3, output: 4, cacheRead: 17, cacheWrite: 1_000_000, reasoning: 2 });
		expect(result.usage.totalTokens).toBe(1_000_024);
		expect(result.usage.cacheWrite1h).toBe(400_000);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(
			(600_000 * model.cost.cacheWrite + 400_000 * model.cost.input * 2) / 1_000_000,
			10,
		);
		expect(result.usage.cost.input).toBeCloseTo((3 * model.cost.input) / 1_000_000, 10);
		expect(result.usage.cost.output).toBeCloseTo((4 * model.cost.output) / 1_000_000, 10);
		expect(result.usage.cost.cacheRead).toBeCloseTo((17 * model.cost.cacheRead) / 1_000_000, 10);
	});

	it.each([
		{ label: "null", cacheCreation: null },
		{ label: "missing 1h count", cacheCreation: { ephemeral_5m_input_tokens: 600_000 } },
	])("preserves the message_start 1h count when the delta breakdown is $label", async ({ cacheCreation }) => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const response = createSseResponse(
			eventsWithCacheCreation(
				{ ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000 },
				{ cache_creation: cacheCreation },
			),
		);
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.cacheWrite).toBe(1_000_000);
		expect(result.usage.cacheWrite1h).toBe(400_000);
		expect(result.usage.totalTokens).toBe(1_000_105);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(7.75, 10);
	});

	it("replaces the message_start 1h count when the delta explicitly reports zero", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const response = createSseResponse(
			eventsWithCacheCreation(
				{ ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000 },
				{ cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 } },
			),
		);
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.cacheWrite).toBe(1_000_000);
		expect(result.usage.cacheWrite1h).toBe(0);
		expect(result.usage.totalTokens).toBe(1_000_105);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(6.25, 10);
	});

	it("falls back to the 5m rate when no breakdown is reported", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const response = createSseResponse(eventsWithCacheCreation(undefined));
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		expect(result.usage.cacheWrite).toBe(1_000_000);
		expect(result.usage.cacheWrite1h ?? 0).toBe(0);
		// 1M * 6.25/Mtok = 6.25
		expect(result.usage.cost.cacheWrite).toBeCloseTo(6.25, 10);
	});
});
