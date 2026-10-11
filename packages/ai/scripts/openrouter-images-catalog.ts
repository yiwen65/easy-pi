import type { ImageModel } from "../src/types.ts";

interface OpenRouterImageRecord {
	id: string;
	name: string;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}

/** Preserve the image catalog's float rates and negative auto-router sentinel. */
export function parseOpenRouterImageModels(payload: unknown, strict: boolean): ImageModel<"openrouter-images">[] {
	const data = typeof payload === "object" && payload !== null ? (payload as { data?: unknown }).data : undefined;
	if (!Array.isArray(data) || data.length === 0) {
		if (strict) throw new Error("OpenRouter API returned a missing or empty image model list");
		return [];
	}
	const models: ImageModel<"openrouter-images">[] = [];
	for (const value of data) {
		if (typeof value !== "object" || value === null) continue;
		const model = value as OpenRouterImageRecord;
		const input = Array.from(new Set((model.architecture?.input_modalities ?? []).filter((modality): modality is "text" | "image" => modality === "text" || modality === "image")));
		const output = Array.from(new Set((model.architecture?.output_modalities ?? []).filter((modality): modality is "text" | "image" => modality === "text" || modality === "image")));
		if (!output.includes("image")) continue;
		if (!model.id || !model.name) {
			if (strict) throw new Error("OpenRouter image model has no id or name");
			continue;
		}
		if (input.length === 0) input.push("text");
		const cost = {
			input: parseFloat(model.pricing?.prompt || "0") * 1_000_000,
			output: parseFloat(model.pricing?.completion || "0") * 1_000_000,
			cacheRead: parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000,
			cacheWrite: parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000,
		};
		if (Object.values(cost).some((rate) => !Number.isFinite(rate))) {
			if (strict) throw new Error(`Invalid OpenRouter image pricing for ${model.id}`);
			continue;
		}
		models.push({ type: "image", id: model.id, name: model.name, api: "openrouter-images", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", input, output, cost });
	}
	if (strict && models.length === 0) throw new Error("OpenRouter API returned no usable image models");
	return models;
}

export async function fetchOpenRouterImageModels(strict: boolean): Promise<ImageModel<"openrouter-images">[]> {
	try {
		const response = await fetch("https://openrouter.ai/api/v1/models?output_modalities=image");
		if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
		return parseOpenRouterImageModels(await response.json(), strict);
	} catch (error) {
		if (strict) throw error;
		console.error("Failed to fetch OpenRouter image models:", error);
		return [];
	}
}
