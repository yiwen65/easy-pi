import { type Static, Type } from "typebox";
import type { AgentHarnessTool, FileInfo } from "../types.ts";
import {
	type SearchCapabilities,
	type SearchHit,
	type SearchMatchedCountRelation,
	type SearchPage,
	SearchProviderError,
	type SearchRequest,
	type SearchSkipped,
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

const structuredModes = [
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

const searchV2Schema = Type.Object({
	query: Type.String({ description: "Literal text, regex, file name, or glob to locate" }),
	kind: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("files"), Type.Literal("glob")])),
	mode: Type.Optional(
		Type.Union([
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
		]),
	),
	targetKind: Type.Optional(
		Type.Union([
			Type.Literal("exact_line"),
			Type.Literal("definition"),
			Type.Literal("reference"),
			Type.Literal("implementation"),
			Type.Literal("assignment"),
			Type.Literal("call"),
			Type.Literal("string_literal"),
			Type.Literal("comment"),
			Type.Literal("path"),
		]),
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
	context: Type.Optional(Type.Number({ description: "Optional candidate context lines; default: 0" })),
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
	ranking: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("global")])),
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
	preview?: string;
	prefixOmitted?: boolean;
	suffixOmitted?: boolean;
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
	mode: "literal" | "regex";
	targetKind?: string;
	query: string;
	path: string;
	hits: SearchHit[];
	locators: SearchV2Locator[];
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
	};
}

type ValidatedInput = {
	query: string;
	kind: "text" | "files" | "glob";
	mode: "literal" | "regex";
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

function positiveInteger(value: number | undefined, name: string, maximum: number): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maximum)) {
		throw new V2ToolError("INVALID_INPUT", `${name} must be an integer between 1 and ${maximum}.`);
	}
}

function validateInput(input: SearchV2Input): ValidatedInput {
	if (input.query.trim().length === 0) throw new V2ToolError("INVALID_INPUT", "query must not be empty.");
	const kind = input.kind ?? "text";
	const requestedMode = input.mode ?? (input.regex ? "regex" : "literal");
	if (input.mode && input.regex !== undefined && (input.mode === "regex") !== input.regex) {
		throw new V2ToolError("INVALID_INPUT", "mode and regex describe conflicting query semantics.");
	}
	if ((structuredModes as readonly string[]).includes(requestedMode)) {
		throw new V2ToolError(
			"SYMBOL_INDEX_UNAVAILABLE",
			`${requestedMode} requires a configured AST/LSP/semantic index. No structured index is available for this host.`,
			{ fallbackAllowed: true, recovery: { kind: "use_text_fallback" as const } },
		);
	}
	if (input.targetKind && (structuredTargetKinds as readonly string[]).includes(input.targetKind)) {
		throw new V2ToolError(
			"SYMBOL_INDEX_UNAVAILABLE",
			`${input.targetKind} intent cannot be verified by the configured text/path providers. Use an explicitly anchored literal or regex fallback without a structured targetKind.`,
			{ fallbackAllowed: true, recovery: { kind: "use_text_fallback" as const } },
		);
	}
	if (input.targetKind === "path" && kind === "text") {
		throw new V2ToolError("INVALID_INPUT", 'targetKind="path" requires kind="files" or kind="glob".');
	}
	const mode = requestedMode as "literal" | "regex";
	const context = input.context ?? 0;
	const ranking = input.ranking ?? "fast";
	if (kind !== "text" && mode === "regex")
		throw new V2ToolError("INVALID_INPUT", 'mode="regex" is only valid for kind="text".');
	if (kind !== "text" && context !== 0)
		throw new V2ToolError("INVALID_INPUT", 'context is only valid for kind="text".');
	if (kind === "glob" && input.fileGlob !== undefined)
		throw new V2ToolError("INVALID_INPUT", 'fileGlob is invalid for kind="glob"; use query as the glob.');
	if (kind !== "files" && input.ranking !== undefined)
		throw new V2ToolError("INVALID_INPUT", 'ranking is only valid for kind="files".');
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
	else if ((request.include?.length || request.exclude?.length) && !capabilities.scopeFilters)
		missing = "scope filters";
	else if (request.wordBoundary && !capabilities.wordBoundary) missing = "word-boundary search";
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
		wordBoundary: request.wordBoundary,
		context: request.context,
		limit: request.limit,
		maxResultsPerFile: request.maxResultsPerFile,
		maxFiles: request.maxFiles,
		maxOutputBytes: input.maxOutputBytes,
		targetKind: input.targetKind,
		ranking: request.ranking,
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

function formatLocator(locator: SearchV2Locator): string {
	const position = locator.startLine
		? `${locator.path}:${locator.startLine}:${locator.startColumn ?? 1}`
		: locator.path;
	const match = locator.match ? `\t${JSON.stringify(locator.match)}` : "";
	return `${locator.locatorId}\t${position}\t${locator.matchKind}${match}`;
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
			"Locate workspace text or paths with explicit semantics, scope, budgets, coverage, and opaque locator IDs. Read a locator to inspect code.",
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
				wordBoundary: input.wordBoundary,
				context: input.context,
				limit: input.limit,
				maxResultsPerFile: input.maxResultsPerFile,
				maxFiles: input.maxFiles,
				ranking: input.ranking,
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
			let outputBytes = 0;
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
				const matchKind = input.targetKind ?? (hit.kind === "file" ? "path" : "text");
				const stateLocator = ledger.addLocator({
					scopeId,
					snapshotId,
					path: resolved.path,
					kind: hit.kind,
					startLine: hit.kind === "text" ? hit.line : undefined,
					endLine: hit.kind === "text" ? hit.line : undefined,
					startColumn: hit.kind === "text" ? hit.column : undefined,
					endColumn: compact?.endColumn,
					byteOffset: hit.kind === "text" ? hit.byteOffset : undefined,
					lineLengthBytes: compact?.lineLengthBytes,
					match: compact?.match,
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
					preview: compact?.preview,
					prefixOmitted: compact?.prefixOmitted,
					suffixOmitted: compact?.suffixOmitted,
				};
				const line = formatLocator(locator);
				const lineBytes = new TextEncoder().encode(`${locators.length > 0 ? "\n" : ""}${line}`).byteLength;
				if (outputBytes + lineBytes > input.maxOutputBytes) {
					toolTruncation = "max_output_bytes";
					break;
				}
				outputBytes += lineBytes;
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
				if (locators.length > 0) text = locators.map(formatLocator).join("\n");
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
				locators.pop();
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
					query: input.query,
					path: scope.absolutePath,
					hits: compactHits,
					locators,
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
					},
				},
			};
		},
	};
}
