import { type Static, Type } from "typebox";
import {
	type BackgroundTaskManagerLike,
	type BackgroundTaskRecord,
	isTerminalTaskStatus,
} from "../env/background-task-types.ts";
import type { AgentHarnessTool } from "../types.ts";
import { formatSize } from "../utils/truncate.ts";
import { ExecutionToolError } from "./execution-tool-error.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const MAX_OUTPUT_PREVIEW_BYTES = 32 * 1024;
const MAX_WAIT_TIMEOUT_SECONDS = 600;
const WAIT_RESULT_TAIL_BYTES = 4 * 1024;

const taskListSchema = Type.Object({
	active_only: Type.Optional(
		Type.Boolean({ description: "List only tasks that are still running or stopping (default true)" }),
	),
});

const taskOutputSchema = Type.Object({
	task_id: Type.String({ description: "Background task ID returned by bash" }),
	max_bytes: Type.Optional(
		Type.Number({
			description: `Tail preview size in bytes (default ${MAX_OUTPUT_PREVIEW_BYTES}, max ${MAX_OUTPUT_PREVIEW_BYTES})`,
		}),
	),
});

const taskStopSchema = Type.Object({
	task_id: Type.String({ description: "Background task ID returned by bash" }),
});

const waitForSchema = Type.Object({
	task_id: Type.String({ description: "Background task ID returned by bash" }),
	timeout: Type.Optional(
		Type.Number({
			description: `Maximum seconds to wait (default ${MAX_WAIT_TIMEOUT_SECONDS}, max ${MAX_WAIT_TIMEOUT_SECONDS}); on timeout the current snapshot is returned`,
		}),
	),
});

export interface TaskListDetails {
	tasks: BackgroundTaskRecord[];
}

export interface TaskOutputDetails {
	task: BackgroundTaskRecord;
	totalBytes: number;
	truncated: boolean;
	outputPath: string;
}

export interface TaskStopDetails {
	task: BackgroundTaskRecord;
}

export interface WaitForDetails {
	task: BackgroundTaskRecord;
	timedOut: boolean;
}

function requireManager(context: ExecutionToolContext): BackgroundTaskManagerLike {
	const manager = context.env.backgroundTasks;
	if (!manager) {
		throw new ExecutionToolError("UNSUPPORTED", "Background tasks are not supported by this execution environment.");
	}
	return manager;
}

function formatElapsed(record: BackgroundTaskRecord, now: number): string {
	const end = record.endedAt ?? now;
	const seconds = Math.max(0, Math.round((end - record.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${seconds % 60}s`;
}

function formatTaskLine(record: BackgroundTaskRecord, now: number): string {
	const firstLine = record.command.split("\n", 1)[0];
	const commandPreview = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
	const suffix =
		record.exitCode !== undefined && record.exitCode !== null
			? ` exit=${record.exitCode}`
			: record.signal
				? ` signal=${record.signal}`
				: "";
	return `${record.id}  ${record.status}${suffix}  ${formatElapsed(record, now)}  ${commandPreview}`;
}

function notFound(taskId: string): ExecutionToolError {
	return new ExecutionToolError("NOT_FOUND", `Unknown background task: ${taskId}`);
}

/** Create the background bash task management tools bound to the execution environment's task manager. */
export function createTaskListTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof taskListSchema,
	TaskListDetails
> {
	return {
		name: "task_list",
		label: "task_list",
		description:
			"List background bash tasks started with run_in_background or promoted from a timed-out foreground command. By default only active tasks are shown; pass active_only=false to include finished ones.",
		parameters: taskListSchema,
		replay: "safe",
		async execute(_toolCallId, { active_only }, _signal, _onUpdate, context) {
			const manager = requireManager(context);
			const tasks = manager.list({ activeOnly: active_only ?? true });
			const now = Date.now();
			const text = tasks.length
				? tasks.map((task) => formatTaskLine(task, now)).join("\n")
				: active_only === false
					? "No background tasks."
					: "No active background tasks.";
			return { content: [{ type: "text", text }], details: { tasks } };
		},
	};
}

export function createTaskOutputTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof taskOutputSchema,
	TaskOutputDetails
> {
	return {
		name: "task_output",
		label: "task_output",
		description: `Non-blocking snapshot of a background bash task's output: the most recent ${MAX_OUTPUT_PREVIEW_BYTES / 1024}KB at most, plus the output_path of the full log for paged reading with the read tool. Never waits for the task.`,
		parameters: taskOutputSchema,
		replay: "safe",
		async execute(_toolCallId, { task_id, max_bytes }, _signal, _onUpdate, context) {
			const manager = requireManager(context);
			const maxBytes = Math.min(
				Math.max(1, Math.floor(max_bytes ?? MAX_OUTPUT_PREVIEW_BYTES)),
				MAX_OUTPUT_PREVIEW_BYTES,
			);
			const result = manager.readOutput(task_id, maxBytes);
			if (!result.ok) throw notFound(task_id);
			const task = manager.get(task_id);
			if (!task) throw notFound(task_id);
			const { output, outputPath, totalBytes, truncated } = result.value;
			const header = `Task ${task.id} (${task.status})\n`;
			const footer = truncated
				? `\n\n[Showing last ${formatSize(output.length)} of ${formatSize(totalBytes)}. Full output: ${outputPath} — use the read tool for paging.]`
				: "";
			return {
				content: [{ type: "text", text: `${header}${output || "(no output yet)"}${footer}` }],
				details: { task, totalBytes, truncated, outputPath },
			};
		},
	};
}

export function createTaskStopTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof taskStopSchema,
	TaskStopDetails
> {
	return {
		name: "task_stop",
		label: "task_stop",
		description:
			"Stop a background bash task: SIGTERM first, then SIGKILL after a 5-second grace period. Safe on tasks that already finished.",
		parameters: taskStopSchema,
		replay: "never",
		async execute(_toolCallId, { task_id }, _signal, _onUpdate, context) {
			const manager = requireManager(context);
			const result = await manager.stop(task_id);
			if (!result.ok) throw notFound(task_id);
			const task = result.value;
			const text = isTerminalTaskStatus(task.status)
				? `Task ${task.id} already reached a terminal state (${task.status}).`
				: `Stop requested for task ${task.id} (SIGTERM; SIGKILL follows after the grace period).`;
			return { content: [{ type: "text", text }], details: { task } };
		},
	};
}

export function createWaitForTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof waitForSchema,
	WaitForDetails
> {
	return {
		name: "wait_for",
		label: "wait_for",
		description: `Block until a background bash task reaches a terminal state or the timeout elapses (max ${MAX_WAIT_TIMEOUT_SECONDS}s). Returns the task snapshot either way; a timeout does not stop the task.`,
		parameters: waitForSchema,
		replay: "never",
		async execute(_toolCallId, { task_id, timeout }, signal, _onUpdate, context) {
			const manager = requireManager(context);
			if (signal?.aborted) throw new ExecutionToolError("ABORTED", "Wait aborted");
			const timeoutSeconds = Math.min(Math.max(1, timeout ?? MAX_WAIT_TIMEOUT_SECONDS), MAX_WAIT_TIMEOUT_SECONDS);
			const result = await manager.wait(task_id, timeoutSeconds * 1000);
			if (signal?.aborted) throw new ExecutionToolError("ABORTED", "Wait aborted");
			if (!result.ok) throw notFound(task_id);
			const { task, timedOut } = result.value;
			let text: string;
			if (timedOut) {
				text = `Task ${task.id} is still ${task.status} after ${timeoutSeconds}s.`;
			} else {
				const outcome =
					task.exitCode !== undefined && task.exitCode !== null
						? `exit code ${task.exitCode}`
						: task.signal
							? `signal ${task.signal}`
							: "no exit status";
				text = `Task ${task.id} finished: ${task.status} (${outcome}) after ${formatElapsed(task, Date.now())}.\nOutput log: ${task.outputPath}`;
				const tail = manager.readOutput(task_id, WAIT_RESULT_TAIL_BYTES);
				if (tail.ok && tail.value.output) {
					text += `\n\nLast output:\n${tail.value.output}${tail.value.truncated ? `\n[...] Full output: ${tail.value.outputPath}` : ""}`;
				}
			}
			return { content: [{ type: "text", text }], details: { task, timedOut } };
		},
	};
}

/** All four background task management tools. */
export function createBackgroundTaskTools() {
	return [createTaskListTool(), createTaskOutputTool(), createTaskStopTool(), createWaitForTool()];
}

export type TaskListInput = Static<typeof taskListSchema>;
export type TaskOutputInput = Static<typeof taskOutputSchema>;
export type TaskStopInput = Static<typeof taskStopSchema>;
export type WaitForInput = Static<typeof waitForSchema>;
