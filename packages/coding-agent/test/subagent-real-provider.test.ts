/**
 * Manual real-provider validation for the native subagent (collaboration) system.
 *
 * Never calls a provider unless PI_REAL_MODEL_EVAL=1 is set explicitly. Uses the
 * production ModelRuntime/AuthStorage path with real ~/.epi/agent credentials and the
 * openai-codex/gpt-6-astra model for both root and children (kimi-coding/k3 hits a concurrency 403 when root and child infer simultaneously). Each scenario gets a fresh temp
 * agentDir/cwd, so teams and session files never touch real user state. Assertions
 * target session state (tool calls, tool results, persisted branch entries), never
 * exact model wording or credentials.
 *
 * Run explicitly (one scenario at a time keeps each run short):
 *   PI_REAL_MODEL_EVAL=1 npx vitest --run test/subagent-real-provider.test.ts --silent=false [-t <name>]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBuiltInExtensions } from "../src/extensions/index.ts";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1";
if (RUN) {
	delete process.env.PI_OFFLINE;
	configureHttpDispatcher();
}

const PROVIDER = process.env.PI_REAL_SUBAGENT_PROVIDER ?? "openai-codex";
const MODEL_ID = process.env.PI_REAL_SUBAGENT_MODEL ?? "gpt-6-astra";
const TURN_TIMEOUT_MS = 280_000;
const MAILBOX_MESSAGE_TYPE = "epi-collaboration-message";

interface SessionFixture {
	session: AgentSession;
	cwd: string;
}

const fixtures: SessionFixture[] = [];
afterEach(async () => {
	while (fixtures.length > 0) {
		const fixture = fixtures.pop()!;
		try {
			fixture.session.dispose();
		} catch {
			// best effort
		}
		rmSync(fixture.cwd, { recursive: true, force: true });
	}
});

async function realSession(): Promise<SessionFixture> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-real-"));
	const agentDir = join(cwd, "agent");
	const realAgentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".epi", "agent");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(realAgentDir, "auth.json"),
		modelsPath: join(realAgentDir, "models.json"),
	});
	const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
	if (!model) throw new Error(`Real provider model not available: ${PROVIDER}/${MODEL_ID}`);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: createBuiltInExtensions(agentDir),
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		settingsManager,
		sessionManager: SessionManager.create(cwd, join(cwd, "root")),
		resourceLoader,
	});
	await session.bindExtensions({ mode: "rpc" });
	const fixture = { session, cwd };
	fixtures.push(fixture);
	console.log(`[real-subagent] session ready with ${PROVIDER}/${MODEL_ID}`);
	return fixture;
}

function toolCallsNamed(messages: AgentMessage[], name: string): Array<Record<string, unknown>> {
	const calls: Array<Record<string, unknown>> = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message as { content?: unknown[] }).content ?? []) {
			const part = block as { type?: string; name?: string; arguments?: Record<string, unknown> };
			if (part.type === "toolCall" && part.name === name) calls.push(part.arguments ?? {});
		}
	}
	return calls;
}

function toolResultTexts(session: AgentSession, toolName: string): string[] {
	return session.agent.state.messages
		.filter((message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === toolName)
		.map((message) =>
			((message as { content?: Array<{ type: string; text?: string }> }).content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n"),
		);
}

function mailboxEntries(session: AgentSession): string[] {
	return session.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === MAILBOX_MESSAGE_TYPE)
		.map((entry) => JSON.stringify(entry));
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

describe.skipIf(!RUN)("subagents with a real provider", () => {
	it(
		"root delegates via spawn_agent, the child runs real inference, and wait_agent receives its result",
		async () => {
			const { session } = await realSession();
			await session.prompt(
				"请严格按步骤执行。注意:这不是两个问题,而是一个连续流程;在拿到子代理结果之前不要输出任何答复文本。\n" +
					'1. 调用 spawn_agent:task_name="researcher";delegation.version=1;' +
					'delegation.task={"relationship":"continue","objective":"Reply with the single word PONG via deliver_result, then stop.","scope":"trivial real-provider probe","material":[],"deliverables":["the word PONG via deliver_result"],"acceptance":["result is PONG"]};' +
					'delegation.context={"mode":"isolated"};delegation.capabilities={"tools":"inherit"}。\n' +
					"2. 在同一回合内立即调用 wait_agent(timeout_ms=60000)等待它的完成通知;这期间不要回复我。\n" +
					"3. 只有拿到 wait_agent 返回的结果后,才用一句中文告诉我结果内容。",
			);

			const messages = session.agent.state.messages;
			const toolNames = messages
				.flatMap((message) =>
					message.role === "assistant"
						? (((message as { content?: unknown[] }).content ?? []) as Array<{ type?: string; name?: string }>)
								.filter((block) => block.type === "toolCall")
								.map((block) => block.name ?? "?")
						: [],
				)
				.join(",");
			console.log("[real-subagent] tool calls:", toolNames || "(none)");
			console.log("[real-subagent] spawn results:", toolResultTexts(session, "spawn_agent").join(" | ").slice(0, 400));
			console.log("[real-subagent] root reply:", lastAssistantText(messages).slice(0, 300));
			for (const message of messages) {
				const stop = (message as { stopReason?: string }).stopReason;
				if (stop === "error") {
					console.log(
						"[real-subagent] error message:",
						JSON.stringify(message).slice(0, 800),
					);
				}
			}
			console.log(
				"[real-subagent] message trace:",
				messages
					.map((message) => {
						const stop = (message as { stopReason?: string }).stopReason;
						const kinds =
							message.role === "assistant"
								? (((message as { content?: Array<{ type: string }> }).content ?? [])
										.map((block) => block.type)
										.join("+") || "empty")
								: "";
						return `${message.role}${stop ? `(${stop})` : ""}${kinds ? `[${kinds}]` : ""}`;
					})
					.join(" > "),
			);
			expect(toolCallsNamed(messages, "spawn_agent").some((call) => call.task_name === "researcher")).toBe(true);
			expect(toolCallsNamed(messages, "wait_agent").length).toBeGreaterThan(0);

			// the child's result was delivered through the mailbox and persisted into the root branch
			const mailbox = mailboxEntries(session);
			expect(mailbox.length).toBeGreaterThan(0);
			expect(mailbox.join("\n")).toContain("PONG");
			expect(lastAssistantText(messages).length).toBeGreaterThan(0);
			console.log("[real-subagent] scenario 1 done: delegation + wait_agent + mailbox delivery");
		},
		TURN_TIMEOUT_MS,
	);

	it(
		"followup_task starts a second turn on the idle child with existing context",
		async () => {
			const { session } = await realSession();
			await session.prompt(
				"请严格按步骤执行:\n" +
					'1. 调用 spawn_agent:task_name="researcher";delegation.version=1;' +
					'delegation.task={"relationship":"continue","objective":"Reply with the single word PONG via deliver_result, then stop.","scope":"trivial probe","material":[],"deliverables":["PONG"],"acceptance":["result is PONG"]};' +
					'delegation.context={"mode":"isolated"};delegation.capabilities={"tools":"inherit"}。\n' +
					"2. 调用 wait_agent 等待完成。\n" +
					'3. 调用 followup_task:target="researcher";task={"relationship":"continue","objective":"Reply with the single word PONG2 via deliver_result.","scope":"trivial probe","material":[],"deliverables":["PONG2"],"acceptance":["result is PONG2"]};' +
					'context="existing";capabilities={"tools":"inherit"}。\n' +
					"4. 再次调用 wait_agent 等待第二个结果,然后用一句中文告诉我两个结果。",
			);

			const messages = session.agent.state.messages;
			expect(toolCallsNamed(messages, "followup_task").some((call) => call.target === "researcher")).toBe(true);
			const mailbox = mailboxEntries(session).join("\n");
			expect(mailbox).toContain("PONG");
			expect(mailbox).toContain("PONG2");
			console.log("[real-subagent] scenario 2 done: followup_task second turn delivered");
		},
		TURN_TIMEOUT_MS,
	);

	it(
		"interrupt_agent stops a running child and list_agents reports the interrupted state",
		async () => {
			const { session } = await realSession();
			await session.prompt(
				"请严格按步骤执行:\n" +
					'1. 调用 spawn_agent:task_name="sleeper";delegation.version=1;' +
					'delegation.task={"relationship":"continue","objective":"用 bash 前台运行命令 sleep 120(把 timeout 参数设为 120),命令完成后用 deliver_result 报告。","scope":"interrupt probe","material":[],"deliverables":["report"],"acceptance":["report delivered"]};' +
					'delegation.context={"mode":"isolated"};delegation.capabilities={"tools":"inherit"}。\n' +
					"2. 调用 wait_agent,把 timeout_ms 设为 3000(只是短暂观察,不会取消子代理)。\n" +
					'3. 无论观察结果如何,调用 interrupt_agent,target="sleeper"。\n' +
					"4. 调用 list_agents,然后用一句中文告诉我 sleeper 的状态。",
			);

			const messages = session.agent.state.messages;
			expect(toolCallsNamed(messages, "interrupt_agent").some((call) => call.target === "sleeper")).toBe(true);
			const listResults = toolResultTexts(session, "list_agents").join("\n");
			expect(listResults).toContain("sleeper");
			expect(listResults).toMatch(/interrupted|closed/);
			console.log("[real-subagent] scenario 3 done: child interrupted, state visible via list_agents");
		},
		TURN_TIMEOUT_MS,
	);

	it(
		"close_agent retires a settled child and keeps its record auditable",
		async () => {
			const { session } = await realSession();
			await session.prompt(
				"请严格按步骤执行:\n" +
					'1. 调用 spawn_agent:task_name="researcher";delegation.version=1;' +
					'delegation.task={"relationship":"continue","objective":"Reply with the single word PONG via deliver_result, then stop.","scope":"trivial probe","material":[],"deliverables":["PONG"],"acceptance":["result is PONG"]};' +
					'delegation.context={"mode":"isolated"};delegation.capabilities={"tools":"inherit"}。\n' +
					"2. 调用 wait_agent 等待完成。\n" +
					'3. 调用 close_agent,target="researcher"。\n' +
					"4. 调用 list_agents,用一句中文告诉我结果。",
			);

			const messages = session.agent.state.messages;
			expect(toolCallsNamed(messages, "close_agent").some((call) => call.target === "researcher")).toBe(true);
			const closeResults = toolResultTexts(session, "close_agent").join("\n");
			expect(closeResults.length).toBeGreaterThan(0);
			console.log("[real-subagent] scenario 4 done: close_agent retired the settled child");
		},
		TURN_TIMEOUT_MS,
	);
});
