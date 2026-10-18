import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type Provider,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const model: Model<Api> = {
	id: "image-context",
	name: "Image Context",
	provider: "context-test",
	api: "openai-completions",
	baseUrl: "https://declared.invalid/v1",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function done() {
	const stream = createAssistantMessageEventStream();
	const result: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		model: model.id,
		provider: model.provider,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	stream.end(result);
	return stream;
}
async function fixture() {
	const capture = vi.fn((_model: Model<Api>, _context: Context, _options?: StreamOptions) => done());
	const provider: Provider = {
		id: model.provider,
		name: "Context Test",
		getModels: () => [model],
		auth: {
			apiKey: {
				name: "Local test",
				resolve: async () => ({ auth: { baseUrl: "https://authenticated.invalid/v1" } }),
			},
		},
		stream: capture,
		streamSimple: capture,
	};
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(provider);
	return { runtime, capture };
}

describe("per-request context preparation after endpoint resolution", () => {
	it.each(["simple", "full"] as const)(
		"uses the actual endpoint in %s and strips the callback before provider dispatch",
		async (mode) => {
			const { runtime, capture } = await fixture();
			const original: Context = { messages: [] };
			const replacement: Context = { messages: [{ role: "user", content: "prepared", timestamp: 0 }] };
			const prepareContext = vi.fn((_context: Context, actual: Model<Api>) => {
				expect(actual.baseUrl).toBe("https://authenticated.invalid/v1");
				return replacement;
			});
			const result =
				mode === "simple"
					? await runtime.completeSimple(model, original, { prepareContext })
					: await runtime.complete(model, original, { prepareContext });
			expect(result.stopReason).toBe("stop");
			expect(prepareContext).toHaveBeenCalledOnce();
			expect(capture.mock.calls[0][1]).toBe(replacement);
			expect(capture.mock.calls[0][2]).not.toHaveProperty("prepareContext");
			expect(original.messages).toEqual([]);
		},
	);

	it("cancels a non-cooperative preparation without dispatching the request", async () => {
		const { runtime, capture } = await fixture();
		let started: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const controller = new AbortController();
		const result = runtime.completeSimple(
			model,
			{ messages: [] },
			{
				signal: controller.signal,
				prepareContext: () => {
					started();
					return new Promise<Context>(() => {});
				},
			},
		);
		await ready;
		controller.abort();
		expect((await result).stopReason).toBe("aborted");
		expect(capture).not.toHaveBeenCalled();
	});

	it("does not retain a session's preparation for concurrent or later requests", async () => {
		const { runtime, capture } = await fixture();
		const make = (text: string): Context => ({ messages: [{ role: "user", content: text, timestamp: 0 }] });
		await Promise.all([
			runtime.completeSimple(model, make("first"), { prepareContext: () => make("first-prepared") }),
			runtime.completeSimple(model, make("second"), { prepareContext: () => make("second-prepared") }),
		]);
		await runtime.completeSimple(model, make("unprepared"));
		expect(capture.mock.calls.map((call) => call[1].messages[0].content)).toEqual([
			"first-prepared",
			"second-prepared",
			"unprepared",
		]);
	});
});
