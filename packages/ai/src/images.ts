import "./providers/images/register-builtins.ts";

import { getImagesApiProvider } from "./images-api-registry.ts";
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ProviderImagesOptions } from "./types.ts";
import { assertImageModel, imageErrorResult } from "./utils/model-operations.ts";

function resolveImagesApiProvider(api: ImageApi) {
	const provider = getImagesApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export async function generateImages<TApi extends ImageApi>(
	model: ImageModel<TApi>,
	context: ImagesContext,
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	try {
		assertImageModel(model);
		const provider = resolveImagesApiProvider(model.api);
		return await provider.generateImages(model, context, options);
	} catch (error) {
		return imageErrorResult(model, error, options?.signal?.aborted);
	}
}
