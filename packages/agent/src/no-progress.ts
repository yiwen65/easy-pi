import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

/** Consecutive identical turn fingerprints that mark a stuck loop. */
export const NO_PROGRESS_REPEAT_LIMIT = 3;

/**
 * Stable projection of an assistant turn for no-progress fingerprinting. Only
 * the requested actions count: tool calls reduce to name + arguments.
 * Provider-assigned ids, thinking/text signatures, usage, and timestamps
 * change on every request even when the model repeats the exact same plan,
 * and assistant prose is excluded because a looping model rephrases it while
 * repeating the same tool call (e.g. `bash true` with fresh narration).
 */
export function fingerprintAssistantTurn(message: AssistantMessage): string {
	const calls = message.content
		.filter((block): block is ToolCall => block.type === "toolCall")
		.map((call) => ({ name: call.name, arguments: call.arguments, namespace: call.namespace }));
	return JSON.stringify({ stopReason: message.stopReason, errorMessage: message.errorMessage, calls });
}

/** Stable projection of a tool result: name, error flag, and model-visible content. */
export function fingerprintToolResult(message: ToolResultMessage): string {
	const content = message.content.map((block) =>
		block.type === "text" ? { type: block.type, text: block.text } : { type: block.type, mimeType: block.mimeType },
	);
	return JSON.stringify({ toolName: message.toolName, isError: message.isError, content });
}
