/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

export interface SkillPromptDetails {
	name: string;
	path: string;
}

export type SkillPromptMessage = CustomMessage<SkillPromptDetails> & {
	customType: typeof SKILL_PROMPT_MESSAGE_TYPE;
	display: true;
	details: SkillPromptDetails;
};

/** Parsed model-visible skill instructions, including legacy inline user messages. */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/** Build one Codex-style, model-visible user context fragment for a selected skill. */
export function createSkillPromptMessage(
	name: string,
	path: string,
	baseDir: string,
	contents: string,
	timestamp = Date.now(),
): SkillPromptMessage {
	return {
		role: "custom",
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: `<skill>\n<name>${name}</name>\n<path>${path}</path>\nReferences are relative to ${baseDir}.\n\n${contents}\n</skill>`,
		display: true,
		details: { name, path },
		timestamp,
	};
}

export function isSkillPromptMessage(message: CustomMessage): message is SkillPromptMessage {
	return (
		message.customType === SKILL_PROMPT_MESSAGE_TYPE &&
		typeof message.details === "object" &&
		message.details !== null &&
		"name" in message.details &&
		typeof message.details.name === "string" &&
		"path" in message.details &&
		typeof message.details.path === "string"
	);
}

/** Parse current Codex-style skill fragments and legacy Pi inline skill blocks. */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const structuredMatch = text.match(
		/^<skill>\n<name>([^\n]*)<\/name>\n<path>([^\n]*)<\/path>\n([\s\S]*?)\n<\/skill>$/,
	);
	if (structuredMatch) {
		return {
			name: structuredMatch[1],
			location: structuredMatch[2],
			content: structuredMatch[3],
			userMessage: undefined,
		};
	}

	const legacyMatch = text.match(
		/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
	);
	if (!legacyMatch) return null;
	return {
		name: legacyMatch[1],
		location: legacyMatch[2],
		content: legacyMatch[3],
		userMessage: legacyMatch[4]?.trim() || undefined,
	};
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	estimatedTokensAfter?: number,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		...(estimatedTokensAfter !== undefined ? { estimatedTokensAfter } : {}),
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
