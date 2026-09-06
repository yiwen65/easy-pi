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

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	cwd: Type.Optional(Type.String({ description: "Initial working directory (defaults to the session cwd)" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;
export type BashTerminationReason = "exit" | "signal" | "timeout" | "aborted";

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
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in an initial working directory. Returns stdout and stderr with structured exit status; nonzero exits, signals, timeouts, and cancellation are tool errors. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first), with full output saved to a temp file. Optional cwd and timeout in seconds. cwd is not a sandbox.`,
		parameters: bashSchema,
		replay: "never",
		async execute(_toolCallId, { command, cwd, timeout }, signal, onUpdate, context) {
			if (!command.trim()) throw new ExecutionToolError("INVALID_INPUT", "command must not be empty.");
			validateTimeout(timeout);
			const { env } = context;
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
					timeout,
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
