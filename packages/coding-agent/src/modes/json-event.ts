import { createHash } from "node:crypto";
import type { StopReason, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type ToJsonEvent<T> = T extends {
	type: "message_update";
	assistantMessageEvent: infer TAssistantMessageEvent;
}
	? {
			type: "message_update";
			usage: Usage;
			assistantMessageEvent: WithoutPartial<TAssistantMessageEvent>;
		}
	: T;

/** Session event shape emitted by the JSON and RPC stdout protocols. */
export type JsonAgentSessionEvent = ToJsonEvent<AgentSessionEvent>;

export type JsonEventProfile = "full" | "compact";

export type CompactJsonAgentSessionEvent =
	| { type: "message_update"; usage: Usage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; argsHash: string }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean }
	| {
			type: "message_end";
			message: {
				role: "assistant";
				content: Array<{ type: "text"; text: string }>;
				model: string;
				usage: Usage;
				stopReason: StopReason;
				errorMessage?: string;
			};
	  };

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message. Cumulative usage
 * remains available because its size is constant.
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type !== "message_update") {
		return event;
	}
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}

	const assistantMessageEvent = event.assistantMessageEvent;
	if (!("partial" in assistantMessageEvent)) {
		return { type: "message_update", usage: event.message.usage, assistantMessageEvent };
	}

	const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
	return { type: "message_update", usage: event.message.usage, assistantMessageEvent: deltaEvent };
}

/**
 * Project the session stream to the bounded fields required by process observers.
 * Tool payloads and aggregate turn/run snapshots stay inside the child session and
 * are never serialized to the compact wire stream.
 */
export function toCompactJsonEvent(event: AgentSessionEvent): CompactJsonAgentSessionEvent | undefined {
	if (event.type === "message_update") {
		if (event.message.role !== "assistant") {
			throw new Error("message_update message is not an assistant message");
		}
		return { type: "message_update", usage: event.message.usage };
	}

	if (event.type === "tool_execution_start") {
		const serializedArgs = JSON.stringify(event.args ?? null);
		return {
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			argsHash: createHash("sha256").update(serializedArgs).digest("hex"),
		};
	}

	if (event.type === "tool_execution_end") {
		return {
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		};
	}

	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;

	const content: Array<{ type: "text"; text: string }> = [];
	for (const part of event.message.content) {
		if (part.type === "text") content.push({ type: "text", text: part.text });
	}
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content,
			model: event.message.model,
			usage: event.message.usage,
			stopReason: event.message.stopReason,
			...(event.message.errorMessage ? { errorMessage: event.message.errorMessage } : {}),
		},
	};
}
