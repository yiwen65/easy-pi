/** Adapts remote MCP calls to bounded model content and easy-pi execution certainty. */

import { createHash } from "node:crypto";
import { AgentToolError, type AgentToolResult, type ToolExecutionOutcome } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type CallToolResult,
	type ContentBlock,
	type McpRequestOptions,
	type Tool as McpTool,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ToolAnnotations, ToolDefinition, ToolExposure, ToolNamespace } from "../../core/extensions/types.ts";
import { READ_MCP_RESOURCE_TOOL } from "../../core/mcp-servers.ts";
import { getTextOutput, replaceTabs } from "../../core/tools/render-utils.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { McpExposure } from "./config.ts";
import { McpOutputPreview, truncateMiddle, writeMcpOutputFile } from "./output.ts";

/** MCP supports direct, deferred, codemode, and hidden exposure. */
export function toToolExposure(exposure: McpExposure): ToolExposure {
	return exposure;
}

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;
/** Model-facing text of an MCP result beyond this is cut in the middle. */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
/** Visual (wrapped) result lines shown before the output is expanded. */
const OUTPUT_PREVIEW_LINES = 5;
/** Tool that reads the resources named by resource links. */
export { READ_MCP_RESOURCE_TOOL };

export interface McpToolDetails {
	server: string;
	tool: string;
	/** Temp file with the full text output, when the model-facing text was truncated. */
	fullOutputPath?: string;
}

/**
 * Saves the full text of a truncated result, or a binary resource, and returns the file path.
 * `extension` includes the dot, for example `.txt`.
 */
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>;

export function saveToTempFile(data: string | Uint8Array, extension: string): Promise<string> {
	return writeMcpOutputFile(data, extension);
}

export interface McpToolCaller {
	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult>;
}

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. Like Codex,
 * everything but `[A-Za-z0-9_]` becomes `_`. `isTaken` reports names used by a different MCP tool: sanitizing can map two tools to
 * one name (`a-b` and `a_b`), which then get the hash suffix.
 */
export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Keep model-facing text within {@link MCP_OUTPUT_MAX_BYTES}. Longer text becomes one text block in
 * Codex's truncation format, followed by the path of the file with the full text; images follow it.
 */
export async function limitMcpContent(
	content: (TextContent | ImageContent)[],
	saveOutput: McpOutputSaver = saveToTempFile,
): Promise<{ content: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const combined = textOf(content);
	const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
	if (!truncation.truncated) return { content };
	let fullOutputPath: string | undefined;
	let where: string;
	try {
		fullOutputPath = await saveOutput(combined, ".txt");
		where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
	} catch (error) {
		where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	const tokens = Math.ceil(truncation.totalBytes / 4);
	const header = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n`;
	where = truncateMiddle(where, 1024).content;
	const body = truncateMiddle(
		combined,
		MCP_OUTPUT_MAX_BYTES - Buffer.byteLength(header) - Buffer.byteLength(`\n\n${where}`),
	);
	const text = `${header}${body.content}\n\n${where}`;
	return {
		content: [{ type: "text", text }, ...content.filter((block) => block.type === "image")],
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

export interface ConvertMcpResultOptions {
	/** Saves truncated text and binary resources. Default: a temp file. */
	saveOutput?: McpOutputSaver;
	/** Whether the server's resources can be read with `read_mcp_resource`, which resource links then name. */
	readableResources?: boolean;
}

/** File extension for a saved binary resource: the one its URI ends in, else `.bin`. */
function extensionOf(uri: string): string {
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

/** Blobs of these types are shown as text. */
function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const type = mimeType.split(";", 1)[0].trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

/** Model-facing content of one block of `server`'s result. */
async function blockToContent(
	server: string,
	block: ContentBlock,
	options: ConvertMcpResultOptions,
): Promise<(TextContent | ImageContent)[]> {
	if (block.type === "resource_link") {
		const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
		const read = options.readableResources ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")` : "";
		const description = block.description ? `: ${block.description}` : "";
		return [
			{
				type: "text",
				text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
			},
		];
	}
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		const { uri, mimeType, blob } = block.resource;
		const data = Buffer.from(blob, "base64");
		if (isTextMimeType(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
		const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
		try {
			const path = await (options.saveOutput ?? saveToTempFile)(data, extensionOf(uri));
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` }];
		}
	}
	return toLlmContent({ content: [block] });
}

/** Model-facing content of `server`'s content blocks, before the output limit. */
export async function toModelContent(
	server: string,
	blocks: readonly ContentBlock[],
	options: ConvertMcpResultOptions = {},
): Promise<(TextContent | ImageContent)[]> {
	return (await Promise.all(blocks.map((block) => blockToContent(server, block, options)))).flat();
}

/** MCP errors are confirmed unless the server explicitly reports an unknown effect. */
export async function convertMcpResult(
	server: string,
	tool: string,
	result: CallToolResult,
	options: ConvertMcpResultOptions = {},
): Promise<AgentToolResult<McpToolDetails>> {
	// Remote metadata can reduce certainty, never prove an operation did not start.
	const unknownOutcome = result._meta?.["io.easy-pi/execution-outcome"] === "unknown";
	// Without content blocks, toLlmContent falls back to the structured content as JSON.
	const converted: (TextContent | ImageContent)[] =
		result.content.length > 0 ? await toModelContent(server, result.content, options) : toLlmContent(result);
	if ((result.isError || unknownOutcome) && textOf(converted) === "") {
		converted.push({
			type: "text",
			text: `MCP tool ${server}/${tool} returned ${unknownOutcome ? "an unknown execution outcome" : "an error"}`,
		});
	}
	const { content, fullOutputPath } = await limitMcpContent(converted, options.saveOutput);
	const details = { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) };
	// Protocol metadata may contain credentials or private routing information. Scripts get
	// the full, untruncated public result, never _meta.
	const { _meta: _ignored, ...publicResult } = result;
	const structuredContent: CallToolResult = {
		...publicResult,
		content: result.content.map((block): ContentBlock => {
			const { _meta: _blockMeta, ...publicBlock } = block;
			if (publicBlock.type !== "resource") return publicBlock;
			const { _meta: _resourceMeta, ...resource } = publicBlock.resource;
			return { ...publicBlock, resource };
		}),
	};
	if (result.isError || unknownOutcome) {
		throw new AgentToolError(textOf(content), details, {
			executionOutcome: unknownOutcome ? undefined : "confirmed",
			structuredContent,
		});
	}
	return { content, details, structuredContent };
}

/**
 * Tool input schemas must be objects. MCP servers may omit `type`, and some providers reject object
 * schemas without `properties`.
 */
function toParameters(schema: Record<string, unknown>): TSchema {
	return {
		...schema,
		type: schema.type ?? "object",
		...(schema.properties === undefined ? { properties: {} } : {}),
	} as unknown as TSchema;
}

/** Bound error presentation without claiming that a sent request did not execute. */
export async function boundedMcpError(
	server: string,
	tool: string,
	error: unknown,
	provenOutcome?: Exclude<ToolExecutionOutcome, "unknown">,
): Promise<AgentToolError<McpToolDetails>> {
	const { content, fullOutputPath } = await limitMcpContent([
		{ type: "text", text: error instanceof Error ? error.message : String(error) },
	]);
	const outcome = provenOutcome ?? (error instanceof AgentToolError ? error.executionOutcome : "unknown");
	return new AgentToolError(
		textOf(content),
		{ server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
		{
			cause: error,
			...(outcome === "unknown" ? {} : { executionOutcome: outcome }),
		},
	);
}

/** Shape of the public CallToolResult received by scripts (including explicit MCP errors). */
export function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): TSchema {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: { type: "object" } },
			...(structuredContentSchema ? { structuredContent: structuredContentSchema } : {}),
			isError: { type: "boolean" },
			_meta: { type: "object" },
		},
		required: ["content"],
	} as unknown as TSchema;
}

const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The boolean hints of an MCP tool's annotations, or undefined when it has none. */
function toToolAnnotations(tool: McpTool): ToolAnnotations | undefined {
	const annotations: ToolAnnotations = {};
	for (const hint of ANNOTATION_HINTS) {
		const value = tool.annotations?.[hint];
		if (typeof value === "boolean") annotations[hint] = value;
	}
	return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export function createMcpToolDefinition(options: {
	server: string;
	tool: McpTool;
	name: string;
	exposure: McpExposure;
	namespace: ToolNamespace;
	timeoutMs: number;
	getClient: () => Promise<McpToolCaller>;
	/** Whether `read_mcp_resource` can read the server's resources. */
	readableResources?: () => boolean;
}): ToolDefinition<TSchema, McpToolDetails> {
	const { server, tool } = options;
	const title = tool.title ?? tool.annotations?.title;
	const annotations = toToolAnnotations(tool);
	const label = `${server}/${tool.name}`;
	return {
		name: options.name,
		label,
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
		parameters: toParameters(tool.inputSchema),
		outputSchema: createMcpResultSchema(tool.outputSchema),
		contract: { sideEffects: "external" },
		exposure: toToolExposure(options.exposure),
		namespace: options.namespace,
		...(annotations ? { annotations } : {}),
		...createMcpToolRenderers(label),
		async execute(_toolCallId, params, signal, onUpdate) {
			let client: McpToolCaller;
			try {
				signal?.throwIfAborted();
				client = await options.getClient();
				signal?.throwIfAborted();
			} catch (error) {
				throw await boundedMcpError(server, tool.name, error, "not_started");
			}
			let result: CallToolResult;
			try {
				result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
					signal,
					timeoutMs: options.timeoutMs,
					onProgress: (progress) => {
						const total = progress.total === undefined ? "" : `/${progress.total}`;
						const text = progress.message ?? `Progress ${progress.progress}${total}`;
						onUpdate?.({
							content: [{ type: "text", text: truncateMiddle(text, MCP_OUTPUT_MAX_BYTES).content }],
							details: { server, tool: tool.name },
						});
					},
				});
			} catch (error) {
				throw await boundedMcpError(server, tool.name, error);
			}
			return convertMcpResult(server, tool.name, result, { readableResources: options.readableResources?.() });
		},
	};
}

/** Renderers of calls to an MCP tool, labeled `server/tool`, also used before the tool is registered. */
export function createMcpToolRenderers(label: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const argumentText = getTextOutput({ content: [{ type: "text", text: JSON.stringify(args) ?? "" }] }, false);
			const safeLabel = getTextOutput({ content: [{ type: "text", text: label }] }, false);
			component.setText(
				`${theme.fg("toolTitle", theme.bold(safeLabel))} ${theme.fg("muted", truncateMiddle(argumentText, context.expanded ? 4096 : 200).content)}`,
			);
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			const output = getTextOutput(result, context.showImages).trim();
			if (!output) return component;
			const color = context.isError ? "error" : "toolOutput";
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			component.addChild(new Spacer(1));
			if (options.expanded) {
				component.addChild(new Text(styled, 0, 0));
			} else {
				// Limit wrapped lines, not logical ones: MCP results are often one long JSON line.
				component.addChild(
					new McpOutputPreview(
						styled,
						OUTPUT_PREVIEW_LINES,
						(hidden) =>
							`${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					),
				);
				const fullOutputPath = (result.details as McpToolDetails | undefined)?.fullOutputPath;
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
			return component;
		},
	};
}
