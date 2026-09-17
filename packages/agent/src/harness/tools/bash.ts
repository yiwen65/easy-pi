import { type Static, Type } from "typebox";
import { AgentToolError } from "../../types.ts";
import type { AgentHarnessTool, ExecutionError, Result } from "../types.ts";
import { getOrThrow } from "../types.ts";
import {
	executeShellWithCapture,
	type ShellCaptureOptions,
	type ShellCaptureProgress,
	type ShellCaptureResult,
} from "../utils/shell-output.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "../utils/truncate.ts";
import { ExecutionToolError } from "./execution-tool-error.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const BASH_UPDATE_THROTTLE_MS = 100;
const DEFAULT_FOREGROUND_TIMEOUT_SECONDS = 60;
const MAX_FOREGROUND_TIMEOUT_SECONDS = 300;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	cwd: Type.Optional(Type.String({ description: "Initial working directory (defaults to the session cwd)" })),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Timeout in seconds. Foreground: defaults apply when the host enables promotion; background: overrides the background runtime bound.",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run in the background and return a task ID immediately instead of blocking (default false). Manage with task_list, task_output, task_stop, and wait_for.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;
export type BashTerminationReason = "exit" | "signal" | "timeout" | "aborted" | "promoted";

export interface BashToolDetails {
	command: string;
	cwd: string;
	exitCode: number | null;
	signal: string | null;
	terminationReason: BashTerminationReason | null;
	terminationRequested: boolean;
	timedOut: boolean;
	durationMs: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Set when the command is running as a background task (started via run_in_background or promoted on timeout). */
	backgroundTaskId?: string;
}

export interface BashExecution {
	command: string;
	cwd: string;
	env: Record<string, string>;
	inheritEnv: boolean;
}

export type BashPrepare<TContext extends ExecutionToolContext = ExecutionToolContext> = (
	execution: BashExecution,
	context: TContext,
	signal?: AbortSignal,
) => void | Promise<void>;

export interface BashToolOptions<TContext extends ExecutionToolContext = ExecutionToolContext> {
	commandPrefix?: string;
	prepare?: BashPrepare<TContext>;
	/** Host transport/capture adapter. It owns cwd resolution and validation, including remote paths. */
	capture?: (
		execution: BashExecution,
		options: ShellCaptureOptions,
	) => Promise<Result<ShellCaptureResult, ExecutionError>>;
	/**
	 * Kimi-style foreground promotion: when the execution environment supports background tasks,
	 * foreground commands default to `foregroundTimeoutSeconds` (60) up to `maxForegroundTimeoutSeconds`
	 * (300), and a timed-out command keeps running as a background task instead of being killed.
	 */
	promotion?: {
		foregroundTimeoutSeconds?: number;
		maxForegroundTimeoutSeconds?: number;
	};
}

function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
}

export function createBashTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options?: BashToolOptions<TContext>,
): AgentHarnessTool<TContext, typeof bashSchema, BashToolDetails> {
	const foregroundTimeoutSeconds = options?.promotion?.foregroundTimeoutSeconds ?? DEFAULT_FOREGROUND_TIMEOUT_SECONDS;
	const maxForegroundTimeoutSeconds =
		options?.promotion?.maxForegroundTimeoutSeconds ?? MAX_FOREGROUND_TIMEOUT_SECONDS;
	const description =
		`Execute a bash command and return stdout, stderr, and a structured exit status; nonzero exits, signals, and cancellation are tool errors. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; full output is saved to a temp file. A nonexistent cwd fails the call and the error names the cause. cwd is not a sandbox.` +
		(options?.promotion
			? ` Foreground commands run at most ${foregroundTimeoutSeconds}s (explicit timeout, max ${maxForegroundTimeoutSeconds}s): on timeout the command keeps running as a background task and the call returns its task ID.`
			: " A timeout fails the call.") +
		" Set run_in_background=true to return a task ID immediately; manage background tasks with task_list, task_output, task_stop, and wait_for.";
	return {
		name: "bash",
		label: "bash",
		description,
		parameters: bashSchema,
		replay: "never",
		async execute(_toolCallId, { command, cwd, timeout, run_in_background }, signal, onUpdate, context) {
			if (!command.trim()) throw new ExecutionToolError("INVALID_INPUT", "command must not be empty.");
			validateTimeout(timeout);
			const { env } = context;
			const backgroundTasks = env.backgroundTasks;
			const promotionActive = options?.promotion !== undefined && backgroundTasks !== undefined;
			if (promotionActive && !run_in_background && timeout !== undefined && timeout > maxForegroundTimeoutSeconds) {
				throw new ExecutionToolError(
					"INVALID_INPUT",
					`timeout exceeds the ${maxForegroundTimeoutSeconds}s foreground maximum; use run_in_background for longer commands.`,
				);
			}
			let executionCwd = cwd ?? env.cwd;
			if (!options?.capture || context.workspacePolicy) {
				const resolved = await resolveWorkspacePath(env, cwd ?? ".", "read", context.workspacePolicy, signal);
				const info = await env.fileInfo(resolved.canonicalPath, signal);
				if (!info.ok) {
					throw new ExecutionToolError(
						info.error.code === "not_found" ? "NOT_FOUND" : "PERMISSION_DENIED",
						`Could not inspect cwd ${executionCwd}: ${info.error.message}`,
					);
				}
				if (info.value.kind !== "directory")
					throw new ExecutionToolError("NOT_A_DIRECTORY", `cwd is not a directory: ${executionCwd}`);
				executionCwd = resolved.absolutePath;
			}
			const execution: BashExecution = {
				command: options?.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
				cwd: executionCwd,
				env: {},
				inheritEnv: true,
			};
			await options?.prepare?.(execution, context, signal);
			const startedAt = Date.now();
			const initialDetails: BashToolDetails = {
				command,
				cwd: execution.cwd,
				exitCode: null,
				signal: null,
				terminationReason: null,
				terminationRequested: false,
				timedOut: false,
				durationMs: 0,
			};
			if (run_in_background) {
				if (!backgroundTasks) {
					throw new ExecutionToolError(
						"UNSUPPORTED",
						"Background tasks are not supported by this execution environment.",
					);
				}
				const started = await backgroundTasks.start(execution.command, {
					cwd: execution.cwd,
					env: execution.env,
					inheritEnv: execution.inheritEnv,
					timeoutMs: timeout !== undefined ? timeout * 1000 : undefined,
				});
				if (!started.ok) {
					throw new ExecutionToolError(
						started.error.code === "not_found"
							? "NOT_FOUND"
							: started.error.code === "limit_reached"
								? "LIMIT_REACHED"
								: "SPAWN_ERROR",
						started.error.message,
					);
				}
				const task = started.value;
				return {
					content: [
						{
							type: "text",
							text: `Background task ${task.id} started (pid ${task.pid ?? "unknown"}).\nOutput log: ${task.outputPath}\nUse task_output to inspect output, wait_for to block until it finishes, task_stop to terminate it.`,
						},
					],
					details: {
						...initialDetails,
						durationMs: Date.now() - startedAt,
						backgroundTaskId: task.id,
						fullOutputPath: task.outputPath,
					},
				};
			}
			let getLatestProgress: (() => ShellCaptureProgress) | undefined;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = (): void => {
				if (!onUpdate || !updateDirty || !getLatestProgress) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const progress = getLatestProgress();
				onUpdate({
					content: [{ type: "text", text: progress.output }],
					details: {
						...initialDetails,
						durationMs: Date.now() - startedAt,
						truncation: progress.truncation.truncated ? progress.truncation : undefined,
						fullOutputPath: progress.fullOutputPath,
					},
				});
			};
			const clearUpdateTimer = (): void => {
				if (!updateTimer) return;
				clearTimeout(updateTimer);
				updateTimer = undefined;
			};
			const scheduleOutputUpdate = (): void => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			onUpdate?.({ content: [], details: initialDetails });
			try {
				const captureOptions: ShellCaptureOptions = {
					cwd: execution.cwd,
					env: execution.env,
					inheritEnv: execution.inheritEnv,
					timeout: promotionActive ? (timeout ?? foregroundTimeoutSeconds) : timeout,
					promoteOnTimeout: promotionActive || undefined,
					abortSignal: signal,
					returnExecutionErrors: true,
					onChunk: (_chunk, getProgress) => {
						getLatestProgress = getProgress;
						scheduleOutputUpdate();
					},
				};
				const capture = getOrThrow(
					await (options?.capture
						? options.capture(execution, captureOptions)
						: executeShellWithCapture(env, execution.command, captureOptions)),
				);
				clearUpdateTimer();
				getLatestProgress = () => capture;
				updateDirty = true;
				emitOutputUpdate();

				if (capture.promotedTaskId !== undefined) {
					const promotedDetails: BashToolDetails = {
						...initialDetails,
						terminationReason: "promoted",
						timedOut: true,
						durationMs: Date.now() - startedAt,
						truncation: capture.truncation.truncated ? capture.truncation : undefined,
						fullOutputPath: capture.fullOutputPath,
						backgroundTaskId: capture.promotedTaskId,
					};
					const manager = backgroundTasks;
					const task = manager?.get(capture.promotedTaskId);
					const note = `Command exceeded the ${promotionActive ? (timeout ?? foregroundTimeoutSeconds) : timeout}s foreground limit and was promoted to background task ${capture.promotedTaskId}; it is still running.${task ? `\nOutput log: ${task.outputPath}` : ""}\nUse task_output to inspect output, wait_for to wait for completion, task_stop to terminate it.`;
					return {
						content: [{ type: "text", text: `${capture.output ? `${capture.output}\n\n` : ""}[${note}]` }],
						details: promotedDetails,
					};
				}

				const cancelled = capture.cancelled || signal?.aborted === true;
				const timedOut = !cancelled && capture.executionError?.code === "timeout";
				const exitSignal = cancelled || timedOut ? null : (capture.signal ?? null);
				const exitCode = cancelled || timedOut || exitSignal ? null : (capture.exitCode ?? null);
				const details: BashToolDetails = {
					...initialDetails,
					exitCode,
					signal: exitSignal,
					terminationReason: cancelled
						? "aborted"
						: timedOut
							? "timeout"
							: exitSignal
								? "signal"
								: exitCode === null
									? null
									: "exit",
					terminationRequested: cancelled || timedOut,
					timedOut,
					durationMs: Date.now() - startedAt,
					truncation: capture.truncation.truncated ? capture.truncation : undefined,
					fullOutputPath: capture.fullOutputPath,
				};
				let outputText = capture.output;
				if (capture.truncation.truncated) {
					const startLine = capture.truncation.totalLines - capture.truncation.outputLines + 1;
					const endLine = capture.truncation.totalLines;
					if (capture.truncation.lastLinePartial) {
						outputText += `\n\n[Showing last ${formatSize(capture.truncation.outputBytes)} of line ${endLine} (line is ${formatSize(capture.lastLineBytes)}). Full output: ${capture.fullOutputPath}]`;
					} else if (capture.truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines}. Full output: ${capture.fullOutputPath}]`;
					} else {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${capture.fullOutputPath}]`;
					}
				}
				const fail = (code: string, status: string, cause?: Error): never => {
					throw Object.assign(
						new AgentToolError(
							`${outputText ? `${outputText}\n\n` : ""}${status}`,
							details,
							cause ? { cause } : undefined,
						),
						{ code },
					);
				};
				if (cancelled) fail("ABORTED", "Command aborted");
				if (timedOut)
					fail(
						"TIMEOUT",
						timeout === undefined
							? capture.executionError!.message
							: `Command timed out after ${timeout} seconds`,
						capture.executionError,
					);
				if (capture.executionError)
					fail(capture.executionError.code, capture.executionError.message, capture.executionError);
				if (exitSignal) fail("SIGNAL", `Command terminated by signal ${exitSignal}`);
				if (exitCode === null)
					fail("UNKNOWN_TERMINATION", "Command ended without an exit status; outcome is unknown.");
				if (exitCode !== 0) fail("NONZERO_EXIT", `Command exited with code ${exitCode}`);
				return { content: [{ type: "text", text: outputText || "(no output)" }], details };
			} finally {
				clearUpdateTimer();
			}
		},
	};
}
