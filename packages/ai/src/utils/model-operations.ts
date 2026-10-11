import { ModelsError } from "../auth/resolve.ts";
import type { AnyModel, Api, AssistantImages, ImageApi, ImageModel, Model, ModelType, ModelTypeMap } from "../types.ts";

/** Missing type is chat only for an existing typed legacy chat model. */
export function getModelType(model: AnyModel): ModelType {
	return model.type === undefined ? "chat" : model.type;
}

/** Unknown external operation types do not match either supported operation. */
export function isModelType<TType extends ModelType>(model: AnyModel, type: TType): model is ModelTypeMap[TType] {
	return getModelType(model) === type;
}

export function hasKnownModelType(model: AnyModel): boolean {
	return isModelType(model, "chat") || isModelType(model, "image");
}

export function assertChatModel(model: AnyModel): asserts model is Model<Api> {
	if (!isModelType(model, "chat")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a chat model`);
	}
}

export function assertImageModel(model: AnyModel): asserts model is ImageModel<ImageApi> {
	if (!isModelType(model, "image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not an image model`);
	}
	if (!model.output?.includes("image"))
		throw new ModelsError("model_validation", `Image model ${model.provider}/${model.id} must include image output`);
}

export function imageErrorResult(model: ImageModel<ImageApi>, error: unknown, aborted = false): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}
