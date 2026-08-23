/**
 * T-304: cross-model real-provider evaluation for the compaction subsystem.
 *
 * MANUAL ONLY. Never runs in CI/test.sh: the whole file is skipped unless
 * PI_MULTI_MODEL_EVAL=1 is set. Real providers require explicit user approval.
 * Credentials are resolved through AuthStorage and are never printed.
 *
 * Run one or more models explicitly:
 *   PI_MULTI_MODEL_EVAL=1 \
 *   PI_MULTI_MODEL_MODELS=openai-codex/gpt-5.4-mini,openai-codex/gpt-5.4 \
 *   node ../../node_modules/vitest/dist/cli.js --run \
 *     test/compaction-subsystem/eval/multi-model-real-eval.test.ts --silent=false
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createPiAiCompleteFn } from "../../../src/core/compaction/subsystem/session-integration.ts";
import { configureHttpDispatcher } from "../../../src/core/http-dispatcher.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../../../src/core/session-manager.ts";
import type { EvalReport } from "./atoms.ts";
import { withCache } from "./batch-runner.ts";
import { convertSessionToFixture } from "./corpus-converter.ts";
import { runEval } from "./runner.ts";

const RUN = process.env.PI_MULTI_MODEL_EVAL === "1";
if (RUN) configureHttpDispatcher();

const DEFAULT_MODELS = "openai-codex/gpt-5.4-mini,openai-codex/gpt-5.4";
const MODEL_SPECS = (process.env.PI_MULTI_MODEL_MODELS ?? DEFAULT_MODELS)
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);

function parseModelSpec(spec: string): { provider: string; modelId: string } {
	const separator = spec.indexOf("/");
	if (separator < 1 || separator === spec.length - 1) {
		throw new Error(`Invalid PI_MULTI_MODEL_MODELS entry: ${spec}`);
	}
	return { provider: spec.slice(0, separator), modelId: spec.slice(separator + 1) };
}

async function realComplete(spec: string) {
	const { provider, modelId } = parseModelSpec(spec);
	const credentials = AuthStorage.create();
	const runtime = await ModelRuntime.create({ credentials, allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	const model = registry.find(provider, modelId);
	if (!model) throw new Error(`${spec} not in model catalog`);
	const resolution = await runtime.getAuth(model);
	if (!resolution) throw new Error(`No credentials available for ${spec}`);
	const headers = resolution.auth.headers
		? Object.fromEntries(
				Object.entries(resolution.auth.headers).filter((entry): entry is [string, string] => entry[1] !== null),
			)
		: undefined;
	const requestModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
	return createPiAiCompleteFn({
		model: requestModel,
		apiKey: resolution.auth.apiKey,
		headers,
		env: resolution.env as Record<string, string> | undefined,
		// OAuth-backed providers (for example openai-codex) require ModelRuntime's
		// request preparation/refresh path; raw pi-ai streamSimple cannot use the
		// stored bearer credential directly.
		streamFn: (requestModel, context, options) => runtime.streamSimple(requestModel, context, options),
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 5000 },
	});
}

function largeSessionFixture(modelLabel: string) {
	const raw = readFileSync(join(__dirname, "../../fixtures/large-session.jsonl"), "utf-8");
	const parsed = parseSessionEntries(raw);
	migrateSessionEntries(parsed);
	const entries = parsed
		.filter((entry): entry is SessionEntry => entry.type !== "session")
		.slice(0, 100)
		.map((entry, index) => {
			const number = String(index + 1).padStart(3, "0");
			const previous = String(index).padStart(3, "0");
			return {
				...entry,
				id: `t304-entry-${number}`,
				parentId: index === 0 ? null : `t304-entry-${previous}`,
			};
		});
	return convertSessionToFixture(entries, {
		name: `pi-mono-large-100-${modelLabel.replaceAll("/", "-")}`,
		constraints: ["Never lose user requirements", "Preserve exact file paths and error messages"],
		compactionRounds: 2,
	});
}

function printReport(spec: string, report: EvalReport): number {
	const tokenGain = report.tokensBeforeFirst > 0 ? (1 - report.tokensAfterLast / report.tokensBeforeFirst) * 100 : 0;
	console.log(`\n=== T-304 ${spec} ===`);
	console.log(`overall retention: ${(report.overallRetention * 100).toFixed(1)}%`);
	console.log(`retention by kind: ${JSON.stringify(report.retentionByKind)}`);
	console.log(`oracle consistent: ${report.oracleConsistent}`);
	console.log(`tokens: ${report.tokensBeforeFirst} -> ${report.tokensAfterLast} (${tokenGain.toFixed(1)}% reduction)`);
	console.log(`rounds activated/rejected: ${report.roundsActivated}/${report.roundsRejected}`);
	if (report.rejectReasons.length > 0) console.log(`reject reasons: ${report.rejectReasons.join("; ")}`);
	return tokenGain;
}

describe.skipIf(!RUN)("T-304 cross-model real-provider eval", () => {
	for (const spec of MODEL_SPECS) {
		it(`${spec}: real long-task corpus, two rounds`, { timeout: 900_000 }, async () => {
			const complete = await realComplete(spec);
			const cached = withCache(complete, {
				cacheDir: join(process.env.PI_EVAL_CACHE_DIR ?? "/tmp", "hf-eval-cache"),
				modelId: `${spec}/t304-dispatcher-v1`,
			});
			const report = await runEval(largeSessionFixture(spec), cached);
			const tokenGain = printReport(spec, report);
			expect(report.roundsActivated).toBe(2);
			expect(report.roundsRejected).toBe(0);
			expect(report.overallRetention).toBe(1);
			expect(report.retentionByKind.C).toBe(1);
			expect(report.retentionByKind.T).toBe(1);
			expect(report.retentionByKind.P).toBe(1);
			expect(report.oracleConsistent).toBe(true);
			expect(tokenGain).toBeGreaterThanOrEqual(40);
		});
	}
});
