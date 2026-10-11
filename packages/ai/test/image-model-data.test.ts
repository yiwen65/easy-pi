import { describe, expect, it } from "vitest";
import { parseOpenRouterImageModels } from "../scripts/openrouter-images-catalog.ts";

const validImageModel = {
	id: "example/image-model",
	name: "Example Image Model",
	architecture: {
		input_modalities: ["text", "image"],
		output_modalities: ["image"],
	},
	pricing: {
		prompt: "0.000001",
		completion: "0.000002",
	},
};

describe("OpenRouter image model parsing", () => {
	it.each([{}, { data: [] }, { data: "invalid" }])("rejects a missing or empty strict catalog", (payload) => {
		expect(() => parseOpenRouterImageModels(payload, true)).toThrow("missing or empty image model list");
	});

	it("rejects a strict catalog with no usable image models", () => {
		expect(() =>
			parseOpenRouterImageModels(
				{
					data: [
						{
							...validImageModel,
							architecture: { input_modalities: ["text"], output_modalities: ["text"] },
						},
					],
				},
				true,
			),
		).toThrow("no usable image models");
	});

	it("preserves floating-point image prices and negative auto-router sentinel rates", () => {
		const [model] = parseOpenRouterImageModels(
			{ data: [{ ...validImageModel, pricing: { prompt: "0.00000010000000000000002", completion: "-0.000001" } }] },
			true,
		);
		expect(model.type).toBe("image");
		expect(model.cost.input).toBe(parseFloat("0.00000010000000000000002") * 1_000_000);
		expect(model.cost.output).toBe(-1);
	});

	it("parses a non-empty image model catalog", () => {
		expect(parseOpenRouterImageModels({ data: [validImageModel] }, true)).toEqual([
			expect.objectContaining({
				id: "example/image-model",
				input: ["text", "image"],
				output: ["image"],
			}),
		]);
	});
});
