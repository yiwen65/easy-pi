import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AnyModel,
	type Api,
	type AssistantImages,
	createProvider,
	type ImageModel,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type Models,
	type Provider,
	type ProviderHeaders,
	type ProviderImages,
} from "@earendil-works/pi-ai";
import { getImagesApiProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";

const providerId = "mixed-test";
const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
function chat(id = "same"): Model<"openai-completions"> {
	return {
		id,
		name: "Chat",
		provider: providerId,
		api: "openai-completions",
		baseUrl: "https://chat.test/v1",
		input: ["text"],
		cost,
		reasoning: false,
		contextWindow: 1000,
		maxTokens: 100,
	};
}
function image(id = "same"): ImageModel<"test-images"> {
	return {
		id,
		name: "Image",
		type: "image",
		provider: providerId,
		api: "test-images",
		baseUrl: "https://image.test/v1",
		input: ["text"],
		output: ["image"],
		cost,
		headers: { "x-static": "static" },
	};
}
function success(model: ImageModel<string>): AssistantImages {
	return { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: "stop", timestamp: 0 };
}
function native(overrides: Partial<Provider> = {}): Provider {
	return {
		id: providerId,
		name: "Mixed Test",
		auth: { apiKey: { name: "Keyless", resolve: async () => ({ auth: {} }) } },
		getModels: () => [chat()],
		getAllModels: () => [chat(), image()],
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
		generateImages: async (model) => success(model),
		...overrides,
	};
}
async function runtime(provider = native()): Promise<ModelRuntime> {
	const result = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	result.registerNativeProvider(provider);
	await result.refresh({ allowNetwork: false });
	return result;
}
const directories: string[] = [];
async function configured(config: unknown, provider = native()): Promise<ModelRuntime> {
	const directory = await mkdtemp(join(tmpdir(), "pi-mixed-runtime-"));
	directories.push(directory);
	const modelsPath = join(directory, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers: { [providerId]: config } }));
	const result = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath,
		allowModelNetwork: false,
	});
	result.registerNativeProvider(provider);
	await result.refresh({ allowNetwork: false });
	return result;
}
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ModelRuntime mixed-operation consumers", () => {
	it("implements Models while keeping default queries, registry and snapshots chat-only", async () => {
		const result = await runtime();
		const models: Models = result;
		const registry = new ModelRegistry(result);
		expect(models.getModel(providerId, "same")?.name).toBe("Chat");
		expect(models.getModelOfType("image", providerId, "same")?.name).toBe("Image");
		expect(models.getModelsOfType("image", providerId)).toHaveLength(1);
		expect(models.getAllModels(providerId)).toHaveLength(2);
		expect(await models.getAvailable(providerId)).toEqual([chat()]);
		expect(await models.getAvailableOfType("image", providerId)).toEqual([image()]);
		expect(await models.getAvailableOfType("chat", providerId)).toEqual([chat()]);
		expect(await models.getAllAvailable(providerId)).toHaveLength(2);
		expect(registry.getAll().filter((model) => model.provider === providerId)).toEqual([chat()]);
		expect(registry.getAvailable().filter((model) => model.provider === providerId)).toEqual([chat()]);
		expect(result.getAvailableSnapshot().filter((model) => model.provider === providerId)).toEqual([chat()]);
		expect(result.hasConfiguredAuth(providerId)).toBe(true);
	});

	it("assembles image auth, env, endpoint and headers once, without resurrecting deleted model defaults", async () => {
		const generateImages = vi.fn<NonNullable<Provider["generateImages"]>>(async (model, _context, options) => {
			expect(model.baseUrl).toBe("https://resolved.test/v1");
			expect(model.headers).toBeUndefined();
			expect(options).not.toHaveProperty("transformHeaders");
			expect(options).toMatchObject({
				apiKey: "explicit-key",
				env: { NATIVE: "native", REQUEST: "request" },
				headers: { authorization: "explicit", "x-auth": "auth", "x-request": "request", "x-transformed": "yes" },
			});
			expect(options?.headers).not.toHaveProperty("x-static");
			return success(model);
		});
		const result = await runtime(
			native({
				auth: {
					apiKey: {
						name: "Synthetic",
						resolve: async () => ({
							auth: {
								apiKey: "native-key",
								headers: { Authorization: "native", "x-auth": "auth" },
								baseUrl: "https://resolved.test/v1",
							},
							env: { NATIVE: "native" },
						}),
					},
				},
				generateImages,
			}),
		);
		const transform = vi.fn((headers) => {
			expect(headers["x-static"]).toBe("static");
			delete headers["x-static"];
			return { ...headers, "x-transformed": "yes" };
		});
		expect(
			(
				await result.generateImages(
					image(),
					{ input: [] },
					{
						apiKey: "explicit-key",
						env: { REQUEST: "request" },
						headers: { authorization: "explicit", "x-request": "request" },
						transformHeaders: transform,
					},
				)
			).stopReason,
		).toBe("stop");
		expect(transform).toHaveBeenCalledTimes(1);
		expect(generateImages).toHaveBeenCalledTimes(1);
	});

	it("applies provider configuration to images but isolates same-ID chat upserts/overrides/headers", async () => {
		const result = await configured(
			{
				baseUrl: "https://proxy.test/v1",
				headers: { "x-provider": "$REQUEST_HEADER" },
				apiKey: "$REQUEST_KEY",
				models: [{ id: "same", name: "Configured chat", headers: { "x-chat-definition": "chat" } }],
				modelOverrides: {
					same: { name: "Chat override", headers: { "x-chat-override": "chat" }, cost: { input: 99 } },
				},
			},
			native({
				auth: {
					apiKey: {
						name: "Synthetic key",
						resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key } }),
					},
				},
			}),
		);
		const imageModel = result.getModelOfType("image", providerId, "same")!;
		expect(imageModel).toMatchObject({ name: "Image", baseUrl: "https://proxy.test/v1", cost });
		expect(result.getModel(providerId, "same")?.name).toBe("Chat override");
		const auth = await result.getAuth(imageModel, {
			env: { REQUEST_HEADER: "image-header", REQUEST_KEY: "image-key" },
		});
		expect(auth?.auth).toEqual({
			apiKey: "image-key",
			headers: { "x-provider": "image-header", "x-static": "static" },
		});
	});

	it("retains image adapters through provider-wide overlays and honors native mixed availability policy", async () => {
		const generateImages = vi.fn<NonNullable<Provider["generateImages"]>>(async (model) => success(model));
		const result = await configured(
			{ baseUrl: "https://proxy.test/v1" },
			native({ generateImages, filterAllModels: (models) => models.filter((model) => model.type !== "image") }),
		);
		expect(await result.getAllAvailable(providerId)).toEqual([result.getModel(providerId, "same")]);
		expect(
			(await result.generateImages(result.getModelOfType("image", providerId, "same")!, { input: [] })).stopReason,
		).toBe("stop");
		expect(generateImages).toHaveBeenCalledTimes(1);
	});

	it("uses mixed availability policy for typed and legacy chat reads", async () => {
		const result = await runtime(
			native({ filterAllModels: (models) => models.filter((model) => model.type === "image") }),
		);
		expect(await result.getAvailableOfType("chat", providerId)).toEqual([]);
		expect(await result.getAvailableOfType("image", providerId)).toEqual([image()]);
		expect(await result.getAvailable(providerId)).toEqual([]);
		expect(result.getAvailableSnapshot().filter((model) => model.provider === providerId)).toEqual([]);
	});

	it("composed image providers encode adapter errors and pre-dispatch cancellation", async () => {
		const adapter = vi.fn<ProviderImages["generateImages"]>(async () => {
			throw new Error("synthetic adapter failure");
		});
		const provider = composeModelProvider(providerId, native(), await ModelConfig.load(undefined), {
			images: { "test-images": { generateImages: adapter } },
		});
		expect(await provider.generateImages!(image(), { input: [] })).toMatchObject({
			stopReason: "error",
			errorMessage: "synthetic adapter failure",
		});
		adapter.mockClear();
		const controller = new AbortController();
		controller.abort(new Error("synthetic cancellation"));
		expect(await provider.generateImages!(image(), { input: [] }, { signal: controller.signal })).toMatchObject({
			stopReason: "aborted",
		});
		expect(adapter).not.toHaveBeenCalled();
	});

	it("applies legacy chat filters without filtering out authenticated images", async () => {
		const result = await configured({ headers: { "x-overlay": "yes" } }, native({ filterModels: () => [] }));
		expect(await result.getAvailable(providerId)).toEqual([]);
		expect((await result.getAllAvailable(providerId)).map((model) => model.type)).toEqual(["image"]);
	});

	it("registers mixed extension config, matches defaults/headers by operation, and preserves re-registration merge", async () => {
		const result = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const adapter: ProviderImages = { generateImages: async (model) => success(model) };
		const config: ProviderConfigInput = {
			api: "openai-completions",
			baseUrl: "https://extension.test/v1",
			apiKey: "synthetic",
			images: { "test-images": adapter },
			models: [
				{ ...chat(), headers: { "x-operation": "chat" } },
				{ ...image(), headers: { "x-operation": "image" } },
			],
		};
		result.registerProvider(providerId, config);
		result.registerProvider(providerId, { headers: { "x-provider": "overlay" } });
		await result.refresh({ allowNetwork: false });
		expect(result.getAllModels(providerId)).toHaveLength(2);
		expect((await result.getAuth(result.getModelOfType("image", providerId, "same")!))?.auth.headers).toEqual({
			"x-provider": "overlay",
			"x-operation": "image",
		});
		expect((await result.getAuth(result.getModel(providerId, "same")!))?.auth.headers).toEqual({
			"x-provider": "overlay",
			"x-operation": "chat",
		});
		expect(
			(await result.generateImages(result.getModelOfType("image", providerId, "same")!, { input: [] })).stopReason,
		).toBe("stop");
		result.registerProvider(providerId, { models: [] });
		expect(result.getAllModels(providerId)).toEqual([]);
	});

	it("uses published dynamic image definitions for changed, new and removed headers without mutating sibling registrations", async () => {
		const result = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const initialModels: NonNullable<ProviderConfigInput["models"]> = [
			{ ...chat(), headers: { "x-operation": "chat" } },
			{ ...image(), headers: { "x-operation": "old-image", "x-removed": "old" } },
		];
		let activeModels: NonNullable<ProviderConfigInput["models"]> = initialModels;
		const captured: ProviderHeaders[] = [];
		result.registerProvider(providerId, {
			apiKey: "synthetic",
			headers: { "x-provider": "stable" },
			models: initialModels,
			images: {
				"test-images": {
					generateImages: async (model, _context, options) => {
						expect(model.headers).toBeUndefined();
						captured.push(options?.headers ?? {});
						return success(model);
					},
				},
			},
			refreshModels: async () => activeModels,
		});
		await result.refresh({ allowNetwork: false });
		const original = result.getModelOfType("image", providerId, "same")!;
		const sibling = await result.createSessionView();
		const siblingModel = sibling.getModelOfType("image", providerId, "same")!;
		const initialAuth = await sibling.getAuth(siblingModel);
		activeModels = [
			{ ...chat(), headers: { "x-operation": "chat" } },
			{
				...image(),
				headers: {
					"x-operation": "new-image",
					"x-env": "$DYNAMIC_IMAGE_HEADER",
					"x-command": "!printf dynamic-command",
				},
			},
			{ ...image("new"), headers: { "x-new": "published" } },
		];
		await result.refresh({ providers: [providerId], allowNetwork: false });
		expect(result.getError()).toBeUndefined();
		expect(result.getModelOfType("image", providerId, "new")).toBeDefined();
		const env = { DYNAMIC_IMAGE_HEADER: "request-env" };
		expect({
			changed: (await result.getAuth(original, { env }))?.auth.headers,
			added: (await result.getAuth(result.getModelOfType("image", providerId, "new")!))?.auth.headers,
		}).toEqual({
			changed: {
				"x-provider": "stable",
				"x-operation": "new-image",
				"x-env": "request-env",
				"x-command": "dynamic-command",
			},
			added: { "x-provider": "stable", "x-new": "published" },
		});
		const transform = vi.fn((headers: ProviderHeaders) => {
			delete headers["x-operation"];
			delete headers["x-command"];
			return { ...headers, "x-transform": "once" };
		});
		expect(
			(await result.generateImages(original, { input: [] }, { env, transformHeaders: transform })).stopReason,
		).toBe("stop");
		expect(transform).toHaveBeenCalledTimes(1);
		expect(captured).toEqual([{ "x-provider": "stable", "x-env": "request-env", "x-transform": "once" }]);
		expect(await sibling.getAuth(siblingModel)).toEqual(initialAuth);
		expect(sibling.getModelOfType("image", providerId, "new")).toBeUndefined();
		expect(result.getRegisteredProviderConfig(providerId)?.models).toBe(initialModels);
		expect(initialModels[1].headers).toEqual({ "x-operation": "old-image", "x-removed": "old" });
		activeModels = [
			{ ...chat(), headers: { "x-operation": "chat" } },
			{ ...image(), headers: undefined },
		];
		await result.refresh({ providers: [providerId], allowNetwork: false });
		expect((await result.getAuth(original))?.auth.headers).toEqual({ "x-provider": "stable" });
		expect((await result.generateImages(original, { input: [] })).stopReason).toBe("stop");
		expect(captured[1]).toEqual({ "x-provider": "stable" });
	});

	it.each(["initial", "later"] as const)(
		"keeps overlaid chat independent of %s optional all-list failure",
		async (phase) => {
			let failing = phase === "initial";
			const provider = native({
				getAllModels: () => {
					if (failing) throw new Error("synthetic all-list failure");
					return [chat(), image()];
				},
			});
			const result = await configured(
				{
					baseUrl: "https://proxy.test/v1",
					headers: { "x-overlay": "present" },
					modelOverrides: { same: { name: "Overlaid Chat" } },
				},
				provider,
			);
			failing = true;
			const registry = new ModelRegistry(result);
			const verify = async () => {
				expect(result.getError()).toBeUndefined();
				const models = result.getModels(providerId);
				expect(models).toHaveLength(1);
				expect(models[0]).toMatchObject({ name: "Overlaid Chat", baseUrl: "https://proxy.test/v1" });
				expect(result.getModels().filter((model) => model.provider === providerId)).toEqual(models);
				expect(await result.getAvailable(providerId)).toEqual(models);
				expect((await result.getAvailable()).filter((model) => model.provider === providerId)).toEqual(models);
				expect(registry.getAll().filter((model) => model.provider === providerId)).toEqual(models);
				expect(registry.getAvailable().filter((model) => model.provider === providerId)).toEqual(models);
				expect((await result.getAuth(models[0]))?.auth.headers).toMatchObject({ "x-overlay": "present" });
				expect(result.getAllModels(providerId)).toEqual([]);
			};
			await verify();
			await result.refresh({ allowNetwork: false });
			await verify();
		},
	);

	it("does not bypass canonical mixed availability policy when an overlaid all-list fails", async () => {
		let failing = false;
		const result = await configured(
			{ headers: { "x-overlay": "present" } },
			native({
				getAllModels: () => {
					if (failing) throw new Error("synthetic all-list failure");
					return [chat(), image()];
				},
				filterAllModels: (models) => models.filter((model) => model.type === "image"),
			}),
		);
		failing = true;
		expect(result.getModels(providerId)).toEqual([chat()]);
		expect(await result.getAvailable(providerId)).toEqual([]);
		expect(await result.getAllAvailable(providerId)).toEqual([]);
		expect((await result.getAvailable()).filter((model) => model.provider === providerId)).toEqual([]);
		expect(new ModelRegistry(result).getAvailable().filter((model) => model.provider === providerId)).toEqual([]);
	});

	it("extension models replace the entire inherited catalog and image API defaults cannot come from chat", async () => {
		const result = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		result.registerProvider("openrouter", { models: [chat()] });
		expect(result.getModelsOfType("image", "openrouter")).toEqual([]);
		const { api: _api, ...definition } = image();
		expect(() =>
			result.registerProvider("new-image-only", {
				api: "openai-completions",
				baseUrl: "https://image.test/v1",
				models: [definition],
			}),
		).toThrow('no "api" specified');
	});

	it("selects inherited image API and endpoint defaults by type plus ID, not a colliding chat or first image", async () => {
		const models = [
			image("other"),
			chat(),
			{ ...image(), api: "matching-images", baseUrl: "https://matching.test/v1" },
		];
		const { api: _api, baseUrl: _baseUrl, ...definition } = image();
		const provider = composeModelProvider(
			providerId,
			native({ getAllModels: () => models }),
			await ModelConfig.load(undefined),
			{ models: [definition] },
		);
		expect(provider.getAllModels?.()[0]).toMatchObject({
			type: "image",
			api: "matching-images",
			baseUrl: "https://matching.test/v1",
		});
	});

	it("rejects duplicate same-operation definitions across APIs but accepts cross-operation same IDs", async () => {
		const result = await runtime();
		expect(() =>
			result.registerProvider(providerId, { models: [image(), { ...image(), api: "other-images" }] }),
		).toThrow("duplicate model operation");
		expect(() =>
			result.registerProvider(providerId, { models: [{ ...image(), output: ["text" as const] }] }),
		).toThrow("must include image output");
	});

	it("legacy OAuth projections see only chat and cannot discard images", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(providerId, async () => ({
			type: "oauth",
			access: "synthetic",
			refresh: "synthetic",
			expires: Date.now() + 3600000,
		}));
		const result = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		const modifyModels = vi.fn((models: Model<Api>[]) => {
			expect(models).toHaveLength(1);
			expect(models.map((model) => model.type ?? "chat")).toEqual(["chat"]);
			return [];
		});
		result.registerProvider(providerId, {
			models: [chat(), image()],
			images: { "test-images": { generateImages: async (model) => success(model) } },
			oauth: {
				name: "Synthetic",
				login: async () => ({ access: "synthetic", refresh: "synthetic", expires: 0 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
				modifyModels,
			},
		});
		await result.refresh({ allowNetwork: false });
		expect(result.getModels(providerId)).toEqual([]);
		expect(result.getModelsOfType("image", providerId)).toHaveLength(1);
		expect(modifyModels).toHaveBeenCalled();
	});

	it("rejects wrong-operation chat/deferred calls before resolving auth or dispatching adapters", async () => {
		const resolve = vi.fn(async () => ({ auth: {} }));
		const generateImages = vi.fn<NonNullable<Provider["generateImages"]>>(async (model) => success(model));
		const result = await runtime(native({ auth: { apiKey: { name: "Keyless", resolve } }, generateImages }));
		resolve.mockClear();
		const wrong = image() as unknown as Model<Api>;
		const context = { messages: [] };
		const handle = { provider: providerId, modelId: "same", api: wrong.api, id: "synthetic" };
		for (const response of [
			await result.complete(wrong, context),
			await result.completeSimple(wrong, context),
			await result.fetchDeferred(wrong, handle),
		]) {
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("not a chat model");
		}
		await expect(result.cancelDeferred(wrong, handle)).rejects.toThrow("not a chat model");
		expect(resolve).not.toHaveBeenCalled();
		expect(generateImages).not.toHaveBeenCalled();
	});

	it("encodes unconfigured image auth and wrong image operations without rejection", async () => {
		const result = await runtime(
			native({ auth: { apiKey: { name: "Unconfigured", resolve: async () => undefined } } }),
		);
		expect(await result.generateImages(image(), { input: [] })).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("not configured"),
		});
		expect(await result.generateImages(chat() as unknown as ImageModel<string>, { input: [] })).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("not an image model"),
		});
		expect(await result.getAvailableOfType("image", providerId)).toEqual([]);
	});

	it.each(["auth", "transform", "adapter"] as const)(
		"promptly encodes cancellation during a non-cooperative %s",
		async (phase) => {
			let started: (() => void) | undefined;
			const pending = new Promise<void>((resolve) => {
				started = resolve;
			});
			const block = async () => {
				started?.();
				return new Promise<never>(() => {});
			};
			const provider = native({
				auth: {
					apiKey: {
						name: "Keyless",
						check: async () => ({ type: "api_key" }),
						resolve: phase === "auth" ? block : async () => ({ auth: {} }),
					},
				},
				generateImages: phase === "adapter" ? block : async (model) => success(model),
			});
			const result = await runtime(provider);
			const controller = new AbortController();
			const request = result.generateImages(
				image(),
				{ input: [] },
				{ signal: controller.signal, transformHeaders: phase === "transform" ? block : undefined },
			);
			await pending;
			controller.abort(new Error("synthetic cancellation"));
			expect(await request).toMatchObject({
				stopReason: "aborted",
				output: [],
				errorMessage: "synthetic cancellation",
			});
		},
	);

	it("isolates image registrations/unregister across session views and keeps global adapters unchanged", async () => {
		const result = await runtime();
		const first = await result.createSessionView();
		const sibling = await result.createSessionView();
		const before = getImagesApiProvider("test-images");
		first.registerProvider(providerId, {
			models: [image("child-only")],
			images: { "test-images": { generateImages: async (model) => success(model) } },
			apiKey: "synthetic",
		});
		expect(first.getModelOfType("image", providerId, "child-only")).toBeDefined();
		expect(result.getModelOfType("image", providerId, "child-only")).toBeUndefined();
		expect(sibling.getModelOfType("image", providerId, "child-only")).toBeUndefined();
		first.unregisterProvider(providerId);
		expect(result.getModelOfType("image", providerId, "same")).toBeDefined();
		expect(sibling.getModelOfType("image", providerId, "same")).toBeDefined();
		expect(getImagesApiProvider("test-images")).toBe(before);
	});

	it("restores and publishes mixed dynamic catalogs through the configured runtime store", async () => {
		const store = new InMemoryModelsStore();
		const provider = createProvider({
			id: providerId,
			auth: { apiKey: { name: "Keyless", resolve: async () => ({ auth: {} }) } },
			models: [],
			images: { "test-images": { generateImages: async (model) => success(model) } },
			fetchModels: async () => [chat(), image()],
		});
		const result = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: store,
			modelsPath: null,
			allowModelNetwork: false,
		});
		result.registerNativeProvider(provider);
		await result.refresh({ providers: [providerId], allowNetwork: true, force: true });
		expect((await store.read(providerId))?.models).toHaveLength(2);
		const restored: AnyModel[] = [];
		const next = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: store,
			modelsPath: null,
			allowModelNetwork: false,
		});
		next.registerNativeProvider(
			native({
				getModels: () => restored.filter((model): model is Model<Api> => model.type !== "image"),
				getAllModels: () => restored,
				refreshModels: async (context) => {
					await context.publish({
						update: () => {
							restored.splice(0, restored.length, ...(context.stored?.models ?? []));
						},
					});
				},
			}),
		);
		await next.refresh({ allowNetwork: false });
		expect(next.getAllModels(providerId)).toHaveLength(2);
		expect(next.getModels(providerId)).toHaveLength(1);
	});

	it("loads the real image-provider extension example through jiti and runs only the injected local transport", async () => {
		const loaded = await loadExtensions(
			[fileURLToPath(new URL("../examples/extensions/custom-provider-images.ts", import.meta.url))],
			process.cwd(),
		);
		expect(loaded.errors).toEqual([]);
		expect(loaded.runtime.pendingNativeProviderRegistrations).toHaveLength(1);
		const provider = loaded.runtime.pendingNativeProviderRegistrations[0].provider;
		const result = await runtime(provider);
		expect(result.getModels(provider.id)).toEqual([]);
		const imageModel = result.getModelsOfType("image", provider.id)[0];
		expect(imageModel).toBeDefined();
		const transport = vi.fn<typeof fetch>(
			async () => new Response(JSON.stringify({ data: "synthetic-image-data", mimeType: "image/png" })),
		);
		const onPayload = vi.fn(() => ({ input: [], test: true }));
		const onResponse = vi.fn();
		expect(
			await result.generateImages(imageModel, { input: [] }, { fetch: transport, onPayload, onResponse }),
		).toMatchObject({
			stopReason: "stop",
			output: [{ type: "image", data: "synthetic-image-data", mimeType: "image/png" }],
		});
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0][0]).toBe("http://localhost:8080/v1/images");
		expect(transport.mock.calls[0][1]?.body).toBe(JSON.stringify({ input: [], test: true }));
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledTimes(1);
	});

	it.each(["models", "modelOverrides"] as const)(
		"rejects image definitions in the chat-only models.json %s field",
		async (field) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-chat-config-"));
			directories.push(directory);
			const path = join(directory, "models.json");
			await writeFile(
				path,
				JSON.stringify({
					providers: { [providerId]: { [field]: field === "models" ? [image()] : { same: { type: "image" } } } },
				}),
			);
			expect((await ModelConfig.load(path)).getError()).toContain("Invalid models.json schema");
		},
	);
});
