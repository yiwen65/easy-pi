import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionError, err, ok, type Result, toError } from "../types.ts";
import { sanitizeBinaryOutput, trimToLastUtf8Bytes } from "../utils/shell-output.ts";
import {
	killNodeProcessTree,
	type NodeProcessShellConfig,
	type NodePromotedProcess,
	observeChildProcess,
	spawnShellChild,
	terminateNodeProcessTree,
} from "./node-process-executor.ts";

export const DEFAULT_BACKGROUND_TIMEOUT_MS = 600_000;
export const DEFAULT_STOP_GRACE_MS = 5_000;
/** Preview reads come from a bounded in-memory tail; the log file always holds the full output. */
const TAIL_BUFFER_BYTES = 128 * 1024;

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
	/** Sanitized tail preview of at most the requested bytes. */
	output: string;
	outputPath: string;
	totalBytes: number;
	truncated: boolean;
}

export interface BackgroundTaskManagerOptions {
	/** Resolve the shell configuration used for tasks started directly in the background. */
	shell: () => Promise<Result<NodeProcessShellConfig, ExecutionError>>;
	/** Merge caller-provided variables into the final process environment (host shell environment rules). */
	resolveEnv?: (env: Record<string, string>, inheritEnv: boolean) => NodeJS.ProcessEnv;
	/** Background runtime bound in milliseconds. Defaults to 600s; 0 disables the timeout. */
	defaultTimeoutMs?: number;
	/** Grace period between SIGTERM and SIGKILL when stopping. Defaults to 5s. */
	stopGraceMs?: number;
	/** Directory for task output logs. Defaults to the OS temp directory. */
	logDir?: string;
	now?: () => number;
	generateId?: () => string;
}

interface ManagedTask {
	record: BackgroundTaskRecord;
	child?: ChildProcess;
	logStream?: WriteStream;
	tail: string;
	totalBytes: number;
	timeoutId?: ReturnType<typeof setTimeout>;
	stopGraceId?: ReturnType<typeof setTimeout>;
	stopRequested: boolean;
	timedOut: boolean;
	waiters: Array<() => void>;
}

export function isTerminalTaskStatus(status: BackgroundTaskStatus): boolean {
	return status !== "running" && status !== "stopping";
}

function appendTail(tail: string, chunk: string): string {
	return trimToLastUtf8Bytes(tail + chunk, TAIL_BUFFER_BYTES, new TextEncoder());
}

/**
 * Owns background bash tasks: processes spawned directly in the background or promoted from a
 * foreground execution on timeout. Output streams to a per-task log file plus a bounded in-memory
 * tail; stopping is two-phase (SIGTERM -> grace -> SIGKILL on the process group).
 */
export class BackgroundTaskManager {
	private readonly tasks = new Map<string, ManagedTask>();
	private readonly terminalListeners = new Set<(task: BackgroundTaskRecord) => void>();
	private readonly startListeners = new Set<(task: BackgroundTaskRecord) => void>();
	private readonly shell: () => Promise<Result<NodeProcessShellConfig, ExecutionError>>;
	private readonly resolveEnv: (env: Record<string, string>, inheritEnv: boolean) => NodeJS.ProcessEnv;
	private readonly defaultTimeoutMs: number;
	private readonly stopGraceMs: number;
	private readonly logDir: string;
	private readonly now: () => number;
	private readonly generateId: () => string;
	private counter = 0;

	constructor(options: BackgroundTaskManagerOptions) {
		this.shell = options.shell;
		this.resolveEnv =
			options.resolveEnv ?? ((env, inheritEnv) => (inheritEnv ? { ...process.env, ...env } : { ...env }));
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS;
		this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
		this.logDir = options.logDir ?? tmpdir();
		this.now = options.now ?? (() => Date.now());
		this.generateId = options.generateId ?? (() => `task-${++this.counter}`);
	}

	/** Start a command directly in the background. stdin is closed (immediate EOF). */
	async start(
		command: string,
		options: { cwd: string; env?: NodeJS.ProcessEnv; inheritEnv?: boolean; timeoutMs?: number },
	): Promise<Result<BackgroundTaskRecord, ExecutionError>> {
		try {
			await access(options.cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return err(new ExecutionError("spawn_error", `Working directory does not exist: ${options.cwd}`, cause));
		}
		const shell = await this.shell();
		if (!shell.ok) return shell;
		const managed = this.createTask(command, options.cwd, false, options.timeoutMs);
		let child: ChildProcess;
		try {
			const env = Object.fromEntries(
				Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
			);
			child = spawnShellChild(shell.value, command, {
				cwd: options.cwd,
				env: this.resolveEnv(env, options.inheritEnv ?? true),
			});
		} catch (error) {
			const cause = toError(error);
			this.tasks.delete(managed.record.id);
			managed.logStream?.destroy();
			return err(new ExecutionError("spawn_error", cause.message, cause));
		}
		this.attach(managed, child);
		this.emitStart(managed);
		return ok({ ...managed.record });
	}

	/**
	 * Adopt a still-running foreground process after a timeout promotion. Synchronous by contract:
	 * detaches the previous owner's listeners first, then starts draining output to the task log.
	 * Output produced before the promotion is not part of the task log.
	 */
	adopt(handle: NodePromotedProcess, meta: { command: string; cwd: string; timeoutMs?: number }): string {
		const managed = this.createTask(meta.command, meta.cwd, true, meta.timeoutMs);
		handle.detach();
		this.attach(managed, handle.child);
		this.emitStart(managed);
		return managed.record.id;
	}

	get(id: string): BackgroundTaskRecord | undefined {
		const managed = this.tasks.get(id);
		return managed ? { ...managed.record } : undefined;
	}

	list(options?: { activeOnly?: boolean }): BackgroundTaskRecord[] {
		const activeOnly = options?.activeOnly ?? true;
		return [...this.tasks.values()]
			.filter((managed) => !activeOnly || !isTerminalTaskStatus(managed.record.status))
			.map((managed) => ({ ...managed.record }));
	}

	/** Subscribe to task starts (background start or foreground promotion). Returns an unsubscribe function. */
	onStart(listener: (task: BackgroundTaskRecord) => void): () => void {
		this.startListeners.add(listener);
		return () => this.startListeners.delete(listener);
	}

	/** Subscribe to terminal-state transitions. Returns an unsubscribe function. */
	onTerminal(listener: (task: BackgroundTaskRecord) => void): () => void {
		this.terminalListeners.add(listener);
		return () => this.terminalListeners.delete(listener);
	}

	/**
	 * Two-phase stop: SIGTERM the process group, then SIGKILL after the grace period.
	 * Safe (no-op) on tasks that already reached a terminal state.
	 */
	async stop(id: string): Promise<Result<BackgroundTaskRecord, ExecutionError>> {
		const managed = this.tasks.get(id);
		if (!managed) return err(new ExecutionError("not_found", `Unknown background task: ${id}`));
		if (isTerminalTaskStatus(managed.record.status)) return ok({ ...managed.record });
		if (managed.record.status === "running") {
			managed.stopRequested = true;
			managed.record.status = "stopping";
			this.beginTwoPhaseTermination(managed);
		}
		return ok({ ...managed.record });
	}

	/** Wait for a terminal state or the timeout; the result is a snapshot, never a cancellation. */
	async wait(
		id: string,
		timeoutMs: number,
	): Promise<Result<{ task: BackgroundTaskRecord; timedOut: boolean }, ExecutionError>> {
		const managed = this.tasks.get(id);
		if (!managed) return err(new ExecutionError("not_found", `Unknown background task: ${id}`));
		if (isTerminalTaskStatus(managed.record.status)) {
			return ok({ task: { ...managed.record }, timedOut: false });
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const index = managed.waiters.indexOf(onTerminal);
				if (index >= 0) managed.waiters.splice(index, 1);
				resolve(ok({ task: { ...managed.record }, timedOut: true }));
			}, timeoutMs);
			const onTerminal = (): void => {
				clearTimeout(timer);
				resolve(ok({ task: { ...managed.record }, timedOut: false }));
			};
			managed.waiters.push(onTerminal);
		});
	}

	/** Tail preview (default 32KB) from the in-memory buffer plus the full log path for paged reads. */
	readOutput(id: string, maxBytes = 32 * 1024): Result<BackgroundTaskOutput, ExecutionError> {
		const managed = this.tasks.get(id);
		if (!managed) return err(new ExecutionError("not_found", `Unknown background task: ${id}`));
		const encoder = new TextEncoder();
		const tail = trimToLastUtf8Bytes(managed.tail, maxBytes, encoder);
		return ok({
			output: sanitizeBinaryOutput(tail),
			outputPath: managed.record.outputPath,
			totalBytes: managed.totalBytes,
			truncated: managed.totalBytes > encoder.encode(tail).byteLength,
		});
	}

	/** Best-effort shutdown: kill every remaining task process immediately. */
	async cleanup(): Promise<void> {
		for (const managed of this.tasks.values()) {
			if (managed.timeoutId) clearTimeout(managed.timeoutId);
			if (managed.stopGraceId) clearTimeout(managed.stopGraceId);
			if (managed.record.pid !== undefined && !isTerminalTaskStatus(managed.record.status)) {
				killNodeProcessTree(managed.record.pid);
			}
			managed.logStream?.destroy();
		}
		this.tasks.clear();
	}

	private createTask(command: string, cwd: string, promoted: boolean, timeoutMs?: number): ManagedTask {
		const id = this.generateId();
		const outputPath = join(this.logDir, `pi-bash-${id}-${randomUUID().slice(0, 8)}.log`);
		const managed: ManagedTask = {
			record: {
				id,
				command,
				cwd,
				status: "running",
				startedAt: this.now(),
				outputPath,
				promoted,
			},
			tail: "",
			totalBytes: 0,
			stopRequested: false,
			timedOut: false,
			waiters: [],
		};
		managed.logStream = createWriteStream(outputPath, { flags: "w" });
		managed.logStream.on("error", () => {});
		this.tasks.set(id, managed);
		const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;
		if (effectiveTimeoutMs > 0) {
			managed.timeoutId = setTimeout(() => {
				if (isTerminalTaskStatus(managed.record.status)) return;
				managed.timedOut = true;
				managed.record.status = "stopping";
				this.beginTwoPhaseTermination(managed);
			}, effectiveTimeoutMs);
		}
		return managed;
	}

	private attach(managed: ManagedTask, child: ChildProcess): void {
		managed.child = child;
		if (child.pid) managed.record.pid = child.pid;
		const drain = (chunk: Buffer): void => {
			managed.totalBytes += chunk.byteLength;
			managed.tail = appendTail(managed.tail, chunk.toString("utf8"));
			managed.logStream?.write(chunk);
		};
		child.stdout?.on("data", drain);
		child.stderr?.on("data", drain);
		const observer = observeChildProcess(child);
		observer.promise
			.then(({ exitCode, signal }) => this.finalize(managed, exitCode, signal, undefined))
			.catch((error: unknown) => {
				const cause = toError(error);
				this.finalize(managed, null, null, cause.message);
			});
	}

	private beginTwoPhaseTermination(managed: ManagedTask): void {
		if (managed.timeoutId) {
			clearTimeout(managed.timeoutId);
			managed.timeoutId = undefined;
		}
		if (managed.record.pid !== undefined) terminateNodeProcessTree(managed.record.pid);
		managed.stopGraceId = setTimeout(() => {
			managed.stopGraceId = undefined;
			if (isTerminalTaskStatus(managed.record.status)) return;
			if (managed.record.pid !== undefined) killNodeProcessTree(managed.record.pid);
		}, this.stopGraceMs);
	}

	private emitStart(managed: ManagedTask): void {
		const snapshot = { ...managed.record };
		for (const listener of this.startListeners) {
			try {
				listener(snapshot);
			} catch {
				// Start observers cannot change task results.
			}
		}
	}

	private finalize(
		managed: ManagedTask,
		exitCode: number | null,
		signal: string | null,
		error: string | undefined,
	): void {
		if (isTerminalTaskStatus(managed.record.status)) return;
		if (managed.timeoutId) clearTimeout(managed.timeoutId);
		if (managed.stopGraceId) clearTimeout(managed.stopGraceId);
		managed.record.status = managed.stopRequested
			? "stopped"
			: managed.timedOut
				? "timed_out"
				: error !== undefined
					? "failed"
					: exitCode === 0
						? "succeeded"
						: "failed";
		managed.record.endedAt = this.now();
		managed.record.exitCode = exitCode;
		managed.record.signal = signal;
		if (error !== undefined) managed.record.error = error;
		managed.logStream?.end();
		const snapshot = { ...managed.record };
		for (const waiter of managed.waiters.splice(0)) waiter();
		for (const listener of this.terminalListeners) {
			try {
				listener(snapshot);
			} catch {
				// Terminal observers cannot change task results.
			}
		}
	}
}
