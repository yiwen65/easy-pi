/**
 * CCTX-050: Compaction trigger policy.
 *
 * The trigger answers one question only: may compaction replace the active
 * provider context now? Execution always uses the same full pipeline. Tool
 * payload size, semantic drift, and rebuild cadence are therefore not trigger
 * inputs and cannot invalidate the provider cache on their own.
 */

export type TriggerAction = "none" | "compact";
export const DEFAULT_COMPACTION_TRIGGER_FRACTION = 0.95;

export interface TriggerInput {
	/** Predicted full next request: system + tools + active messages + output reserve. */
	predictedNextRequestTokens: number;
	modelContextLimit: number;
	/** Fraction at which automatic compaction opens. Default 0.95. */
	triggerFraction?: number;
	/** Explicit user/manual compaction request. Automatic callers leave this false. */
	manual?: boolean;
	previousCallOverflowed?: boolean;
	/** The last successful compaction already projected this exact provider-visible context. */
	sameProviderContextAsLastCompaction?: boolean;
}

export interface TriggerDecision {
	action: TriggerAction;
	reasons: string[];
	/** Complete-request size at which automatic compaction opens. */
	triggerTokens: number;
	/** Overflow recovery cannot be suppressed by same-context deduplication. */
	overflowRecovery: boolean;
}

export function evaluateTriggers(input: TriggerInput): TriggerDecision {
	const triggerFraction = input.triggerFraction ?? DEFAULT_COMPACTION_TRIGGER_FRACTION;
	const triggerTokens = Math.floor(triggerFraction * input.modelContextLimit);
	const none = (reasons: string[] = []): TriggerDecision => ({
		action: "none",
		reasons,
		triggerTokens,
		overflowRecovery: false,
	});

	if (input.previousCallOverflowed) {
		return {
			action: "compact",
			reasons: ["previous call overflowed the context window"],
			triggerTokens,
			overflowRecovery: true,
		};
	}
	if (input.manual) {
		return {
			action: "compact",
			reasons: ["explicit manual compaction request"],
			triggerTokens,
			overflowRecovery: false,
		};
	}
	if (input.sameProviderContextAsLastCompaction) {
		return none(["same provider context already compacted"]);
	}
	if (input.predictedNextRequestTokens >= triggerTokens) {
		return {
			action: "compact",
			reasons: [
				`predicted next request ${input.predictedNextRequestTokens} >= ${Math.round(triggerFraction * 100)}% limit (${triggerTokens})`,
			],
			triggerTokens,
			overflowRecovery: false,
		};
	}

	return none();
}
