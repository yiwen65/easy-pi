import { describe, expect, it } from "vitest";
import { allocateConcurrentBudgets, budgetExhausted, remainingBudget, remainingSoftTokenLimit } from "../src/budget.ts";
import { ZERO_USAGE } from "../src/ledger.ts";

describe("subagent token budget helpers", () => {
	it("derives the next attempt budget from one task's cumulative usage", () => {
		const budget = { maxTokens: 11 };
		const fresh = remainingBudget(budget, { turns: 0, usage: structuredClone(ZERO_USAGE) });
		expect(fresh).toEqual(budget);
		const used = structuredClone(ZERO_USAGE);
		used.totalTokens = 5;
		const remaining = remainingBudget(budget, { turns: 2, usage: used });
		expect(remaining.maxTokens).toBe(6);
		expect(budgetExhausted(remaining)).toBe(false);
		const drained = remainingBudget(budget, {
			turns: 0,
			usage: { ...structuredClone(ZERO_USAGE), totalTokens: 11 },
		});
		expect(drained.maxTokens).toBe(0);
		expect(budgetExhausted(drained)).toBe(true);
	});

	it("derives a one-time 90% soft threshold from cumulative task usage", () => {
		const budget = { maxTokens: 101 };
		expect(remainingSoftTokenLimit(budget, { turns: 0, usage: structuredClone(ZERO_USAGE) })).toBe(90);
		expect(
			remainingSoftTokenLimit(budget, {
				turns: 1,
				usage: { ...structuredClone(ZERO_USAGE), totalTokens: 40 },
			}),
		).toBe(50);
		expect(
			remainingSoftTokenLimit(budget, {
				turns: 1,
				usage: { ...structuredClone(ZERO_USAGE), totalTokens: 90 },
			}),
		).toBeUndefined();
		expect(
			remainingSoftTokenLimit(budget, {
				turns: 1,
				usage: { ...structuredClone(ZERO_USAGE), totalTokens: 100 },
			}),
		).toBeUndefined();
	});

	it("splits a persisted legacy run allowance across four concurrent claims", () => {
		expect(allocateConcurrentBudgets({ maxTokens: 100 }, 4)).toEqual([
			{ maxTokens: 25 },
			{ maxTokens: 25 },
			{ maxTokens: 25 },
			{ maxTokens: 25 },
		]);
	});

	it("assigns remainder tokens deterministically to earlier claims", () => {
		expect(allocateConcurrentBudgets({ maxTokens: 10 }, 4)).toEqual([
			{ maxTokens: 3 },
			{ maxTokens: 3 },
			{ maxTokens: 2 },
			{ maxTokens: 2 },
		]);
	});

	it("gives scarce tokens to earlier claims and marks the rest unrunnable", () => {
		expect(allocateConcurrentBudgets({ maxTokens: 2 }, 4)).toEqual([
			{ maxTokens: 1 },
			{ maxTokens: 1 },
			{ maxTokens: 0 },
			{ maxTokens: 0 },
		]);
	});

	it("returns zero legacy allocations when the aggregate allowance is empty", () => {
		expect(allocateConcurrentBudgets({ maxTokens: 0 }, 4)).toEqual([
			{ maxTokens: 0 },
			{ maxTokens: 0 },
			{ maxTokens: 0 },
			{ maxTokens: 0 },
		]);
	});

	it("preserves a single large safe-integer allowance exactly", () => {
		expect(allocateConcurrentBudgets({ maxTokens: Number.MAX_SAFE_INTEGER }, 1)).toEqual([
			{ maxTokens: Number.MAX_SAFE_INTEGER },
		]);
	});

	it("keeps large concurrent allocations integral and within the allowance", () => {
		const allocations = allocateConcurrentBudgets({ maxTokens: Number.MAX_SAFE_INTEGER }, 4);
		expect(allocations).toEqual([
			{ maxTokens: 2_251_799_813_685_248 },
			{ maxTokens: 2_251_799_813_685_248 },
			{ maxTokens: 2_251_799_813_685_248 },
			{ maxTokens: 2_251_799_813_685_247 },
		]);
		expect(allocations.every(({ maxTokens }) => Number.isSafeInteger(maxTokens) && maxTokens >= 0)).toBe(true);
		expect(allocations.reduce((sum, allocation) => sum + allocation.maxTokens, 0)).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("returns an empty allocation for an empty claim batch", () => {
		expect(allocateConcurrentBudgets({ maxTokens: 10 }, 0)).toEqual([]);
	});
});
