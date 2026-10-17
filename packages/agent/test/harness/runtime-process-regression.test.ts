import type * as childProcesses from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskManager } from "../../src/harness/env/background-task-manager.ts";
import { NodeProcessExecutor } from "../../src/harness/env/node-process-executor.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { getOrThrow, ok } from "../../src/harness/types.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcesses>()),
	spawn: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof fs>()),
	createWriteStream: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof fsp>();
	return { ...original, stat: vi.fn(original.stat) };
});

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class ControlledWriter extends EventEmitter {
	closed = false;
	chunks: Buffer[] = [];
	end = vi.fn();
	write(chunk: Buffer | string) {
		this.chunks.push(Buffer.from(chunk));
		return true;
	}
	destroy() {
		this.close();
		return this;
	}
	close() {
		if (!this.closed) {
			this.closed = true;
			this.emit("close");
		}
	}
}

function childProcess() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: null,
		// No real process exists: kill is intercepted below and no OS pid is used.
		pid: 12345,
	}) as unknown as ChildProcess;
}

let child: ChildProcess;
let writers: ControlledWriter[];
let managers: BackgroundTaskManager[];
beforeEach(() => {
	vi.useFakeTimers();
	child = childProcess();
	writers = [];
	managers = [];
	vi.mocked(spawn).mockImplementation(() => child as ReturnType<typeof spawn>);
	vi.mocked(fs.createWriteStream).mockImplementation(() => {
		const writer = new ControlledWriter();
		writers.push(writer);
		return writer as unknown as fs.WriteStream;
	});
	vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(async () => {
	child.emit("close", 0, null);
	await vi.runAllTimersAsync();
	for (const writer of writers) writer.close();
	for (const manager of managers) await manager.shutdown();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.useRealTimers();
});

function manager(options: Partial<ConstructorParameters<typeof BackgroundTaskManager>[0]> = {}) {
	const value = new BackgroundTaskManager({
		shell: async () => ok({ shell: "faux-shell", args: [] }),
		stallTimeoutMs: 0,
		...options,
	});
	managers.push(value);
	return value;
}

describe("background launch admission (F01)", () => {
	it.each(["stat", "shell"] as const)("does not spawn after cancellation during %s", async (stage) => {
		const entered = deferred();
		const release = deferred();
		const controller = new AbortController();
		const tasks = manager({
			shell: async () => {
				if (stage === "shell") {
					entered.resolve();
					await release.promise;
				}
				return ok({ shell: "faux-shell", args: [] });
			},
		});
		if (stage === "stat") {
			const info = await fsp.stat(process.cwd());
			vi.mocked(fsp.stat).mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				return info;
			});
		}
		const result = tasks.start("faux", { cwd: process.cwd(), signal: controller.signal });
		await entered.promise;
		controller.abort();
		release.resolve();
		const started = await result;
		expect(started).toMatchObject({ ok: false, error: { code: "aborted", executionOutcome: "not_started" } });
		expect(spawn).not.toHaveBeenCalled();
		expect(tasks.list({ activeOnly: false })).toHaveLength(0);
		expect(writers).toHaveLength(0);
	});

	it.each(["prepare", "cwd", "shell"] as const)(
		"does not launch from Bash after cancellation during %s",
		async (stage) => {
			const entered = deferred();
			const release = deferred();
			const tasks = manager({
				shell: async () => {
					if (stage === "shell") {
						entered.resolve();
						await release.promise;
					}
					return ok({ shell: "faux-shell", args: [] });
				},
			});
			const start = vi.spyOn(tasks, "start");
			const env = new NodeExecutionEnv({ cwd: process.cwd(), backgroundTasks: tasks });
			if (stage === "cwd") {
				const info = await env.fileInfo(process.cwd());
				vi.spyOn(env, "fileInfo").mockImplementationOnce(async () => {
					entered.resolve();
					await release.promise;
					return info;
				});
			}
			const controller = new AbortController();
			const tool = createBashTool({
				prepare: async () => {
					if (stage === "prepare") {
						entered.resolve();
						await release.promise;
					}
				},
			});
			const execution = tool.execute(
				"id",
				{ command: "faux", run_in_background: true },
				controller.signal,
				undefined,
				{
					env,
				},
			);
			const outcome = execution.catch((error: unknown) => error);
			await entered.promise;
			controller.abort();
			release.resolve();
			expect(await outcome).toMatchObject({ code: "ABORTED", executionOutcome: "not_started" });
			expect(start).toHaveBeenCalledTimes(stage === "shell" ? 1 : 0);
			expect(spawn).not.toHaveBeenCalled();
			expect(tasks.list({ activeOnly: false })).toHaveLength(0);
		},
	);

	it("does not connect admitted background task lifetime to the request signal", async () => {
		const tasks = manager();
		const controller = new AbortController();
		const task = getOrThrow(await tasks.start("faux", { cwd: process.cwd(), signal: controller.signal }));
		controller.abort();
		expect(tasks.get(task.id)?.status).toBe("running");
		expect(process.kill).not.toHaveBeenCalled();
	});
});

describe("background writer settlement (F15/F16)", () => {
	it("retains terminal tasks and writer leases until close, then allows shutdown retry and cleanup", async () => {
		const release = vi.fn();
		const tasks = manager({ createLogFile: () => ({ path: "/faux/log", fd: 123, release }) });
		const task = getOrThrow(await tasks.start("faux", { cwd: process.cwd() }));
		child.emit("close", 0, null);
		await Promise.resolve();
		expect(tasks.get(task.id)?.status).toBe("succeeded");
		const shutdown = tasks.shutdown({ timeoutMs: 10 });
		await vi.advanceTimersByTimeAsync(10);
		expect(await shutdown).toEqual({
			complete: false,
			completed: [],
			failed: [],
			timedOut: [task.id],
			remaining: [task.id],
		});
		expect(release).toHaveBeenCalledTimes(0);
		const cleanup = tasks.cleanup();
		await vi.advanceTimersByTimeAsync(5000);
		await cleanup;
		expect(tasks.list({ activeOnly: false })).toHaveLength(1);
		writers[0].close();
		expect(release).toHaveBeenCalledTimes(1);
		expect(await tasks.shutdown()).toEqual({
			complete: true,
			completed: [task.id],
			failed: [],
			timedOut: [],
			remaining: [],
		});
		await tasks.cleanup();
		expect(tasks.list({ activeOnly: false })).toHaveLength(0);
		child = childProcess();
		expect((await tasks.start("reused", { cwd: process.cwd() })).ok).toBe(true);
	});

	it("refreshes an incomplete report after a live process eventually settles", async () => {
		const tasks = manager({ stopGraceMs: 50 });
		const task = getOrThrow(await tasks.start("faux", { cwd: process.cwd() }));
		const shutdown = tasks.shutdown({ timeoutMs: 10 });
		await vi.advanceTimersByTimeAsync(10);
		expect(await shutdown).toMatchObject({ complete: false, remaining: [task.id] });
		await vi.advanceTimersByTimeAsync(50);
		child.emit("close", null, "SIGKILL");
		await Promise.resolve();
		writers[0].close();
		expect(await tasks.shutdown()).toMatchObject({ complete: true, remaining: [] });
	});
});

describe("background UTF-8 output (F17)", () => {
	it("preserves leading BOM characters from both output channels", async () => {
		const tasks = manager();
		const task = getOrThrow(await tasks.start("faux", { cwd: process.cwd() }));
		const bytes = Buffer.from("\uFEFFtext");
		child.stdout?.emit("data", bytes.subarray(0, 1));
		child.stdout?.emit("data", bytes.subarray(1));
		child.stderr?.emit("data", bytes);
		expect(getOrThrow(tasks.readOutput(task.id))).toMatchObject({
			output: "\uFEFFtext\uFEFFtext",
			totalBytes: bytes.length * 2,
		});
	});

	it("decodes independent interleaved pipes and flushes incomplete characters at settlement", async () => {
		const tasks = manager();
		const task = getOrThrow(await tasks.start("faux", { cwd: process.cwd() }));
		const out = Buffer.from("中");
		const err = Buffer.from("😀");
		child.stdout?.emit("data", out.subarray(0, 1));
		child.stderr?.emit("data", err.subarray(0, 2));
		child.stdout?.emit("data", out.subarray(1));
		child.stderr?.emit("data", err.subarray(2));
		expect(getOrThrow(tasks.readOutput(task.id))).toMatchObject({ output: "中😀", totalBytes: 7, truncated: false });
		expect(Buffer.concat(writers[0].chunks)).toEqual(
			Buffer.concat([out.subarray(0, 1), err.subarray(0, 2), out.subarray(1), err.subarray(2)]),
		);
		child.stdout?.emit("data", Buffer.from([0xe4]));
		child.emit("close", 0, null);
		await Promise.resolve();
		expect(getOrThrow(tasks.readOutput(task.id))).toMatchObject({ output: "中😀�", totalBytes: 8 });
	});
});

describe("foreground promotion admission (F18)", () => {
	it.each(["abort", "output-callback", "start-callback"] as const)(
		"never promotes after %s while exit is pending",
		async (failure) => {
			const controller = new AbortController();
			const adopt = vi.fn(() => "background-id");
			const ended = vi.fn();
			const executor = new NodeProcessExecutor({
				onProcessStart: () => {
					if (failure === "start-callback") throw new Error("failed start observer");
				},
				onProcessEnd: ended,
			});
			const result = executor.execute("faux", {
				shell: { shell: "faux-shell", args: [] },
				cwd: process.cwd(),
				env: {},
				timeoutMs: 10,
				abortSignal: controller.signal,
				promoteOnTimeout: { adopt },
				onStdout: () => {
					if (failure === "output-callback") throw new Error("failed output observer");
				},
			});
			if (failure === "abort") controller.abort();
			if (failure === "output-callback") child.stdout?.emit("data", Buffer.from("output"));
			await vi.advanceTimersByTimeAsync(10);
			const prematureAdoptions = adopt.mock.calls.length;
			child.emit("close", null, "SIGKILL");
			expect(await result).toMatchObject({
				ok: false,
				error: { code: failure === "abort" ? "aborted" : "callback_error" },
			});
			expect(prematureAdoptions).toBe(0);
			expect(ended).toHaveBeenCalledTimes(1);
		},
	);

	it("preserves a numeric exit acknowledged after cancellation", async () => {
		const controller = new AbortController();
		const adopt = vi.fn(() => "background-id");
		const result = new NodeProcessExecutor().execute("faux", {
			shell: { shell: "faux-shell", args: [] },
			cwd: process.cwd(),
			env: {},
			timeoutMs: 10,
			abortSignal: controller.signal,
			promoteOnTimeout: { adopt },
		});
		controller.abort();
		await vi.advanceTimersByTimeAsync(10);
		child.emit("close", 0, null);
		expect(await result).toEqual(ok({ exitCode: 0, signal: null }));
		expect(adopt).not.toHaveBeenCalled();
	});

	it("keeps a successfully adopted process independent from later abort", async () => {
		const controller = new AbortController();
		const executor = new NodeProcessExecutor();
		const tasks = manager();
		const result = executor.execute("faux", {
			shell: { shell: "faux-shell", args: [] },
			cwd: process.cwd(),
			env: {},
			timeoutMs: 10,
			abortSignal: controller.signal,
			promoteOnTimeout: { adopt: (handle) => tasks.adopt(handle, { command: "faux", cwd: process.cwd() }) },
		});
		await vi.advanceTimersByTimeAsync(10);
		const id = getOrThrow(await result).promotedTaskId!;
		controller.abort();
		expect(tasks.get(id)?.status).toBe("running");
		expect(process.kill).not.toHaveBeenCalled();
	});
});
