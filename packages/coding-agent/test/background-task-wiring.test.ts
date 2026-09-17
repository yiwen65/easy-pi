import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@earendil-works/pi-agent-core";
import { BackgroundTaskManager } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { BACKGROUND_TASK_TOOL_NAMES, createBackgroundTaskToolDefinitions } from "../src/core/tools/background-tasks.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { getShellConfig } from "../src/utils/shell.ts";

const noCtx = undefined as unknown as ExtensionContext;

describe("background task wiring (coding-agent)", () => {
	let cwd: string;
	let logDir: string;
	let manager: BackgroundTaskManager;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-bg-wiring-"));
		logDir = mkdtempSync(join(tmpdir(), "pi-bg-logs-"));
		manager = new BackgroundTaskManager({
			shell: async () => ok(getShellConfig()),
			resolveEnv: (env) => env,
			stopGraceMs: 100,
			logDir,
		});
	});
	afterEach(async () => {
		await manager.cleanup();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(logDir, { recursive: true, force: true });
	});

	it("promotes a timed-out foreground command through the BashOperations path", async () => {
		const definition = createBashToolDefinition(cwd, { backgroundTasks: manager, promotion: {} });
		const result = await definition.execute(
			"call-1",
			{ command: "sleep 5; echo should-be-stopped-later", timeout: 0.1 },
			undefined,
			undefined,
			noCtx,
		);
		expect(result.details).toMatchObject({ terminationReason: "promoted" });
		const taskId = (result.details as { backgroundTaskId?: string }).backgroundTaskId;
		expect(taskId).toBeDefined();
		expect(manager.get(taskId!)).toMatchObject({ status: "running", promoted: true });

		await manager.stop(taskId!);
		const waited = await manager.wait(taskId!, 10_000);
		expect(waited.ok && waited.value.task.status).toBe("stopped");
	});

	it("starts run_in_background through the shared manager", async () => {
		const definition = createBashToolDefinition(cwd, { backgroundTasks: manager, promotion: {} });
		const result = await definition.execute(
			"call-2",
			{ command: "echo wiring-ok", run_in_background: true },
			undefined,
			undefined,
			noCtx,
		);
		const taskId = (result.details as { backgroundTaskId?: string }).backgroundTaskId;
		expect(taskId).toBeDefined();
		const waited = await manager.wait(taskId!, 10_000);
		expect(waited.ok && waited.value.task.status).toBe("succeeded");
		const output = manager.readOutput(taskId!);
		expect(output.ok && output.value.output).toContain("wiring-ok");
	});

	it("keeps timeout failures when promotion is not configured", async () => {
		const definition = createBashToolDefinition(cwd, { backgroundTasks: manager });
		await expect(
			definition.execute("call-3", { command: "sleep 5", timeout: 0.1 }, undefined, undefined, noCtx),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		expect(manager.list()).toHaveLength(0);
	});

	it("binds the four task tools to the same manager", async () => {
		const definitions = createBackgroundTaskToolDefinitions(cwd, manager);
		expect(definitions.map((definition) => definition.name)).toEqual(BACKGROUND_TASK_TOOL_NAMES);

		const bash = createBashToolDefinition(cwd, { backgroundTasks: manager, promotion: {} });
		const started = await bash.execute(
			"call-4",
			{ command: "sleep 5", run_in_background: true },
			undefined,
			undefined,
			noCtx,
		);
		const taskId = (started.details as { backgroundTaskId?: string }).backgroundTaskId!;

		const taskList = definitions.find((definition) => definition.name === "task_list")!;
		const listed = await taskList.execute("call-5", {}, undefined, undefined, noCtx);
		expect(listed.content[0]).toMatchObject({ text: expect.stringContaining(taskId) });

		const waitFor = definitions.find((definition) => definition.name === "wait_for")!;
		const stop = definitions.find((definition) => definition.name === "task_stop")!;
		await stop.execute("call-6", { task_id: taskId }, undefined, undefined, noCtx);
		const waited = await waitFor.execute("call-7", { task_id: taskId }, undefined, undefined, noCtx);
		expect(waited.content[0]).toMatchObject({ text: expect.stringContaining("stopped") });
	});
	it("marks terminal results consumed through the wait_for definition hook", async () => {
		const consumed: string[] = [];
		const definitions = createBackgroundTaskToolDefinitions(cwd, manager, {
			onWaitForSettled: (taskId) => consumed.push(taskId),
		});
		const bash = createBashToolDefinition(cwd, { backgroundTasks: manager, promotion: {} });
		const started = await bash.execute(
			"call-hook-1",
			{ command: "echo hook-path", run_in_background: true },
			undefined,
			undefined,
			noCtx,
		);
		const taskId = (started.details as { backgroundTaskId?: string }).backgroundTaskId!;

		const waitFor = definitions.find((definition) => definition.name === "wait_for")!;
		await waitFor.execute("call-hook-2", { task_id: taskId }, undefined, undefined, noCtx);
		expect(consumed).toEqual([taskId]);

		// a timed-out wait must not consume
		const started2 = await bash.execute(
			"call-hook-3",
			{ command: "sleep 5", run_in_background: true },
			undefined,
			undefined,
			noCtx,
		);
		const taskId2 = (started2.details as { backgroundTaskId?: string }).backgroundTaskId!;
		await waitFor.execute("call-hook-4", { task_id: taskId2, timeout: 0.1 }, undefined, undefined, noCtx);
		expect(consumed).toEqual([taskId]);
		await manager.stop(taskId2);
		await manager.wait(taskId2, 10_000);
	});
});

describe("background bash runtime and stall settings", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-bg-settings-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("ships no runtime cap by default and honors explicit caps including 0", () => {
		// Long tasks keep running until they finish or are stopped; a cap is opt-in.
		expect(SettingsManager.create(dir, dir).getBackgroundBashTaskTimeoutSeconds()).toBe(0);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ backgroundBashTaskTimeoutSeconds: 0 }));
		expect(SettingsManager.create(dir, dir).getBackgroundBashTaskTimeoutSeconds()).toBe(0);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ backgroundBashTaskTimeoutSeconds: 42 }));
		expect(SettingsManager.create(dir, dir).getBackgroundBashTaskTimeoutSeconds()).toBe(42);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ backgroundBashTaskTimeoutSeconds: -1 }));
		expect(SettingsManager.create(dir, dir).getBackgroundBashTaskTimeoutSeconds()).toBe(0);
	});

	it("defaults the stall window to 30 minutes and honors explicit values including 0", () => {
		expect(SettingsManager.create(dir, dir).getBackgroundBashStallTimeoutSeconds()).toBe(1800);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ backgroundBashStallTimeoutSeconds: 0 }));
		expect(SettingsManager.create(dir, dir).getBackgroundBashStallTimeoutSeconds()).toBe(0);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ backgroundBashStallTimeoutSeconds: 900 }));
		expect(SettingsManager.create(dir, dir).getBackgroundBashStallTimeoutSeconds()).toBe(900);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ backgroundBashStallTimeoutSeconds: -5 }));
		expect(SettingsManager.create(dir, dir).getBackgroundBashStallTimeoutSeconds()).toBe(1800);
	});

	it("defaults delivery, concurrency, log budget, and inline output, and honors explicit values", () => {
		const settings = () => SettingsManager.create(dir, dir);
		expect(settings().getBackgroundBashCompletionDelivery()).toBe("nextRequest");
		expect(settings().getBackgroundBashMaxTasks()).toBe(8);
		expect(settings().getBackgroundBashMaxLogBytes()).toBe(64 * 1024 * 1024);
		expect(settings().getBackgroundBashCompletionInlineOutput()).toBe("failures");
		expect(settings().getBackgroundBashCompletionInlineBytes()).toBe(4 * 1024);

		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				backgroundBashCompletionDelivery: "wake",
				backgroundBashMaxTasks: 0,
				backgroundBashMaxLogBytes: 1024,
				backgroundBashCompletionInlineOutput: "always",
				backgroundBashCompletionInlineBytes: 8192,
			}),
		);
		expect(settings().getBackgroundBashCompletionDelivery()).toBe("wake");
		expect(settings().getBackgroundBashMaxTasks()).toBe(0);
		expect(settings().getBackgroundBashMaxLogBytes()).toBe(1024);
		expect(settings().getBackgroundBashCompletionInlineOutput()).toBe("always");
		expect(settings().getBackgroundBashCompletionInlineBytes()).toBe(8192);

		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				backgroundBashCompletionDelivery: "nonsense",
				backgroundBashMaxTasks: -3,
				backgroundBashMaxLogBytes: -1,
				backgroundBashCompletionInlineOutput: "nonsense",
				backgroundBashCompletionInlineBytes: -5,
			}),
		);
		expect(settings().getBackgroundBashCompletionDelivery()).toBe("nextRequest");
		expect(settings().getBackgroundBashMaxTasks()).toBe(8);
		expect(settings().getBackgroundBashMaxLogBytes()).toBe(64 * 1024 * 1024);
		expect(settings().getBackgroundBashCompletionInlineOutput()).toBe("failures");
		expect(settings().getBackgroundBashCompletionInlineBytes()).toBe(4 * 1024);

		// the inline byte budget is clamped to a usable range
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ backgroundBashCompletionInlineOutput: "never", backgroundBashCompletionInlineBytes: 1 }),
		);
		expect(settings().getBackgroundBashCompletionInlineOutput()).toBe("never");
		expect(settings().getBackgroundBashCompletionInlineBytes()).toBe(256);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ backgroundBashCompletionInlineBytes: 999_999 }));
		expect(settings().getBackgroundBashCompletionInlineBytes()).toBe(32 * 1024);
	});
});
