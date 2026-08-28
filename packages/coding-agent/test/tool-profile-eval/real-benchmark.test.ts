/**
 * Manual real-provider benchmark for legacy versus v2 tool profiles.
 *
 * No provider call occurs unless PI_REAL_TOOL_PROFILE_BENCHMARK=1 or the
 * narrower PI_REAL_TOOL_PROFILE_DIAGNOSTIC=1 is explicit. The benchmark
 * persists neither sessions nor model responses and prints only content-free metrics.
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
import { type EvalExecutionInput, runToolProfileEvaluation, type ToolProfileEvalManifest } from "./runner.ts";
import { createSanitizedToolTraceCollector } from "./trace.ts";

const RUN = process.env.PI_REAL_TOOL_PROFILE_BENCHMARK === "1";
const RUN_DIAGNOSTIC = process.env.PI_REAL_TOOL_PROFILE_DIAGNOSTIC === "1";
if (RUN && RUN_DIAGNOSTIC) throw new Error("Select either benchmark or diagnostic mode, not both");
if (RUN || RUN_DIAGNOSTIC) configureHttpDispatcher();

const PROVIDER = process.env.PI_REAL_TOOL_PROFILE_PROVIDER ?? "openai-codex";
const MODEL_ID = process.env.PI_REAL_TOOL_PROFILE_MODEL ?? "gpt-5.6-luna";
const MAX_SESSIONS = 20;
const MAX_REPORTED_COST_USD = Number(process.env.PI_REAL_TOOL_PROFILE_MAX_COST_USD ?? "20");

function manifest(): ToolProfileEvalManifest {
	return JSON.parse(
		readFileSync(join(dirname(fileURLToPath(import.meta.url)), "manifest.json"), "utf8"),
	) as ToolProfileEvalManifest;
}

function writeCommonFixture(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n');
	writeFileSync(join(cwd, "src", "noise-a.js"), "export const alpha = 7;\n");
	writeFileSync(join(cwd, "src", "noise-b.js"), "export const beta = 11;\n");
}

function resetFixture(cwd: string, taskId: string, seed: number): { prompt: string; grade: () => boolean } {
	rmSync(cwd, { recursive: true, force: true });
	writeCommonFixture(cwd);
	if (taskId === "locate-edit-test") {
		const target = seed + 1000;
		writeFileSync(join(cwd, "src", "value.js"), `export const answer = ${seed}; // TARGET_PROFILE_VALUE\n`);
		writeFileSync(
			join(cwd, "test.js"),
			`import { answer } from "./src/value.js";\nif (answer !== ${target}) process.exit(1);\nconsole.log("PASS");\n`,
		);
		return {
			prompt: `Locate the file containing TARGET_PROFILE_VALUE, change the exported answer to ${target}, and run node test.js. Do not merely explain; finish only after the test passes.`,
			grade: () =>
				readFileSync(join(cwd, "src", "value.js"), "utf8").includes(`answer = ${target}`) && testPasses(cwd),
		};
	}
	if (taskId === "move-edit-test") {
		const target = seed * 2;
		mkdirSync(join(cwd, "src", "staging"), { recursive: true });
		writeFileSync(
			join(cwd, "src", "staging", "worker.js"),
			`export const worker = () => ${seed}; // TARGET_PROFILE_MOVE\n`,
		);
		writeFileSync(
			join(cwd, "test.js"),
			`import { worker } from "./src/final/worker.js";\nif (worker() !== ${target}) process.exit(1);\nconsole.log("PASS");\n`,
		);
		return {
			prompt: `Locate the file containing TARGET_PROFILE_MOVE, move it to src/final/worker.js, change worker() to return ${target}, and run node test.js. Do not merely explain; finish only after the test passes.`,
			grade: () =>
				!existsSync(join(cwd, "src", "staging", "worker.js")) &&
				readFileSync(join(cwd, "src", "final", "worker.js"), "utf8").includes(`=> ${target}`) &&
				testPasses(cwd),
		};
	}
	throw new Error(`Unknown benchmark task: ${taskId}`);
}

function testPasses(cwd: string): boolean {
	try {
		execFileSync(process.execPath, ["test.js"], { cwd, stdio: "ignore", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!RUN && !RUN_DIAGNOSTIC)("real tool-profile five-seed benchmark", () => {
	let benchmarkRoot: string;
	let runtime: ModelRuntime;
	let totalSessions = 0;
	let totalModelTurns = 0;
	let totalReportedCostUsd = 0;

	beforeAll(async () => {
		benchmarkRoot = join(tmpdir(), `pi-real-tool-profile-benchmark-${Date.now()}`);
		mkdirSync(benchmarkRoot, { recursive: true });
		runtime = await ModelRuntime.create({ credentials: AuthStorage.create(), allowModelNetwork: false });
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`${PROVIDER}/${MODEL_ID} is not in the local model catalog`);
		if (!(await runtime.getAuth(model))) throw new Error(`${PROVIDER}/${MODEL_ID} has no configured credentials`);
	});

	afterAll(() => {
		if (benchmarkRoot) rmSync(benchmarkRoot, { recursive: true, force: true });
	});

	it("runs the bounded benchmark or v2 move diagnostic", { timeout: 1_800_000 }, async () => {
		const config = manifest();
		expect(config.tasks.map((task) => task.id)).toEqual(["locate-edit-test", "move-edit-test"]);
		expect(config.seeds).toHaveLength(5);
		expect(config.tasks.length * config.seeds.length * config.profiles.length).toBe(MAX_SESSIONS);
		const sessionLimit = RUN_DIAGNOSTIC ? config.seeds.length : MAX_SESSIONS;
		const budgets = RUN_DIAGNOSTIC ? { ...config.budgets, maxTurns: 12 } : config.budgets;
		const maxModelTurns = sessionLimit * budgets.maxTurns;
		const cwd = join(benchmarkRoot, "fixture");
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`${PROVIDER}/${MODEL_ID} disappeared from the local model catalog`);

		const execute = async (input: EvalExecutionInput) => {
			if (totalSessions >= sessionLimit) throw new Error(`Session budget exceeded: ${totalSessions}`);
			totalSessions += 1;
			const fixture = resetFixture(cwd, input.task.id, input.seed);
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
			const { session } = await createAgentSession({
				cwd,
				agentDir: benchmarkRoot,
				modelRuntime: runtime,
				model,
				thinkingLevel: "max",
				toolProfile: input.profile,
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
			});
			const traceCollector = createSanitizedToolTraceCollector();
			const unsubscribe = session.subscribe(traceCollector.handle);
			const startedAt = Date.now();
			const timeout = setTimeout(() => void session.abort(), input.budgets.timeoutMs);
			try {
				expect(session.thinkingLevel).toBe("max");
				await session.prompt(fixture.prompt);
				const stats = session.getSessionStats();
				const elapsedMs = Date.now() - startedAt;
				const trace = traceCollector.snapshot();
				const modelElapsedMs = Math.max(0, elapsedMs - trace.toolElapsedMs);
				totalModelTurns += stats.assistantMessages;
				totalReportedCostUsd += stats.cost;
				if (stats.assistantMessages > input.budgets.maxTurns) {
					throw new Error(
						`${input.task.id}/${input.seed}/${input.profile} used ${stats.assistantMessages} model turns, exceeding ${input.budgets.maxTurns}`,
					);
				}
				if (totalModelTurns > maxModelTurns) throw new Error(`Model-turn budget exceeded: ${totalModelTurns}`);
				if (totalReportedCostUsd > MAX_REPORTED_COST_USD) {
					throw new Error(`Reported cost budget exceeded: ${totalReportedCostUsd.toFixed(6)} USD`);
				}
				const success = fixture.grade();
				console.log(
					JSON.stringify({
						eval: "real-tool-profile-call",
						taskId: input.task.id,
						seed: input.seed,
						profile: input.profile,
						success,
						turns: stats.assistantMessages,
						inputTokens: stats.tokens.input,
						outputTokens: stats.tokens.output,
						cacheReadTokens: stats.tokens.cacheRead,
						cacheWriteTokens: stats.tokens.cacheWrite,
						costUsd: Number(stats.cost.toFixed(6)),
						elapsedMs,
						modelElapsedMs,
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
					modelElapsedMs,
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
			}
		};

		if (RUN_DIAGNOSTIC) {
			const task = config.tasks.find((candidate) => candidate.id === "move-edit-test");
			if (!task) throw new Error("move-edit-test is missing from the manifest");
			const records: Awaited<ReturnType<typeof execute>>[] = [];
			for (const seed of config.seeds) {
				records.push(await execute({ task, seed, profile: "v2", budgets }));
			}
			expect(records).toHaveLength(config.seeds.length);
			expect(totalSessions).toBe(sessionLimit);
			console.log(
				JSON.stringify({
					eval: "real-tool-profile-v2-move-diagnostic",
					provider: PROVIDER,
					model: MODEL_ID,
					records: records.map(({ systemPrompt: _systemPrompt, tools: _tools, ...record }) => record),
				}),
			);
			return;
		}

		const summary = await runToolProfileEvaluation(config, execute);
		expect(summary.records).toHaveLength(MAX_SESSIONS);
		expect(totalSessions).toBe(MAX_SESSIONS);
		console.log(JSON.stringify({ eval: "real-tool-profile-summary", provider: PROVIDER, model: MODEL_ID, summary }));
	});
});
