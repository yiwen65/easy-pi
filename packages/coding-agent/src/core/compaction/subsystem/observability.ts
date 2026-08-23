/**
 * CCTX-070: Observability and audit trail.
 *
 * Every compaction run records trigger/reason, before/after tokens, zone
 * composition, offload bytes, validator/repair/reject reasons, lineage, and
 * CAS outcomes. Details carry ids, counts, and enums only — never raw
 * conversation content.
 */

export type AuditEventType =
	| "trigger"
	| "boundary_frozen"
	| "reduce"
	| "cut"
	| "offload"
	| "extract"
	| "narrative"
	| "validate"
	| "repair"
	| "rebuild"
	| "candidate_written"
	| "shadow_candidate"
	| "cas_activated"
	| "cas_conflict"
	| "reject"
	| "rollback"
	| "recall"
	| "goal_interpretation"
	| "compact_committed"
	| "commit_log_failed";

export interface AuditEvent {
	type: AuditEventType;
	at: string;
	sessionId: string;
	snapshotVersion?: number;
	/** Ids, counts, enums, and reasons only — no raw message content. */
	details: Record<string, string | number | boolean | undefined>;
}

export class AuditTrail {
	private events: AuditEvent[] = [];

	record(
		type: AuditEventType,
		sessionId: string,
		details: AuditEvent["details"] = {},
		snapshotVersion?: number,
	): void {
		this.events.push({ type, at: new Date().toISOString(), sessionId, details, snapshotVersion });
	}

	list(): AuditEvent[] {
		return [...this.events];
	}

	byType(type: AuditEventType): AuditEvent[] {
		return this.events.filter((e) => e.type === type);
	}
}
