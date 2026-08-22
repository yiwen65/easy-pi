/**
 * CCTX-050: Trigger controller (pure policy).
 *
 *   SOFT_COMPACT:  predicted next request > 70% of the model limit
 *                  OR recoverable tool tokens over threshold
 *                  OR task phase changed OR manual milestone
 *   HARD_COMPACT:  predicted > 85% OR previous call overflowed
 *   FULL_REBUILD:  incremental compaction cap reached OR drift over threshold
 *                  OR critical contradiction OR before a high-risk
 *                  irreversible action
 *
 * Offload-only is preferred when offloading recoverable tool payloads alone
 * clears the threshold. Cooldown hysteresis prevents threshold flapping, but
 * never suppresses HARD/FULL_REBUILD.
 */

export type TriggerAction = "none" | "offload_only" | "soft_compact" | "hard_compact" | "full_rebuild";

export interface TriggerInput {
	/** Predicted full next request: system+tools+contract+snapshot+narrative+tail+recall+output reserve. */
	predictedNextRequestTokens: number;
	modelContextLimit: number;
	/** Tokens recoverable by offloading tool results alone. */
	recoverableToolTokens: number;
	/** Absolute token threshold for offload-only. Default 8192. */
	recoverableThreshold?: number;
	softFraction?: number; // default 0.70
	hardFraction?: number; // default 0.85
	phaseChanged?: boolean;
	manualMilestone?: boolean;
	previousCallOverflowed?: boolean;
	incrementalCompactionsSinceRebuild: number;
	maxIncrementalCompactions?: number; // default 8
	driftScore?: number; // 0..1
	driftThreshold?: number; // default 0.05
	hasCriticalContradiction?: boolean;
	highRiskIrreversibleActionPending?: boolean;
	compactionCooldownRemaining?: number;
}

export interface TriggerDecision {
	action: TriggerAction;
	reasons: string[];
}

export function evaluateTriggers(input: TriggerInput): TriggerDecision {
	const softLimit = (input.softFraction ?? 0.7) * input.modelContextLimit;
	const hardLimit = (input.hardFraction ?? 0.85) * input.modelContextLimit;
	const recoverableThreshold = input.recoverableThreshold ?? 8192;
	const maxIncremental = input.maxIncrementalCompactions ?? 8;
	const driftThreshold = input.driftThreshold ?? 0.05;
	const cooldown = (input.compactionCooldownRemaining ?? 0) > 0;

	// FULL_REBUILD first: it overrides everything and ignores cooldown.
	const rebuildReasons: string[] = [];
	if (input.incrementalCompactionsSinceRebuild >= maxIncremental) {
		rebuildReasons.push(
			`incremental compactions ${input.incrementalCompactionsSinceRebuild} reached cap ${maxIncremental}`,
		);
	}
	if ((input.driftScore ?? 0) > driftThreshold) {
		rebuildReasons.push(`drift ${input.driftScore} exceeds threshold ${driftThreshold}`);
	}
	if (input.hasCriticalContradiction) {
		rebuildReasons.push("critical contradiction detected");
	}
	if (input.highRiskIrreversibleActionPending) {
		rebuildReasons.push("high-risk irreversible action pending");
	}
	if (rebuildReasons.length > 0) {
		return { action: "full_rebuild", reasons: rebuildReasons };
	}

	// HARD_COMPACT: never suppressed by cooldown.
	if (input.predictedNextRequestTokens > hardLimit) {
		return {
			action: "hard_compact",
			reasons: [`predicted next request ${input.predictedNextRequestTokens} > 85% limit (${Math.floor(hardLimit)})`],
		};
	}
	if (input.previousCallOverflowed) {
		return { action: "hard_compact", reasons: ["previous call overflowed the context window"] };
	}

	// Below hard: cooldown suppresses soft/offload churn.
	if (cooldown) {
		return { action: "none", reasons: ["cooldown active (hysteresis)"] };
	}

	// Offload-only: big recoverable tool payloads, or offloading alone clears soft threshold.
	const overSoft = input.predictedNextRequestTokens > softLimit;
	const offloadable = input.recoverableToolTokens >= recoverableThreshold;
	if (offloadable) {
		if (!overSoft) {
			return {
				action: "offload_only",
				reasons: [`recoverable tool tokens ${input.recoverableToolTokens} >= threshold ${recoverableThreshold}`],
			};
		}
		const afterOffload = input.predictedNextRequestTokens - input.recoverableToolTokens;
		if (afterOffload <= softLimit) {
			return {
				action: "offload_only",
				reasons: [
					`offloading ${input.recoverableToolTokens} recoverable tokens brings predicted ${input.predictedNextRequestTokens} under 70% limit`,
				],
			};
		}
	}

	// SOFT_COMPACT.
	const softReasons: string[] = [];
	if (overSoft) {
		softReasons.push(
			`predicted next request ${input.predictedNextRequestTokens} > 70% limit (${Math.floor(softLimit)})`,
		);
	}
	if (input.phaseChanged) softReasons.push("task phase changed");
	if (input.manualMilestone) softReasons.push("manual milestone");
	if (softReasons.length > 0) {
		return { action: "soft_compact", reasons: softReasons };
	}

	return { action: "none", reasons: [] };
}
