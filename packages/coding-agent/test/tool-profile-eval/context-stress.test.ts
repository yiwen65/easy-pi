/** Manual held-out context-stress validation. No provider call occurs without explicit opt-in. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createV2ToolDefinitions } from "../../src/core/tools/tool-profile.ts";
import { type PromptVariant, runPromptAblation } from "./prompt-ablation.ts";
import type { ToolProfileEvalManifest } from "./runner.ts";
import { createSanitizedToolTraceCollector } from "./trace.ts";

const RUN = process.env.PI_REAL_TOOL_PROFILE_CONTEXT_STRESS === "1";
if (RUN) configureHttpDispatcher();

const PROVIDER = process.env.PI_REAL_TOOL_PROFILE_PROVIDER ?? "openai-codex";
const MODEL_ID = process.env.PI_REAL_TOOL_PROFILE_MODEL ?? "gpt-5.6-luna";
const MAX_SESSIONS = 20;
const MAX_REPORTED_COST_USD = Number(process.env.PI_REAL_TOOL_PROFILE_MAX_COST_USD ?? "20");

const manifest: ToolProfileEvalManifest = {
	version: 2,
	profiles: ["A", "B", "C"],
	seeds: [211, 307],
	budgets: { maxTurns: 18, timeoutMs: 180_000 },
	tasks: [
		{ id: "large-directory-discovery", prompt: "held out" },
		{ id: "large-file-bounded-read", prompt: "held out" },
		{ id: "long-output-truncation", prompt: "held out" },
		{ id: "ambiguous-edit-recovery", prompt: "held out" },
		{ id: "multi-file-operation", prompt: "held out" },
	],
	bootstrapSamples: 100,
};

function writeCommonFixture(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n');
}

function testPasses(cwd: string): boolean {
	try {
		execFileSync(process.execPath, ["test.js"], { cwd, stdio: "ignore", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

function resetFixture(cwd: string, taskId: string, seed: number): { prompt: string; grade: () => boolean } {
	rmSync(cwd, { recursive: true, force: true });
	writeCommonFixture(cwd);
	if (taskId === "large-directory-discovery") {
		const directory = `group-${seed % 40}`;
		for (let group = 0; group < 40; group++) {
			mkdirSync(join(cwd, "src", `group-${group}`), { recursive: true });
			for (let file = 0; file < 10; file++) {
				writeFileSync(
					join(cwd, "src", `group-${group}`, `item-${file}.js`),
					`export const value = ${group + file};\n`,
				);
			}
		}
		const targetPath = join(cwd, "src", directory, "target.js");
		writeFileSync(targetPath, `export const answer = ${seed}; // TARGET_STRESS_DIRECTORY\n`);
		writeFileSync(
			join(cwd, "test.js"),
			`import { answer } from "./src/${directory}/target.js";\nif (answer !== ${seed + 1}) process.exit(1);\n`,
		);
		return {
			prompt: `In this large workspace, locate TARGET_STRESS_DIRECTORY, change its exported answer to ${seed + 1}, and run node test.js.`,
			grade: () => readFileSync(targetPath, "utf8").includes(`answer = ${seed + 1}`) && testPasses(cwd),
		};
	}
	if (taskId === "large-file-bounded-read") {
		const target = seed + 2;
		const lines = Array.from({ length: 2_500 }, (_, index) => `// filler line ${index + 1}`);
		lines[1_799] = `export const answer = ${seed}; // TARGET_STRESS_LARGE_FILE`;
		writeFileSync(join(cwd, "src", "large.js"), `${lines.join("\n")}\n`);
		writeFileSync(
			join(cwd, "test.js"),
			`import { answer } from "./src/large.js";\nif (answer !== ${target}) process.exit(1);\n`,
		);
		return {
			prompt: `Locate TARGET_STRESS_LARGE_FILE inside the large source file, change answer to ${target}, and run node test.js.`,
			grade: () =>
				readFileSync(join(cwd, "src", "large.js"), "utf8").includes(`answer = ${target}`) && testPasses(cwd),
		};
	}
	if (taskId === "long-output-truncation") {
		writeFileSync(join(cwd, "src", "config.js"), "export const enabled = false; // TARGET_STRESS_LONG_OUTPUT\n");
		writeFileSync(
			join(cwd, "diagnose.js"),
			'import { writeFileSync } from "node:fs";\nwriteFileSync(".diagnosed", "yes");\nfor (let i = 0; i < 7000; i++) console.log("diagnostic-noise-" + i.toString().padStart(5, "0") + "-xxxxxxxxxxxxxxxx");\nconsole.log("TARGET_STRESS_LONG_OUTPUT");\n',
		);
		writeFileSync(
			join(cwd, "test.js"),
			'import { existsSync } from "node:fs";\nimport { enabled } from "./src/config.js";\nif (!existsSync(".diagnosed") || !enabled) process.exit(1);\n',
		);
		return {
			prompt:
				"Run node diagnose.js first and handle its long output. Then locate TARGET_STRESS_LONG_OUTPUT, enable the config, and run node test.js.",
			grade: () =>
				existsSync(join(cwd, ".diagnosed")) &&
				readFileSync(join(cwd, "src", "config.js"), "utf8").includes("enabled = true") &&
				testPasses(cwd),
		};
	}
	if (taskId === "ambiguous-edit-recovery") {
		const target = seed + 3;
		writeFileSync(
			join(cwd, "src", "ambiguous.js"),
			`export function alpha() { return ${seed}; }\nexport function beta() { // TARGET_STRESS_AMBIGUOUS\n  return ${seed};\n}\n`,
		);
		writeFileSync(
			join(cwd, "test.js"),
			`import { alpha, beta } from "./src/ambiguous.js";\nif (alpha() !== ${seed} || beta() !== ${target}) process.exit(1);\n`,
		);
		return {
			prompt: `Locate TARGET_STRESS_AMBIGUOUS, change only beta() to return ${target}, preserve alpha(), and run node test.js.`,
			grade: () => testPasses(cwd),
		};
	}
	if (taskId === "multi-file-operation") {
		const target = seed + 4;
		mkdirSync(join(cwd, "src", "staging"), { recursive: true });
		writeFileSync(
			join(cwd, "src", "staging", "worker.js"),
			`export const worker = () => ${seed}; // TARGET_STRESS_MULTI_FILE\n`,
		);
		writeFileSync(join(cwd, "src", "index.js"), 'export { worker } from "./staging/worker.js";\n');
		writeFileSync(join(cwd, "src", "config.js"), 'export const label = "old";\n');
		writeFileSync(
			join(cwd, "test.js"),
			`import { worker } from "./src/index.js";\nimport { label } from "./src/config.js";\nif (worker() !== ${target} || label !== "ready-${seed}") process.exit(1);\n`,
		);
		return {
			prompt: `Locate TARGET_STRESS_MULTI_FILE, move its file to src/final/worker.js and update it to return ${target}; also update all imports and set the config label to ready-${seed}. Run node test.js.`,
			grade: () =>
				!existsSync(join(cwd, "src", "staging", "worker.js")) &&
				existsSync(join(cwd, "src", "final", "worker.js")) &&
				testPasses(cwd),
		};
	}
	throw new Error(`Unknown context-stress task: ${taskId}`);
}

function promptVariantTools(cwd: string, variant: PromptVariant) {
	const definitions = createV2ToolDefinitions(cwd);
	if (variant === "control") {
		definitions.edit.promptGuidelines = [
			"Use edit for file mutations; make exact updates from freshly read content.",
		];
	}
	return Object.values(definitions);
}

describe.skipIf(!RUN)("held-out tool-profile context stress", () => {
	let benchmarkRoot: string;
	let runtime: ModelRuntime;
	let totalSessions = 0;
	let totalModelTurns = 0;
	let totalReportedCostUsd = 0;

	beforeAll(async () => {
		benchmarkRoot = join(tmpdir(), `pi-tool-profile-context-stress-${Date.now()}`);
		mkdirSync(benchmarkRoot, { recursive: true });
		runtime = await ModelRuntime.create({ credentials: AuthStorage.create(), allowModelNetwork: false });
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`${PROVIDER}/${MODEL_ID} is not in the local model catalog`);
		if (!(await runtime.getAuth(model))) throw new Error(`${PROVIDER}/${MODEL_ID} has no configured credentials`);
	});

	afterAll(() => {
		if (benchmarkRoot) rmSync(benchmarkRoot, { recursive: true, force: true });
	});

	it("compares control and candidate across five held-out layers", { timeout: 1_800_000 }, async () => {
		const cwd = join(benchmarkRoot, "fixture");
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`${PROVIDER}/${MODEL_ID} disappeared from the local model catalog`);
		const summary = await runPromptAblation(manifest, async (input) => {
			if (totalSessions >= MAX_SESSIONS) throw new Error(`Session budget exceeded: ${totalSessions}`);
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
				toolProfile: "v2",
				customTools: promptVariantTools(cwd, input.variant),
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
			});
			const traceCollector = createSanitizedToolTraceCollector();
			const unsubscribe = session.subscribe(traceCollector.handle);
			const startedAt = Date.now();
			const timeout = setTimeout(() => void session.abort(), input.budgets.timeoutMs);
			try {
				await session.prompt(fixture.prompt);
				const stats = session.getSessionStats();
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
						eval: "tool-profile-context-stress-call",
						taskId: input.task.id,
						seed: input.seed,
						variant: input.variant,
						success,
						turns: stats.assistantMessages,
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
			}
		});

		expect(summary.records).toHaveLength(MAX_SESSIONS);
		expect(totalSessions).toBe(MAX_SESSIONS);
		expect(summary.variants.control.successes).toBe(MAX_SESSIONS / 2);
		expect(summary.variants.candidate.successes).toBe(MAX_SESSIONS / 2);
		for (const variant of ["control", "candidate"] as const) {
			const longOutput = summary.records.filter(
				(record) => record.variant === variant && record.taskId === "long-output-truncation",
			);
			expect(longOutput.every((record) => (record.trace?.truncationCount ?? 0) > 0)).toBe(true);
		}
		console.log(
			JSON.stringify({ eval: "tool-profile-context-stress-summary", provider: PROVIDER, model: MODEL_ID, summary }),
		);
	});
});
