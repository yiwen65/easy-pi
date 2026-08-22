/**
 * Batch corpus runner: serial pacing, response cache keyed by
 * (model, promptVersion, input hash), failure isolation, aggregate report.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../../../src/core/compaction/subsystem/hashing.ts";
import type { CompactionLLMResponse, CompleteFn } from "../../../src/core/compaction/subsystem/types.ts";
import type { EvalFixture, EvalReport } from "./atoms.ts";
import { runEval } from "./runner.ts";

export interface CacheOptions {
	cacheDir: string;
	modelId: string;
}

/**
 * Cache compactor responses on disk. Identical requests (same model, prompt
 * version, and canonical input) never hit the model twice — reruns are cheap
 * and reproducible.
 */
export function withCache(complete: CompleteFn, options: CacheOptions): CompleteFn {
	mkdirSync(options.cacheDir, { recursive: true });
	return async (request) => {
		const key = sha256Hex(
			canonicalJson({
				model: options.modelId,
				promptVersion: request.promptVersion,
				systemPrompt: request.systemPrompt,
				messages: request.messages,
				maxTokens: request.maxTokens,
				responseSchema: request.responseSchema ?? null,
			}),
		);
		const path = join(options.cacheDir, `${key}.json`);
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf-8")) as CompactionLLMResponse;
		}
		const response = await complete(request);
		writeFileSync(path, JSON.stringify(response));
		return response;
	};
}

export interface CorpusRunOptions {
	/** Compaction rounds per cell. Default [2]. */
	roundsSchedule?: number[];
	/** Repetitions per cell (median over reps). Default 1. */
	reps?: number;
	/** Minimum delay between real model calls (ms). Default 0. */
	pacingMs?: number;
	label?: string;
}

export interface CorpusCellReport extends EvalReport {
	rep: number;
}

export interface CorpusReport {
	label: string;
	cells: CorpusCellReport[];
	/** Median across cells with measured tokens; null when nothing activated. */
	medianTokenGainPct: number | null;
	retentionByKind: Record<string, number>;
	overallRetention: number;
	failures: string[];
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run every fixture × rounds × rep serially (concurrency 1 to respect rate
 * limits). A failing cell is recorded and skipped; the corpus continues.
 */
export async function runCorpus(
	fixtures: EvalFixture[],
	complete: CompleteFn,
	options: CorpusRunOptions = {},
): Promise<CorpusReport> {
	const roundsSchedule = options.roundsSchedule ?? [2];
	const reps = options.reps ?? 1;
	const cells: CorpusCellReport[] = [];
	const failures: string[] = [];

	for (const fixture of fixtures) {
		for (const rounds of roundsSchedule) {
			for (let rep = 1; rep <= reps; rep++) {
				const cellName = `${fixture.name}@${rounds}r#${rep}`;
				try {
					if (options.pacingMs) await sleep(options.pacingMs);
					const report = await runEval({ ...fixture, compactionRounds: rounds, name: cellName }, complete);
					cells.push({ ...report, rep });
				} catch (error) {
					failures.push(`${cellName}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}

	const gains = cells
		.filter((c) => c.tokensBeforeFirst > 0 && c.tokensAfterLast > 0 && c.roundsActivated > 0)
		.map((c) => (1 - c.tokensAfterLast / c.tokensBeforeFirst) * 100);

	const retentionByKind: Record<string, number> = {};
	for (const kind of ["F", "C", "R", "S", "U", "D", "T", "P"]) {
		const values = cells.map((c) => c.retentionByKind[kind]).filter((v): v is number => v !== undefined);
		if (values.length > 0) {
			retentionByKind[kind] = values.reduce((a, b) => a + b, 0) / values.length;
		}
	}
	const overallRetention =
		cells.length === 0 ? 0 : cells.reduce((sum, c) => sum + c.overallRetention, 0) / cells.length;

	return {
		label: options.label ?? "corpus",
		cells,
		medianTokenGainPct: median(gains),
		retentionByKind,
		overallRetention,
		failures,
	};
}

/** Render a corpus report as Markdown for review. */
export function corpusReportToMarkdown(report: CorpusReport): string {
	const lines = [
		`# Corpus report: ${report.label}`,
		"",
		`- cells: ${report.cells.length}, failures: ${report.failures.length}`,
		`- overall retention: ${(report.overallRetention * 100).toFixed(1)}%`,
		`- median token gain: ${report.medianTokenGainPct === null ? "n/a" : `${report.medianTokenGainPct.toFixed(1)}%`}`,
		"",
		"| kind | retention |",
		"|---|---:|",
		...Object.entries(report.retentionByKind).map(([kind, v]) => `| ${kind} | ${(v * 100).toFixed(1)}% |`),
	];
	if (report.failures.length > 0) {
		lines.push("", "## Failures", ...report.failures.map((f) => `- ${f}`));
	}
	return lines.join("\n");
}
