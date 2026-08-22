/**
 * CCTX-061: Multi-agent consistency primitives over a shared event log.
 *
 * Each agent keeps its own active view (agentView). Shared task/decision/
 * artifact state goes through SharedRegistry with field-level conflict
 * detection — concurrent divergence is surfaced, never silently
 * last-write-wins. Cross-agent side effects are deduplicated by idempotency
 * key. Handoffs use structured capsules, not prose.
 */

import type { EventEnvelope } from "./types.ts";

/**
 * Per-agent projection of a shared log. Causal parent ids are preserved even
 * when they point at events owned by other agents (the view is a filter, not
 * a rewrite).
 */
export function agentView(events: EventEnvelope[], agentId: string): EventEnvelope[] {
	return events.filter((e) => e.agentId === agentId);
}

// ============================================================================
// Shared registry with field-level conflict detection
// ============================================================================

export interface FieldConflict {
	kind: string;
	id: string;
	field: string;
	currentValue: unknown;
	attemptedValue: unknown;
	currentAgent: string;
	attemptingAgent: string;
	at: string;
}

interface RegistryEntry<TFields extends Record<string, unknown>> {
	fields: TFields;
	/** Per-field last writer for conflict attribution. */
	fieldWriters: Map<string, string>;
	/** Per-field version at which the field last changed. */
	fieldVersions: Map<string, number>;
	version: number;
	updatedAt: string;
}

export interface UpdateResult {
	ok: boolean;
	conflicts?: FieldConflict[];
}

/**
 * Shared TaskLedger/DecisionRegistry/ArtifactRegistry semantics: optimistic
 * versioning + field-level merge. An update must name the version it read;
 * changing a field that someone else changed since that version is a
 * conflict — surfaced and recorded, never silently last-write-wins.
 */
export class SharedRegistry<TFields extends Record<string, unknown>> {
	private entries = new Map<string, Map<string, RegistryEntry<TFields>>>();
	private conflictLog: FieldConflict[] = [];

	register(kind: string, id: string, fields: TFields, agentId: string): number {
		let scope = this.entries.get(kind);
		if (!scope) {
			scope = new Map();
			this.entries.set(kind, scope);
		}
		if (scope.has(id)) {
			throw new Error(`Registry ${kind}/${id} already exists`);
		}
		scope.set(id, {
			fields: { ...fields },
			fieldWriters: new Map(Object.keys(fields).map((f) => [f, agentId])),
			fieldVersions: new Map(Object.keys(fields).map((f) => [f, 1])),
			version: 1,
			updatedAt: new Date().toISOString(),
		});
		return 1;
	}

	get(kind: string, id: string): RegistryEntry<TFields> | undefined {
		return this.entries.get(kind)?.get(id);
	}

	/**
	 * Field-level merge with optimistic concurrency: `baseVersion` is the
	 * version the caller read. A patch field conflicts when that field changed
	 * after baseVersion under a different agent. Conflicting fields are NOT
	 * applied; clean fields in the same patch are applied.
	 */
	update(kind: string, id: string, patch: Partial<TFields>, agentId: string, baseVersion: number): UpdateResult {
		const entry = this.entries.get(kind)?.get(id);
		if (!entry) {
			throw new Error(`Registry ${kind}/${id} does not exist`);
		}
		const conflicts: FieldConflict[] = [];
		const accepted: [string, unknown][] = [];
		for (const [field, value] of Object.entries(patch)) {
			const current = (entry.fields as Record<string, unknown>)[field];
			const changedSinceBase = (entry.fieldVersions.get(field) ?? 0) > baseVersion;
			const diverges = current !== undefined && JSON.stringify(current) !== JSON.stringify(value);
			if (changedSinceBase && diverges && entry.fieldWriters.get(field) !== agentId) {
				conflicts.push({
					kind,
					id,
					field,
					currentValue: current,
					attemptedValue: value,
					currentAgent: entry.fieldWriters.get(field) ?? "unknown",
					attemptingAgent: agentId,
					at: new Date().toISOString(),
				});
				continue;
			}
			accepted.push([field, value]);
		}
		if (accepted.length > 0) {
			entry.version += 1;
			for (const [field, value] of accepted) {
				(entry.fields as Record<string, unknown>)[field] = value;
				entry.fieldWriters.set(field, agentId);
				entry.fieldVersions.set(field, entry.version);
			}
			entry.updatedAt = new Date().toISOString();
		}
		if (conflicts.length > 0) {
			this.conflictLog.push(...conflicts);
			return { ok: false, conflicts };
		}
		return { ok: true };
	}

	conflicts(): FieldConflict[] {
		return [...this.conflictLog];
	}
}

// ============================================================================
// Cross-agent side-effect deduplication
// ============================================================================

export interface SideEffectRegistration {
	idempotencyKey: string;
	agentId: string;
	toolCallId: string;
	at: string;
}

export class SideEffectRegistry {
	private byKey = new Map<string, SideEffectRegistration>();

	/** Register a side-effecting operation. duplicate=true means the effect already exists — do not replay. */
	register(
		idempotencyKey: string,
		agentId: string,
		toolCallId: string,
	): { duplicate: boolean; existing?: SideEffectRegistration } {
		const existing = this.byKey.get(idempotencyKey);
		if (existing) {
			return { duplicate: true, existing };
		}
		const registration: SideEffectRegistration = {
			idempotencyKey,
			agentId,
			toolCallId,
			at: new Date().toISOString(),
		};
		this.byKey.set(idempotencyKey, registration);
		return { duplicate: false, existing: undefined };
	}

	get(idempotencyKey: string): SideEffectRegistration | undefined {
		return this.byKey.get(idempotencyKey);
	}
}

// ============================================================================
// Structured handoff capsule
// ============================================================================

export interface HandoffCapsule {
	schemaVersion: 1;
	fromAgent: string;
	toAgent: string;
	goal: string;
	openTasks: { id: string; title: string; state: string }[];
	decisionRefs: string[];
	constraintRefs: string[];
	recallRefs: string[];
	note?: string;
	createdAt: string;
}

export function buildHandoffCapsule(input: Omit<HandoffCapsule, "schemaVersion" | "createdAt">): HandoffCapsule {
	return { schemaVersion: 1, ...input, createdAt: new Date().toISOString() };
}

export function parseHandoffCapsule(serialized: string): HandoffCapsule {
	const parsed = JSON.parse(serialized) as HandoffCapsule;
	if (parsed.schemaVersion !== 1) {
		throw new Error(`Unsupported handoff capsule schema version: ${parsed.schemaVersion}`);
	}
	if (!parsed.fromAgent || !parsed.toAgent || typeof parsed.goal !== "string") {
		throw new Error("Malformed handoff capsule");
	}
	return parsed;
}
