import { hasConfirmedBashExit } from "./harness/tools/bash-outcome.ts";
import { AgentToolError, type ToolExecutionOutcome } from "./types.ts";

/** Classify the execution exception before hooks can replace its details or error flag. */
export function getToolErrorOutcome(error: unknown, toolName: string, args: unknown): ToolExecutionOutcome {
	if (!(error instanceof AgentToolError)) return "unknown";
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
	return "unknown";
}
