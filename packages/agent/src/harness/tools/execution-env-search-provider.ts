import type { ExecutionEnv } from "../types.ts";
import {
	compareSearchPaths,
	type SearchCapabilities,
	type SearchExecutionContext,
	type SearchHit,
	type SearchPage,
	type SearchProvider,
	SearchProviderError,
	type SearchRequest,
	scoreSearchPath,
} from "./search-provider.ts";

const MAX_SCANNED_ENTRIES = 50_000;
const MAX_BUFFERED_HITS = 10_000;
const MAX_SNAPSHOTS = 200;

type Snapshot = {
	hits: SearchHit[];
	complete: boolean;
	approximate: boolean;
	partial: boolean;
	generation: string;
	matchedCount?: number;
	matchedCountRelation?: "exact" | "at_least" | "unknown";
	truncatedBy?: SearchPage["truncatedBy"];
	skipped?: SearchPage["skipped"];
};

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/$/, "");
}

function relativePath(path: string, root: string): string {
	const normalizedPath = normalizePath(path);
	const normalizedRoot = normalizePath(root);
	if (normalizedPath === normalizedRoot) return normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
	const prefix = `${normalizedRoot}/`;
	return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

function globRegex(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				index++;
				if (pattern[index + 1] === "/") {
					index++;
					source += "(?:.*/)?";
				} else source += ".*";
			} else source += "[^/]*";
		} else if (character === "?") source += "[^/]";
		else source += /[\\^$+?.()|{}[\]]/.test(character) ? `\\${character}` : character;
	}
	return new RegExp(`${source}$`);
}

function matchesGlob(path: string, pattern: string): boolean {
	const candidate = pattern.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1);
	return globRegex(pattern).test(candidate);
}

function matchesRequestPath(path: string, request: SearchRequest): boolean {
	if (!request.includeHidden && path.split("/").some((part) => part.startsWith("."))) return false;
	if (request.fileGlob !== undefined && !matchesGlob(path, request.fileGlob)) return false;
	if (request.include && request.include.length > 0 && !request.include.some((glob) => matchesGlob(path, glob))) {
		return false;
	}
	return !request.exclude?.some((glob) => matchesGlob(path, glob));
}

/** Capability-accurate fallback for ExecutionEnv backends without local rg/fd processes. */
export class ExecutionEnvSearchProvider implements SearchProvider {
	readonly id = "execution-env";
	readonly capabilities: SearchCapabilities = {
		textLiteral: false,
		textRegex: false,
		context: false,
		fuzzyFiles: true,
		glob: true,
		stableCursor: true,
		globalRanking: true,
		scopeFilters: true,
		wordBoundary: false,
	};
	private readonly env: ExecutionEnv;
	private readonly snapshots = new Map<string, Snapshot>();
	private sequence = 0;

	constructor(env: ExecutionEnv) {
		this.env = env;
	}

	async search(request: SearchRequest, _context: SearchExecutionContext, signal?: AbortSignal): Promise<SearchPage> {
		if (request.kind === "text") {
			throw new SearchProviderError("unsupported", "This filesystem provider does not support text search.");
		}
		if (request.cursor) return this.continueSnapshot(request.cursor, request.expectedGeneration, request.limit);

		const rootInfo = await this.env.fileInfo(request.path, signal);
		if (!rootInfo.ok) throw new SearchProviderError("unavailable", rootInfo.error.message);
		const candidates: Array<{ path: string; kind: "file" | "directory" }> = [];
		let scanned = 0;
		let partial = false;
		const visit = async (directory: string): Promise<void> => {
			if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
			const listed = await this.env.listDir(directory, signal);
			if (!listed.ok) throw new SearchProviderError("unavailable", listed.error.message);
			for (const entry of listed.value) {
				scanned++;
				if (scanned > MAX_SCANNED_ENTRIES) {
					partial = true;
					return;
				}
				if (entry.kind === "file" || entry.kind === "directory") {
					candidates.push({ path: relativePath(entry.path, request.path), kind: entry.kind });
				}
				if (entry.kind === "directory") {
					await visit(entry.path);
					if (partial) return;
				}
			}
		};

		if (rootInfo.value.kind === "directory") await visit(request.path);
		else if (rootInfo.value.kind === "file") {
			candidates.push({ path: rootInfo.value.name, kind: "file" });
		} else throw new SearchProviderError("unsupported", "Search scope must be a regular file or directory.");

		let hits: SearchHit[];
		if (request.kind === "glob") {
			const matcher = globRegex(request.query);
			hits = candidates
				.filter((candidate) => matcher.test(candidate.path) && matchesRequestPath(candidate.path, request))
				.map((candidate) => ({ kind: "file", path: candidate.path, pathKind: candidate.kind }));
			hits.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		} else {
			hits = candidates.flatMap((candidate): SearchHit[] => {
				if (!matchesRequestPath(candidate.path, request)) return [];
				const score = scoreSearchPath(candidate.path, request.query, request.case);
				return score === undefined
					? []
					: [
							{
								kind: "file",
								path: candidate.path,
								pathKind: candidate.kind,
								score,
								exact: score === 0,
							},
						];
			});
			hits.sort(compareSearchPaths);
		}
		if (hits.length > MAX_BUFFERED_HITS) {
			hits = hits.slice(0, MAX_BUFFERED_HITS);
			partial = true;
		}
		const matchedCount = hits.length;
		let truncatedBy: SearchPage["truncatedBy"];
		if (request.maxFiles !== undefined && hits.length > request.maxFiles) {
			hits = hits.slice(0, request.maxFiles);
			truncatedBy = "max_files";
		}
		const skipped: Array<{ reason: string }> = [];
		if (request.honorIgnore) skipped.push({ reason: "IGNORE_RULES_UNAVAILABLE" });
		if (request.followSymlinks) skipped.push({ reason: "SYMLINK_FOLLOW_UNAVAILABLE" });
		if (skipped.length > 0) partial = true;
		const approximate = request.kind === "files" && request.ranking === "fast" && partial;
		return this.createPage(hits, request.limit, !partial, approximate, partial, undefined, {
			matchedCount,
			matchedCountRelation: partial ? "unknown" : "exact",
			truncatedBy,
			skipped: skipped.length > 0 ? skipped : undefined,
		});
	}

	private createPage(
		hits: SearchHit[],
		limit: number,
		complete: boolean,
		approximate: boolean,
		partial: boolean,
		generation = `env-${this.sequence++}`,
		coverage: Pick<SearchPage, "matchedCount" | "matchedCountRelation" | "truncatedBy" | "skipped"> = {},
	): SearchPage {
		const page = hits.slice(0, limit);
		const remaining = hits.slice(limit);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `env-cursor-${this.sequence++}`;
			this.snapshots.set(nextCursor, { hits: remaining, complete, approximate, partial, generation, ...coverage });
			while (this.snapshots.size > MAX_SNAPSHOTS) {
				const oldest = this.snapshots.keys().next().value;
				if (oldest === undefined) break;
				this.snapshots.delete(oldest);
			}
		}
		return {
			hits: page,
			nextCursor,
			complete,
			approximate,
			partial,
			generation,
			...coverage,
			truncatedBy: coverage.truncatedBy ?? (remaining.length > 0 ? "max_results_global" : undefined),
		};
	}

	private continueSnapshot(
		cursor: string,
		expectedGeneration: string | number | undefined,
		limit: number,
	): SearchPage {
		const snapshot = this.snapshots.get(cursor);
		if (!snapshot || snapshot.generation !== expectedGeneration) {
			throw new SearchProviderError("stale_cursor", "The filesystem search snapshot is no longer available.");
		}
		return this.createPage(
			snapshot.hits,
			limit,
			snapshot.complete,
			snapshot.approximate,
			snapshot.partial,
			snapshot.generation,
			{
				matchedCount: snapshot.matchedCount,
				matchedCountRelation: snapshot.matchedCountRelation,
				truncatedBy: snapshot.truncatedBy,
				skipped: snapshot.skipped,
			},
		);
	}

	async close(): Promise<void> {
		this.snapshots.clear();
	}
}
