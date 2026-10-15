import {
	type AnyModel,
	getModelType,
	isModelType,
	type ModelsStoreEntry,
	modelsAreEqual,
	type OpenAIResponsesCompat,
	type Provider,
} from "@earendil-works/pi-ai";
import { hasKnownModelType } from "@earendil-works/pi-ai/utils/model-operations";
import { VERSION } from "../config.ts";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

function mergeModels(baseline: readonly AnyModel[], dynamic: readonly AnyModel[]): AnyModel[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => modelsAreEqual(entry, model));
		if (index >= 0) {
			const bundled = merged[index];
			if (
				isModelType(model, "chat") &&
				isModelType(bundled, "chat") &&
				model.provider === "openai-codex" &&
				model.api === "openai-codex-responses" &&
				bundled.api === "openai-codex-responses"
			) {
				const bundledCompat = bundled.compat as OpenAIResponsesCompat | undefined;
				const remoteCompat = model.compat as OpenAIResponsesCompat | undefined;
				// Older catalogs cannot declare this newly added field. Keep verified local
				// knowledge on exact Codex collisions, but honor an explicit remote false.
				merged[index] =
					remoteCompat?.supportsFastMode === undefined && bundledCompat?.supportsFastMode !== undefined
						? { ...model, compat: { ...remoteCompat, supportsFastMode: bundledCompat.supportsFastMode } }
						: model;
			} else merged[index] = model;
		} else merged.push(model);
	}
	return merged;
}

function parseCatalog(providerId: string, value: unknown): AnyModel[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries
		.filter(
			(entry): entry is AnyModel =>
				typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string",
		)
		.filter(hasKnownModelType)
		.map((model) => ({ ...model, provider: providerId }));
}

/** IDs of the generated (bundled) baseline models a remote overlay is merged onto. */
type BaselineIds = ReadonlySet<string>;

/** A validator only backs the exact all-operation request variant that fetched it. */
interface RemoteCatalogEntry extends ModelsStoreEntry {
	catalogType?: "all";
}

function operationKey(model: AnyModel): string {
	return JSON.stringify([model.provider, getModelType(model), model.id]);
}

function remoteModels(
	entry: ModelsStoreEntry | undefined,
	localGeneratedAt: number | undefined,
	baselineIds: BaselineIds,
): readonly AnyModel[] {
	if (!entry) return [];
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		// The generated catalog is at least as new as this snapshot, so it wins
		// collisions. It can still lag the snapshot's model set (a regeneration
		// built from a hand-maintained list while the remote catalog already added
		// a model, for example), so models the generated catalog does not know
		// remain visible instead of being dropped.
		return entry.models.filter((model) => !baselineIds.has(operationKey(model)));
	}
	return entry.models;
}

/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	let dynamicModels: readonly AnyModel[] = [];
	const baseline = () => provider.getAllModels?.() ?? provider.getModels();
	const baselineIds: BaselineIds = new Set(baseline().map(operationKey));

	return {
		...provider,
		getModels: () =>
			mergeModels(
				provider.getModels(),
				dynamicModels.filter((model) => isModelType(model, "chat")),
			).filter((model) => isModelType(model, "chat")),
		getAllModels: () => mergeModels(baseline(), dynamicModels),
		refreshModels: async (context) => {
			const stored = context.stored as Readonly<RemoteCatalogEntry> | undefined;
			const restored = remoteModels(stored, localGeneratedAt, baselineIds).filter(
				(model) => model.provider === provider.id && hasKnownModelType(model),
			);
			if (
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				stored?.catalogType === "all" &&
				stored.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			// Only revalidate when a cached body backs the validator, so a 304 can never
			// leave the overlay empty.
			const validator = stored?.catalogType === "all" && stored.models.length ? stored.etag : undefined;
			const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
			url.searchParams.set("type", "all");
			const response = await fetchWithRetry(
				url,
				{
					headers: {
						accept: "application/json",
						"User-Agent": getPiUserAgent(VERSION),
						...(validator ? { "if-none-match": validator } : {}),
					},
					signal: context.signal,
				},
				{ attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS },
			);
			if (context.signal.aborted) return;
			const checkedAt = Date.now();
			// Unchanged: dynamicModels already holds the stored overlay, so only the
			// freshness window moves.
			if (response.status === 304) {
				if (!stored || !validator)
					throw new Error(`Model catalog returned 304 without an all-operation cached body for ${provider.id}`);
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			if (response.status === 404 || response.status === 501) {
				const unavailable: RemoteCatalogEntry = {
					...(stored ?? { models: [] }),
					checkedAt,
					lastModified: 0,
					etag: undefined,
					catalogType: "all",
				};
				await context.publish({ persist: unavailable });
				return;
			}
			if (!response.ok) {
				// Transient failure: the cached body and its validator stay valid, so keep the
				// etag and let the next refresh revalidate instead of downloading the catalog.
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			const refreshed = parseCatalog(provider.id, await response.json());
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			if (context.signal.aborted) return;
			const entry: RemoteCatalogEntry = {
				catalogType: "all",
				models: refreshed,
				checkedAt,
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
				etag: response.headers.get("etag") ?? undefined,
			};
			const published = remoteModels(entry, localGeneratedAt, baselineIds);
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
				},
			});
		},
	};
}
