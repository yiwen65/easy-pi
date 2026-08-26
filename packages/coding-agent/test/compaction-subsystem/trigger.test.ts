import { describe, expect, it } from "vitest";
import { evaluateTriggers, type TriggerInput } from "../../src/core/compaction/subsystem/trigger.ts";

function base(partial: Partial<TriggerInput> = {}): TriggerInput {
	return {
		predictedNextRequestTokens: 1000,
		modelContextLimit: 100000,
		...partial,
	};
}

describe("evaluateTriggers", () => {
	it("does not compact a short session", () => {
		expect(evaluateTriggers(base())).toEqual({
			action: "none",
			reasons: [],
			triggerTokens: 95000,
			overflowRecovery: false,
		});
	});

	it("selects the single compact action exactly at the 95% complete-request boundary", () => {
		const decision = evaluateTriggers(base({ predictedNextRequestTokens: 95000 }));
		expect(decision.action).toBe("compact");
		expect(decision.triggerTokens).toBe(95000);
		expect(decision.reasons[0]).toContain("95% limit");
		expect(evaluateTriggers(base({ predictedNextRequestTokens: 94999 })).action).toBe("none");
	});

	it("supports one configurable trigger fraction without changing execution mode", () => {
		const decision = evaluateTriggers(base({ predictedNextRequestTokens: 76000, triggerFraction: 0.75 }));
		expect(decision).toMatchObject({ action: "compact", triggerTokens: 75000 });
		expect(decision.reasons[0]).toContain("75% limit");
	});

	it("manual compaction uses the same action without defining a post-compaction target", () => {
		expect(evaluateTriggers(base({ manual: true }))).toMatchObject({
			action: "compact",
			triggerTokens: 95000,
			overflowRecovery: false,
		});
	});

	it("deduplicates the exact provider context already compacted", () => {
		expect(
			evaluateTriggers(base({ predictedNextRequestTokens: 100000, sameProviderContextAsLastCompaction: true })),
		).toMatchObject({ action: "none", reasons: ["same provider context already compacted"] });
	});

	it("a changed provider context beyond the window uses the same compact action", () => {
		expect(evaluateTriggers(base({ predictedNextRequestTokens: 110000 }))).toMatchObject({
			action: "compact",
			overflowRecovery: false,
		});
	});

	it("overflow bypasses same-context deduplication and is marked as recovery", () => {
		expect(
			evaluateTriggers(base({ previousCallOverflowed: true, sameProviderContextAsLastCompaction: true })),
		).toMatchObject({
			action: "compact",
			overflowRecovery: true,
			reasons: ["previous call overflowed the context window"],
		});
	});
});
