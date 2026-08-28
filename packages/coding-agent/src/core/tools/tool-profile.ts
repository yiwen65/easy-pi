import {
	type AgentHarnessTool,
	createEditV2Tool,
	createReadV2Tool,
	createRunV2Tool,
	createSearchV2Tool,
	type ExecutionToolContext,
	type RunV2Details,
	type WorkspacePolicy,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type {
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../extensions/types.ts";
import { resolveSessionShellEnvironment } from "./bash.ts";
import { LocalSearchProviderV2 } from "./local-search-provider-v2.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

export type ToolProfile = "legacy" | "v2";

export const V2_TOOL_NAMES = ["search", "read", "edit", "run"] as const;

export interface CreateV2ToolDefinitionsOptions {
	shellPath?: string;
	getShellCommandPrefix?: () => string | undefined;
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
		guidelines: [
			"Use edit for file mutations; make exact updates from freshly read content.",
			"When moving and updating the same file, use one edit batch with move first and update on the destination second.",
		],
	},
	run: {
		snippet: "Run builds, tests, Git, and other commands in an explicit cwd",
		guidelines: [
			"Use run for commands, not for searching, reading, or editing files.",
			"You can inspect PI_* environment variables for current model and session details.",
		],
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

const RUN_PREVIEW_LINES = 5;

type RunRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: ReturnType<typeof setInterval> | undefined;
};

type RunResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class RunResultRenderComponent extends Container {
	state: RunResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function renderRunCall(
	args: { command?: unknown; cwd?: unknown; timeout?: unknown },
	theme: Theme,
	context: ToolRenderContext<RunRenderState>,
): Text {
	if (context.executionStarted && context.state.startedAt === undefined) {
		context.state.startedAt = Date.now();
		context.state.endedAt = undefined;
	}
	const command = typeof args.command === "string" && args.command.length > 0 ? args.command : "...";
	const metadata: string[] = [];
	if (typeof args.cwd === "string" && args.cwd.length > 0) metadata.push(`cwd ${args.cwd}`);
	if (typeof args.timeout === "number") metadata.push(`timeout ${args.timeout}s`);
	const suffix = metadata.length > 0 ? theme.fg("muted", ` (${metadata.join(", ")})`) : "";
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(theme.fg("toolTitle", theme.bold(`$ ${command}`)) + suffix);
	return component;
}

function rebuildRunResult(
	component: RunResultRenderComponent,
	result: { content: Array<{ type: string; text?: string }>; details: RunV2Details },
	options: ToolRenderResultOptions,
	theme: Theme,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();
	let output = textOutput(result).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath) {
		const footerStart = output.lastIndexOf("\n\n[Output truncated");
		const footerEnd = footerStart === -1 ? -1 : output.indexOf("]", footerStart);
		if (footerEnd !== -1 && output.slice(footerStart, footerEnd + 1).includes(fullOutputPath)) {
			output = `${output.slice(0, footerStart)}${output.slice(footerEnd + 1)}`.trim();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, RUN_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
		if (truncation?.truncated) {
			warnings.push(
				truncation.truncatedBy === "lines"
					? `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`
					: `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
			);
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		component.addChild(
			new Text(`\n${theme.fg("muted", `${label} ${formatDuration((endedAt ?? Date.now()) - startedAt)}`)}`, 0, 0),
		);
	}
}

function renderRunResult(
	result: { content: Array<{ type: string; text?: string }>; details: RunV2Details },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<RunRenderState>,
): RunResultRenderComponent {
	const state = context.state;
	if (state.startedAt !== undefined && options.isPartial && !state.interval) {
		state.interval = setInterval(() => context.invalidate(), 1000);
	}
	if (!options.isPartial || context.isError) {
		state.endedAt ??= Date.now();
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}
	const component = (context.lastComponent as RunResultRenderComponent | undefined) ?? new RunResultRenderComponent();
	rebuildRunResult(component, result, options, theme, state.startedAt, state.endedAt);
	component.invalidate();
	return component;
}

function bindV2Tool<TParameters extends TSchema, TDetails>(
	tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
	context: ExecutionToolContext,
	getCommandPrefix?: () => string | undefined,
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
		execute: (toolCallId, params, signal, onUpdate, extensionContext: ExtensionContext) => {
			const executionContext =
				tool.name === "run"
					? {
							...context,
							run: {
								commandPrefix: getCommandPrefix?.(),
								env: resolveSessionShellEnvironment(true, extensionContext),
								inheritEnv: false,
							},
						}
					: context;
			return tool.execute(toolCallId, params, signal, onUpdate, executionContext);
		},
		renderCall: (args, theme, renderContext) =>
			tool.name === "run" ? renderRunCall(args, theme, renderContext) : renderCall(tool.name, args, theme),
		renderResult: (result, options, theme, renderContext) =>
			tool.name === "run"
				? renderRunResult(
						result as unknown as { content: Array<{ type: string; text?: string }>; details: RunV2Details },
						options,
						theme,
						renderContext,
					)
				: renderResult(result, options, theme),
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
		run: bindV2Tool(createRunV2Tool(), context, options.getShellCommandPrefix),
	};
}
