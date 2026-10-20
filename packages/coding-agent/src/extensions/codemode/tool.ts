/**
 * Local QuickJS tool orchestration. Nested calls go through ctx.executeTool(), never a direct
 * handler invocation. Failed scripts retain partial output; an unknown nested outcome cannot
 * be converted to success by catching its exception. Store writes commit only after all host
 * calls settle with known outcomes, on the branch that started the script.
 *
 * This migration exposes tools and discovery globals, not the upstream models.* runtime.
 */

import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import {
	MCP_TYPESCRIPT_PREAMBLE,
	mcpStructuredContentSchema,
	renderToolOutputType,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode/declarations";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import { type Static, Type } from "typebox";
import { getDocsPath } from "../../config.ts";
import type {
	ToolDefinition,
	ToolInfo,
	ToolLoadout,
	ToolLoadoutChanges,
	ToolNamespace,
} from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
import { executeCodemode } from "./execute.ts";
import { codemodeRenderers } from "./renderer.ts";

export const CODEMODE_TOOL_NAME = "codemode";

/** Custom entry type holding one script's `store()` writes: {@link CodemodeStoreEntryData}. */
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";

export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}

export interface CodemodeToolOptions {
	/** Host-owned output storage. A temporary session may delete its files after execution drains. */
	writeOutputFile?: (data: string | Uint8Array, extension: string) => Promise<string>;
	/** Namespace of a tool, for `searchTools()` ranking and its `namespace` filter. */
	getToolNamespace?: (toolName: string) => ToolNamespace | undefined;
	/** Prompt guidelines of every tool, by tool name, shown with declarations by `describeTool()` and `ALL_TOOLS`. */
	getToolGuidelines?: () => ReadonlyMap<string, readonly string[]>;
	/**
	 * Persists `store()` writes as a session custom entry. Without it, writes last only for the
	 * current script; `load()` still reads entries already on the branch.
	 */
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
	/** How the tool presents the loadout while active (the `codemode.mode` setting). Default: `on`. */
	getMode?: () => CodemodeMode;
	/** Token budget for tool declarations in the description. Default: {@link DEFAULT_CODEMODE_INLINE_BUDGET}. */
	getInlineBudget?: () => number | undefined;
}

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export const codemodeSchema = Type.Object({
	code: Type.String({
		description: "Raw JavaScript source.",
	}),
});

export type CodemodeToolInput = Static<typeof codemodeSchema>;

/**
 * Whether a registered tool is this package's `codemode` tool rather than another extension's tool
 * with the same name. Compares the parameter schema, which the definition passes through by reference.
 */
export function isCodemodeTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === CODEMODE_TOOL_NAME && tool.parameters === codemodeSchema;
}

export type CodemodeNestedCallStatus = "running" | "ok" | "error" | "cancelled";

export interface CodemodeNestedCall {
	/** Tool call id of the nested call, `<codemode call id>/<n>`. */
	id: string;
	name: string;
	/** Compact JSON of the arguments, truncated for display. */
	args: string;
	status: CodemodeNestedCallStatus;
	durationMs?: number;
	/** Error text, truncated for display. */
	error?: string;
	/** Execution certainty reported before result presentation hooks. */
	executionOutcome?: "not_started" | "confirmed" | "unknown";
}

export interface CodemodeToolDetails {
	/** Bounded display history, not the durable execution journal. */
	calls: CodemodeNestedCall[];
	/** Calls omitted from the bounded display history. */
	omittedCalls?: number;
	/** Temp file with the full text output, when the output was truncated. */
	fullOutputPath?: string;
	/** Partial output retained on an AgentToolError, including image blocks. */
	output?: AgentToolResult<unknown>["content"];
}

const CODEMODE_SELECTION_GUIDELINE =
	"Use codemode to batch independent calls, chain deterministic steps, or filter large tool output. Prefer a direct tool for a single simple call when it is declared; split execution when the next step needs model judgment.";

export const codemodeToolSystemPromptContribution = {
	snippet: "Run JavaScript that calls other tools",
	guidelines: [CODEMODE_SELECTION_GUIDELINE],
} as const;

/** The reference for scripts: globals, tool results, store persistence, and limits. */
export const CODEMODE_DOCS_PATH = join(getDocsPath(), "codemode.md");

const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. ${CODEMODE_SELECTION_GUIDELINE}
The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure.
- Parallelize only independent read-only calls; keep dependent steps and writes ordered. Use \`Promise.allSettled()\` when successful results should survive known failures.
- Await calls that matter; do not fire-and-forget writes. Calls still running when the script ends are signalled to cancel, but their effects are not undone.
- Catching an error or cancelling a call does not prove an external effect failed or stopped. For unknown outcomes, inspect external state before retrying; do not repeat unresolved effects.
- Scripts can call only currently authorized tools. Nested calls retain normal validation, hooks and host permissions; the VM does not isolate effects of Bash or MCP tools.
- Each script admits at most 1024 host calls, including discovery globals. Serialized store writes, including keys and deletions, are capped at 1048576 JavaScript string characters; neither limit rolls back tool effects.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\`. Text output defaults to 10000 estimated tokens; oversized output is saved to a private temporary file.`;

/** One line per global. The details live in {@link CODEMODE_DOCS_PATH}. */
function describeGlobals(): string {
	const lines = [
		"Globals:",
		"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block. `image()` also saves the image to a temp file and the result names its path.",
		"- `store(key, value)` and `load(key)` keep branch-local JSON values across codemode calls. Writes commit only after a successful, non-cancelled script with known nested outcomes; failures, cancellation or unknown outcomes discard them.",
		"- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.",
	];
	return lines.join("\n");
}

/** Default for {@link CodemodeDescriptionOptions.inlineBudget}, in estimated tokens. */
export const DEFAULT_CODEMODE_INLINE_BUDGET = SETTINGS_DEFAULTS.codemode.inlineBudget;
/** Characters per token when estimating the cost of a tool section. */
const CHARS_PER_TOKEN = 4;

/**
 * What a script sees of a tool: its description followed by its prompt guidelines, which the system
 * prompt only has for declared tools. Tools without an output schema resolve to their text output.
 */
export function toCodemodeDeclaration(
	tool: AgentTool,
	guidelines: readonly string[] = [],
): Omit<CodemodeTool, "execute"> {
	const bullets = guidelines.flatMap((guideline) => (guideline.trim() ? [`- ${guideline.trim()}`] : []));
	return {
		name: tool.name,
		description: bullets.length > 0 ? `${tool.description.trim()}\n\n${bullets.join("\n")}` : tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** Tools a script may call: every given tool except the codemode tool itself. */
export function getCodemodeCallableTools(tools: readonly AgentTool[]): AgentTool[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

export interface CodemodeDescriptionOptions {
	/** Namespace of each tool, by tool name. Tools of one namespace are listed under one heading. */
	namespaces?: ReadonlyMap<string, ToolNamespace>;
	/** Tools that are callable but never listed with their declaration (`deferred` exposure). */
	deferred?: ReadonlySet<string>;
	/** Prompt guidelines of each tool, by tool name, listed after its description. */
	guidelines?: ReadonlyMap<string, readonly string[]>;
	/**
	 * Estimated tokens (characters / 4) the tool sections may use. Tools that do not fit are left
	 * out, like deferred tools. Unset lists every tool that is not deferred.
	 */
	inlineBudget?: number;
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration. */
function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
	const id = toCodemodeIdentifier(declaration.name);
	const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

interface CatalogEntry {
	name: string;
	section: string;
	cost: number;
}

interface CatalogGroup {
	namespace: ToolNamespace | undefined;
	entries: CatalogEntry[];
}

/**
 * Pick the tool sections that fit the budget, like OpenCode's catalog: in each round every group
 * (tools without a namespace first, then namespaces by name) places its cheapest remaining tool; a
 * group whose next tool does not fit drops out while the others continue. Every namespace is
 * represented before any namespace is complete.
 */
function selectCatalog(groups: readonly CatalogGroup[], budget: number | undefined): Set<string> {
	if (budget === undefined) return new Set(groups.flatMap((group) => group.entries.map((entry) => entry.name)));
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

/**
 * Model-facing description: the helper list, guidance for finding tools that are not listed, the
 * shared MCP types when listed tools need them, and one section per listed tool,
 * grouped by namespace. Deferred tools are never listed and do not affect the description at all, so
 * it stays the same while MCP servers connect or change their tools. Tool sections are limited to
 * `inlineBudget`.
 */
export function createCodemodeDescription(
	tools: readonly AgentTool[],
	options: CodemodeDescriptionOptions = {},
): string {
	const declarations = getCodemodeCallableTools(tools)
		.filter((tool) => !options.deferred?.has(tool.name))
		.map((tool) => toCodemodeDeclaration(tool, options.guidelines?.get(tool.name)));
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const declaration of declarations) {
		const namespace = options.namespaces?.get(declaration.name);
		const key = namespace ? `ns:${namespace.name}` : "";
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const section = renderToolSection(declaration);
		group.entries.push({ name: declaration.name, section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) });
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = selectCatalog(ordered, options.inlineBudget);

	const sections = [DESCRIPTION_INTRO, describeGlobals()];
	if (
		declarations.some(
			(declaration) =>
				shown.has(declaration.name) && mcpStructuredContentSchema(declaration.outputSchema) !== undefined,
		)
	) {
		sections.push(`Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
	}
	if (declarations.length === 0) return sections.join("\n\n");

	const toolSections = ["Nested tools:"];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			// Only tools that did not fit the budget are counted as not listed here.
			const listing =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			const description = namespace.description?.trim();
			toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
		}
		for (const entry of visible) toolSections.push(entry.section);
	}
	sections.push(toolSections.join("\n\n"));
	return sections.join("\n\n");
}

/**
 * What a script call resolves to, in one line: `a string`, the field names of an object
 * (`{ output, exit_code, full_output_path? }`), or the rendered type for anything else.
 */
function describeOutput(schema: CodemodeJsonSchema | undefined): string {
	const type = renderToolOutputType(schema);
	if (type === "string") return "a string";
	const object = typeof schema === "object" ? schema : undefined;
	const properties = object?.properties;
	if (
		object?.type === "object" &&
		typeof properties === "object" &&
		properties !== null &&
		mcpStructuredContentSchema(schema) === undefined
	) {
		const required = new Set(Array.isArray(object.required) ? object.required : []);
		const fields = Object.keys(properties).map((name) => (required.has(name) ? name : `${name}?`));
		return `\`{ ${fields.join(", ")} }\``;
	}
	return `\`${type.replace(/\s+/g, " ")}\``;
}

/**
 * A declared tool's description followed by how scripts call it and what the call resolves to. The
 * arguments are the tool's declared parameters, so they are not repeated.
 */
function describeScriptCall(tool: AgentTool): string {
	return `${tool.description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(tool.name)}(args)\` resolves to ${describeOutput(toCodemodeDeclaration(tool).outputSchema)}.`;
}

/**
 * How the codemode tool presents tools that are both declared and callable from scripts:
 * - `on`: their descriptions say how scripts call them, and the codemode description
 *   lists only the callable tools without `direct` exposure.
 * - `only`: the codemode description lists every callable tool, and requests leave out the
 *   declarations of active `direct` tools.
 *
 * Listed tools carry their prompt guidelines, which the system prompt only has for declared tools.
 *
 * Listing by exposure, not by the active set, keeps the codemode description unchanged when
 * `tool_search` loads a tool, so loads do not redeclare codemode.
 */
function prepareCodemodeLoadout(loadout: ToolLoadout, options: CodemodeToolOptions): ToolLoadoutChanges {
	const mode = options.getMode?.() ?? SETTINGS_DEFAULTS.codemode.mode;
	const isDirect = (tool: AgentTool) => loadout.getExposure(tool.name) === "direct";
	const callable = getCodemodeCallableTools(loadout.callable);
	const callableNames = new Set(callable.map((tool) => tool.name));
	const descriptions: Record<string, string> = {};
	if (mode === "on") {
		for (const tool of loadout.declared) {
			if (callableNames.has(tool.name)) descriptions[tool.name] = describeScriptCall(tool);
		}
	}
	const listed = mode === "only" ? callable : callable.filter((tool) => !isDirect(tool));
	const namespaces = new Map(
		listed.flatMap((tool) => {
			const namespace = loadout.getNamespace(tool.name);
			return namespace ? [[tool.name, namespace] as const] : [];
		}),
	);
	const guidelines = new Map(listed.map((tool) => [tool.name, loadout.getPromptGuidelines(tool.name)] as const));
	descriptions[CODEMODE_TOOL_NAME] = createCodemodeDescription(listed, {
		namespaces,
		guidelines,
		deferred: new Set(
			listed.filter((tool) => loadout.getExposure(tool.name) === "deferred").map((tool) => tool.name),
		),
		inlineBudget: options.getInlineBudget?.() ?? DEFAULT_CODEMODE_INLINE_BUDGET,
	});
	const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
	return {
		descriptions,
		hiddenDeclarations:
			mode === "only"
				? callable.filter((tool) => isDirect(tool) && declaredNames.has(tool.name)).map((tool) => tool.name)
				: [],
	};
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the callable tools when the tool is activated.
		description: createCodemodeDescription([]),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		// Scripts must not start other scripts.
		exposure: "model-only",
		defaultActive: false,
		orchestratesTools: true,
		prepareLoadout: (loadout) => prepareCodemodeLoadout(loadout, options),
		// Capable models write the script as raw text instead of a JSON-escaped string.
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		// Whole scripts may orchestrate irreversible effects and are never safe to replay.
		contract: { sideEffects: "external" },
		// The worker and wasm are created only when a script runs.
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			executeCodemode(toolCallId, params, signal, onUpdate, ctx, options),
		...codemodeRenderers,
	};
}

/**
 * Create the codemode tool as an AgentTool. The description lists the given tools; the script can
 * call whatever tools the agent loop provides at execution time.
 */
export function createCodemodeTool(
	tools: readonly AgentTool[] = [],
	options: CodemodeToolOptions = {},
): AgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition(options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		description: createCodemodeDescription(tools),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
