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
}

export interface NodeProcessExecutionResult {
	exitCode: number | null;
	signal: string | null;
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
 * Wait for the shell while retaining output from descendants until inherited pipes
 * either close or remain idle for a short grace period.
 */
function waitForChildProcess(child: ChildProcess): Promise<ChildExit> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let signal: string | null = null;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

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
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({ exitCode: code, signal: exitSignal });
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
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
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
	});
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
			const commandFromStdin = options.shell.commandTransport === "stdin";
			child = spawn(options.shell.shell, commandFromStdin ? options.shell.args : [...options.shell.args, command], {
				cwd: options.cwd,
				detached: process.platform !== "win32",
				env: options.env,
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
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
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
		} catch (error) {
			const cause = toError(error);
			releaseProcess();
			return err(new ExecutionError("spawn_error", cause.message, cause));
		}

		if (options.timeoutMs !== undefined) {
			timeoutId = setTimeout(() => {
				timedOut = true;
				terminate();
			}, options.timeoutMs);
		}
		if (options.abortSignal) {
			if (options.abortSignal.aborted) onAbort();
			else options.abortSignal.addEventListener("abort", onAbort, { once: true });
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
		child.stdout?.on("data", (chunk: Buffer) => forward(options.onStdout, chunk));
		child.stderr?.on("data", (chunk: Buffer) => forward(options.onStderr, chunk));

		try {
			const result = await waitForChildProcess(child);
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
