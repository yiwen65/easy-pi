/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import { type AgentTool, AgentToolError, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { combineNestedUsage } from "../nested-tool-calls.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition);
	const execute = registeredTool.definition.execute.bind(registeredTool.definition);
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const activeBefore = runner.getActiveTools();
			const context = runner.createToolContext(toolCallId, signal);
			let result: AgentToolResult<unknown> | undefined;
			let failure: unknown;
			let failed = false;
			try {
				result = await execute(toolCallId, params, context.signal, onUpdate, context);
			} catch (error) {
				failure = error;
				failed = true;
			}
			const summary = await runner.finishToolContext(context);
			if (failed && !summary.calls && !summary.usage && summary.executionOutcome === "confirmed") throw failure;
			const usage = result?.usage ?? (failure instanceof AgentToolError ? failure.usage : undefined);
			const totalUsage =
				usage && summary.usage ? combineNestedUsage(usage, summary.usage) : (usage ?? summary.usage);
			if (failed || summary.executionOutcome === "unknown") {
				const outcome =
					summary.executionOutcome === "unknown"
						? "unknown"
						: failure instanceof AgentToolError
							? failure.executionOutcome
							: "unknown";
				throw new AgentToolError(
					summary.executionOutcome === "unknown"
						? "A nested tool has an unknown outcome; inspect external state before repeating this operation"
						: failure instanceof Error
							? failure.message
							: String(failure),
					failure instanceof AgentToolError ? failure.details : (result?.details ?? {}),
					{
						...(outcome === "unknown" ? {} : { executionOutcome: outcome }),
						structuredContent:
							failure instanceof AgentToolError ? failure.structuredContent : result?.structuredContent,
						nestedCalls: summary.calls,
						nestedExecutionOutcome:
							summary.executionOutcome === "unknown"
								? "unknown"
								: failure instanceof AgentToolError
									? failure.nestedExecutionOutcome
									: undefined,
						usage: totalUsage,
						cause: failure,
					},
				);
			}
			if (!result) throw new Error(`Tool "${tool.name}" returned no result`);
			result = {
				...result,
				...(summary.calls ? { nestedCalls: summary.calls } : {}),
				...(totalUsage ? { usage: totalUsage } : {}),
			};
			const activeAfter = runner.getActiveTools();
			if (!activeBefore.every((name) => activeAfter.includes(name))) return result;

			const beforeNames = new Set(activeBefore);
			const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
			if (addedToolNames.length === 0) return result;
			return {
				...result,
				addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
			};
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
