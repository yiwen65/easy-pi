import { type Static, Type } from "typebox";
import type { AgentHarnessTool, ExecutionErrorCode } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { executeShellWithCapture, type ShellCaptureResult } from "../utils/shell-output.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../utils/truncate.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
import { V2ToolError } from "./v2-errors.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const RUN_UPDATE_THROTTLE_MS = 100;
const runV2Schema = Type.Object({
	command: Type.String({ description: "Command to execute" }),
	cwd: Type.Optional(Type.String({ description: "Initial working directory" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export type RunV2Input = Static<typeof runV2Schema>;
export interface RunV2Details {
	command: string;
	cwd: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	managedProcessesTerminated: boolean;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

function validateInput(input: RunV2Input): void {
	if (input.command.trim().length === 0) throw new V2ToolError("INVALID_INPUT", "command must not be empty.");
	if (
		input.timeout !== undefined &&
		(!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > MAX_TIMEOUT_SECONDS)
	) {
		throw new V2ToolError("INVALID_INPUT", `timeout must be between 0 and ${MAX_TIMEOUT_SECONDS} seconds.`);
	}
}

function executionFailure(code: ExecutionErrorCode, message: string): V2ToolError {
	switch (code) {
		case "aborted":
			return new V2ToolError("ABORTED", "Command was aborted.");
		case "shell_unavailable":
			return new V2ToolError("SHELL_UNAVAILABLE", message);
		case "spawn_error":
			return new V2ToolError("SPAWN_FAILED", message);
		default:
			return new V2ToolError("SPAWN_FAILED", `Execution environment failed: ${message}`);
	}
}

export function createRunV2Tool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof runV2Schema,
	RunV2Details
> {
	return {
		name: "run",
		label: "run",
		description:
			"Run a command in an initial working directory. Use it for builds, tests, Git, and programs—not for searching, reading, or editing files. cwd is not a sandbox.",
		parameters: runV2Schema,
		executionMode: "sequential",
		replay: "never",
		async execute(_toolCallId, input, signal, onUpdate, context) {
			validateInput(input);
			const cwd = await resolveWorkspacePath(
				context.env,
				input.cwd ?? context.env.cwd,
				"read",
				context.workspacePolicy,
				signal,
			);
			const cwdInfo = await context.env.fileInfo(cwd.canonicalPath, signal);
			if (!cwdInfo.ok) {
				if (cwdInfo.error.code === "not_found")
					throw new V2ToolError("NOT_FOUND", `cwd does not exist: ${input.cwd ?? context.env.cwd}`);
				throw new V2ToolError("PERMISSION_DENIED", `Could not inspect cwd: ${cwdInfo.error.message}`);
			}
			if (cwdInfo.value.kind !== "directory")
				throw new V2ToolError("NOT_A_DIRECTORY", `cwd is not a directory: ${input.cwd ?? context.env.cwd}`);
			const startedAt = Date.now();
			if (onUpdate) {
				onUpdate({
					content: [],
					details: {
						command: input.command,
						cwd: cwd.absolutePath,
						exitCode: null,
						timedOut: false,
						durationMs: 0,
						managedProcessesTerminated: false,
					},
				});
			}
			const resolvedCommand = context.run?.commandPrefix
				? `${context.run.commandPrefix}\n${input.command}`
				: input.command;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let latestProgress:
				| (() => {
						output: string;
						truncation: TruncationResult;
						fullOutputPath?: string;
				  })
				| undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitUpdate = () => {
				if (!onUpdate || !updateDirty || !latestProgress) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const progress = latestProgress();
				onUpdate({
					content: [{ type: "text", text: progress.output }],
					details: {
						command: input.command,
						cwd: cwd.absolutePath,
						exitCode: null,
						timedOut: false,
						durationMs: Date.now() - startedAt,
						managedProcessesTerminated: false,
						truncation: progress.truncation.truncated ? progress.truncation : undefined,
						fullOutputPath: progress.fullOutputPath,
					},
				});
			};
			const scheduleUpdate = (getProgress: NonNullable<typeof latestProgress>) => {
				if (!onUpdate) return;
				latestProgress = getProgress;
				updateDirty = true;
				const delay = RUN_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					if (updateTimer) clearTimeout(updateTimer);
					updateTimer = undefined;
					emitUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitUpdate();
				}, delay);
			};

			let capture: ShellCaptureResult;
			try {
				capture = getOrThrow(
					await executeShellWithCapture(context.env, resolvedCommand, {
						cwd: cwd.absolutePath,
						env: context.run?.env,
						inheritEnv: context.run?.inheritEnv,
						timeout: input.timeout,
						abortSignal: signal,
						returnExecutionErrors: true,
						onChunk: (_chunk, getProgress) => scheduleUpdate(getProgress),
					}),
				);
			} finally {
				if (updateTimer) clearTimeout(updateTimer);
				updateTimer = undefined;
			}
			if (onUpdate) {
				latestProgress = () => capture;
				updateDirty = true;
				emitUpdate();
			}
			if (capture.cancelled || signal?.aborted) throw new V2ToolError("ABORTED", "Command was aborted.");
			const timedOut = capture.executionError?.code === "timeout";
			if (capture.executionError && !timedOut) {
				throw executionFailure(capture.executionError.code, capture.executionError.message);
			}
			let output = capture.output || "(no output)";
			if (capture.truncation.truncated) {
				output += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} or configured line limit. Full output: ${capture.fullOutputPath ?? "unavailable"}]`;
			}
			output += timedOut
				? `\n\ntimed out${input.timeout ? ` after ${input.timeout}s` : ""}`
				: `\n\nexit ${capture.exitCode ?? 0}`;
			return {
				content: [{ type: "text", text: output }],
				details: {
					command: input.command,
					cwd: cwd.absolutePath,
					exitCode: timedOut ? null : (capture.exitCode ?? 0),
					timedOut,
					durationMs: Date.now() - startedAt,
					managedProcessesTerminated: !timedOut,
					truncation: capture.truncation.truncated ? capture.truncation : undefined,
					fullOutputPath: capture.fullOutputPath,
				},
			};
		},
	};
}
