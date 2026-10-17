import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskManager } from "../../src/harness/env/background-task-manager.ts";
import { NodeProcessExecutor } from "../../src/harness/env/node-process-executor.ts";
import { ok } from "../../src/harness/types.ts";

const fault = vi.hoisted(() => ({ stream: false }));
vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return {
		...original,
		createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
			if (fault.stream) throw new Error("synthetic stream construction failure");
			return original.createWriteStream(...args);
		},
	};
});

let directory: string;
beforeEach(() => {
	directory = fs.mkdtempSync(join(tmpdir(), "pi-bg-log-admission-"));
});
afterEach(() => {
	fault.stream = false;
	vi.restoreAllMocks();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe("background managed-log admission failures", () => {
	it("closes the host fd and releases its lease when stream construction throws synchronously", async () => {
		const path = join(directory, "managed.log");
		const fd = fs.openSync(path, "wx");
		const release = vi.fn();
		const manager = new BackgroundTaskManager({
			shell: async () => ok({ shell: process.execPath, args: ["-e"] }),
			createLogFile: () => ({ path, fd, release }),
			stallTimeoutMs: 0,
		});
		fault.stream = true;
		const result = await manager.start("throw new Error('must not spawn')", { cwd: directory });
		expect(result).toMatchObject({ ok: false, error: { executionOutcome: "not_started" } });
		expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
		expect(release).toHaveBeenCalledOnce();
		expect(manager.list({ activeOnly: false })).toEqual([]);
		await manager.shutdown();
	});

	it.each(["factory", "stream"])(
		"retains foreground ownership and terminates an already running process on %s failure during promotion",
		async (failure) => {
			let fd: number | undefined;
			const release = vi.fn();
			const manager = new BackgroundTaskManager({
				shell: async () => ok({ shell: process.execPath, args: ["-e"] }),
				createLogFile: () => {
					if (failure === "factory") throw new Error("synthetic log admission failure");
					const path = join(directory, "promoted.log");
					fd = fs.openSync(path, "wx");
					return { path, fd, release };
				},
				stallTimeoutMs: 0,
			});
			fault.stream = failure === "stream";
			const started: number[] = [];
			const ended: number[] = [];
			const executor = new NodeProcessExecutor({
				onProcessStart: (pid) => started.push(pid),
				onProcessEnd: (pid) => ended.push(pid),
			});
			const detach = vi.fn();
			let output = "";
			try {
				const result = await executor.execute("process.stdout.write('running');setInterval(() => {}, 1000);", {
					shell: { shell: process.execPath, args: ["-e"] },
					cwd: directory,
					env: process.env,
					timeoutMs: 300,
					onStdout: (chunk) => {
						output += Buffer.from(chunk).toString();
					},
					promoteOnTimeout: {
						adopt: (handle) =>
							manager.adopt(
								{
									...handle,
									detach: () => {
										detach();
										handle.detach();
									},
								},
								{ command: "already running", cwd: directory },
							),
					},
				});
				expect(output).toBe("running");
				expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
				if (!result.ok) expect(result.error.executionOutcome).not.toBe("not_started");
				expect(detach).not.toHaveBeenCalled();
				expect(started).toHaveLength(1);
				expect(ended).toEqual(started);
				await vi.waitFor(() => expect(() => process.kill(started[0], 0)).toThrow());
				expect(manager.list({ activeOnly: false })).toEqual([]);
				if (fd !== undefined) {
					expect(() => fs.fstatSync(fd!)).toThrow(/EBADF/);
					expect(release).toHaveBeenCalledOnce();
				}
			} finally {
				await executor.cleanup();
				await manager.shutdown();
			}
		},
	);
});
