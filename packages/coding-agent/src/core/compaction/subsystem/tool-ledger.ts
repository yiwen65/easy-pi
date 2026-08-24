/**
 * CCTX-013: Tool & side-effect ledger.
 *
 * Completion and side-effect status come only from recorded evidence, never
 * from summaries. State machine (monotonic, terminal succeeded/failed):
 *
 *   planned → approved → started → succeeded | failed | unknown
 *
 * `unknown` marks interrupted operations (timeout/network drop). Unknown is
 * never blindly replayed: recovery must query real external state first, then
 * resolve to succeeded/failed by verification.
 *
 * The ledger is event-sourced: every transition appends a ledger event to the
 * event log, and replayLedger() rebuilds identical state from those events.
 */

import type { EventLog } from "./event-log.ts";
import type { Authority, LedgerEntry, RiskLevel, SideEffectClass, SideEffectState } from "./types.ts";

const LEGAL_TRANSITIONS: Record<SideEffectState, SideEffectState[]> = {
	planned: ["approved", "started", "failed", "unknown"],
	approved: ["started", "unknown"],
	started: ["succeeded", "failed", "unknown"],
	unknown: ["succeeded", "failed"], // resolution requires external verification
	succeeded: [],
	failed: [],
};

export interface PlannedInput {
	operationId: string;
	toolCallId: string;
	idempotencyKey?: string;
	sideEffectClass: SideEffectClass;
	riskLevel: RiskLevel;
	requestRef?: string;
	authority: Authority;
}

export interface CompletionInput {
	exitCode?: number;
	resultRef?: string;
	externalResourceId?: string;
	error?: string;
}

export interface LedgerEventPayload {
	kind: "ledger_transition";
	toolCallId: string;
	operationId: string;
	to: SideEffectState;
	idempotencyKey?: string;
	sideEffectClass?: SideEffectClass;
	riskLevel?: RiskLevel;
	requestRef?: string;
	completion?: CompletionInput;
	approval?: { approvedBy: Authority; at: string };
	reason?: string;
}

export class ToolLedger {
	private entries = new Map<string, LedgerEntry>();
	private byKey = new Map<string, LedgerEntry>();
	private eventLog: EventLog | undefined;
	private sessionId: string | undefined;
	private agentId: string | undefined;

	constructor(options?: { eventLog?: EventLog; sessionId?: string; agentId?: string }) {
		this.bind(options);
	}

	/** Rebind durable emission after a read-only replay. */
	bind(options?: { eventLog?: EventLog; sessionId?: string; agentId?: string }): void {
		this.eventLog = options?.eventLog;
		this.sessionId = options?.sessionId;
		this.agentId = options?.agentId;
	}

	private emit(payload: LedgerEventPayload): void {
		if (!this.eventLog || !this.sessionId || !this.agentId) return;
		this.eventLog.append({
			sessionId: this.sessionId,
			agentId: this.agentId,
			eventType: "ledger",
			toolCallId: payload.toolCallId,
			payload,
			authority: { kind: "system", id: "tool-ledger", verified: true },
		});
	}

	private assertTransition(entry: LedgerEntry, to: SideEffectState, what: string): void {
		const legal = LEGAL_TRANSITIONS[entry.state];
		if (!legal.includes(to)) {
			if (entry.state === "succeeded" || entry.state === "failed") {
				throw new Error(`Illegal ledger transition: ${entry.state} is terminal, cannot become ${to} (${what})`);
			}
			throw new Error(`Illegal ledger transition: ${entry.state} → ${to} (${what})`);
		}
	}

	private transition(entry: LedgerEntry, to: SideEffectState, what: string): void {
		this.assertTransition(entry, to, what);
		entry.state = to;
		entry.history.push({ state: to, at: new Date().toISOString(), eventId: `ledger-${entry.history.length + 1}` });
		entry.lastVerifiedAt = new Date().toISOString();
	}

	private mustGet(toolCallId: string): LedgerEntry {
		const entry = this.entries.get(toolCallId);
		if (!entry) throw new Error(`Unknown tool call ${toolCallId}`);
		return entry;
	}

	recordPlanned(input: PlannedInput): LedgerEntry {
		if (input.idempotencyKey) {
			const existing = this.byKey.get(input.idempotencyKey);
			if (existing) {
				// Same idempotency key: the operation already exists. Never create a
				// duplicate side-effecting operation.
				return existing;
			}
		}
		if (this.entries.has(input.toolCallId)) {
			throw new Error(`Ledger entry for ${input.toolCallId} already exists`);
		}
		const entry: LedgerEntry = {
			operationId: input.operationId,
			toolCallId: input.toolCallId,
			idempotencyKey: input.idempotencyKey,
			sideEffectClass: input.sideEffectClass,
			riskLevel: input.riskLevel,
			requestRef: input.requestRef,
			state: "planned",
			history: [{ state: "planned", at: new Date().toISOString(), eventId: "ledger-1" }],
		};
		this.emit({
			kind: "ledger_transition",
			toolCallId: input.toolCallId,
			operationId: input.operationId,
			to: "planned",
			idempotencyKey: input.idempotencyKey,
			sideEffectClass: input.sideEffectClass,
			riskLevel: input.riskLevel,
			requestRef: input.requestRef,
		});
		this.entries.set(input.toolCallId, entry);
		if (input.idempotencyKey) this.byKey.set(input.idempotencyKey, entry);
		return entry;
	}

	recordApproved(toolCallId: string, approval: { approvedBy: Authority; at: string }): LedgerEntry {
		if (!approval.approvedBy.verified) {
			throw new Error("Approval requires a verified approver");
		}
		const entry = this.mustGet(toolCallId);
		this.assertTransition(entry, "approved", "recordApproved");
		this.emit({ kind: "ledger_transition", toolCallId, operationId: entry.operationId, to: "approved", approval });
		this.transition(entry, "approved", "recordApproved");
		entry.approval = approval;
		return entry;
	}

	recordStarted(toolCallId: string, options?: { requiresApproval?: boolean }): LedgerEntry {
		const entry = this.mustGet(toolCallId);
		if (options?.requiresApproval && entry.state === "planned") {
			throw new Error(`Tool call ${toolCallId} requires approval before it can start`);
		}
		this.assertTransition(entry, "started", "recordStarted");
		this.emit({ kind: "ledger_transition", toolCallId, operationId: entry.operationId, to: "started" });
		this.transition(entry, "started", "recordStarted");
		return entry;
	}

	recordSucceeded(toolCallId: string, completion: CompletionInput): LedgerEntry {
		const entry = this.mustGet(toolCallId);
		this.assertTransition(entry, "succeeded", "recordSucceeded");
		this.emit({
			kind: "ledger_transition",
			toolCallId,
			operationId: entry.operationId,
			to: "succeeded",
			completion,
		});
		this.transition(entry, "succeeded", "recordSucceeded");
		entry.exitCode = completion.exitCode;
		entry.resultRef = completion.resultRef ?? entry.resultRef;
		entry.externalResourceId = completion.externalResourceId ?? entry.externalResourceId;
		return entry;
	}

	recordFailed(toolCallId: string, completion: CompletionInput): LedgerEntry {
		const entry = this.mustGet(toolCallId);
		this.assertTransition(entry, "failed", "recordFailed");
		this.emit({ kind: "ledger_transition", toolCallId, operationId: entry.operationId, to: "failed", completion });
		this.transition(entry, "failed", "recordFailed");
		entry.exitCode = completion.exitCode;
		entry.resultRef = completion.resultRef ?? entry.resultRef;
		return entry;
	}

	/** Mark an in-flight operation whose outcome is unknowable (timeout, disconnect). */
	recordUnknown(toolCallId: string, reason: string): LedgerEntry {
		const entry = this.mustGet(toolCallId);
		this.assertTransition(entry, "unknown", "recordUnknown");
		this.emit({ kind: "ledger_transition", toolCallId, operationId: entry.operationId, to: "unknown", reason });
		this.transition(entry, "unknown", "recordUnknown");
		return entry;
	}

	get(toolCallId: string): LedgerEntry | undefined {
		return this.entries.get(toolCallId);
	}

	byIdempotencyKey(key: string): LedgerEntry[] {
		const entry = this.byKey.get(key);
		return entry ? [entry] : [];
	}

	list(): LedgerEntry[] {
		return [...this.entries.values()];
	}

	/** True only when the operation has evidence-backed terminal status. */
	isComplete(toolCallId: string): boolean {
		const entry = this.entries.get(toolCallId);
		return entry !== undefined && (entry.state === "succeeded" || entry.state === "failed");
	}

	/**
	 * Recovery check before any retry: returns the existing operation for this
	 * idempotency key. A non-terminal (especially `unknown`) state means the
	 * caller MUST query the external system for real state instead of replaying.
	 */
	wouldReplay(idempotencyKey: string): LedgerEntry | undefined {
		return this.byKey.get(idempotencyKey);
	}
}

/**
 * Rebuild a ledger from ledger events (event-sourced recovery).
 * Events of other types are ignored.
 */
export function replayLedger(
	events: { eventType: string; payload?: unknown }[],
	options?: { eventLog?: EventLog; sessionId?: string; agentId?: string },
): ToolLedger {
	const ledger = new ToolLedger();
	for (const event of events) {
		if (event.eventType !== "ledger") continue;
		const payload = event.payload as LedgerEventPayload | undefined;
		if (!payload || payload.kind !== "ledger_transition") continue;
		switch (payload.to) {
			case "planned": {
				const existing = payload.idempotencyKey ? ledger.wouldReplay(payload.idempotencyKey) : undefined;
				if (!existing) {
					ledger.recordPlanned({
						operationId: payload.operationId,
						toolCallId: payload.toolCallId,
						idempotencyKey: payload.idempotencyKey,
						sideEffectClass: payload.sideEffectClass ?? "none",
						riskLevel: payload.riskLevel ?? "low",
						requestRef: payload.requestRef,
						authority: { kind: "system", id: "ledger-replay", verified: true },
					});
				}
				break;
			}
			case "approved":
				ledger.recordApproved(
					payload.toolCallId,
					payload.approval ?? { approvedBy: { kind: "system", id: "replay", verified: true }, at: "" },
				);
				break;
			case "started":
				ledger.recordStarted(payload.toolCallId);
				break;
			case "succeeded":
				ledger.recordSucceeded(payload.toolCallId, payload.completion ?? {});
				break;
			case "failed":
				ledger.recordFailed(payload.toolCallId, payload.completion ?? {});
				break;
			case "unknown":
				ledger.recordUnknown(payload.toolCallId, payload.reason ?? "replay");
				break;
		}
	}
	ledger.bind(options);
	return ledger;
}
