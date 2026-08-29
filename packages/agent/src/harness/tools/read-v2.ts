import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool, ExecutionEnv, FileInfo } from "../types.ts";
import { detectSupportedImageMimeType, encodeBase64 } from "./image.ts";
import type { ReadImageProcessor, ReadToolOptions } from "./read.ts";
import {
	type DirectoryReadEntry,
	type DirectoryReadPage,
	ExecutionEnvReadProvider,
	ReadProviderError,
	type ResourceReader,
} from "./read-provider.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
import {
	fileVersion,
	resolveToolState,
	sameFileVersion,
	type ToolFileVersion,
	type ToolLocator,
} from "./tool-state.ts";
import { V2ToolError } from "./v2-errors.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const DEFAULT_TEXT_MAX_LINES = 200;
const DEFAULT_TEXT_MAX_BYTES = 8 * 1024;
const DEFAULT_OUTPUT_TOKENS = 2048;
const DEFAULT_LOCATOR_CONTEXT = 5;
const MIN_TEXT_MAX_BYTES = 512;
const MAX_TEXT_MAX_BYTES = 256 * 1024;
const MAX_TEXT_LINES = 10_000;
const MAX_CONTEXT_LINES = 1_000;
const MIN_OUTPUT_TOKENS = 128;
const MAX_OUTPUT_TOKENS = 64 * 1024;
const OUTPUT_RESERVE_BYTES = 320;
const MAX_HASH_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CURSOR_TTL_MS = 10 * 60 * 1000;
const MAX_CURSORS = 100;
const textEncoder = new TextEncoder();

const readV2Properties = {
	startLine: Type.Optional(Type.Number({ description: "First text line, 1-indexed" })),
	endLine: Type.Optional(Type.Number({ description: "Last requested text line, inclusive" })),
	offset: Type.Optional(Type.Number({ description: "Compatibility alias for startLine or directory entry offset" })),
	limit: Type.Optional(Type.Number({ description: "Compatibility alias for maxLines or directory entry count" })),
	beforeLines: Type.Optional(Type.Number({ description: "Lines before a locator (default: 5)" })),
	afterLines: Type.Optional(Type.Number({ description: "Lines after a locator (default: 5)" })),
	maxLines: Type.Optional(Type.Number({ description: `Text line budget (default: ${DEFAULT_TEXT_MAX_LINES})` })),
	maxBytes: Type.Optional(
		Type.Number({ description: `Model-visible text byte budget (default: ${DEFAULT_TEXT_MAX_BYTES})` }),
	),
	maxOutputTokens: Type.Optional(
		Type.Number({ description: `Estimated output token budget (default: ${DEFAULT_OUTPUT_TOKENS})` }),
	),
	byteOffset: Type.Optional(Type.Number({ description: "Absolute byte offset for a bounded text read" })),
	cursor: Type.Optional(Type.String({ description: "Stable directory continuation returned by a previous read" })),
};

const readV2Schema = Type.Union([
	Type.Object({
		...readV2Properties,
		path: Type.String({ description: "File, directory, or configured resource to read" }),
		locatorId: Type.Optional(Type.String()),
	}),
	Type.Object({
		...readV2Properties,
		path: Type.Optional(Type.String()),
		locatorId: Type.String({ description: "Opaque locator returned by search" }),
	}),
]);

export type ReadV2Input = Static<typeof readV2Schema>;

export interface ReadV2Details {
	path: string;
	kind: "text" | "directory" | "image" | "resource";
	range?: [number, number];
	byteRange?: [number, number];
	lines?: string[];
	entries?: DirectoryReadEntry[];
	viewId?: string;
	locatorId?: string;
	snapshotId?: string;
	fileHash?: string;
	fileVersion?: ToolFileVersion;
	editable?: boolean;
	hasMore?: boolean;
	hasMoreBefore?: boolean;
	hasMoreAfter?: boolean;
	nextOffset?: number;
	nextByteOffset?: number;
	nextCursor?: string;
	stable?: boolean;
	partial?: boolean;
	mediaType?: string;
	size?: number;
	outputBytes?: number;
	estimatedOutputTokens?: number;
	truncation?: { reason: "bytes" | "lines" | "entries" | "output_budget" };
}

type CursorRecord = {
	path: string;
	limit: number;
	providerId: string;
	providerCursor: string;
	generation?: string | number;
	scopeId: string;
	expiresAt: number;
};

function validatePositiveInteger(value: number | undefined, name: string, maximum = Number.MAX_SAFE_INTEGER): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maximum)) {
		throw new V2ToolError("INVALID_INPUT", `${name} must be an integer between 1 and ${maximum}.`);
	}
}

function validateNonNegativeInteger(value: number | undefined, name: string, maximum: number): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > maximum)) {
		throw new V2ToolError("INVALID_INPUT", `${name} must be an integer between 0 and ${maximum}.`);
	}
}

function formatDirectoryEntry(entry: DirectoryReadEntry): string {
	const metadata: string[] = [];
	if (entry.size !== undefined) metadata.push(`${entry.size}B`);
	if (entry.mtimeMs !== undefined) metadata.push(new Date(entry.mtimeMs).toISOString());
	return `${entry.name}\t${entry.kind}${metadata.length > 0 ? `\t${metadata.join("\t")}` : ""}`;
}

async function shortHash(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(value));
	return [...new Uint8Array(digest).slice(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function versionSignature(version: ToolFileVersion): string {
	return `${version.identity ?? ""}\0${version.size}\0${version.mtimeMs}\0${version.mode ?? ""}`;
}

async function imageResult(
	bytes: Uint8Array,
	mimeType: string,
	options: ReadToolOptions | undefined,
): Promise<{ content: Array<TextContent | ImageContent>; details: ReadV2Details }> {
	const path = "";
	const processor: ReadImageProcessor | undefined = options?.imageProcessor;
	if (processor) {
		const processed = await processor(bytes, mimeType, { autoResizeImages: options?.autoResizeImages ?? true });
		if (!processed.ok) {
			return {
				content: [{ type: "text", text: `Read image file [${mimeType}]\n${processed.message}` }],
				details: { path, kind: "image", mediaType: mimeType, size: bytes.byteLength },
			};
		}
		const hints = processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
		return {
			content: [
				{ type: "text", text: `Read image file [${processed.mimeType}]${hints}` },
				{ type: "image", data: processed.data, mimeType: processed.mimeType },
			],
			details: { path, kind: "image", mediaType: processed.mimeType, size: bytes.byteLength },
		};
	}
	if (mimeType === "image/bmp") {
		return {
			content: [
				{ type: "text", text: "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor.]" },
			],
			details: { path, kind: "image", mediaType: mimeType, size: bytes.byteLength },
		};
	}
	return {
		content: [
			{ type: "text", text: `Read image file [${mimeType}]` },
			{ type: "image", data: encodeBase64(bytes), mimeType },
		],
		details: { path, kind: "image", mediaType: mimeType, size: bytes.byteLength },
	};
}

async function readConfiguredResource(
	path: string,
	readers: ResourceReader[] | undefined,
	signal?: AbortSignal,
): Promise<{ content: Array<TextContent | ImageContent>; details: ReadV2Details } | undefined> {
	const reader = readers?.find((candidate) => candidate.canRead(path));
	if (!reader) return undefined;
	try {
		const result = await reader.read(path, signal);
		return {
			content: result.content,
			details: { path, kind: "resource", mediaType: result.mediaType, size: result.size },
		};
	} catch (error) {
		if (signal?.aborted) throw new V2ToolError("ABORTED", "Resource read was aborted.");
		throw new V2ToolError(
			"READ_PROVIDER_FAILED",
			`Resource reader ${reader.id} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function mapProviderError(error: ReadProviderError, path: string): V2ToolError {
	switch (error.code) {
		case "not_found":
			return new V2ToolError("NOT_FOUND", `${path} was not found.`);
		case "permission_denied":
			return new V2ToolError("PERMISSION_DENIED", `Could not read ${path}: ${error.message}`);
		case "invalid":
			return new V2ToolError("INVALID_INPUT", error.message);
		case "range_unsupported":
			return new V2ToolError(
				"RANGE_READ_UNSUPPORTED",
				`${error.message} Use a smaller file, start from line 1, or configure a range-capable provider.`,
			);
		case "directory_too_large":
			return new V2ToolError("DIRECTORY_TOO_LARGE", error.message);
		case "stale_cursor":
			return new V2ToolError("STALE_DIRECTORY", `${error.message} Repeat the directory read without cursor.`);
		case "unsupported":
			return new V2ToolError("READ_PROVIDER_FAILED", error.message);
	}
}

function boundedDirectoryOutput(
	entries: DirectoryReadEntry[],
	maxBytes: number,
): { entries: DirectoryReadEntry[]; text: string; truncated: boolean } {
	const visible: DirectoryReadEntry[] = [];
	let text = "";
	for (const entry of entries) {
		const line = formatDirectoryEntry(entry);
		const candidate = text ? `${text}\n${line}` : line;
		if (textEncoder.encode(candidate).byteLength > maxBytes) break;
		visible.push(entry);
		text = candidate;
	}
	return {
		entries: visible,
		text: text || (entries.length > 0 ? "(no entries fit output budget)" : "(empty directory)"),
		truncated: visible.length < entries.length,
	};
}

function textOutput(
	viewId: string,
	snapshotId: string,
	fileHash: string | undefined,
	lines: string[],
	startLine: number,
	byteMode: boolean,
	nextOffset: number | undefined,
	nextByteOffset: number | undefined,
	maxBytes: number,
	startByte?: number,
): { text: string; lines: string[]; nextOffset?: number; nextByteOffset?: number; outputTruncated: boolean } {
	const header = `[view_id=${viewId} snapshot_id=${snapshotId} ${fileHash ? `file_hash=${fileHash}` : "editable=false"}]`;
	const visible = [...lines];
	let visibleNextOffset = nextOffset;
	let visibleNextByteOffset = nextByteOffset;
	let outputTruncated = false;
	const render = (): string => {
		const body = visible
			.map(
				(line, index) =>
					`${byteMode && index === 0 ? `@byte:${startByte ?? 0}` : String(startLine + index)}\t${line}`,
			)
			.join("\n");
		const continuations: string[] = [];
		if (visibleNextOffset !== undefined) continuations.push(`continue with startLine=${visibleNextOffset}`);
		if (visibleNextByteOffset !== undefined) continuations.push(`continue with byteOffset=${visibleNextByteOffset}`);
		if (outputTruncated && continuations.length === 0) continuations.push("narrow the requested range");
		return `${header}${body ? `\n${body}` : ""}${
			continuations.length > 0 ? `\n\n[Truncated: ${continuations.join("; ")}.]` : ""
		}`;
	};
	let text = render();
	while (textEncoder.encode(text).byteLength > maxBytes && visible.length > 1) {
		visible.pop();
		outputTruncated = true;
		if (byteMode) visibleNextByteOffset = undefined;
		else visibleNextOffset = startLine + visible.length;
		text = render();
	}
	if (textEncoder.encode(text).byteLength > maxBytes) {
		visible.length = 0;
		outputTruncated = true;
		visibleNextOffset = byteMode ? undefined : startLine;
		visibleNextByteOffset = undefined;
		text = render();
	}
	if (textEncoder.encode(text).byteLength > maxBytes) {
		text = `[view_id=${viewId} editable=false]\n[BUDGET_EXCEEDED: narrow the requested range.]`;
	}
	return {
		text,
		lines: visible,
		nextOffset: visibleNextOffset,
		nextByteOffset: visibleNextByteOffset,
		outputTruncated,
	};
}

export function createReadV2Tool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options?: ReadToolOptions,
): AgentHarnessTool<TContext, typeof readV2Schema, ReadV2Details> {
	const fallbackProviders = new WeakMap<ExecutionEnv, ExecutionEnvReadProvider>();
	const cursors = new Map<string, CursorRecord>();
	let cursorSequence = 0;

	const getProvider = (context: ExecutionToolContext) => {
		if (context.readProvider) return context.readProvider;
		let provider = fallbackProviders.get(context.env);
		if (!provider) {
			provider = new ExecutionEnvReadProvider(context.env);
			fallbackProviders.set(context.env, provider);
		}
		return provider;
	};
	const pruneCursors = (): void => {
		const now = Date.now();
		for (const [cursor, record] of cursors) if (record.expiresAt <= now) cursors.delete(cursor);
		while (cursors.size >= MAX_CURSORS) {
			const oldest = cursors.keys().next().value;
			if (oldest === undefined) break;
			cursors.delete(oldest);
		}
	};

	return {
		name: "read",
		label: "read",
		description:
			"Read an opaque search locator or a bounded file range with numbered lines, view/hash evidence, and explicit continuation. Also reads stable directory pages, images, and configured resources.",
		parameters: readV2Schema,
		executionMode: "parallel",
		replay: "safe",
		async execute(_toolCallId, input, signal, _onUpdate, context) {
			if ((input.path === undefined) === (input.locatorId === undefined)) {
				throw new V2ToolError("INVALID_INPUT", "Provide exactly one of path or locatorId.");
			}
			validatePositiveInteger(input.offset, "offset");
			validatePositiveInteger(input.startLine, "startLine");
			validatePositiveInteger(input.endLine, "endLine");
			validatePositiveInteger(input.limit, "limit", MAX_TEXT_LINES);
			validatePositiveInteger(input.maxLines, "maxLines", MAX_TEXT_LINES);
			if (
				input.maxOutputTokens !== undefined &&
				(!Number.isSafeInteger(input.maxOutputTokens) ||
					input.maxOutputTokens < MIN_OUTPUT_TOKENS ||
					input.maxOutputTokens > MAX_OUTPUT_TOKENS)
			) {
				throw new V2ToolError(
					"INVALID_INPUT",
					`maxOutputTokens must be an integer between ${MIN_OUTPUT_TOKENS} and ${MAX_OUTPUT_TOKENS}.`,
				);
			}
			validateNonNegativeInteger(input.beforeLines, "beforeLines", MAX_CONTEXT_LINES);
			validateNonNegativeInteger(input.afterLines, "afterLines", MAX_CONTEXT_LINES);
			if (
				input.maxBytes !== undefined &&
				(!Number.isSafeInteger(input.maxBytes) ||
					input.maxBytes < MIN_TEXT_MAX_BYTES ||
					input.maxBytes > MAX_TEXT_MAX_BYTES)
			) {
				throw new V2ToolError(
					"INVALID_INPUT",
					`maxBytes must be an integer between ${MIN_TEXT_MAX_BYTES} and ${MAX_TEXT_MAX_BYTES}.`,
				);
			}
			if (input.byteOffset !== undefined && (!Number.isSafeInteger(input.byteOffset) || input.byteOffset < 0)) {
				throw new V2ToolError("INVALID_INPUT", "byteOffset must be a non-negative safe integer.");
			}
			if (input.startLine !== undefined && input.offset !== undefined && input.startLine !== input.offset) {
				throw new V2ToolError("INVALID_INPUT", "startLine and offset must match when both are provided.");
			}
			if (input.maxLines !== undefined && input.limit !== undefined && input.maxLines !== input.limit) {
				throw new V2ToolError("INVALID_INPUT", "maxLines and limit must match when both are provided.");
			}
			if (input.endLine !== undefined && input.endLine < (input.startLine ?? input.offset ?? 1)) {
				throw new V2ToolError("INVALID_INPUT", "endLine must not be before startLine.");
			}
			if (
				input.byteOffset !== undefined &&
				(input.startLine !== undefined || input.offset !== undefined || input.endLine)
			) {
				throw new V2ToolError("INVALID_INPUT", "byteOffset cannot be combined with a line range.");
			}
			if (input.cursor && (input.startLine !== undefined || input.offset !== undefined || input.locatorId)) {
				throw new V2ToolError("INVALID_INPUT", "cursor cannot be combined with a line range or locatorId.");
			}
			if (
				input.locatorId &&
				(input.byteOffset !== undefined ||
					input.cursor ||
					input.endLine !== undefined ||
					input.startLine !== undefined ||
					input.offset !== undefined)
			) {
				throw new V2ToolError(
					"INVALID_INPUT",
					"locatorId selects the file and target range; use beforeLines, afterLines, maxLines, and maxBytes.",
				);
			}
			if (!input.locatorId && (input.beforeLines !== undefined || input.afterLines !== undefined)) {
				throw new V2ToolError("INVALID_INPUT", "beforeLines and afterLines require locatorId.");
			}

			if (input.path) {
				const resource = await readConfiguredResource(input.path, context.resourceReaders, signal);
				if (resource) return resource;
			}

			const scopeId = context.read?.scopeId ?? context.search?.scopeId ?? context.env.cwd;
			const ledger = resolveToolState(context);
			let locator: ToolLocator | undefined;
			if (input.locatorId) {
				locator = ledger.getLocator(input.locatorId, scopeId);
				if (!locator) {
					throw new V2ToolError(
						"STALE_LOCATOR",
						"The locator expired or belongs to another tool scope. Repeat search and read the new locator.",
						{ recovery: { kind: "read_locator" as const } },
					);
				}
			}
			const requestedPath = locator?.path ?? input.path;
			if (!requestedPath) throw new V2ToolError("INVALID_INPUT", "A path or locatorId is required.");
			const resolved = await resolveWorkspacePath(
				context.env,
				requestedPath,
				"read",
				context.workspacePolicy,
				signal,
			);
			const provider = getProvider(context);
			let info: FileInfo;
			try {
				info = await provider.stat(resolved.canonicalPath, signal);
			} catch (error) {
				if (signal?.aborted) throw new V2ToolError("ABORTED", "Read was aborted.");
				if (error instanceof ReadProviderError) throw mapProviderError(error, requestedPath);
				throw error;
			}
			if (locator?.fileVersion && !sameFileVersion(locator.fileVersion, fileVersion(info))) {
				throw new V2ToolError(
					"STALE_LOCATOR",
					"The located file changed after search. Repeat search before reading it.",
					{ paths: [requestedPath], recovery: { kind: "read_again" as const, paths: [requestedPath] } },
				);
			}
			if (locator && !locator.fileVersion) {
				throw new V2ToolError("STALE_LOCATOR", "The locator has no verifiable file version. Repeat search.");
			}

			const maxOutputBytes = Math.min(
				input.maxBytes ?? DEFAULT_TEXT_MAX_BYTES,
				(input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS) * 4,
			);
			const requestedMaxLines = input.maxLines ?? input.limit ?? DEFAULT_TEXT_MAX_LINES;

			if (info.kind === "directory") {
				if (locator) throw new V2ToolError("NOT_A_FILE", "The locator resolves to a directory, not text.");
				if (!provider.capabilities.directoryPage) {
					throw new V2ToolError("READ_PROVIDER_FAILED", "The configured provider cannot page directories.");
				}
				if (input.cursor && !provider.capabilities.stableDirectoryCursor) {
					throw new V2ToolError(
						"STALE_DIRECTORY",
						"The configured provider does not support stable directory continuation. Repeat without cursor.",
					);
				}
				if (input.byteOffset !== undefined || input.endLine !== undefined)
					throw new V2ToolError("INVALID_INPUT", "Text ranges are invalid for a directory.");
				const limit = input.limit ?? input.maxLines ?? DEFAULT_TEXT_MAX_LINES;
				let providerCursor: string | undefined;
				let expectedGeneration: string | number | undefined;
				if (input.cursor) {
					pruneCursors();
					const record = cursors.get(input.cursor);
					if (
						!record ||
						record.path !== resolved.canonicalPath ||
						record.limit !== limit ||
						record.providerId !== provider.id ||
						record.scopeId !== scopeId
					) {
						throw new V2ToolError(
							"STALE_DIRECTORY",
							"The directory cursor expired or belongs to a different request. Repeat without cursor.",
						);
					}
					providerCursor = record.providerCursor;
					expectedGeneration = record.generation;
				}
				let page: DirectoryReadPage;
				try {
					page = await provider.readDirectory(
						{
							path: resolved.canonicalPath,
							offset: input.offset ?? 1,
							limit,
							cursor: providerCursor,
							expectedGeneration,
						},
						signal,
					);
				} catch (error) {
					if (signal?.aborted) throw new V2ToolError("ABORTED", "Read was aborted.");
					if (error instanceof ReadProviderError) throw mapProviderError(error, requestedPath);
					throw error;
				}
				let nextCursor: string | undefined;
				if (page.nextCursor) {
					pruneCursors();
					nextCursor = `r2-${Date.now().toString(36)}-${(cursorSequence++).toString(36)}`;
					cursors.set(nextCursor, {
						path: resolved.canonicalPath,
						limit,
						providerId: provider.id,
						providerCursor: page.nextCursor,
						generation: page.generation,
						scopeId,
						expiresAt: Date.now() + CURSOR_TTL_MS,
					});
				}
				let bounded = boundedDirectoryOutput(page.entries, maxOutputBytes);
				let notice = nextCursor
					? `[More entries. Continue with cursor=${nextCursor}.]`
					: bounded.truncated
						? "[Directory output budget reached. Narrow the path or limit.]"
						: "";
				if (notice) {
					const available = Math.max(0, maxOutputBytes - textEncoder.encode(`\n\n${notice}`).byteLength);
					bounded = boundedDirectoryOutput(page.entries, available);
					if (!nextCursor && !bounded.truncated) notice = "";
				}
				const text = `${bounded.text}${notice ? `\n\n${notice}` : ""}`;
				return {
					content: [{ type: "text", text }],
					details: {
						path: resolved.absolutePath,
						kind: "directory",
						entries: bounded.entries,
						range:
							bounded.entries.length > 0 && input.offset !== undefined && !input.cursor
								? [input.offset, input.offset + bounded.entries.length - 1]
								: undefined,
						hasMore: nextCursor !== undefined || bounded.truncated,
						nextCursor,
						stable: page.stable,
						partial: page.partial || bounded.truncated,
						outputBytes: textEncoder.encode(text).byteLength,
						estimatedOutputTokens: Math.ceil(textEncoder.encode(text).byteLength / 4),
						truncation: nextCursor
							? { reason: "entries" }
							: bounded.truncated
								? { reason: "output_budget" }
								: undefined,
					},
				};
			}
			if (info.kind !== "file") throw new V2ToolError("NOT_A_FILE", `${requestedPath} is not a regular file.`);

			const beforeLines = input.beforeLines ?? DEFAULT_LOCATOR_CONTEXT;
			const afterLines = input.afterLines ?? DEFAULT_LOCATOR_CONTEXT;
			let startLine = input.startLine ?? input.offset ?? 1;
			let maxLines = requestedMaxLines;
			if (locator) {
				startLine = Math.max(1, (locator.startLine ?? 1) - beforeLines);
				const desiredEnd = (locator.endLine ?? locator.startLine ?? startLine) + afterLines;
				maxLines = Math.min(maxLines, desiredEnd - startLine + 1);
			} else if (input.endLine !== undefined) {
				maxLines = Math.min(maxLines, input.endLine - startLine + 1);
			}
			const longLineLocator =
				locator?.byteOffset !== undefined && (locator.lineLengthBytes ?? 0) > maxOutputBytes - OUTPUT_RESERVE_BYTES
					? locator
					: undefined;
			const readByteOffset = longLineLocator?.byteOffset ?? input.byteOffset;
			if (!provider.capabilities.textRange && (startLine > 1 || readByteOffset !== undefined)) {
				throw new V2ToolError(
					"RANGE_READ_UNSUPPORTED",
					"This backend cannot read the requested range without loading an oversized file. Use line 1 or configure a range-capable provider.",
				);
			}
			const providerMaxBytes = Math.max(4, maxOutputBytes - OUTPUT_RESERVE_BYTES);
			try {
				const range = await provider.readText(
					resolved.canonicalPath,
					{
						startLine: longLineLocator?.startLine ?? startLine,
						startByte: readByteOffset,
						maxLines: readByteOffset === undefined ? maxLines : 1,
						maxBytes: providerMaxBytes,
					},
					signal,
				);
				let fileHash: string | undefined;
				if (info.size <= MAX_HASH_BYTES) {
					const binary = await context.env.readBinaryFile(resolved.canonicalPath, signal);
					if (binary.ok && binary.value.byteLength <= MAX_HASH_BYTES) fileHash = await hashBytes(binary.value);
				}
				const finalInfo = await provider.stat(resolved.canonicalPath, signal);
				const initialVersion = fileVersion(info);
				const finalVersion = fileVersion(finalInfo);
				if (!sameFileVersion(initialVersion, finalVersion)) {
					throw new V2ToolError(
						"STALE_SNAPSHOT",
						"The file changed while it was being read. Read it again before editing.",
						{ paths: [requestedPath], recovery: { kind: "read_again" as const, paths: [requestedPath] } },
					);
				}
				const snapshotId =
					locator?.snapshotId ??
					`snap_${await shortHash(`${scopeId}\0${resolved.canonicalPath}\0${versionSignature(finalVersion)}\0${fileHash ?? ""}`)}`;
				const actualStartLine = longLineLocator?.startLine ?? range.startLine;
				const byteMode = readByteOffset !== undefined;
				const initialEndLine = range.lines.length > 0 ? actualStartLine + range.lines.length - 1 : actualStartLine;
				const view = ledger.addView({
					scopeId,
					snapshotId,
					locatorId: locator?.id,
					path: resolved.canonicalPath,
					range: [actualStartLine, initialEndLine],
					lines: [...range.lines],
					fileVersion: finalVersion,
					fileHash,
					editable: fileHash !== undefined,
					byteRange:
						readByteOffset === undefined
							? undefined
							: [readByteOffset, readByteOffset + textEncoder.encode(range.lines.join("\n")).byteLength],
				});
				const formatted = textOutput(
					view.id,
					snapshotId,
					fileHash,
					range.lines,
					actualStartLine,
					byteMode,
					range.nextLine,
					range.nextByte,
					maxOutputBytes,
					readByteOffset,
				);
				view.lines = formatted.lines;
				view.range = [
					actualStartLine,
					formatted.lines.length > 0 ? actualStartLine + formatted.lines.length - 1 : actualStartLine,
				];
				const outputBytes = textEncoder.encode(formatted.text).byteLength;
				const hasMoreAfter =
					formatted.nextOffset !== undefined || formatted.nextByteOffset !== undefined || !range.eof;
				return {
					content: [{ type: "text", text: formatted.text }],
					details: {
						path: resolved.absolutePath,
						kind: "text",
						range: view.range,
						byteRange: view.byteRange,
						lines: formatted.lines,
						viewId: view.id,
						locatorId: locator?.id,
						snapshotId,
						fileHash,
						fileVersion: finalVersion,
						editable: fileHash !== undefined,
						hasMore: hasMoreAfter,
						hasMoreBefore: actualStartLine > 1 || (readByteOffset ?? 0) > 0,
						hasMoreAfter,
						nextOffset: formatted.nextOffset,
						nextByteOffset: formatted.nextByteOffset,
						outputBytes,
						estimatedOutputTokens: Math.ceil(outputBytes / 4),
						truncation: formatted.outputTruncated
							? { reason: "output_budget" }
							: range.nextByte !== undefined
								? { reason: "bytes" }
								: range.nextLine !== undefined
									? { reason: "lines" }
									: undefined,
					},
				};
			} catch (error) {
				if (signal?.aborted) throw new V2ToolError("ABORTED", "Read was aborted.");
				if (error instanceof V2ToolError) throw error;
				if (error instanceof ReadProviderError && error.code !== "unsupported") {
					throw mapProviderError(error, requestedPath);
				}
				if (!(error instanceof ReadProviderError)) throw error;
			}
			if (
				input.offset !== undefined ||
				input.startLine !== undefined ||
				input.endLine !== undefined ||
				input.limit !== undefined ||
				input.maxLines !== undefined ||
				input.byteOffset !== undefined ||
				input.cursor ||
				locator
			) {
				throw new V2ToolError("INVALID_INPUT", "Text ranges, locatorId, and cursor are invalid for images.");
			}
			if (!provider.capabilities.binary) {
				throw new V2ToolError("UNSUPPORTED_BINARY_FILE", "The configured provider cannot read binary images.");
			}
			if (info.size > MAX_IMAGE_BYTES) {
				throw new V2ToolError("UNSUPPORTED_BINARY_FILE", `${requestedPath} exceeds the bounded image read limit.`);
			}
			let bytes: Uint8Array;
			try {
				bytes = await provider.readBinary(resolved.canonicalPath, signal);
			} catch (error) {
				if (signal?.aborted) throw new V2ToolError("ABORTED", "Read was aborted.");
				if (error instanceof ReadProviderError) throw mapProviderError(error, requestedPath);
				throw error;
			}
			const mimeType = detectSupportedImageMimeType(bytes);
			if (!mimeType)
				throw new V2ToolError(
					"UNSUPPORTED_BINARY_FILE",
					`${requestedPath} is not UTF-8 text or a supported image.`,
				);
			const result = await imageResult(bytes, mimeType, options);
			return { ...result, details: { ...result.details, path: resolved.absolutePath } };
		},
	};
}
