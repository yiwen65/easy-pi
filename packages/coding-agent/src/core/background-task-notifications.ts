import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BackgroundTaskManager, BackgroundTaskRecord } from "@earendil-works/pi-agent-core/node";

export const BACKGROUND_TASK_NOTIFICATION_TYPE = "pi-background-task";

function formatElapsed(record: BackgroundTaskRecord): string {
	const seconds = Math.max(0, Math.round(((record.endedAt ?? Date.now()) - record.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export function formatBackgroundTaskNotification(record: BackgroundTaskRecord): string {
	const firstLine = record.command.split("\n", 1)[0];
	const commandPreview = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
	const outcome =
		record.exitCode !== undefined && record.exitCode !== null
			? `exit code ${record.exitCode}`
			: record.signal
				? `signal ${record.signal}`
				: (record.error ?? "no exit status");
	return [
		`Background task ${record.id} finished: ${record.status} (${outcome}) after ${formatElapsed(record)}.`,
		`Command: ${commandPreview}`,
		`Output log: ${record.outputPath}`,
		record.promoted ? "(promoted from a timed-out foreground command)" : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * One-shot terminal-state notifications for background bash tasks.
 *
 * Terminal events queue here; the queue is drained by the AgentSession transformContext wrapper,
 * which persists each notification as a custom session message and appends it to the next provider
 * request. A task whose terminal result was consumed by wait_for never notifies.
 */
export class BackgroundTaskNotifications {
	private pending: BackgroundTaskRecord[] = [];
	private readonly consumed = new Set<string>();
	private unsubscribe?: () => void;

	/** Subscribe to a task manager's terminal events (rebinds when the manager is recreated). */
	bind(manager: BackgroundTaskManager): void {
		this.unsubscribe?.();
		this.unsubscribe = manager.onTerminal((record) => {
			if (!this.consumed.has(record.id)) this.pending.push(record);
		});
	}

	/** Mark a task's terminal result as consumed via wait_for; suppresses its notification. */
	markConsumedByWaitFor(taskId: string): void {
		this.consumed.add(taskId);
		this.pending = this.pending.filter((record) => record.id !== taskId);
	}

	/** Number of queued, unconsumed notifications (for tests and diagnostics). */
	get pendingCount(): number {
		return this.pending.length;
	}

	/** True when a task's terminal result was consumed via wait_for (notification suppressed). */
	isConsumed(taskId: string): boolean {
		return this.consumed.has(taskId);
	}

	/**
	 * Persist and project all due notifications. Returns the custom messages to append to the
	 * outgoing provider request. Failed sends are requeued for the next request boundary.
	 */
	async drain(
		send: (message: {
			customType: string;
			display: boolean;
			content: string;
			details: BackgroundTaskRecord;
		}) => Promise<void>,
	): Promise<AgentMessage[]> {
		if (this.pending.length === 0) return [];
		const due = this.pending.splice(0);
		const added: AgentMessage[] = [];
		for (const record of due) {
			if (this.consumed.has(record.id)) continue;
			const message = {
				customType: BACKGROUND_TASK_NOTIFICATION_TYPE,
				display: true,
				details: record,
				content: formatBackgroundTaskNotification(record),
			};
			try {
				await send(message);
			} catch {
				this.pending.push(record);
				continue;
			}
			added.push({ role: "custom", ...message, timestamp: Date.now() });
		}
		return added;
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.pending = [];
	}
}
