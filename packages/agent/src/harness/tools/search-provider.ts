export interface SearchRequest {
	query: string;
	kind: "text" | "files";
	path: string;
	glob?: string;
	regex: boolean;
	caseSensitive: boolean;
	hardLimit: number;
}

export type SearchCandidate =
	| { kind: "text"; path: string; line: number; text: string }
	| { kind: "file"; path: string };

export interface SearchProviderResult {
	candidates: SearchCandidate[];
	truncated: boolean;
}

/** Hidden search backend used by the model-visible v2 search tool. */
export interface SearchProvider {
	search(request: SearchRequest, signal?: AbortSignal): Promise<SearchProviderResult>;
	cleanup(): Promise<void>;
}
