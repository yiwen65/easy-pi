import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ok } from "@earendil-works/pi-agent-core";
import { BackgroundTaskManager, type BackgroundTaskRecord } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	BACKGROUND_TASK_NOTIFICATION_TYPE,
	BACKGROUND_TASK_STALL_NOTIFICATION_TYPE,
	BackgroundTaskNotifications,
	formatBackgroundTaskNotification,
	formatBackgroundTaskStallNotification,
} from "../src/core/background-task-notifications.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getShellConfig } from "../src/utils/shell.ts";

function createManager(logDir: string): BackgroundTaskManager {
	return new BackgroundTaskManager({
		shell: async () => ok(getShellConfig()),
		resolveEnv: (env) => env,
		stopGraceMs: 100,
		logDir,
	});
}

async function settle(manager: BackgroundTaskManager, id: string): Promise<BackgroundTaskRecord> {
	const result = await manager.wait(id, 10_000);
	if (!result.ok) throw new Error("wait failed");
	return result.value.task;
}

describe("BackgroundTaskNotifications", () => {
	let dir: string;
	let manager: BackgroundTaskManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-bg-notify-"));
		manager = createManager(dir);
	});
	afterEach(async () => {
		await manager.cleanup();
		rmSync(dir, { recursive: true, force: true });
	});

	it("queues a terminal event once and drains it as a custom message", async () => {
		const notifications = new BackgroundTaskNotifications();
		notifications.bind(manager);
		const started = await manager.start("echo notify-me", { cwd: dir, env: { ...process.env } });
		if (!started.ok) throw new Error("start failed");
		const task = await settle(manager, started.value.id);
		expect(notifications.pendingCount).toBe(1);

		const sent: string[] = [];
		const added = await notifications.drain(async (message) => {
			sent.push(message.content);
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(`Background task ${task.id} finished: succeeded (exit code 0)`);
		expect(sent[0]).toContain("echo notify-me");
		expect(sent[0]).toContain("Output log:");
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({ role: "custom", customType: BACKGROUND_TASK_NOTIFICATION_TYPE });

		// one-shot: a later request boundary has nothing to inject
		expect(await notifications.drain(async () => {})).toHaveLength(0);
		expect(notifications.pendingCount).toBe(0);
	});

	it("coalesces every task that finished inside one boundary into a single message", async () => {
		const notifications = new BackgroundTaskNotifications();
		notifications.bind(manager);
		const started = await Promise.all([
			manager.start("echo batch-1", { cwd: dir, env: { ...process.env } }),
			manager.start("exit 3", { cwd: dir, env: { ...process.env } }),
			manager.start("echo batch-3", { cwd: dir, env: { ...process.env } }),
		]);
		const ids = started.map((result) => {
			if (!result.ok) throw new Error("start failed");
			return result.value.id;
		});
		for (const id of ids) await settle(manager, id);
		expect(notifications.pendingCount).toBe(3);

		const sent: string[] = [];
		const added = await notifications.drain(async (message) => {
			sent.push(message.content);
		});
		expect(sent).toHaveLength(1);
		expect(added).toHaveLength(1);
		expect(sent[0]).toContain("Background tasks finished: 3");
		for (const id of ids) expect(sent[0]).toContain(id);
		expect(sent[0]).toContain("task_output(task_id)");
		// tasks finish in nondeterministic order, so compare the id set rather than the array order
		const detailTasks = (added[0] as { details?: { tasks?: Array<{ id: string }> } }).details?.tasks ?? [];
		expect(detailTasks.map((task) => task.id).sort()).toEqual([...ids].sort());
		expect(notifications.pendingCount).toBe(0);
	});

	it("reports an unavailable log instead of a log path", () => {
		const record: BackgroundTaskRecord = {
			id: "task-9",
			command: "echo nope",
			cwd: dir,
			status: "succeeded",
			startedAt: 1_000,
			endedAt: 3_400,
			lastOutputAt: 2_000,
			exitCode: 0,
			signal: null,
			outputPath: "/tmp/pi-batch-missing.log",
			promoted: false,
			logError: "ENOENT: no such file or directory",
		};
		const text = formatBackgroundTaskNotification(record);
		expect(text).toContain("finished: succeeded (exit code 0) after 2s.");
		expect(text).toContain("Output log unavailable (ENOENT: no such file or directory)");
		expect(text).not.toContain("/tmp/pi-batch-missing.log");
	});

	it("inlines the last output for a single failed task and keeps a success as a pointer", async () => {
		const notifications = new BackgroundTaskNotifications();
		notifications.bind(manager);

		const failed = await manager.start("echo boom-marker >&2; exit 3", { cwd: dir, env: { ...process.env } });
		if (!failed.ok) throw new Error("start failed");
		const failedTask = await settle(manager, failed.value.id);
		expect(failedTask.status).toBe("failed");
		let sent: string[] = [];
		await notifications.drain(async (message) => {
			sent.push(message.content);
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("Last output:");
		expect(sent[0]).toContain("boom-marker");

		// a successful task stays a result plus a pointer: no output inlined, log path only
		const ok = await manager.start("echo fine-here", { cwd: dir, env: { ...process.env } });
		if (!ok.ok) throw new Error("start failed");
		await settle(manager, ok.value.id);
		sent = [];
		await notifications.drain(async (message) => {
			sent.push(message.content);
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toContain("Last output:");
		expect(sent[0]).toContain("Output log: ");
		// every notice tells the model how to look closer, so it never has to guess
		expect(sent[0]).toContain("Use task_output(");
	});

	it("honors the configured inline policy", async () => {
		const run = async (mode: "failures" | "never" | "tail-lines" | "always", command: string) => {
			const notifications = new BackgroundTaskNotifications();
			notifications.bind(manager, { inlinePolicy: () => ({ mode, bytes: 4 * 1024 }) });
			const started = await manager.start(command, { cwd: dir, env: { ...process.env } });
			if (!started.ok) throw new Error("start failed");
			await settle(manager, started.value.id);
			const sent: string[] = [];
			await notifications.drain(async (message) => {
				sent.push(message.content);
			});
			return sent[0] ?? "";
		};

		// never: even a failure stays a pure result
		const neverFailure = await run("never", "echo hidden-marker >&2; exit 9");
		expect(neverFailure).toContain("failed (exit code 9)");
		expect(neverFailure).not.toContain("Last output:");

		// always: a success carries its output too
		const alwaysSuccess = await run("always", "echo success-marker");
		expect(alwaysSuccess).toContain("Last output:");
		expect(alwaysSuccess).toContain("success-marker");

		// tail-lines: only the last few lines, not the whole output
		const tailLines = await run("tail-lines", "echo line-1; echo line-2; echo line-3; echo line-4; exit 1");
		expect(tailLines).toContain("Last output:");
		const [, tailSection = ""] = tailLines.split("Last output:");
		expect(tailSection).toContain("line-4");
		expect(tailSection).not.toContain("line-1");
	});

	it("formats a batch of stall notices compactly", () => {
		const now = Date.now();
		const base: BackgroundTaskRecord = {
			id: "task-1",
			command: "cargo build",
			cwd: dir,
			status: "running",
			startedAt: now - 3_600_000,
			lastOutputAt: now - 1_800_000,
			outputPath: "/tmp/pi-stall.log",
			promoted: false,
		};
		const text = formatBackgroundTaskStallNotification([
			{ task: base, silentMs: 1_800_000 },
			{ task: { ...base, id: "task-2", command: "npm install" }, silentMs: 3_600_000 },
		]);
		expect(text).toContain("Background tasks with no output for their stall window: 2");
		expect(text).toContain("task-1 silent 30m0s");
		expect(text).toContain("task-2 silent 1h0m");
		expect(text).toContain("They keep running");
	});

	it("queues one stall notice per silent task and drains it as its own message", async () => {
		const notifications = new BackgroundTaskNotifications();
		const stallManager = new BackgroundTaskManager({
			shell: async () => ok(getShellConfig()),
			resolveEnv: (env) => env,
			stopGraceMs: 100,
			logDir: dir,
			stallTimeoutMs: 50,
			stallSweepIntervalMs: 20,
		});
		notifications.bind(stallManager);
		let notices = 0;
		stallManager.onStall(() => notices++);
		const started = await stallManager.start("sleep 5", {
			cwd: dir,
			env: { ...process.env },
		});
		if (!started.ok) throw new Error("start failed");

		// Several stall windows elapse for the same task, but only one notice stays queued.
		await vi.waitFor(() => expect(notices).toBeGreaterThan(1), { timeout: 5_000 });
		expect(notifications.pendingStallCount).toBe(1);

		const sent: Array<{ type: string; content: string }> = [];
		const added = await notifications.drain(async (message) => {
			sent.push({ type: message.customType, content: message.content });
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]?.type).toBe(BACKGROUND_TASK_STALL_NOTIFICATION_TYPE);
		expect(sent[0]?.content).toContain(`Background task ${started.value.id} has produced no output for`);
		expect(sent[0]?.content).toContain("It may be stuck, but it keeps running.");
		expect(sent[0]?.content).toContain(`task_output(${started.value.id})`);
		expect(added[0]).toMatchObject({ customType: BACKGROUND_TASK_STALL_NOTIFICATION_TYPE });
		expect(notifications.pendingStallCount).toBe(0);

		// a stall notice never stops the task
		expect(stallManager.get(started.value.id)?.status).toBe("running");
		await stallManager.cleanup();
	});

	it("suppresses notifications for tasks consumed via wait_for", async () => {
		const notifications = new BackgroundTaskNotifications();
		notifications.bind(manager);
		const started = await manager.start("echo consumed", { cwd: dir, env: { ...process.env } });
		if (!started.ok) throw new Error("start failed");
		const task = await settle(manager, started.value.id);
		notifications.markConsumedByWaitFor(task.id);
		expect(notifications.pendingCount).toBe(0);
		expect(await notifications.drain(async () => {})).toHaveLength(0);
	});

	it("requeues notifications whose persistence failed", async () => {
		const notifications = new BackgroundTaskNotifications();
		notifications.bind(manager);
		const started = await manager.start("echo retry", { cwd: dir, env: { ...process.env } });
		if (!started.ok) throw new Error("start failed");
		await settle(manager, started.value.id);

		const failed = await notifications.drain(async () => {
			throw new Error("disk full");
		});
		expect(failed).toHaveLength(0);
		expect(notifications.pendingCount).toBe(1);

		const sent: string[] = [];
		await notifications.drain(async (message) => {
			sent.push(message.content);
		});
		expect(sent).toHaveLength(1);
	});

	it("formats promoted and failed outcomes", async () => {
		const notifications = new BackgroundTaskNotifications();
		notifications.bind(manager);
		const started = await manager.start("exit 3", { cwd: dir, env: { ...process.env } });
		if (!started.ok) throw new Error("start failed");
		const task = await settle(manager, started.value.id);
		expect(task.status).toBe("failed");
		const text = formatBackgroundTaskNotification(task);
		expect(text).toContain("finished: failed (exit code 3)");
		expect(text).toContain("exit 3");
	});
});

describe("background task notification session wiring", () => {
	let dir: string;
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-bg-notify-session-"));
	});
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("injects a persisted synthetic message at the next request boundary", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ok")]);
		cleanups.push(() => faux.unregister());

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(dir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: dir,
			modelRuntime,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(dir),
			model,
		});
		const session = created.session;
		cleanups.push(() => session.dispose());

		const manager = session.backgroundTasks;
		expect(manager).toBeDefined();
		const started = await manager!.start("echo session-notify", { cwd: dir, env: { ...process.env } });
		if (!started.ok) throw new Error("start failed");
		const task = await settle(manager!, started.value.id);
		expect(session.pendingBackgroundTaskNotificationCount).toBe(1);

		// next provider request boundary: the transform appends the notification once
		const transformed = await session.agent.transformContext?.([], undefined);
		const isNotification = (message: { role: string }): message is Extract<AgentMessage, { role: "custom" }> =>
			message.role === "custom" &&
			(message as { customType?: string }).customType === BACKGROUND_TASK_NOTIFICATION_TYPE;
		const injected = (transformed ?? []).filter(isNotification);
		expect(injected).toHaveLength(1);
		expect(injected[0].content).toContain(`Background task ${task.id} finished: succeeded`);

		// persisted into the session branch for subsequent turns
		const branch = session.sessionManager.getBranch();
		expect(
			branch.some(
				(entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_TASK_NOTIFICATION_TYPE,
			),
		).toBe(true);

		// one-shot: no repeat on the following boundary
		expect(session.pendingBackgroundTaskNotificationCount).toBe(0);
		const again = await session.agent.transformContext?.([], undefined);
		expect((again ?? []).filter(isNotification)).toHaveLength(0);
	});
});
