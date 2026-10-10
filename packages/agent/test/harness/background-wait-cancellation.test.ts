import { describe, expect, it, vi } from "vitest";
import { BackgroundTaskManager } from "../../src/harness/env/background-task-manager.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createWaitForTool } from "../../src/harness/tools/background-tasks.ts";
import { getOrThrow, ok } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("background observation cancellation", () => {
	it("cancels waits promptly, releases listeners, and keeps the observed process running", async () => {
		const cwd = createTempDir();
		const manager = new BackgroundTaskManager({
			shell: async () => ok({ shell: process.execPath, args: ["-e"] }),
			logDir: cwd,
			stopGraceMs: 50,
		});
		try {
			const task = getOrThrow(
				await manager.start("setInterval(() => {}, 1000)", { cwd, env: {}, inheritEnv: false }),
			);
			const env = new NodeExecutionEnv({ cwd, backgroundTasks: manager });
			for (let attempt = 0; attempt < 3; attempt++) {
				const controller = new AbortController();
				const removed = vi.spyOn(controller.signal, "removeEventListener");
				const wait = createWaitForTool().execute(
					"wait",
					{ task_id: task.id, timeout: 600 },
					controller.signal,
					undefined,
					{ env },
				);
				controller.abort();
				await expect(wait).rejects.toThrow("Wait aborted");
				expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
				expect(manager.get(task.id)?.status).toBe("running");
			}
			const timed = getOrThrow(await manager.wait(task.id, 1));
			expect(timed.timedOut).toBe(true);
			expect(timed.task.status).toBe("running");
		} finally {
			await manager.cleanup();
		}
	});
});
