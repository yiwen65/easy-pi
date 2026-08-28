import { createHash } from "node:crypto";
import type { SanitizedToolTrace } from "./trace.ts";

export type ToolProfileEvalVariant = "A" | "B" | "C";

export interface ToolProfileEvalManifest {
	version: 2;
	profiles: ["A", "B", "C"];
	seeds: number[];
	budgets: { maxTurns: number; timeoutMs: number };
	tasks: Array<{ id: string; prompt: string }>;
	bootstrapSamples: number;
}

export interface EvalExecutionInput {
	task: ToolProfileEvalManifest["tasks"][number];
	variant: ToolProfileEvalVariant;
	seed: number;
	budgets: ToolProfileEvalManifest["budgets"];
}

export interface EvalExecutionOutput {
	success: boolean;
	score: number;
	turns: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	elapsedMs?: number;
	modelElapsedMs?: number;
	trace?: SanitizedToolTrace;
	systemPrompt: string;
	tools: Array<{ name: string; description: string; parameters: unknown }>;
}

export type EvalExecutor = (input: EvalExecutionInput) => Promise<EvalExecutionOutput>;

export interface ToolProfileEvalRecord {
	taskId: string;
	variant: ToolProfileEvalVariant;
	seed: number;
	order: number;
	promptHash: string;
	schemaHash: string;
	success: boolean;
	score: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	elapsedMs: number;
	modelElapsedMs: number;
	trace?: SanitizedToolTrace;
}

export interface ToolProfileEvalSummary {
	manifestVersion: number;
	records: ToolProfileEvalRecord[];
	variants: Record<
		ToolProfileEvalVariant,
		{
			runs: number;
			successes: number;
			meanScore: number;
			meanTurns: number;
			meanElapsedMs: number;
			meanModelElapsedMs: number;
			totalInputTokens: number;
			totalOutputTokens: number;
			totalCacheReadTokens: number;
			totalCacheWriteTokens: number;
			totalCostUsd: number;
			meanToolCalls: number;
			meanToolErrors: number;
			firstEditSuccesses: number;
			runMisuseCount: number;
			targetFirstReadCount: number;
		}
	>;
	pairedScoreDeltas: { BMinusA: number; CMinusB: number; CMinusA: number };
	clusteredBootstrap95CMinusA: [number, number];
}

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

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted: number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function summarizeVariant(records: ToolProfileEvalRecord[], variant: ToolProfileEvalVariant) {
	const selected = records.filter((record) => record.variant === variant);
	return {
		runs: selected.length,
		successes: selected.filter((record) => record.success).length,
		meanScore: mean(selected.map((record) => record.score)),
		meanTurns: mean(selected.map((record) => record.turns)),
		meanElapsedMs: mean(selected.map((record) => record.elapsedMs)),
		meanModelElapsedMs: mean(selected.map((record) => record.modelElapsedMs)),
		totalInputTokens: selected.reduce((sum, record) => sum + record.inputTokens, 0),
		totalOutputTokens: selected.reduce((sum, record) => sum + record.outputTokens, 0),
		totalCacheReadTokens: selected.reduce((sum, record) => sum + record.cacheReadTokens, 0),
		totalCacheWriteTokens: selected.reduce((sum, record) => sum + record.cacheWriteTokens, 0),
		totalCostUsd: selected.reduce((sum, record) => sum + record.costUsd, 0),
		meanToolCalls: mean(selected.map((record) => record.trace?.toolCallCount ?? 0)),
		meanToolErrors: mean(selected.map((record) => record.trace?.toolErrorCount ?? 0)),
		firstEditSuccesses: selected.filter((record) => record.trace?.firstEditSuccess === true).length,
		runMisuseCount: selected.reduce((sum, record) => sum + (record.trace?.runMisuseCount ?? 0), 0),
		targetFirstReadCount: selected.filter((record) => record.trace?.targetFirstRead === true).length,
	};
}

function randomizedVariants(seed: number, taskId: string): ToolProfileEvalVariant[] {
	const variants: ToolProfileEvalVariant[] = ["A", "B", "C"];
	const rng = random(seed ^ Number.parseInt(hash(taskId).slice(0, 8), 16));
	for (let index = variants.length - 1; index > 0; index--) {
		const swap = Math.floor(rng() * (index + 1));
		[variants[index], variants[swap]] = [variants[swap], variants[index]];
	}
	return variants;
}

/** Run fixed A/B/C evaluations and compute deterministic task×seed clustered C-minus-A intervals. */
export async function runToolProfileEvaluation(
	manifest: ToolProfileEvalManifest,
	execute: EvalExecutor,
): Promise<ToolProfileEvalSummary> {
	if (manifest.profiles.join(",") !== "A,B,C") throw new Error("Evaluation profiles must be [A, B, C]");
	const records: ToolProfileEvalRecord[] = [];
	for (const task of manifest.tasks) {
		for (const seed of manifest.seeds) {
			const variants = randomizedVariants(seed, task.id);
			for (let order = 0; order < variants.length; order++) {
				const variant = variants[order];
				const output = await execute({ task, variant, seed, budgets: manifest.budgets });
				records.push({
					taskId: task.id,
					variant,
					seed,
					order,
					promptHash: hash(output.systemPrompt),
					schemaHash: hash(output.tools),
					success: output.success,
					score: output.score,
					turns: output.turns,
					inputTokens: output.inputTokens ?? 0,
					outputTokens: output.outputTokens ?? 0,
					cacheReadTokens: output.cacheReadTokens ?? 0,
					cacheWriteTokens: output.cacheWriteTokens ?? 0,
					costUsd: output.costUsd ?? 0,
					elapsedMs: output.elapsedMs ?? 0,
					modelElapsedMs: output.modelElapsedMs ?? output.elapsedMs ?? 0,
					...(output.trace ? { trace: output.trace } : {}),
				});
			}
		}
	}

	const clusters = manifest.tasks.flatMap((task) =>
		manifest.seeds.map((seed) => {
			const group = records.filter((record) => record.taskId === task.id && record.seed === seed);
			const find = (variant: ToolProfileEvalVariant) => {
				const record = group.find((candidate) => candidate.variant === variant);
				if (!record) throw new Error(`Incomplete A/B/C group for ${task.id}/${seed}`);
				return record.score;
			};
			return { A: find("A"), B: find("B"), C: find("C") };
		}),
	);
	const rng = random(manifest.version * 1_000_003 + manifest.bootstrapSamples);
	const bootstrap = Array.from({ length: manifest.bootstrapSamples }, () =>
		mean(
			Array.from({ length: clusters.length }, () => {
				const cluster = clusters[Math.floor(rng() * clusters.length)];
				return cluster.C - cluster.A;
			}),
		),
	).sort((left, right) => left - right);

	return {
		manifestVersion: manifest.version,
		records,
		variants: {
			A: summarizeVariant(records, "A"),
			B: summarizeVariant(records, "B"),
			C: summarizeVariant(records, "C"),
		},
		pairedScoreDeltas: {
			BMinusA: mean(clusters.map((cluster) => cluster.B - cluster.A)),
			CMinusB: mean(clusters.map((cluster) => cluster.C - cluster.B)),
			CMinusA: mean(clusters.map((cluster) => cluster.C - cluster.A)),
		},
		clusteredBootstrap95CMinusA: [percentile(bootstrap, 0.025), percentile(bootstrap, 0.975)],
	};
}
