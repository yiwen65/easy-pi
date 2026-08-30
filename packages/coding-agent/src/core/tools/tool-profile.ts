import { relative } from "node:path";
import {
	type AgentHarnessTool,
	createEditV2Tool,
	createReadV2Tool,
	createRunV2Tool,
	createSearchV2Tool,
	type EditV2Details,
	type EditV2Dialect,
	type ExecutionEnv,
	ExecutionEnvMutationBackend,
	ExecutionEnvReadProvider,
	ExecutionEnvSearchProvider,
	type ExecutionToolContext,
	HookedMutationBackend,
	type MutationBackend,
	type MutationBackendHooks,
	type MutationLimits,
	type ReadProvider,
	type ReadV2Details,
	type ResourceReader,
	type RunV2Details,
	type SearchCapabilities,
	type SearchProvider,
	type SearchV2Details,
	type SymbolReadProvider,
	ToolStateLedger,
	type WorkspacePolicy,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { processImage } from "../../utils/image-process.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type {
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../extensions/types.ts";
import { resolveSessionShellEnvironment } from "./bash.ts";
import { FffSearchProvider } from "./fff-search-provider.ts";
import { NodeReadProviderV2 } from "./node-read-provider-v2.ts";
import { replaceTabs } from "./render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";
import { TypeScriptCodeIndexProvider } from "./typescript-code-index-provider.ts";

export type ToolProfile = "legacy" | "v2";

export const V2_TOOL_NAMES = ["search", "read", "edit", "run"] as const;

export type V2SessionResourceSource<T> = T | (() => T);
export type V2CodeIndexProvider = SearchProvider & SymbolReadProvider;

// The runtime registry is intentionally heterogeneous across four schemas/detail types.
type V2ToolDefinition = ToolDefinition<any, any>;

export interface CreateV2ToolDefinitionsOptions {
	shellPath?: string;
	getShellCommandPrefix?: () => string | undefined;
	autoResizeImages?: boolean;
	workspacePolicy?: WorkspacePolicy;
	/** Instances are host-owned; factory results and the default Node environment are session-owned. */
	executionEnv?: V2SessionResourceSource<ExecutionEnv>;
	/** Instances are host-owned; factory results are session-owned. */
	searchProvider?: V2SessionResourceSource<SearchProvider>;
	/** JS/TS structured Search plus symbol/AST Read. Defaults locally on Node; false explicitly disables it. */
	codeIndexProvider?: V2SessionResourceSource<V2CodeIndexProvider> | false;
	/** Remote semantic Search is never created implicitly. */
	semanticSearchProvider?: V2SessionResourceSource<SearchProvider>;
	/** Instances are host-owned; factory results are session-owned. */
	readProvider?: V2SessionResourceSource<ReadProvider>;
	resourceReaders?: Array<V2SessionResourceSource<ResourceReader>>;
	/** Instances are host-owned; factory results are session-owned. */
	mutationBackend?: V2SessionResourceSource<MutationBackend>;
	mutationHooks?: MutationBackendHooks;
	editDialect?: EditV2Dialect;
	editLimits?: Partial<MutationLimits>;
}

export interface V2ToolRuntimeHandle {
	readonly definitions: Record<(typeof V2_TOOL_NAMES)[number], V2ToolDefinition>;
	readonly lifecycleErrors: readonly Error[];
	toolEvidenceSummary(): string | undefined;
	reload(): Promise<Record<(typeof V2_TOOL_NAMES)[number], V2ToolDefinition>>;
	close(): Promise<void>;
}

const promptContributions = {
	search: {
		snippet: "Locate code as bounded locators with explicit scope, semantics, ranking, and coverage",
		guidelines: [
			"Use search instead of run for discovery. Start with the narrowest justified path and explicit literal, regex, or JS/TS query-template semantics; use include/exclude and preferredPaths only when the task supports them.",
			"Use concept/semantic candidates only when naming is unknown and a remote provider was explicitly configured; verify candidates with structured/literal Search and Read before Edit.",
			"Same-file results are grouped but each locator remains independently readable. Never infer absence from partial, overflow, truncated, skipped, or unsupported results; narrow one query dimension and search again.",
			"Choose either mode or queryTemplate, not both. Structured/semantic Search requires kind=text and context=0; omit targetKind for concept search, otherwise pair it exactly with the requested structured mode. Set ranking only when its value is exposed by the session schema.",
		],
	},
	read: {
		snippet: "Read a locator or bounded range into a numbered, versioned view",
		guidelines: [
			"Read a selected locator or JS/TS symbol/AST node with a small window first, then expand progressively; do not page from the start of a large file.",
			"Use the returned view_id, file_hash, true line range, and continuation metadata for editing or further reads.",
		],
	},
	edit: {
		snippet: "Prepare and commit view/hash/range-bound file changes",
		guidelines: [
			"For updates, use freshly read view_id/file_hash evidence, an exact range, and exactly_one_in_range; never choose the first of multiple matches or imply replace-all.",
			"Use edit action=prepare, inspect the bounded diff, commit its patchId, then read the changed range and run the smallest relevant verification.",
			"On partial or indeterminate commit, read every changed or unknown path and do not replay blindly. When moving and updating the same file, use one edit batch with move first and update on the destination second.",
		],
	},
	run: {
		snippet: "Run builds, tests, Git, and other commands in an explicit cwd",
		guidelines: [
			"Use run for the smallest focused verification, not for searching, reading, or editing files. Nonzero exits and timeouts are visible results that require inspection and recovery.",
			"You can inspect PI_* environment variables for current model and session details.",
		],
	},
} as const;

function promptContribution(name: keyof typeof promptContributions, context: ExecutionToolContext) {
	const prompt = promptContributions[name];
	if (name === "search") {
		const base = context.searchProvider?.capabilities;
		const structured = (context.structuredSearchProvider?.capabilities.structuredModes?.length ?? 0) > 0;
		const semantic =
			context.semanticSearchProvider?.capabilities.structuredModes?.includes("semantic_candidate") === true;
		const literal = base?.textLiteral === true;
		const regex = base?.textRegex === true;
		const paths = base?.fuzzyFiles === true || base?.glob === true;
		if (!structured && !semantic) {
			if (!literal && !regex) {
				return {
					snippet: prompt.snippet,
					guidelines: [
						"This session supports path Search only. Use files or glob with an explicit kind.",
						"Do not use literal, regex, structured, or semantic Search; no text, AST, or semantic provider is configured.",
						promptContributions.search.guidelines[2],
					],
				};
			}
			const textModes = literal && regex ? "literal/regex" : literal ? "literal" : "regex";
			return {
				snippet: prompt.snippet,
				guidelines: [
					`This session supports ${textModes} text${paths ? " and path" : ""} Search only.`,
					"Do not use structured or semantic modes, query templates, structured targetKind values, or task ranking; no AST or semantic provider is configured.",
					promptContributions.search.guidelines[2],
				],
			};
		}
		const guidelines: string[] = [...promptContributions.search.guidelines];
		if (!structured) {
			guidelines[0] = `Use search instead of run for discovery. This session has ${literal || regex ? "text" : "no text"}${paths ? "/path" : ""} and semantic candidate Search, but JS/TS structured modes are unavailable.`;
		}
		if (!semantic) {
			guidelines[1] =
				"Remote concept/semantic candidates are unavailable in this session because no provider was configured; when configured, verify candidates with structured/literal Search and Read before Edit.";
		}
		return { snippet: prompt.snippet, guidelines };
	}
	if (name === "read" && context.symbolReadProvider === undefined) {
		return {
			snippet: prompt.snippet,
			guidelines: [
				"Read a selected locator or bounded path range with a small window first, then expand progressively; do not page from the start of a large file.",
				"Symbol and AST reads are unavailable in this session; use a locator or bounded path range.",
				promptContributions.read.guidelines[1],
			],
		};
	}
	return { snippet: prompt.snippet, guidelines: [...prompt.guidelines] };
}

function mergeSearchCapabilities(providers: Array<SearchProvider | undefined>): SearchCapabilities {
	const capabilities = providers.flatMap((provider) => (provider ? [provider.capabilities] : []));
	return {
		textLiteral: capabilities.some((entry) => entry.textLiteral),
		textRegex: capabilities.some((entry) => entry.textRegex),
		context: capabilities.some((entry) => entry.context),
		fuzzyFiles: capabilities.some((entry) => entry.fuzzyFiles),
		glob: capabilities.some((entry) => entry.glob),
		stableCursor: capabilities.some((entry) => entry.stableCursor),
		globalRanking: capabilities.length > 0 && capabilities.every((entry) => entry.globalRanking),
		taskRanking: capabilities.length > 0 && capabilities.every((entry) => entry.taskRanking),
		scopeFilters: capabilities.some((entry) => entry.scopeFilters),
		wordBoundary: capabilities.some((entry) => entry.wordBoundary),
		structuredModes: [...new Set(capabilities.flatMap((entry) => entry.structuredModes ?? []))],
	};
}

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

const READ_PREVIEW_LINES = 12;
const READ_PREVIEW_ENTRIES = 12;

function renderReadCall(
	args: {
		path?: unknown;
		locatorId?: unknown;
		startLine?: unknown;
		endLine?: unknown;
		offset?: unknown;
		limit?: unknown;
		maxLines?: unknown;
		maxBytes?: unknown;
		byteOffset?: unknown;
		cursor?: unknown;
	},
	theme: Theme,
	context: ToolRenderContext,
): Text {
	const target =
		typeof args.locatorId === "string" ? args.locatorId : typeof args.path === "string" ? args.path : "...";
	const metadata: string[] = [];
	const startLine = typeof args.startLine === "number" ? args.startLine : args.offset;
	if (typeof startLine === "number") {
		metadata.push(typeof args.endLine === "number" ? `lines ${startLine}-${args.endLine}` : `line ${startLine}`);
	}
	const maxLines = typeof args.maxLines === "number" ? args.maxLines : args.limit;
	if (typeof maxLines === "number") metadata.push(`max ${maxLines} lines`);
	if (typeof args.maxBytes === "number") metadata.push(`${formatSize(args.maxBytes)} output`);
	if (typeof args.byteOffset === "number") metadata.push(`byte ${args.byteOffset}`);
	if (typeof args.cursor === "string") metadata.push("snapshot continuation");
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(
		theme.fg("toolTitle", theme.bold("read")) +
			theme.fg("accent", ` ${safeInlineDisplay(target)}`) +
			(metadata.length > 0 ? theme.fg("muted", ` · ${metadata.join(" · ")}`) : ""),
	);
	return component;
}

class ReadResultRenderComponent extends Container {
	private details: ReadV2Details | undefined;
	private options: ToolRenderResultOptions = { expanded: false, isPartial: false };
	private renderTheme: Theme | undefined;

	setResult(details: ReadV2Details, options: ToolRenderResultOptions, theme: Theme): void {
		this.details = details;
		this.options = options;
		this.renderTheme = theme;
		this.invalidate();
	}

	override render(width: number): string[] {
		const details = this.details;
		const theme = this.renderTheme;
		if (!details || !theme) return [];
		const lines: string[] = [""];
		if (details.kind === "text") {
			if (details.viewId) {
				const evidence = details.fileHash
					? `${details.viewId} · ${details.fileHash.slice(0, 19)}…`
					: `${details.viewId} · non-editable`;
				lines.push(theme.fg(details.editable ? "muted" : "warning", `[${evidence}]`));
			}
			const sourceLines = details.lines ?? [];
			const visible = this.options.expanded ? sourceLines : sourceLines.slice(0, READ_PREVIEW_LINES);
			const safeVisible = visible.map(safeLineDisplay);
			const language = getLanguageFromPath(details.path);
			const highlighted = language ? highlightCode(replaceTabs(safeVisible.join("\n")), language) : safeVisible;
			const startLine = details.range?.[0] ?? 1;
			const gutterWidth = String(startLine + Math.max(0, visible.length - 1)).length;
			for (let index = 0; index < visible.length; index++) {
				const code = language
					? (highlighted[index] ?? "")
					: theme.fg("toolOutput", replaceTabs(safeVisible[index]));
				const location =
					details.byteRange && index === 0
						? `@${details.byteRange[0]}`
						: String(startLine + index).padStart(gutterWidth, " ");
				lines.push(`${theme.fg("muted", location)} ${code}`);
			}
			const remaining = sourceLines.length - visible.length;
			if (remaining > 0) lines.push(theme.fg("muted", `... (${remaining} more lines in this page)`));
		} else if (details.kind === "directory") {
			const entries = details.entries ?? [];
			const visible = this.options.expanded ? entries : entries.slice(0, READ_PREVIEW_ENTRIES);
			for (const entry of visible) {
				const suffix = entry.kind === "directory" ? "/" : "";
				const metadata = entry.size === undefined ? "" : ` ${formatSize(entry.size)}`;
				lines.push(
					`${theme.fg("accent", `${safeInlineDisplay(entry.name)}${suffix}`)}${theme.fg("muted", ` · ${entry.kind}${metadata}`)}`,
				);
			}
			if (entries.length > visible.length) {
				lines.push(theme.fg("muted", `... (${entries.length - visible.length} more entries in this page)`));
			}
			lines.push(
				theme.fg(details.stable ? "muted" : "warning", details.stable ? "[stable snapshot]" : "[best effort]"),
			);
		} else {
			const label = details.kind === "image" ? "image" : "resource";
			const metadata = [details.mediaType, details.size === undefined ? undefined : formatSize(details.size)]
				.filter((value): value is string => value !== undefined)
				.join(" · ");
			lines.push(theme.fg("muted", `[${label}${metadata ? ` · ${safeInlineDisplay(metadata)}` : ""}]`));
		}
		if (details.nextOffset !== undefined) lines.push(theme.fg("muted", `Continue with offset ${details.nextOffset}`));
		if (details.nextByteOffset !== undefined)
			lines.push(theme.fg("muted", `Continue with byteOffset ${details.nextByteOffset}`));
		if (details.nextCursor) lines.push(theme.fg("muted", `Continue with cursor ${details.nextCursor}`));
		if (details.truncation) lines.push(theme.fg("warning", `[truncated by ${details.truncation.reason}]`));
		if (details.partial) lines.push(theme.fg("warning", "[partial directory page]"));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "..."));
	}
}

function renderReadResult(
	result: { content: Array<{ type: string; text?: string }>; details: ReadV2Details },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): ReadResultRenderComponent | Text {
	if (!result.details || typeof result.details.kind !== "string") return renderResult(result, options, theme);
	const component =
		context.lastComponent instanceof ReadResultRenderComponent
			? context.lastComponent
			: new ReadResultRenderComponent();
	component.setResult(result.details, options, theme);
	return component;
}

function safeInlineDisplay(value: string): string {
	return sanitizeBinaryOutput(stripAnsi(value))
		.replaceAll("\t", "\\t")
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n");
}

function safeLineDisplay(value: string): string {
	return sanitizeBinaryOutput(stripAnsi(value)).replaceAll("\r", "");
}

const EDIT_PREVIEW_FILES = 3;
const EDIT_PREVIEW_DIFF_LINES = 8;
const EDIT_MAX_EXPANDED_DIFF_LINES = 200;
const EDIT_MAX_RENDER_LINES = 2000;

function renderEditCall(
	args: {
		action?: unknown;
		dryRun?: unknown;
		patchId?: unknown;
		operations?: unknown;
		path?: unknown;
		edits?: unknown;
		patch?: unknown;
	},
	theme: Theme,
	context: ToolRenderContext,
): Text {
	let summary = "structured edit";
	if (args.action === "commit" && typeof args.patchId === "string") {
		summary = `commit ${safeInlineDisplay(args.patchId)}`;
	} else if (Array.isArray(args.operations)) {
		const paths = args.operations
			.flatMap((operation) =>
				typeof operation === "object" && operation !== null && "path" in operation
					? [safeInlineDisplay(String(operation.path))]
					: [],
			)
			.slice(0, 2);
		summary = `${args.operations.length} operation(s)${paths.length > 0 ? ` · ${paths.join(", ")}` : ""}`;
	} else if (typeof args.path === "string") {
		summary = `${safeInlineDisplay(args.path)} · ${Array.isArray(args.edits) ? args.edits.length : 0} replacement(s)`;
	} else if (typeof args.patch === "string") {
		summary = "Pi Edit Patch v1";
	}
	const phase =
		args.action === "prepare" || args.dryRun === true ? "prepare" : args.action === "commit" ? "commit" : "apply";
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(theme.fg("toolTitle", theme.bold("edit")) + theme.fg("muted", ` · ${phase} · ${summary}`));
	return component;
}

function styleEditDiffLine(line: string, theme: Theme): string {
	const safeLine = safeLineDisplay(line);
	if (safeLine.startsWith("+")) return theme.fg("success", safeLine);
	if (safeLine.startsWith("-")) return theme.fg("error", safeLine);
	return theme.fg("muted", safeLine);
}

class StructuredEditErrorComponent extends Container {
	private lines: string[] = [];

	setLines(lines: string[]): void {
		this.lines = lines;
		this.invalidate();
	}

	override render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, Math.max(1, width), "..."));
	}
}

function renderStructuredEditError(
	details: unknown,
	theme: Theme,
	context: ToolRenderContext,
): StructuredEditErrorComponent | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const record = details as Record<string, unknown>;
	const lines = [""];
	if (typeof record.failedOperationIndex === "number") {
		lines.push(theme.fg("error", `[partial commit · failed operation ${record.failedOperationIndex}]`));
		if (Array.isArray(record.changedPaths)) {
			lines.push(
				theme.fg(
					"warning",
					`Changed: ${record.changedPaths.map(String).map(safeInlineDisplay).join(", ") || "none"}`,
				),
			);
		}
		if (Array.isArray(record.unknownPaths)) {
			lines.push(
				theme.fg(
					"error",
					`Inspect: ${record.unknownPaths.map(String).map(safeInlineDisplay).join(", ") || "none"}`,
				),
			);
		}
	} else {
		const recovery =
			typeof record.recovery === "object" && record.recovery !== null
				? (record.recovery as Record<string, unknown>)
				: undefined;
		if (recovery?.kind === "split_edit") lines.push(theme.fg("error", "[edit plan too large · split the edit]"));
		else if (recovery?.kind === "read_again") lines.push(theme.fg("error", "[stale edit · no files changed]"));
		else if (recovery?.kind === "prepare_edit") lines.push(theme.fg("error", "[stale patch · prepare again]"));
		else return undefined;
		if (Array.isArray(record.paths) && record.paths.length > 0) {
			lines.push(theme.fg("warning", `Read again: ${record.paths.map(String).map(safeInlineDisplay).join(", ")}`));
		}
	}
	const component =
		context.lastComponent instanceof StructuredEditErrorComponent
			? context.lastComponent
			: new StructuredEditErrorComponent();
	component.setLines(lines);
	return component;
}

class EditResultRenderComponent extends Container {
	private details: EditV2Details | undefined;
	private options: ToolRenderResultOptions = { expanded: false, isPartial: false };
	private renderTheme: Theme | undefined;

	setResult(details: EditV2Details, options: ToolRenderResultOptions, theme: Theme): void {
		this.details = details;
		this.options = options;
		this.renderTheme = theme;
		this.invalidate();
	}

	override render(width: number): string[] {
		const details = this.details;
		const theme = this.renderTheme;
		if (!details || !theme) return [];
		const lines: string[] = [""];
		if (details.status === "prepared") {
			lines.push(theme.fg("warning", `[prepared ${details.patchId ?? "patch"} · workspace unchanged]`));
		} else if (details.status === "applied") {
			lines.push(theme.fg("success", "[applied]"));
		}
		const visibleFiles = this.options.expanded ? details.files : details.files.slice(0, EDIT_PREVIEW_FILES);
		for (const file of visibleFiles) {
			const location = file.firstChangedLine === undefined ? "" : ` · line ${file.firstChangedLine}`;
			lines.push(
				theme.fg(
					file.status === "deleted" ? "error" : "success",
					`${file.status} ${safeInlineDisplay(file.path)}${location}`,
				),
			);
			const diffLines = file.diff ? file.diff.split("\n") : [];
			const limit = this.options.expanded ? EDIT_MAX_EXPANDED_DIFF_LINES : EDIT_PREVIEW_DIFF_LINES;
			for (const line of diffLines.slice(0, limit)) lines.push(styleEditDiffLine(line, theme));
			if (diffLines.length > limit) {
				lines.push(theme.fg("muted", `... (${diffLines.length - limit} more diff lines for this file)`));
			}
		}
		if (details.files.length > visibleFiles.length) {
			lines.push(
				theme.fg("muted", `... (${details.files.length - visibleFiles.length} more changed files,`) +
					` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
			);
		}
		if (details.files.length === 0) lines.push(theme.fg("muted", "No net content changes."));
		if (details.pendingAcceptance) {
			lines.push(
				theme.fg(
					"warning",
					`[overlay ${safeInlineDisplay(details.pendingAcceptance.id)} awaits host accept/discard]`,
				),
			);
		}
		const pathLabel = details.status === "prepared" ? "planned path(s)" : "changed path(s)";
		lines.push(theme.fg("muted", `[${details.dialect} · ${details.changedPaths.length} ${pathLabel}]`));
		if (lines.length > EDIT_MAX_RENDER_LINES) {
			lines.length = EDIT_MAX_RENDER_LINES;
			lines.push(theme.fg("warning", "[render truncated at 2000 lines]"));
		}
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "..."));
	}
}

function renderEditResult(
	result: { content: Array<{ type: string; text?: string }>; details: unknown },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): EditResultRenderComponent | StructuredEditErrorComponent | Text {
	if (context.isError) {
		const errorComponent = renderStructuredEditError(result.details, theme, context);
		if (errorComponent) return errorComponent;
	}
	if (
		typeof result.details !== "object" ||
		result.details === null ||
		!("files" in result.details) ||
		!Array.isArray(result.details.files)
	) {
		return renderResult(result, options, theme);
	}
	const component =
		context.lastComponent instanceof EditResultRenderComponent
			? context.lastComponent
			: new EditResultRenderComponent();
	component.setResult(result.details as unknown as EditV2Details, options, theme);
	return component;
}

const SEARCH_PREVIEW_HITS = 8;

function renderSearchCall(
	args: {
		query?: unknown;
		kind?: unknown;
		mode?: unknown;
		targetKind?: unknown;
		path?: unknown;
		fileGlob?: unknown;
		case?: unknown;
		regex?: unknown;
		context?: unknown;
		ranking?: unknown;
		queryTemplate?: unknown;
		preferredPaths?: unknown;
		maxResultsGlobal?: unknown;
		maxResultsPerFile?: unknown;
		maxFiles?: unknown;
	},
	theme: Theme,
	context: ToolRenderContext,
): Text {
	const query = typeof args.query === "string" ? args.query : "...";
	const kind = args.kind === "files" || args.kind === "glob" ? args.kind : "text";
	const mode =
		kind === "text"
			? typeof args.mode === "string"
				? args.mode
				: typeof args.queryTemplate === "string"
					? args.queryTemplate
					: args.regex === true
						? "regex"
						: "literal"
			: kind === "files"
				? (args.ranking ?? "fast")
				: "exact";
	const metadata = [kind, String(mode)];
	if (typeof args.targetKind === "string") metadata.push(args.targetKind);
	if (kind === "text") metadata.push(typeof args.case === "string" ? args.case : "smart");
	if (typeof args.queryTemplate === "string") metadata.push(`template ${args.queryTemplate}`);
	if (Array.isArray(args.preferredPaths) && args.preferredPaths.length > 0) {
		metadata.push(`${args.preferredPaths.length} preferred path(s)`);
	}
	if (typeof args.context === "number" && args.context > 0) metadata.push(`context ${args.context}`);
	if (typeof args.path === "string" && args.path.length > 0) metadata.push(safeInlineDisplay(args.path));
	if (typeof args.fileGlob === "string" && args.fileGlob.length > 0) metadata.push(safeInlineDisplay(args.fileGlob));
	if (typeof args.maxResultsGlobal === "number") metadata.push(`max ${args.maxResultsGlobal}`);
	if (typeof args.maxResultsPerFile === "number") metadata.push(`${args.maxResultsPerFile}/file`);
	if (typeof args.maxFiles === "number") metadata.push(`${args.maxFiles} files`);
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(
		theme.fg("toolTitle", theme.bold("search")) +
			theme.fg("accent", ` ${JSON.stringify(query)}`) +
			theme.fg("muted", ` · ${metadata.join(" · ")}`),
	);
	return component;
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
		const visibleLocators = this.options.expanded ? details.locators : details.locators.slice(0, SEARCH_PREVIEW_HITS);
		const lines: string[] = [""];
		const count =
			details.coverage.matchedCount === undefined
				? `${details.coverage.returnedCount} returned`
				: `${details.coverage.returnedCount}/${details.coverage.matchedCount} ${details.coverage.matchedCountRelation}`;
		const status = [details.status, count];
		if (details.approximate) status.push("approximate");
		if (details.coverage.truncatedBy) status.push(`truncated: ${details.coverage.truncatedBy}`);
		if (details.coverage.skipped.length > 0) status.push(`${details.coverage.skipped.length} skipped`);
		lines.push(theme.fg(details.status === "complete" ? "muted" : "warning", `[${status.join(" · ")}]`));
		const visibleGroups = new Map<string, typeof visibleLocators>();
		for (const locator of visibleLocators) {
			const group = visibleGroups.get(locator.path) ?? [];
			group.push(locator);
			visibleGroups.set(locator.path, group);
		}
		for (const [path, locators] of visibleGroups) {
			lines.push(theme.fg("accent", safeInlineDisplay(path)));
			for (const locator of locators) {
				const position = locator.startLine ? `${locator.startLine}:${locator.startColumn ?? 1}` : "file";
				const match = locator.match ? ` · ${JSON.stringify(safeInlineDisplay(locator.match))}` : "";
				lines.push(
					`  ${theme.fg("muted", safeInlineDisplay(locator.locatorId))} ${theme.fg("accent", position)}${theme.fg("muted", ` · ${safeInlineDisplay(locator.matchKind)}`)}${theme.fg("toolOutput", match)}`,
				);
			}
		}
		const remaining = details.locators.length - visibleLocators.length;
		if (remaining > 0) {
			lines.push(
				theme.fg("muted", `... (${remaining} more locators,`) +
					` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
			);
		}
		if (details.nextCursor) lines.push(theme.fg("muted", `Continue with cursor ${details.nextCursor}`));
		if (details.locators.length === 0) {
			lines.push(
				theme.fg(
					details.status === "complete" ? "muted" : "warning",
					details.status === "complete"
						? "No matches in the fully covered scope."
						: "No returned locator; coverage is incomplete.",
				),
			);
		}
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "..."));
	}
}

function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details: SearchV2Details },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): SearchResultRenderComponent | Text {
	if (!result.details || !Array.isArray(result.details.locators)) return renderResult(result, options, theme);
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
	const prompt = promptContribution(tool.name as keyof typeof promptContributions, context);
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		promptSnippet: prompt.snippet,
		promptGuidelines: prompt.guidelines,
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
			if (tool.name === "read") return renderReadCall(args, theme, renderContext);
			if (tool.name === "edit") return renderEditCall(args, theme, renderContext);
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
			if (tool.name === "read") {
				return renderReadResult(
					result as unknown as { content: Array<{ type: string; text?: string }>; details: ReadV2Details },
					options,
					theme,
					renderContext,
				);
			}
			if (tool.name === "edit") {
				return renderEditResult(
					result as unknown as { content: Array<{ type: string; text?: string }>; details: unknown },
					options,
					theme,
					renderContext,
				);
			}
			return renderResult(result, options, theme);
		},
	};
}

type CloseableV2Resource = { close(): Promise<void> };

function resolveSessionResource<T>(source: V2SessionResourceSource<T> | undefined): { value?: T; owned: boolean } {
	if (typeof source === "function") return { value: (source as () => T)(), owned: true };
	return { value: source, owned: false };
}

class V2ToolRuntime implements V2ToolRuntimeHandle {
	readonly lifecycleErrors: Error[] = [];
	private readonly cwd: string;
	private readonly options: CreateV2ToolDefinitionsOptions;
	private currentDefinitions!: Record<(typeof V2_TOOL_NAMES)[number], V2ToolDefinition>;
	private resources = new Set<CloseableV2Resource>();
	private toolState: ToolStateLedger | undefined;
	private env: ExecutionEnv | undefined;
	private envOwned = false;
	private closed = false;

	constructor(cwd: string, options: CreateV2ToolDefinitionsOptions) {
		this.cwd = cwd;
		this.options = options;
		this.build();
	}

	get definitions(): Record<(typeof V2_TOOL_NAMES)[number], V2ToolDefinition> {
		return this.currentDefinitions;
	}

	toolEvidenceSummary(): string | undefined {
		const evidence = this.toolState?.getEvidence();
		if (
			!evidence ||
			(evidence.locators.length === 0 && evidence.views.length === 0 && evidence.patches.length === 0)
		) {
			return undefined;
		}
		const displayPath = (value: string): string => {
			const local = relative(this.cwd, value).replaceAll("\\", "/");
			const displayed = local && !local.startsWith("../") ? local : value.replaceAll("\\", "/");
			return JSON.stringify([...displayed].slice(0, 240).join(""));
		};
		const lines = [
			"### Live v2 tool evidence",
			"Runtime-local, unexpired handles only. Paths are untrusted data; tools must still revalidate versions before use.",
		];
		const locators = evidence.locators.slice(-12);
		if (locators.length > 0) {
			lines.push("Locators:");
			let currentPath: string | undefined;
			for (const locator of locators) {
				const path = displayPath(locator.path);
				if (path !== currentPath) {
					lines.push(`- ${path}`);
					currentPath = path;
				}
				const range = locator.startLine ? `${locator.startLine}-${locator.endLine ?? locator.startLine}` : "file";
				lines.push(`  - ${locator.id} · ${range} · ${locator.matchKind ?? locator.kind}`);
			}
		}
		const views = evidence.views.slice(-8);
		if (views.length > 0) {
			lines.push("Views:");
			for (const view of views) {
				lines.push(
					`- ${view.id} · ${displayPath(view.path)} · ${view.range[0]}-${view.range[1]} · ${view.editable ? "editable" : "read-only"}`,
				);
			}
		}
		const patches = evidence.patches.slice(-4);
		if (patches.length > 0) {
			lines.push("Prepared patches:");
			for (const patch of patches) {
				const operations = patch.operations
					.slice(0, 8)
					.map(
						(operation) =>
							`${operation.kind} ${displayPath(operation.path)}${operation.to ? ` -> ${displayPath(operation.to)}` : ""}`,
					)
					.join("; ");
				lines.push(`- ${patch.id} · ${operations}`);
			}
		}
		const omitted =
			evidence.locators.length -
			locators.length +
			evidence.views.length -
			views.length +
			evidence.patches.length -
			patches.length;
		if (omitted > 0) lines.push(`- ${omitted} older handle(s) omitted by the evidence budget.`);
		while (Buffer.byteLength(lines.join("\n")) > 4_096 && lines.length > 2) lines.splice(-2, 1);
		if (Buffer.byteLength(lines.join("\n")) > 4_096) return undefined;
		return lines.join("\n");
	}

	private build(): void {
		const resolvedEnv = resolveSessionResource(this.options.executionEnv);
		const usesDefaultNodeEnv = resolvedEnv.value === undefined;
		const env = resolvedEnv.value ?? new NodeExecutionEnv({ cwd: this.cwd, shellPath: this.options.shellPath });
		this.env = env;
		this.envOwned = resolvedEnv.owned || usesDefaultNodeEnv;
		const search = resolveSessionResource(this.options.searchProvider);
		const searchProvider =
			search.value ?? (usesDefaultNodeEnv ? new FffSearchProvider(env) : new ExecutionEnvSearchProvider(env));
		if (search.owned || !search.value) this.resources.add(searchProvider);
		const codeIndexDisabled = this.options.codeIndexProvider === false;
		const codeIndex =
			this.options.codeIndexProvider === false
				? { value: undefined, owned: false }
				: resolveSessionResource(this.options.codeIndexProvider);
		const codeIndexProvider =
			codeIndex.value ?? (!codeIndexDisabled && usesDefaultNodeEnv ? new TypeScriptCodeIndexProvider() : undefined);
		if (codeIndexProvider && (codeIndex.owned || !codeIndex.value)) this.resources.add(codeIndexProvider);
		const semantic = resolveSessionResource(this.options.semanticSearchProvider);
		if (semantic.owned && semantic.value) this.resources.add(semantic.value);
		const read = resolveSessionResource(this.options.readProvider);
		const readProvider =
			read.value ??
			(usesDefaultNodeEnv ? new NodeReadProviderV2(env as NodeExecutionEnv) : new ExecutionEnvReadProvider(env));
		if (read.owned || !read.value) this.resources.add(readProvider);
		const backendSource = resolveSessionResource(this.options.mutationBackend);
		const baseMutationBackend = backendSource.value ?? new ExecutionEnvMutationBackend(env);
		if (backendSource.owned || !backendSource.value) this.resources.add(baseMutationBackend);
		const mutationBackend = this.options.mutationHooks
			? new HookedMutationBackend(baseMutationBackend, this.options.mutationHooks)
			: baseMutationBackend;
		const resourceReaders = (this.options.resourceReaders ?? []).map((source) => {
			const resolved = resolveSessionResource(source);
			if (!resolved.value) throw new Error("Resource reader factory returned no reader.");
			if (resolved.owned) this.resources.add(resolved.value);
			return resolved.value;
		});
		const toolState = new ToolStateLedger();
		this.toolState = toolState;
		this.resources.add(toolState);
		const context: ExecutionToolContext = {
			env,
			searchProvider,
			structuredSearchProvider: codeIndexProvider,
			semanticSearchProvider: semantic.value,
			toolState,
			readProvider,
			symbolReadProvider: codeIndexProvider,
			resourceReaders,
			mutationBackend,
			workspacePolicy: this.options.workspacePolicy,
		};
		const searchProviders = [searchProvider, codeIndexProvider, semantic.value];
		this.currentDefinitions = {
			search: bindV2Tool(
				createSearchV2Tool({
					capabilities: mergeSearchCapabilities(searchProviders),
					preferredPaths: searchProviders.some((provider) => provider?.capabilities.taskRanking === true),
				}),
				context,
			),
			read: bindV2Tool(
				createReadV2Tool({
					autoResizeImages: this.options.autoResizeImages,
					imageProcessor: processImage,
				}),
				context,
			),
			edit: bindV2Tool(
				createEditV2Tool({
					dialect: this.options.editDialect,
					backend: mutationBackend,
					limits: this.options.editLimits,
				}),
				context,
			),
			run: bindV2Tool(createRunV2Tool(), context, this.options.getShellCommandPrefix),
		};
	}

	private async closeCurrent(): Promise<void> {
		const resources = this.resources;
		this.resources = new Set();
		this.toolState = undefined;
		for (const resource of resources) {
			try {
				await resource.close();
			} catch (error) {
				this.lifecycleErrors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		const env = this.env;
		const envOwned = this.envOwned;
		this.env = undefined;
		this.envOwned = false;
		if (env && envOwned) {
			try {
				await env.cleanup();
			} catch (error) {
				this.lifecycleErrors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	async reload(): Promise<Record<(typeof V2_TOOL_NAMES)[number], V2ToolDefinition>> {
		if (this.closed) throw new Error("Cannot reload a closed v2 tool runtime.");
		await this.closeCurrent();
		this.build();
		return this.currentDefinitions;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.closeCurrent();
	}
}

/** Create an owned, reloadable runtime for the four opt-in v2 tool definitions. */
export function createV2ToolRuntime(cwd: string, options: CreateV2ToolDefinitionsOptions = {}): V2ToolRuntimeHandle {
	return new V2ToolRuntime(cwd, options);
}

/** Create definitions for compatibility callers. Session hosts should prefer createV2ToolRuntime for cleanup. */
export function createV2ToolDefinitions(
	cwd: string,
	options: CreateV2ToolDefinitionsOptions = {},
): Record<(typeof V2_TOOL_NAMES)[number], V2ToolDefinition> {
	return createV2ToolRuntime(cwd, options).definitions;
}
