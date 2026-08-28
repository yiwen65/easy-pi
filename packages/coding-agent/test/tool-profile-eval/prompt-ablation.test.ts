import { describe, expect, it } from "vitest";
import { runPromptAblation } from "./prompt-ablation.ts";
import type { ToolProfileEvalManifest } from "./runner.ts";

const manifest: ToolProfileEvalManifest = {
	version: 1,
	profiles: ["legacy", "v2"],
	seeds: [1, 2],
	budgets: { maxTurns: 10, timeoutMs: 1_000 },
	tasks: [
		{ id: "move", prompt: "move" },
		{ id: "control", prompt: "control" },
	],
	bootstrapSamples: 10,
};

describe("prompt ablation runner", () => {
	it("pairs variants deterministically and reports candidate-minus-control metrics", async () => {
		const execute = async (input: Parameters<Parameters<typeof runPromptAblation>[1]>[0]) => {
			const candidate = input.variant === "candidate";
			return {
				success: true,
				score: 1,
				turns: candidate ? 3 : 5,
				inputTokens: candidate ? 80 : 100,
				outputTokens: candidate ? 10 : 20,
				cacheReadTokens: 40,
				cacheWriteTokens: 0,
				costUsd: candidate ? 0.01 : 0.02,
				elapsedMs: candidate ? 30 : 50,
				modelElapsedMs: candidate ? 25 : 45,
				systemPrompt: input.variant,
				tools: [{ name: "read", description: "same", parameters: {} }],
				trace: {
					calls: [],
					toolCallCount: candidate ? 3 : 5,
					toolErrorCount: candidate ? 0 : 2,
					firstEditSuccess: true,
					postEditReadCount: 0,
					recoveryCallCount: candidate ? 0 : 2,
					truncationCount: 0,
					toolElapsedMs: 5,
					peakContextTokens: candidate ? 80 : 100,
				},
			};
		};

		const first = await runPromptAblation(manifest, execute);
		const second = await runPromptAblation(manifest, execute);
		expect(second).toEqual(first);
		expect(first.records).toHaveLength(8);
		expect(first.variants.control.runs).toBe(4);
		expect(first.variants.candidate.runs).toBe(4);
		expect(first.pairedCandidateMinusControl).toEqual({
			score: 0,
			turns: -2,
			toolCalls: -2,
			toolErrors: -2,
			inputTokens: -20,
			outputTokens: -10,
			elapsedMs: -20,
		});
		expect(new Set(first.records.map((record) => record.schemaHash))).toHaveLength(1);
		expect(new Set(first.records.map((record) => record.promptHash))).toHaveLength(2);
	});
});
