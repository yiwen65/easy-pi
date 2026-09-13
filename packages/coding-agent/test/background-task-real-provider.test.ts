/**
 * Manual real-provider validation for the background bash task system.
 *
 * Never calls a provider unless PI_REAL_MODEL_EVAL=1 is set explicitly. Uses the
 * production ModelRuntime/AuthStorage path with the real ~/.epi/agent auth and the
 * kimi-coding/k3 model. Sessions are in-memory; nothing is written to the real
 * agent dir. Assertions target session state (tool calls, task records, persisted
 * custom messages), never exact model wording or credentials.
 *
 * Run explicitly:
 *   PI_REAL_MODEL_EVAL=1 npx vitest --run test/background-task-real-provider.test.ts --silent=false
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { BACKGROUND_TASK_NOTIFICATION_TYPE } from "../src/core/background-task-notifications.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1";
if (RUN) {
	delete process.env.PI_OFFLINE;
	configureHttpDispatcher();
}

const PROVIDER = process.env.PI_REAL_BG_PROVIDER ?? "kimi-coding";
const MODEL_ID = process.env.PI_REAL_BG_MODEL ?? "k3";
const TURN_TIMEOUT_MS = 240_000;

interface BashToolCall {
	arguments: { command?: string; run_in_background?: boolean; timeout?: number };
}

function toolCallsNamed(messages: AgentMessage[], name: string): BashToolCall[] {
	const calls: BashToolCall[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message as { content?: unknown[] }).content ?? []) {
			const part = block as { type?: string; name?: string; arguments?: BashToolCall["arguments"] };
			if (part.type === "toolCall" && part.name === name) calls.push({ arguments: part.arguments ?? {} });
		}
	}
	return calls;
}

function toolResultsNamed(messages: AgentMessage[], toolName: string) {
	return messages
		.filter((message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === toolName)
		.map((message) => message as Extract<AgentMessage, { role: "toolResult" }>);
}

function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = ((message as { content?: unknown[] }).content ?? [])
			.filter((block) => (block as { type?: string }).type === "text")
			.map((block) => (block as { text?: string }).text ?? "")
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

function notificationEntries(session: AgentSession) {
	return session.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_TASK_NOTIFICATION_TYPE);
}

describe.skipIf(!RUN)("background bash tasks with a real provider", () => {
	let workDir: string;
	let session: AgentSession;
	const activeTaskIds: string[] = [];

	beforeAll(async () => {
		workDir = mkdtempSync(join(tmpdir(), "pi-bg-real-"));
		const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".epi", "agent");
		const services = await createAgentSessionServices({
			cwd: workDir,
			agentDir,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
		});
		const model = services.modelRuntime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`Real provider model not available: ${PROVIDER}/${MODEL_ID}`);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(workDir),
			model,
			backgroundBash: { promotion: true },
		});
		session = created.session;
		console.log(`[real-bg] session ready with ${PROVIDER}/${MODEL_ID}`);
	}, 60_000);

	afterAll(async () => {
		for (const id of activeTaskIds) {
			try {
				await session.backgroundTasks?.stop(id);
			} catch {
				// best effort
			}
		}
		session?.dispose();
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it(
		"model starts a background task on request and can wait for it",
		async () => {
			const marker = `REAL_BG_DONE_${Date.now()}`;
			await session.prompt(
				`请用 bash 工具在后台运行这个命令(必须设置 run_in_background=true):\`sleep 6 && echo ${marker}\`。\n` +
					`启动成功后,用 wait_for 工具等待它结束,然后简单回复我结果。`,
			);

			const messages = session.agent.state.messages;
			const bashCalls = toolCallsNamed(messages, "bash");
			expect(bashCalls.some((call) => call.arguments.run_in_background === true)).toBe(true);

			const backgroundResult = toolResultsNamed(messages, "bash").find(
				(result) => (result.details as { backgroundTaskId?: string } | undefined)?.backgroundTaskId !== undefined,
			);
			expect(backgroundResult).toBeDefined();
			const taskId = (backgroundResult!.details as { backgroundTaskId: string }).backgroundTaskId;
			activeTaskIds.push(taskId);

			const manager = session.backgroundTasks!;
			const waited = await manager.wait(taskId, 30_000);
			expect(waited.ok && waited.value.task.status).toBe("succeeded");
			const output = manager.readOutput(taskId);
			expect(output.ok && output.value.output).toContain(marker);

			// the model used wait_for and got a terminal result
			const waitResults = toolResultsNamed(messages, "wait_for");
			expect(waitResults.length).toBeGreaterThan(0);
			expect((waitResults[0].details as { timedOut?: boolean } | undefined)?.timedOut).toBe(false);
			expect(lastAssistantText(messages).length).toBeGreaterThan(0);
			console.log(`[real-bg] scenario 1 done: task ${taskId} succeeded, wait_for used`);
		},
		TURN_TIMEOUT_MS,
	);

	it(
		"promotes an explicitly short-timed-out foreground command and notifies on the next turn",
		async () => {
			const marker = `REAL_BG_PROMOTED_${Date.now()}`;
			await session.prompt(
				`请用 bash 工具前台运行这个命令,并把 timeout 参数设为 3 秒:\`sleep 12 && echo ${marker}\`。` +
					`如果它因为超时被转入后台,回复我它的 task ID 即可。`,
			);

			const messages = session.agent.state.messages;
			const bashResults = toolResultsNamed(messages, "bash");
			const promoted = bashResults.find(
				(result) =>
					(result.details as { terminationReason?: string } | undefined)?.terminationReason === "promoted",
			);
			expect(promoted).toBeDefined();
			const taskId = (promoted!.details as { backgroundTaskId: string }).backgroundTaskId;
			activeTaskIds.push(taskId);

			const manager = session.backgroundTasks!;
			expect(manager.get(taskId)?.promoted).toBe(true);

			// wait for the background task to actually finish, then let the model ask about it
			const waited = await manager.wait(taskId, 30_000);
			expect(waited.ok && waited.value.task.status).toBe("succeeded");

			const notificationsBefore = notificationEntries(session).length;
			await session.prompt(`刚才那个被转入后台的命令(task ${taskId})结束了吗?简单回答即可。`);
			const notifications = notificationEntries(session);
			expect(notifications.length).toBeGreaterThan(notificationsBefore);
			expect(lastAssistantText(session.agent.state.messages).length).toBeGreaterThan(0);
			console.log(`[real-bg] scenario 2 done: promoted task ${taskId} notified at next boundary`);
		},
		TURN_TIMEOUT_MS,
	);

	it(
		"model stops a background task via task_stop",
		async () => {
			await session.prompt(
				"请用 bash 在后台运行 `sleep 120`(run_in_background=true),然后立刻用 task_stop 停止它,简单回复即可。",
			);

			const messages = session.agent.state.messages;
			const stopCalls = toolCallsNamed(messages, "task_stop");
			expect(stopCalls.length).toBeGreaterThan(0);

			const bashResults = toolResultsNamed(messages, "bash");
			const started = bashResults
				.map((result) => (result.details as { backgroundTaskId?: string } | undefined)?.backgroundTaskId)
				.filter((id): id is string => id !== undefined);
			expect(started.length).toBeGreaterThan(0);
			const taskId = started[started.length - 1];
			activeTaskIds.push(taskId);

			const manager = session.backgroundTasks!;
			const waited = await manager.wait(taskId, 15_000);
			expect(waited.ok && waited.value.timedOut).toBe(false);
			expect(waited.ok && waited.value.task.status).toBe("stopped");
			console.log(`[real-bg] scenario 3 done: task ${taskId} stopped via task_stop`);
		},
		TURN_TIMEOUT_MS,
	);
});
