import {
	type AgentHarnessTool,
	createEditV2Tool,
	createReadV2Tool,
	createRunV2Tool,
	createSearchV2Tool,
	type ExecutionToolContext,
	type WorkspacePolicy,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { LocalSearchProviderV2 } from "./local-search-provider-v2.ts";

export type ToolProfile = "legacy" | "v2";

export const V2_TOOL_NAMES = ["search", "read", "edit", "run"] as const;

export interface CreateV2ToolDefinitionsOptions {
	shellPath?: string;
	autoResizeImages?: boolean;
	workspacePolicy?: WorkspacePolicy;
}

const promptContributions = {
	search: {
		snippet: "Search workspace text or file paths (literal by default)",
		guidelines: ["Use search instead of run for text and file discovery."],
	},
	read: {
		snippet: "Read bounded file ranges, directories, and images",
		guidelines: ["Continue bounded reads with the returned offset or byteOffset."],
	},
	edit: {
		snippet: "Create, update, move, or delete files in one structured batch",
		guidelines: ["Use edit for file mutations; make exact updates from freshly read content."],
	},
	run: {
		snippet: "Run builds, tests, Git, and other commands in an explicit cwd",
		guidelines: ["Use run for commands, not for searching, reading, or editing files."],
	},
} as const;

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function renderCall(name: string, args: object, theme: Theme): Text {
	const value = Object.values(args).find((candidate) => typeof candidate === "string");
	const suffix = typeof value === "string" && value.length > 0 ? ` ${value}` : "";
	return new Text(theme.fg("toolTitle", theme.bold(name)) + theme.fg("accent", suffix), 0, 0);
}

function renderResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	const lines = textOutput(result).trim().split("\n");
	const visible = options.expanded ? lines : lines.slice(0, 20);
	const remaining = lines.length - visible.length;
	const suffix = remaining > 0 ? `\n... (${remaining} more lines)` : "";
	return new Text(theme.fg("toolOutput", `${visible.join("\n")}${suffix}`), 0, 0);
}

function bindV2Tool<TParameters extends TSchema, TDetails>(
	tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
	context: ExecutionToolContext,
): ToolDefinition<TParameters, TDetails> {
	const prompt = promptContributions[tool.name as keyof typeof promptContributions];
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		promptSnippet: prompt.snippet,
		promptGuidelines: [...prompt.guidelines],
		constrainedSampling: getExperimentalToolSampling(),
		executionMode: tool.executionMode,
		execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate, context),
		renderCall: (args, theme) => renderCall(tool.name, args, theme),
		renderResult: (result, options, theme) => renderResult(result, options, theme),
	};
}

/** Create the four coding-agent definitions for the opt-in v2 profile. */
export function createV2ToolDefinitions(
	cwd: string,
	options: CreateV2ToolDefinitionsOptions = {},
): Record<(typeof V2_TOOL_NAMES)[number], ToolDefinition<any, any>> {
	const env = new NodeExecutionEnv({ cwd, shellPath: options.shellPath });
	const searchProvider = new LocalSearchProviderV2();
	const context: ExecutionToolContext = {
		env,
		searchProvider,
		workspacePolicy: options.workspacePolicy,
	};
	return {
		search: bindV2Tool(createSearchV2Tool(), context),
		read: bindV2Tool(
			createReadV2Tool({
				autoResizeImages: options.autoResizeImages,
				imageProcessor: processImage,
			}),
			context,
		),
		edit: bindV2Tool(createEditV2Tool(), context),
		run: bindV2Tool(createRunV2Tool(), context),
	};
}
