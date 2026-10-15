import type { SummarizationAttemptMetrics } from "../compaction.ts";

export const COMPACTION_DIAGNOSTICS_ENTRY_TYPE = "pi-compaction-diagnostics";

export interface CompactionAttemptMetrics extends SummarizationAttemptMetrics {
	provider: string;
	model: string;
	api: string;
	/** CompleteFn invocation; multiple attempts with the same index are outer retries. */
	requestIndex: number;
	promptVersion: string;
	messageCount: number;
	/** Requested effort, not proof of the provider's effective reasoning behavior. */
	reasoning?: string;
}

export interface CompactionDiagnosticsSnapshot {
	version: 1;
	reason: "manual" | "threshold" | "overflow";
	outcome: "activated" | "failed" | "aborted";
	durationMs: number;
	/** Host-only stages; auth, extension hooks and publication remain in total duration. */
	stages?: { preparationMs: number; generationMs: number; validationMs: number };
	attempts: CompactionAttemptMetrics[];
	retryCount: number;
	/** Requested outer retry sleeps; actual elapsed wait is included in generationMs. */
	scheduledRetryDelayMs: number;
}

/** One compaction lifecycle. Stores timing/model/usage metadata, never prompts, tool data or errors. */
export class CompactionDiagnostics {
	private readonly startedAt = performance.now();
	private readonly attempts: CompactionAttemptMetrics[] = [];
	private stages?: CompactionDiagnosticsSnapshot["stages"];
	private retryCount = 0;
	private scheduledRetryDelayMs = 0;

	recordAttempt(attempt: CompactionAttemptMetrics): void {
		this.attempts.push(structuredClone(attempt));
	}

	recordRetry(delayMs: number): void {
		this.retryCount++;
		this.scheduledRetryDelayMs += delayMs;
	}

	recordStages(stages: NonNullable<CompactionDiagnosticsSnapshot["stages"]>): void {
		this.stages = stages;
	}

	finish(
		reason: CompactionDiagnosticsSnapshot["reason"],
		outcome: CompactionDiagnosticsSnapshot["outcome"],
	): CompactionDiagnosticsSnapshot {
		return {
			version: 1,
			reason,
			outcome,
			durationMs: performance.now() - this.startedAt,
			stages: this.stages,
			attempts: structuredClone(this.attempts),
			retryCount: this.retryCount,
			scheduledRetryDelayMs: this.scheduledRetryDelayMs,
		};
	}
}

export type AuditEventType = "checkpoint_validated" | "checkpoint_rejected" | "provider_context";

export interface AuditEvent {
	type: AuditEventType;
	at: string;
	sessionId: string;
	details: Record<string, string | number | boolean | undefined>;
}

export class AuditTrail {
	private events: AuditEvent[] = [];

	record(type: AuditEventType, sessionId: string, details: AuditEvent["details"] = {}): void {
		this.events.push({ type, at: new Date().toISOString(), sessionId, details });
	}

	list(): AuditEvent[] {
		return [...this.events];
	}

	byType(type: AuditEventType): AuditEvent[] {
		return this.events.filter((event) => event.type === type);
	}
}
