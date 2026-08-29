export type SearchKind = "text" | "files" | "glob";
export type SearchCaseMode = "smart" | "sensitive" | "insensitive";
export type SearchRanking = "fast" | "global" | "task";
export type SearchQueryTemplate = "definition" | "references" | "assignment" | "calls" | "concept";
export type SearchStructuredMode =
	| "symbol_definition"
	| "symbol_reference"
	| "implementation"
	| "assignment"
	| "call"
	| "string_literal"
	| "comment"
	| "semantic_candidate";
export type SearchQueryMode = "literal" | "regex" | SearchStructuredMode;
export type SearchMatchedCountRelation = "exact" | "at_least" | "unknown";
export type SearchTruncationReason =
	| "max_results_global"
	| "max_results_per_file"
	| "max_files"
	| "max_output_bytes"
	| "provider_limit";

export interface SearchCapabilities {
	textLiteral: boolean;
	textRegex: boolean;
	context: boolean;
	fuzzyFiles: boolean;
	glob: boolean;
	stableCursor: boolean;
	globalRanking: boolean;
	taskRanking?: boolean;
	scopeFilters?: boolean;
	wordBoundary?: boolean;
	/** Structured modes verified by this provider. Omitted means text/path search only. */
	structuredModes?: SearchStructuredMode[];
}

export interface SearchRequest {
	query: string;
	kind: SearchKind;
	path: string;
	fileGlob?: string;
	case: SearchCaseMode;
	regex: boolean;
	mode?: SearchQueryMode;
	targetKind?: string;
	context: number;
	limit: number;
	ranking: SearchRanking;
	queryTemplate?: SearchQueryTemplate;
	preferredPaths?: string[];
	wordBoundary?: boolean;
	include?: string[];
	exclude?: string[];
	honorIgnore?: boolean;
	includeHidden?: boolean;
	followSymlinks?: boolean;
	maxResultsPerFile?: number;
	maxFiles?: number;
	/** Provider-private continuation restored from the public opaque cursor. */
	cursor?: string;
	/** Generation captured with the provider-private continuation. */
	expectedGeneration?: string | number;
}

function normalizeSearchPath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function scoreSearchPath(path: string, query: string, caseMode: SearchCaseMode): number | undefined {
	const sensitive = caseMode === "sensitive" || (caseMode === "smart" && /[A-Z]/.test(query));
	const candidate = sensitive ? normalizeSearchPath(path) : normalizeSearchPath(path).toLowerCase();
	const needle = sensitive ? query : query.toLowerCase();
	const basename = candidate.slice(candidate.lastIndexOf("/") + 1);
	if (basename === needle) return 0;
	if (basename.startsWith(needle)) return 10 + basename.length - needle.length;
	const basenameIndex = basename.indexOf(needle);
	if (basenameIndex >= 0) return 20 + basenameIndex;
	const pathIndex = candidate.indexOf(needle);
	if (pathIndex >= 0) return 40 + pathIndex;
	let cursor = 0;
	let gap = 0;
	for (const character of needle) {
		const index = candidate.indexOf(character, cursor);
		if (index < 0) return undefined;
		gap += index - cursor;
		cursor = index + 1;
	}
	return 100 + gap + candidate.length - needle.length;
}

export function compareSearchPaths(
	left: { path: string; score?: number },
	right: { path: string; score?: number },
): number {
	const scoreDifference = (left.score ?? Number.MAX_SAFE_INTEGER) - (right.score ?? Number.MAX_SAFE_INTEGER);
	if (scoreDifference !== 0) return scoreDifference;
	const leftPath = normalizeSearchPath(left.path);
	const rightPath = normalizeSearchPath(right.path);
	return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

export interface SearchContextLine {
	line: number;
	text: string;
}

export type SearchHit =
	| {
			kind: "text";
			path: string;
			line: number;
			column: number;
			text: string;
			ranges: Array<[number, number]>;
			/** Absolute byte offset of the first match when the provider exposes it. */
			byteOffset?: number;
			endLine?: number;
			endColumn?: number;
			matchKind?: string;
			enclosingSymbol?: string;
			nodeKind?: string;
			nodeId?: string;
			fileClass?: string;
			score?: number;
			rankReasons?: string[];
			before?: SearchContextLine[];
			after?: SearchContextLine[];
	  }
	| {
			kind: "file";
			path: string;
			pathKind?: "file" | "directory";
			score?: number;
			exact?: boolean;
	  };

export interface SearchSkipped {
	path?: string;
	reason: string;
	count?: number;
}

export interface SearchPage {
	hits: SearchHit[];
	nextCursor?: string;
	complete: boolean;
	approximate: boolean;
	partial: boolean;
	generation?: string | number;
	matchedCount?: number;
	matchedCountRelation?: SearchMatchedCountRelation;
	truncatedBy?: SearchTruncationReason;
	skipped?: SearchSkipped[];
}

export interface SearchExecutionContext {
	workspaceRoot: string;
	scopeId: string;
}

export type SearchProviderErrorCode =
	| "invalid_regex"
	| "stale_cursor"
	| "unsupported"
	| "budget_exceeded"
	| "unavailable";

export class SearchProviderError extends Error {
	readonly code: SearchProviderErrorCode;

	constructor(code: SearchProviderErrorCode, message: string) {
		super(message);
		this.name = "SearchProviderError";
		this.code = code;
	}
}

/** Hidden structured search backend used by the model-visible v2 search tool. */
export interface SearchProvider {
	readonly id: string;
	readonly capabilities: SearchCapabilities;
	search(request: SearchRequest, context: SearchExecutionContext, signal?: AbortSignal): Promise<SearchPage>;
	close(): Promise<void>;
}
