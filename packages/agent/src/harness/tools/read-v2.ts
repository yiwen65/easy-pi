import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool, ExecutionEnv, FileInfo } from "../types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../utils/truncate.ts";
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
import { V2ToolError } from "./v2-errors.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CURSOR_TTL_MS = 10 * 60 * 1000;
const MAX_CURSORS = 100;

const readV2Schema = Type.Object({
	path: Type.String({ description: "File, directory, or configured resource to read" }),
	offset: Type.Optional(Type.Number({ description: "First text line or best-effort directory entry, 1-indexed" })),
	limit: Type.Optional(Type.Number({ description: "Maximum lines or directory entries" })),
	byteOffset: Type.Optional(Type.Number({ description: "Byte continuation returned by a previous text read" })),
	cursor: Type.Optional(Type.String({ description: "Stable directory continuation returned by a previous read" })),
});

export type ReadV2Input = Static<typeof readV2Schema>;

export interface ReadV2Details {
	path: string;
	kind: "text" | "directory" | "image" | "resource";
	range?: [number, number];
	lines?: string[];
	entries?: DirectoryReadEntry[];
	hasMore?: boolean;
	nextOffset?: number;
	nextByteOffset?: number;
	nextCursor?: string;
	stable?: boolean;
	partial?: boolean;
	mediaType?: string;
	size?: number;
	truncation?: { reason: "bytes" | "lines" | "entries" };
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

function validatePositiveInteger(value: number | undefined, name: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
		throw new V2ToolError("INVALID_INPUT", `${name} must be a positive safe integer.`);
	}
}

function formatDirectoryEntry(entry: DirectoryReadEntry): string {
	const metadata: string[] = [];
	if (entry.size !== undefined) metadata.push(`${entry.size}B`);
	if (entry.mtimeMs !== undefined) metadata.push(new Date(entry.mtimeMs).toISOString());
	return `${entry.name}\t${entry.kind}${metadata.length > 0 ? `\t${metadata.join("\t")}` : ""}`;
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
				`${error.message} Use a smaller file, start from offset=1, or configure a range-capable provider.`,
			);
		case "directory_too_large":
			return new V2ToolError("DIRECTORY_TOO_LARGE", error.message);
		case "stale_cursor":
			return new V2ToolError("STALE_DIRECTORY", `${error.message} Repeat the directory read without cursor.`);
		case "unsupported":
			return new V2ToolError("READ_PROVIDER_FAILED", error.message);
	}
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
			"Read a file, stable directory page, image, or configured resource. Text reads are bounded; continue with returned offsets or cursor.",
		parameters: readV2Schema,
		executionMode: "parallel",
		replay: "safe",
		async execute(_toolCallId, input, signal, _onUpdate, context) {
			validatePositiveInteger(input.offset, "offset");
			validatePositiveInteger(input.limit, "limit");
			if (input.byteOffset !== undefined && (!Number.isSafeInteger(input.byteOffset) || input.byteOffset < 0)) {
				throw new V2ToolError("INVALID_INPUT", "byteOffset must be a non-negative safe integer.");
			}
			if (
				input.byteOffset !== undefined &&
				(input.offset !== undefined || input.limit !== undefined || input.cursor)
			) {
				throw new V2ToolError("INVALID_INPUT", "byteOffset cannot be combined with offset, limit, or cursor.");
			}
			if (input.cursor && input.offset !== undefined) {
				throw new V2ToolError("INVALID_INPUT", "cursor cannot be combined with offset.");
			}
			const resource = await readConfiguredResource(input.path, context.resourceReaders, signal);
			if (resource) return resource;

			const resolved = await resolveWorkspacePath(context.env, input.path, "read", context.workspacePolicy, signal);
			const provider = getProvider(context);
			let info: FileInfo;
			try {
				info = await provider.stat(resolved.canonicalPath, signal);
			} catch (error) {
				if (signal?.aborted) throw new V2ToolError("ABORTED", "Read was aborted.");
				if (error instanceof ReadProviderError) throw mapProviderError(error, input.path);
				throw error;
			}
			if (info.kind === "directory") {
				if (!provider.capabilities.directoryPage) {
					throw new V2ToolError("READ_PROVIDER_FAILED", "The configured provider cannot page directories.");
				}
				if (input.cursor && !provider.capabilities.stableDirectoryCursor) {
					throw new V2ToolError(
						"STALE_DIRECTORY",
						"The configured provider does not support stable directory continuation. Repeat without cursor.",
					);
				}
				if (input.byteOffset !== undefined)
					throw new V2ToolError("INVALID_INPUT", "byteOffset is invalid for a directory.");
				const limit = input.limit ?? DEFAULT_MAX_LINES;
				const scopeId = context.read?.scopeId ?? context.env.cwd;
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
					if (error instanceof ReadProviderError) throw mapProviderError(error, input.path);
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
				let text =
					page.entries.length > 0 ? page.entries.map(formatDirectoryEntry).join("\n") : "(empty directory)";
				if (nextCursor) text += `\n\n[More entries. Continue with cursor=${nextCursor}.]`;
				return {
					content: [{ type: "text", text }],
					details: {
						path: resolved.absolutePath,
						kind: "directory",
						entries: page.entries,
						range:
							page.entries.length > 0 && input.offset !== undefined && !input.cursor
								? [input.offset, input.offset + page.entries.length - 1]
								: undefined,
						hasMore: nextCursor !== undefined,
						nextCursor,
						stable: page.stable,
						partial: page.partial,
						truncation: nextCursor ? { reason: "entries" } : undefined,
					},
				};
			}
			if (info.kind !== "file") throw new V2ToolError("NOT_A_FILE", `${input.path} is not a regular file.`);
			const offset = input.offset ?? 1;
			const limit = input.limit ?? DEFAULT_MAX_LINES;
			if (!provider.capabilities.textRange && (offset > 1 || input.byteOffset !== undefined)) {
				throw new V2ToolError(
					"RANGE_READ_UNSUPPORTED",
					"This backend cannot read the requested range without loading an oversized file. Use offset=1 or configure a range-capable provider.",
				);
			}
			try {
				const range = await provider.readText(
					resolved.canonicalPath,
					{
						startLine: offset,
						startByte: input.byteOffset,
						maxLines: input.byteOffset === undefined ? limit : 1,
						maxBytes: DEFAULT_MAX_BYTES,
					},
					signal,
				);
				let text = range.lines.join("\n");
				if (range.nextByte !== undefined)
					text += `\n\n[Line truncated. Continue with byteOffset=${range.nextByte}.]`;
				else if (range.nextLine !== undefined) text += `\n\n[More lines. Continue with offset=${range.nextLine}.]`;
				return {
					content: [{ type: "text", text }],
					details: {
						path: resolved.absolutePath,
						kind: "text",
						range: [range.startLine, range.endLine],
						lines: range.lines,
						hasMore: !range.eof,
						nextOffset: range.nextLine,
						nextByteOffset: range.nextByte,
						truncation:
							range.nextByte !== undefined
								? { reason: "bytes" }
								: range.nextLine !== undefined
									? { reason: "lines" }
									: undefined,
					},
				};
			} catch (error) {
				if (signal?.aborted) throw new V2ToolError("ABORTED", "Read was aborted.");
				if (error instanceof ReadProviderError && error.code !== "unsupported") {
					throw mapProviderError(error, input.path);
				}
				if (!(error instanceof ReadProviderError)) throw error;
			}
			if (
				input.offset !== undefined ||
				input.limit !== undefined ||
				input.byteOffset !== undefined ||
				input.cursor
			) {
				throw new V2ToolError("INVALID_INPUT", "offset, limit, byteOffset, and cursor are invalid for images.");
			}
			if (!provider.capabilities.binary) {
				throw new V2ToolError("UNSUPPORTED_BINARY_FILE", "The configured provider cannot read binary images.");
			}
			if (info.size > MAX_IMAGE_BYTES) {
				throw new V2ToolError("UNSUPPORTED_BINARY_FILE", `${input.path} exceeds the bounded image read limit.`);
			}
			let bytes: Uint8Array;
			try {
				bytes = await provider.readBinary(resolved.canonicalPath, signal);
			} catch (error) {
				if (signal?.aborted) throw new V2ToolError("ABORTED", "Read was aborted.");
				if (error instanceof ReadProviderError) throw mapProviderError(error, input.path);
				throw error;
			}
			const mimeType = detectSupportedImageMimeType(bytes);
			if (!mimeType)
				throw new V2ToolError("UNSUPPORTED_BINARY_FILE", `${input.path} is not UTF-8 text or a supported image.`);
			const result = await imageResult(bytes, mimeType, options);
			return { ...result, details: { ...result.details, path: resolved.absolutePath } };
		},
	};
}
