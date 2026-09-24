import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { ComputerHost } from "../../src/core/computer/host.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	takeOverStdout() {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout() {},
}));
vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: () => () => {},
	serializeJsonLine: JSON.stringify,
}));
vi.mock("../../src/utils/shell.ts", () => ({ killTrackedDetachedChildren() {} }));

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class Exited extends Error {}
const failures: unknown[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	expect(failures.splice(0)).toEqual([]);
});

function signals() {
	const handlers = new Map<string, () => void>();
	vi.spyOn(process, "prependListener").mockImplementation(((name: string, listener: () => void) => {
		handlers.set(name, listener);
		return process;
	}) as typeof process.prependListener);
	vi.spyOn(process, "on").mockImplementation(((name: string, listener: () => void) => {
		handlers.set(name, listener);
		return process;
	}) as typeof process.on);
	vi.spyOn(process, "off").mockImplementation(((name: string) => {
		handlers.delete(name);
		return process;
	}) as typeof process.off);
	return handlers;
}

describe("Computer process-signal drain", () => {
	it.each(process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"])(
		"interactive %s waits for native terminal and closes once",
		async (signal) => {
			const handlers = signals();
			const exit = vi.spyOn(process, "exit").mockImplementation(() => {
				throw new Exited();
			});
			const terminal = barrier();
			const entered = barrier();
			const close = vi.fn(async () => {});
			const cancel = vi.fn();
			const host = new ComputerHost({
				desktopId: "signals",
				createRuntime: () => ({
					openSession: () => ({ revoke() {}, close: async () => {} }),
					close,
				}),
			});
			const pending = host.openSession().run(() => {
				entered.resolve();
				return { result: Promise.resolve("dispatched"), terminal: terminal.promise, cancel };
			});
			await entered.promise;
			const proto = InteractiveMode.prototype as unknown as {
				registerSignalHandlers(this: object): void;
				unregisterSignalHandlers(this: object): void;
				shutdown(this: object, options?: { fromSignal?: boolean }): Promise<void>;
			};
			const context = {
				isShuttingDown: false,
				isSuspended: false,
				signalCleanupHandlers: [] as Array<() => void>,
				runtimeHost: { dispose: () => host.close() },
				ui: { terminal: { drainInput: async () => {} } },
				themeController: { disableAutoSync() {} },
				stop() {},
				unregisterSignalHandlers() {
					proto.unregisterSignalHandlers.call(this);
				},
				shutdown(options?: { fromSignal?: boolean }) {
					return proto.shutdown.call(this, options).catch((error) => {
						if (!(error instanceof Exited)) failures.push(error);
					});
				},
			};
			proto.registerSignalHandlers.call(context);
			cleanups.push(() => context.unregisterSignalHandlers());
			try {
				expect(handlers.has(signal)).toBe(true);
				if (signal === "SIGINT") {
					context.isSuspended = true;
					handlers.get(signal)!();
					expect(context.isShuttingDown).toBe(false);
					expect(cancel).not.toHaveBeenCalled();
					context.isSuspended = false;
				}
				handlers.get(signal)!();
				handlers.get(signal)!();
				await Promise.resolve();
				expect(cancel).toHaveBeenCalledTimes(1);
				expect(exit).not.toHaveBeenCalled();
				expect(close).not.toHaveBeenCalled();
				expect(handlers.has(signal)).toBe(true);
			} finally {
				terminal.resolve();
			}
			await pending;
			await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
			expect(close).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["print", "rpc"])(
		"%s retains SIGINT/SIGTERM handlers and never exits on a second signal before drain",
		async (mode) => {
			const handlers = signals();
			const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
			const drain = barrier();
			const prompt = barrier();
			const dispose = vi.fn(() => {
				prompt.resolve();
				return drain.promise;
			});
			const runtime = {
				dispose,
				setRebindSession() {},
				session: {
					bindExtensions: async () => {},
					subscribe: () => () => {},
					agent: { subscribe: () => () => {} },
					prompt: () => prompt.promise,
					state: { messages: [] },
				},
			} as unknown as AgentSessionRuntime;
			const originalEnd = process.stdin.listeners("end");
			cleanups.push(() => {
				for (const listener of process.stdin.listeners("end") as Array<() => void>)
					if (!originalEnd.includes(listener)) process.stdin.removeListener("end", listener);
			});
			const running =
				mode === "print" ? runPrintMode(runtime, { mode: "text", initialMessage: "test" }) : runRpcMode(runtime);
			try {
				await vi.waitFor(() => expect(handlers.has("SIGTERM")).toBe(true));
				expect(handlers.has("SIGINT")).toBe(true);
				handlers.get("SIGINT")!();
				await Promise.resolve();
				await Promise.resolve();
				expect(handlers.has("SIGTERM")).toBe(true);
				handlers.get("SIGTERM")!();
				await Promise.resolve();
				expect(exit).not.toHaveBeenCalled();
			} finally {
				drain.resolve();
				prompt.resolve();
			}
			await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
			if (mode === "print") await running;
			await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
			expect(exit).toHaveBeenCalledWith(130);
		},
	);
});
