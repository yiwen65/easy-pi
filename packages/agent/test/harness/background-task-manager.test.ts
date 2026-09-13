import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BackgroundTaskManager, isTerminalTaskStatus } from "../../src/harness/env/background-task-manager.ts";
import {
	type NodeProcessExecutionOptions,
	NodeProcessExecutor,
	type NodeProcessShellConfig,
} from "../../src/harness/env/node-process-executor.ts";
import { getOrThrow, ok } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const SHELL: NodeProcessShellConfig = { shell: process.execPath, args: ["-e"] };

function createManager(options: { stopGraceMs?: number; defaultTimeoutMs?: number } = {}) {
	const logDir = createTempDir();
	const manager = new BackgroundTaskManager({
		shell: async () => ok({ ...SHELL }),
		logDir,
		stopGraceMs: options.stopGraceMs ?? 100,
		defaultTimeoutMs: options.defaultTimeoutMs,
	});
	return { manager, logDir };
}

async function waitTerminal(manager: BackgroundTaskManager, id: string, timeoutMs = 10_000) {
	const result = getOrThrow(await manager.wait(id, timeoutMs));
	expect(result.timedOut).toBe(false);
	return result.task;
}

async function waitForOutput(manager: BackgroundTaskManager, id: string, marker: string, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const output = getOrThrow(manager.readOutput(id));
		if (output.output.includes(marker)) return output;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`marker not seen in task output: ${marker}`);
}

describe("BackgroundTaskManager", () => {
	it("runs a command in the background, streams output to the log, and reports terminal state", async () => {
		const { manager } = createManager();
		const terminals: string[] = [];
		manager.onTerminal((task) => terminals.push(`${task.id}:${task.status}`));

		const task = getOrThrow(
			await manager.start("process.stdout.write('hello'); process.stderr.write('world');", {
				cwd: createTempDir(),
				env: { ...process.env },
			}),
		);
		expect(task.id).toMatch(/^task-/);
		expect(task.status).toBe("running");

		const settled = await waitTerminal(manager, task.id);
		expect(settled.status).toBe("succeeded");
		expect(settled.exitCode).toBe(0);
		expect(terminals).toEqual([`${task.id}:succeeded`]);

		const log = await readFile(settled.outputPath, "utf8");
		expect(log).toContain("hello");
		expect(log).toContain("world");

		const output = getOrThrow(manager.readOutput(task.id));
		expect(output.output).toContain("hello");
		expect(output.outputPath).toBe(settled.outputPath);
		expect(output.truncated).toBe(false);
		await manager.cleanup();
	});

	it("closes stdin immediately so readers get EOF", async () => {
		const { manager } = createManager();
		const task = getOrThrow(
			await manager.start(
				"let data=''; process.stdin.on('data',(c)=>data+=c); process.stdin.on('end',()=>{process.stdout.write('eof:'+JSON.stringify(data));});",
				{ cwd: createTempDir(), env: { ...process.env } },
			),
		);
		const settled = await waitTerminal(manager, task.id);
		expect(settled.status).toBe("succeeded");
		expect(getOrThrow(manager.readOutput(task.id)).output).toContain('eof:""');
		await manager.cleanup();
	});

	it("bounds the tail preview while the log retains everything", async () => {
		const { manager } = createManager();
		const task = getOrThrow(
			await manager.start("process.stdout.write('x'.repeat(100_000)); process.stdout.write('TAIL-MARKER');", {
				cwd: createTempDir(),
				env: { ...process.env },
			}),
		);
		const settled = await waitTerminal(manager, task.id);
		expect(settled.status).toBe("succeeded");

		const preview = getOrThrow(manager.readOutput(task.id, 1024));
		expect(Buffer.byteLength(preview.output)).toBeLessThanOrEqual(1024);
		expect(preview.output).toContain("TAIL-MARKER");
		expect(preview.truncated).toBe(true);
		expect(preview.totalBytes).toBeGreaterThan(100_000);

		const log = await readFile(settled.outputPath, "utf8");
		expect(log.length).toBeGreaterThan(100_000);
		await manager.cleanup();
	});

	it.skipIf(process.platform === "win32")(
		"stops a task two-phase: SIGTERM then SIGKILL after the grace period",
		async () => {
			const { manager } = createManager({ stopGraceMs: 100 });
			const task = getOrThrow(
				await manager.start(
					"process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setTimeout(() => {}, 60_000);",
					{
						cwd: createTempDir(),
						env: { ...process.env },
					},
				),
			);
			// wait until the SIGTERM handler is installed so the first phase cannot kill the process
			await waitForOutput(manager, task.id, "ready");

			const stopped = getOrThrow(await manager.stop(task.id));
			expect(stopped.status).toBe("stopping");

			const settled = await waitTerminal(manager, task.id);
			expect(settled.status).toBe("stopped");
			expect(settled.signal).toBe("SIGKILL");

			// stop is safe on terminal tasks
			const again = getOrThrow(await manager.stop(task.id));
			expect(again.status).toBe("stopped");
			await manager.cleanup();
		},
	);

	it("bounds background runtime with the default timeout and reports timed_out", async () => {
		const { manager } = createManager({ defaultTimeoutMs: 100, stopGraceMs: 50 });
		const task = getOrThrow(
			await manager.start("setTimeout(() => {}, 60_000);", { cwd: createTempDir(), env: { ...process.env } }),
		);
		const settled = await waitTerminal(manager, task.id);
		expect(settled.status).toBe("timed_out");
		const report = await manager.shutdown();
		expect(report.timedOut).toContain(task.id);
		await manager.cleanup();
	});

	it("wait returns a snapshot on timeout without cancelling the task", async () => {
		const { manager } = createManager();
		const task = getOrThrow(
			await manager.start("setTimeout(() => { process.stdout.write('late'); }, 300);", {
				cwd: createTempDir(),
				env: { ...process.env },
			}),
		);
		const early = getOrThrow(await manager.wait(task.id, 30));
		expect(early.timedOut).toBe(true);
		expect(early.task.status).toBe("running");

		const settled = await waitTerminal(manager, task.id);
		expect(settled.status).toBe("succeeded");
		expect(getOrThrow(manager.readOutput(task.id)).output).toContain("late");
		await manager.cleanup();
	});

	it("lists active tasks by default and all tasks on request", async () => {
		const { manager } = createManager();
		const quick = getOrThrow(
			await manager.start("process.stdout.write('q');", { cwd: createTempDir(), env: { ...process.env } }),
		);
		const slow = getOrThrow(
			await manager.start("setTimeout(() => {}, 5_000);", { cwd: createTempDir(), env: { ...process.env } }),
		);
		await waitTerminal(manager, quick.id);

		const active = manager.list();
		expect(active.map((t) => t.id)).toEqual([slow.id]);
		const all = manager.list({ activeOnly: false });
		expect(all.map((t) => t.id).sort()).toEqual([quick.id, slow.id].sort());

		await manager.stop(slow.id);
		await waitTerminal(manager, slow.id);
		await manager.cleanup();
	});

	it("shutdown waits for process and writer settlement and reports ownership", async () => {
		const { manager } = createManager({ stopGraceMs: 50 });
		const task = getOrThrow(
			await manager.start("setTimeout(() => {}, 60_000);", { cwd: createTempDir(), env: { ...process.env } }),
		);

		const report = await manager.shutdown({ timeoutMs: 2_000 });
		expect(report.complete).toBe(true);
		expect(report.remaining).toEqual([]);
		expect([...report.completed, ...report.failed]).toContain(task.id);
		await manager.cleanup();
	});

	it("rejects new tasks after shutdown starts", async () => {
		const { manager } = createManager();
		const report = await manager.shutdown({ timeoutMs: 100 });
		expect(report.complete).toBe(true);

		const started = await manager.start("process.stdout.write('x');", {
			cwd: createTempDir(),
			env: { ...process.env },
		});
		expect(started).toMatchObject({ ok: false, error: { code: "aborted" } });
	});

	it("rejects start for a nonexistent cwd and unknown task lookups", async () => {
		const { manager } = createManager();
		const started = await manager.start("process.stdout.write('x');", {
			cwd: "/definitely/missing/path",
			env: { ...process.env },
		});
		expect(started).toMatchObject({ ok: false, error: { code: "spawn_error" } });
		expect(manager.get("task-999")).toBeUndefined();
		expect((await manager.stop("task-999")).ok).toBe(false);
		expect((await manager.wait("task-999", 1)).ok).toBe(false);
		expect(manager.readOutput("task-999").ok).toBe(false);
		await manager.cleanup();
	});
});

describe("NodeProcessExecutor promotion", () => {
	function nodeExecutionOptions(
		cwd: string,
		overrides: Partial<NodeProcessExecutionOptions> = {},
	): NodeProcessExecutionOptions {
		return {
			shell: { ...SHELL },
			cwd,
			env: { ...process.env },
			...overrides,
		};
	}

	it.skipIf(process.platform === "win32")(
		"promotes a timed-out process to a background task instead of killing it",
		async () => {
			const { manager } = createManager({ stopGraceMs: 100 });
			const startedPids: number[] = [];
			const endedPids: number[] = [];
			const executor = new NodeProcessExecutor({
				onProcessStart: (pid) => startedPids.push(pid),
				onProcessEnd: (pid) => endedPids.push(pid),
			});
			const command =
				"let i=0; const t=setInterval(()=>{process.stdout.write('tick'+i+'\\n'); if(++i>=6){clearInterval(t);process.exit(0);}},100);";
			const cwd = createTempDir();

			const result = getOrThrow(
				await executor.execute(
					command,
					nodeExecutionOptions(cwd, {
						timeoutMs: 150,
						promoteOnTimeout: { adopt: (handle) => manager.adopt(handle, { command, cwd }) },
					}),
				),
			);
			expect(result.promotedTaskId).toBeDefined();
			expect(result.exitCode).toBeNull();
			// lifecycle notifications stay balanced across the handoff
			expect(endedPids).toEqual(startedPids);

			const settled = await waitTerminal(manager, result.promotedTaskId!);
			expect(settled.status).toBe("succeeded");
			expect(settled.promoted).toBe(true);

			// the process kept running after promotion and its later output reached the task log
			const log = await readFile(settled.outputPath, "utf8");
			expect(log).toContain("tick5");
			await manager.cleanup();
		},
	);

	it("falls back to termination when promotion adopts nothing", async () => {
		const executor = new NodeProcessExecutor();
		const result = await executor.execute(
			"setTimeout(() => {}, 60_000);",
			nodeExecutionOptions(createTempDir(), {
				timeoutMs: 20,
				promoteOnTimeout: {
					adopt: () => {
						throw new Error("no manager");
					},
				},
			}),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
	});

	it("keeps plain timeout behavior when promotion is not configured", async () => {
		const executor = new NodeProcessExecutor();
		const result = await executor.execute(
			"setTimeout(() => {}, 60_000);",
			nodeExecutionOptions(createTempDir(), { timeoutMs: 20 }),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
	});
});

describe("isTerminalTaskStatus", () => {
	it("classifies statuses", () => {
		expect(isTerminalTaskStatus("running")).toBe(false);
		expect(isTerminalTaskStatus("stopping")).toBe(false);
		expect(isTerminalTaskStatus("succeeded")).toBe(true);
		expect(isTerminalTaskStatus("failed")).toBe(true);
		expect(isTerminalTaskStatus("timed_out")).toBe(true);
		expect(isTerminalTaskStatus("stopped")).toBe(true);
	});
});
