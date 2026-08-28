import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import type { SearchCandidate, SearchProviderResult, SearchRequest } from "./search-provider.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
import { V2ToolError } from "./v2-errors.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 1000;

const searchV2Schema = Type.Object({
	query: Type.String({ description: "Literal text or path substring to search for" }),
	kind: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("files")])),
	path: Type.Optional(Type.String({ description: "File or directory scope" })),
	glob: Type.Optional(Type.String({ description: "Optional file glob filter" })),
	regex: Type.Optional(Type.Boolean({ description: "Treat text query as regex (default: false)" })),
	limit: Type.Optional(Type.Number({ description: `Maximum results (default: ${DEFAULT_SEARCH_LIMIT})` })),
});

export type SearchV2Input = Static<typeof searchV2Schema>;

export interface SearchV2Details {
	kind: "text" | "files";
	query: string;
	path: string;
	returnedCount: number;
	truncated: boolean;
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function fileRank(path: string, query: string, caseSensitive: boolean): number {
	const candidate = caseSensitive ? normalizePath(path) : normalizePath(path).toLowerCase();
	const needle = caseSensitive ? query : query.toLowerCase();
	const segments = candidate.split("/");
	const basename = segments.at(-1) ?? candidate;
	if (basename === needle) return 0;
	if (basename.startsWith(needle)) return 1;
	if (basename.includes(needle)) return 2;
	if (segments.some((segment) => segment.startsWith(needle))) return 3;
	return 4;
}

export function compareFileSearchCandidates(
	left: string,
	right: string,
	query: string,
	caseSensitive: boolean,
): number {
	const rankDifference = fileRank(left, query, caseSensitive) - fileRank(right, query, caseSensitive);
	return rankDifference || compareCodePoints(normalizePath(left), normalizePath(right));
}

function validateInput(
	input: SearchV2Input,
): Required<Pick<SearchV2Input, "query" | "kind" | "regex" | "limit">> & Pick<SearchV2Input, "path" | "glob"> {
	if (input.query.trim().length === 0) {
		throw new V2ToolError("INVALID_INPUT", "query must not be empty. Provide literal text or a path substring.");
	}
	const kind = input.kind ?? "text";
	const regex = input.regex ?? false;
	if (kind === "files" && regex) {
		throw new V2ToolError("INVALID_INPUT", 'regex is only valid for kind="text".');
	}
	if (
		input.limit !== undefined &&
		(!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > MAX_SEARCH_LIMIT)
	) {
		throw new V2ToolError("INVALID_INPUT", `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`);
	}
	if (regex) {
		try {
			new RegExp(input.query);
		} catch (error) {
			throw new V2ToolError(
				"INVALID_REGEX",
				`The regex is invalid. Fix it or omit regex to search literally. ${error instanceof Error ? error.message : ""}`.trim(),
			);
		}
	}
	return { ...input, query: input.query, kind, regex, limit: input.limit ?? DEFAULT_SEARCH_LIMIT };
}

function sortCandidates(candidates: SearchCandidate[], request: SearchRequest): SearchCandidate[] {
	if (request.kind === "files") {
		return candidates
			.filter((candidate): candidate is Extract<SearchCandidate, { kind: "file" }> => candidate.kind === "file")
			.sort((left, right) =>
				compareFileSearchCandidates(left.path, right.path, request.query, request.caseSensitive),
			);
	}
	return candidates
		.filter((candidate): candidate is Extract<SearchCandidate, { kind: "text" }> => candidate.kind === "text")
		.sort(
			(left, right) =>
				compareCodePoints(normalizePath(left.path), normalizePath(right.path)) || left.line - right.line,
		);
}

export function createSearchV2Tool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof searchV2Schema,
	SearchV2Details
> {
	return {
		name: "search",
		label: "search",
		description:
			'Search workspace text or file paths. Text search is literal by default; use kind="files" for path substrings and regex=true only when regex is required.',
		parameters: searchV2Schema,
		executionMode: "parallel",
		replay: "safe",
		async execute(_toolCallId, rawInput, signal, _onUpdate, context) {
			const input = validateInput(rawInput);
			if (!context.searchProvider) {
				throw new V2ToolError("SEARCH_PROVIDER_FAILED", "No search provider is configured for this v2 profile.");
			}
			const scope = await resolveWorkspacePath(
				context.env,
				input.path ?? ".",
				"read",
				context.workspacePolicy,
				signal,
			);
			const request: SearchRequest = {
				query: input.query,
				kind: input.kind,
				path: scope.absolutePath,
				glob: input.glob,
				regex: input.regex,
				caseSensitive: /[A-Z]/.test(input.query),
				hardLimit: input.limit,
			};
			let providerResult: SearchProviderResult;
			try {
				providerResult = await context.searchProvider.search(request, signal);
			} catch (error) {
				if (signal?.aborted) throw new V2ToolError("ABORTED", "Search was aborted.");
				throw new V2ToolError(
					"SEARCH_PROVIDER_FAILED",
					`Search failed. Refine the scope or retry. ${error instanceof Error ? error.message : String(error)}`,
					undefined,
					error instanceof Error ? error : undefined,
				);
			}
			const candidates = sortCandidates(providerResult.candidates, request).slice(0, input.limit);
			const truncated = providerResult.truncated || providerResult.candidates.length > candidates.length;
			const lines = candidates.map((candidate) =>
				candidate.kind === "text"
					? `${normalizePath(candidate.path)}:${candidate.line}: ${candidate.text}`
					: normalizePath(candidate.path),
			);
			let text = lines.length > 0 ? lines.join("\n") : "No matches found.";
			if (truncated) text += "\n\n[Results are bounded, not a global top N. Narrow query, path, or glob.]";
			return {
				content: [{ type: "text", text }],
				details: {
					kind: input.kind,
					query: input.query,
					path: scope.absolutePath,
					returnedCount: candidates.length,
					truncated,
				},
			};
		},
	};
}
