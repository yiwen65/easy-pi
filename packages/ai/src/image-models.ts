import { IMAGE_MODELS } from "./models.generated.ts";

type BuiltinImageProvider = keyof typeof IMAGE_MODELS;

import type { ImageApi, ImageModel } from "./types.ts";

const imageModelRegistry: Map<string, Map<string, ImageModel<ImageApi>>> = new Map();

for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	const providerModels = new Map<string, ImageModel<ImageApi>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as ImageModel<ImageApi>);
	}
	imageModelRegistry.set(provider, providerModels);
}

type ImageModelApi<
	TProvider extends BuiltinImageProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
> = (typeof IMAGE_MODELS)[TProvider][TModelId] extends { api: infer TApi }
	? TApi extends ImageApi
		? TApi
		: never
	: never;

export function getImageModel<
	TProvider extends BuiltinImageProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): ImageModel<ImageModelApi<TProvider, TModelId>> {
	const providerModels = imageModelRegistry.get(provider);
	return providerModels?.get(modelId as string) as ImageModel<ImageModelApi<TProvider, TModelId>>;
}

export function getImageProviders(): BuiltinImageProvider[] {
	return Array.from(imageModelRegistry.keys()) as BuiltinImageProvider[];
}

export function getImageModels<TProvider extends BuiltinImageProvider>(
	provider: TProvider,
): ImageModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[] {
	const models = imageModelRegistry.get(provider);
	return models
		? (Array.from(models.values()) as ImageModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[])
		: [];
}
