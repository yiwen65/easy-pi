import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { SessionEntry } from "../../core/session-manager.ts";

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type TurnEndEvent = Extract<AgentSessionEvent, { type: "turn_end" }>;
type CompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;

/**
 * Presentation-neutral events emitted by the Pi session adapter.
 *
 * This union deliberately describes Pi behavior rather than a concrete TUI
 * action type so the presentation package can evolve independently.
 */
export type PiSessionUiEvent =
	| { sequence: number; kind: "agent"; phase: "start" }
	| {
			sequence: number;
			kind: "agent";
			phase: "end";
			messages: readonly AgentMessage[];
			willRetry: boolean;
	  }
	| { sequence: number; kind: "agent"; phase: "settled" }
	| { sequence: number; kind: "turn"; phase: "start" }
	| {
			sequence: number;
			kind: "turn";
			phase: "end";
			message: TurnEndEvent["message"];
			toolResults: TurnEndEvent["toolResults"];
	  }
	| { sequence: number; kind: "message"; phase: "start" | "end"; message: AgentMessage }
	| {
			sequence: number;
			kind: "message";
			phase: "update";
			message: MessageUpdateEvent["message"];
			assistantMessageEvent: MessageUpdateEvent["assistantMessageEvent"];
	  }
	| {
			sequence: number;
			kind: "tool";
			phase: "start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			sequence: number;
			kind: "tool";
			phase: "update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: unknown;
	  }
	| {
			sequence: number;
			kind: "tool";
			phase: "end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
	  }
	| {
			sequence: number;
			kind: "queue";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| {
			sequence: number;
			kind: "compaction";
			phase: "start";
			reason: "manual" | "threshold" | "overflow";
	  }
	| {
			sequence: number;
			kind: "compaction";
			phase: "end";
			reason: CompactionEndEvent["reason"];
			result: CompactionEndEvent["result"];
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			sequence: number;
			kind: "retry";
			phase: "start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			sequence: number;
			kind: "retry";
			phase: "end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| {
			sequence: number;
			kind: "summarization-retry";
			phase: "scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			sequence: number;
			kind: "summarization-retry";
			phase: "attempt-start";
			source: "branchSummary" | "compaction";
			reason?: "manual" | "threshold" | "overflow";
	  }
	| { sequence: number; kind: "summarization-retry"; phase: "finished" }
	| { sequence: number; kind: "session-entry"; entry: SessionEntry }
	| { sequence: number; kind: "session-info"; name: string | undefined }
	| {
			sequence: number;
			kind: "thinking-level";
			level: Extract<AgentSessionEvent, { type: "thinking_level_changed" }>["level"];
	  }
	| { sequence: number; kind: "bash-output"; id: string | undefined; delta: string };

function unreachableEvent(event: never): never {
	throw new Error(`Unhandled AgentSessionEvent: ${JSON.stringify(event)}`);
}

/** Map exactly one source event to exactly one ordered presentation event. */
export function mapAgentSessionEvent(event: AgentSessionEvent, sequence: number): PiSessionUiEvent {
	switch (event.type) {
		case "agent_start":
			return { sequence, kind: "agent", phase: "start" };
		case "agent_end":
			return { sequence, kind: "agent", phase: "end", messages: [...event.messages], willRetry: event.willRetry };
		case "agent_settled":
			return { sequence, kind: "agent", phase: "settled" };
		case "turn_start":
			return { sequence, kind: "turn", phase: "start" };
		case "turn_end":
			return {
				sequence,
				kind: "turn",
				phase: "end",
				message: event.message,
				toolResults: [...event.toolResults],
			};
		case "message_start":
			return { sequence, kind: "message", phase: "start", message: event.message };
		case "message_update":
			return {
				sequence,
				kind: "message",
				phase: "update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
		case "message_end":
			return { sequence, kind: "message", phase: "end", message: event.message };
		case "tool_execution_start":
			return {
				sequence,
				kind: "tool",
				phase: "start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
		case "tool_execution_update":
			return {
				sequence,
				kind: "tool",
				phase: "update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
		case "tool_execution_end":
			return {
				sequence,
				kind: "tool",
				phase: "end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
		case "queue_update":
			return { sequence, kind: "queue", steering: [...event.steering], followUp: [...event.followUp] };
		case "compaction_start":
			return { sequence, kind: "compaction", phase: "start", reason: event.reason };
		case "compaction_end":
			return {
				sequence,
				kind: "compaction",
				phase: "end",
				reason: event.reason,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
			};
		case "auto_retry_start":
			return {
				sequence,
				kind: "retry",
				phase: "start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			};
		case "auto_retry_end":
			return {
				sequence,
				kind: "retry",
				phase: "end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
			};
		case "summarization_retry_scheduled":
			return {
				sequence,
				kind: "summarization-retry",
				phase: "scheduled",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			};
		case "summarization_retry_attempt_start":
			return event.source === "compaction"
				? {
						sequence,
						kind: "summarization-retry",
						phase: "attempt-start",
						source: event.source,
						reason: event.reason,
					}
				: {
						sequence,
						kind: "summarization-retry",
						phase: "attempt-start",
						source: event.source,
					};
		case "summarization_retry_finished":
			return { sequence, kind: "summarization-retry", phase: "finished" };
		case "entry_appended":
			return { sequence, kind: "session-entry", entry: event.entry };
		case "session_info_changed":
			return { sequence, kind: "session-info", name: event.name };
		case "thinking_level_changed":
			return { sequence, kind: "thinking-level", level: event.level };
		case "bash_execution_update":
			return { sequence, kind: "bash-output", id: event.id, delta: event.delta };
		default:
			return unreachableEvent(event);
	}
}
