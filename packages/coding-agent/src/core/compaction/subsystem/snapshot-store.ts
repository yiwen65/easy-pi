/**
 * CCTX-020: Snapshot store — immutable versions, active pointer, CAS activation.
 *
 * Candidates and activation are separated: putCandidate() only persists an
 * immutable candidate; activate() performs compare-and-swap on the expected
 * active version. A lost CAS race never overwrites anything — the losing
 * candidate stays on disk for audit. Rollback moves the active pointer back
 * to any earlier version.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StructuredSnapshot } from "./types.ts";

export interface ActivateRequest {
	/** CAS: activation only succeeds when the current active version equals this. 0 = none active. */
	expectedActiveVersion: number;
	candidateVersion: number;
	/** Optional freshness guard: candidate must cover at least this event seq. */
	minBaseEventSeq?: number;
}

export interface SnapshotDiff {
	fromVersion: number;
	toVersion: number;
	changedFields: string[];
}

export interface SnapshotStore {
	putCandidate(snapshot: Omit<StructuredSnapshot, "snapshotVersion">): StructuredSnapshot;
	getCandidate(sessionId: string, version: number): StructuredSnapshot | undefined;
	activate(sessionId: string, request: ActivateRequest): StructuredSnapshot;
	getActive(sessionId: string): StructuredSnapshot | undefined;
	getVersion(sessionId: string, version: number): StructuredSnapshot | undefined;
	listVersions(sessionId: string): StructuredSnapshot[];
	rollback(sessionId: string, toVersion: number): StructuredSnapshot;
	diff(sessionId: string, fromVersion: number, toVersion: number): SnapshotDiff;
}

interface SessionSnapshots {
	versions: Map<number, StructuredSnapshot>;
	activeVersion: number;
}

const SNAPSHOT_ARRAY_FIELDS: (keyof StructuredSnapshot)[] = [
	"constraints",
	"facts",
	"decisions",
	"tasks",
	"tools",
	"artifacts",
	"errors",
	"nextActions",
	"recallCatalogRefs",
	"sourceEventRanges",
	"lineage",
];

export class InMemorySnapshotStore implements SnapshotStore {
	private sessions = new Map<string, SessionSnapshots>();

	private getSession(sessionId: string): SessionSnapshots {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = { versions: new Map(), activeVersion: 0 };
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	putCandidate(snapshot: Omit<StructuredSnapshot, "snapshotVersion">): StructuredSnapshot {
		const session = this.getSession(snapshot.sessionId);
		const version = session.versions.size + 1;
		const stored: StructuredSnapshot = Object.freeze({ ...snapshot, snapshotVersion: version }) as StructuredSnapshot;
		session.versions.set(version, stored);
		return stored;
	}

	getCandidate(sessionId: string, version: number): StructuredSnapshot | undefined {
		return this.getSession(sessionId).versions.get(version);
	}

	activate(sessionId: string, request: ActivateRequest): StructuredSnapshot {
		const session = this.getSession(sessionId);
		if (session.activeVersion !== request.expectedActiveVersion) {
			throw new Error(
				`CAS conflict: expected active version ${request.expectedActiveVersion}, actual ${session.activeVersion}. Candidate must be rebuilt from the current active snapshot.`,
			);
		}
		const candidate = session.versions.get(request.candidateVersion);
		if (!candidate) {
			throw new Error(`Unknown candidate version ${request.candidateVersion}`);
		}
		if (request.minBaseEventSeq !== undefined && candidate.baseEventSeq < request.minBaseEventSeq) {
			throw new Error(
				`Stale candidate: base event seq ${candidate.baseEventSeq} < required ${request.minBaseEventSeq}; newer events would be overwritten`,
			);
		}
		session.activeVersion = request.candidateVersion;
		return candidate;
	}

	getActive(sessionId: string): StructuredSnapshot | undefined {
		const session = this.getSession(sessionId);
		if (session.activeVersion === 0) return undefined;
		return session.versions.get(session.activeVersion);
	}

	getVersion(sessionId: string, version: number): StructuredSnapshot | undefined {
		return this.getSession(sessionId).versions.get(version);
	}

	listVersions(sessionId: string): StructuredSnapshot[] {
		return [...this.getSession(sessionId).versions.values()].sort((a, b) => a.snapshotVersion - b.snapshotVersion);
	}

	rollback(sessionId: string, toVersion: number): StructuredSnapshot {
		const session = this.getSession(sessionId);
		const target = session.versions.get(toVersion);
		if (!target) {
			throw new Error(`Cannot rollback: snapshot version ${toVersion} does not exist`);
		}
		session.activeVersion = toVersion;
		return target;
	}

	diff(sessionId: string, fromVersion: number, toVersion: number): SnapshotDiff {
		const from = this.getSession(sessionId).versions.get(fromVersion);
		const to = this.getSession(sessionId).versions.get(toVersion);
		if (!from || !to) {
			throw new Error(`diff requires both versions to exist (${fromVersion}, ${toVersion})`);
		}
		const changedFields: string[] = [];
		for (const field of SNAPSHOT_ARRAY_FIELDS) {
			if (JSON.stringify(from[field]) !== JSON.stringify(to[field])) {
				changedFields.push(field);
			}
		}
		if (from.narrative !== to.narrative) changedFields.push("narrative");
		if (from.baseEventSeq !== to.baseEventSeq) changedFields.push("baseEventSeq");
		if (JSON.stringify(from.tokenStats) !== JSON.stringify(to.tokenStats)) changedFields.push("tokenStats");
		return { fromVersion, toVersion, changedFields };
	}
}

// ============================================================================
// JSONL-backed durable store
// ============================================================================

type SnapshotFileRecord =
	| { kind: "version"; sessionId: string; snapshot: StructuredSnapshot }
	| { kind: "active"; sessionId: string; version: number };

/**
 * JSONL-backed snapshot store: immutable version records plus an active-pointer
 * record per activation/rollback. Replay on open; last active record wins.
 * CAS semantics are identical to the in-memory store.
 */
export class JsonlSnapshotStore extends InMemorySnapshotStore {
	private readonly filePath: string;
	private loaded = false;

	constructor(dir: string) {
		super();
		mkdirSync(dir, { recursive: true });
		this.filePath = join(dir, "snapshots.jsonl");
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.filePath)) return;
		const lines = readFileSync(this.filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0);
		// Candidates are appended with incrementing versions, so replaying version
		// records in file order reproduces the same numbering via putCandidate.
		for (const line of lines) {
			const record = JSON.parse(line) as SnapshotFileRecord;
			if (record.kind === "version") {
				const { snapshotVersion: _dropped, ...rest } = record.snapshot;
				super.putCandidate(rest);
			} else {
				const current = super.getActive(record.sessionId)?.snapshotVersion ?? 0;
				super.activate(record.sessionId, { expectedActiveVersion: current, candidateVersion: record.version });
			}
		}
	}

	private appendRecord(record: SnapshotFileRecord): void {
		appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
	}

	override putCandidate(snapshot: Omit<StructuredSnapshot, "snapshotVersion">): StructuredSnapshot {
		this.ensureLoaded();
		const stored = super.putCandidate(snapshot);
		this.appendRecord({ kind: "version", sessionId: snapshot.sessionId, snapshot: stored });
		return stored;
	}

	override activate(sessionId: string, request: ActivateRequest): StructuredSnapshot {
		this.ensureLoaded();
		const activated = super.activate(sessionId, request);
		this.appendRecord({ kind: "active", sessionId, version: activated.snapshotVersion });
		return activated;
	}

	override rollback(sessionId: string, toVersion: number): StructuredSnapshot {
		this.ensureLoaded();
		const restored = super.rollback(sessionId, toVersion);
		this.appendRecord({ kind: "active", sessionId, version: toVersion });
		return restored;
	}

	override getActive(sessionId: string): StructuredSnapshot | undefined {
		this.ensureLoaded();
		return super.getActive(sessionId);
	}

	override getCandidate(sessionId: string, version: number): StructuredSnapshot | undefined {
		this.ensureLoaded();
		return super.getCandidate(sessionId, version);
	}

	override getVersion(sessionId: string, version: number): StructuredSnapshot | undefined {
		this.ensureLoaded();
		return super.getVersion(sessionId, version);
	}

	override listVersions(sessionId: string): StructuredSnapshot[] {
		this.ensureLoaded();
		return super.listVersions(sessionId);
	}
}
