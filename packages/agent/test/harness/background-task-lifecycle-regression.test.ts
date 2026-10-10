import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { BackgroundTaskManager } from "../../src/harness/env/background-task-manager.ts";
import { getOrThrow, ok } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("background task lifecycle regressions", () => {
	it("admits only one concurrent start when the cap is one", async () => {
		const cwd = createTempDir();
		const manager = new BackgroundTaskManager({
			shell: async () => ok({ shell: process.execPath, args: ["-e"] }),
			logDir: cwd,
			maxTasks: 1,
		});
		try {
			const results = await Promise.all([
				manager.start("setTimeout(() => {}, 60_000)", { cwd }),
				manager.start("setTimeout(() => {}, 60_000)", { cwd }),
			]);
			expect(results.filter((result) => result.ok)).toHaveLength(1);
			expect(results.filter((result) => !result.ok)).toMatchObject([{ error: { code: "limit_reached" } }]);
			expect(manager.list()).toHaveLength(1);
		} finally {
			await manager.cleanup();
		}
	});

	it("never appends smaller output chunks after truncating the log", async () => {
		const cwd = createTempDir();
		const manager = new BackgroundTaskManager({
			shell: async () => ok({ shell: process.execPath, args: ["-e"] }),
			logDir: cwd,
			maxLogBytes: 16,
		});
		try {
			const task = getOrThrow(
				await manager.start(
					"process.stdout.write('12345678901234567890'); setTimeout(() => process.stdout.write('END'), 200)",
					{ cwd },
				),
			);
			expect(getOrThrow(await manager.wait(task.id, 5_000)).task.logTruncated).toBe(true);
			await manager.shutdown();
			const log = await readFile(task.outputPath, "utf8");
			expect(log).toContain("byte budget");
			expect(log).not.toContain("END");
			expect(getOrThrow(manager.readOutput(task.id)).output).toBe("12345678901234567890END");
		} finally {
			await manager.cleanup();
		}
	});

	it.skipIf(process.platform === "win32").each(["stop", "timeout"] as const)(
		"keeps %s in stopping until a surviving descendant is killed",
		async (mode) => {
			const cwd = createTempDir();
			const graceMs = 500;
			const manager = new BackgroundTaskManager({
				shell: async () => ok({ shell: process.execPath, args: ["-e"] }),
				logDir: cwd,
				stopGraceMs: graceMs,
				defaultTimeoutMs: mode === "timeout" ? 1_000 : 0,
			});
			let childPid: number | undefined;
			try {
				const childCode =
					"process.on('SIGTERM', () => {}); console.log('READY:' + process.pid); setInterval(() => {}, 1000)";
				// The group leader dies on SIGTERM; its child keeps the inherited output pipe open.
				const command = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}]); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.on('exit',()=>process.exit(0));`;
				const task = getOrThrow(await manager.start(command, { cwd }));
				await vi.waitFor(() => {
					const output = getOrThrow(manager.readOutput(task.id)).output;
					expect(output).toContain("READY:");
					childPid = Number(/READY:(\d+)/.exec(output)?.[1]);
				});
				if (mode === "stop") await manager.stop(task.id);
				else await vi.waitFor(() => expect(manager.get(task.id)?.status).toBe("stopping"), { timeout: 2_000 });
				const early = getOrThrow(await manager.wait(task.id, 200));
				expect(early).toMatchObject({ timedOut: true, task: { status: "stopping" } });
				const settled = getOrThrow(await manager.wait(task.id, 3_000));
				expect(settled).toMatchObject({
					timedOut: false,
					task: { status: mode === "stop" ? "stopped" : "timed_out" },
				});
				await vi.waitFor(() => expect(() => process.kill(childPid!, 0)).toThrow(), { timeout: 2_000 });
			} finally {
				if (childPid) {
					try {
						process.kill(childPid, "SIGKILL");
					} catch {
						/* Already reaped. */
					}
				}
				await manager.cleanup();
			}
		},
	);
});
