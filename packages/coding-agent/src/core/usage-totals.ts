import type { Usage } from "@earendil-works/pi-ai/compat";
import { COMPACTION_DIAGNOSTICS_ENTRY_TYPE } from "./compaction/subsystem/observability.ts";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReportedUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	const cost = value.cost;
	const finite = (candidate: unknown): candidate is number =>
		typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0;
	return (
		["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => finite(value[key])) &&
		["cacheWrite1h", "reasoning"].every((key) => value[key] === undefined || finite(value[key])) &&
		["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => finite(cost[key]))
	);
}

/** Activated summaries are counted on their checkpoint; unsuccessful attempts have diagnostics only. */
export function getUnactivatedCompactionUsages(entry: unknown): Usage[] {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== COMPACTION_DIAGNOSTICS_ENTRY_TYPE) return [];
	const data = entry.data;
	if (
		!isRecord(data) ||
		data.version !== 1 ||
		(data.outcome !== "failed" && data.outcome !== "aborted") ||
		!Array.isArray(data.attempts)
	)
		return [];
	return data.attempts.flatMap((attempt: unknown) =>
		isRecord(attempt) && isReportedUsage(attempt.usage) ? [attempt.usage] : [],
	);
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string;
		let usages: Usage[] = [];
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usages = entry.message.usage ? [entry.message.usage] : [];
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usages = [entry.message.usage];
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usages = [entry.usage];
		} else {
			key = "Tools/summaries";
			usages = getUnactivatedCompactionUsages(entry);
		}
		if (usages.length === 0) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		for (const usage of usages) addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
