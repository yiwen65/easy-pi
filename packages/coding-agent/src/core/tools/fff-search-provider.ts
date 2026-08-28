import { stat } from "node:fs/promises";
import {
	type ExecutionToolContext,
	type SearchCapabilities,
	type SearchExecutionContext,
	type SearchHit,
	type SearchPage,
	type SearchProvider,
	SearchProviderError,
	type SearchRequest,
	scoreSearchPath,
} from "@earendil-works/pi-agent-core";
import { type Result as FffResult, FileFinder, type MixedSearchResult, type WatchUnsubscribe } from "@ff-labs/fff-node";
import { minimatch } from "minimatch";
import { LocalSearchProviderV2 } from "./local-search-provider-v2.ts";

const MAX_FFF_RESULTS = 10_000;
const MAX_FINDERS = 4;
const MAX_SNAPSHOTS = 200;

type FinderHandle = {
	finder: FileFinder;
	unsubscribe?: WatchUnsubscribe;
	generation: number;
	scanComplete: boolean;
};

type Snapshot = {
	hits: SearchHit[];
	complete: boolean;
	approximate: boolean;
	partial: boolean;
	generation: string;
};

function unwrap<T>(result: FffResult<T>, operation: string): T {
	if (!result.ok) throw new SearchProviderError("unavailable", `FFF ${operation} failed: ${result.error}`);
	return result.value;
}

/** Opt-in FFF fuzzy-file route with direct rg/fd fallback for unsupported or unavailable requests. */
export class FffSearchProvider implements SearchProvider {
	readonly id = "fff-local";
	readonly capabilities: SearchCapabilities;
	private readonly fallback: LocalSearchProviderV2;
	private readonly finders = new Map<string, Promise<FinderHandle | undefined>>();
	private readonly snapshots = new Map<string, Snapshot>();
	private sequence = 0;

	constructor(env: ExecutionToolContext["env"]) {
		this.fallback = new LocalSearchProviderV2(env);
		this.capabilities = this.fallback.capabilities;
	}

	async search(request: SearchRequest, context: SearchExecutionContext, signal?: AbortSignal): Promise<SearchPage> {
		if (request.cursor?.startsWith("fff:")) {
			return this.continueSnapshot(request.cursor.slice(4), request.expectedGeneration, request.limit);
		}
		if (request.cursor?.startsWith("local:")) {
			return this.wrapFallback(
				await this.fallback.search({ ...request, cursor: request.cursor.slice(6) }, context, signal),
			);
		}
		if (request.kind !== "files" || request.ranking !== "fast" || request.case === "sensitive" || signal?.aborted) {
			return this.wrapFallback(await this.fallback.search(request, context, signal));
		}

		const handle = await this.getFinder(request.path);
		if (!handle || signal?.aborted) return this.wrapFallback(await this.fallback.search(request, context, signal));
		const pageSize = Math.min(MAX_FFF_RESULTS, Math.max(request.limit * 50, 1000));
		let result: MixedSearchResult;
		try {
			result = unwrap(handle.finder.mixedSearch(request.query, { pageSize }), "mixedSearch");
		} catch {
			return this.wrapFallback(await this.fallback.search(request, context, signal));
		}
		const hits = result.items.flatMap((entry, index): SearchHit[] => {
			const item = entry.item;
			const path = item.relativePath.replaceAll("\\", "/").replace(/\/$/, "");
			if (request.fileGlob && !minimatch(path, request.fileGlob, { dot: true })) return [];
			const score = -result.scores[index].total;
			return [
				{
					kind: "file",
					path,
					pathKind: entry.type,
					score,
					exact: scoreSearchPath(path, request.query, request.case) === 0,
				},
			];
		});
		const complete = handle.scanComplete && result.totalMatched <= result.items.length;
		const partial = !complete || hits.length < Math.min(request.limit, result.totalMatched);
		return this.createPage(
			hits,
			request.limit,
			complete,
			!complete,
			partial,
			`fff-${handle.generation}-${this.sequence++}`,
		);
	}

	private async getFinder(basePath: string): Promise<FinderHandle | undefined> {
		let pending = this.finders.get(basePath);
		if (!pending) {
			pending = this.createFinder(basePath);
			this.finders.set(basePath, pending);
			while (this.finders.size > MAX_FINDERS) {
				const oldest = this.finders.keys().next().value;
				if (oldest === undefined || oldest === basePath) break;
				const oldFinder = this.finders.get(oldest);
				this.finders.delete(oldest);
				void oldFinder?.then((handle) => this.destroyFinder(handle));
			}
		}
		return pending;
	}

	private async createFinder(basePath: string): Promise<FinderHandle | undefined> {
		try {
			if (!(await stat(basePath)).isDirectory() || !FileFinder.isAvailable()) return undefined;
			const created = FileFinder.create({
				basePath,
				aiMode: true,
				disableContentIndexing: true,
				disableMmapCache: true,
			});
			if (!created.ok) return undefined;
			const finder = created.value;
			const waited = await finder.waitForScan(5000);
			const handle: FinderHandle = { finder, generation: 0, scanComplete: waited.ok && waited.value };
			const watched = finder.watch((events) => {
				handle.generation++;
				if (events.some((event) => event.kind === "rescan")) handle.scanComplete = false;
			});
			if (watched.ok) handle.unsubscribe = watched.value;
			return handle;
		} catch {
			return undefined;
		}
	}

	private wrapFallback(page: SearchPage): SearchPage {
		return { ...page, nextCursor: page.nextCursor ? `local:${page.nextCursor}` : undefined };
	}

	private createPage(
		hits: SearchHit[],
		limit: number,
		complete: boolean,
		approximate: boolean,
		partial: boolean,
		generation: string,
	): SearchPage {
		const page = hits.slice(0, limit);
		const remaining = hits.slice(limit);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			const cursor = `fff-cursor-${this.sequence++}`;
			nextCursor = `fff:${cursor}`;
			this.snapshots.set(cursor, { hits: remaining, complete, approximate, partial, generation });
			while (this.snapshots.size > MAX_SNAPSHOTS) {
				const oldest = this.snapshots.keys().next().value;
				if (oldest === undefined) break;
				this.snapshots.delete(oldest);
			}
		}
		return { hits: page, nextCursor, complete, approximate, partial, generation };
	}

	private continueSnapshot(
		cursor: string,
		expectedGeneration: string | number | undefined,
		limit: number,
	): SearchPage {
		const snapshot = this.snapshots.get(cursor);
		if (!snapshot || snapshot.generation !== expectedGeneration) {
			throw new SearchProviderError("stale_cursor", "The FFF search snapshot is no longer available.");
		}
		return this.createPage(
			snapshot.hits,
			limit,
			snapshot.complete,
			snapshot.approximate,
			snapshot.partial,
			snapshot.generation,
		);
	}

	private destroyFinder(handle: FinderHandle | undefined): void {
		if (!handle) return;
		handle.unsubscribe?.();
		if (!handle.finder.isDestroyed) handle.finder.destroy();
	}

	async close(): Promise<void> {
		const finders = [...this.finders.values()];
		this.finders.clear();
		for (const finder of finders) this.destroyFinder(await finder);
		this.snapshots.clear();
		await this.fallback.close();
	}
}
