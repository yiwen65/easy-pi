import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	BackgroundTaskManager,
	type BackgroundTaskManagerOptions,
} from "../../src/harness/env/background-task-manager.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	createTaskListTool,
	createTaskOutputTool,
	createTaskStopTool,
	createWaitForTool,
	type TaskListDetails,
	type TaskOutputDetails,
	type TaskStopDetails,
	type WaitForDetails,
} from "../../src/harness/tools/background-tasks.ts";
import { type BashToolDetails, type BashToolOptions, createBashTool } from "../../src/harness/tools/bash.ts";
import type { ExecutionToolContext } from "../../src/harness/tools/tool-context.ts";
import { ExecutionError, err, ok } from "../../src/harness/types.ts";
import { getToolErrorOutcome } from "../../src/tool-outcome.ts";
import { createTempDir } from "./session-test-utils.ts";

function createEnv(): NodeExecutionEnv {
	return new NodeExecutionEnv({ cwd: createTempDir() });
}

function contextFor(env: NodeExecutionEnv): ExecutionToolContext {
	return { env };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((chunk) => chunk.type === "text")
		.map((chunk) => chunk.text ?? "")
		.join("\n");
}

async function waitTaskTerminal(env: NodeExecutionEnv, taskId: string) {
	const result = await env.backgroundTasks?.wait(taskId, 10_000);
	expect(result?.ok).toBe(true);
	if (result?.ok) expect(result.value.timedOut).toBe(false);
	return result?.ok ? result.value.task : undefined;
}

describe("bash run_in_background", () => {
	it("returns a task ID immediately and the task keeps running", async () => {
		const env = createEnv();
		const bash = createBashTool();
		const result = await bash.execute(
			"call-1",
			{ command: "sleep 0.2; echo background-done", run_in_background: true },
			undefined,
			undefined,
			contextFor(env),
		);
		const details = result.details as BashToolDetails;
		expect(details.backgroundTaskId).toBeDefined();
		expect(textOf(result)).toContain(`Background task ${details.backgroundTaskId} started`);

		const task = await waitTaskTerminal(env, details.backgroundTaskId!);
		expect(task?.status).toBe("succeeded");
		const output = env.backgroundTasks?.readOutput(details.backgroundTaskId!);
		expect(output?.ok && output.value.output).toContain("background-done");
		await env.cleanup();
	});

	it("classifies a missing background cwd as not started without resolving the shell or registering a task", async () => {
		const cwd = createTempDir();
		const shell = vi.fn<BackgroundTaskManagerOptions["shell"]>(async () => ok({ shell: "bash", args: ["-c"] }));
		const manager = new BackgroundTaskManager({ shell });
		const env = new NodeExecutionEnv({ cwd, backgroundTasks: manager });
		const capture = vi.fn<NonNullable<BashToolOptions["capture"]>>(async () =>
			err(new ExecutionError("unknown", "unexpected foreground capture")),
		);
		const bash = createBashTool({ capture });
		const missingCwd = join(cwd, "node22");
		const args = {
			command: `mkdir -p ${JSON.stringify(missingCwd)}; echo started`,
			cwd: missingCwd,
			run_in_background: true,
		};
		try {
			const error = await bash
				.execute("missing-cwd", args, undefined, undefined, { env })
				.catch((error: unknown) => error);
			expect(error).toMatchObject({
				code: "SPAWN_ERROR",
				message: `SPAWN_ERROR\n\nWorking directory does not exist: ${missingCwd}`,
			});
			expect(shell).not.toHaveBeenCalled();
			expect(capture).not.toHaveBeenCalled();
			expect(manager.list({ activeOnly: false })).toEqual([]);
			expect(existsSync(missingCwd)).toBe(false);
			expect(getToolErrorOutcome(error, "bash", args)).toBe("not_started");
		} finally {
			await env.cleanup();
		}
	});

	it("classifies shell preparation failure as not started", async () => {
		const manager = new BackgroundTaskManager({
			shell: async () => err(new ExecutionError("shell_unavailable", "No usable shell")),
		});
		const env = new NodeExecutionEnv({ cwd: createTempDir(), backgroundTasks: manager });
		try {
			await expect(
				createBashTool().execute(
					"shell-failed",
					{ command: "echo hi", run_in_background: true },
					undefined,
					undefined,
					{ env },
				),
			).rejects.toMatchObject({ code: "SPAWN_ERROR", executionOutcome: "not_started" });
			expect(manager.list({ activeOnly: false })).toEqual([]);
		} finally {
			await env.cleanup();
		}
	});

	it("classifies manager shutdown rejection as not started", async () => {
		const env = createEnv();
		await env.backgroundTasks.shutdown();
		try {
			await expect(
				createBashTool().execute(
					"shutdown",
					{ command: "echo hi", run_in_background: true },
					undefined,
					undefined,
					{ env },
				),
			).rejects.toMatchObject({ code: "SPAWN_ERROR", executionOutcome: "not_started" });
			expect(env.backgroundTasks.list({ activeOnly: false })).toEqual([]);
		} finally {
			await env.cleanup();
		}
	});

	it("classifies capacity rejection as not started without registering another task", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir(), backgroundTaskMaxTasks: 1 });
		try {
			const bash = createBashTool();
			await bash.execute("running", { command: "sleep 60", run_in_background: true }, undefined, undefined, { env });
			await expect(
				bash.execute("over-capacity", { command: "echo hi", run_in_background: true }, undefined, undefined, {
					env,
				}),
			).rejects.toMatchObject({ code: "LIMIT_REACHED", executionOutcome: "not_started" });
			expect(env.backgroundTasks.list({ activeOnly: false })).toHaveLength(1);
		} finally {
			await env.cleanup();
		}
	});

	it("fails cleanly when the environment has no background task support", async () => {
		const env = createEnv();
		const withoutManager = Object.create(Object.getPrototypeOf(env), Object.getOwnPropertyDescriptors(env));
		Object.defineProperty(withoutManager, "backgroundTasks", { value: undefined });
		const bash = createBashTool();
		await expect(
			bash.execute("call-2", { command: "echo hi", run_in_background: true }, undefined, undefined, {
				env: withoutManager,
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED", executionOutcome: "not_started" });
		await env.cleanup();
	});
});

describe("bash foreground promotion", () => {
	it("promotes a timed-out foreground command instead of failing", async () => {
		const env = createEnv();
		const bash = createBashTool({ promotion: { foregroundTimeoutSeconds: 1, maxForegroundTimeoutSeconds: 300 } });
		const result = await bash.execute(
			"call-3",
			{ command: "sleep 0.3; echo after-promotion", timeout: 0.1 },
			undefined,
			undefined,
			contextFor(env),
		);
		const details = result.details as BashToolDetails;
		expect(details.terminationReason).toBe("promoted");
		expect(details.backgroundTaskId).toBeDefined();
		expect(textOf(result)).toContain("promoted to background task");

		const task = await waitTaskTerminal(env, details.backgroundTaskId!);
		expect(task?.status).toBe("succeeded");
		expect(task?.promoted).toBe(true);
		await env.cleanup();
	});

	it("applies the configured default foreground timeout", async () => {
		const env = createEnv();
		const bash = createBashTool({ promotion: { foregroundTimeoutSeconds: 0.15 } });
		const result = await bash.execute(
			"call-4",
			{ command: "sleep 5; echo late" },
			undefined,
			undefined,
			contextFor(env),
		);
		const details = result.details as BashToolDetails;
		expect(details.terminationReason).toBe("promoted");
		await env.backgroundTasks?.stop(details.backgroundTaskId!);
		await waitTaskTerminal(env, details.backgroundTaskId!);
		await env.cleanup();
	});

	it("rejects explicit timeouts above the foreground maximum", async () => {
		const env = createEnv();
		const bash = createBashTool({ promotion: {} });
		await expect(
			bash.execute("call-5", { command: "echo hi", timeout: 301 }, undefined, undefined, contextFor(env)),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await env.cleanup();
	});

	it("keeps the classic timeout failure when promotion is not configured", async () => {
		const env = createEnv();
		const bash = createBashTool();
		await expect(
			bash.execute("call-6", { command: "sleep 5", timeout: 0.1 }, undefined, undefined, contextFor(env)),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		await env.cleanup();
	});
});

describe("task management tools", () => {
	async function startTask(env: NodeExecutionEnv, command: string): Promise<string> {
		const bash = createBashTool();
		const result = await bash.execute(
			"call-start",
			{ command, run_in_background: true },
			undefined,
			undefined,
			contextFor(env),
		);
		return (result.details as BashToolDetails).backgroundTaskId!;
	}

	it("task_list shows active then finished tasks", async () => {
		const env = createEnv();
		const taskList = createTaskListTool();
		const quickId = await startTask(env, "echo quick");
		const slowId = await startTask(env, "sleep 5");
		await waitTaskTerminal(env, quickId);

		const active = await taskList.execute("t1", {}, undefined, undefined, contextFor(env));
		const activeTasks = (active.details as TaskListDetails).tasks;
		expect(activeTasks.map((task) => task.id)).toEqual([slowId]);
		expect(textOf(active)).toContain("sleep 5");

		const all = await taskList.execute("t2", { active_only: false }, undefined, undefined, contextFor(env));
		expect((all.details as TaskListDetails).tasks).toHaveLength(2);

		await env.backgroundTasks?.stop(slowId);
		await waitTaskTerminal(env, slowId);
		await env.cleanup();
	});

	it("marks running tasks with their silent time", async () => {
		const env = createEnv();
		const taskList = createTaskListTool();
		const quickId = await startTask(env, "echo quiet");
		const slowId = await startTask(env, "sleep 5");
		await waitTaskTerminal(env, quickId);

		const all = await taskList.execute("t1", { active_only: false }, undefined, undefined, contextFor(env));
		const lines = textOf(all).split("\n");
		// only running tasks report silence; finished rows keep their duration only
		expect(lines.find((line) => line.includes(slowId))).toContain("silent=");
		expect(lines.find((line) => line.includes(quickId))).not.toContain("silent=");

		await env.backgroundTasks?.stop(slowId);
		await waitTaskTerminal(env, slowId);
		await env.cleanup();
	});

	it("task_output returns a bounded preview plus the log path", async () => {
		const env = createEnv();
		const taskOutput = createTaskOutputTool();
		const taskId = await startTask(env, "printf '%0.sx' {1..40000}; echo MARKER");
		await waitTaskTerminal(env, taskId);

		const result = await taskOutput.execute(
			"t3",
			{ task_id: taskId, max_bytes: 2048 },
			undefined,
			undefined,
			contextFor(env),
		);
		const details = result.details as TaskOutputDetails;
		expect(details.truncated).toBe(true);
		expect(details.outputPath).toContain("pi-bash-");
		const text = textOf(result);
		expect(text).toContain("MARKER");
		expect(text).toContain("Full output:");
		expect(text.length).toBeLessThan(4096);

		await expect(
			taskOutput.execute("t4", { task_id: "task-nope" }, undefined, undefined, contextFor(env)),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await env.cleanup();
	});

	it("task_stop terminates two-phase and is safe on finished tasks", async () => {
		const env = createEnv();
		const taskStop = createTaskStopTool();
		const taskId = await startTask(env, "sleep 60");

		const result = await taskStop.execute("t5", { task_id: taskId }, undefined, undefined, contextFor(env));
		expect(textOf(result)).toContain("Stop requested");
		const task = await waitTaskTerminal(env, taskId);
		expect(task?.status).toBe("stopped");

		const again = await taskStop.execute("t6", { task_id: taskId }, undefined, undefined, contextFor(env));
		expect(textOf(again)).toContain("already reached a terminal state");
		expect((again.details as TaskStopDetails).task.status).toBe("stopped");
		await env.cleanup();
	});

	it("wait_for blocks until terminal and returns a snapshot on timeout", async () => {
		const env = createEnv();
		const waitFor = createWaitForTool();
		const quickId = await startTask(env, "sleep 0.2; echo waited");
		const finished = await waitFor.execute("t7", { task_id: quickId }, undefined, undefined, contextFor(env));
		const finishedDetails = finished.details as WaitForDetails;
		expect(finishedDetails.timedOut).toBe(false);
		expect(finishedDetails.task.status).toBe("succeeded");
		expect(textOf(finished)).toContain("waited");

		const slowId = await startTask(env, "sleep 5");
		const timedOut = await waitFor.execute(
			"t8",
			{ task_id: slowId, timeout: 0.1 },
			undefined,
			undefined,
			contextFor(env),
		);
		const timedOutDetails = timedOut.details as WaitForDetails;
		expect(timedOutDetails.timedOut).toBe(true);
		expect(textOf(timedOut)).toContain("still running");

		await env.backgroundTasks?.stop(slowId);
		await waitTaskTerminal(env, slowId);
		await env.cleanup();
	});

	it("task tools report UNSUPPORTED without a manager", async () => {
		const env = createEnv();
		const withoutManager = Object.create(Object.getPrototypeOf(env), Object.getOwnPropertyDescriptors(env));
		Object.defineProperty(withoutManager, "backgroundTasks", { value: undefined });
		const context = { env: withoutManager as NodeExecutionEnv };
		const taskList = createTaskListTool();
		await expect(taskList.execute("t9", {}, undefined, undefined, context)).rejects.toMatchObject({
			code: "UNSUPPORTED",
		});
		await env.cleanup();
	});

	it("exposes the manager on the execution environment", () => {
		const env = createEnv();
		expect(env.backgroundTasks).toBeInstanceOf(BackgroundTaskManager);
	});
});
