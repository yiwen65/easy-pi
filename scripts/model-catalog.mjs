import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function validateProviderId(providerId) {
	if (typeof providerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(providerId)) {
		throw new Error(`Invalid provider ID: ${JSON.stringify(providerId)}`);
	}
}

function validateModel(model, providerId, { legacyChat = false } = {}) {
	if (
		!isRecord(model) ||
		typeof model.id !== "string" ||
		model.id.trim().length === 0 ||
		/[\u0000-\u001f\u007f]/.test(model.id) ||
		model.provider !== providerId ||
		(model.type !== "chat" && model.type !== "image" && !(legacyChat && model.type === undefined))
	) {
		throw new Error(`Invalid model entry for provider ${providerId}: ${JSON.stringify(model)}`);
	}
	return model.type === undefined ? { ...model, type: "chat" } : model;
}

/** Operation identity within a provider; never merge chat and image by bare ID. */
export function modelOperationKey(model) {
	return JSON.stringify([model.type, model.id]);
}

/**
 * Read and cross-check every public projection. Legacy-only input is opt-in for
 * historical diffs, never publication. Missing types are accepted only in keyed
 * chat projections; mixed arrays must declare their operation explicitly.
 */
export function readModelCatalog(inputDir, { allowLegacy = false } = {}) {
	const modelsPath = join(inputDir, "models.json");
	const allModelsPath = join(inputDir, "models.all.json");
	const providerIndexPath = join(inputDir, "providers.json");
	const providersDir = join(inputDir, "providers");
	const chatCatalog = readJson(modelsPath);
	const providerIds = readJson(providerIndexPath);
	if (!isRecord(chatCatalog)) throw new Error("models.json must contain an object");
	if (!Array.isArray(providerIds)) throw new Error("providers.json must contain an array of provider IDs");
	for (const providerId of providerIds) validateProviderId(providerId);
	if (!isDeepStrictEqual(providerIds, Object.keys(chatCatalog).sort())) {
		throw new Error("providers.json does not match the sorted providers in models.json");
	}

	const mixed = existsSync(allModelsPath);
	if (!mixed && !allowLegacy) throw new Error("models.all.json is required for publication");
	const files = ["models.json", "providers.json"];
	if (mixed) files.push("models.all.json");
	const modelsByProvider = new Map(providerIds.map((providerId) => [providerId, new Map()]));
	const allByProvider = new Map(providerIds.map((providerId) => [providerId, []]));
	if (mixed) {
		const allModels = readJson(allModelsPath);
		if (!Array.isArray(allModels)) throw new Error("models.all.json must contain an array");
		for (const entry of allModels) {
			const providerId = entry?.provider;
			validateProviderId(providerId);
			const models = modelsByProvider.get(providerId);
			if (!models) throw new Error(`Unknown provider in models.all.json: ${providerId}`);
			const model = validateModel(entry, providerId);
			const key = modelOperationKey(model);
			if (models.has(key)) throw new Error(`Duplicate model operation: ${providerId}/${model.type}:${model.id}`);
			models.set(key, model);
			allByProvider.get(providerId).push(model);
		}
	}

	let modelCount = 0;
	let imageModelCount = 0;
	for (const providerId of providerIds) {
		const chatModels = chatCatalog[providerId];
		if (!isRecord(chatModels)) throw new Error(`Provider chat catalog must be an object: ${providerId}`);
		if (!isDeepStrictEqual(readJson(join(providersDir, `${providerId}.json`)), chatModels)) {
			throw new Error(`Provider shard does not match models.json: ${providerId}`);
		}
		files.push(`providers/${providerId}.json`);
		const normalizedChats = {};
		for (const [id, entry] of Object.entries(chatModels)) {
			const model = validateModel(entry, providerId, { legacyChat: true });
			if (id !== model.id || model.type !== "chat") throw new Error(`Invalid chat model entry: ${providerId}/${id}`);
			Object.defineProperty(normalizedChats, id, { value: model, enumerable: true });
			if (!mixed) modelsByProvider.get(providerId).set(modelOperationKey(model), model);
			modelCount++;
		}
		if (mixed) {
			const allModels = allByProvider.get(providerId);
			const shard = readJson(join(providersDir, `${providerId}.all.json`));
			if (!isDeepStrictEqual(shard, allModels)) {
				throw new Error(`Provider mixed shard does not match models.all.json: ${providerId}`);
			}
			files.push(`providers/${providerId}.all.json`);
			const projectedChats = Object.fromEntries(allModels.filter((model) => model.type === "chat").map((model) => [model.id, model]));
			if (!isDeepStrictEqual(projectedChats, normalizedChats)) {
				throw new Error(`Chat projection does not match models.all.json: ${providerId}`);
			}
			imageModelCount += allModels.filter((model) => model.type === "image").length;
		}
	}

	const shardFiles = readdirSync(providersDir).filter((name) => name.endsWith(".json")).sort();
	const expectedShardFiles = files.filter((name) => name.startsWith("providers/")).map((name) => name.slice("providers/".length)).sort();
	if (!isDeepStrictEqual(shardFiles, expectedShardFiles)) {
		throw new Error("Provider shard files do not match providers.json and catalog projections");
	}

	// Frame both filenames and bytes so every archived projection contributes,
	// including all image metadata. Publication timestamps never affect revision.
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		const bytes = readFileSync(join(inputDir, file));
		hash.update(`${file}\0${bytes.length}\0`).update(bytes);
	}
	return {
		modelsPath,
		allModelsPath: mixed ? allModelsPath : undefined,
		providerIndexPath,
		providersDir,
		providerIds,
		modelsByProvider,
		files,
		providerCount: providerIds.length,
		modelCount,
		imageModelCount,
		totalModelCount: modelCount + imageModelCount,
		revision: `sha256-${hash.digest("hex")}`,
	};
}
