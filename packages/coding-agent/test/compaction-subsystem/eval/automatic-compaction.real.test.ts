/**
 * Manual real-provider validation for automatic compaction and token calibration.
 *
 * Reproduces the failures found in real-provider runs:
 * - the 95% trigger used to sit beyond the point where a compaction request still fits, because the
 *   compaction request reserved the main response budget (16,384 tokens) as its own output space;
 * - reported token sizes used to be raw `chars/4` estimates, 2.0-2.4x below the provider's own
 *   count for CJK and digit-dense content, so `/context`, the audit trail and the compaction banner
 *   disagreed with the provider;
 * - the summary-proportionality gate used to reject concise handoffs for bulk histories, which left
 *   the session uncompactable and eventually blocked it.
 *
 * Never calls a provider unless PI_REAL_MODEL_EVAL=1 is set explicitly. Uses the production
 * ModelRuntime/AuthStorage path with real credentials, a fresh temp cwd for each scenario, and a
 * `noExtensions` resource loader, so user state and user extensions stay untouched. Assertions
 * target session state and measured provider usage, never exact model wording.
 *
 * Run explicitly (bulk ~3-5 min, documents ~5-10 min; add -t to pick one):
 *   PI_REAL_MODEL_EVAL=1 npx vitest --run test/compaction-subsystem/eval/automatic-compaction.real.test.ts --silent=false
 *   PI_REAL_MODEL_EVAL=1 npx vitest --run test/compaction-subsystem/eval/automatic-compaction.real.test.ts --silent=false -t bulk
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { estimateTokens } from "../../../src/core/compaction/index.ts";
import { configureHttpDispatcher } from "../../../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1";
if (RUN) {
	delete process.env.PI_OFFLINE;
	configureHttpDispatcher();
}

const PROVIDER = process.env.PI_REAL_COMPACTION_PROVIDER ?? "openai-codex";
const MODEL_ID = process.env.PI_REAL_COMPACTION_MODEL ?? "gpt-5.6-luna";
const REAL_AGENT_DIR = process.env.PI_AGENT_DIR ?? join(homedir(), ".epi", "agent");
/** Activate compaction a little before the provider window is actually full. */
const FILL_TARGET_FRACTION = 0.968;
const MAX_FILLS = 60;
const SCENARIO_TIMEOUT_MS = 1_800_000;

/** Deterministic, distinct specification document: ~120 numbered constraints (~4.7k provider tokens). */
function specDoc(n: number): string {
	const lines = [`# 规范 D${n}`, "负责人: 老王"];
	for (let i = 1; i <= 120; i++) {
		lines.push(
			`关键约束 D${n}.${i}: 组件 svc-${n}-${i % 37} 参数必须为 ${100 + ((n * 131 + i * 17) % 900)}；检查 ${(i % 7) + 1} 分钟；级别 P${(i % 4) + 1}；工单 OPS-${n}${String(i).padStart(3, "0")}。`,
		);
	}
	return lines.join("\n");
}

interface ScenarioResult {
	fills: number;
	compactionReason?: string;
	tokensBefore?: number;
	estimatedTokensAfter?: number;
	/** Provider's own prompt measurement immediately before the compaction. */
	providerPromptBefore?: number;
	/** Raw chars/4 estimate of the history at the same moment. */
	localCharsBefore?: number;
	/** Provider prompt of the first request after the checkpoint. */
	providerPromptAfter?: number;
	finalAnswer: string;
}

async function runScenario(mode: "bulk" | "docs"): Promise<ScenarioResult> {
	const cwd = mkdtempSync(join(tmpdir(), `pi-compaction-real-${mode}-`));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(REAL_AGENT_DIR, "auth.json"),
			modelsPath: join(REAL_AGENT_DIR, "models.json"),
		});
		const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`Real provider model not available: ${PROVIDER}/${MODEL_ID}`);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model,
			thinkingLevel: "max",
			tools: ["read", "bash", "write", "edit"],
			resourceLoader,
			sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
			settingsManager,
		});

		const usages: Array<{ prompt: number }> = [];
		const result: ScenarioResult = { fills: 0, finalAnswer: "" };
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const usage = event.message.usage;
				if (usage) usages.push({ prompt: usage.input + usage.cacheRead + usage.cacheWrite });
			}
			if (event.type === "compaction_start") {
				result.providerPromptBefore = usages[usages.length - 1]?.prompt;
				result.localCharsBefore = session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
			}
			if (event.type === "compaction_end" && event.result) {
				result.compactionReason = event.reason;
				result.tokensBefore = event.result.tokensBefore;
				result.estimatedTokensAfter = event.result.estimatedTokensAfter;
			}
		});
		const providerPrompt = (): number => usages[usages.length - 1]?.prompt ?? 0;
		const ask = async (text: string): Promise<void> => {
			await session.prompt(text);
			await session.waitForIdle();
		};

		try {
			const target = Math.floor(model.contextWindow * FILL_TARGET_FRACTION);
			while (providerPrompt() < target && result.fills < MAX_FILLS && result.tokensBefore === undefined) {
				result.fills++;
				if (mode === "bulk") {
					// Digit-dense tool output: the content class that defeated chars/4 estimation.
					const commands = [1, 2].map((i) => `seq 1 400 | sed 's/^/REAL${result.fills}c${i} row=/'`).join(" ; ");
					await ask(`并行运行以下 2 条 bash 命令（一条消息里 2 个工具调用），只回复每条的输出行数：\n${commands}`);
				} else {
					await ask(`粘贴规范文档 D${result.fills}（只回复条数）：\n\n${specDoc(result.fills)}`);
				}
			}

			// One more request crosses the threshold if the last fill stopped just below it.
			if (result.tokensBefore === undefined) await ask("用一行说明你现在的状态和长期规则。");
			await ask("继续：用一行说明你现在的状态。");
			result.providerPromptAfter = providerPrompt();
			const last = session.messages[session.messages.length - 1];
			result.finalAnswer = last?.role === "assistant" ? JSON.stringify(last.content).slice(0, 400) : "";
			return result;
		} finally {
			session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe.skipIf(!RUN)("real-provider automatic compaction", () => {
	it(
		"bulk history: threshold compaction activates and reports provider-scale sizes",
		async () => {
			const result = await runScenario("bulk");
			expect(result.tokensBefore, `no checkpoint activated within ${result.fills} fills`).toBeDefined();
			expect(result.compactionReason).toBe("threshold");
			expect(result.providerPromptBefore).toBeGreaterThan(0);
			expect(result.localCharsBefore).toBeGreaterThan(0);

			// The reported size must be calibrated against the provider measurement, not raw chars/4.
			expect(result.tokensBefore!).toBeGreaterThan(1.4 * result.localCharsBefore!);
			const providerAgreement = result.tokensBefore! / result.providerPromptBefore!;
			expect(providerAgreement).toBeGreaterThan(0.8);
			expect(providerAgreement).toBeLessThan(1.6);

			// The checkpoint must actually shrink the next provider request and keep the session usable.
			expect(result.providerPromptAfter!).toBeLessThan(0.2 * result.providerPromptBefore!);
			expect(result.finalAnswer.length).toBeGreaterThan(0);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"document-dense history: threshold compaction activates before the window is exceeded",
		async () => {
			const result = await runScenario("docs");
			expect(result.tokensBefore, `no checkpoint activated within ${result.fills} fills`).toBeDefined();
			expect(result.compactionReason).toBe("threshold");
			expect(result.tokensBefore!).toBeGreaterThan(1.4 * result.localCharsBefore!);
			expect(result.providerPromptAfter!).toBeLessThan(0.2 * result.providerPromptBefore!);
			expect(result.finalAnswer.length).toBeGreaterThan(0);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
