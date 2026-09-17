import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type BackgroundTaskManager,
	type BackgroundTaskRecord,
	formatTaskDuration,
} from "@earendil-works/pi-agent-core/node";

export const BACKGROUND_TASK_NOTIFICATION_TYPE = "pi-background-task";
/** Custom message type for stall notices (a running task with no output for the stall window). */
export const BACKGROUND_TASK_STALL_NOTIFICATION_TYPE = "pi-background-task-stall";
/** Command preview length for a single-task notification. */
const COMMAND_PREVIEW_CHARS = 120;
/** Shorter command preview so a batch line stays scannable. */
const BATCH_COMMAND_PREVIEW_CHARS = 80;

function outcomeText(record: BackgroundTaskRecord): string {
	if (record.exitCode !== undefined && record.exitCode !== null) return `exit code ${record.exitCode}`;
	if (record.signal) return `signal ${record.signal}`;
	return record.error ?? "no exit status";
}

function commandPreview(record: BackgroundTaskRecord, maxChars: number): string {
	const firstLine = record.command.split("\n", 1)[0];
	return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars - 3)}...` : firstLine;
}

function durationText(record: BackgroundTaskRecord): string {
	return formatTaskDuration((record.endedAt ?? Date.now()) - record.startedAt);
}

export function formatBackgroundTaskNotification(record: BackgroundTaskRecord, options?: { tail?: string }): string {
	const tail = options?.tail?.trim();
	return [
		`Background task ${record.id} finished: ${record.status} (${outcomeText(record)}) after ${durationText(record)}.`,
		`Command: ${commandPreview(record, COMMAND_PREVIEW_CHARS)}`,
		record.logError
			? `Output log unavailable (${record.logError}); only the in-memory tail is available.`
			: `Output log: ${record.outputPath}`,
		record.promoted ? "(promoted from a timed-out foreground command)" : undefined,
		tail ? `Last output:\n${tail}` : undefined,
		// The result alone is often enough; this tells the model how to look closer if it is not.
		`Use task_output(${record.id}) to inspect output.`,
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * One compact message for every task that reached a terminal state inside the same request
 * boundary; per-task output stays reachable through task_output(task_id).
 */
export function formatBackgroundTaskBatchNotification(records: BackgroundTaskRecord[]): string {
	const lines = [`Background tasks finished: ${records.length}`];
	for (const record of records) {
		const markers = [record.promoted ? "promoted" : undefined, record.logError ? "log write failed" : undefined]
			.filter(Boolean)
			.join(", ");
		lines.push(
			`- ${record.id} ${record.status} (${outcomeText(record)}) after ${durationText(record)}` +
				`${markers ? ` [${markers}]` : ""} — ${commandPreview(record, BATCH_COMMAND_PREVIEW_CHARS)}`,
		);
	}
	lines.push("Use task_output(task_id) for output and log paths.");
	return lines.join("\n");
}

export interface BackgroundTaskNotificationDetails {
	tasks: BackgroundTaskRecord[];
}

export interface BackgroundTaskStallNotice {
	task: BackgroundTaskRecord;
	/** Milliseconds without output when the notice fired. */
	silentMs: number;
}

export interface BackgroundTaskStallNotificationDetails {
	notices: BackgroundTaskStallNotice[];
}

/**
 * One compact stall notice. Stalls are informational: the task is still running, and the model (or
 * user) decides whether to inspect it, keep waiting, or stop it.
 */
export function formatBackgroundTaskStallNotification(
	notices: BackgroundTaskStallNotice[],
	options?: { tail?: string },
): string {
	if (notices.length === 1) {
		const [notice] = notices;
		const task = notice?.task;
		if (task) {
			const tail = options?.tail?.trim();
			return [
				`Background task ${task.id} has produced no output for ${formatTaskDuration(notice.silentMs)}` +
					` (status ${task.status}, running ${durationText(task)}). It may be stuck, but it keeps running.`,
				`Command: ${commandPreview(task, COMMAND_PREVIEW_CHARS)}`,
				task.logError ? `Output log unavailable (${task.logError}).` : `Output log: ${task.outputPath}`,
				`Inspect it with task_output(${task.id}), keep waiting with wait_for, or stop it with task_stop.`,
				tail ? `Last output:\n${tail}` : undefined,
			]
				.filter(Boolean)
				.join("\n");
		}
	}
	const lines = [`Background tasks with no output for their stall window: ${notices.length}`];
	for (const { task, silentMs } of notices) {
		lines.push(
			`- ${task.id} silent ${formatTaskDuration(silentMs)} (running ${durationText(task)}, status ${task.status})` +
				` — ${commandPreview(task, BATCH_COMMAND_PREVIEW_CHARS)}`,
		);
	}
	lines.push(
		"They keep running; use task_output(task_id) to inspect, wait_for to keep waiting, or task_stop to stop one.",
	);
	return lines.join("\n");
}

export interface BackgroundTaskNotificationMessage {
	customType: string;
	display: boolean;
	content: string;
	details: BackgroundTaskNotificationDetails;
}

/** How much of a finished task's output is inlined into its completion notice. */
export type BackgroundTaskInlineOutputMode = "failures" | "never" | "tail-lines" | "always";

/** Live inline policy (settings can change between requests). */
export interface BackgroundTaskInlinePolicy {
	mode: BackgroundTaskInlineOutputMode;
	/** Byte budget for `failures`/`always`. */
	bytes: number;
}

const DEFAULT_INLINE_POLICY: BackgroundTaskInlinePolicy = { mode: "failures", bytes: 4 * 1024 };
/** Lines kept by the `tail-lines` mode. */
const INLINE_TAIL_LINES = 3;

/**
 * One-shot terminal-state and stall notifications for background bash tasks.
 *
 * The notice always carries the result itself (status, exit code or signal, duration, command, log
 * path); output is optional evidence: `failures` (default) inlines the last few KB of a task that
 * needs attention, `always` does it for successes too, `tail-lines` keeps only the last lines, and
 * `never` leaves the notice as a pure result plus a pointer.
 *
 * Terminal events queue here; the queue is drained by the AgentSession transformContext wrapper,
 * which persists each notification as a custom session message and appends it to the next provider
 * request. Tasks that finished inside the same boundary are coalesced into one message so a
 * fan-out of tasks cannot flood the request, and stall notices are coalesced the same way. Stalls
 * never stop a task: they tell the model a running task has gone quiet. A task whose result was
 * consumed by wait_for never notifies.
 */
export class BackgroundTaskNotifications {
	private pending: BackgroundTaskRecord[] = [];
	/** Latest stall notice per task; a repeat notice replaces the older entry. */
	private readonly stalls = new Map<string, BackgroundTaskStallNotice>();
	private readonly consumed = new Set<string>();
	private unsubscribes: Array<() => void> = [];
	/** Manager used for inline output tails (null until bound to a live manager). */
	private manager: BackgroundTaskManager | undefined;
	/** Inline policy supplier; defaults match the shipped settings defaults. */
	private inlinePolicy: () => BackgroundTaskInlinePolicy = () => DEFAULT_INLINE_POLICY;

	/** Subscribe to a task manager's terminal and stall events (rebinds when the manager is recreated). */
	bind(manager: BackgroundTaskManager, options?: { inlinePolicy?: () => BackgroundTaskInlinePolicy }): void {
		for (const unsubscribe of this.unsubscribes) unsubscribe();
		this.manager = manager;
		if (options?.inlinePolicy) this.inlinePolicy = options.inlinePolicy;
		this.unsubscribes = [
			manager.onTerminal((record) => {
				if (!this.consumed.has(record.id)) this.pending.push(record);
			}),
			manager.onStall((record, info) => {
				if (this.consumed.has(record.id)) return;
				this.stalls.set(record.id, { task: record, silentMs: info.silentMs });
			}),
		];
	}

	/** Mark a task's terminal result as consumed via wait_for; suppresses its notifications. */
	markConsumedByWaitFor(taskId: string): void {
		this.consumed.add(taskId);
		this.pending = this.pending.filter((record) => record.id !== taskId);
		this.stalls.delete(taskId);
	}

	/** Number of queued, unconsumed terminal notifications (for tests and diagnostics). */
	get pendingCount(): number {
		return this.pending.length;
	}

	/** Number of queued stall notices, one per task (for tests and diagnostics). */
	get pendingStallCount(): number {
		return this.stalls.size;
	}

	/** True when a background task's terminal result was consumed via wait_for (notification suppressed). */
	isConsumed(taskId: string): boolean {
		return this.consumed.has(taskId);
	}

	/**
	 * Persist and project all due notifications. Terminal results are coalesced into one message and
	 * stall notices into another; both are appended to the outgoing provider request. Failed sends
	 * are requeued for the next request boundary.
	 */
	async drain(send: (message: BackgroundTaskNotificationMessage) => Promise<void>): Promise<AgentMessage[]> {
		const due = this.pending.splice(0).filter((record) => !this.consumed.has(record.id));
		const stallNotices = [...this.stalls.values()].filter((notice) => !this.consumed.has(notice.task.id));
		this.stalls.clear();
		const added: AgentMessage[] = [];
		if (due.length > 0) {
			const message: BackgroundTaskNotificationMessage = {
				customType: BACKGROUND_TASK_NOTIFICATION_TYPE,
				display: true,
				details: { tasks: due },
				content:
					due.length === 1
						? formatBackgroundTaskNotification(due[0]!, { tail: this._inlineTail(due[0]!) })
						: formatBackgroundTaskBatchNotification(due),
			};
			try {
				await send(message);
				added.push({ role: "custom", ...message, timestamp: Date.now() });
			} catch {
				// Requeue in arrival order for the next request boundary.
				this.pending.unshift(...due);
			}
		}
		if (stallNotices.length > 0) {
			const message: BackgroundTaskNotificationMessage = {
				customType: BACKGROUND_TASK_STALL_NOTIFICATION_TYPE,
				display: true,
				details: { tasks: stallNotices.map((notice) => notice.task) },
				content: formatBackgroundTaskStallNotification(stallNotices, {
					tail: stallNotices.length === 1 ? this._inlineTail(stallNotices[0]!.task, { always: true }) : undefined,
				}),
			};
			try {
				await send(message);
				added.push({ role: "custom", ...message, timestamp: Date.now() });
			} catch {
				for (const notice of stallNotices) this.stalls.set(notice.task.id, notice);
			}
		}
		return added;
	}

	/**
	 * Inline output for a task. Failures, timeouts, and log problems ship their last output so the
	 * model can diagnose without a second tool call; successes follow the configured policy
	 * (pointer-only by default). `always` forces inlining for stalled tasks, whose newest output is
	 * the evidence for judging where they went quiet.
	 */
	private _inlineTail(record: BackgroundTaskRecord, options?: { always?: boolean }): string | undefined {
		const { mode, bytes } = this.inlinePolicy();
		if (mode === "never") return undefined;
		const needsAttention =
			record.status === "failed" || record.status === "timed_out" || !!record.logError || !!record.logTruncated;
		if (mode === "failures" && !needsAttention && options?.always !== true) return undefined;
		const limit = mode === "tail-lines" ? Math.max(512, Math.min(bytes, 4 * 1024)) : bytes;
		const output = this.manager?.readOutput(record.id, limit);
		const text = output?.ok ? output.value.output.trim() : "";
		if (text.length === 0) return undefined;
		if (mode !== "tail-lines") return text;
		const lines = text.split("\n").filter((line) => line.trim().length > 0);
		return lines.slice(-INLINE_TAIL_LINES).join("\n");
	}

	dispose(): void {
		for (const unsubscribe of this.unsubscribes) unsubscribe();
		this.unsubscribes = [];
		this.manager = undefined;
		this.pending = [];
		this.stalls.clear();
	}
}
