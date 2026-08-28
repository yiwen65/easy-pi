import {
	type AgentHarnessTool,
	createEditV2Tool,
	createReadV2Tool,
	createRunV2Tool,
	createSearchV2Tool,
	type ExecutionToolContext,
	type RunV2Details,
	type SearchProvider,
	type SearchV2Details,
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
	/** Directly injected providers are host-owned and must be closed by their caller. */
	searchProvider?: SearchProvider;
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

const SEARCH_PREVIEW_HITS = 8;

function renderSearchCall(
	args: {
		query?: unknown;
		kind?: unknown;
		path?: unknown;
		fileGlob?: unknown;
		case?: unknown;
		regex?: unknown;
		context?: unknown;
		ranking?: unknown;
	},
	theme: Theme,
	context: ToolRenderContext,
): Text {
	const query = typeof args.query === "string" ? args.query : "...";
	const kind = args.kind === "files" || args.kind === "glob" ? args.kind : "text";
	const mode =
		kind === "text"
			? args.regex === true
				? "regex"
				: "literal"
			: kind === "files"
				? (args.ranking ?? "fast")
				: "exact";
	const metadata = [kind, String(mode)];
	if (kind === "text") metadata.push(typeof args.case === "string" ? args.case : "smart");
	if (typeof args.context === "number" && args.context > 0) metadata.push(`context ${args.context}`);
	if (typeof args.path === "string" && args.path.length > 0) metadata.push(args.path);
	if (typeof args.fileGlob === "string" && args.fileGlob.length > 0) metadata.push(args.fileGlob);
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(
		theme.fg("toolTitle", theme.bold("search")) +
			theme.fg("accent", ` ${JSON.stringify(query)}`) +
			theme.fg("muted", ` · ${metadata.join(" · ")}`),
	);
	return component;
}

function highlightSearchRanges(text: string, ranges: Array<[number, number]>, theme: Theme): string {
	const normalized = ranges
		.map(
			([start, end]) =>
				[Math.max(0, Math.min(text.length, start)), Math.max(0, Math.min(text.length, end))] as const,
		)
		.filter(([start, end]) => end > start)
		.sort(([left], [right]) => left - right);
	let cursor = 0;
	let output = "";
	for (const [start, end] of normalized) {
		if (start < cursor) continue;
		output += theme.fg("toolOutput", text.slice(cursor, start));
		output += theme.fg("accent", theme.bold(text.slice(start, end)));
		cursor = end;
	}
	output += theme.fg("toolOutput", text.slice(cursor));
	return output;
}

class SearchResultRenderComponent extends Container {
	private details: SearchV2Details | undefined;
	private options: ToolRenderResultOptions = { expanded: false, isPartial: false };
	private renderTheme: Theme | undefined;

	setResult(details: SearchV2Details, options: ToolRenderResultOptions, theme: Theme): void {
		this.details = details;
		this.options = options;
		this.renderTheme = theme;
		this.invalidate();
	}

	override render(width: number): string[] {
		const details = this.details;
		const theme = this.renderTheme;
		if (!details || !theme) return [];
		const visibleHits = this.options.expanded ? details.hits : details.hits.slice(0, SEARCH_PREVIEW_HITS);
		const lines: string[] = [""];
		const status = [details.approximate ? "approximate" : "exact", details.partial ? "partial" : "complete"];
		lines.push(theme.fg(details.partial ? "warning" : "muted", `[${status.join(" · ")}]`));
		let currentPath: string | undefined;
		for (const hit of visibleHits) {
			if (hit.kind === "file") {
				const marker = hit.exact ? "=" : details.approximate ? "~" : "•";
				const kind = hit.pathKind === "directory" ? "/" : "";
				lines.push(`${theme.fg("muted", `${marker} `)}${theme.fg("accent", `${hit.path}${kind}`)}`);
				continue;
			}
			if (hit.path !== currentPath) {
				currentPath = hit.path;
				lines.push(theme.fg("accent", hit.path));
			}
			for (const contextLine of hit.before ?? []) {
				lines.push(`${theme.fg("muted", `  ${contextLine.line}- `)}${theme.fg("muted", contextLine.text)}`);
			}
			lines.push(
				`${theme.fg("muted", `  ${hit.line}:${hit.column} `)}${highlightSearchRanges(hit.text, hit.ranges, theme)}`,
			);
			for (const contextLine of hit.after ?? []) {
				lines.push(`${theme.fg("muted", `  ${contextLine.line}- `)}${theme.fg("muted", contextLine.text)}`);
			}
		}
		const remaining = details.hits.length - visibleHits.length;
		if (remaining > 0) {
			lines.push(
				theme.fg("muted", `... (${remaining} more hits,`) +
					` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
			);
		}
		if (details.nextCursor) lines.push(theme.fg("muted", `Continue with cursor ${details.nextCursor}`));
		if (details.hits.length === 0) lines.push(theme.fg("muted", "No matches found."));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "..."));
	}
}

function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details: SearchV2Details },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): SearchResultRenderComponent | Text {
	if (!result.details || !Array.isArray(result.details.hits)) return renderResult(result, options, theme);
	const component =
		context.lastComponent instanceof SearchResultRenderComponent
			? context.lastComponent
			: new SearchResultRenderComponent();
	component.setResult(result.details, options, theme);
	return component;
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
	cachedHasEarlierOutput: boolean | undefined;
};

class RunResultRenderComponent extends Container {
	state: RunResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedHasEarlierOutput: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function takeRunPreviewSuffix(output: string): { text: string; hasEarlierOutput: boolean } {
	let start = output.length;
	for (let line = 0; line < RUN_PREVIEW_LINES; line++) {
		const newline = output.lastIndexOf("\n", start - 1);
		if (newline === -1) return { text: output, hasEarlierOutput: false };
		start = newline;
	}
	return { text: output.slice(start + 1), hasEarlierOutput: true };
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
		if (options.expanded) {
			const styledOutput = output
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			const suffix = takeRunPreviewSuffix(output);
			const styledSuffix = suffix.text
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledSuffix, RUN_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedHasEarlierOutput = suffix.hasEarlierOutput || preview.skippedCount > 0;
						state.cachedWidth = width;
					}
					if (state.cachedHasEarlierOutput) {
						const hint =
							theme.fg("muted", "... (earlier lines,") +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedHasEarlierOutput = undefined;
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
		renderCall: (args, theme, renderContext) => {
			if (tool.name === "run") return renderRunCall(args, theme, renderContext);
			if (tool.name === "search") return renderSearchCall(args, theme, renderContext);
			return renderCall(tool.name, args, theme);
		},
		renderResult: (result, options, theme, renderContext) => {
			if (tool.name === "run") {
				return renderRunResult(
					result as unknown as { content: Array<{ type: string; text?: string }>; details: RunV2Details },
					options,
					theme,
					renderContext,
				);
			}
			if (tool.name === "search") {
				return renderSearchResult(
					result as unknown as { content: Array<{ type: string; text?: string }>; details: SearchV2Details },
					options,
					theme,
					renderContext,
				);
			}
			return renderResult(result, options, theme);
		},
	};
}

/** Create the four coding-agent definitions for the opt-in v2 profile. */
export function createV2ToolDefinitions(
	cwd: string,
	options: CreateV2ToolDefinitionsOptions = {},
): Record<(typeof V2_TOOL_NAMES)[number], ToolDefinition<any, any>> {
	const env = new NodeExecutionEnv({ cwd, shellPath: options.shellPath });
	const searchProvider: SearchProvider = options.searchProvider ?? new LocalSearchProviderV2(env);
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
