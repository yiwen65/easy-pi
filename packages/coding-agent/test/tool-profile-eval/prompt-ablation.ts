import { createHash } from "node:crypto";
import type { EvalExecutionOutput, ToolProfileEvalManifest } from "./runner.ts";
import type { SanitizedToolTrace } from "./trace.ts";

export type PromptVariant = "control" | "candidate";

export interface PromptAblationInput {
	task: ToolProfileEvalManifest["tasks"][number];
	seed: number;
	variant: PromptVariant;
	budgets: ToolProfileEvalManifest["budgets"];
}

export interface PromptAblationRecord {
	taskId: string;
	seed: number;
	variant: PromptVariant;
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

export interface PromptAblationSummary {
	records: PromptAblationRecord[];
	variants: Record<
		PromptVariant,
		{
			runs: number;
			successes: number;
			meanTurns: number;
			meanToolCalls: number;
			meanToolErrors: number;
			firstEditSuccesses: number;
			postEditReads: number;
			recoveryCalls: number;
			meanInputTokens: number;
			meanOutputTokens: number;
			meanCacheReadTokens: number;
			meanElapsedMs: number;
			meanModelElapsedMs: number;
			totalCostUsd: number;
		}
	>;
	pairedCandidateMinusControl: {
		score: number;
		turns: number;
		toolCalls: number;
		toolErrors: number;
		inputTokens: number;
		outputTokens: number;
		elapsedMs: number;
	};
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

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(records: PromptAblationRecord[], variant: PromptVariant) {
	const selected = records.filter((record) => record.variant === variant);
	return {
		runs: selected.length,
		successes: selected.filter((record) => record.success).length,
		meanTurns: mean(selected.map((record) => record.turns)),
		meanToolCalls: mean(selected.map((record) => record.trace?.toolCallCount ?? 0)),
		meanToolErrors: mean(selected.map((record) => record.trace?.toolErrorCount ?? 0)),
		firstEditSuccesses: selected.filter((record) => record.trace?.firstEditSuccess === true).length,
		postEditReads: selected.reduce((sum, record) => sum + (record.trace?.postEditReadCount ?? 0), 0),
		recoveryCalls: selected.reduce((sum, record) => sum + (record.trace?.recoveryCallCount ?? 0), 0),
		meanInputTokens: mean(selected.map((record) => record.inputTokens)),
		meanOutputTokens: mean(selected.map((record) => record.outputTokens)),
		meanCacheReadTokens: mean(selected.map((record) => record.cacheReadTokens)),
		meanElapsedMs: mean(selected.map((record) => record.elapsedMs)),
		meanModelElapsedMs: mean(selected.map((record) => record.modelElapsedMs)),
		totalCostUsd: selected.reduce((sum, record) => sum + record.costUsd, 0),
	};
}

/** Runs deterministic paired control/candidate prompt variants over the manifest tasks and seeds. */
export async function runPromptAblation(
	manifest: ToolProfileEvalManifest,
	execute: (input: PromptAblationInput) => Promise<EvalExecutionOutput>,
): Promise<PromptAblationSummary> {
	const records: PromptAblationRecord[] = [];
	for (const task of manifest.tasks) {
		for (const seed of manifest.seeds) {
			const variants: PromptVariant[] =
				Number.parseInt(hash(`${task.id}/${seed}`).slice(0, 2), 16) % 2
					? ["control", "candidate"]
					: ["candidate", "control"];
			for (let pairOrder = 0; pairOrder < variants.length; pairOrder++) {
				const variant = variants[pairOrder];
				const output = await execute({ task, seed, variant, budgets: manifest.budgets });
				records.push({
					taskId: task.id,
					seed,
					variant,
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

	const deltas = manifest.tasks.flatMap((task) =>
		manifest.seeds.map((seed) => {
			const pair = records.filter((record) => record.taskId === task.id && record.seed === seed);
			const control = pair.find((record) => record.variant === "control");
			const candidate = pair.find((record) => record.variant === "candidate");
			if (!control || !candidate) throw new Error(`Incomplete prompt pair for ${task.id}/${seed}`);
			return {
				score: candidate.score - control.score,
				turns: candidate.turns - control.turns,
				toolCalls: (candidate.trace?.toolCallCount ?? 0) - (control.trace?.toolCallCount ?? 0),
				toolErrors: (candidate.trace?.toolErrorCount ?? 0) - (control.trace?.toolErrorCount ?? 0),
				inputTokens: candidate.inputTokens - control.inputTokens,
				outputTokens: candidate.outputTokens - control.outputTokens,
				elapsedMs: candidate.elapsedMs - control.elapsedMs,
			};
		}),
	);

	return {
		records,
		variants: { control: summarize(records, "control"), candidate: summarize(records, "candidate") },
		pairedCandidateMinusControl: {
			score: mean(deltas.map((delta) => delta.score)),
			turns: mean(deltas.map((delta) => delta.turns)),
			toolCalls: mean(deltas.map((delta) => delta.toolCalls)),
			toolErrors: mean(deltas.map((delta) => delta.toolErrors)),
			inputTokens: mean(deltas.map((delta) => delta.inputTokens)),
			outputTokens: mean(deltas.map((delta) => delta.outputTokens)),
			elapsedMs: mean(deltas.map((delta) => delta.elapsedMs)),
		},
	};
}
