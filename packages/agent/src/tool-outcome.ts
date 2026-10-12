import { hasConfirmedBashExit } from "./harness/tools/bash-outcome.ts";
import { AgentToolError, type ToolContract, type ToolExecutionOutcome } from "./types.ts";

/** The parts of a tool that decide whether an unresolved outcome can require reconciliation. */
export interface ReplaySafeToolLike {
	/** Declarative execution contract; absent fields mean no guarantees. */
	contract?: ToolContract;
	/** Orchestrators compose other calls, so their nested effects decide the outcome. */
	orchestratesTools?: boolean;
}

/**
 * Whether repeating the same call is harmless: a read-only, idempotent, or side-effect-free tool
 * cannot leave an unresolved effect behind, so its failures never need reconciliation. Orchestrators
 * are excluded because their unresolved effects belong to the calls they compose.
 */
export function isReplaySafeTool(tool: ReplaySafeToolLike | undefined): boolean {
	if (!tool || tool.orchestratesTools) return false;
	const contract = tool.contract;
	return contract?.readOnly === true || contract?.idempotent === true || contract?.sideEffects === "none";
}

/** Classify the execution exception before hooks can replace its details or error flag. */
export function getToolErrorOutcome(
	error: unknown,
	toolName: string,
	args: unknown,
	tool?: ReplaySafeToolLike,
): ToolExecutionOutcome {
	if (error instanceof AgentToolError) {
		// A composed unresolved effect is never downgraded by the failing tool's own contract.
		if (error.nestedExecutionOutcome === "unknown") return "unknown";
		// An outcome proven at the throw site is more precise than the contract.
		if (error.executionOutcome === "not_started" || error.executionOutcome === "confirmed")
			return error.executionOutcome;
		if (
			hasConfirmedBashExit(toolName, error.details) &&
			args !== null &&
			typeof args === "object" &&
			"command" in args &&
			error.details.command === args.command
		)
			return "confirmed";
	}
	// A replay-safe tool cannot leave an unresolved effect, so its failure needs no reconciliation.
	return isReplaySafeTool(tool) ? "confirmed" : "unknown";
}
