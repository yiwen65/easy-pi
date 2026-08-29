import { type Static, Type } from "typebox";
import type { AgentHarnessTool, FileInfo } from "../types.ts";
import {
	type SearchCapabilities,
	type SearchHit,
	type SearchMatchedCountRelation,
	type SearchPage,
	SearchProviderError,
	type SearchQueryMode,
	type SearchRequest,
	type SearchSkipped,
	type SearchStructuredMode,
	type SearchTruncationReason,
} from "./search-provider.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
import { fileVersion, resolveToolState } from "./tool-state.ts";
import { V2ToolError } from "./v2-errors.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RESULTS_PER_FILE = 3;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_SEARCH_LIMIT = 1000;
const MAX_CONTEXT_LINES = 20;
const MAX_SCOPE_GLOBS = 50;
const MIN_OUTPUT_BYTES = 128;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_MATCH_CHARS = 200;
const MAX_PREVIEW_CHARS = 320;
const CURSOR_TTL_MS = 10 * 60 * 1000;
const MAX_CURSORS = 200;
const textEncoder = new TextEncoder();

const structuredModes: SearchStructuredMode[] = [
	"symbol_definition",
	"symbol_reference",
	"implementation",
	"assignment",
	"call",
	"string_literal",
	"comment",
	"semantic_candidate",
] as const;
const structuredTargetKinds = [
	"definition",
	"reference",
	"implementation",
	"assignment",
	"call",
	"string_literal",
	"comment",
] as const;
const queryTemplateModes = {
	definition: "symbol_definition",
	references: "symbol_reference",
	assignment: "assignment",
	calls: "call",
	concept: "semantic_candidate",
} as const;
const structuredModeTargetKinds = {
	symbol_definition: "definition",
	symbol_reference: "reference",
	implementation: "implementation",
	assignment: "assignment",
	call: "call",
	string_literal: "string_literal",
	comment: "comment",
	semantic_candidate: undefined,
} as const;

const searchV2Schema = Type.Object({
	query: Type.String({ description: "Literal text, regex, file name, or glob to locate" }),
	kind: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("files"), Type.Literal("glob")])),
	mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("literal"),
				Type.Literal("regex"),
				Type.Literal("symbol_definition"),
				Type.Literal("symbol_reference"),
				Type.Literal("implementation"),
				Type.Literal("assignment"),
				Type.Literal("call"),
				Type.Literal("string_literal"),
				Type.Literal("comment"),
				Type.Literal("semantic_candidate"),
			],
			{ description: "Select one query semantic; do not combine with queryTemplate" },
		),
	),
	targetKind: Type.Optional(
		Type.Union(
			[
				Type.Literal("exact_line"),
				Type.Literal("definition"),
				Type.Literal("reference"),
				Type.Literal("implementation"),
				Type.Literal("assignment"),
				Type.Literal("call"),
				Type.Literal("string_literal"),
				Type.Literal("comment"),
				Type.Literal("path"),
			],
			{
				description:
					"Optional verified result kind; omit for semantic candidates and pair exactly with a structured mode",
			},
		),
	),
	path: Type.Optional(Type.String({ description: "Narrowest justified file or directory root" })),
	fileGlob: Type.Optional(Type.String({ description: "Compatibility include glob for text/files" })),
	include: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_SCOPE_GLOBS })),
	exclude: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_SCOPE_GLOBS })),
	honorIgnore: Type.Optional(Type.Boolean({ description: "Honor repository ignore files (default: true)" })),
	includeHidden: Type.Optional(Type.Boolean({ description: "Include hidden paths (default: false)" })),
	followSymlinks: Type.Optional(Type.Boolean({ description: "Follow directory symlinks (default: false)" })),
	case: Type.Optional(Type.Union([Type.Literal("smart"), Type.Literal("sensitive"), Type.Literal("insensitive")])),
	regex: Type.Optional(Type.Boolean({ description: "Compatibility alias for mode=regex" })),
	wordBoundary: Type.Optional(Type.Boolean()),
	context: Type.Optional(
		Type.Number({ description: "Literal/regex candidate context lines; structured/semantic modes require 0" }),
	),
	limit: Type.Optional(Type.Number({ description: "Compatibility alias for maxResultsGlobal" })),
	maxResultsGlobal: Type.Optional(
		Type.Number({ description: `Global result budget (default: ${DEFAULT_SEARCH_LIMIT})` }),
	),
	maxResultsPerFile: Type.Optional(
		Type.Number({ description: `Per-file result budget (default: ${DEFAULT_RESULTS_PER_FILE})` }),
	),
	maxFiles: Type.Optional(Type.Number({ description: `Matched-file budget (default: ${DEFAULT_MAX_FILES})` })),
	maxOutputBytes: Type.Optional(
		Type.Number({ description: `Model-visible output budget (default: ${DEFAULT_MAX_OUTPUT_BYTES})` }),
	),
	cursor: Type.Optional(Type.String({ description: "Opaque continuation returned by the same search" })),
	ranking: Type.Optional(
		Type.Union([Type.Literal("fast"), Type.Literal("global"), Type.Literal("task")], {
			description: "Explicit ranking is valid only for file or structured search",
		}),
	),
	queryTemplate: Type.Optional(
		Type.Union(
			[
				Type.Literal("definition"),
				Type.Literal("references"),
				Type.Literal("assignment"),
				Type.Literal("calls"),
				Type.Literal("concept"),
			],
			{ description: "Shortcut for one structured mode; do not combine with mode" },
		),
	),
	preferredPaths: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
});

export type SearchV2Input = Static<typeof searchV2Schema>;
export type SearchV2Status = "complete" | "partial" | "overflow";

export interface SearchV2Locator {
	locatorId: string;
	path: string;
	startLine?: number;
	endLine?: number;
	startColumn?: number;
	endColumn?: number;
	byteOffset?: number;
	match?: string;
	matchKind: string;
	snapshotId: string;
	lineLengthBytes?: number;
	enclosingSymbol?: string;
	nodeKind?: string;
	nodeId?: string;
	fileClass?: string;
	score?: number;
	rankReasons?: string[];
	preview?: string;
	prefixOmitted?: boolean;
	suffixOmitted?: boolean;
}

export interface SearchV2Group {
	path: string;
	locatorIds: string[];
}

export interface SearchV2Coverage {
	returnedCount: number;
	matchedCount?: number;
	matchedCountRelation: SearchMatchedCountRelation;
	hasMore: boolean;
	truncated: boolean;
	truncatedBy?: SearchTruncationReason;
	skipped: SearchSkipped[];
}

export interface SearchV2Details {
	status: SearchV2Status;
	kind: "text" | "files" | "glob";
	mode: SearchQueryMode;
	targetKind?: string;
	queryTemplate?: "definition" | "references" | "assignment" | "calls" | "concept";
	query: string;
	path: string;
	hits: SearchHit[];
	locators: SearchV2Locator[];
	groups: SearchV2Group[];
	snapshotId: string;
	coverage: SearchV2Coverage;
	returnedCount: number;
	complete: boolean;
	approximate: boolean;
	partial: boolean;
	nextCursor?: string;
	generation?: string | number;
	effectiveScope: {
		root: string;
		include: string[];
		exclude: string[];
		honorIgnore: boolean;
		includeHidden: boolean;
		followSymlinks: boolean;
		preferredPaths: string[];
	};
}

type ValidatedInput = {
	query: string;
	kind: "text" | "files" | "glob";
	mode: SearchQueryMode;
	targetKind?: string;
	path?: string;
	fileGlob?: string;
	include: string[];
	exclude: string[];
	honorIgnore: boolean;
	includeHidden: boolean;
	followSymlinks: boolean;
	case: "smart" | "sensitive" | "insensitive";
	wordBoundary: boolean;
	context: number;
	limit: number;
	maxResultsPerFile: number;
	maxFiles: number;
	maxOutputBytes: number;
	cursor?: string;
	ranking: "fast" | "global" | "task";
	queryTemplate?: "definition" | "references" | "assignment" | "calls" | "concept";
	preferredPaths: string[];
};

type CursorRecord = {
	signature: string;
	scopeId: string;
	providerId: string;
	providerCursor: string;
	generation?: string | number;
	expiresAt: number;
};

function positiveInteger(value: number | undefined, name: string, maximum: number): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maximum)) {
		throw new V2ToolError("INVALID_INPUT", `${name} must be an integer between 1 and ${maximum}.`);
	}
}

function validateInput(input: SearchV2Input): ValidatedInput {
	if (input.query.trim().length === 0) throw new V2ToolError("INVALID_INPUT", "query must not be empty.");
	const kind = input.kind ?? "text";
	const templateMode = input.queryTemplate ? queryTemplateModes[input.queryTemplate] : undefined;
	if (input.mode && templateMode && input.mode !== templateMode) {
		throw new V2ToolError("INVALID_INPUT", "mode conflicts with queryTemplate.");
	}
	const requestedMode = input.mode ?? templateMode ?? (input.regex ? "regex" : "literal");
	if (input.regex !== undefined && (requestedMode === "regex") !== input.regex) {
		throw new V2ToolError("INVALID_INPUT", "mode, queryTemplate, and regex describe conflicting query semantics.");
	}
	const structured = (structuredModes as readonly string[]).includes(requestedMode);
	if (input.targetKind && (structuredTargetKinds as readonly string[]).includes(input.targetKind)) {
		if (!structured) {
			throw new V2ToolError(
				"SYMBOL_INDEX_UNAVAILABLE",
				`${input.targetKind} intent cannot be verified by a text/path provider. Use a structured mode or an explicitly anchored literal/regex fallback without targetKind.`,
				{ fallbackAllowed: true, recovery: { kind: "use_text_fallback" as const } },
			);
		}
		const expectedTargetKind = structuredModeTargetKinds[requestedMode as keyof typeof structuredModeTargetKinds];
		if (input.targetKind !== expectedTargetKind) {
			throw new V2ToolError("INVALID_INPUT", "targetKind conflicts with the structured search mode.");
		}
	}
	if (input.targetKind === "path" && kind === "text") {
		throw new V2ToolError("INVALID_INPUT", 'targetKind="path" requires kind="files" or kind="glob".');
	}
	const mode = requestedMode as SearchQueryMode;
	const context = input.context ?? 0;
	const ranking = input.ranking ?? (structured ? "task" : "fast");
	if (structured && kind !== "text")
		throw new V2ToolError("INVALID_INPUT", "Structured search modes require kind=text.");
	if (kind !== "text" && mode === "regex")
		throw new V2ToolError("INVALID_INPUT", 'mode="regex" is only valid for kind="text".');
	if (kind !== "text" && context !== 0)
		throw new V2ToolError("INVALID_INPUT", 'context is only valid for kind="text".');
	if (structured && context !== 0)
		throw new V2ToolError("INVALID_INPUT", "Structured search returns AST-backed locators and requires context=0.");
	if (kind === "glob" && input.fileGlob !== undefined)
		throw new V2ToolError("INVALID_INPUT", 'fileGlob is invalid for kind="glob"; use query as the glob.');
	if (kind !== "files" && input.ranking !== undefined && !structured)
		throw new V2ToolError("INVALID_INPUT", "ranking is only valid for file or structured search.");
	if (input.limit !== undefined && input.maxResultsGlobal !== undefined && input.limit !== input.maxResultsGlobal) {
		throw new V2ToolError("INVALID_INPUT", "limit and maxResultsGlobal must match when both are provided.");
	}
	if (!Number.isSafeInteger(context) || context < 0 || context > MAX_CONTEXT_LINES) {
		throw new V2ToolError("INVALID_INPUT", `context must be an integer between 0 and ${MAX_CONTEXT_LINES}.`);
	}
	positiveInteger(input.limit, "limit", MAX_SEARCH_LIMIT);
	positiveInteger(input.maxResultsGlobal, "maxResultsGlobal", MAX_SEARCH_LIMIT);
	positiveInteger(input.maxResultsPerFile, "maxResultsPerFile", MAX_SEARCH_LIMIT);
	positiveInteger(input.maxFiles, "maxFiles", MAX_SEARCH_LIMIT);
	if (
		input.maxOutputBytes !== undefined &&
		(!Number.isSafeInteger(input.maxOutputBytes) ||
			input.maxOutputBytes < MIN_OUTPUT_BYTES ||
			input.maxOutputBytes > MAX_OUTPUT_BYTES)
	) {
		throw new V2ToolError(
			"INVALID_INPUT",
			`maxOutputBytes must be an integer between ${MIN_OUTPUT_BYTES} and ${MAX_OUTPUT_BYTES}.`,
		);
	}
	return {
		query: input.query,
		kind,
		mode,
		targetKind: input.targetKind,
		path: input.path,
		fileGlob: input.fileGlob,
		include: input.include ?? [],
		exclude: input.exclude ?? [],
		honorIgnore: input.honorIgnore ?? true,
		includeHidden: input.includeHidden ?? false,
		followSymlinks: input.followSymlinks ?? false,
		case: input.case ?? "smart",
		wordBoundary: input.wordBoundary ?? false,
		context,
		limit: input.maxResultsGlobal ?? input.limit ?? DEFAULT_SEARCH_LIMIT,
		maxResultsPerFile: input.maxResultsPerFile ?? DEFAULT_RESULTS_PER_FILE,
		maxFiles: input.maxFiles ?? DEFAULT_MAX_FILES,
		maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		cursor: input.cursor,
		ranking,
		queryTemplate: input.queryTemplate,
		preferredPaths: input.preferredPaths ?? [],
	};
}

function requireCapabilities(request: SearchRequest, capabilities: SearchCapabilities): void {
	const structured = request.mode && (structuredModes as readonly string[]).includes(request.mode);
	if (structured && !capabilities.structuredModes?.includes(request.mode as SearchStructuredMode)) {
		throw new V2ToolError(
			"SYMBOL_INDEX_UNAVAILABLE",
			`${request.mode} requires a configured AST/LSP/semantic provider.`,
			{ fallbackAllowed: true, recovery: { kind: "use_text_fallback" as const } },
		);
	}
	let missing: string | undefined;
	if (request.ranking === "task" && !capabilities.taskRanking) missing = "task-aware ranking";
	else if (request.ranking === "global" && !capabilities.globalRanking) missing = "global ranking";
	else if ((request.include?.length || request.exclude?.length) && !capabilities.scopeFilters)
		missing = "scope filters";
	else if (request.wordBoundary && !capabilities.wordBoundary) missing = "word-boundary search";
	if (!structured && !missing) {
		if (request.kind === "text" && request.regex && !capabilities.textRegex) missing = "regex text search";
		else if (request.kind === "text" && !request.regex && !capabilities.textLiteral) missing = "literal text search";
		else if (request.kind === "text" && request.context > 0 && !capabilities.context) missing = "text context";
		else if (request.kind === "files" && !capabilities.fuzzyFiles) missing = "fuzzy file search";
		else if (request.kind === "glob" && !capabilities.glob) missing = "glob search";
	}
	if (request.cursor && !capabilities.stableCursor) missing = "stable continuation";
	if (missing) {
		throw new V2ToolError(
			"SEARCH_CAPABILITY_UNSUPPORTED",
			`The configured search provider does not support ${missing}. Change the request or configure a capable provider.`,
			{ recovery: { kind: "configure_capability" as const } },
		);
	}
}

function requestSignature(request: SearchRequest, input: ValidatedInput): string {
	return JSON.stringify({
		query: request.query,
		kind: request.kind,
		path: request.path,
		fileGlob: request.fileGlob,
		include: request.include,
		exclude: request.exclude,
		honorIgnore: request.honorIgnore,
		includeHidden: request.includeHidden,
		followSymlinks: request.followSymlinks,
		case: request.case,
		regex: request.regex,
		mode: request.mode,
		wordBoundary: request.wordBoundary,
		context: request.context,
		limit: request.limit,
		maxResultsPerFile: request.maxResultsPerFile,
		maxFiles: request.maxFiles,
		maxOutputBytes: input.maxOutputBytes,
		targetKind: input.targetKind,
		ranking: request.ranking,
		queryTemplate: request.queryTemplate,
		preferredPaths: request.preferredPaths,
	});
}

async function shortHash(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest).slice(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compactTextHit(hit: Extract<SearchHit, { kind: "text" }>): {
	hit: Extract<SearchHit, { kind: "text" }>;
	match: string;
	preview: string;
	prefixOmitted: boolean;
	suffixOmitted: boolean;
	lineLengthBytes: number;
	endColumn: number;
} {
	const range = hit.ranges[0] ?? [Math.max(0, hit.column - 1), Math.max(0, hit.column - 1)];
	const match = hit.text.slice(range[0], range[1]).slice(0, MAX_MATCH_CHARS);
	const half = Math.floor((MAX_PREVIEW_CHARS - Math.min(match.length, MAX_MATCH_CHARS)) / 2);
	const start = Math.max(0, range[0] - half);
	const end = Math.min(hit.text.length, Math.max(range[1] + half, start + MAX_PREVIEW_CHARS));
	const preview = hit.text.slice(start, end);
	const adjustedRange: [number, number] = [Math.max(0, range[0] - start), Math.max(0, range[1] - start)];
	return {
		hit: {
			...hit,
			text: preview,
			ranges: [adjustedRange],
			before: hit.before?.slice(-1),
			after: hit.after?.slice(0, 1),
		},
		match,
		preview,
		prefixOmitted: start > 0,
		suffixOmitted: end < hit.text.length,
		lineLengthBytes: new TextEncoder().encode(hit.text).byteLength,
		endColumn: range[1] + 1,
	};
}

function groupLocators(locators: readonly SearchV2Locator[]): SearchV2Group[] {
	const groups = new Map<string, string[]>();
	for (const locator of locators) {
		const locatorIds = groups.get(locator.path) ?? [];
		locatorIds.push(locator.locatorId);
		groups.set(locator.path, locatorIds);
	}
	return [...groups].map(([path, locatorIds]) => ({ path, locatorIds }));
}

function formatGroupedLocators(locators: readonly SearchV2Locator[]): string {
	const byId = new Map(locators.map((locator) => [locator.locatorId, locator]));
	return groupLocators(locators)
		.map((group) => {
			const entries = group.locatorIds.flatMap((id) => {
				const locator = byId.get(id);
				if (!locator) return [];
				const position = locator.startLine ? `${locator.startLine}:${locator.startColumn ?? 1}` : "file";
				const match = locator.match ? `\t${JSON.stringify(locator.match)}` : "";
				return [`  ${locator.locatorId}\t${position}\t${locator.matchKind}${match}`];
			});
			return `${group.path}\n${entries.join("\n")}`;
		})
		.join("\n");
}

async function resolvedHitInfo(
	context: ExecutionToolContext,
	scopePath: string,
	scopeInfo: FileInfo,
	hitPath: string,
	signal?: AbortSignal,
): Promise<{ path: string; info?: FileInfo }> {
	if (scopeInfo.kind === "file") return { path: scopePath, info: scopeInfo };
	const joined = await context.env.joinPath([scopePath, hitPath], signal);
	if (!joined.ok) return { path: hitPath };
	const info = await context.env.fileInfo(joined.value, signal);
	return { path: joined.value, info: info.ok ? info.value : undefined };
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
		for (const [token, record] of cursors) if (record.expiresAt <= now) cursors.delete(token);
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
			"Locate workspace text, paths, verified JS/TS structures, or explicitly configured semantic candidates with scope, budgets, ranking, coverage, grouped paths, and opaque locator IDs. Read a locator before editing.",
		parameters: searchV2Schema,
		executionMode: "parallel",
		replay: "safe",
		async execute(_toolCallId, rawInput, signal, _onUpdate, context) {
			const input = validateInput(rawInput);
			const structuredMode = (structuredModes as readonly string[]).includes(input.mode);
			const provider =
				input.mode === "semantic_candidate"
					? context.semanticSearchProvider
					: structuredMode
						? context.structuredSearchProvider
						: context.searchProvider;
			if (!provider) {
				if (structuredMode) {
					throw new V2ToolError(
						"SYMBOL_INDEX_UNAVAILABLE",
						`${input.mode} requires a configured AST/LSP/semantic provider.`,
						{ fallbackAllowed: true, recovery: { kind: "use_text_fallback" as const } },
					);
				}
				throw new V2ToolError("SEARCH_PROVIDER_FAILED", "No search provider is configured for this v2 profile.");
			}
			const scope = await resolveWorkspacePath(
				context.env,
				input.path ?? ".",
				"read",
				context.workspacePolicy,
				signal,
			);
			const scopeInfoResult = await context.env.fileInfo(scope.canonicalPath, signal);
			if (!scopeInfoResult.ok) {
				throw new V2ToolError("NOT_FOUND", `Search root ${input.path ?? "."} could not be inspected.`);
			}
			const scopeId = context.search?.scopeId ?? context.read?.scopeId ?? context.env.cwd;
			const request: SearchRequest = {
				query: input.query,
				kind: input.kind,
				path: scope.absolutePath,
				fileGlob: input.fileGlob,
				include: input.include,
				exclude: input.exclude,
				honorIgnore: input.honorIgnore,
				includeHidden: input.includeHidden,
				followSymlinks: input.followSymlinks,
				case: input.case,
				regex: input.mode === "regex",
				mode: input.mode,
				targetKind: input.targetKind,
				wordBoundary: input.wordBoundary,
				context: input.context,
				limit: input.limit,
				maxResultsPerFile: input.maxResultsPerFile,
				maxFiles: input.maxFiles,
				ranking: input.ranking,
				queryTemplate: input.queryTemplate,
				preferredPaths: input.preferredPaths,
			};
			const signature = requestSignature(request, input);
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
				if (error instanceof SearchProviderError && error.code === "budget_exceeded")
					throw new V2ToolError("BUDGET_EXCEEDED", error.message);
				throw new V2ToolError(
					"SEARCH_PROVIDER_FAILED",
					`Search failed. Refine the scope or retry. ${error instanceof Error ? error.message : String(error)}`,
					undefined,
					error instanceof Error ? error : undefined,
				);
			}
			if (page.hits.length > input.limit) {
				throw new V2ToolError("SEARCH_PROVIDER_FAILED", "Search provider returned more hits than requested.");
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

			const snapshotId = `snap_${await shortHash(`${scopeId}\0${signature}\0${String(page.generation ?? "")}`)}`;
			const ledger = resolveToolState(context);
			const locators: SearchV2Locator[] = [];
			const compactHits: SearchHit[] = [];
			const skipped = [...(page.skipped ?? [])];
			const seen = new Set<string>();
			const perFile = new Map<string, number>();
			const files = new Set<string>();
			let toolTruncation: SearchTruncationReason | undefined;

			for (const hit of page.hits) {
				const key =
					hit.kind === "text"
						? `${hit.path}\0${hit.line}\0${hit.column}\0${JSON.stringify(hit.ranges)}`
						: `${hit.path}\0path`;
				if (seen.has(key)) continue;
				seen.add(key);
				const currentPerFile = perFile.get(hit.path) ?? 0;
				if (currentPerFile >= input.maxResultsPerFile) {
					toolTruncation = "max_results_per_file";
					continue;
				}
				if (!files.has(hit.path) && files.size >= input.maxFiles) {
					toolTruncation = "max_files";
					continue;
				}
				const resolved = await resolvedHitInfo(
					context,
					scope.canonicalPath,
					scopeInfoResult.value,
					hit.path,
					signal,
				);
				const compact = hit.kind === "text" ? compactTextHit(hit) : undefined;
				const matchKind =
					hit.kind === "text" ? (hit.matchKind ?? input.targetKind ?? "text") : (input.targetKind ?? "path");
				const stateLocator = ledger.addLocator({
					scopeId,
					snapshotId,
					path: resolved.path,
					kind: hit.kind,
					startLine: hit.kind === "text" ? hit.line : undefined,
					endLine: hit.kind === "text" ? (hit.endLine ?? hit.line) : undefined,
					startColumn: hit.kind === "text" ? hit.column : undefined,
					endColumn: hit.kind === "text" ? (hit.endColumn ?? compact?.endColumn) : undefined,
					byteOffset: hit.kind === "text" ? hit.byteOffset : undefined,
					lineLengthBytes: compact?.lineLengthBytes,
					match: compact?.match,
					matchKind,
					enclosingSymbol: hit.kind === "text" ? hit.enclosingSymbol : undefined,
					nodeKind: hit.kind === "text" ? hit.nodeKind : undefined,
					nodeId: hit.kind === "text" ? hit.nodeId : undefined,
					fileClass: hit.kind === "text" ? hit.fileClass : undefined,
					rankReasons: hit.kind === "text" ? hit.rankReasons : undefined,
					fileVersion: resolved.info ? fileVersion(resolved.info) : undefined,
				});
				const locator: SearchV2Locator = {
					locatorId: stateLocator.id,
					path: hit.path,
					startLine: stateLocator.startLine,
					endLine: stateLocator.endLine,
					startColumn: stateLocator.startColumn,
					endColumn: stateLocator.endColumn,
					byteOffset: stateLocator.byteOffset,
					match: stateLocator.match,
					matchKind,
					snapshotId,
					lineLengthBytes: compact?.lineLengthBytes,
					enclosingSymbol: stateLocator.enclosingSymbol,
					nodeKind: stateLocator.nodeKind,
					nodeId: stateLocator.nodeId,
					fileClass: stateLocator.fileClass,
					score: hit.kind === "text" ? hit.score : hit.score,
					rankReasons: stateLocator.rankReasons,
					preview: compact?.preview,
					prefixOmitted: compact?.prefixOmitted,
					suffixOmitted: compact?.suffixOmitted,
				};
				const candidateBytes = textEncoder.encode(formatGroupedLocators([...locators, locator])).byteLength;
				if (candidateBytes > input.maxOutputBytes) {
					ledger.removeLocator(stateLocator.id);
					toolTruncation = "max_output_bytes";
					break;
				}
				locators.push(locator);
				compactHits.push(compact?.hit ?? hit);
				perFile.set(hit.path, currentPerFile + 1);
				files.add(hit.path);
			}

			const renderText = (): {
				text: string;
				status: SearchV2Status;
				coverage: SearchV2Coverage;
			} => {
				const truncatedBy = toolTruncation ?? page.truncatedBy;
				const truncated = truncatedBy !== undefined || nextCursor !== undefined;
				const hasMore = truncated || page.partial || !page.complete;
				const status: SearchV2Status = truncated
					? "overflow"
					: hasMore || skipped.length > 0
						? "partial"
						: "complete";
				const coverage: SearchV2Coverage = {
					returnedCount: locators.length,
					matchedCount: page.matchedCount,
					matchedCountRelation:
						page.matchedCountRelation ?? (page.complete && !page.partial ? "exact" : "unknown"),
					hasMore,
					truncated,
					truncatedBy,
					skipped,
				};
				let text: string;
				if (locators.length > 0) text = formatGroupedLocators(locators);
				else if (status === "complete") text = "NO_MATCH_COMPLETE: no matches in the fully covered scope.";
				else text = "SEARCH_INCOMPLETE: no returned locator proves absence; narrow or change the query.";
				const notices: string[] = [];
				if (page.approximate) notices.push("approximate ranking");
				if (coverage.truncatedBy) notices.push(`truncated by ${coverage.truncatedBy}`);
				if (nextCursor) notices.push(`continue with cursor=${nextCursor}`);
				if (skipped.length > 0) notices.push(`${skipped.length} skipped coverage item(s)`);
				if (notices.length > 0) text += `\n\n[${status}: ${notices.join("; ")}.]`;
				return { text, status, coverage };
			};

			let rendered = renderText();
			while (textEncoder.encode(rendered.text).byteLength > input.maxOutputBytes && locators.length > 0) {
				const removed = locators.pop();
				if (removed) ledger.removeLocator(removed.locatorId);
				compactHits.pop();
				toolTruncation = "max_output_bytes";
				rendered = renderText();
			}
			if (textEncoder.encode(rendered.text).byteLength > input.maxOutputBytes) {
				toolTruncation = "max_output_bytes";
				rendered = renderText();
				rendered.text = "SEARCH_INCOMPLETE: output truncated by max_output_bytes.";
			}
			const { text, status, coverage } = rendered;

			return {
				content: [{ type: "text", text }],
				details: {
					status,
					kind: input.kind,
					mode: input.mode,
					targetKind: input.targetKind,
					queryTemplate: input.queryTemplate,
					query: input.query,
					path: scope.absolutePath,
					hits: compactHits,
					locators,
					groups: groupLocators(locators),
					snapshotId,
					coverage,
					returnedCount: locators.length,
					complete: status === "complete",
					approximate: page.approximate,
					partial: status !== "complete",
					nextCursor,
					generation: page.generation,
					effectiveScope: {
						root: scope.absolutePath,
						include: input.include,
						exclude: input.exclude,
						honorIgnore: input.honorIgnore,
						includeHidden: input.includeHidden,
						followSymlinks: input.followSymlinks,
						preferredPaths: input.preferredPaths,
					},
				},
			};
		},
	};
}
