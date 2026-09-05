import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AgentTool,
	type BashExecution,
	type BashToolDetails,
	createBashTool as createCoreBashTool,
	type ExecutionEnv,
	ExecutionError,
	type ExecutionToolContext,
	err,
	getOrThrow,
	ok,
	type Result,
	type ShellCaptureOptions,
	type ShellCaptureProgress,
	type ShellCaptureResult,
	type WorkspacePolicy,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv, NodeProcessExecutor } from "@earendil-works/pi-agent-core/node";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { getShellConfig, getShellEnv, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

type BashSchema = ReturnType<typeof createCoreBashTool>["parameters"];

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type { BashToolDetails, BashToolInput } from "@earendil-works/pi-agent-core";

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null; signal?: string }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	const processExecutor = new NodeProcessExecutor({
		onProcessStart: trackDetachedChildPid,
		onProcessEnd: untrackDetachedChildPid,
	});
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const forwardData = (chunk: Uint8Array): void => {
				onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			};
			const result = await processExecutor.execute(command, {
				shell: shellConfig,
				cwd,
				env: env ?? getShellEnv(),
				timeoutMs,
				abortSignal: signal,
				onStdout: forwardData,
				onStderr: forwardData,
			});
			if (result.ok) {
				if (signal?.aborted) throw new Error("aborted");
				return { exitCode: result.value.exitCode, signal: result.value.signal ?? undefined };
			}
			if (result.error.code === "aborted" || (result.error.code === "timeout" && signal?.aborted)) {
				throw new Error("aborted");
			}
			if (result.error.code === "timeout") {
				throw new Error(`timeout:${timeout}`);
			}
			if (result.error.cause instanceof Error) throw result.error.cause;
			throw new Error(result.error.message);
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export function resolveSessionShellEnvironment(
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(getShellEnv()).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	return env;
}

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = resolveSessionShellEnvironment(exposeSessionEnvironment, ctx);
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Host-owned environment; mutually exclusive with BashOperations. */
	executionEnv?: ExecutionEnv;
	workspacePolicy?: WorkspacePolicy;
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; cwd?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const metadata = [args?.cwd ? `cwd ${args.cwd}` : undefined, timeout ? `timeout ${timeout}s` : undefined].filter(
		Boolean,
	);
	const timeoutSuffix = metadata.length ? theme.fg("muted", ` (${metadata.join(", ")})`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath) {
		const footerStart = output.lastIndexOf("\n\n[Showing ");
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
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
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
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

/** Preserve native raw-byte logs while delegating tool orchestration to Agent Bash. */
async function captureBashOperations(
	ops: BashOperations,
	execution: BashExecution,
	options: ShellCaptureOptions,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
	let acceptingOutput = true;
	let exitCode: number | undefined;
	let exitSignal: string | undefined;
	let executionError: ExecutionError | undefined;
	let cancelled = false;
	const progress = (): ShellCaptureProgress => {
		const snapshot = output.snapshot({ persistIfTruncated: true });
		return {
			output: snapshot.content,
			truncation: snapshot.truncation,
			fullOutputPath: snapshot.fullOutputPath,
			lastLineBytes: output.getLastLineBytes(),
		};
	};
	try {
		try {
			if (options.abortSignal?.aborted) throw new Error("aborted");
			const result = await ops.exec(execution.command, execution.cwd, {
				onData: (data) => {
					if (!acceptingOutput) return;
					output.append(data);
					options.onChunk?.("", progress);
				},
				signal: options.abortSignal,
				timeout: options.timeout,
				env: execution.env,
			});
			exitCode = result.exitCode ?? undefined;
			exitSignal = result.signal;
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			cancelled = options.abortSignal?.aborted === true || cause.message === "aborted";
			if (!cancelled) {
				executionError =
					error instanceof ExecutionError
						? error
						: new ExecutionError(
								cause.message.startsWith("timeout:") ? "timeout" : "unknown",
								cause.message.startsWith("timeout:")
									? `Command timed out after ${cause.message.slice("timeout:".length)} seconds`
									: cause.message,
								cause,
							);
			}
		} finally {
			acceptingOutput = false;
			output.finish();
			await output.closeTempFile();
		}
		const snapshot = progress();
		return ok({
			...snapshot,
			exitCode,
			signal: exitSignal,
			cancelled,
			truncated: snapshot.truncation.truncated,
			executionError,
		});
	} catch (error) {
		return err(
			new ExecutionError(
				"unknown",
				error instanceof Error ? error.message : String(error),
				error instanceof Error ? error : undefined,
			),
		);
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<BashSchema, BashToolDetails, BashRenderState> {
	if (options?.operations && options.executionEnv) throw new Error("Choose BashOperations or executionEnv, not both.");
	const env =
		options?.executionEnv ??
		new NodeExecutionEnv({ cwd: options?.operations ? cwd : resolve(cwd), shellPath: options?.shellPath });
	const ops =
		options?.operations ??
		(options?.executionEnv ? undefined : createLocalBashOperations({ shellPath: options?.shellPath }));
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const tool = createCoreBashTool<ExecutionToolContext & { extensionContext?: ExtensionContext }>({
		commandPrefix: options?.commandPrefix,
		prepare: async (execution, context, signal) => {
			if (ops && !options?.operations) {
				execution.cwd = getOrThrow(await env.absolutePath(execution.cwd, signal));
			}
			const spawnContext = resolveSpawnContext(
				execution.command,
				execution.cwd,
				options?.spawnHook,
				exposeSessionEnvironment,
				context.extensionContext,
			);
			Object.assign(execution, spawnContext, { inheritEnv: false });
		},
		capture: ops ? (execution, captureOptions) => captureBashOperations(ops, execution, captureOptions) : undefined,
	});
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		promptSnippet: bashToolSystemPromptContribution.snippet,
		promptGuidelines: exposeSessionEnvironment ? [...bashToolSystemPromptContribution.guidelines] : undefined,
		parameters: tool.parameters,
		constrainedSampling: getExperimentalToolSampling(),
		executionMode: tool.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, signal, onUpdate, {
				env,
				workspacePolicy: options?.workspacePolicy,
				extensionContext: ctx,
			}),
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
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
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<BashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
