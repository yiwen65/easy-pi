/** One local script execution. QuickJS is not the authority or the durable execution journal. */
import {
	type AgentTool,
	type AgentToolCallOutcome,
	AgentToolError,
	type AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type CodemodeOutputItem,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSWasm,
	parseCodemodeSource,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
import { getCodemodeWorkerSpecifier, getQuickJSWasmPath } from "../../config.ts";
import type { ExtensionToolContext, ToolNamespace } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { Bm25Ranker, createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT } from "../tool-search/tool.ts";
import { writeCodemodeOutputFile } from "./output.ts";
import {
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeNestedCall,
	type CodemodeStoreEntryData,
	type CodemodeToolDetails,
	type CodemodeToolInput,
	type CodemodeToolOptions,
	getCodemodeCallableTools,
	toCodemodeDeclaration,
} from "./tool.ts";

const MAX_DISPLAY_CALLS = 256;
const ARGS_PREVIEW_CHARS = 200;
const TOTAL_ARGS_PREVIEW_BYTES = 32 * 1024;
const ERROR_PREVIEW_CHARS = 500;
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;

function truncateText(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...`.slice(0, maxChars) : text;
}

function previewArgs(args: unknown, maxBytes: number): string {
	if (args === undefined || maxBytes <= 0) return "";
	try {
		const text = truncateText(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
		if (Buffer.byteLength(text) <= maxBytes) return text;
		if (maxBytes <= 3) return ".".repeat(maxBytes);
		let preview = "";
		let bytes = 0;
		for (const point of text) {
			const size = Buffer.byteLength(point);
			if (bytes + size > maxBytes - 3) break;
			preview += point;
			bytes += size;
		}
		return `${preview}...`;
	} catch {
		return "";
	}
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function isStoreEntryData(data: unknown): data is CodemodeStoreEntryData {
	if (typeof data !== "object" || data === null) return false;
	const { set, delete: deleted } = data as Partial<CodemodeStoreEntryData>;
	return (
		typeof set === "object" &&
		set !== null &&
		!Array.isArray(set) &&
		Array.isArray(deleted) &&
		deleted.every((key: unknown) => typeof key === "string")
	);
}

/** Fold only store entries on the current branch, never abandoned sibling writes. */
export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	const store = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE || !isStoreEntryData(entry.data)) {
			continue;
		}
		for (const key of entry.data.delete) store.delete(key);
		for (const [key, value] of Object.entries(entry.data.set)) store.set(key, value);
	}
	return Object.fromEntries(store);
}

function valueText(value: unknown): string {
	return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/** Separate text()/return items, then collect console output after them. */
function formatOutput(output: readonly CodemodeOutputItem[]): (TextContent | ImageContent)[] {
	const total = output.filter((item) => item.type === "text" && !item.console).length;
	const items: (TextContent | ImageContent)[] = [];
	const consoleLines: string[] = [];
	let index = 0;
	for (const item of output) {
		if (item.type === "image") items.push(item);
		else if (item.console) consoleLines.push(item.text);
		else {
			index++;
			items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
		}
	}
	if (consoleLines.length > 0) {
		items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
	}
	return items;
}

function joinAdjacentText(items: readonly (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	const joined: (TextContent | ImageContent)[] = [];
	for (const item of items) {
		const last = joined.at(-1);
		if (item.type === "text" && last?.type === "text") {
			const separator = last.text === "" || last.text.endsWith("\n") ? "" : "\n";
			joined[joined.length - 1] = { type: "text", text: `${last.text}${separator}${item.text}` };
		} else joined.push(item);
	}
	return joined;
}

function formatCallSummary(calls: readonly CodemodeNestedCall[], omitted: number): string {
	if (calls.length === 0 && omitted === 0) return "No tool calls were made.";
	return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}${omitted > 0 ? `; ${omitted} further calls omitted from this display` : ""}`;
}

function formatError(result: Extract<CodemodeResult, { ok: false }>): string {
	const { error } = result;
	return error.kind === "script"
		? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
		: error.kind === "timeout"
			? `Script timed out: ${error.message}`
			: error.kind === "aborted"
				? `Script aborted: ${error.message}`
				: `Script sandbox failed: ${error.message}`;
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

/** A failed image-file write must not hide already executed tool effects. */
async function saveImages(items: readonly (TextContent | ImageContent)[]): Promise<(TextContent | ImageContent)[]> {
	const labels = new Map<string, Promise<string>>();
	const label = async ({ data, mimeType }: ImageContent): Promise<string> => {
		const bytes = Buffer.from(data, "base64");
		const kind = `${mimeType}, ${formatSize(bytes.length)}`;
		try {
			const extension = IMAGE_EXTENSIONS[mimeType];
			if (!extension) throw new Error(`No file extension for image type ${mimeType}`);
			return `[Image saved to ${await writeCodemodeOutputFile(bytes, extension)} (${kind})]`;
		} catch (error) {
			return `[Image (${kind}) could not be saved: ${error instanceof Error ? error.message : String(error)}]`;
		}
	};
	const result = await Promise.all(
		items.map(async (item): Promise<(TextContent | ImageContent)[]> => {
			if (item.type !== "image") return [item];
			const key = `${item.mimeType}:${item.data}`;
			let pending = labels.get(key);
			if (!pending) {
				pending = label(item);
				labels.set(key, pending);
			}
			return [{ type: "text", text: await pending }, item];
		}),
	);
	return result.flat();
}

/** Keep the head and tail of oversized text, retaining images and a private spill path. */
async function truncateOutput(
	items: (TextContent | ImageContent)[],
	maxTokens: number,
): Promise<{ items: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const texts = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text);
	const combined = texts.join("\n");
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (texts.length === 0 || combined.length <= budget) return { items };
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${combined.slice(0, headChars)}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tailChars > 0 ? combined.slice(-tailChars) : ""}`;
	let fullOutputPath: string | undefined;
	try {
		fullOutputPath = await writeCodemodeOutputFile(combined, ".txt");
		text += `\n\n[Full output: ${fullOutputPath} (read with offset/limit)]`;
	} catch (error) {
		text += `\n\n[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

/** Unknown results always reject, even if a presentation hook or MCP schema suggests success. */
function toScriptValue(tool: AgentTool, outcome: AgentToolCallOutcome): unknown {
	const { result } = outcome;
	const text = textOf(result);
	if (outcome.executionOutcome === "unknown") {
		throw new Error(`Tool "${tool.name}" has an unknown outcome. ${text}`.trim());
	}
	if (outcome.executionOutcome === "confirmed" && tool.outputSchema && result.structuredContent !== undefined) {
		return result.structuredContent;
	}
	if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
	return text;
}

/** Run, drain host work, then commit branch state only when the entire execution is known. */
export async function executeCodemode(
	toolCallId: string,
	input: CodemodeToolInput,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	ctx: ExtensionToolContext | undefined,
	options: CodemodeToolOptions = {},
): Promise<AgentToolResult<CodemodeToolDetails>> {
	// A source update can load this extension into a process whose core still passes
	// ExtensionContext. Reject that host before creating a VM or dispatching effects.
	if (
		ctx &&
		(!Array.isArray(ctx.tools) ||
			typeof ctx.executeTool !== "function" ||
			typeof ctx.waitForNestedTools !== "function")
	) {
		throw new AgentToolError(
			"Codemode requires an invocation-scoped tool context. Restart Easy Pi and resume the session after updating; /reload cannot update the running core. SDK hosts must provide tools, executeTool, and waitForNestedTools. No script or nested tools were started.",
			{ calls: [] },
			{ executionOutcome: "not_started" },
		);
	}
	const startedAt = performance.now();
	let source: ReturnType<typeof parseCodemodeSource>;
	try {
		source = parseCodemodeSource(input.code);
	} catch (error) {
		throw new AgentToolError(
			error instanceof Error ? error.message : String(error),
			{ calls: [] },
			{
				executionOutcome: "not_started",
			},
		);
	}
	const { code, options: sourceOptions } = source;
	const calls: CodemodeNestedCall[] = [];
	let omittedCalls = 0;
	let argsRemaining = TOTAL_ARGS_PREVIEW_BYTES;
	let nextCall = 0;
	let unknownOutcome = false;
	let cutOffHostCall = false;
	const pending = new Set<Promise<unknown>>();
	const startingLeaf = ctx?.sessionManager.getLeafId();
	const snapshot = (): CodemodeToolDetails => ({
		calls: calls.map((call) => ({ ...call })),
		...(omittedCalls > 0 ? { omittedCalls } : {}),
	});
	const publish = () => onUpdate?.({ content: [], details: snapshot() });
	const callableNow = () => (ctx ? getCodemodeCallableTools(ctx.tools) : []);
	const sample = (tool: AgentTool) =>
		renderToolSample(toCodemodeDeclaration(tool, options.getToolGuidelines?.().get(tool.name)));
	const sandboxTools: CodemodeTool[] = callableNow().map((tool) => ({
		name: tool.name,
		description: sample(tool),
		execute: (args, { signal: callSignal }) => {
			const record: CodemodeNestedCall = {
				id: `${toolCallId}/${++nextCall}`,
				name: tool.name,
				args: previewArgs(args, argsRemaining),
				status: "running",
			};
			if (calls.length < MAX_DISPLAY_CALLS) {
				calls.push(record);
				argsRemaining -= Buffer.byteLength(record.args);
			} else omittedCalls++;
			publish();
			const callStartedAt = performance.now();
			// Sandbox cancellation must not let a successful-looking script commit writes.
			const onAbort = () => {
				cutOffHostCall = true;
			};
			callSignal.addEventListener("abort", onAbort, { once: true });
			const run = async () => {
				try {
					const liveTool = callableNow().find((candidate) => candidate.name === tool.name);
					if (!ctx || !liveTool || callSignal.aborted) {
						throw new AgentToolError(
							`Tool "${tool.name}" is no longer callable`,
							{},
							{
								executionOutcome: "not_started",
							},
						);
					}
					const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
					record.id = outcome.toolCall.id;
					record.executionOutcome = outcome.executionOutcome;
					if (outcome.executionOutcome === "unknown") unknownOutcome = true;
					record.status = outcome.isError || outcome.executionOutcome === "unknown" ? "error" : "ok";
					if (record.status === "error") {
						record.error = truncateText(
							textOf(outcome.result) || `Tool "${tool.name}" failed`,
							ERROR_PREVIEW_CHARS,
						);
					}
					return toScriptValue(liveTool, outcome);
				} catch (error) {
					if (record.executionOutcome === undefined) {
						record.executionOutcome = error instanceof AgentToolError ? error.executionOutcome : "unknown";
						if (record.executionOutcome === "unknown") unknownOutcome = true;
					}
					record.status = callSignal.aborted ? "cancelled" : "error";
					record.error = truncateText(error instanceof Error ? error.message : String(error), ERROR_PREVIEW_CHARS);
					throw error;
				} finally {
					callSignal.removeEventListener("abort", onAbort);
					record.durationMs = performance.now() - callStartedAt;
					publish();
				}
			};
			const promise = run();
			pending.add(promise);
			// Both branches handle settlement, avoiding an unhandled rejection from finally().
			void promise.then(
				() => pending.delete(promise),
				() => pending.delete(promise),
			);
			return promise;
		},
	}));
	const sandbox = new CodemodeSandbox({
		tools: sandboxTools,
		globals: createDiscoveryGlobals(callableNow, sample, options),
		// As upstream, scripts are unbounded unless the caller supplies an explicit deadline.
		timeoutMs: sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY,
		memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
		wasm: loadQuickJSWasm(getQuickJSWasmPath()),
		workerUrl: getCodemodeWorkerSpecifier(),
	});
	let result: CodemodeResult;
	try {
		const store = ctx ? readCodemodeStore(ctx.sessionManager.getBranch()) : {};
		result = await sandbox.execute(code, { signal, store });
	} finally {
		await sandbox.close();
		// The VM can be gone while RPCs still run. Never publish parent success/store before they settle.
		await Promise.allSettled([...pending]);
		if (ctx && (await ctx.waitForNestedTools()) === "unknown") unknownOutcome = true;
	}
	const branchChanged =
		startingLeaf != null && !ctx?.sessionManager.getBranch().some((entry) => entry.id === startingLeaf);
	const failures: string[] = [];
	if (!result.ok) failures.push(formatError(result));
	if (unknownOutcome)
		failures.push(
			"A nested tool has an unknown outcome; inspect external state before retrying. Catching its exception does not confirm it.",
		);
	if (cutOffHostCall)
		failures.push(
			"Host tool calls were still running when the script ended and were cancelled; their effects are not undone.",
		);
	if (signal?.aborted && result.ok) failures.push("Script aborted before its output and store were committed.");
	if (branchChanged) failures.push("The session branch changed during the script; store writes were discarded.");
	const successful = result.ok && failures.length === 0;
	const scriptOutput = [...result.output];
	if (result.ok && result.value !== undefined) scriptOutput.push({ type: "text", text: valueText(result.value) });
	const items = formatOutput(scriptOutput);
	if (!successful) {
		items.push({
			type: "text",
			text: `Script error:\n${failures.join("\n\n")}\n\n${formatCallSummary(calls, omittedCalls)}`,
		});
	}
	const truncated = await truncateOutput(
		joinAdjacentText(items),
		sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
	);
	const output = joinAdjacentText(await saveImages(truncated.items));
	const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
	const content: (TextContent | ImageContent)[] = [
		{ type: "text", text: `Script ${successful ? "completed" : "failed"}\nWall time ${wallTime} seconds\nOutput:\n` },
		...output,
	];
	const details = snapshot();
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	if (!successful) {
		details.output = content;
		throw new AgentToolError(
			textOf({ content, details }),
			details,
			unknownOutcome ? undefined : { executionOutcome: "confirmed" },
		);
	}
	// Formatting may await filesystem I/O. Re-check cancellation and branch ownership at the write seam.
	if (
		signal?.aborted ||
		(startingLeaf != null && !ctx?.sessionManager.getBranch().some((entry) => entry.id === startingLeaf))
	) {
		throw new AgentToolError(
			"Script state was not committed: cancellation or branch change",
			{ ...details, output: content },
			{ executionOutcome: "confirmed" },
		);
	}
	if (result.ok) {
		const { set, delete: deleted } = result.storeWrites;
		if (Object.keys(set).length > 0 || deleted.length > 0)
			options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, { set, delete: deleted });
	}
	return { content, details };
}

function isNamespaceName(namespace: string, query: string): boolean {
	const id = toCodemodeIdentifier(namespace);
	const queryId = toCodemodeIdentifier(query);
	const suffix = (name: string) => (name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : undefined);
	return namespace === query || id === queryId || suffix(namespace) === query || suffix(id) === queryId;
}

/** Helpers re-read the live callable registry; a captured initial catalog cannot leak revoked metadata. */
function createDiscoveryGlobals(
	getTools: () => readonly AgentTool[],
	sample: (tool: AgentTool) => string,
	options: CodemodeToolOptions,
): CodemodeTool[] {
	const ranker = new Bm25Ranker();
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > 50) {
					throw new Error("searchTools() limit must be an integer from 1 to 50");
				}
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string")
					throw new Error("searchTools() namespace must be a string");
				const tools = getTools();
				const documents = tools.flatMap((tool) => {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (namespace && (!toolNamespace || !isNamespaceName(toolNamespace.name, namespace))) return [];
					return [createToolSearchDocument(tool, toolNamespace)];
				});
				return ranker.rank(query, documents, limit).flatMap((match) => {
					const tool = tools.find((candidate) => candidate.name === match.name);
					return tool ? [{ name: toCodemodeIdentifier(tool.name), description: sample(tool) }] : [];
				});
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = getTools().find(
					(candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
				);
				return tool ? sample(tool) : undefined;
			},
		},
		{
			name: "describeNamespace",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
				let namespace: ToolNamespace | undefined;
				const names: string[] = [];
				for (const tool of getTools()) {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (!toolNamespace || !isNamespaceName(toolNamespace.name, name)) continue;
					namespace ??= toolNamespace;
					names.push(toCodemodeIdentifier(tool.name));
				}
				return namespace
					? {
							name: namespace.name,
							...(namespace.description ? { description: namespace.description } : {}),
							...(namespace.instructions ? { instructions: namespace.instructions } : {}),
							tools: names,
						}
					: undefined;
			},
		},
	];
}
