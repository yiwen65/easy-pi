import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentBudget } from "./types.ts";

export interface BudgetUsage {
	turns: number;
	usage: Usage;
}

/** Return one task or legacy-run token allowance after previously accounted usage. */
export function remainingBudget(budget: SubagentBudget, used: BudgetUsage): SubagentBudget {
	return {
		maxTokens: Math.max(0, budget.maxTokens - used.usage.totalTokens),
	};
}

/**
 * Return the attempt-relative token count at which a task first reaches 90%
 * of its cumulative hard budget. Undefined means prior attempts already
 * reached the threshold, so a resumed/retried task must not be steered again.
 */
export function remainingSoftTokenLimit(budget: SubagentBudget, used: BudgetUsage): number | undefined {
	const threshold = budget.maxTokens - Math.ceil(budget.maxTokens / 10);
	if (used.usage.totalTokens >= threshold) return undefined;
	return threshold - used.usage.totalTokens;
}

/**
 * Preserve aggregate hard partitioning for persisted legacy run-scoped budgets.
 * Earlier claims receive any indivisible remainder, so ordering is stable.
 */
export function allocateConcurrentBudgets(remaining: SubagentBudget, claimCount: number): SubagentBudget[] {
	if (!Number.isSafeInteger(remaining.maxTokens) || remaining.maxTokens < 0) {
		throw new RangeError("remaining maxTokens must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(claimCount) || claimCount < 0) {
		throw new RangeError("claimCount must be a non-negative safe integer");
	}
	if (claimCount === 0) return [];

	const tokensPerClaim = Math.floor(remaining.maxTokens / claimCount);
	const claimsWithExtraToken = remaining.maxTokens - tokensPerClaim * claimCount;
	return Array.from({ length: claimCount }, (_, index) => ({
		maxTokens: tokensPerClaim + (index < claimsWithExtraToken ? 1 : 0),
	}));
}

/** True when no consumable token budget remains for another child attempt. */
export function budgetExhausted(budget: SubagentBudget): boolean {
	return budget.maxTokens < 1;
}
