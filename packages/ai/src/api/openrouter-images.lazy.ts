import type { ImageModel, ProviderImages } from "../types.ts";

export const openrouterImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openrouter-images.ts")).generateImages(
			model as ImageModel<"openrouter-images">,
			context,
			options,
		),
});
