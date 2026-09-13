import { createToolPlan, type ToolPlan } from "./tool-plan.ts";
import type { AgentContext, AgentLoopConfig, ThinkingLevel } from "./types.ts";

export interface StepSnapshot {
	readonly runId?: string;
	readonly stepId: string;
	readonly model: AgentLoopConfig["model"];
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly context: AgentContext;
	readonly toolPlan: ToolPlan;
}

/** Bind model context and tools to one request step without copying transcript history. */
export function createStepSnapshot(context: AgentContext, config: AgentLoopConfig, stepNumber: number): StepSnapshot {
	const toolPlan = createToolPlan(
		context.tools ?? context.toolPlan?.tools ?? [],
		stepNumber,
		`${config.runId ?? "run"}-step-${stepNumber}`,
	);
	const plannedContext: AgentContext = {
		...context,
		tools: [...toolPlan.tools],
		toolPlan,
	};
	return Object.freeze({
		runId: config.runId,
		stepId: `${config.runId ?? "run"}-step-${stepNumber}`,
		model: config.model,
		thinkingLevel: config.reasoning,
		context: plannedContext,
		toolPlan,
	});
}
