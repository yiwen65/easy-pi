/**
 * Explicitly gated 15-session A/B/C tool-profile evaluation.
 *
 * A: complete native compatibility tool set
 * B: current four-tool v2 profile
 * C: full opt-in candidate with journaled mutation and minimal hooks
 *
 * No provider call occurs unless PI_REAL_TOOL_PROFILE_ABC=1. The executor writes no
 * sessions or model/tool content and prints only sanitized metrics and hashes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { NodeJournaledMutationBackend } from "../../src/core/tools/node-journaled-mutation-backend.ts";
import { type EvalExecutionInput, runToolProfileEvaluation, type ToolProfileEvalManifest } from "./runner.ts";
import { createSanitizedToolTraceCollector } from "./trace.ts";

const RUN = process.env.PI_REAL_TOOL_PROFILE_ABC === "1";
if (RUN) configureHttpDispatcher();

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-luna";
const MAX_SESSIONS = 15;
const MAX_REPORTED_COST_USD = Number(process.env.PI_REAL_TOOL_PROFILE_MAX_COST_USD ?? "20");

function manifest(): ToolProfileEvalManifest {
	return JSON.parse(
		readFileSync(join(dirname(fileURLToPath(import.meta.url)), "manifest.json"), "utf8"),
	) as ToolProfileEvalManifest;
}

function testPasses(cwd: string): boolean {
	try {
		execFileSync(process.execPath, ["test.js"], { cwd, stdio: "ignore", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

function resetFixture(cwd: string, seed: number): { prompt: string; targetPath: string; grade: () => boolean } {
	rmSync(cwd, { recursive: true, force: true });
	mkdirSync(join(cwd, "src", "staging"), { recursive: true });
	mkdirSync(join(cwd, "src", "noise"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n');
	for (let index = 0; index < 30; index++) {
		writeFileSync(join(cwd, "src", "noise", `item-${index}.js`), `export const value${index} = ${index};\n`);
	}
	const target = seed * 3 + 7;
	const targetPath = "src/staging/worker.js";
	writeFileSync(join(cwd, targetPath), `export const worker = () => ${seed}; // TARGET_PROFILE_ABC\n`);
	writeFileSync(join(cwd, "src", "config.js"), 'export const label = "old";\n');
	writeFileSync(
		join(cwd, "test.js"),
		`import { worker } from "./src/final/worker.js";\nimport { label } from "./src/config.js";\nif (worker() !== ${target} || label !== "ready-${seed}") process.exit(1);\n`,
	);
	return {
		targetPath,
		prompt: `Locate TARGET_PROFILE_ABC and inspect its file. Move it to src/final/worker.js, change worker() to return ${target}, set src/config.js label to ready-${seed}, and run node test.js. Do not merely explain; finish only after the test passes.`,
		grade: () =>
			!existsSync(join(cwd, "src", "staging", "worker.js")) &&
			existsSync(join(cwd, "src", "final", "worker.js")) &&
			readFileSync(join(cwd, "src", "final", "worker.js"), "utf8").includes(`=> ${target}`) &&
			readFileSync(join(cwd, "src", "config.js"), "utf8").includes(`ready-${seed}`) &&
			testPasses(cwd),
	};
}

describe.skipIf(!RUN)("real tool-profile A/B/C benchmark", () => {
	let benchmarkRoot: string;
	let runtime: ModelRuntime;
	let totalSessions = 0;
	let totalModelTurns = 0;
	let totalReportedCostUsd = 0;

	beforeAll(async () => {
		benchmarkRoot = join(tmpdir(), `pi-real-tool-profile-abc-${Date.now()}`);
		mkdirSync(benchmarkRoot, { recursive: true });
		runtime = await ModelRuntime.create({ credentials: AuthStorage.create(), allowModelNetwork: false });
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`${PROVIDER}/${MODEL_ID} is not in the local model catalog`);
		if (!(await runtime.getAuth(model))) throw new Error(`${PROVIDER}/${MODEL_ID} has no configured credentials`);
	});

	afterAll(() => {
		if (benchmarkRoot) rmSync(benchmarkRoot, { recursive: true, force: true });
	});

	it("runs exactly five fixed seeds for each A/B/C variant", { timeout: 1_800_000 }, async () => {
		const config = manifest();
		expect(config.version).toBe(2);
		expect(config.profiles).toEqual(["A", "B", "C"]);
		expect(config.tasks).toHaveLength(1);
		expect(config.seeds).toEqual([17, 41, 73, 101, 137]);
		expect(config.tasks.length * config.seeds.length * config.profiles.length).toBe(MAX_SESSIONS);
		const cwd = join(benchmarkRoot, "fixture");
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`${PROVIDER}/${MODEL_ID} disappeared from the local model catalog`);

		const execute = async (input: EvalExecutionInput) => {
			if (totalSessions >= MAX_SESSIONS) throw new Error(`Session budget exceeded: ${totalSessions}`);
			totalSessions += 1;
			const fixture = resetFixture(cwd, input.seed);
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: benchmarkRoot,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			const candidateBackend =
				input.variant === "C"
					? new NodeJournaledMutationBackend({
							workspaceRoot: cwd,
							journalRoot: join(benchmarkRoot, "journals", `${input.seed}-${totalSessions}`),
							maxTransactions: 4,
							maxJournalBytes: 4 * 1024 * 1024,
						})
					: undefined;
			const { session } = await createAgentSession({
				cwd,
				agentDir: benchmarkRoot,
				modelRuntime: runtime,
				model,
				thinkingLevel: "max",
				toolProfile: input.variant === "A" ? "legacy" : "v2",
				tools: input.variant === "A" ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : undefined,
				toolsV2:
					input.variant === "C"
						? {
								edit: {
									backend: candidateBackend,
									hooks: { afterCommit: () => {}, afterRollback: () => {} },
								},
							}
						: undefined,
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
			});
			const traceCollector = createSanitizedToolTraceCollector(Date.now, { targetPath: fixture.targetPath });
			const unsubscribe = session.subscribe(traceCollector.handle);
			const startedAt = Date.now();
			const timeout = setTimeout(() => void session.abort(), input.budgets.timeoutMs);
			try {
				expect(session.thinkingLevel).toBe("max");
				await session.prompt(fixture.prompt);
				const stats = session.getSessionStats();
				if (stats.assistantMessages === 0) throw new Error("Systemic evaluation failure: no assistant turn");
				const elapsedMs = Date.now() - startedAt;
				const trace = traceCollector.snapshot();
				totalModelTurns += stats.assistantMessages;
				totalReportedCostUsd += stats.cost;
				if (stats.assistantMessages > input.budgets.maxTurns) {
					throw new Error(
						`${input.task.id}/${input.seed}/${input.variant} exceeded ${input.budgets.maxTurns} turns`,
					);
				}
				if (totalModelTurns > MAX_SESSIONS * input.budgets.maxTurns) {
					throw new Error(`Model-turn budget exceeded: ${totalModelTurns}`);
				}
				if (totalReportedCostUsd > MAX_REPORTED_COST_USD) {
					throw new Error(`Reported cost budget exceeded: ${totalReportedCostUsd.toFixed(6)} USD`);
				}
				const success = fixture.grade();
				console.log(
					JSON.stringify({
						eval: "real-tool-profile-abc-call",
						variant: input.variant,
						seed: input.seed,
						success,
						turns: stats.assistantMessages,
						inputTokens: stats.tokens.input,
						outputTokens: stats.tokens.output,
						cacheReadTokens: stats.tokens.cacheRead,
						cacheWriteTokens: stats.tokens.cacheWrite,
						costUsd: Number(stats.cost.toFixed(6)),
						elapsedMs,
						modelElapsedMs: Math.max(0, elapsedMs - trace.toolElapsedMs),
						trace,
					}),
				);
				return {
					success,
					score: success ? 1 : 0,
					turns: stats.assistantMessages,
					inputTokens: stats.tokens.input,
					outputTokens: stats.tokens.output,
					cacheReadTokens: stats.tokens.cacheRead,
					cacheWriteTokens: stats.tokens.cacheWrite,
					costUsd: stats.cost,
					elapsedMs,
					modelElapsedMs: Math.max(0, elapsedMs - trace.toolElapsedMs),
					trace,
					systemPrompt: session.systemPrompt,
					tools: session.getAllTools().map(({ name, description, parameters }) => ({
						name,
						description,
						parameters,
					})),
				};
			} finally {
				clearTimeout(timeout);
				unsubscribe();
				session.dispose();
				await candidateBackend?.close();
			}
		};

		const summary = await runToolProfileEvaluation(config, execute);
		expect(summary.records).toHaveLength(MAX_SESSIONS);
		expect(totalSessions).toBe(MAX_SESSIONS);
		for (const variant of ["A", "B", "C"] as const) expect(summary.variants[variant].runs).toBe(5);
		expect(
			new Set(summary.records.filter((record) => record.variant === "A").map((record) => record.schemaHash)),
		).toHaveLength(1);
		expect(
			new Set(summary.records.filter((record) => record.variant === "B").map((record) => record.schemaHash)),
		).toHaveLength(1);
		expect(
			new Set(summary.records.filter((record) => record.variant === "C").map((record) => record.schemaHash)),
		).toHaveLength(1);
		console.log(
			JSON.stringify({ eval: "real-tool-profile-abc-summary", provider: PROVIDER, model: MODEL_ID, summary }),
		);
	});
});
