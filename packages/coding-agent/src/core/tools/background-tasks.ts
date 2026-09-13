import {
	createTaskListTool,
	createTaskOutputTool,
	createTaskStopTool,
	createWaitForTool,
	type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { type BackgroundTaskManager, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ToolDefinition } from "../extensions/types.ts";

export const BACKGROUND_TASK_TOOL_NAMES = ["task_list", "task_output", "task_stop", "wait_for"] as const;

/**
 * Wrap the core background task tools as coding-agent tool definitions bound to the shared
 * session task manager. Rendering falls back to the default tool shell.
 */
export function createBackgroundTaskToolDefinitions(
	cwd: string,
	backgroundTasks: BackgroundTaskManager,
	options?: { onWaitForSettled?: (taskId: string) => void },
): ToolDefinition[] {
	const env = new NodeExecutionEnv({ cwd, backgroundTasks });
	const waitFor = createWaitForTool<ExecutionToolContext>();
	const onWaitForSettled = options?.onWaitForSettled;
	const waitForDefinition: ToolDefinition = {
		name: waitFor.name,
		label: waitFor.label,
		description: waitFor.description,
		parameters: waitFor.parameters,
		executionMode: waitFor.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const result = await waitFor.execute(toolCallId, params as never, signal, onUpdate, { env });
			const details = result.details as { task?: { id?: string }; timedOut?: boolean } | undefined;
			if (details?.timedOut === false && details.task?.id) onWaitForSettled?.(details.task.id);
			return result;
		},
	};
	const passthrough = [
		createTaskListTool<ExecutionToolContext>(),
		createTaskOutputTool<ExecutionToolContext>(),
		createTaskStopTool<ExecutionToolContext>(),
	];
	const definitions: ToolDefinition[] = passthrough.map((tool) => ({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		executionMode: tool.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params as never, signal, onUpdate, { env }),
	}));
	return [definitions[0], definitions[1], definitions[2], waitForDefinition];
}
