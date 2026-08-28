/**
 * Authorized real-provider matrix for durable AgentHarness prompt-cache affinity.
 *
 * This file never calls a Provider unless PI_REAL_CACHE_MATRIX_EVAL=1 is set.
 * It is pinned to openai-codex/gpt-5.6-luna, sends synthetic text only, performs
 * at most 14 planned model calls (20 hard cap), and prints metrics without
 * response content or credentials.
 *
 * Run explicitly:
 *   PI_REAL_CACHE_MATRIX_EVAL=1 node ../../node_modules/vitest/dist/cli.js \
 *     --run test/real-cache-affinity-matrix-eval.test.ts --silent=false
 */

import { AgentHarness, InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import {
	type Api,
	cleanupSessionResources,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const RUN = process.env.PI_REAL_CACHE_MATRIX_EVAL === "1";
if (RUN) configureHttpDispatcher();

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-luna";
const PLANNED_MODEL_CALLS = 14;
const MAX_MODEL_CALLS = 20;
const MAX_REPORTED_COST_USD = 10;
const MAX_ESTIMATED_INPUT_TOKENS_PER_CALL = 12_000;
const MAX_OUTPUT_TOKENS_PER_CALL = 64;

type MatrixTransport = "sse" | "auto";

interface CallMetric {
	scenario: string;
	turn: number;
	transport: MatrixTransport;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheReadRatio: number;
	costUsd: number;
	elapsedMs: number;
}

function errorSummary(error: unknown, depth = 0): unknown {
	if (!(error instanceof Error) || depth >= 4) return String(error);
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name,
		message: error.message,
		...(typeof code === "string" || typeof code === "number" ? { code } : {}),
		...(error.cause !== undefined ? { cause: errorSummary(error.cause, depth + 1) } : {}),
	};
}

const diagnosticFetch: typeof globalThis.fetch = async (input, init) => {
	try {
		return await globalThis.fetch(input, init);
	} catch (error) {
		const rawUrl = input instanceof Request ? input.url : String(input);
		let host = "unknown";
		try {
			host = new URL(rawUrl).host;
		} catch {
			// Keep the redacted fallback; never print the raw request URL.
		}
		console.log(JSON.stringify({ eval: "real-cache-matrix-fetch-error", host, error: errorSummary(error) }));
		throw error;
	}
};

function stableSystemPrompt(matrixId: string, scenario: string): string {
	const prefix = `Synthetic cache matrix ${matrixId}; isolated scenario ${scenario}.`;
	const filler = Array.from(
		{ length: 220 },
		(_, index) =>
			`${prefix} Stable record ${String(index + 1).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.`,
	).join("\n");
	return [
		`${prefix} Follow the current request exactly and answer in one short line.`,
		filler,
		`${prefix} These synthetic records remain stable only inside this scenario so cache-read usage can be measured.`,
	].join("\n\n");
}

function completedUsage(result: Awaited<ReturnType<AgentHarness["prompt"]>>, scenario: string): Usage {
	expect(result.ok, result.ok ? undefined : `${scenario}: ${result.error.message}`).toBe(true);
	if (!result.ok) throw new Error(`${scenario}: ${result.error.message}`);
	if (result.value.kind === "failed") {
		throw new Error(`${scenario}: ${result.value.error.code}: ${result.value.error.message}`);
	}
	expect(result.value.kind, scenario).toBe("completed");
	if (result.value.kind !== "completed") throw new Error(`${scenario}: unexpected ${result.value.kind}`);
	return result.value.finalMessage.usage;
}

function promptTokens(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function cacheReadRatio(usage: Usage): number {
	const total = promptTokens(usage);
	return total > 0 ? usage.cacheRead / total : 0;
}

function conservativeCallCost(model: Model<Api>): number {
	return (
		(model.cost.input * MAX_ESTIMATED_INPUT_TOKENS_PER_CALL + model.cost.output * MAX_OUTPUT_TOKENS_PER_CALL) /
		1_000_000
	);
}

describe.skipIf(!RUN)("real durable prompt-cache affinity matrix", () => {
	it("covers Luna session, retention, transport, and repeatability boundaries", { timeout: 600_000 }, async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(),
			allowModelNetwork: false,
		});
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error(`${PROVIDER}/${MODEL_ID} is not in the local model catalog`);
		const auth = await runtime.getAuth(model);
		if (!auth) throw new Error(`${PROVIDER}/${MODEL_ID} has no configured credentials`);

		const matrixId = String(Date.now());
		const metrics: CallMetric[] = [];
		let modelCalls = 0;
		let reportedCostUsd = 0;
		const estimatedCallCost = conservativeCallCost(model);

		const createHarness = async (options: {
			scenario: string;
			metadataSessionId: string;
			providerSessionId?: string;
			cacheRetention?: "none" | "short";
			transport: MatrixTransport;
		}) => {
			const streamOptions: SimpleStreamOptions = {
				cacheRetention: options.cacheRetention ?? "short",
				maxTokens: MAX_OUTPUT_TOKENS_PER_CALL,
				maxRetries: 1,
				timeoutMs: 120_000,
				transport: options.transport,
				fetch: diagnosticFetch,
				...(options.providerSessionId !== undefined ? { sessionId: options.providerSessionId } : {}),
			};
			const session = new Session(
				new InMemorySessionStorage({ id: options.metadataSessionId, createdAt: Date.now() }),
			);
			const created = await AgentHarness.create({
				session,
				models: runtime,
				model,
				systemPrompt: stableSystemPrompt(matrixId, options.scenario),
				streamOptions,
				streamFn: (requestModel, context, requestOptions) =>
					runtime.streamSimple(requestModel, context, requestOptions),
			});
			return {
				harness: created.harness,
				cleanupSessionId: options.providerSessionId ?? options.metadataSessionId,
			};
		};

		const runPrompt = async (
			harness: AgentHarness,
			scenario: string,
			turn: number,
			transport: MatrixTransport,
		): Promise<Usage> => {
			if (modelCalls >= MAX_MODEL_CALLS) throw new Error(`Model-call budget exceeded (${modelCalls})`);
			if (reportedCostUsd + estimatedCallCost > MAX_REPORTED_COST_USD) {
				throw new Error(
					`Conservative cost budget would be exceeded (${reportedCostUsd.toFixed(6)} + ${estimatedCallCost.toFixed(6)})`,
				);
			}
			modelCalls += 1;
			const startedAt = Date.now();
			const usage = completedUsage(
				await harness.prompt(`Synthetic ${scenario} turn ${turn}. Reply exactly: CACHE-MATRIX-OK-${turn}`),
				scenario,
			);
			const metric: CallMetric = {
				scenario,
				turn,
				transport,
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cacheReadRatio: Number(cacheReadRatio(usage).toFixed(4)),
				costUsd: Number(usage.cost.total.toFixed(6)),
				elapsedMs: Date.now() - startedAt,
			};
			reportedCostUsd += usage.cost.total;
			if (reportedCostUsd > MAX_REPORTED_COST_USD) {
				throw new Error(`Reported cost budget exceeded (${reportedCostUsd.toFixed(6)})`);
			}
			metrics.push(metric);
			console.log(JSON.stringify({ eval: "real-cache-affinity-matrix-call", ...metric }));
			return usage;
		};

		const runScenario = async (options: {
			scenario: string;
			metadataSessionId: string;
			providerSessionId?: string;
			cacheRetention?: "none" | "short";
			transport: MatrixTransport;
			turns: number;
			assertWarm: boolean;
		}) => {
			const { harness, cleanupSessionId } = await createHarness(options);
			try {
				const resolvedOptions = await harness.getStreamOptions();
				expect(resolvedOptions.sessionId).toBe(options.providerSessionId ?? options.metadataSessionId);
				const usages: Usage[] = [];
				for (let turn = 1; turn <= options.turns; turn++) {
					const usage = await runPrompt(harness, options.scenario, turn, options.transport);
					expect(promptTokens(usage), `${options.scenario} turn ${turn}`).toBeGreaterThan(1024);
					usages.push(usage);
				}
				if (options.assertWarm) {
					for (let index = 1; index < usages.length; index++) {
						expect(usages[index].cacheRead, `${options.scenario} warm turn ${index + 1}`).toBeGreaterThan(0);
						expect(cacheReadRatio(usages[index]), `${options.scenario} warm ratio ${index + 1}`).toBeGreaterThan(
							0,
						);
					}
				}
				return usages;
			} finally {
				await harness.close();
				cleanupSessionResources(cleanupSessionId);
			}
		};

		await runScenario({
			scenario: "sse-repeat",
			metadataSessionId: `matrix-${matrixId}-sse-repeat`,
			transport: "sse",
			turns: 4,
			assertWarm: true,
		});
		await runScenario({
			scenario: "explicit-override",
			metadataSessionId: `matrix-${matrixId}-metadata`,
			providerSessionId: `matrix-${matrixId}-explicit`,
			transport: "sse",
			turns: 2,
			assertWarm: true,
		});
		await runScenario({
			scenario: "cross-session-a",
			metadataSessionId: `matrix-${matrixId}-cross-a`,
			transport: "sse",
			turns: 2,
			assertWarm: true,
		});
		await runScenario({
			scenario: "cross-session-b",
			metadataSessionId: `matrix-${matrixId}-cross-b`,
			transport: "sse",
			turns: 2,
			assertWarm: true,
		});
		await runScenario({
			scenario: "cache-retention-none",
			metadataSessionId: `matrix-${matrixId}-none`,
			cacheRetention: "none",
			transport: "sse",
			turns: 2,
			assertWarm: false,
		});
		await runScenario({
			scenario: "auto-transport",
			metadataSessionId: `matrix-${matrixId}-auto`,
			transport: "auto",
			turns: 2,
			assertWarm: true,
		});

		expect(modelCalls).toBe(PLANNED_MODEL_CALLS);
		expect(modelCalls).toBeLessThanOrEqual(MAX_MODEL_CALLS);
		expect(reportedCostUsd).toBeLessThanOrEqual(MAX_REPORTED_COST_USD);
		console.log(
			JSON.stringify({
				eval: "real-cache-affinity-matrix-summary",
				provider: PROVIDER,
				model: MODEL_ID,
				plannedModelCalls: PLANNED_MODEL_CALLS,
				actualModelCalls: modelCalls,
				reportedCostUsd: Number(reportedCostUsd.toFixed(6)),
				estimatedCostCeilingPerCallUsd: Number(estimatedCallCost.toFixed(6)),
				scenarios: Array.from(new Set(metrics.map((metric) => metric.scenario))),
			}),
		);
	});
});
