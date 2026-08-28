import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool, FileInfo } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../utils/truncate.ts";
import { detectSupportedImageMimeType, encodeBase64 } from "./image.ts";
import type { ReadImageProcessor, ReadToolOptions } from "./read.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
import { V2ToolError } from "./v2-errors.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const readV2Schema = Type.Object({
	path: Type.String({ description: "File or directory path to read" }),
	offset: Type.Optional(Type.Number({ description: "First text line or directory entry, 1-indexed" })),
	limit: Type.Optional(Type.Number({ description: "Maximum lines or directory entries" })),
	byteOffset: Type.Optional(Type.Number({ description: "Byte continuation returned by a previous read" })),
});

export type ReadV2Input = Static<typeof readV2Schema>;

export interface ReadV2Details {
	path: string;
	kind: "text" | "directory" | "image";
	range?: [number, number];
	hasMore?: boolean;
	nextOffset?: number;
	nextByteOffset?: number;
	truncation?: { reason: "bytes" | "lines" | "entries" };
}

function validatePositiveInteger(value: number | undefined, name: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
		throw new V2ToolError("INVALID_INPUT", `${name} must be a positive safe integer.`);
	}
}

function compareNames(left: FileInfo, right: FileInfo): number {
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
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
				details: { path, kind: "image" },
			};
		}
		const hints = processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
		return {
			content: [
				{ type: "text", text: `Read image file [${processed.mimeType}]${hints}` },
				{ type: "image", data: processed.data, mimeType: processed.mimeType },
			],
			details: { path, kind: "image" },
		};
	}
	if (mimeType === "image/bmp") {
		return {
			content: [
				{ type: "text", text: "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor.]" },
			],
			details: { path, kind: "image" },
		};
	}
	return {
		content: [
			{ type: "text", text: `Read image file [${mimeType}]` },
			{ type: "image", data: encodeBase64(bytes), mimeType },
		],
		details: { path, kind: "image" },
	};
}

export function createReadV2Tool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options?: ReadToolOptions,
): AgentHarnessTool<TContext, typeof readV2Schema, ReadV2Details> {
	return {
		name: "read",
		label: "read",
		description:
			"Read a file or list a directory. Text reads are bounded; use offset or byteOffset returned by a previous result to continue.",
		parameters: readV2Schema,
		executionMode: "parallel",
		async execute(_toolCallId, input, signal, _onUpdate, context) {
			validatePositiveInteger(input.offset, "offset");
			validatePositiveInteger(input.limit, "limit");
			if (input.byteOffset !== undefined && (!Number.isSafeInteger(input.byteOffset) || input.byteOffset < 0)) {
				throw new V2ToolError("INVALID_INPUT", "byteOffset must be a non-negative safe integer.");
			}
			if (input.byteOffset !== undefined && (input.offset !== undefined || input.limit !== undefined)) {
				throw new V2ToolError("INVALID_INPUT", "byteOffset cannot be combined with offset or limit.");
			}
			const resolved = await resolveWorkspacePath(context.env, input.path, "read", context.workspacePolicy, signal);
			const infoResult = await context.env.fileInfo(resolved.canonicalPath, signal);
			if (!infoResult.ok) {
				if (infoResult.error.code === "not_found")
					throw new V2ToolError("NOT_FOUND", `${input.path} was not found.`);
				throw new V2ToolError("PERMISSION_DENIED", `Could not inspect ${input.path}: ${infoResult.error.message}`);
			}
			const info = infoResult.value;
			if (info.kind === "directory") {
				if (input.byteOffset !== undefined)
					throw new V2ToolError("INVALID_INPUT", "byteOffset is invalid for a directory.");
				const entriesResult = await context.env.listDir(resolved.canonicalPath, signal);
				if (!entriesResult.ok) throw new V2ToolError("PERMISSION_DENIED", `Could not list ${input.path}.`);
				const entries = entriesResult.value.sort(compareNames);
				const offset = input.offset ?? 1;
				const limit = input.limit ?? DEFAULT_MAX_LINES;
				if (offset > entries.length && entries.length > 0) {
					throw new V2ToolError(
						"INVALID_INPUT",
						`offset ${offset} is beyond ${entries.length} directory entries.`,
					);
				}
				const page = entries.slice(offset - 1, offset - 1 + limit);
				const hasMore = offset - 1 + page.length < entries.length;
				let text =
					page.length > 0 ? page.map((entry) => `${entry.name}\t${entry.kind}`).join("\n") : "(empty directory)";
				if (hasMore) text += `\n\n[More entries. Continue with offset=${offset + page.length}.]`;
				return {
					content: [{ type: "text", text }],
					details: {
						path: resolved.absolutePath,
						kind: "directory",
						range: page.length > 0 ? [offset, offset + page.length - 1] : undefined,
						hasMore,
						nextOffset: hasMore ? offset + page.length : undefined,
						truncation: hasMore ? { reason: "entries" } : undefined,
					},
				};
			}
			if (info.kind !== "file") throw new V2ToolError("NOT_A_FILE", `${input.path} is not a regular file.`);
			if (!context.env.readTextRange) {
				throw new V2ToolError("INVALID_INPUT", "This execution environment does not support bounded text reads.");
			}
			const offset = input.offset ?? 1;
			const limit = input.limit ?? DEFAULT_MAX_LINES;
			const textResult = await context.env.readTextRange(resolved.canonicalPath, {
				startLine: offset,
				startByte: input.byteOffset,
				maxLines: input.byteOffset === undefined ? limit : 1,
				maxBytes: DEFAULT_MAX_BYTES,
				abortSignal: signal,
			});
			if (textResult.ok) {
				const range = textResult.value;
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
			}
			if (textResult.error.code === "aborted") throw new V2ToolError("ABORTED", "Read was aborted.");
			if (textResult.error.code !== "invalid") {
				throw new V2ToolError("PERMISSION_DENIED", `Could not read ${input.path}: ${textResult.error.message}`);
			}
			const bytes = getOrThrow(await context.env.readBinaryFile(resolved.canonicalPath, signal));
			const mimeType = detectSupportedImageMimeType(bytes);
			if (!mimeType)
				throw new V2ToolError("UNSUPPORTED_BINARY_FILE", `${input.path} is not UTF-8 text or a supported image.`);
			if (input.offset !== undefined || input.limit !== undefined || input.byteOffset !== undefined) {
				throw new V2ToolError("INVALID_INPUT", "offset, limit, and byteOffset are invalid for images.");
			}
			const result = await imageResult(bytes, mimeType, options);
			return { ...result, details: { ...result.details, path: resolved.absolutePath } };
		},
	};
}
