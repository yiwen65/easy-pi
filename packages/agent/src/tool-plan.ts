import { cloneToolSchema } from "./tool-schema.ts";
import type { AgentTool } from "./types.ts";

export interface ToolPlan {
	readonly revision: number;
	readonly identity: string;
	readonly tools: readonly AgentTool[];
	readonly bindings: Readonly<Record<string, AgentTool>>;
}

function freezeSchema(value: unknown): void {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
	for (const child of Array.isArray(value) ? value : Object.values(value)) freezeSchema(child);
	Object.freeze(value);
}

/** Build one immutable schema/handler view for a provider request and its tool calls. */
export function createToolPlan(tools: readonly AgentTool[], revision: number, identity?: string): ToolPlan {
	const plannedByName = new Map<string, AgentTool>();
	for (const tool of tools) {
		const plannedTool = {
			...tool,
			parameters: cloneToolSchema(tool.parameters),
			...(tool.contract ? { contract: cloneToolSchema(tool.contract) } : {}),
			...(tool.executionResource ? { executionResource: cloneToolSchema(tool.executionResource) } : {}),
		} as AgentTool;
		freezeSchema(plannedTool.parameters);
		freezeSchema(plannedTool.contract);
		freezeSchema(plannedTool.executionResource);
		plannedByName.set(tool.name, Object.freeze(plannedTool));
	}
	const plannedTools = [...plannedByName.values()];
	const bindings: Record<string, AgentTool> = {};
	for (const tool of plannedTools) bindings[tool.name] = tool;
	Object.freeze(bindings);
	return Object.freeze({
		revision,
		identity: identity ?? `tool-plan-${revision}`,
		tools: Object.freeze(plannedTools),
		bindings,
	});
}
