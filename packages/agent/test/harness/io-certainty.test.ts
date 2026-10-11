import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTaskManagerLike } from "../../src/harness/env/background-task-types.ts";
import { NodeProcessExecutor } from "../../src/harness/env/node-process-executor.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import { ExecutionError, err, getOrThrow, ok, type Result, type ShellExecResult } from "../../src/harness/types.ts";
import { executeShellWithCapture } from "../../src/harness/utils/shell-output.ts";
import { truncateTail } from "../../src/harness/utils/truncate.ts";
import { getToolErrorOutcome } from "../../src/tool-outcome.ts";
import { createTempDir } from "./session-test-utils.ts";

const environments: NodeExecutionEnv[] = [];
function environment() {
	const env = new NodeExecutionEnv({ cwd: createTempDir(), backgroundTaskStallTimeoutMs: 0 });
	environments.push(env);
	return env;
}
afterEach(async () => {
	vi.restoreAllMocks();
	for (const env of environments.splice(0)) await env.cleanup();
});
async function failure(execution: Promise<unknown>) {
	try {
		await execution;
	} catch (error) {
		return error;
	}
	throw new Error("Expected failure");
}

describe("native I/O certainty", () => {
	it("carries local prelaunch certainty through capture while the executor remains unused", async () => {
		const env = environment();
		const executor = vi.spyOn(NodeProcessExecutor.prototype, "execute");
		const result = getOrThrow(
			await executeShellWithCapture(env, "pwd", {
				cwd: join(env.cwd, "missing"),
				returnExecutionErrors: true,
			}),
		);
		expect(executor).not.toHaveBeenCalled();
		expect(result.executionError).toMatchObject({ executionOutcome: "not_started" });
	});

	it("keeps explicit adapter cancellation authoritative even alongside a numeric exit", async () => {
		const env = environment();
		const args = { command: "opaque effect" };
		const tool = createBashTool({
			capture: async () =>
				ok({
					output: "partial",
					truncation: truncateTail("partial"),
					lastLineBytes: 7,
					exitCode: 0,
					cancelled: true,
					truncated: false,
				}),
		});
		const error = await failure(tool.execute("cancelled-capture", args, undefined, undefined, { env }));
		expect(error).toMatchObject({ code: "ABORTED", details: { exitCode: null, terminationReason: "aborted" } });
		expect(getToolErrorOutcome(error, "bash", args)).toBe("unknown");
	});

	it("rejects a regular-file native foreground cwd before calling the executor", async () => {
		const dir = createTempDir();
		const path = join(dir, "file.txt");
		await writeFile(path, "unchanged");
		const processStart = vi.fn();
		const env = new NodeExecutionEnv({ cwd: dir, onProcessStart: processStart });
		environments.push(env);
		const executor = vi.spyOn(NodeProcessExecutor.prototype, "execute");
		const result = await env.exec("printf must-not-run", { cwd: path });
		expect(processStart).not.toHaveBeenCalled();
		expect(result).toMatchObject({ ok: false, error: { executionOutcome: "not_started" } });
		expect(executor).not.toHaveBeenCalled();
		expect(await readFile(path, "utf8")).toBe("unchanged");
	});

	it("rejects a regular-file native background cwd before admission or task creation", async () => {
		const dir = createTempDir();
		const path = join(dir, "file.txt");
		await writeFile(path, "unchanged");
		const env = new NodeExecutionEnv({ cwd: dir, backgroundTaskLogDir: dir, backgroundTaskStallTimeoutMs: 0 });
		environments.push(env);
		const started = vi.fn();
		env.backgroundTasks.onStart(started);
		const result = await env.backgroundTasks.start("printf must-not-run", { cwd: path });
		if (result.ok) await env.backgroundTasks.wait(result.value.id, 1000);
		expect(result).toMatchObject({ ok: false, error: { executionOutcome: "not_started" } });
		expect(started).not.toHaveBeenCalled();
		expect(env.backgroundTasks.list({ activeOnly: false })).toEqual([]);
	});

	it.each(["foreground", "background"] as const)(
		"accepts a directory symlink at native %s prelaunch",
		async (mode) => {
			const dir = createTempDir();
			const target = join(dir, "directory");
			const alias = join(dir, "alias");
			await mkdir(target);
			await symlink(target, alias);
			const env = new NodeExecutionEnv({ cwd: dir, backgroundTaskLogDir: dir, backgroundTaskStallTimeoutMs: 0 });
			environments.push(env);
			if (mode === "foreground") {
				const result = getOrThrow(await env.exec("printf acknowledged", { cwd: alias }));
				expect(result).toMatchObject({ exitCode: 0, stdout: "acknowledged" });
			} else {
				const started = getOrThrow(await env.backgroundTasks.start("printf acknowledged", { cwd: alias }));
				const result = getOrThrow(await env.backgroundTasks.wait(started.id, 1000));
				expect(result).toMatchObject({ timedOut: false, task: { status: "succeeded", exitCode: 0 } });
			}
		},
	);

	it("preserves an acknowledged numeric exit when the lifecycle end observer cancels", async () => {
		const controller = new AbortController();
		const env = new NodeExecutionEnv({ cwd: createTempDir(), onProcessEnd: () => controller.abort() });
		environments.push(env);
		const capture = getOrThrow(
			await executeShellWithCapture(env, "printf acknowledged", { abortSignal: controller.signal }),
		);
		expect(controller.signal.aborted).toBe(true);
		expect(capture.exitCode).toBe(0);
		expect(capture.cancelled).toBe(false);
	});

	it("preserves a normal nonzero exit acknowledgement despite late cancellation", async () => {
		const controller = new AbortController();
		const env = new NodeExecutionEnv({ cwd: createTempDir(), onProcessEnd: () => controller.abort() });
		environments.push(env);
		const args = { command: "printf rejected; exit 4" };
		const error = await failure(createBashTool().execute("io", args, controller.signal, undefined, { env }));
		expect(error).toMatchObject({ details: { exitCode: 4, signal: null, terminationReason: "exit" } });
		expect(getToolErrorOutcome(error, "bash", args)).toBe("confirmed");
	});

	it("retains prelaunch proof when capture also observes cancellation", async () => {
		const env = environment();
		const controller = new AbortController();
		controller.abort();
		const capture = getOrThrow(await executeShellWithCapture(env, "effect", { abortSignal: controller.signal }));
		expect(capture.cancelled).toBe(true);
		expect(capture.executionError).toMatchObject({ executionOutcome: "not_started" });
	});

	it("keeps a failed opaque execution unknown even with spawn_error code and preflight wording", async () => {
		const env = environment();
		vi.spyOn(env, "exec").mockResolvedValue(
			err(new ExecutionError("spawn_error", "Working directory does not exist after lost acknowledgement")),
		);
		const args = { command: "effect" };
		const error = await failure(createBashTool().execute("opaque", args, undefined, undefined, { env }));
		expect(getToolErrorOutcome(error, "bash", args)).toBe("unknown");
	});

	it("does not assume a custom background !ok response proves no launch", async () => {
		const env = environment();
		const manager: BackgroundTaskManagerLike = {
			start: vi.fn<BackgroundTaskManagerLike["start"]>(async () =>
				err(new ExecutionError("spawn_error", "Lost launch acknowledgement after remote start")),
			),
			get: () => undefined,
			list: () => [],
			stop: async () => err(new ExecutionError("unknown", "unused")),
			wait: async () => err(new ExecutionError("unknown", "unused")),
			readOutput: () => err(new ExecutionError("unknown", "unused")),
			onStart: () => () => {},
			onTerminal: () => () => {},
			cleanup: async () => {},
		};
		Object.defineProperty(env, "backgroundTasks", { value: manager });
		const args = { command: "effect", run_in_background: true };
		const error = await failure(createBashTool().execute("opaque", args, undefined, undefined, { env }));
		expect(manager.start).toHaveBeenCalledOnce();
		expect(getToolErrorOutcome(error, "bash", args)).toBe("unknown");
	});

	it("preserves native background prelaunch evidence", async () => {
		const env = environment();
		const result = await env.backgroundTasks.start("effect", { cwd: join(env.cwd, "missing") });
		expect(result).toMatchObject({ ok: false, error: { executionOutcome: "not_started" } });
		expect(env.backgroundTasks.list({ activeOnly: false })).toEqual([]);
	});

	it.each(["write", "edit"] as const)(
		"returns the acknowledged %s facts after cancellation at the target ack boundary",
		async (name) => {
			const env = environment();
			const controller = new AbortController();
			await writeFile(join(env.cwd, "target.txt"), "before");
			const nativeWrite = env.writeFile.bind(env);
			vi.spyOn(env, "writeFile").mockImplementation(async (...args) => {
				const result = await nativeWrite(...args);
				if (result.ok) controller.abort();
				return result;
			});
			const result =
				name === "write"
					? await createWriteTool().execute(
							"io",
							{ path: "target.txt", content: "after" },
							controller.signal,
							undefined,
							{ env },
						)
					: await createEditTool().execute(
							"io",
							{ path: "target.txt", edits: [{ oldText: "before", newText: "after" }] },
							controller.signal,
							undefined,
							{ env },
						);
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Successfully") });
			expect(await readFile(join(env.cwd, "target.txt"), "utf8")).toBe("after");
			expect(controller.signal.aborted).toBe(true);
		},
	);

	it("catches native queue-key ELOOP before invoking the write backend", async () => {
		const env = environment();
		const path = join(env.cwd, "loop");
		await symlink(path, path);
		const write = vi.spyOn(env, "writeFile");
		const args = { path, content: "after" };
		const error = await failure(createWriteTool().execute("loop", args, undefined, undefined, { env }));
		expect(write).not.toHaveBeenCalled();
		expect(getToolErrorOutcome(error, "write", args)).toBe("not_started");
	});

	it("marks pre-invocation cancellation not started", async () => {
		const env = environment();
		const controller = new AbortController();
		controller.abort();
		const write = vi.spyOn(env, "writeFile");
		const args = { path: "target.txt", content: "after" };
		const error = await failure(createWriteTool().execute("io", args, controller.signal, undefined, { env }));
		expect(write).not.toHaveBeenCalled();
		expect(getToolErrorOutcome(error, "write", args)).toBe("not_started");
	});

	it("does not mark a backend write rejection not started, including possible mkdir effects", async () => {
		const env = environment();
		const parent = join(env.cwd, "created");
		vi.spyOn(env, "writeFile").mockImplementation(async () => {
			await mkdir(parent);
			throw new Error("mkdir acknowledgement lost");
		});
		const args = { path: join(parent, "target.txt"), content: "after" };
		const error = await failure(createWriteTool().execute("io", args, undefined, undefined, { env }));
		expect(getToolErrorOutcome(error, "write", args)).toBe("unknown");
	});

	it.each(["signal", "timeout", "lost_ack", "promoted"] as const)(
		"keeps %s termination without confirmed exit",
		async (kind) => {
			const env = environment();
			const controller = new AbortController();
			vi.spyOn(env, "exec").mockImplementation(async (): Promise<Result<ShellExecResult, ExecutionError>> => {
				controller.abort();
				if (kind === "timeout") return err(new ExecutionError("timeout", "timeout:1"));
				if (kind === "lost_ack") return err(new ExecutionError("unknown", "ack lost"));
				return {
					ok: true,
					value:
						kind === "signal"
							? { stdout: "", stderr: "", exitCode: 0, signal: "SIGTERM" }
							: { stdout: "", stderr: "", exitCode: -1, promotedTaskId: "promoted" },
				};
			});
			const capture = getOrThrow(
				await executeShellWithCapture(env, "effect", {
					abortSignal: controller.signal,
					returnExecutionErrors: true,
				}),
			);
			expect(capture.exitCode).toBeUndefined();
			if (kind === "promoted") expect(capture.promotedTaskId).toBe("promoted");
		},
	);
});
