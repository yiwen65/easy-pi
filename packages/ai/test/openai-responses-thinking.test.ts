import type { ResponseReasoningItem, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"openai-responses"> = {
	id: "test",
	name: "Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "http://127.0.0.1:1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};
const item: ResponseReasoningItem = { type: "reasoning", id: "rs_test", summary: [] };

async function parse(events: unknown[], terminalItem = item) {
	async function* source(): AsyncIterable<ResponseStreamEvent> {
		yield { type: "response.output_item.added", output_index: 0, item } as ResponseStreamEvent;
		for (const event of events) yield event as ResponseStreamEvent;
		yield {
			type: "response.completed",
			response: { status: "completed", output: [terminalItem] },
		} as ResponseStreamEvent;
	}
	const output = { ...fauxAssistantMessage([]), api: model.api, provider: model.provider, model: model.id };
	const stream = new AssistantMessageEventStream();
	await processResponsesStream(source(), output, stream, model);
	stream.end(output);
	const updates: AssistantMessageEvent[] = [];
	for await (const event of stream) updates.push(event);
	return { output, updates };
}

describe("Responses thinking completion text", () => {
	it.each([
		"response.reasoning_summary_text.done",
		"response.reasoning_summary_part.done",
		"response.reasoning_text.done",
	])("retains text received only in %s", async (type) => {
		const { output, updates } = await parse([
			{
				type,
				output_index: 0,
				summary_index: 0,
				content_index: 0,
				text: "Visible thinking",
				part: { type: "summary_text", text: "Visible thinking" },
			},
		]);
		expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "Visible thinking" });
		expect(updates.some((event) => event.type === "thinking_delta" || event.type === "thinking_end")).toBe(true);
	});

	it("reconciles indexed parts without duplicating deltas and done snapshots", async () => {
		const { output } = await parse([
			{ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "Fir" },
			{ type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 0, text: "First" },
			{ type: "response.reasoning_summary_part.done", output_index: 0, summary_index: 0, part: { text: "First" } },
			{ type: "response.reasoning_summary_part.done", output_index: 0, summary_index: 1, part: { text: "Second" } },
		]);
		expect(output.content[0]).toMatchObject({ thinking: "First\n\nSecond" });
	});

	it("uses done text to correct a streamed prefix", async () => {
		const { output, updates } = await parse([
			{ type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "Incorrect" },
			{ type: "response.reasoning_text.done", output_index: 0, content_index: 0, text: "Correct" },
		]);
		expect(output.content[0]).toMatchObject({ thinking: "Correct" });
		expect(updates.find((event) => event.type === "thinking_end")).toMatchObject({ content: "Correct" });
		expect(updates.some((event) => event.type === "thinking_end" && event.itemComplete === true)).toBe(false);
	});

	it("orders parts by index and prefers a visible summary over raw reasoning", async () => {
		const { output } = await parse([
			{ type: "response.reasoning_text.done", output_index: 0, content_index: 0, text: "Raw" },
			{ type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 1, text: "Second" },
			{ type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 0, text: "First" },
		]);
		expect(output.content[0]).toMatchObject({ thinking: "First\n\nSecond" });
	});

	it("backfills raw reasoning from the terminal response", async () => {
		const { output } = await parse([], { ...item, content: [{ type: "reasoning_text", text: "Terminal raw" }] });
		expect(output.content[0]).toMatchObject({ thinking: "Terminal raw" });
	});

	it("matches terminal reasoning by item id when output items are interleaved", async () => {
		const other: ResponseReasoningItem = { ...item, id: "rs_other" };
		const { output } = await parse(
			[
				{ type: "response.output_item.added", output_index: 1, item: other },
				{ type: "response.reasoning_summary_text.done", output_index: 1, summary_index: 0, text: "Other thinking" },
				{ type: "response.output_item.done", output_index: 1, item: other },
			],
			{ ...item, summary: [{ type: "summary_text", text: "Original thinking" }] },
		);
		expect(output.content).toMatchObject([{ thinking: "Original thinking" }, { thinking: "Other thinking" }]);
	});

	it.each([false, true])("backfills terminal text after item completion=%s", async (completed) => {
		const terminal: ResponseReasoningItem = {
			...item,
			summary: [{ type: "summary_text", text: "Terminal thinking" }],
			encrypted_content: "cipher",
		};
		const { output, updates } = await parse(
			completed ? [{ type: "response.output_item.done", output_index: 0, item }] : [],
			terminal,
		);
		expect(output.content[0]).toMatchObject({ thinking: "Terminal thinking" });
		expect(updates.some((event) => event.type === "thinking_delta" && event.delta === "Terminal thinking")).toBe(
			true,
		);
	});

	it("does not invent text for encrypted-only reasoning", async () => {
		const { output } = await parse([], { ...item, encrypted_content: "cipher" });
		expect(output.content[0]).toMatchObject({ thinking: "" });
	});
});
