import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import {
	type SearchCapabilities,
	type SearchHit,
	type SearchPage,
	SearchProviderError,
	type SearchRequest,
} from "./search-provider.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
import { V2ToolError } from "./v2-errors.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 1000;
const MAX_CONTEXT_LINES = 20;
const CURSOR_TTL_MS = 10 * 60 * 1000;
const MAX_CURSORS = 200;

const searchV2Schema = Type.Object({
	query: Type.String({ description: "Text, file name, or glob to search for" }),
	kind: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("files"), Type.Literal("glob")])),
	path: Type.Optional(Type.String({ description: "File or directory scope" })),
	fileGlob: Type.Optional(Type.String({ description: "Optional candidate file filter for text/files" })),
	case: Type.Optional(Type.Union([Type.Literal("smart"), Type.Literal("sensitive"), Type.Literal("insensitive")])),
	regex: Type.Optional(Type.Boolean({ description: "Treat a text query as regex (default: false)" })),
	context: Type.Optional(Type.Number({ description: "Context lines around text matches (default: 0)" })),
	limit: Type.Optional(Type.Number({ description: `Maximum results (default: ${DEFAULT_SEARCH_LIMIT})` })),
	cursor: Type.Optional(Type.String({ description: "Opaque continuation returned by the same search" })),
	ranking: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("global")])),
});

export type SearchV2Input = Static<typeof searchV2Schema>;

export interface SearchV2Details {
	kind: "text" | "files" | "glob";
	query: string;
	path: string;
	hits: SearchHit[];
	returnedCount: number;
	complete: boolean;
	approximate: boolean;
	partial: boolean;
	nextCursor?: string;
	generation?: string | number;
}

type ValidatedInput = {
	query: string;
	kind: "text" | "files" | "glob";
	path?: string;
	fileGlob?: string;
	case: "smart" | "sensitive" | "insensitive";
	regex: boolean;
	context: number;
	limit: number;
	cursor?: string;
	ranking: "fast" | "global";
};

type CursorRecord = {
	signature: string;
	scopeId: string;
	providerId: string;
	providerCursor: string;
	generation?: string | number;
	expiresAt: number;
};

function validateInput(input: SearchV2Input): ValidatedInput {
	if (input.query.trim().length === 0) {
		throw new V2ToolError("INVALID_INPUT", "query must not be empty.");
	}
	const kind = input.kind ?? "text";
	const regex = input.regex ?? false;
	const context = input.context ?? 0;
	const ranking = input.ranking ?? "fast";
	if (kind !== "text" && regex) throw new V2ToolError("INVALID_INPUT", 'regex is only valid for kind="text".');
	if (kind !== "text" && context !== 0)
		throw new V2ToolError("INVALID_INPUT", 'context is only valid for kind="text".');
	if (kind === "glob" && input.fileGlob !== undefined)
		throw new V2ToolError("INVALID_INPUT", 'fileGlob is invalid for kind="glob"; use query as the glob.');
	if (kind !== "files" && input.ranking !== undefined)
		throw new V2ToolError("INVALID_INPUT", 'ranking is only valid for kind="files".');
	if (!Number.isSafeInteger(context) || context < 0 || context > MAX_CONTEXT_LINES) {
		throw new V2ToolError("INVALID_INPUT", `context must be an integer between 0 and ${MAX_CONTEXT_LINES}.`);
	}
	if (
		input.limit !== undefined &&
		(!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > MAX_SEARCH_LIMIT)
	) {
		throw new V2ToolError("INVALID_INPUT", `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`);
	}
	return {
		query: input.query,
		kind,
		path: input.path,
		fileGlob: input.fileGlob,
		case: input.case ?? "smart",
		regex,
		context,
		limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
		cursor: input.cursor,
		ranking,
	};
}

function requireCapabilities(request: SearchRequest, capabilities: SearchCapabilities): void {
	let missing: string | undefined;
	if (request.kind === "text" && request.regex && !capabilities.textRegex) missing = "regex text search";
	else if (request.kind === "text" && !request.regex && !capabilities.textLiteral) missing = "literal text search";
	else if (request.kind === "text" && request.context > 0 && !capabilities.context) missing = "text context";
	else if (request.kind === "files" && !capabilities.fuzzyFiles) missing = "fuzzy file search";
	else if (request.kind === "files" && request.ranking === "global" && !capabilities.globalRanking)
		missing = "global file ranking";
	else if (request.kind === "glob" && !capabilities.glob) missing = "glob search";
	if (request.cursor && !capabilities.stableCursor) missing = "stable continuation";
	if (missing) {
		throw new V2ToolError(
			"SEARCH_CAPABILITY_UNSUPPORTED",
			`The configured search provider does not support ${missing}. Change the request or configure a capable provider.`,
		);
	}
}

function requestSignature(request: SearchRequest): string {
	return JSON.stringify({
		query: request.query,
		kind: request.kind,
		path: request.path,
		fileGlob: request.fileGlob,
		case: request.case,
		regex: request.regex,
		context: request.context,
		limit: request.limit,
		ranking: request.ranking,
	});
}

function formatHit(hit: SearchHit): string {
	if (hit.kind === "file") return hit.path;
	const before = hit.before?.map((line) => `${hit.path}-${line.line}- ${line.text}`) ?? [];
	const match = `${hit.path}:${hit.line}:${hit.column}: ${hit.text}`;
	const after = hit.after?.map((line) => `${hit.path}-${line.line}- ${line.text}`) ?? [];
	return [...before, match, ...after].join("\n");
}

function formatPage(page: SearchPage, nextCursor: string | undefined): string {
	let text = page.hits.length > 0 ? page.hits.map(formatHit).join("\n") : "No matches found.";
	const notices: string[] = [];
	if (page.approximate) notices.push("Approximate ranking; results are not a strict global top N");
	if (page.partial) notices.push("Partial results; narrow path or fileGlob to improve coverage");
	if (nextCursor) notices.push(`More results. Continue with cursor=${nextCursor}`);
	if (notices.length > 0) text += `\n\n[${notices.join(". ")}.]`;
	return text;
}

export function createSearchV2Tool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof searchV2Schema,
	SearchV2Details
> {
	const cursors = new Map<string, CursorRecord>();
	let cursorSequence = 0;

	const pruneCursors = (): void => {
		const now = Date.now();
		for (const [token, record] of cursors) {
			if (record.expiresAt <= now) cursors.delete(token);
		}
		while (cursors.size >= MAX_CURSORS) {
			const oldest = cursors.keys().next().value;
			if (oldest === undefined) break;
			cursors.delete(oldest);
		}
	};

	return {
		name: "search",
		label: "search",
		description:
			'Search workspace text, fuzzy file paths, or deterministic globs. Text is literal by default; use kind="glob" for path enumeration.',
		parameters: searchV2Schema,
		executionMode: "parallel",
		replay: "safe",
		async execute(_toolCallId, rawInput, signal, _onUpdate, context) {
			const input = validateInput(rawInput);
			const provider = context.searchProvider;
			if (!provider) {
				throw new V2ToolError("SEARCH_PROVIDER_FAILED", "No search provider is configured for this v2 profile.");
			}
			const scope = await resolveWorkspacePath(
				context.env,
				input.path ?? ".",
				"read",
				context.workspacePolicy,
				signal,
			);
			const scopeId = context.search?.scopeId ?? scope.absolutePath;
			const request: SearchRequest = {
				query: input.query,
				kind: input.kind,
				path: scope.absolutePath,
				fileGlob: input.fileGlob,
				case: input.case,
				regex: input.regex,
				context: input.context,
				limit: input.limit,
				ranking: input.ranking,
			};
			const signature = requestSignature(request);
			if (input.cursor) {
				pruneCursors();
				const record = cursors.get(input.cursor);
				if (
					!record ||
					record.signature !== signature ||
					record.scopeId !== scopeId ||
					record.providerId !== provider.id
				) {
					throw new V2ToolError(
						"STALE_CURSOR",
						"The search cursor expired or belongs to a different request. Repeat the same search without cursor.",
					);
				}
				request.cursor = record.providerCursor;
				request.expectedGeneration = record.generation;
			}
			requireCapabilities(request, provider.capabilities);
			let page: SearchPage;
			try {
				page = await provider.search(request, { workspaceRoot: context.env.cwd, scopeId }, signal);
			} catch (error) {
				if (signal?.aborted) throw new V2ToolError("ABORTED", "Search was aborted.");
				if (error instanceof SearchProviderError && error.code === "invalid_regex")
					throw new V2ToolError("INVALID_REGEX", error.message);
				if (error instanceof SearchProviderError && error.code === "stale_cursor")
					throw new V2ToolError("STALE_CURSOR", `${error.message} Repeat the same search without cursor.`);
				if (error instanceof SearchProviderError && error.code === "unsupported")
					throw new V2ToolError("SEARCH_CAPABILITY_UNSUPPORTED", error.message);
				throw new V2ToolError(
					"SEARCH_PROVIDER_FAILED",
					`Search failed. Refine the scope or retry. ${error instanceof Error ? error.message : String(error)}`,
					undefined,
					error instanceof Error ? error : undefined,
				);
			}
			if (page.hits.length > input.limit) {
				throw new V2ToolError(
					"SEARCH_PROVIDER_FAILED",
					"Search provider returned more hits than the requested limit.",
				);
			}
			let nextCursor: string | undefined;
			if (page.nextCursor) {
				pruneCursors();
				nextCursor = `s2-${Date.now().toString(36)}-${(cursorSequence++).toString(36)}`;
				cursors.set(nextCursor, {
					signature,
					scopeId,
					providerId: provider.id,
					providerCursor: page.nextCursor,
					generation: page.generation,
					expiresAt: Date.now() + CURSOR_TTL_MS,
				});
			}
			return {
				content: [{ type: "text", text: formatPage(page, nextCursor) }],
				details: {
					kind: input.kind,
					query: input.query,
					path: scope.absolutePath,
					hits: page.hits,
					returnedCount: page.hits.length,
					complete: page.complete,
					approximate: page.approximate,
					partial: page.partial,
					nextCursor,
					generation: page.generation,
				},
			};
		},
	};
}
