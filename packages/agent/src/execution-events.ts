/**
 * Redacted runtime phases. A phase may emit a `started` event followed by one
 * terminal outcome; `execution_result` is terminal-only for work that never
 * reached a handler (for example, denial or cancellation).
 */
export type AgentExecutionPhase =
	| "provider_request"
	| "tool_admission"
	| "scheduler_wait"
	| "tool_execution"
	| "execution_result";

export interface AgentExecutionEvent {
	readonly phase: AgentExecutionPhase;
	readonly runId?: string;
	readonly stepId?: string;
	readonly toolPlanRevision?: number;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly outcome?: "started" | "succeeded" | "failed" | "denied" | "cancelled";
	readonly reason?: string;
	readonly durationMs?: number;
}

export type AgentExecutionObserver = (event: AgentExecutionEvent) => void;
