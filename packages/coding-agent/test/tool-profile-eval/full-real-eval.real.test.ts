/**
 * Explicitly gated real-model calibration and held-out toolchain evaluation.
 *
 * No network call occurs unless exactly one stage flag is enabled together with
 * PI_SEMANTIC_SEARCH=1 and complete embedding configuration. Only generated
 * temporary fixture inputs admitted by an in-memory allowlist can reach the
 * embedding fetch implementation. Printed output is content-free metrics only.
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { OpenAICompatibleEmbeddingSearchProvider } from "../../src/core/tools/openai-compatible-embedding-search-provider.ts";
import { TypeScriptCodeIndexProvider } from "../../src/core/tools/typescript-code-index-provider.ts";
import {
	createSyntheticEmbeddingAllowlist,
	createSyntheticEmbeddingFetchGuard,
	FULL_REAL_EVAL_MAX_COST_USD,
	FULL_REAL_EVAL_MAX_TURNS,
	type FullRealEvalCase,
	type FullRealEvalExecutionOutput,
	type FullRealEvalStage,
	fullRealEvalShouldStopAfterTurn,
	runFullRealEvalStage,
	type SyntheticEmbeddingAllowlist,
	SystemicEvaluationError,
} from "./full-real-eval.ts";
import { createFullRealEvalFixture, type FullRealEvalFixture } from "./full-real-eval-fixtures.ts";
import { createSanitizedToolTraceCollector } from "./trace.ts";

const RUN_CALIBRATION = process.env.PI_REAL_FULL_TOOLCHAIN_CALIBRATION === "1";
const RUN_HELD_OUT = process.env.PI_REAL_FULL_TOOLCHAIN_HELD_OUT === "1";
const RUN = RUN_CALIBRATION || RUN_HELD_OUT;
if (RUN) configureHttpDispatcher();

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-luna";
const SESSION_TIMEOUT_MS = 180_000;

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, stableValue(nested)]),
		);
	}
	return value;
}

function hash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex");
}

function nonEmptyEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Real evaluation preflight requires ${name}`);
	return value;
}

function parsePrior(stage: FullRealEvalStage): { sessions: number; costUsd: number } {
	if (stage === "calibration") return { sessions: 0, costUsd: 0 };
	const sessions = Number(nonEmptyEnvironment("PI_REAL_FULL_TOOLCHAIN_PRIOR_SESSIONS"));
	const costUsd = Number(nonEmptyEnvironment("PI_REAL_FULL_TOOLCHAIN_PRIOR_COST_USD"));
	if (!Number.isSafeInteger(sessions) || sessions <= 0 || sessions > 6) {
		throw new Error("Held-out preflight requires a prior calibration session count from 1 through 6");
	}
	if (!Number.isFinite(costUsd) || costUsd < 0 || costUsd >= FULL_REAL_EVAL_MAX_COST_USD) {
		throw new Error("Held-out preflight requires prior cost below the global $5 limit");
	}
	return { sessions, costUsd };
}

function resultText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
		return undefined;
	}
	return result.content.find(
		(part: unknown): part is { type: "text"; text: string } =>
			!!part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string",
	)?.text;
}

function normalizedPath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function pathMatches(value: unknown, relativePath: string): boolean {
	if (typeof value !== "string") return false;
	const normalized = normalizedPath(value);
	const target = normalizedPath(relativePath);
	return normalized === target || normalized.endsWith(`/${target}`);
}

function resultDetails(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object" || !("details" in result)) return undefined;
	return result.details && typeof result.details === "object"
		? (result.details as Record<string, unknown>)
		: undefined;
}

function createFaultController(
	fixture: FullRealEvalFixture,
	variant: FullRealEvalCase["variant"],
): {
	handle(event: AgentSessionEvent): void;
	wasApplied(): boolean;
} {
	let applied = false;
	const reads = new Map<string, boolean>();
	const prepares = new Map<string, boolean>();
	return {
		handle(event) {
			if (!fixture.fault || applied) return;
			if (event.type === "tool_execution_start") {
				if (event.toolName === "read") {
					const args = event.args && typeof event.args === "object" ? event.args : {};
					reads.set(event.toolCallId, "path" in args && pathMatches(args.path, fixture.targetPath));
				}
				if (event.toolName === "edit") {
					const args = event.args && typeof event.args === "object" ? event.args : {};
					prepares.set(event.toolCallId, "action" in args && args.action === "prepare");
				}
				return;
			}
			if (event.type !== "tool_execution_end" || event.isError) return;
			const details = resultDetails(event.result);
			const readTarget =
				reads.get(event.toolCallId) === true || (details && pathMatches(details.path, fixture.targetPath));
			reads.delete(event.toolCallId);
			if (
				readTarget &&
				(fixture.fault.kind === "after_target_read" ||
					(fixture.fault.kind === "after_multifile_prepare" && variant === "legacy"))
			) {
				fixture.fault.apply();
				applied = true;
				return;
			}
			if (fixture.fault.kind !== "after_multifile_prepare" || prepares.get(event.toolCallId) !== true) return;
			prepares.delete(event.toolCallId);
			const files = details?.files;
			if (
				Array.isArray(files) &&
				files.some(
					(file) =>
						!!file &&
						typeof file === "object" &&
						"path" in file &&
						pathMatches(file.path, fixture.fault?.relativePath ?? ""),
				)
			) {
				fixture.fault.apply();
				applied = true;
			}
		},
		wasApplied: () => applied,
	};
}

async function allowedSemanticDocuments(
	provider: TypeScriptCodeIndexProvider,
	cwd: string,
	fixture: FullRealEvalFixture,
): Promise<SyntheticEmbeddingAllowlist> {
	const page = await provider.listSemanticDocuments({
		query: fixture.semanticQuery,
		kind: "text",
		path: cwd,
		case: "sensitive",
		regex: false,
		mode: "semantic_candidate",
		context: 0,
		limit: 100,
		ranking: "task",
		honorIgnore: true,
		includeHidden: false,
		followSymlinks: false,
	});
	return createSyntheticEmbeddingAllowlist(
		[fixture.semanticQuery],
		page.documents.map((document) => ({ path: document.path, text: document.text })),
	);
}

function preparedPreflight(): {
	stage: FullRealEvalStage;
	prior: { sessions: number; costUsd: number };
	embedding: { baseUrl: string; model: string; apiKey: string; usdPerMillionTokens: number };
} {
	if (RUN_CALIBRATION === RUN_HELD_OUT) {
		throw new Error("Set exactly one full-toolchain stage opt-in flag");
	}
	if (process.env.PI_SEMANTIC_SEARCH !== "1") {
		throw new Error("Real full-toolchain evaluation requires PI_SEMANTIC_SEARCH=1");
	}
	const price = Number(nonEmptyEnvironment("PI_EMBEDDING_USD_PER_MILLION_TOKENS"));
	if (!Number.isFinite(price) || price < 0) throw new Error("Embedding token price must be non-negative");
	const stage: FullRealEvalStage = RUN_CALIBRATION ? "calibration" : "held_out";
	return {
		stage,
		prior: parsePrior(stage),
		embedding: {
			baseUrl: nonEmptyEnvironment("PI_EMBEDDING_BASE_URL"),
			model: nonEmptyEnvironment("PI_EMBEDDING_MODEL"),
			apiKey: nonEmptyEnvironment("PI_EMBEDDING_API_KEY"),
			usdPerMillionTokens: price,
		},
	};
}

describe.skipIf(!RUN)("real full-toolchain evaluation", () => {
	let benchmarkRoot: string;
	let runtime: ModelRuntime;
	let preflight: ReturnType<typeof preparedPreflight>;
	let completedCostUsd = 0;

	beforeAll(async () => {
		preflight = preparedPreflight();
		completedCostUsd = preflight.prior.costUsd;
		benchmarkRoot = join(tmpdir(), `pi-real-full-toolchain-${Date.now()}`);
		mkdirSync(benchmarkRoot, { recursive: true });
		runtime = await ModelRuntime.create({ credentials: AuthStorage.create(), allowModelNetwork: false });
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error("Required real-evaluation model is unavailable");
		if (!(await runtime.getAuth(model))) throw new Error("Required real-evaluation credentials are unavailable");
	});

	afterAll(() => {
		if (benchmarkRoot) rmSync(benchmarkRoot, { recursive: true, force: true });
	});

	it(
		"runs the frozen stage within global session, turn, cost, and data boundaries",
		{ timeout: 8_000_000 },
		async () => {
			const model = runtime.getModel(PROVIDER, MODEL_ID);
			if (!model) throw new SystemicEvaluationError("model_catalog_changed");
			const summary = await runFullRealEvalStage(
				preflight.stage,
				async (input) => {
					if (completedCostUsd >= FULL_REAL_EVAL_MAX_COST_USD) {
						throw new SystemicEvaluationError("global_cost_budget_exhausted");
					}
					const cwd = join(benchmarkRoot, "fixture");
					const fixture = createFullRealEvalFixture(cwd, input);
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

					let codeIndex: TypeScriptCodeIndexProvider | undefined;
					let semanticProvider: OpenAICompatibleEmbeddingSearchProvider | undefined;
					let embeddingBoundaryViolation = false;
					if (input.variant === "structured_semantic_v2") {
						codeIndex = new TypeScriptCodeIndexProvider();
						const allowed = await allowedSemanticDocuments(codeIndex, cwd, fixture);
						semanticProvider = new OpenAICompatibleEmbeddingSearchProvider(codeIndex, {
							...preflight.embedding,
							maxCostUsd: FULL_REAL_EVAL_MAX_COST_USD - completedCostUsd,
							maxDocuments: 64,
							batchSize: 32,
							maxInputBytes: 256 * 1024,
							maxRequests: 12,
							fetchFn: createSyntheticEmbeddingFetchGuard(allowed, fetch, () => {
								embeddingBoundaryViolation = true;
							}),
						});
					}

					const { session } = await createAgentSession({
						cwd,
						agentDir: benchmarkRoot,
						modelRuntime: runtime,
						model,
						thinkingLevel: "max",
						toolProfile: input.variant === "legacy" ? "legacy" : "v2",
						tools:
							input.variant === "legacy" ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : undefined,
						toolsV2:
							input.variant === "text_v2"
								? { search: { codeIndexProvider: false } }
								: input.variant === "structured_semantic_v2"
									? { search: { codeIndexProvider: codeIndex, semanticProvider } }
									: undefined,
						settingsManager,
						resourceLoader,
						sessionManager: SessionManager.inMemory(cwd),
					});
					const traceCollector = createSanitizedToolTraceCollector(Date.now, { targetPath: fixture.targetPath });
					const faultController = createFaultController(fixture, input.variant);
					let systemicCategory: string | undefined;
					let assistantTurns = 0;
					let observedChatCostUsd = 0;
					session.agent.shouldStopAfterTurn = ({ toolResults }) => {
						if (!fullRealEvalShouldStopAfterTurn(assistantTurns, toolResults.length)) return false;
						systemicCategory ??= "model_turn_budget_exceeded";
						return true;
					};
					const unsubscribe = session.subscribe((event) => {
						traceCollector.handle(event);
						faultController.handle(event);
						if (event.type === "message_end" && event.message.role === "assistant") {
							assistantTurns += 1;
							observedChatCostUsd += event.message.usage.cost.total;
							if (assistantTurns > FULL_REAL_EVAL_MAX_TURNS) {
								systemicCategory = "model_turn_budget_exceeded";
								void session.abort();
							}
							const embeddingCost = semanticProvider?.getUsage().estimatedCostUsd ?? 0;
							if (completedCostUsd + observedChatCostUsd + embeddingCost > FULL_REAL_EVAL_MAX_COST_USD) {
								systemicCategory = "global_cost_budget_exceeded";
								void session.abort();
							}
						}
						if (event.type === "tool_execution_end" && event.isError) {
							const code = resultText(event.result)?.split("\n", 1)[0];
							if (code === "SEARCH_PROVIDER_FAILED" || code === "READ_PROVIDER_FAILED") {
								systemicCategory = embeddingBoundaryViolation
									? "embedding_data_boundary_violation"
									: "tool_provider_unavailable";
								void session.abort();
							}
						}
					});
					const startedAt = Date.now();
					const timeout = setTimeout(() => {
						systemicCategory = "session_timeout";
						void session.abort();
					}, SESSION_TIMEOUT_MS);
					try {
						try {
							await session.prompt(fixture.prompt);
						} catch {
							systemicCategory ??= "chat_provider_or_infrastructure";
						}
						const stats = session.getSessionStats();
						if (stats.assistantMessages === 0) systemicCategory ??= "missing_assistant_turn";
						const trace = traceCollector.snapshot();
						const embeddingUsage = semanticProvider?.getUsage() ?? {
							requests: 0,
							estimatedOrReportedTokens: 0,
							estimatedCostUsd: 0,
						};
						const elapsedMs = Date.now() - startedAt;
						const grade = fixture.grade();
						const callCostUsd = stats.cost + embeddingUsage.estimatedCostUsd;
						completedCostUsd += callCostUsd;
						const output: FullRealEvalExecutionOutput = {
							success: systemicCategory ? false : grade.success,
							score: grade.score,
							turns: stats.assistantMessages,
							inputTokens: stats.tokens.input,
							outputTokens: stats.tokens.output,
							cacheReadTokens: stats.tokens.cacheRead,
							cacheWriteTokens: stats.tokens.cacheWrite,
							chatCostUsd: stats.cost,
							embeddingCostUsd: embeddingUsage.estimatedCostUsd,
							embeddingRequests: embeddingUsage.requests,
							embeddingTokens: embeddingUsage.estimatedOrReportedTokens,
							elapsedMs,
							modelElapsedMs: Math.max(0, elapsedMs - trace.toolElapsedMs),
							promptHash: hash(fixture.prompt),
							schemaHash: hash(
								session
									.getAllTools()
									.map(({ name, description, parameters }) => ({ name, description, parameters })),
							),
							trace,
							oracles: grade.oracles,
						};
						console.log(
							JSON.stringify({
								eval: "full-toolchain-real-call",
								stage: input.stage,
								taskId: input.taskId,
								seed: input.seed,
								variant: input.variant,
								order: input.order,
								faultApplied: faultController.wasApplied(),
								status: systemicCategory ? "aborted" : "completed",
								stopCategory: systemicCategory,
								...output,
							}),
						);
						if (systemicCategory) throw new SystemicEvaluationError(systemicCategory, output);
						return output;
					} finally {
						clearTimeout(timeout);
						unsubscribe();
						session.dispose();
						await semanticProvider?.close();
						await codeIndex?.close();
					}
				},
				preflight.prior,
			);
			console.log(
				JSON.stringify({ eval: "full-toolchain-real-summary", provider: PROVIDER, model: MODEL_ID, summary }),
			);
			for (const variant of Object.values(summary.variants)) {
				expect(variant.successes).toBe(variant.runs);
				expect(variant.wrongLocationProtectionRate).toBe(1);
				expect(variant.externalChangePreservationRate).toBe(1);
			}
			expect(summary.variants.structured_semantic_v2.totalEmbeddingRequests).toBeGreaterThan(0);
		},
	);
});
