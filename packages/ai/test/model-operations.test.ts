import { expect, expectTypeOf, it } from "vitest";
import {
	generateImages as compatGenerateImages,
	streamSimple as compatStreamSimple,
	getImageModel,
	getImageModels,
	getImageProviders,
} from "../src/compat.ts";
import { flattenChatModelCatalog, flattenImageModelCatalog } from "../src/model-catalog.ts";
import { IMAGE_MODELS, MODELS } from "../src/models.generated.ts";
import { getModelType, hasApi, isModelType, modelsAreEqual } from "../src/models.ts";
import { getAllBuiltinModels, getBuiltinImageModel, getBuiltinImageModels } from "../src/providers/all.ts";
import type { AnyModel, ImageModel, Model, ModelType } from "../src/types.ts";

const legacy: Model<"custom"> = {
	id: "same",
	name: "Same",
	api: "custom",
	provider: "p",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100,
	maxTokens: 10,
};
const image: ImageModel<"custom"> = {
	type: "image",
	id: "same",
	name: "Same",
	api: "custom",
	provider: "p",
	baseUrl: "",
	input: ["text"],
	output: ["image"],
	cost: legacy.cost,
};

it("defaults legacy typed chat to chat and uses operation identity, including API-independent equality", () => {
	expectTypeOf<ModelType>().toEqualTypeOf<"chat" | "image">();
	expect(getModelType(legacy)).toBe("chat");
	expect(isModelType(legacy, "chat")).toBe(true);
	expect(isModelType(image, "chat")).toBe(false);
	expect(hasApi(image, "custom")).toBe(false);
	expect(hasApi(legacy, "custom")).toBe(true);
	expect(modelsAreEqual(legacy, { ...legacy, type: "chat", api: "other" })).toBe(true);
	expect(modelsAreEqual(legacy, image)).toBe(false);
	expect(modelsAreEqual(legacy, { ...legacy, provider: "other" })).toBe(false);
	expect(modelsAreEqual(undefined, legacy)).toBe(false);
	const unknown = { ...legacy, type: "classifier" } as unknown as AnyModel;
	expect(isModelType(unknown, "chat")).toBe(false);
	expect(isModelType(unknown, "image")).toBe(false);
});

it("defaults only missing or undefined operation types, not explicit null", () => {
	const malformed = { ...legacy };
	Object.defineProperty(malformed, "type", { value: null, enumerable: true });
	expect(getModelType({ ...legacy, type: undefined })).toBe("chat");
	expect(getModelType(malformed)).toBeNull();
	expect(isModelType(malformed, "chat")).toBe(false);
	expect(isModelType(malformed, "image")).toBe(false);
	expect(hasApi(malformed, "custom")).toBe(false);
});

it("derives exact chat/image literals from operation keys without overwriting same IDs", () => {
	const groups = { custom: { "chat:same": { ...legacy, type: "chat" as const }, "image:same": image } };
	const chats = flattenChatModelCatalog("p", groups);
	const images = flattenImageModelCatalog("p", groups);
	expect(chats.same).toEqual({ ...legacy, type: "chat" });
	expect(images.same).toEqual(image);
	expectTypeOf(chats.same.id).toEqualTypeOf<"same">();
	expectTypeOf(chats.same.api).toEqualTypeOf<"custom">();
	expectTypeOf(images.same.api).toEqualTypeOf<"custom">();
	expectTypeOf(images.same.type).toEqualTypeOf<"image">();
	expect(() => flattenChatModelCatalog("p", { custom: groups.custom, other: groups.custom })).toThrow();
});

it("keeps global image catalog/registry entrypoints available against the unified generated image projection", async () => {
	expect(getImageProviders()).toEqual(["openrouter"]);
	expect(getImageModels("openrouter")).toHaveLength(61);
	const found = getImageModel("openrouter", "google/gemini-2.5-flash-image");
	expect(found).toBe(IMAGE_MODELS.openrouter["google/gemini-2.5-flash-image"]);
	expect(found.type).toBe("image");
	const builtin = getBuiltinImageModel("openrouter", "google/gemini-2.5-flash-image");
	expectTypeOf(builtin.api).toEqualTypeOf<"openrouter-images">();
	expect(getBuiltinImageModels("anthropic")).toEqual([]);
	expect(getAllBuiltinModels("openrouter")).toHaveLength(453);
	expectTypeOf(found.api).toEqualTypeOf<"openrouter-images">();
	expect(MODELS.openrouter.auto.type).toBe("chat");
	const forced = { ...found, api: "openai-completions" } as unknown as Model<"openai-completions">;
	expect(await compatStreamSimple(forced, { messages: [] }).result()).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("not a chat model"),
	});
	expect(await compatGenerateImages({ ...found, api: "unregistered-fixture" }, { input: [] })).toMatchObject({
		stopReason: "error",
	});
});
