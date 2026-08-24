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
	/**
	 * Synchronous final assertion for state owned outside this store. It runs
	 * after all prechecks and immediately before the active pointer mutation.
	 * Throwing aborts activation and leaves the current pointer unchanged.
	 */
	assertExternalState?: () => void;
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
	/** Select the latest actually-activated snapshot visible from the current branch. */
	selectActiveForBranch(
		sessionId: string,
		branchPathEntryIds: readonly string[],
		visibleEventIds: ReadonlySet<string>,
	): StructuredSnapshot | undefined;
	getVersion(sessionId: string, version: number): StructuredSnapshot | undefined;
	listVersions(sessionId: string): StructuredSnapshot[];
	rollback(sessionId: string, toVersion: number): StructuredSnapshot;
	diff(sessionId: string, fromVersion: number, toVersion: number): SnapshotDiff;
}

interface SessionSnapshots {
	versions: Map<number, StructuredSnapshot>;
	activeVersion: number;
	/** Candidates are not eligible until activate/rollback has succeeded at least once. */
	activatedVersions: Set<number>;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const nested of Object.values(value)) deepFreeze(nested);
	}
	return value;
}

function cloneSnapshot(snapshot: StructuredSnapshot): StructuredSnapshot {
	return structuredClone(snapshot);
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
			session = { versions: new Map(), activeVersion: 0, activatedVersions: new Set() };
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	protected removeCandidate(sessionId: string, version: number): void {
		this.getSession(sessionId).versions.delete(version);
	}

	protected getActiveVersion(sessionId: string): number {
		return this.getSession(sessionId).activeVersion;
	}

	protected restoreActiveVersion(sessionId: string, version: number): void {
		this.getSession(sessionId).activeVersion = version;
	}

	protected hasActivatedVersion(sessionId: string, version: number): boolean {
		return this.getSession(sessionId).activatedVersions.has(version);
	}

	protected restoreActivatedVersion(sessionId: string, version: number, wasActivated: boolean): void {
		const activated = this.getSession(sessionId).activatedVersions;
		if (wasActivated) activated.add(version);
		else activated.delete(version);
	}

	putCandidate(snapshot: Omit<StructuredSnapshot, "snapshotVersion">): StructuredSnapshot {
		const session = this.getSession(snapshot.sessionId);
		const version = session.versions.size + 1;
		const stored = deepFreeze(structuredClone({ ...snapshot, snapshotVersion: version })) as StructuredSnapshot;
		session.versions.set(version, stored);
		return cloneSnapshot(stored);
	}

	getCandidate(sessionId: string, version: number): StructuredSnapshot | undefined {
		const candidate = this.getSession(sessionId).versions.get(version);
		return candidate ? cloneSnapshot(candidate) : undefined;
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
		request.assertExternalState?.();
		session.activatedVersions.add(request.candidateVersion);
		session.activeVersion = request.candidateVersion;
		return cloneSnapshot(candidate);
	}

	getActive(sessionId: string): StructuredSnapshot | undefined {
		const session = this.getSession(sessionId);
		if (session.activeVersion === 0) return undefined;
		const active = session.versions.get(session.activeVersion);
		return active ? cloneSnapshot(active) : undefined;
	}

	selectActiveForBranch(
		sessionId: string,
		branchPathEntryIds: readonly string[],
		visibleEventIds: ReadonlySet<string>,
	): StructuredSnapshot | undefined {
		const session = this.getSession(sessionId);
		const pathDepth = new Map(branchPathEntryIds.map((entryId, index) => [entryId, index]));
		const selected = [...session.activatedVersions]
			.map((version) => session.versions.get(version))
			.filter((snapshot): snapshot is StructuredSnapshot => snapshot !== undefined)
			.filter((snapshot) => {
				const branchId = snapshot.taskLedgerRef?.branchId;
				// Legacy snapshots without an explicit branch binding cannot be
				// ordered safely against sibling ancestry. Fail closed to raw replay.
				return branchId ? visibleEventIds.has(branchId) : false;
			})
			.sort((left, right) => {
				const leftDepth = pathDepth.get(left.taskLedgerRef?.branchId ?? "") ?? -1;
				const rightDepth = pathDepth.get(right.taskLedgerRef?.branchId ?? "") ?? -1;
				return rightDepth - leftDepth || right.snapshotVersion - left.snapshotVersion;
			})[0];
		session.activeVersion = selected?.snapshotVersion ?? 0;
		return selected ? cloneSnapshot(selected) : undefined;
	}

	getVersion(sessionId: string, version: number): StructuredSnapshot | undefined {
		const snapshot = this.getSession(sessionId).versions.get(version);
		return snapshot ? cloneSnapshot(snapshot) : undefined;
	}

	listVersions(sessionId: string): StructuredSnapshot[] {
		return [...this.getSession(sessionId).versions.values()]
			.sort((a, b) => a.snapshotVersion - b.snapshotVersion)
			.map(cloneSnapshot);
	}

	rollback(sessionId: string, toVersion: number): StructuredSnapshot {
		const session = this.getSession(sessionId);
		const target = session.versions.get(toVersion);
		if (!target) {
			throw new Error(`Cannot rollback: snapshot version ${toVersion} does not exist`);
		}
		session.activatedVersions.add(toVersion);
		session.activeVersion = toVersion;
		return cloneSnapshot(target);
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
		if (!existsSync(this.filePath)) {
			this.loaded = true;
			return;
		}
		const records = readFileSync(this.filePath, "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as SnapshotFileRecord);
		// Parse the full file before exposing any prefix. A torn JSON tail keeps
		// loaded=false and fails every subsequent read instead of failing open.
		for (const record of records) {
			if (record.kind === "version") {
				const { snapshotVersion: _dropped, ...rest } = record.snapshot;
				super.putCandidate(rest);
			} else if (record.version === 0) {
				this.restoreActiveVersion(record.sessionId, 0);
			} else {
				const current = super.getActive(record.sessionId)?.snapshotVersion ?? 0;
				super.activate(record.sessionId, { expectedActiveVersion: current, candidateVersion: record.version });
			}
		}
		this.loaded = true;
	}

	protected appendRecord(record: SnapshotFileRecord): void {
		appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
	}

	override putCandidate(snapshot: Omit<StructuredSnapshot, "snapshotVersion">): StructuredSnapshot {
		this.ensureLoaded();
		const stored = super.putCandidate(snapshot);
		try {
			this.appendRecord({ kind: "version", sessionId: snapshot.sessionId, snapshot: stored });
			return stored;
		} catch (error) {
			this.removeCandidate(snapshot.sessionId, stored.snapshotVersion);
			throw error;
		}
	}

	override activate(sessionId: string, request: ActivateRequest): StructuredSnapshot {
		this.ensureLoaded();
		const previousVersion = this.getActiveVersion(sessionId);
		const wasActivated = this.hasActivatedVersion(sessionId, request.candidateVersion);
		const activated = super.activate(sessionId, request);
		try {
			this.appendRecord({ kind: "active", sessionId, version: activated.snapshotVersion });
			return activated;
		} catch (error) {
			this.restoreActiveVersion(sessionId, previousVersion);
			this.restoreActivatedVersion(sessionId, request.candidateVersion, wasActivated);
			throw error;
		}
	}

	override rollback(sessionId: string, toVersion: number): StructuredSnapshot {
		this.ensureLoaded();
		const previousVersion = this.getActiveVersion(sessionId);
		const wasActivated = this.hasActivatedVersion(sessionId, toVersion);
		const restored = super.rollback(sessionId, toVersion);
		try {
			this.appendRecord({ kind: "active", sessionId, version: toVersion });
			return restored;
		} catch (error) {
			this.restoreActiveVersion(sessionId, previousVersion);
			this.restoreActivatedVersion(sessionId, toVersion, wasActivated);
			throw error;
		}
	}

	override getActive(sessionId: string): StructuredSnapshot | undefined {
		this.ensureLoaded();
		return super.getActive(sessionId);
	}

	override selectActiveForBranch(
		sessionId: string,
		branchPathEntryIds: readonly string[],
		visibleEventIds: ReadonlySet<string>,
	): StructuredSnapshot | undefined {
		this.ensureLoaded();
		const previousVersion = this.getActiveVersion(sessionId);
		const selected = super.selectActiveForBranch(sessionId, branchPathEntryIds, visibleEventIds);
		const selectedVersion = selected?.snapshotVersion ?? 0;
		if (selectedVersion === previousVersion) return selected;
		try {
			this.appendRecord({ kind: "active", sessionId, version: selectedVersion });
			return selected;
		} catch (error) {
			this.restoreActiveVersion(sessionId, previousVersion);
			throw error;
		}
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
