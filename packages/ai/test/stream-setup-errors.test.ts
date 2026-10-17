import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as anthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as google } from "../src/api/google-generative-ai.ts";
import { streamSimple as mistral } from "../src/api/mistral-conversations.ts";
import { streamSimple as codex } from "../src/api/openai-codex-responses.ts";
import { streamSimple as completions } from "../src/api/openai-completions.ts";
import { streamSimple as responses } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "../src/types.ts";

function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test-model",
		name: "Test",
		api,
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		contextWindow: 32000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const adapters = [
	{
		name: "Anthropic",
		call: (context: Context, options: SimpleStreamOptions) =>
			anthropic(model("anthropic-messages"), context, options),
	},
	{
		name: "Codex",
		call: (context: Context, options: SimpleStreamOptions) =>
			codex(model("openai-codex-responses"), context, options),
	},
	{
		name: "Mistral",
		call: (context: Context, options: SimpleStreamOptions) =>
			mistral(model("mistral-conversations"), context, options),
	},
	{
		name: "OpenAI Responses",
		call: (context: Context, options: SimpleStreamOptions) => responses(model("openai-responses"), context, options),
	},
	{
		name: "OpenAI Completions",
		call: (context: Context, options: SimpleStreamOptions) =>
			completions(model("openai-completions"), context, options),
	},
	{
		name: "Google",
		call: (context: Context, options: SimpleStreamOptions) => google(model("google-generative-ai"), context, options),
	},
];

afterEach(() => vi.unstubAllGlobals());

describe.each(adapters)("$name direct streamSimple setup failures", ({ call }) => {
	it.each(["missing auth", "invalid context", "pre-aborted"])(
		"encodes %s in one terminal event without network",
		async (scenario) => {
			const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Unexpected network"));
			vi.stubGlobal("fetch", fetch);
			const controller = new AbortController();
			if (scenario === "pre-aborted") controller.abort();
			const context: Context =
				scenario === "invalid context" ? { messages: null as unknown as Context["messages"] } : { messages: [] };
			const options: SimpleStreamOptions = {
				apiKey: scenario === "invalid context" ? "synthetic-key" : undefined,
				signal: controller.signal,
			};
			// A synchronous throw fails here: StreamFunction promises an event stream even for setup failures.
			const stream = call(context, options);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				type: "error",
				reason: scenario === "pre-aborted" ? "aborted" : "error",
				error: result,
			});
			expect(result.errorMessage).toBeTruthy();
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
