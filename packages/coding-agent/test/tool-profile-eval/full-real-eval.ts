import { createHash } from "node:crypto";
import type { SanitizedToolTrace } from "./trace.ts";

export type FullRealEvalStage = "calibration" | "held_out";
export type FullRealEvalVariant = "legacy" | "text_v2" | "structured_semantic_v2";

export const FULL_REAL_EVAL_VARIANTS: readonly FullRealEvalVariant[] = ["legacy", "text_v2", "structured_semantic_v2"];
export const FULL_REAL_EVAL_MAX_SESSIONS = 48;
export const FULL_REAL_EVAL_MAX_CALIBRATION_SESSIONS = 6;
export const FULL_REAL_EVAL_MAX_HELD_OUT_SESSIONS = 42;
export const FULL_REAL_EVAL_MAX_TURNS = 18;
export const FULL_REAL_EVAL_MAX_COST_USD = 5;

export function fullRealEvalShouldStopAfterTurn(assistantTurns: number, toolResultCount: number): boolean {
	return assistantTurns >= FULL_REAL_EVAL_MAX_TURNS && toolResultCount > 0;
}

const CALIBRATION_TASKS = ["calibration-stale-view", "calibration-multifile-repair"] as const;
const HELD_OUT_TASKS = [
	"duplicate-definition",
	"qualified-assignment",
	"definition-among-calls",
	"same-method-multiple-classes",
	"large-tail-long-line",
	"overflow-narrowing",
	"stale-patch-syntax-repair",
] as const;
const CALIBRATION_SEEDS = [809] as const;
const HELD_OUT_SEEDS = [1201, 1601] as const;

export interface FullRealEvalCase {
	stage: FullRealEvalStage;
	taskId: string;
	seed: number;
	variant: FullRealEvalVariant;
	order: number;
}

export interface FullRealEvalOracles {
	mutationCorrect: boolean;
	wrongLocationsUnchanged: boolean;
	verificationPassed: boolean;
	externalChangePreserved: boolean;
}

export interface FullRealEvalExecutionOutput {
	success: boolean;
	score: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	chatCostUsd: number;
	embeddingCostUsd: number;
	embeddingRequests: number;
	embeddingTokens: number;
	elapsedMs: number;
	modelElapsedMs: number;
	promptHash: string;
	schemaHash: string;
	trace: SanitizedToolTrace;
	oracles: FullRealEvalOracles;
}

export interface FullRealEvalRecord extends FullRealEvalCase, FullRealEvalExecutionOutput {
	totalCostUsd: number;
}

export interface FullRealEvalVariantSummary {
	runs: number;
	successes: number;
	meanScore: number;
	meanTurns: number;
	meanToolCalls: number;
	meanToolErrors: number;
	meanRecoveryCalls: number;
	truncationCount: number;
	schemaErrorCount: number;
	runMisuseCount: number;
	targetFirstReadCount: number;
	meanFirstSearchTargetRank: number | null;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalEmbeddingRequests: number;
	totalEmbeddingTokens: number;
	p50ElapsedMs: number;
	p95ElapsedMs: number;
	p50CostUsd: number;
	p95CostUsd: number;
	totalCostUsd: number;
	wrongLocationProtectionRate: number;
	externalChangePreservationRate: number;
}

export interface SyntheticEmbeddingAllowlist {
	queries: ReadonlySet<string>;
	documentPaths: ReadonlySet<string>;
	documentBodies: ReadonlySet<string>;
}

export interface FullRealEvalSummary {
	version: 1;
	stage: FullRealEvalStage;
	records: FullRealEvalRecord[];
	variants: Record<FullRealEvalVariant, FullRealEvalVariantSummary>;
	usage: {
		priorSessions: number;
		stageSessions: number;
		totalSessions: number;
		priorCostUsd: number;
		stageCostUsd: number;
		totalCostUsd: number;
		maxSessions: number;
		maxTurnsPerSession: number;
		maxCostUsd: number;
	};
}

function normalizedPath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Build an in-memory allowlist from generated fixture documents without retaining it in summaries. */
export function createSyntheticEmbeddingAllowlist(
	queries: readonly string[],
	documents: ReadonlyArray<{ path: string; text: string }>,
): SyntheticEmbeddingAllowlist {
	const documentPaths = new Set<string>();
	const documentBodies = new Set<string>();
	for (const document of documents) {
		const segments = normalizedPath(document.path).split("/");
		for (let index = 0; index < segments.length; index++) documentPaths.add(segments.slice(index).join("/"));
		const newline = document.text.indexOf("\n");
		if (newline >= 0) documentBodies.add(document.text.slice(newline + 1));
	}
	return { queries: new Set(queries), documentPaths, documentBodies };
}

/** Reject non-fixture embedding inputs before delegating to the configured network fetch. */
export function createSyntheticEmbeddingFetchGuard(
	allowed: SyntheticEmbeddingAllowlist,
	fetchFn: typeof fetch,
	onBoundaryViolation: () => void,
): typeof fetch {
	const isAllowed = (value: unknown): boolean => {
		if (typeof value !== "string") return false;
		if (allowed.queries.has(value)) return true;
		const newline = value.indexOf("\n");
		return (
			newline > 0 &&
			allowed.documentPaths.has(normalizedPath(value.slice(0, newline))) &&
			allowed.documentBodies.has(value.slice(newline + 1))
		);
	};
	return async (input, init) => {
		let values: unknown;
		try {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			values = body?.input;
		} catch {
			onBoundaryViolation();
			throw new Error("Synthetic embedding boundary rejected an invalid request");
		}
		if (!Array.isArray(values) || !values.every(isAllowed)) {
			onBoundaryViolation();
			throw new Error("Synthetic embedding boundary rejected non-fixture input");
		}
		return fetchFn(input, init);
	};
}

export class SystemicEvaluationError extends Error {
	readonly category: string;

	constructor(category: string) {
		super(`Systemic evaluation failure: ${category}`);
		this.name = "SystemicEvaluationError";
		this.category = category;
	}
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function randomizedVariants(taskId: string, seed: number): FullRealEvalVariant[] {
	const variants = [...FULL_REAL_EVAL_VARIANTS];
	const rng = random(seed ^ Number.parseInt(hash(taskId).slice(0, 8), 16));
	for (let index = variants.length - 1; index > 0; index--) {
		const swap = Math.floor(rng() * (index + 1));
		[variants[index], variants[swap]] = [variants[swap], variants[index]];
	}
	return variants;
}

export function buildFullRealEvalCases(stage: FullRealEvalStage): FullRealEvalCase[] {
	const tasks: readonly string[] = stage === "calibration" ? CALIBRATION_TASKS : HELD_OUT_TASKS;
	const seeds: readonly number[] = stage === "calibration" ? CALIBRATION_SEEDS : HELD_OUT_SEEDS;
	return tasks.flatMap((taskId) =>
		seeds.flatMap((seed) =>
			randomizedVariants(taskId, seed).map((variant, order) => ({ stage, taskId, seed, variant, order })),
		),
	);
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function rate(values: boolean[]): number {
	return values.length === 0 ? 0 : values.filter(Boolean).length / values.length;
}

function summarizeVariant(records: FullRealEvalRecord[], variant: FullRealEvalVariant): FullRealEvalVariantSummary {
	const selected = records.filter((record) => record.variant === variant);
	const ranks = selected.flatMap((record) =>
		record.trace.firstSearchTargetRank && record.trace.firstSearchTargetRank > 0
			? [record.trace.firstSearchTargetRank]
			: [],
	);
	return {
		runs: selected.length,
		successes: selected.filter((record) => record.success).length,
		meanScore: mean(selected.map((record) => record.score)),
		meanTurns: mean(selected.map((record) => record.turns)),
		meanToolCalls: mean(selected.map((record) => record.trace.toolCallCount)),
		meanToolErrors: mean(selected.map((record) => record.trace.toolErrorCount)),
		meanRecoveryCalls: mean(selected.map((record) => record.trace.recoveryCallCount)),
		truncationCount: selected.reduce((sum, record) => sum + record.trace.truncationCount, 0),
		schemaErrorCount: selected.reduce((sum, record) => sum + record.trace.schemaErrorCount, 0),
		runMisuseCount: selected.reduce((sum, record) => sum + record.trace.runMisuseCount, 0),
		targetFirstReadCount: selected.filter((record) => record.trace.targetFirstRead === true).length,
		meanFirstSearchTargetRank: ranks.length === 0 ? null : mean(ranks),
		totalInputTokens: selected.reduce((sum, record) => sum + record.inputTokens, 0),
		totalOutputTokens: selected.reduce((sum, record) => sum + record.outputTokens, 0),
		totalCacheReadTokens: selected.reduce((sum, record) => sum + record.cacheReadTokens, 0),
		totalCacheWriteTokens: selected.reduce((sum, record) => sum + record.cacheWriteTokens, 0),
		totalEmbeddingRequests: selected.reduce((sum, record) => sum + record.embeddingRequests, 0),
		totalEmbeddingTokens: selected.reduce((sum, record) => sum + record.embeddingTokens, 0),
		p50ElapsedMs: percentile(
			selected.map((record) => record.elapsedMs),
			0.5,
		),
		p95ElapsedMs: percentile(
			selected.map((record) => record.elapsedMs),
			0.95,
		),
		p50CostUsd: percentile(
			selected.map((record) => record.totalCostUsd),
			0.5,
		),
		p95CostUsd: percentile(
			selected.map((record) => record.totalCostUsd),
			0.95,
		),
		totalCostUsd: selected.reduce((sum, record) => sum + record.totalCostUsd, 0),
		wrongLocationProtectionRate: rate(selected.map((record) => record.oracles.wrongLocationsUnchanged)),
		externalChangePreservationRate: rate(selected.map((record) => record.oracles.externalChangePreserved)),
	};
}

function validateCount(stage: FullRealEvalStage, count: number): void {
	const expected =
		stage === "calibration" ? FULL_REAL_EVAL_MAX_CALIBRATION_SESSIONS : FULL_REAL_EVAL_MAX_HELD_OUT_SESSIONS;
	if (count !== expected) throw new Error(`${stage} matrix must contain exactly ${expected} sessions`);
}

function validatePriorUsage(stage: FullRealEvalStage, priorSessions: number, priorCostUsd: number): void {
	if (
		!Number.isSafeInteger(priorSessions) ||
		priorSessions < 0 ||
		priorSessions > FULL_REAL_EVAL_MAX_CALIBRATION_SESSIONS
	) {
		throw new Error("Prior session count must be an integer from 0 through 6");
	}
	if (stage === "calibration" && priorSessions !== 0)
		throw new Error("Calibration must start with zero prior sessions");
	if (stage === "held_out" && priorSessions === 0)
		throw new Error("Held-out evaluation requires recorded calibration usage");
	if (!Number.isFinite(priorCostUsd) || priorCostUsd < 0 || priorCostUsd >= FULL_REAL_EVAL_MAX_COST_USD) {
		throw new Error("Prior cost must be non-negative and below the global cost limit");
	}
}

function validateOutput(output: FullRealEvalExecutionOutput): void {
	if (!Number.isSafeInteger(output.turns) || output.turns <= 0 || output.turns > FULL_REAL_EVAL_MAX_TURNS) {
		throw new Error(`Session exceeded ${FULL_REAL_EVAL_MAX_TURNS} model turns (observed ${output.turns})`);
	}
	for (const [name, value] of [
		["score", output.score],
		["chatCostUsd", output.chatCostUsd],
		["embeddingCostUsd", output.embeddingCostUsd],
		["elapsedMs", output.elapsedMs],
		["modelElapsedMs", output.modelElapsedMs],
	] as const) {
		if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
	}
	for (const value of [
		output.inputTokens,
		output.outputTokens,
		output.cacheReadTokens,
		output.cacheWriteTokens,
		output.embeddingRequests,
		output.embeddingTokens,
	]) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("Usage counters must be non-negative integers");
	}
	if (!/^[a-f0-9]{64}$/.test(output.promptHash) || !/^[a-f0-9]{64}$/.test(output.schemaHash)) {
		throw new Error("Evaluation hashes must be SHA-256 hex values");
	}
}

/** Reject accidental content-bearing fields or values before a summary is printed or persisted. */
export function assertContentFreeRealEvalSummary(summary: FullRealEvalSummary): void {
	const forbiddenKeys = new Set([
		"path",
		"prompt",
		"command",
		"content",
		"message",
		"messages",
		"args",
		"credentials",
		"apiKey",
		"response",
		"session",
	]);
	const visit = (value: unknown, key?: string): void => {
		if (key && forbiddenKeys.has(key)) throw new Error(`Content-bearing evaluation field is forbidden: ${key}`);
		if (typeof value === "string") {
			if (value.includes("\n") || value.includes("/") || value.includes("\\") || value.length > 128) {
				throw new Error("Evaluation summary contains a content-like string");
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value && typeof value === "object") {
			for (const [nestedKey, nestedValue] of Object.entries(value)) visit(nestedValue, nestedKey);
		}
	};
	visit(summary);
}

/** Execute one frozen stage sequentially. Any thrown systemic failure stops before the next case. */
export async function runFullRealEvalStage(
	stage: FullRealEvalStage,
	execute: (input: FullRealEvalCase) => Promise<FullRealEvalExecutionOutput>,
	prior: { sessions: number; costUsd: number },
): Promise<FullRealEvalSummary> {
	validatePriorUsage(stage, prior.sessions, prior.costUsd);
	const cases = buildFullRealEvalCases(stage);
	validateCount(stage, cases.length);
	const records: FullRealEvalRecord[] = [];
	let stageCostUsd = 0;
	for (const input of cases) {
		if (prior.sessions + records.length >= FULL_REAL_EVAL_MAX_SESSIONS) {
			throw new Error(`Global session budget exhausted at ${prior.sessions + records.length} sessions`);
		}
		const output = await execute(input);
		validateOutput(output);
		const totalCostUsd = output.chatCostUsd + output.embeddingCostUsd;
		stageCostUsd += totalCostUsd;
		if (prior.costUsd + stageCostUsd > FULL_REAL_EVAL_MAX_COST_USD) {
			throw new Error(`Global cost budget exceeded after ${records.length + 1} stage sessions`);
		}
		records.push({ ...input, ...output, totalCostUsd });
	}
	const summary: FullRealEvalSummary = {
		version: 1,
		stage,
		records,
		variants: {
			legacy: summarizeVariant(records, "legacy"),
			text_v2: summarizeVariant(records, "text_v2"),
			structured_semantic_v2: summarizeVariant(records, "structured_semantic_v2"),
		},
		usage: {
			priorSessions: prior.sessions,
			stageSessions: records.length,
			totalSessions: prior.sessions + records.length,
			priorCostUsd: prior.costUsd,
			stageCostUsd,
			totalCostUsd: prior.costUsd + stageCostUsd,
			maxSessions: FULL_REAL_EVAL_MAX_SESSIONS,
			maxTurnsPerSession: FULL_REAL_EVAL_MAX_TURNS,
			maxCostUsd: FULL_REAL_EVAL_MAX_COST_USD,
		},
	};
	assertContentFreeRealEvalSummary(summary);
	return summary;
}
