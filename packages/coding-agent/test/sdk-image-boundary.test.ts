import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	type ImageContent,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	streamSimple as streamCompletions,
	stream as streamCompletionsFull,
} from "../../ai/src/api/openai-completions.ts";
import type { ImagePolicyOverride } from "../src/core/images/policy.ts";
import type { ImageLimits } from "../src/core/images/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createImagePng } from "./helpers/image-fixtures.ts";
import { createTestResourceLoader } from "./utilities.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const image: ImageContent = { type: "image", mimeType: "image/png", data: createImagePng().toString("base64") };

async function fixture(
	blockImages = false,
	limits?: Partial<ImageLimits>,
	imagePolicyOverrides?: readonly ImagePolicyOverride[],
) {
	const directory = mkdtempSync(join(tmpdir(), "pi-sdk-images-"));
	const bodies: string[] = [];
	const transport = vi.fn<typeof fetch>(async (_url, options) => {
		bodies.push(String(options?.body));
		const chunk = {
			id: "local",
			object: "chat.completion.chunk",
			model: "local-image",
			created: 0,
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	});
	const model: Model<"openai-completions"> = {
		id: "local-image",
		name: "Local Image",
		provider: "image-boundary",
		api: "openai-completions",
		baseUrl: "https://declared.invalid/v1",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 100000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "synthetic" }));
	const provider: Provider<"openai-completions"> = {
		id: model.provider,
		name: "Local boundary test",
		getModels: () => [model],
		auth: {
			apiKey: {
				name: "Synthetic",
				resolve: async () => ({ auth: { apiKey: "synthetic", baseUrl: "https://resolved.invalid/v1" } }),
			},
		},
		stream: (actual, context, options) => streamCompletionsFull(actual, context, { ...options, fetch: transport }),
		streamSimple: (actual, context, options) => streamCompletions(actual, context, { ...options, fetch: transport }),
	};
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(provider);
	await runtime.refresh({ providers: [model.provider], allowNetwork: false });
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		model,
		modelRuntime: runtime,
		sessionManager: SessionManager.inMemory(directory),
		settingsManager: SettingsManager.inMemory({ images: { blockImages, limits } }),
		imagePolicyOverrides,
		resourceLoader: createTestResourceLoader(),
		tools: [],
	});
	cleanups.push(async () => {
		await session.shutdown();
		rmSync(directory, { recursive: true, force: true });
	});
	return { session, model, transport, bodies };
}

describe("SDK image wire boundary with real local serializer", () => {
	it("repairs historical bad image bytes before serialization without changing the source context", async () => {
		const { session, model, transport, bodies } = await fixture();
		const context: Context = {
			messages: [
				{ role: "user", content: [{ ...image, data: "bm90LWFuLWltYWdl" }], timestamp: 0 },
				{ role: "user", content: [image], timestamp: 1 },
			],
		};
		const before = JSON.stringify(context);
		const result = await (await session.agent.streamFunction(model, context, {})).result();
		expect(result.stopReason).toBe("stop");
		expect(transport).toHaveBeenCalledOnce();
		expect(bodies[0]).not.toContain("bm90LWFuLWltYWdl");
		expect(bodies[0]).toContain(image.data);
		expect(JSON.stringify(context)).toBe(before);
		expect(session.getImageDecisions().some((decision) => decision.stage === "serialized")).toBe(true);
	});

	it("publishes historical IDs on budget failure and recovers after explicit reversible selection", async () => {
		const { session, model, transport } = await fixture(false, { maxImages: 1 });
		const context: Context = {
			messages: [
				{ role: "user", content: [image], timestamp: 0 },
				{ role: "user", content: [image], timestamp: 1 },
			],
		};
		const original = JSON.stringify(context);
		const failed = await (await session.agent.streamFunction(model, context, {})).result();
		expect(failed.stopReason).toBe("error");
		expect(transport).not.toHaveBeenCalled();
		const ids = session.getImageDecisions().map((decision) => decision.imageId);
		expect(ids).toHaveLength(2);
		session.setImageSelection([ids[0]]);
		expect((await (await session.agent.streamFunction(model, context, {})).result()).stopReason).toBe("stop");
		expect(transport).toHaveBeenCalledOnce();
		expect(JSON.stringify(context)).toBe(original);
		session.setImageSelection([]);
		expect((await (await session.agent.streamFunction(model, context, {})).result()).stopReason).toBe("error");
		expect(transport).toHaveBeenCalledOnce();
	});

	it("applies explicit endpoint limits only after auth rerouting", async () => {
		const override: ImagePolicyOverride = {
			api: "openai-completions",
			baseUrl: "https://resolved.invalid/v1",
			limits: { maxImages: 1 },
			source: "operator",
		};
		const { session, model, transport } = await fixture(false, undefined, [override]);
		const context: Context = { messages: [{ role: "user", content: [image, image], timestamp: 2 }] };
		const result = await (await session.agent.streamFunction(model, context, {})).result();
		expect(result.stopReason).toBe("error");
		expect(transport).not.toHaveBeenCalled();
		const other = await fixture(false, undefined, [{ ...override, baseUrl: model.baseUrl }]);
		expect((await (await other.session.agent.streamFunction(other.model, context, {})).result()).stopReason).toBe(
			"stop",
		);
		expect(other.transport).toHaveBeenCalledOnce();
	});

	it("rejects a hook-injected corrupt image before any HTTP request", async () => {
		const { session, model, transport } = await fixture();
		const result = await (
			await session.agent.streamFunction(
				model,
				{ messages: [] },
				{
					onPayload: () => ({
						model: model.id,
						stream: true,
						messages: [
							{
								role: "user",
								content: [{ type: "image_url", image_url: { url: "data:image/png;base64,bm90LWFuLWltYWdl" } }],
							},
						],
					}),
				},
			)
		).result();
		expect(result.stopReason).toBe("error");
		expect(transport).not.toHaveBeenCalled();
	});

	it("does not let raw hooks bypass blockImages", async () => {
		const { session, model, transport } = await fixture(true);
		const result = await (
			await session.agent.streamFunction(
				model,
				{ messages: [] },
				{
					onPayload: () => ({
						messages: [
							{
								role: "user",
								content: [{ type: "image_url", image_url: { url: "https://example.invalid/private" } }],
							},
						],
					}),
				},
			)
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("disabled");
		expect(transport).not.toHaveBeenCalled();
	});
});
