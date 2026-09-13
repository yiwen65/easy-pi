import { type ChildProcess, spawn } from "node:child_process";
import { ExecutionError, err, ok, type Result, toError } from "../types.ts";

const EXIT_STDIO_GRACE_MS = 100;

export interface NodeProcessShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

export interface NodeProcessExecutionOptions {
	shell: NodeProcessShellConfig;
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
	abortSignal?: AbortSignal;
	onStdout?: (chunk: Uint8Array) => void;
	onStderr?: (chunk: Uint8Array) => void;
	/**
	 * When set, a timeout does not kill the process; ownership transfers synchronously via
	 * {@link NodeProcessPromotion.adopt} and the execution resolves with `promotedTaskId`.
	 */
	promoteOnTimeout?: NodeProcessPromotion;
}

export interface NodePromotedProcess {
	pid: number | undefined;
	child: ChildProcess;
	/** Remove every executor listener without destroying streams; after detach the executor no longer observes the child. */
	detach: () => void;
}

export interface NodeProcessPromotion {
	/** Adopt the still-running process and return its background task ID. Throwing falls back to termination. */
	adopt: (handle: NodePromotedProcess) => string;
}

export interface NodeProcessExecutionResult {
	exitCode: number | null;
	signal: string | null;
	/** Set when the process timed out and was promoted to a background task; exitCode/signal are then null. */
	promotedTaskId?: string;
}

export interface NodeProcessExecutorOptions {
	onProcessStart?: (pid: number) => void;
	onProcessEnd?: (pid: number) => void;
}

type ChildExit = {
	exitCode: number | null;
	signal: string | null;
};

/** Kill one process and its descendants using the platform's strongest available primitive. */
export function killNodeProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// Best-effort cleanup.
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already exited.
		}
	}
}

/**
 * Politely terminate one process and its descendants (first phase of two-phase stop).
 * POSIX sends SIGTERM to the process group; win32 uses taskkill without /F, which only
 * reaches processes that handle close messages. Follow up with killNodeProcessTree after a grace period.
 */
export function terminateNodeProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// Best-effort cleanup.
		}
		return;
	}

	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Process already exited.
		}
	}
}

/** Spawn the shell child shared by foreground execution and background task management. */
export function spawnShellChild(
	shell: NodeProcessShellConfig,
	command: string,
	options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess {
	const commandFromStdin = shell.commandTransport === "stdin";
	const child = spawn(shell.shell, commandFromStdin ? shell.args : [...shell.args, command], {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		env: options.env,
		stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (commandFromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(command);
	}
	return child;
}

export interface ChildProcessObserver {
	/** Resolves with the child's exit state. Never settles after {@link ChildProcessObserver.detach}. */
	promise: Promise<ChildExit>;
	/** True once the exit state is known. */
	settled: () => boolean;
	/** Stop observing without destroying stdio streams; used when ownership transfers to a background task. */
	detach: () => void;
}

/**
 * Wait for the shell while retaining output from descendants until inherited pipes
 * either close or remain idle for a short grace period.
 */
export function observeChildProcess(child: ChildProcess): ChildProcessObserver {
	let settled = false;
	let detached = false;
	let exited = false;
	let exitCode: number | null = null;
	let signal: string | null = null;
	let postExitTimer: ReturnType<typeof setTimeout> | undefined;
	let stdoutEnded = child.stdout === null;
	let stderrEnded = child.stderr === null;
	let resolvePromise!: (exit: ChildExit) => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<ChildExit>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	// A detached observer never settles; keep the pending promise from triggering unhandled rejections.
	promise.catch(() => {});

	const cleanup = (): void => {
		if (postExitTimer) clearTimeout(postExitTimer);
		child.removeListener("error", onError);
		child.removeListener("exit", onExit);
		child.removeListener("close", onClose);
		child.stdout?.removeListener("end", onStdoutEnd);
		child.stderr?.removeListener("end", onStderrEnd);
		child.stdout?.removeListener("data", onData);
		child.stderr?.removeListener("data", onData);
	};
	const finalize = (code: number | null, exitSignal: string | null): void => {
		if (settled || detached) return;
		settled = true;
		cleanup();
		child.stdout?.destroy();
		child.stderr?.destroy();
		resolvePromise({ exitCode: code, signal: exitSignal });
	};
	const maybeFinalizeAfterExit = (): void => {
		if (exited && stdoutEnded && stderrEnded) finalize(exitCode, signal);
	};
	const armIdleTimer = (): void => {
		if (postExitTimer) clearTimeout(postExitTimer);
		postExitTimer = setTimeout(() => finalize(exitCode, signal), EXIT_STDIO_GRACE_MS);
	};
	const onData = (): void => {
		if (exited && !settled) armIdleTimer();
	};
	const onStdoutEnd = (): void => {
		stdoutEnded = true;
		maybeFinalizeAfterExit();
	};
	const onStderrEnd = (): void => {
		stderrEnded = true;
		maybeFinalizeAfterExit();
	};
	const onError = (error: Error): void => {
		if (settled || detached) return;
		settled = true;
		cleanup();
		rejectPromise(error);
	};
	const onExit = (code: number | null, exitSignal: string | null): void => {
		exited = true;
		exitCode = code;
		signal = exitSignal;
		maybeFinalizeAfterExit();
		if (!settled) armIdleTimer();
	};
	const onClose = (code: number | null, exitSignal: string | null): void => {
		finalize(exited ? exitCode : code, exited ? signal : exitSignal);
	};

	child.stdout?.once("end", onStdoutEnd);
	child.stderr?.once("end", onStderrEnd);
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	child.once("error", onError);
	child.once("exit", onExit);
	child.once("close", onClose);

	return {
		promise,
		settled: () => settled,
		detach: () => {
			if (settled || detached) return;
			detached = true;
			cleanup();
		},
	};
}

/** Shared one-shot foreground process lifecycle used by the local Bash and Run facades. */
export class NodeProcessExecutor {
	private readonly activePids = new Set<number>();
	private readonly onProcessStart: ((pid: number) => void) | undefined;
	private readonly onProcessEnd: ((pid: number) => void) | undefined;

	constructor(options: NodeProcessExecutorOptions = {}) {
		this.onProcessStart = options.onProcessStart;
		this.onProcessEnd = options.onProcessEnd;
	}

	async execute(
		command: string,
		options: NodeProcessExecutionOptions,
	): Promise<Result<NodeProcessExecutionResult, ExecutionError>> {
		if (options.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		let child: ReturnType<typeof spawn> | undefined;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		let promotedTaskId: string | undefined;
		let callbackError: ExecutionError | undefined;
		let trackedPid: number | undefined;

		const terminate = (): void => {
			if (child?.pid) killNodeProcessTree(child.pid);
		};
		const onAbort = (): void => terminate();
		const releaseProcess = (): void => {
			if (trackedPid === undefined || !this.activePids.delete(trackedPid)) return;
			try {
				this.onProcessEnd?.(trackedPid);
			} catch {
				// Lifecycle observers cannot change process execution results.
			}
		};

		try {
			child = spawnShellChild(options.shell, command, { cwd: options.cwd, env: options.env });
			if (child.pid) {
				trackedPid = child.pid;
				this.activePids.add(child.pid);
				try {
					this.onProcessStart?.(child.pid);
				} catch (error) {
					const cause = toError(error);
					callbackError = new ExecutionError("callback_error", cause.message, cause);
					terminate();
				}
			}
		} catch (error) {
			const cause = toError(error);
			releaseProcess();
			return err(new ExecutionError("spawn_error", cause.message, cause));
		}

		const forward = (callback: ((chunk: Uint8Array) => void) | undefined, chunk: Buffer): void => {
			if (callbackError) return;
			try {
				callback?.(chunk);
			} catch (error) {
				const cause = toError(error);
				callbackError = new ExecutionError("callback_error", cause.message, cause);
				terminate();
			}
		};
		const onStdoutData = (chunk: Buffer): void => forward(options.onStdout, chunk);
		const onStderrData = (chunk: Buffer): void => forward(options.onStderr, chunk);
		const observer = observeChildProcess(child);
		const detachFromChild = (): void => {
			observer.detach();
			child.stdout?.removeListener("data", onStdoutData);
			child.stderr?.removeListener("data", onStderrData);
		};

		let promotionDone: (() => void) | undefined;
		const promotion = new Promise<void>((resolve) => {
			promotionDone = resolve;
		});
		if (options.timeoutMs !== undefined) {
			timeoutId = setTimeout(() => {
				timedOut = true;
				if (options.promoteOnTimeout && !observer.settled() && promotedTaskId === undefined) {
					try {
						promotedTaskId = options.promoteOnTimeout.adopt({ pid: trackedPid, child, detach: detachFromChild });
						// Ownership transferred: the executor no longer tracks, aborts, or observes this process.
						if (options.abortSignal) options.abortSignal.removeEventListener("abort", onAbort);
						releaseProcess();
						promotionDone?.();
						return;
					} catch {
						promotedTaskId = undefined;
					}
				}
				terminate();
			}, options.timeoutMs);
		}
		if (options.abortSignal) {
			if (options.abortSignal.aborted) onAbort();
			else options.abortSignal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", onStdoutData);
		child.stderr?.on("data", onStderrData);

		try {
			const result = await Promise.race([observer.promise, promotion]);
			if (promotedTaskId !== undefined) {
				return ok({ exitCode: null, signal: null, promotedTaskId });
			}
			if (result === undefined) return err(new ExecutionError("timeout", `timeout:${options.timeoutMs}`));
			if (callbackError) return err(callbackError);
			if (timedOut) return err(new ExecutionError("timeout", `timeout:${options.timeoutMs}`));
			if (options.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
			return ok(result);
		} catch (error) {
			const cause = toError(error);
			return err(new ExecutionError("spawn_error", cause.message, cause));
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
			if (options.abortSignal) options.abortSignal.removeEventListener("abort", onAbort);
			releaseProcess();
		}
	}

	async cleanup(): Promise<void> {
		for (const pid of [...this.activePids]) {
			killNodeProcessTree(pid);
			if (!this.activePids.delete(pid)) continue;
			try {
				this.onProcessEnd?.(pid);
			} catch {
				// Best-effort cleanup.
			}
		}
	}
}
