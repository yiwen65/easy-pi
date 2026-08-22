import { describe, expect, it } from "vitest";
import { evaluateTriggers, type TriggerInput } from "../../src/core/compaction/subsystem/trigger.ts";

function base(partial: Partial<TriggerInput> = {}): TriggerInput {
	return {
		predictedNextRequestTokens: 1000,
		modelContextLimit: 100000,
		recoverableToolTokens: 0,
		incrementalCompactionsSinceRebuild: 0,
		...partial,
	};
}

describe("evaluateTriggers", () => {
	it("short sessions never trigger wasteful compaction", () => {
		const r = evaluateTriggers(base());
		expect(r.action).toBe("none");
		expect(r.reasons).toEqual([]);
	});

	it("soft compaction above 70% predicted next request", () => {
		const r = evaluateTriggers(base({ predictedNextRequestTokens: 71000 }));
		expect(r.action).toBe("soft_compact");
		expect(r.reasons.some((x) => x.includes("70%"))).toBe(true);
	});

	it("hard compaction above 85% or after a call overflow", () => {
		expect(evaluateTriggers(base({ predictedNextRequestTokens: 86000 })).action).toBe("hard_compact");
		expect(evaluateTriggers(base({ predictedNextRequestTokens: 1000, previousCallOverflowed: true })).action).toBe(
			"hard_compact",
		);
	});

	it("a single huge tool output triggers offload only", () => {
		const r = evaluateTriggers(base({ recoverableToolTokens: 30000 }));
		expect(r.action).toBe("offload_only");
		expect(r.reasons.some((x) => x.includes("recoverable"))).toBe(true);
	});

	it("offload_only is preferred when offloading alone clears the 70% threshold", () => {
		const r = evaluateTriggers(base({ predictedNextRequestTokens: 75000, recoverableToolTokens: 10000 }));
		expect(r.action).toBe("offload_only");
	});

	it("phase change and manual milestones trigger soft compaction", () => {
		expect(evaluateTriggers(base({ phaseChanged: true })).action).toBe("soft_compact");
		expect(evaluateTriggers(base({ manualMilestone: true })).action).toBe("soft_compact");
	});

	it("full rebuild on incremental cap, drift, contradiction, or before high-risk irreversible actions", () => {
		expect(evaluateTriggers(base({ incrementalCompactionsSinceRebuild: 8 })).action).toBe("full_rebuild");
		expect(evaluateTriggers(base({ driftScore: 0.2 })).action).toBe("full_rebuild");
		expect(evaluateTriggers(base({ hasCriticalContradiction: true })).action).toBe("full_rebuild");
		expect(evaluateTriggers(base({ highRiskIrreversibleActionPending: true })).action).toBe("full_rebuild");
	});

	it("hysteresis: cooldown suppresses soft/offload churn near thresholds, but never hard/rebuild", () => {
		const near = base({ predictedNextRequestTokens: 70500, compactionCooldownRemaining: 2 });
		expect(evaluateTriggers(near).action).toBe("none");
		const hard = base({ predictedNextRequestTokens: 90000, compactionCooldownRemaining: 2 });
		expect(evaluateTriggers(hard).action).toBe("hard_compact");
		const rebuild = base({ incrementalCompactionsSinceRebuild: 8, compactionCooldownRemaining: 2 });
		expect(evaluateTriggers(rebuild).action).toBe("full_rebuild");
	});

	it("manual compact cannot bypass anything: it is just a soft trigger", () => {
		const r = evaluateTriggers(base({ manualMilestone: true }));
		expect(r.action).toBe("soft_compact");
		// The validator still gates the candidate; the trigger only selects the mode.
	});
});
