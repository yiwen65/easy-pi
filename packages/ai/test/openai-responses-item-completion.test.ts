import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
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

async function parseItem(item: unknown): Promise<AssistantMessageEvent[]> {
	async function* events(): AsyncIterable<ResponseStreamEvent> {
		yield { type: "response.output_item.done", output_index: 0, item } as ResponseStreamEvent;
		yield { type: "response.completed", response: { id: "r", status: "completed" } } as ResponseStreamEvent;
	}
	const output = { ...fauxAssistantMessage([]), api: model.api, provider: model.provider, model: model.id };
	const stream = new AssistantMessageEventStream();
	await processResponsesStream(events(), output, stream, model);
	stream.end(output);
	const result: AssistantMessageEvent[] = [];
	for await (const event of stream) result.push(event);
	return result;
}

describe("Responses upstream item completion", () => {
	it.each([
		{ argumentsJson: '{"text":"ok"}', status: "completed", complete: true },
		{ argumentsJson: '{"text":"ok"}', status: undefined, complete: true },
		{ argumentsJson: '{"text":"ok"}', status: "incomplete", complete: false },
		{ argumentsJson: '{"text":"ok"}', status: "in_progress", complete: false },
		{ argumentsJson: '{"text":"ok"', status: "completed", complete: false },
		{ argumentsJson: "null", status: "completed", complete: false },
		{ argumentsJson: "[]", status: "completed", complete: false },
	])(
		"validates status and strict tool arguments: $argumentsJson / $status",
		async ({ argumentsJson, status, complete }) => {
			const events = await parseItem({
				type: "function_call",
				id: "fc_a",
				call_id: "a",
				name: "record",
				arguments: argumentsJson,
				status,
			});
			expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({ itemComplete: complete });
		},
	);

	it.each(["completed", "incomplete", "in_progress"])("honors custom-tool status %s", async (status) => {
		const events = await parseItem({
			type: "custom_tool_call",
			id: "ctc_a",
			call_id: "a",
			name: "record",
			input: "complete input",
			status,
		});
		expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
			itemComplete: status === "completed",
		});
	});

	it.each(["completed", "incomplete", "in_progress"])("honors message status %s", async (status) => {
		const events = await parseItem({
			type: "message",
			id: "msg_a",
			role: "assistant",
			status,
			content: [{ type: "output_text", text: "complete text" }],
		});
		expect(events.find((event) => event.type === "text_end")).toMatchObject({ itemComplete: status === "completed" });
	});
});
