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
	error?: string;
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
