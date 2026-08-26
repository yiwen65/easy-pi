/**
 * Provider-context identity helpers.
 *
 * These helpers deliberately describe the logical request handed to a provider
 * adapter. They exclude runtime metadata that providers do not replay (usage,
 * timestamps, UI details), while preserving ordered messages, tool schemas,
 * opaque replay signatures, and model identity. Adapter/chat-template token
 * identity remains the final authority when a provider exposes it.
 */

import type { Message, Tool } from "@earendil-works/pi-ai";
import { canonicalJson, sha256Hex } from "./hashing.ts";

export type ContextChangeReason = "no_trigger" | "compaction_activate" | "navigation" | "explicit_config_change";

export interface ProviderModelIdentity {
	provider: string;
	model: string;
	api?: string;
	chatTemplate?: string;
}

export interface ProviderContextIdentityInput {
	model?: ProviderModelIdentity;
	systemPrompt?: string;
	messages: readonly Message[];
	tools?: readonly Tool[];
	/** Number of leading messages whose immutability should be checked. */
	historicalMessageCount?: number;
}

export interface ProviderContextIdentity {
	fullHash: string;
	historicalPrefixHash: string;
	messageCount: number;
	historicalMessageCount: number;
}

export interface ProviderContextObservation extends ProviderContextIdentity {
	reason: ContextChangeReason;
	prefixPreserved: boolean;
	previousFullHash?: string;
	firstDifference?: string;
}

interface ProviderContextView {
	model?: ProviderModelIdentity;
	systemPrompt?: string;
	messages: unknown[];
	tools: unknown[];
}

function providerMessageView(message: Message): unknown {
	switch (message.role) {
		case "user":
			return { role: message.role, content: message.content };
		case "assistant":
			return {
				role: message.role,
				content: message.content,
				responseId: message.responseId,
				deferred: message.deferred,
			};
		case "toolResult":
			return {
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				addedToolNames: message.addedToolNames,
				isError: message.isError,
			};
	}
}

function providerToolView(tool: Tool): unknown {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		constrainedSampling: tool.constrainedSampling,
	};
}

function contextView(input: ProviderContextIdentityInput, messageCount = input.messages.length): ProviderContextView {
	return {
		model: input.model,
		systemPrompt: input.systemPrompt,
		messages: input.messages.slice(0, messageCount).map(providerMessageView),
		tools: (input.tools ?? []).map(providerToolView),
	};
}

export function identifyProviderContext(input: ProviderContextIdentityInput): ProviderContextIdentity {
	const historicalMessageCount = Math.max(
		0,
		Math.min(input.messages.length, input.historicalMessageCount ?? input.messages.length),
	);
	return {
		fullHash: sha256Hex(canonicalJson(contextView(input))),
		historicalPrefixHash: sha256Hex(canonicalJson(contextView(input, historicalMessageCount))),
		messageCount: input.messages.length,
		historicalMessageCount,
	};
}

/** True when the next request preserves the complete previous logical request and only appends messages. */
export function preservesProviderContextPrefix(
	previous: ProviderContextIdentityInput,
	next: ProviderContextIdentityInput,
): boolean {
	if (next.messages.length < previous.messages.length) return false;
	return canonicalJson(contextView(previous)) === canonicalJson(contextView(next, previous.messages.length));
}

/** Return the first canonical logical-request path that differs, for cache-miss diagnostics. */
export function firstProviderContextDifference(
	left: ProviderContextIdentityInput,
	right: ProviderContextIdentityInput,
): string | undefined {
	return firstDifference(contextView(left), contextView(right), "$");
}

function firstDifference(left: unknown, right: unknown, path: string): string | undefined {
	if (Object.is(left, right)) return undefined;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return path;
		const length = Math.max(left.length, right.length);
		for (let index = 0; index < length; index++) {
			const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
			if (difference) return difference;
		}
		return undefined;
	}
	if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
		const leftRecord = left as Record<string, unknown>;
		const rightRecord = right as Record<string, unknown>;
		const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
		for (const key of keys) {
			const difference = firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
			if (difference) return difference;
		}
		return undefined;
	}
	return path;
}
