import { createHash } from "node:crypto";
import type { ToolProfile } from "../../src/core/sdk.ts";
import type { SanitizedToolTrace } from "./trace.ts";

export interface ToolProfileEvalManifest {
	version: 1;
	profiles: ["legacy", "v2"];
	seeds: number[];
	budgets: { maxTurns: number; timeoutMs: number };
	tasks: Array<{ id: string; prompt: string }>;
	bootstrapSamples: number;
}

export interface EvalExecutionInput {
	task: ToolProfileEvalManifest["tasks"][number];
	profile: ToolProfile;
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
	profile: ToolProfile;
	seed: number;
	pairOrder: number;
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
	profiles: Record<
		ToolProfile,
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
		}
	>;
	pairedScoreDeltaV2MinusLegacy: number;
	clusteredBootstrap95: [number, number];
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

function summarizeProfile(records: ToolProfileEvalRecord[], profile: ToolProfile) {
	const selected = records.filter((record) => record.profile === profile);
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
	};
}

/** Run paired profile evaluations and compute a deterministic task×seed clustered bootstrap interval. */
export async function runToolProfileEvaluation(
	manifest: ToolProfileEvalManifest,
	execute: EvalExecutor,
): Promise<ToolProfileEvalSummary> {
	if (manifest.profiles[0] !== "legacy" || manifest.profiles[1] !== "v2") {
		throw new Error("Evaluation profiles must be [legacy, v2]");
	}
	const records: ToolProfileEvalRecord[] = [];
	for (const task of manifest.tasks) {
		for (const seed of manifest.seeds) {
			const pairProfiles: ToolProfile[] =
				random(seed ^ Number.parseInt(hash(task.id).slice(0, 8), 16))() < 0.5 ? ["legacy", "v2"] : ["v2", "legacy"];
			for (let pairOrder = 0; pairOrder < pairProfiles.length; pairOrder++) {
				const profile = pairProfiles[pairOrder];
				const output = await execute({ task, profile, seed, budgets: manifest.budgets });
				records.push({
					taskId: task.id,
					profile,
					seed,
					pairOrder,
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
			const pair = records.filter((record) => record.taskId === task.id && record.seed === seed);
			const legacy = pair.find((record) => record.profile === "legacy");
			const v2 = pair.find((record) => record.profile === "v2");
			if (!legacy || !v2) throw new Error(`Incomplete pair for ${task.id}/${seed}`);
			return v2.score - legacy.score;
		}),
	);
	const rng = random(manifest.version * 1_000_003 + manifest.bootstrapSamples);
	const bootstrap = Array.from({ length: manifest.bootstrapSamples }, () =>
		mean(Array.from({ length: clusters.length }, () => clusters[Math.floor(rng() * clusters.length)])),
	).sort((left, right) => left - right);

	return {
		manifestVersion: manifest.version,
		records,
		profiles: {
			legacy: summarizeProfile(records, "legacy"),
			v2: summarizeProfile(records, "v2"),
		},
		pairedScoreDeltaV2MinusLegacy: mean(clusters),
		clusteredBootstrap95: [percentile(bootstrap, 0.025), percentile(bootstrap, 0.975)],
	};
}
