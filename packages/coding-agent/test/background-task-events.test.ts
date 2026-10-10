import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { BACKGROUND_TASK_NOTIFICATION_TYPE } from "../src/core/background-task-notifications.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getShellConfig } from "../src/utils/shell.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Faux-provider session with optional settings overrides and an inline extension factory. */
async function createHarness(
	options: { settings?: Record<string, unknown>; extensionFactory?: (pi: ExtensionAPI) => void } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "pi-bg-events-"));
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("ack-1"), fauxAssistantMessage("ack-2"), fauxAssistantMessage("ack-3")]);
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(dir, "models.json") });
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
		settingsManager: SettingsManager.inMemory(options.settings ?? {}),
		resourceLoaderOptions: {
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noExtensions: true,
			extensionFactories: options.extensionFactory ? [options.extensionFactory] : undefined,
		},
	});
	const created = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.create(dir),
		model,
	});
	const harness = {
		dir,
		session: created.session,
		faux,
		dispose: async (): Promise<void> => {
			await created.session.dispose();
			faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		},
	};
	cleanups.push(harness.dispose);
	return harness;
}

async function startSilentTask(harness: Harness, id = "noop", exitCode = 0): Promise<string> {
	const manager = harness.session.backgroundTasks;
	if (!manager) throw new Error("background task manager unavailable");
	const started = await manager.start(`echo bg-${id}; exit ${exitCode}`, {
		cwd: harness.dir,
		env: { ...process.env },
	});
	if (!started.ok) throw new Error(started.error.message);
	const settled = await manager.wait(started.value.id, 10_000);
	if (!settled.ok) throw new Error("wait failed");
	return started.value.id;
}

function notificationMessages(messages: AgentMessage[] | undefined): AgentMessage[] {
	return (messages ?? []).filter(
		(message) => (message as { customType?: string }).customType === BACKGROUND_TASK_NOTIFICATION_TYPE,
	);
}

describe("background task session events", () => {
	it.each(["success", "failure"])("wakes once for a %s completed inside the final model request", async (outcome) => {
		const harness = await createHarness({ settings: { backgroundBashCompletionDelivery: "wake" } });
		harness.faux.setResponses([
			async () => {
				await startSilentTask(harness, outcome, outcome === "failure" ? 7 : 0);
				return fauxAssistantMessage("started");
			},
			fauxAssistantMessage("consumed"),
		]);
		await harness.session.prompt("start work");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.pendingBackgroundTaskNotificationCount).toBe(0);
		const notices = harness.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_TASK_NOTIFICATION_TYPE);
		expect(notices).toHaveLength(1);
		expect(harness.session.backgroundTasks?.list({ activeOnly: false })[0]?.status).toBe(
			outcome === "failure" ? "failed" : "succeeded",
		);
	});

	it("keeps completion pending when the current run was explicitly cancelled", async () => {
		const harness = await createHarness({ settings: { backgroundBashCompletionDelivery: "wake" } });
		harness.faux.setResponses([
			async () => {
				const aborting = harness.session.abort();
				await startSilentTask(harness, "cancelled");
				void aborting;
				return fauxAssistantMessage("cancelled");
			},
			fauxAssistantMessage("must not wake"),
		]);
		await harness.session.prompt("start work");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.pendingBackgroundTaskNotificationCount).toBe(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("does not wake for a task finishing after an explicitly cancelled run is idle", async () => {
		const harness = await createHarness({ settings: { backgroundBashCompletionDelivery: "wake" } });
		harness.faux.setResponses([
			() => {
				void harness.session.abort();
				return fauxAssistantMessage("cancelled");
			},
			fauxAssistantMessage("must not wake"),
		]);
		await harness.session.prompt("start work");
		await startSilentTask(harness, "after-cancel");
		expect(harness.session.isIdle).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.pendingBackgroundTaskNotificationCount).toBe(1);
	});

	it("coalesces completions from the final request into one continuation", async () => {
		const harness = await createHarness({ settings: { backgroundBashCompletionDelivery: "wake" } });
		harness.faux.setResponses([
			async () => {
				await startSilentTask(harness, "first");
				await startSilentTask(harness, "second", 7);
				return fauxAssistantMessage("started both");
			},
			fauxAssistantMessage("consumed both"),
		]);
		await harness.session.prompt("start work");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.pendingBackgroundTaskNotificationCount).toBe(0);
		const notices = harness.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_TASK_NOTIFICATION_TYPE);
		expect(notices).toHaveLength(1);
		expect(JSON.stringify(notices[0])).toContain("Background tasks finished: 2");
	});

	it("does not continue after wait_for already consumed the completion", async () => {
		const harness = await createHarness({ settings: { backgroundBashCompletionDelivery: "wake" } });
		harness.faux.setResponses([
			async () => {
				const taskId = await startSilentTask(harness, "waited");
				const waitFor = harness.session.getToolDefinition("wait_for");
				if (!waitFor) throw new Error("wait_for unavailable");
				await waitFor.execute(
					"consume",
					{ task_id: taskId },
					undefined,
					undefined,
					harness.session.extensionRunner.createContext(),
				);
				return fauxAssistantMessage("consumed by wait_for");
			},
		]);
		await harness.session.prompt("start work");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.pendingBackgroundTaskNotificationCount).toBe(0);
	});

	it("emits started/completed to session listeners and extensions", async () => {
		const extensionEvents: string[] = [];
		const harness = await createHarness({
			extensionFactory: (pi) => {
				pi.on("background_task_started", (event) => {
					extensionEvents.push(`started:${event.task.id}`);
				});
				pi.on("background_task_completed", (event) => {
					extensionEvents.push(`completed:${event.task.id}`);
				});
			},
		});
		const sessionEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "background_task_started") sessionEvents.push(`started:${event.task.id}`);
			if (event.type === "background_task_completed") sessionEvents.push(`completed:${event.task.id}`);
		});

		const taskId = await startSilentTask(harness, "events");
		expect(sessionEvents).toEqual([`started:${taskId}`, `completed:${taskId}`]);
		// extension handlers run on the same payload, asynchronously
		await vi.waitFor(() => expect(extensionEvents).toEqual(sessionEvents), { timeout: 10_000 });
	});

	it("reports a stall to session listeners without stopping the task", async () => {
		const harness = await createHarness({ settings: { backgroundBashStallTimeoutSeconds: 0.05 } });
		const stalls: Array<{ id: string; silentMs: number }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "background_task_stalled") {
				stalls.push({ id: event.task.id, silentMs: event.silentMs });
			}
		});
		const manager = harness.session.backgroundTasks;
		if (!manager) throw new Error("background task manager unavailable");
		const shell = getShellConfig();
		const started = await manager.start(`sleep 5`, { cwd: harness.dir, env: { ...process.env } });
		if (!started.ok) throw new Error(started.error.message);
		void shell;

		await vi.waitFor(() => expect(stalls.length).toBeGreaterThan(0), { timeout: 10_000 });
		expect(stalls[0]?.id).toBe(started.value.id);
		expect(stalls[0]?.silentMs).toBeGreaterThanOrEqual(50);
		expect(manager.get(started.value.id)?.status).toBe("running");
	});

	it("queues completion behind the turn with followUp delivery instead of injecting it", async () => {
		const harness = await createHarness({ settings: { backgroundBashCompletionDelivery: "followUp" } });
		const taskId = await startSilentTask(harness, "followup");

		const transformed = await harness.session.agent.transformContext?.([], undefined);
		expect(notificationMessages(transformed)).toHaveLength(0);
		const branch = harness.session.sessionManager.getBranch();
		const persisted = branch.filter(
			(entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_TASK_NOTIFICATION_TYPE,
		);
		expect(persisted).toHaveLength(1);
		expect(JSON.stringify(persisted[0])).toContain(taskId);
	});

	it("starts a turn when a task completes while idle in wake mode", async () => {
		const harness = await createHarness({ settings: { backgroundBashCompletionDelivery: "wake" } });
		await startSilentTask(harness, "wake");

		await vi.waitFor(
			() => {
				const assistant = harness.session.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "message")
					.map((entry) => entry.message)
					.filter((message) => message.role === "assistant");
				expect(assistant.length).toBeGreaterThan(0);
			},
			{ timeout: 15_000 },
		);
	});
});
