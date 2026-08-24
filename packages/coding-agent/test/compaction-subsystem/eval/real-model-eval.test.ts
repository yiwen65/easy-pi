/**
 * T-105: real-model evaluation for the compaction subsystem.
 *
 * MANUAL ONLY. Never runs in CI/test.sh: the whole file is skipped unless
 * PI_REAL_MODEL_EVAL=1 is set. This is the approved real-API pattern per
 * AGENTS.md (real providers only with explicit user approval). Uses the pi
 * auth store's kimi-coding K3 credentials (or KIMI_API_KEY) via the
 * production ModelRuntime/AuthStorage resolution path. No credentials are
 * printed.
 *
 * Run explicitly:
 *   PI_REAL_MODEL_EVAL=1 node ../../node_modules/vitest/dist/cli.js --run \
 *     test/compaction-subsystem/eval/real-model-eval.test.ts --silent=false
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createPiAiCompleteFn } from "../../../src/core/compaction/subsystem/session-integration.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../../../src/core/session-manager.ts";
import type { EvalReport } from "./atoms.ts";
import { withCache } from "./batch-runner.ts";
import { convertSessionToFixture, takeClosedSessionPrefix } from "./corpus-converter.ts";
import { codingFixture, toolHeavyFixture } from "./fixtures.ts";
import { runEval } from "./runner.ts";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1";
const TIMEOUT = 300_000;

async function kimiComplete() {
	const credentials = AuthStorage.create();
	const runtime = await ModelRuntime.create({ credentials, allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	const model = registry.find("kimi-coding", "k3");
	if (!model) throw new Error("kimi-coding/k3 not in catalog");
	const resolution = await runtime.getAuth(model);
	if (!resolution) throw new Error("No kimi-coding credentials in pi auth store (and no KIMI_API_KEY)");
	const headers = resolution.auth.headers
		? Object.fromEntries(Object.entries(resolution.auth.headers).filter((e): e is [string, string] => e[1] !== null))
		: undefined;
	const requestModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
	return createPiAiCompleteFn({
		model: requestModel,
		apiKey: resolution.auth.apiKey,
		headers,
		env: resolution.env as Record<string, string> | undefined,
		retry: { enabled: true, maxRetries: 4, baseDelayMs: 5000 }, // K3 rate limits observed (429)
	});
}

function printReport(report: EvalReport): void {
	console.log(`\n=== ${report.fixture} (${report.compactionRounds} rounds) ===`);
	console.log(`overall retention: ${(report.overallRetention * 100).toFixed(1)}%`);
	console.log(`retention by kind: ${JSON.stringify(report.retentionByKind)}`);
	console.log(`oracle consistent: ${report.oracleConsistent}`);
	console.log(`tokens: before-first=${report.tokensBeforeFirst} after-last=${report.tokensAfterLast}`);
	console.log(
		`rounds activated/rejected: ${report.roundsActivated}/${report.roundsRejected}${report.rejectReasons.length ? ` reasons: ${report.rejectReasons.join("; ")}` : ""}`,
	);
	for (const atom of report.atoms.filter((a) => !a.passed)) {
		console.log(`  MISS ${atom.atomId} (${atom.kind}): ${atom.detail}`);
	}
}

/** Real long-task corpus: prefix of the recorded pi-mono session (1019 entries, ~253k tokens full). */
function largeSessionFixture(entries: number, name: string) {
	const raw = readFileSync(join(__dirname, "../../fixtures/large-session.jsonl"), "utf-8");
	const parsed = parseSessionEntries(raw);
	migrateSessionEntries(parsed);
	const sliced = takeClosedSessionPrefix(
		parsed.filter((e): e is SessionEntry => e.type !== "session"),
		entries,
	);
	return convertSessionToFixture(sliced, {
		name,
		constraints: ["Never lose user requirements", "Preserve exact file paths and error messages"],
		compactionRounds: 2,
	});
}

describe.skipIf(!RUN)("T-105 real-model eval (kimi-coding k3)", () => {
	it(
		"real long-task corpus: recorded pi-mono session prefix (100 entries, ~59k tokens)",
		{ timeout: 900_000 },
		async () => {
			const complete = await kimiComplete();
			const cached = withCache(complete, {
				cacheDir: join(process.env.PI_EVAL_CACHE_DIR ?? "/tmp", "hf-eval-cache"),
				modelId: "kimi-coding/k3",
			});
			const fixture = largeSessionFixture(100, "pi-mono-large-100");
			const report = await runEval(fixture, cached);
			printReport(report);
			expect(report.roundsActivated).toBeGreaterThan(0);
			expect(report.retentionByKind.C).toBe(1);
			expect(report.retentionByKind.T).toBe(1);
			expect(report.retentionByKind.P).toBe(1);
			expect(report.oracleConsistent).toBe(true);
			expect(report.atoms.filter((a) => !a.passed && a.kind === "F")).toEqual([]);
		},
	);

	it("coding fixture with real extraction", { timeout: TIMEOUT }, async () => {
		const complete = await kimiComplete();
		const report = await runEval(codingFixture, complete);
		printReport(report);
		// Hard gates (任务书 §3.1): constraints 100%, tool/task state exact, provenance resolvable.
		expect(report.retentionByKind.C).toBe(1);
		expect(report.retentionByKind.T).toBe(1);
		expect(report.retentionByKind.S).toBe(1);
		expect(report.retentionByKind.P).toBe(1);
		expect(report.oracleConsistent).toBe(true);
	});

	it("tool-heavy fixture with real extraction", { timeout: TIMEOUT }, async () => {
		const complete = await kimiComplete();
		const report = await runEval(toolHeavyFixture, complete);
		printReport(report);
		expect(report.retentionByKind.C).toBe(1);
		expect(report.retentionByKind.T).toBe(1);
		expect(report.oracleConsistent).toBe(true);
	});

	it("coding fixture, 4 compaction rounds (drift)", { timeout: TIMEOUT }, async () => {
		const complete = await kimiComplete();
		const report = await runEval({ ...codingFixture, compactionRounds: 4, name: "coding-drift-4" }, complete);
		printReport(report);
		expect(report.retentionByKind.C).toBe(1);
		expect(report.retentionByKind.P).toBe(1);
		expect(report.oracleConsistent).toBe(true);
	});

	it("real long-task corpus: 4-round drift on recorded session", { timeout: 900_000 }, async () => {
		const complete = await kimiComplete();
		const cached = withCache(complete, {
			cacheDir: join(process.env.PI_EVAL_CACHE_DIR ?? "/tmp", "hf-eval-cache"),
			modelId: "kimi-coding/k3",
		});
		const fixture = { ...largeSessionFixture(100, "pi-mono-large-100-drift"), compactionRounds: 4 };
		const report = await runEval(fixture, cached);
		printReport(report);
		expect(report.roundsActivated).toBeGreaterThan(0);
		expect(report.retentionByKind.C).toBe(1);
		expect(report.retentionByKind.P).toBe(1);
		expect(report.oracleConsistent).toBe(true);
	});

	it(
		"full-scale soak: complete recorded session (1018 entries, ~156k tokens), 4 rounds",
		{ timeout: 1_800_000 },
		async () => {
			const complete = await kimiComplete();
			const cached = withCache(complete, {
				cacheDir: join(process.env.PI_EVAL_CACHE_DIR ?? "/tmp", "hf-eval-cache"),
				modelId: "kimi-coding/k3",
			});
			const raw = readFileSync(join(__dirname, "../../fixtures/large-session.jsonl"), "utf-8");
			const parsed = parseSessionEntries(raw);
			migrateSessionEntries(parsed);
			const all = parsed.filter((e): e is SessionEntry => e.type !== "session");
			const fixture = convertSessionToFixture(all, {
				name: "pi-mono-large-full",
				constraints: ["Never lose user requirements", "Preserve exact file paths and error messages"],
				compactionRounds: 4,
			});
			const report = await runEval(fixture, cached);
			printReport(report);
			expect(report.roundsActivated).toBeGreaterThan(0);
			expect(report.retentionByKind.C).toBe(1);
			expect(report.retentionByKind.T).toBe(1);
			expect(report.retentionByKind.P).toBe(1);
			expect(report.oracleConsistent).toBe(true);
		},
	);
});
