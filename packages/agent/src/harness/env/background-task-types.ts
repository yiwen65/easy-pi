import type { ExecutionError, Result } from "../types.ts";

export type BackgroundTaskStatus = "running" | "stopping" | "succeeded" | "failed" | "timed_out" | "stopped";

export interface BackgroundTaskRecord {
	id: string;
	command: string;
	cwd: string;
	status: BackgroundTaskStatus;
	pid?: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: string | null;
	outputPath: string;
	promoted: boolean;
	/** Wall-clock time of the last stdout/stderr chunk (or the start time when the task never printed). */
	lastOutputAt: number;
	error?: string;
	/** Set when the output log file could not be written; the in-memory tail preview stays available. */
	logError?: string;
	/** Set when the output log reached the byte budget; the file stops growing at that point. */
	logTruncated?: boolean;
}

export interface BackgroundTaskOutput {
	output: string;
	outputPath: string;
	totalBytes: number;
	truncated: boolean;
}

export interface BackgroundTaskManagerLike {
	start(
		command: string,
		options: { cwd: string; env?: Record<string, string | undefined>; inheritEnv?: boolean; timeoutMs?: number },
	): Promise<Result<BackgroundTaskRecord, ExecutionError>>;
	get(id: string): BackgroundTaskRecord | undefined;
	list(options?: { activeOnly?: boolean }): BackgroundTaskRecord[];
	stop(id: string): Promise<Result<BackgroundTaskRecord, ExecutionError>>;
	wait(
		id: string,
		timeoutMs: number,
	): Promise<Result<{ task: BackgroundTaskRecord; timedOut: boolean }, ExecutionError>>;
	readOutput(id: string, maxBytes?: number): Result<BackgroundTaskOutput, ExecutionError>;
	onStart(listener: (task: BackgroundTaskRecord) => void): () => void;
	onTerminal(listener: (task: BackgroundTaskRecord) => void): () => void;
	shutdown?(options?: { timeoutMs?: number }): Promise<{
		complete: boolean;
		completed: string[];
		failed: string[];
		timedOut: string[];
		remaining: string[];
	}>;
	cleanup(): Promise<void>;
}

export function isTerminalTaskStatus(status: BackgroundTaskStatus): boolean {
	return status !== "running" && status !== "stopping";
}

/**
 * True when a running task has produced no output for at least the stall window. A stall is a
 * notice, never a termination: the task keeps running until it exits or is stopped.
 */
export function isBackgroundTaskStalled(record: BackgroundTaskRecord, now: number, stallTimeoutMs: number): boolean {
	if (stallTimeoutMs <= 0 || isTerminalTaskStatus(record.status)) return false;
	return now - (record.lastOutputAt ?? record.startedAt) >= stallTimeoutMs;
}
