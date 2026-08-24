import { describe, expect, it } from "vitest";
import {
	PromptBudgetExceededError,
	selectBudgetedItems,
	truncateTextToBudget,
} from "../../src/core/compaction/subsystem/active-projection.ts";

describe("active projection budgets", () => {
	it("keeps protected items, then admits highest-priority recent items in source order", () => {
		const selected = selectBudgetedItems(
			"warm",
			[
				{ id: "old", value: "old", tokens: 3, priority: 10, protected: false, order: 0 },
				{ id: "open", value: "open", tokens: 4, priority: 100, protected: true, order: 1 },
				{ id: "new", value: "new", tokens: 3, priority: 10, protected: false, order: 2 },
				{ id: "important", value: "important", tokens: 3, priority: 90, protected: false, order: 3 },
			],
			10,
		);

		expect(selected.selected).toEqual(["open", "new", "important"]);
		expect(selected.usedTokens).toBe(10);
		expect(selected.droppedItems).toBe(1);
		expect(selected.protectedItems).toBe(1);
	});

	it("fails closed when protected content cannot fit", () => {
		expect(() =>
			selectBudgetedItems(
				"hot",
				[{ id: "open", value: "open", tokens: 11, priority: 100, protected: true, order: 0 }],
				10,
			),
		).toThrow(PromptBudgetExceededError);
	});

	it("truncates lossy text deterministically below the hard limit", () => {
		const estimate = (text: string) => text.length;
		const projected = truncateTextToBudget("first line\nsecond line\nthird line", 20, estimate);
		expect(projected.truncated).toBe(true);
		expect(projected.tokens).toBeLessThanOrEqual(20);
		expect(projected.text).toBe("first line");
	});
});
