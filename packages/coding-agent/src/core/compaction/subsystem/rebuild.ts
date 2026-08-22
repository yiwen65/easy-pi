/**
 * CCTX-052: Rollback and raw rebuild.
 *
 * Rollback moves the active pointer to any earlier snapshot version. Raw
 * rebuild reconstructs state from the raw event log (seq 0 or checkpoint)
 * without any LLM call and without re-executing tools or side effects. Stable
 * refs are verified against the artifact store; missing objects are reported
 * as explicit gaps. Prior extractor-produced items carry forward only as
 * unverified — never as truth.
 */

import type { ArtifactStore } from "./artifact-store.ts";
import type { EventLog } from "./event-log.ts";
import { COMPACTOR_POLICY_VERSION } from "./injection-guard.ts";
import type { AuditTrail } from "./observability.ts";
import { reduceEvents } from "./reducer.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import type { ContractStore } from "./task-contract.ts";
import type { StructuredSnapshot } from "./types.ts";
import { COMPACTION_SCHEMA_VERSION } from "./types.ts";

export interface RebuildDeps {
	sessionId: string;
	eventLog: EventLog;
	artifactStore: ArtifactStore;
	contractStore: ContractStore;
	snapshotStore: SnapshotStore;
	audit: AuditTrail;
}

export interface RebuildResult {
	snapshot: Omit<StructuredSnapshot, "snapshotVersion">;
	gaps: string[];
	mttrMs: number;
}

/**
 * Rebuild a snapshot from raw events. Deterministic state comes from a full
 * reduce; prior extractor items carry over as unverified; the narrative is
 * dropped (lossy text must not accumulate across rebuilds).
 */
export async function rawRebuild(
	deps: RebuildDeps,
	options: { fromCheckpointSeq?: number } = {},
): Promise<RebuildResult> {
	const started = Date.now();
	const { eventLog, artifactStore, contractStore, snapshotStore, audit, sessionId } = deps;

	const boundary = eventLog.freeze(sessionId);
	const fromSeq = options.fromCheckpointSeq ?? 1;
	const events = eventLog.range(sessionId, 1, boundary.seq);

	// Verify stable refs resolve; missing objects are explicit gaps.
	const gaps: string[] = [];
	for (const event of events) {
		if (event.payloadRef && !artifactStore.resolve(event.payloadRef)) {
			gaps.push(`missing artifact ${event.payloadRef} referenced by event ${event.eventId}`);
		}
	}

	// When starting from a checkpoint, the checkpoint snapshot provides the
	// prior deterministic state and we reduce only the delta.
	const checkpoint =
		fromSeq > 1 ? snapshotStore.listVersions(sessionId).find((s) => s.baseEventSeq === fromSeq - 1) : undefined;

	const deltaEvents = events.filter((e) => e.seq >= fromSeq);
	const deterministicState = reduceEvents(
		deltaEvents,
		checkpoint
			? {
					contractRef: checkpoint.contractRef,
					tasks: checkpoint.tasks,
					tools: checkpoint.tools,
					artifacts: checkpoint.artifacts,
					errors: checkpoint.errors,
					approvals: [],
					lastEventSeq: checkpoint.baseEventSeq,
					eventCount: checkpoint.baseEventSeq,
				}
			: undefined,
	);

	const active = snapshotStore.getActive(sessionId);
	const contract = contractStore.getActive(sessionId);

	// Prior extractor content survives only as unverified, with provenance intact.
	const carriedFacts = (active?.facts ?? [])
		.filter((f) => f.provenance.source === "extractor")
		.map((f) => ({ ...f, verified: false }));
	const carriedDecisions = active?.decisions ?? [];
	const carriedNextActions = active?.nextActions ?? [];

	const snapshot: Omit<StructuredSnapshot, "snapshotVersion"> = {
		sessionId,
		parentVersion: active?.snapshotVersion ?? null,
		baseEventSeq: boundary.seq,
		lineage: active ? [...active.lineage, active.snapshotVersion] : [],
		contractRef: contract
			? { contractId: contract.contractId, version: contract.version }
			: (deterministicState.contractRef ?? { contractId: "unknown", version: 0 }),
		constraints: contract ? contract.constraints.map((c) => ({ ...c })) : [],
		facts: carriedFacts,
		decisions: carriedDecisions,
		tasks: deterministicState.tasks,
		tools: deterministicState.tools,
		artifacts: deterministicState.artifacts,
		errors: deterministicState.errors,
		nextActions: carriedNextActions,
		recallCatalogRefs: active?.recallCatalogRefs ?? [],
		sourceEventRanges: [{ fromSeq, toSeq: boundary.seq }],
		// narrative intentionally dropped
		compactor: { promptVersion: COMPACTOR_POLICY_VERSION, schemaVersion: COMPACTION_SCHEMA_VERSION },
		tokenStats: {
			system: 0,
			tools: 0,
			contract: 0,
			snapshot: 0,
			narrative: 0,
			recall: 0,
			recentTail: 0,
			currentInput: 0,
			outputReserve: 0,
			total: 0,
		},
		createdAt: new Date().toISOString(),
		schemaVersion: COMPACTION_SCHEMA_VERSION,
	};

	const mttrMs = Date.now() - started;
	audit.record("rebuild", sessionId, {
		fromSeq,
		toSeq: boundary.seq,
		gaps: gaps.length,
		mttrMs,
		checkpointUsed: checkpoint !== undefined,
	});
	return { snapshot, gaps, mttrMs };
}

/**
 * Roll back the active pointer to an earlier snapshot version. History is
 * never deleted; the polluted version stays auditable.
 */
export function rollbackToVersion(deps: RebuildDeps, toVersion: number): StructuredSnapshot {
	const restored = deps.snapshotStore.rollback(deps.sessionId, toVersion);
	deps.audit.record("rollback", deps.sessionId, { toVersion }, toVersion);
	return restored;
}
