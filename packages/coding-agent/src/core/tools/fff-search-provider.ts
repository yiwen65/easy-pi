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
} from "@earendil-works/pi-agent-core";
import {
	type Result as FffResult,
	FileFinder,
	type GrepCursor,
	type GrepMatch,
	type MixedSearchResult,
	type SearchResult,
	type WatchUnsubscribe,
} from "@ff-labs/fff-node";
import { LocalSearchProviderV2 } from "./local-search-provider-v2.ts";

const MAX_FINDERS = 4;
const MAX_CURSORS = 200;

type FinderHandle = {
	finder: FileFinder;
	unsubscribe?: WatchUnsubscribe;
	generation: number;
	scanComplete: boolean;
};

type NativeCursor =
	| {
			kind: "files" | "glob";
			basePath: string;
			generation: string;
			pageIndex: number;
	  }
	| {
			kind: "text";
			basePath: string;
			generation: string;
			cursor: GrepCursor;
	  };

function unwrap<T>(result: FffResult<T>, operation: string): T {
	if (!result.ok) throw new SearchProviderError("unavailable", `FFF ${operation} failed: ${result.error}`);
	return result.value;
}

function byteIndexToStringIndex(value: string, byteIndex: number): number {
	return Buffer.from(value).subarray(0, byteIndex).toString("utf8").length;
}

function generation(handle: FinderHandle): string {
	return `fff-${handle.generation}`;
}

function hasUnlocatedTextHit(page: SearchPage): boolean {
	return page.hits.some(
		(hit) => hit.kind === "text" && (hit.byteOffset === undefined || !hit.ranges || hit.ranges.length === 0),
	);
}

/** FFF-first local Search provider with a direct rg/fd fallback for unsupported or unavailable requests. */
export class FffSearchProvider implements SearchProvider {
	readonly id = "fff-local";
	readonly capabilities: SearchCapabilities;
	private readonly fallback: LocalSearchProviderV2;
	private readonly initialScanTimeoutMs: number;
	private readonly finders = new Map<string, Promise<FinderHandle | undefined>>();
	private readonly cursors = new Map<string, NativeCursor>();
	private sequence = 0;

	constructor(env: ExecutionToolContext["env"], options: { initialScanTimeoutMs?: number } = {}) {
		this.fallback = new LocalSearchProviderV2(env);
		this.capabilities = this.fallback.capabilities;
		this.initialScanTimeoutMs = options.initialScanTimeoutMs ?? 5000;
	}

	async search(request: SearchRequest, context: SearchExecutionContext, signal?: AbortSignal): Promise<SearchPage> {
		if (request.cursor?.startsWith("fff:")) {
			const page = await this.continueNative(request, request.cursor.slice(4), signal);
			if (hasUnlocatedTextHit(page)) {
				throw new SearchProviderError(
					"unavailable",
					"FFF omitted match coordinates on a truncated line; repeat with a narrower path.",
				);
			}
			return page;
		}
		if (request.cursor?.startsWith("local:")) {
			return this.wrapFallback(
				await this.fallback.search({ ...request, cursor: request.cursor.slice(6) }, context, signal),
			);
		}
		if (!this.supportsNativeRequest(request) || signal?.aborted) {
			return this.wrapFallback(await this.fallback.search(request, context, signal));
		}

		const handle = await this.getFinder(request.path);
		if (!handle || signal?.aborted) return this.wrapFallback(await this.fallback.search(request, context, signal));
		this.refreshScanState(handle);
		try {
			const page = this.searchNative(handle, request, signal);
			if (hasUnlocatedTextHit(page)) {
				return this.wrapFallback(await this.fallback.search(request, context, signal));
			}
			return page;
		} catch (error) {
			if (error instanceof SearchProviderError && error.code === "invalid_regex") throw error;
			return this.wrapFallback(await this.fallback.search(request, context, signal));
		}
	}

	private supportsNativeRequest(request: SearchRequest): boolean {
		// FFF cannot call host authorization while indexing; the local fallback preflights traversal.
		if (
			request.checkPath !== undefined ||
			request.fileGlob !== undefined ||
			request.include?.length ||
			request.exclude?.length ||
			request.case !== "smart" ||
			request.wordBoundary ||
			request.honorIgnore === false ||
			request.includeHidden ||
			request.followSymlinks
		) {
			return false;
		}
		return request.kind === "files" || request.kind === "text" || request.kind === "glob";
	}

	private searchNative(handle: FinderHandle, request: SearchRequest, signal?: AbortSignal): SearchPage {
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
		if (request.kind === "text") return this.searchText(handle, request, undefined, signal);
		if (request.kind === "glob") return this.searchGlob(handle, request, 0, signal);
		return this.searchFiles(handle, request, 0, signal);
	}

	private searchFiles(
		handle: FinderHandle,
		request: SearchRequest,
		pageIndex: number,
		signal?: AbortSignal,
	): SearchPage {
		const result = unwrap(
			handle.finder.mixedSearch(request.query, { pageIndex, pageSize: request.limit }),
			"mixedSearch",
		);
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
		const hits = result.items.map(
			(entry, index): SearchHit => ({
				kind: "file",
				path: entry.item.relativePath.replaceAll("\\", "/").replace(/\/$/, ""),
				pathKind: entry.type,
				score: -result.scores[index].total,
				exact: result.scores[index].exactMatch,
			}),
		);
		return this.pageFromSearchResult(handle, request, hits, result, pageIndex, "files");
	}

	private searchGlob(
		handle: FinderHandle,
		request: SearchRequest,
		pageIndex: number,
		signal?: AbortSignal,
	): SearchPage {
		const result = unwrap(handle.finder.glob(request.query, { pageIndex, pageSize: request.limit }), "glob");
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
		const hits = result.items.map(
			(item): SearchHit => ({
				kind: "file",
				path: item.relativePath.replaceAll("\\", "/"),
				pathKind: "file",
				exact: true,
			}),
		);
		return this.pageFromSearchResult(handle, request, hits, result, pageIndex, "glob");
	}

	private pageFromSearchResult(
		handle: FinderHandle,
		request: SearchRequest,
		hits: SearchHit[],
		result: SearchResult | MixedSearchResult,
		pageIndex: number,
		kind: "files" | "glob",
	): SearchPage {
		let nextCursor: string | undefined;
		if (pageIndex + hits.length < result.totalMatched) {
			nextCursor = this.storeCursor({
				kind,
				basePath: request.path,
				generation: generation(handle),
				// FFF 0.10.5 documents this as a page index but advances it as a result offset.
				pageIndex: pageIndex + request.limit,
			});
		}
		return {
			hits,
			nextCursor,
			complete: handle.scanComplete,
			approximate: !handle.scanComplete,
			partial: !handle.scanComplete,
			generation: generation(handle),
			matchedCount: result.totalMatched,
			matchedCountRelation: handle.scanComplete ? "exact" : "at_least",
			truncatedBy: nextCursor ? "max_results_global" : undefined,
		};
	}

	private searchText(
		handle: FinderHandle,
		request: SearchRequest,
		cursor: GrepCursor | undefined,
		signal?: AbortSignal,
	): SearchPage {
		const result = unwrap(
			handle.finder.grep(request.query, {
				mode: request.regex ? "regex" : "plain",
				smartCase: true,
				cursor,
				beforeContext: request.context,
				afterContext: request.context,
				pageSize: request.limit,
			}),
			"grep",
		);
		if (result.regexFallbackError) throw new SearchProviderError("invalid_regex", result.regexFallbackError);
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
		const hits = result.items.map((match) => this.textHit(match));
		let nextCursor: string | undefined;
		if (result.nextCursor) {
			nextCursor = this.storeCursor({
				kind: "text",
				basePath: request.path,
				generation: generation(handle),
				cursor: result.nextCursor,
			});
		}
		const skippedCount = Math.max(0, result.totalFiles - result.filteredFileCount);
		return {
			hits,
			nextCursor,
			complete: handle.scanComplete,
			approximate: !handle.scanComplete,
			partial: !handle.scanComplete || skippedCount > 0,
			generation: generation(handle),
			matchedCount: result.totalMatched,
			matchedCountRelation: result.nextCursor ? "at_least" : "exact",
			truncatedBy: nextCursor ? "max_results_global" : undefined,
			skipped: skippedCount > 0 ? [{ reason: "FFF_FILTERED_FILE", count: skippedCount }] : undefined,
		};
	}

	private textHit(match: GrepMatch): SearchHit {
		const text = match.lineContent.replace(/\r?\n$/, "").replace(/\r$/, "");
		const ranges = match.matchRanges.map(([start, end]): [number, number] => [
			byteIndexToStringIndex(text, start),
			byteIndexToStringIndex(text, end),
		]);
		const contextBefore = match.contextBefore ?? [];
		const contextAfter = match.contextAfter ?? [];
		return {
			kind: "text",
			path: match.relativePath.replaceAll("\\", "/"),
			line: match.lineNumber,
			column: (ranges[0]?.[0] ?? byteIndexToStringIndex(text, match.col)) + 1,
			text,
			ranges,
			byteOffset: match.byteOffset + match.col,
			before: contextBefore.map((line, index) => ({
				line: match.lineNumber - contextBefore.length + index,
				text: line,
			})),
			after: contextAfter.map((line, index) => ({ line: match.lineNumber + index + 1, text: line })),
		};
	}

	private async continueNative(request: SearchRequest, cursorId: string, signal?: AbortSignal): Promise<SearchPage> {
		const cursor = this.cursors.get(cursorId);
		if (!cursor || cursor.basePath !== request.path || cursor.kind !== request.kind) {
			throw new SearchProviderError("stale_cursor", "The FFF search cursor is no longer available.");
		}
		const handle = await this.getFinder(request.path);
		if (!handle) throw new SearchProviderError("stale_cursor", "The FFF search index is no longer available.");
		this.refreshScanState(handle);
		if (cursor.generation !== request.expectedGeneration || cursor.generation !== generation(handle)) {
			throw new SearchProviderError("stale_cursor", "The FFF search index changed after this cursor was created.");
		}
		this.cursors.delete(cursorId);
		if (cursor.kind === "text") return this.searchText(handle, request, cursor.cursor, signal);
		if (cursor.kind === "glob") return this.searchGlob(handle, request, cursor.pageIndex, signal);
		return this.searchFiles(handle, request, cursor.pageIndex, signal);
	}

	private storeCursor(cursor: NativeCursor): string {
		const id = `fff-cursor-${this.sequence++}`;
		this.cursors.set(id, cursor);
		while (this.cursors.size > MAX_CURSORS) {
			const oldest = this.cursors.keys().next().value;
			if (oldest === undefined) break;
			this.cursors.delete(oldest);
		}
		return `fff:${id}`;
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
			const created = FileFinder.create({ basePath, aiMode: true });
			if (!created.ok) return undefined;
			const finder = created.value;
			const waited = await finder.waitForScan(this.initialScanTimeoutMs);
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

	private refreshScanState(handle: FinderHandle): void {
		if (handle.scanComplete) return;
		const progress = handle.finder.getScanProgress();
		if (progress.ok && !progress.value.isScanning) {
			handle.scanComplete = true;
			handle.generation++;
		}
	}

	private wrapFallback(page: SearchPage): SearchPage {
		return { ...page, nextCursor: page.nextCursor ? `local:${page.nextCursor}` : undefined };
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
		this.cursors.clear();
		await this.fallback.close();
	}
}
