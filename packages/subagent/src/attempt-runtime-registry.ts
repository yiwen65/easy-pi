import type { ChildAgentRuntime } from "./child-agent-runtime.ts";
import type { LiveActivity } from "./live-activity.ts";
import type { ChildRuntimeMetadata, DagRunLease } from "./types.ts";

export interface LiveAttemptRuntime {
	runId: string;
	taskId: string;
	attemptId: string;
	ownerId: string;
	runtime: ChildAgentRuntime;
	metadata: ChildRuntimeMetadata;
	liveActivity?: LiveActivity;
	runLease(): DagRunLease;
}

export type LiveAttemptControl = "message" | "follow_up" | "interrupt";

function key(runId: string, taskId: string): string {
	return `${runId}\0${taskId}`;
}

export class AttemptRuntimeRegistry {
	private readonly entries = new Map<string, LiveAttemptRuntime>();

	set(entry: LiveAttemptRuntime): void {
		this.entries.set(key(entry.runId, entry.taskId), entry);
	}

	get(runId: string, taskId: string): LiveAttemptRuntime | undefined {
		return this.entries.get(key(runId, taskId));
	}

	update(runId: string, taskId: string, runtime: ChildAgentRuntime, metadata: ChildRuntimeMetadata): void {
		const entry = this.get(runId, taskId);
		if (entry?.runtime === runtime) entry.metadata = metadata;
	}

	updateLiveActivity(runId: string, taskId: string, runtime: ChildAgentRuntime, activity: LiveActivity): void {
		const entry = this.get(runId, taskId);
		if (entry?.runtime === runtime) entry.liveActivity = activity;
	}

	delete(runId: string, taskId: string, runtime: ChildAgentRuntime): void {
		const entry = this.get(runId, taskId);
		if (entry?.runtime === runtime) this.entries.delete(key(runId, taskId));
	}

	async control(entry: LiveAttemptRuntime, operation: LiveAttemptControl, message?: string): Promise<void> {
		if (operation === "message") await entry.runtime.prompt(message!, "steer");
		else if (operation === "follow_up") await entry.runtime.followUp(message!);
		else await entry.runtime.abort();
	}
}
