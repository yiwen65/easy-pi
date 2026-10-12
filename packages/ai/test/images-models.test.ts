import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels, createProvider, type Provider } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { builtinModels } from "../src/providers/all.ts";
import type {
	AnyModel,
	AssistantImages,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesOptions,
	Model,
	ProviderStreams,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function image(id = "same"): ImageModel<ImageApi> {
	return {
		type: "image",
		id,
		name: id,
		api: "test-images",
		provider: "p",
		baseUrl: "https://example.test/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}
function chat(id = "same"): Model<"test-chat"> {
	return {
		id,
		name: id,
		api: "test-chat",
		provider: "p",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}
function ok(model: ImageModel<ImageApi>): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
		stopReason: "stop",
		timestamp: 1,
	};
}
const auth = { apiKey: { name: "Keyless", resolve: async () => ({ auth: {} }) } };
const streams: ProviderStreams = {
	stream: () => new AssistantMessageEventStream(),
	streamSimple: () => new AssistantMessageEventStream(),
};
const context: ImagesContext = { input: [{ type: "text", text: "red circle" }] };

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("unified Models image operations", () => {
	it.each(["getAvailable", "getAllAvailable"] as const)(
		"does not mix provider instances during gated auth (%s)",
		async (method) => {
			const started = gate();
			const blocked = gate();
			const models = createModels();
			const checked = createProvider({
				id: "p",
				models: [chat("old")],
				api: streams,
				auth: {
					apiKey: {
						name: "Old keyless",
						resolve: async () => ({ auth: {} }),
						check: async () => {
							started.resolve();
							await blocked.promise;
							return { type: "api_key" };
						},
					},
				},
			});
			models.setProvider(checked);
			const pending = models[method]("p");
			await started.promise;
			const replacement = createProvider({
				id: "p",
				models: [chat("replacement")],
				api: streams,
				auth: { apiKey: { name: "Unconfigured replacement", resolve: async () => undefined } },
			});
			models.setProvider(replacement);
			blocked.resolve();
			expect(await pending).toEqual([]);
			expect(await models[method]("p")).toEqual([]);
		},
	);

	it("applies a filterAll-only policy to the ordinary chat projection", async () => {
		const models = createModels();
		const filterAllModels = vi.fn((list: readonly AnyModel[]) => list.filter((model) => model.type === "image"));
		models.setProvider(createProvider({ id: "p", auth, models: [chat(), image()], api: streams, filterAllModels }));
		expect(await models.getAvailable()).toEqual([]);
		expect(filterAllModels).toHaveBeenCalledWith([chat(), image()], undefined);
		expect(await models.getAllAvailable()).toEqual([image()]);
	});

	it("uses the canonical all-filter rather than a conflicting legacy chat filter", async () => {
		const models = createModels();
		const filterModels = vi.fn((_list: readonly Model<string>[]) => []);
		const filterAllModels = vi.fn((list: readonly AnyModel[]) => list.filter((model) => model.id === "allowed"));
		models.setProvider(
			createProvider({
				id: "p",
				auth,
				models: [chat("allowed"), chat("denied"), image("allowed")],
				api: streams,
				filterModels,
				filterAllModels,
			}),
		);
		expect(await models.getAvailable()).toEqual([chat("allowed")]);
		expect(await models.getAllAvailable()).toEqual([chat("allowed"), image("allowed")]);
		expect(filterModels).not.toHaveBeenCalled();
	});

	it.each(["collection", "store", "fetch"] as const)("rejects explicit null operation records (%s)", async (stage) => {
		const invalid = chat("null");
		Object.defineProperty(invalid, "type", { value: null, enumerable: true });
		if (stage === "collection") {
			const models = createModels();
			models.setProvider({
				id: "p",
				name: "p",
				auth,
				getModels: () => [chat(), invalid],
				getAllModels: () => [chat(), invalid, image()],
				...streams,
			});
			expect(models.getModels()).toEqual([chat()]);
			expect(models.getAllModels()).toEqual([chat(), image()]);
			expect(await models.getAvailable()).toEqual([chat()]);
			expect(await models.getAllAvailable()).toEqual([chat(), image()]);
			return;
		}
		const store = new InMemoryModelsStore();
		if (stage === "store") await store.write("p", { models: [chat(), invalid, image()] });
		const models = createModels({ modelsStore: store });
		models.setProvider(
			createProvider({
				id: "p",
				auth,
				models: [],
				api: streams,
				fetchModels: async () => [chat("fetched"), invalid, image("fetched")],
			}),
		);
		if (stage === "store") {
			expect((await models.refresh({ allowNetwork: false })).errors.size).toBe(0);
			expect(models.getAllModels()).toEqual([chat(), image()]);
		} else {
			expect((await models.refresh()).errors.size).toBe(0);
			expect(models.getAllModels()).toEqual([chat("fetched"), image("fetched")]);
			expect((await store.read("p"))?.models).toEqual([chat("fetched"), image("fetched")]);
		}
	});

	it("keeps same-ID chat and image models separate through reads and availability", async () => {
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "p",
				auth,
				models: [chat(), image()],
				api: streams,
				images: { "test-images": { generateImages: async (model) => ok(model) } },
			}),
		);
		expect(models.getModels()).toEqual([chat()]);
		expect(models.getModelsOfType("chat")).toEqual([chat()]);
		expect(models.getAllModels()).toEqual([chat(), image()]);
		expect(models.getModel("p", "same")).toEqual(chat());
		expect(models.getModelOfType("image", "p", "same")).toEqual(image());
		expect(await models.getAvailable()).toEqual([chat()]);
		expect(await models.getAvailableOfType("image")).toEqual([image()]);
		expect(await models.getAllAvailable()).toEqual([chat(), image()]);
		expect(await models.generateImages(image(), context)).toMatchObject({ stopReason: "stop" });
	});

	it("accepts image-only providers but rejects empty or non-implementation maps", () => {
		const provider = createProvider({
			id: "p",
			auth,
			models: [image()],
			images: { "test-images": { generateImages: async (model) => ok(model) } },
		});
		expect(provider.getModels()).toEqual([]);
		expect(provider.getAllModels?.()).toEqual([image()]);
		for (const input of [{}, { api: {} }, { images: {} }, { api: {}, images: { missing: undefined } }])
			expect(() => createProvider({ id: "p", auth, models: [], ...input })).toThrow("at least one");
	});

	it("falls back to handwritten chat lists and keeps chat reads independent of throwing all-lists", async () => {
		const provider: Provider = { id: "p", name: "p", auth, getModels: () => [chat()], ...streams };
		const models = createModels();
		models.setProvider(provider);
		expect(models.getAllModels()).toEqual([chat()]);
		provider.getAllModels = () => {
			throw new Error("all unavailable");
		};
		expect(models.getAllModels()).toEqual([]);
		expect(models.getModels()).toEqual([chat()]);
		expect(await models.getAvailable()).toEqual([chat()]);
	});

	it("applies the old chat filter only to chat, and the new all-filter to mixed operations", async () => {
		const filterModels = vi.fn((_models: readonly Model<string>[]) => []);
		const models = createModels();
		const provider = createProvider({ id: "p", auth, models: [chat(), image()], api: streams, filterModels });
		models.setProvider(provider);
		expect(await models.getAvailable()).toEqual([]);
		expect(await models.getAllAvailable()).toEqual([image()]);
		expect(filterModels.mock.calls[0][0]).toEqual([chat()]);
		provider.filterAllModels = () => [];
		expect(await models.getAllAvailable()).toEqual([]);
	});

	it("skips external unknown operation types without coercing them into legacy chat", async () => {
		const unknown = { ...chat("unknown"), type: "classifier" } as unknown as AnyModel;
		const models = createModels();
		const provider: Provider = {
			id: "p",
			name: "p",
			auth,
			getModels: () => [chat(), unknown as Model<string>, image() as unknown as Model<string>],
			getAllModels: () => [chat(), image(), unknown],
			...streams,
		};
		models.setProvider(provider);
		expect(models.getModels()).toEqual([chat()]);
		expect(models.getAllModels()).toEqual([chat(), image()]);
		expect(await models.getAllAvailable()).toEqual([chat(), image()]);
	});

	it("rejects duplicate operations across APIs while accepting the same ID across types", () => {
		expect(() =>
			createProvider<string>({ id: "p", auth, models: [chat(), { ...chat(), api: "other-api" }], api: streams }),
		).toThrow("Duplicate model operation");
		expect(() => createProvider({ id: "p", auth, models: [chat(), image()], api: streams })).not.toThrow();
	});

	it("rejects forced images in every chat/deferred path before auth or adapter dispatch", async () => {
		const resolve = vi.fn(async () => ({ auth: {} }));
		const stream = vi.fn(() => new AssistantMessageEventStream());
		const cancelDeferred = vi.fn(async () => {});
		const provider = createProvider({
			id: "p",
			auth: { apiKey: { name: "Test", resolve } },
			models: [chat(), image()],
			api: { stream, streamSimple: stream, fetchDeferred: stream, cancelDeferred },
		});
		const models = createModels();
		models.setProvider(provider);
		const forced = image() as unknown as Model<"test-chat">;
		const handle = { provider: "p", modelId: "same", api: "test-images", id: "response" };
		for (const result of [
			models.stream(forced, { messages: [] }),
			models.streamSimple(forced, { messages: [] }),
			provider.stream(forced, { messages: [] }),
			provider.streamSimple(forced, { messages: [] }),
			provider.fetchDeferred!(forced, handle),
		]) {
			const events = [];
			for await (const event of result) events.push(event.type);
			expect(events).toEqual(["error"]);
			expect(await result.result()).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("not a chat model"),
			});
		}
		expect(await models.fetchDeferred(forced, handle)).toMatchObject({ stopReason: "error" });
		await expect(models.cancelDeferred(forced, handle)).rejects.toThrow("not a chat model");
		await expect(provider.cancelDeferred!(forced, handle)).rejects.toThrow("not a chat model");
		expect(resolve).not.toHaveBeenCalled();
		expect(stream).not.toHaveBeenCalled();
		expect(cancelDeferred).not.toHaveBeenCalled();
	});

	it("resolves headers, endpoint, env and transform exactly once before image dispatch", async () => {
		const resolve = vi.fn(async () => ({
			auth: {
				apiKey: "resolved",
				baseUrl: "https://resolved.test",
				headers: { "X-Shared": "auth", "x-auth": "auth" },
			},
			env: { SHARED: "auth", AUTH: "yes" },
		}));
		const generateImages = vi.fn(
			async (model: ImageModel<ImageApi>, _context: ImagesContext, options?: ImagesOptions) => {
				expect(model.baseUrl).toBe("https://resolved.test");
				expect(model.headers).toBeUndefined();
				expect(options?.apiKey).toBe("request");
				expect(options?.env).toEqual({ AUTH: "yes", SHARED: "request", REQUEST: "yes" });
				expect(options?.headers).toEqual({ "x-auth": "auth", "X-SHARED": "request", "x-transformed": "yes" });
				expect(options).not.toHaveProperty("transformHeaders");
				return ok(model);
			},
		);
		const model = { ...image(), headers: { "x-shared": "model", "x-remove": "model" } };
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "p",
				auth: { apiKey: { name: "Test", resolve } },
				models: [model],
				images: { "test-images": { generateImages } },
			}),
		);
		const transformHeaders = vi.fn(async (headers) => {
			expect(headers).toEqual({ "x-auth": "auth", "x-remove": "model", "X-SHARED": "request" });
			const { "x-remove": _removed, ...kept } = headers;
			return { ...kept, "x-transformed": "yes" };
		});
		expect(
			await models.generateImages(model, context, {
				apiKey: "request",
				headers: { "X-SHARED": "request" },
				env: { SHARED: "request", REQUEST: "yes" },
				transformHeaders,
			}),
		).toMatchObject({ stopReason: "stop" });
		expect(resolve).toHaveBeenCalledOnce();
		expect(transformHeaders).toHaveBeenCalledOnce();
		expect(generateImages).toHaveBeenCalledOnce();
		expect(model.headers["x-remove"]).toBe("model");
	});

	it("returns errors for unknown providers, wrong operation, missing adapter, unconfigured auth and throwing adapters", async () => {
		const models = createModels();
		expect(await models.generateImages(image(), context)).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("Unknown provider"),
		});
		models.setProvider(createProvider({ id: "p", auth, models: [image()], api: streams }));
		expect(await models.generateImages(image(), context)).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("does not support image generation"),
		});
		expect(await models.generateImages(chat() as unknown as ImageModel<string>, context)).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("not an image model"),
		});
		const generateImages = vi.fn(async () => {
			throw new Error("adapter failed");
		});
		models.setProvider(
			createProvider({
				id: "p",
				auth: { apiKey: { name: "Missing", resolve: async () => undefined } },
				models: [image()],
				images: { "test-images": { generateImages } },
			}),
		);
		expect(await models.generateImages(image(), context)).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("not configured"),
		});
		expect(generateImages).not.toHaveBeenCalled();
		models.setProvider(
			createProvider({ id: "p", auth, models: [image()], images: { "test-images": { generateImages } } }),
		);
		expect(await models.generateImages(image(), context)).toMatchObject({
			stopReason: "error",
			errorMessage: "adapter failed",
		});
		expect(await models.generateImages({ ...image(), api: "missing" }, context)).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("no image generation implementation"),
		});
	});

	it("returns promptly from cancellation even when an image adapter ignores the signal", async () => {
		const started = gate();
		const blocked = gate();
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "p",
				auth,
				models: [image()],
				images: {
					"test-images": {
						generateImages: async (model) => {
							started.resolve();
							await blocked.promise;
							return ok(model);
						},
					},
				},
			}),
		);
		const controller = new AbortController();
		const pending = models.generateImages(image(), context, { signal: controller.signal });
		await started.promise;
		controller.abort();
		expect(await pending).toMatchObject({ stopReason: "aborted" });
		blocked.resolve();
	});

	it("persists rotated OAuth credentials after cancelled image auth waits", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p", async () => ({ type: "oauth", access: "old", refresh: "old", expires: 0 }));
		const started = gate();
		const blocked = gate();
		let refreshSignal: AbortSignal | undefined;
		const models = createModels({ credentials });
		models.setProvider(
			createProvider({
				id: "p",
				models: [image()],
				images: { "test-images": { generateImages: async (model) => ok(model) } },
				auth: {
					oauth: {
						name: "Test OAuth",
						login: async () => {
							throw new Error("unused");
						},
						refresh: async (credential, signal) => {
							refreshSignal = signal;
							started.resolve();
							await blocked.promise;
							return { ...credential, access: "new", refresh: "rotated", expires: Date.now() + 60 * 60_000 };
						},
						toAuth: async (credential) => ({ apiKey: credential.access }),
					},
				},
			}),
		);
		const controller = new AbortController();
		const pending = models.generateImages(image(), context, { signal: controller.signal });
		await started.promise;
		controller.abort();
		expect(await pending).toMatchObject({ stopReason: "aborted" });
		expect(refreshSignal?.aborted).toBe(false);
		blocked.resolve();
		await vi.waitFor(async () => expect(await credentials.read("p")).toMatchObject({ refresh: "rotated" }));
	});

	it("restores/fetches mixed stores with operation-specific overlay and rejects stale publication", async () => {
		const store = new InMemoryModelsStore();
		const unknown = { ...chat("unknown"), type: "future" } as unknown as AnyModel;
		await store.write("p", { models: [image(), chat(), unknown], etag: '"saved"', lastModified: 12, checkedAt: 34 });
		const firstStarted = gate();
		const firstBlocked = gate();
		let fetches = 0;
		const provider = createProvider({
			id: "p",
			auth,
			models: [{ ...chat(), name: "baseline" }],
			api: streams,
			fetchModels: async ({ stored }) => {
				expect(stored?.etag).toBe('"saved"');
				fetches++;
				const number = fetches;
				if (number === 1) {
					firstStarted.resolve();
					await firstBlocked.promise;
				}
				return [{ ...image(), name: `image-${number}` }, { ...chat(), name: `chat-${number}` }, unknown];
			},
		});
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		expect((await models.refresh({ allowNetwork: false })).errors.size).toBe(0);
		expect(models.getAllModels()).toEqual([chat(), image()]);
		const first = models.refresh();
		await firstStarted.promise;
		expect((await models.refresh({ force: true })).errors.size).toBe(0);
		await first;
		firstBlocked.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(models.getModel("p", "same")?.name).toBe("chat-2");
		expect(models.getModelOfType("image", "p", "same")?.name).toBe("image-2");
		expect((await store.read("p"))?.models.map((model) => model.name)).toEqual(["image-2", "chat-2"]);
	});

	it("builtinModels owns OpenRouter chat and images with shared auth and unchanged default membership", async () => {
		const models = builtinModels({
			authContext: {
				env: async (name) => (name === "OPENROUTER_API_KEY" ? "fixture-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(models.getProviders()).toHaveLength(39);
		expect(models.getProvider("radius")).toBeUndefined();
		expect(models.getModelsOfType("image", "openrouter")).toHaveLength(61);
		expect(models.getModels("openrouter").every((model) => model.api === "openai-completions")).toBe(true);
		expect((await models.getAuth(models.getModelsOfType("image")[0]))?.auth.apiKey).toBe("fixture-key");
	});
});
