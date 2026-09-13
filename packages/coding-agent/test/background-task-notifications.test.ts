import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ok } from "@earendil-works/pi-agent-core";
import { BackgroundTaskManager, type BackgroundTaskRecord } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	BACKGROUND_TASK_NOTIFICATION_TYPE,
	BackgroundTaskNotifications,
	formatBackgroundTaskNotification,
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
