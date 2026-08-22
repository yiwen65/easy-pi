import { describe, expect, it } from "vitest";
import { InMemorySnapshotStore, type SnapshotStore } from "../../src/core/compaction/subsystem/snapshot-store.ts";
import type { StructuredSnapshot } from "../../src/core/compaction/subsystem/types.ts";

function makeSnapshot(
	sessionId: string,
	overrides: Partial<StructuredSnapshot> = {},
): Omit<StructuredSnapshot, "snapshotVersion"> {
	return {
		sessionId,
		parentVersion: null,
		baseEventSeq: 10,
		lineage: [],
		contractRef: { contractId: "c-1", version: 1 },
		constraints: [],
		facts: [],
		decisions: [],
		tasks: [],
		tools: [],
		artifacts: [],
		errors: [],
		nextActions: [],
		recallCatalogRefs: [],
		sourceEventRanges: [{ fromSeq: 1, toSeq: 10 }],
		compactor: { promptVersion: "1.0.0", schemaVersion: 1 },
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
		schemaVersion: 1,
		...overrides,
	};
}

describe("InMemorySnapshotStore", () => {
	let store: SnapshotStore;

	it("candidate write and activation are separate; activate is CAS on expected version", () => {
		store = new InMemorySnapshotStore();
		const c1 = store.putCandidate(makeSnapshot("s-1"));
		expect(c1.snapshotVersion).toBe(1);
		expect(store.getActive("s-1")).toBeUndefined(); // candidate is not active yet

		const activated = store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: 1 });
		expect(activated.snapshotVersion).toBe(1);
		expect(store.getActive("s-1")?.snapshotVersion).toBe(1);
	});

	it("concurrent compaction: only one activation wins; loser stays an auditable candidate", () => {
		store = new InMemorySnapshotStore();
		const a = store.putCandidate(makeSnapshot("s-1"));
		const b = store.putCandidate(makeSnapshot("s-1"));
		// Both observed active=0. A activates; B's CAS must fail.
		store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: a.snapshotVersion });
		expect(() => store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: b.snapshotVersion })).toThrow(
			/CAS|conflict|expected/i,
		);
		// Loser candidate remains for audit, never activated.
		expect(store.getCandidate("s-1", b.snapshotVersion)).toBeDefined();
		expect(store.getActive("s-1")?.snapshotVersion).toBe(a.snapshotVersion);
	});

	it("events appended after a candidate's boundary are never overwritten by that candidate", () => {
		store = new InMemorySnapshotStore();
		const c1 = store.putCandidate(makeSnapshot("s-1", { baseEventSeq: 10 }));
		store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: c1.snapshotVersion });
		// A stale candidate built on seq 10 cannot displace an active snapshot on seq 20.
		const stale = store.putCandidate(makeSnapshot("s-1", { baseEventSeq: 10, parentVersion: 1 }));
		expect(() =>
			store.activate("s-1", {
				expectedActiveVersion: 1,
				candidateVersion: stale.snapshotVersion,
				minBaseEventSeq: 20,
			}),
		).toThrow(/base event|stale/i);
		expect(store.getActive("s-1")?.baseEventSeq).toBe(10);
	});

	it("rollback restores a previous snapshot version as active", () => {
		store = new InMemorySnapshotStore();
		const v1 = store.putCandidate(makeSnapshot("s-1"));
		store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: v1.snapshotVersion });
		const v2 = store.putCandidate(makeSnapshot("s-1", { parentVersion: 1, baseEventSeq: 20, lineage: [1] }));
		store.activate("s-1", { expectedActiveVersion: 1, candidateVersion: v2.snapshotVersion });

		const rolledBack = store.rollback("s-1", 1);
		expect(rolledBack.snapshotVersion).toBe(1);
		expect(store.getActive("s-1")?.snapshotVersion).toBe(1);
		// History is intact: v2 still exists as a version.
		expect(store.getVersion("s-1", 2)?.baseEventSeq).toBe(20);
	});

	it("lists history with lineage so every snapshot is traceable", () => {
		store = new InMemorySnapshotStore();
		const v1 = store.putCandidate(makeSnapshot("s-1"));
		store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: v1.snapshotVersion });
		const v2 = store.putCandidate(makeSnapshot("s-1", { parentVersion: 1, lineage: [1] }));
		store.activate("s-1", { expectedActiveVersion: 1, candidateVersion: v2.snapshotVersion });
		const history = store.listVersions("s-1");
		expect(history.map((s) => s.snapshotVersion)).toEqual([1, 2]);
		expect(history[1].parentVersion).toBe(1);
		expect(history[1].lineage).toEqual([1]);
	});

	it("diff reports field-level changes between versions", () => {
		store = new InMemorySnapshotStore();
		const v1 = store.putCandidate(makeSnapshot("s-1"));
		const v2 = store.putCandidate(
			makeSnapshot("s-1", {
				parentVersion: 1,
				facts: [
					{
						id: "f-1",
						text: "x",
						kind: "fact",
						verified: true,
						provenance: { sourceEventIds: ["e-1"], source: "event" },
					},
				],
			}),
		);
		const diff = store.diff("s-1", v1.snapshotVersion, v2.snapshotVersion);
		expect(diff.changedFields).toContain("facts");
		expect(diff.changedFields).not.toContain("contractRef");
	});
});
