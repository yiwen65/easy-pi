import { stripVTControlCharacters } from "node:util";
import {
	type BackgroundTaskRecord,
	type BackgroundTaskStatus,
	formatTaskDuration,
	isBackgroundTaskStalled,
	isTerminalTaskStatus,
} from "@earendil-works/pi-agent-core/node";

/** Icon, word, and color for every task state, shared by the transcript block and the /tasks panel. */
export const BACKGROUND_TASK_STATUS_PRESENTATION: Record<
	BackgroundTaskStatus,
	{ icon: string; word: string; color: "success" | "warning" | "error" | "muted" | "dim" }
> = {
	running: { icon: "●", word: "Running", color: "success" },
	stopping: { icon: "◌", word: "Stopping", color: "warning" },
	succeeded: { icon: "✓", word: "Done", color: "dim" },
	failed: { icon: "✗", word: "Failed", color: "error" },
	timed_out: { icon: "⏱", word: "Timed out", color: "error" },
	stopped: { icon: "■", word: "Stopped", color: "muted" },
};

/** Strip terminal control characters and expand tabs; multi-line output stays multi-line. */
export function safeBackgroundTaskText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/\t/g, "    ");
}

/** Safe rendering collapsed onto one line, for commands and single-line summaries. */
export function oneLineBackgroundTaskText(text: string): string {
	return safeBackgroundTaskText(text).replace(/\s+/g, " ");
}

/** Running tasks show live elapsed time; terminal tasks keep their runtime duration (start -> end). */
export function backgroundTaskDuration(record: BackgroundTaskRecord, now: number): string {
	return formatTaskDuration((record.endedAt ?? now) - record.startedAt);
}

/**
 * Stall badge for a running task that has been silent past the stall window; undefined when the task
 * is fine. A stall is informational: the task keeps running, so the badge never implies a failure.
 */
export function backgroundTaskStallHint(
	record: BackgroundTaskRecord,
	now: number,
	stallTimeoutMs: number,
): string | undefined {
	if (!isBackgroundTaskStalled(record, now, stallTimeoutMs)) return undefined;
	return `⏸ no output ${formatTaskDuration(now - (record.lastOutputAt ?? record.startedAt))}`;
}

/** Active tasks first (oldest started), then terminal tasks (newest finished). */
export function sortBackgroundTasks(records: readonly BackgroundTaskRecord[]): BackgroundTaskRecord[] {
	const active = records.filter((record) => !isTerminalTaskStatus(record.status));
	const terminal = records.filter((record) => isTerminalTaskStatus(record.status));
	active.sort((a, b) => a.startedAt - b.startedAt);
	terminal.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
	return [...active, ...terminal];
}
