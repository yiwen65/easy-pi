import { appendFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	InMemorySnapshotStore,
	JsonlSnapshotStore,
	type SnapshotStore,
} from "../../src/core/compaction/subsystem/snapshot-store.ts";
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

const tempDirs: string[] = [];
afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

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

	it("defensively isolates nested candidate and read values", () => {
		store = new InMemorySnapshotStore();
		const input = makeSnapshot("s-1", {
			taskLedgerRef: { ledgerVersion: 1, focusTaskId: "T1", focusContractVersion: 1, taskRef: "task://T1/v1" },
			facts: [
				{
					id: "f-1",
					text: "trusted",
					kind: "fact",
					verified: true,
					provenance: { sourceEventIds: ["e-1"], source: "event" },
				},
			],
		});
		const candidate = store.putCandidate(input);
		input.facts[0].text = "mutated input";
		candidate.facts[0].text = "mutated return";
		candidate.taskLedgerRef!.taskRef = "task://forged/v9";
		expect(store.getCandidate("s-1", 1)).toMatchObject({
			facts: [{ text: "trusted" }],
			taskLedgerRef: { taskRef: "task://T1/v1" },
		});
		const read = store.getCandidate("s-1", 1)!;
		read.facts[0].text = "mutated read";
		expect(store.getCandidate("s-1", 1)?.facts[0].text).toBe("trusted");
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

	it("runs the synchronous external-state assertion immediately before pointer mutation", () => {
		store = new InMemorySnapshotStore();
		const candidate = store.putCandidate(makeSnapshot("s-1"));
		let asserted = false;
		expect(() =>
			store.activate("s-1", {
				expectedActiveVersion: 0,
				candidateVersion: candidate.snapshotVersion,
				assertExternalState: () => {
					asserted = true;
					// The pointer has passed internal prechecks but has not moved yet.
					expect(store.getActive("s-1")).toBeUndefined();
					throw new Error("external ledger changed");
				},
			}),
		).toThrow(/external ledger changed/);
		expect(asserted).toBe(true);
		expect(store.getActive("s-1")).toBeUndefined();
		expect(store.getCandidate("s-1", candidate.snapshotVersion)).toBeDefined();
	});

	it("selects only activated ancestor-visible snapshots and excludes sibling candidates", () => {
		store = new InMemorySnapshotStore();
		const root = store.putCandidate(makeSnapshot("s-1", { taskLedgerRef: { branchId: "root", ledgerVersion: 1 } }));
		store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: root.snapshotVersion });
		const branchA = store.putCandidate(
			makeSnapshot("s-1", {
				parentVersion: root.snapshotVersion,
				taskLedgerRef: { branchId: "a", ledgerVersion: 2 },
			}),
		);
		store.activate("s-1", { expectedActiveVersion: root.snapshotVersion, candidateVersion: branchA.snapshotVersion });
		const unactivatedB = store.putCandidate(
			makeSnapshot("s-1", {
				parentVersion: root.snapshotVersion,
				taskLedgerRef: { branchId: "b", ledgerVersion: 2 },
			}),
		);
		const newerRoot = store.putCandidate(
			makeSnapshot("s-1", {
				parentVersion: root.snapshotVersion,
				taskLedgerRef: { branchId: "root", ledgerVersion: 2 },
			}),
		);
		store.activate("s-1", {
			expectedActiveVersion: branchA.snapshotVersion,
			candidateVersion: newerRoot.snapshotVersion,
		});

		expect(store.selectActiveForBranch("s-1", ["root", "a"], new Set(["root", "a"]))?.snapshotVersion).toBe(
			branchA.snapshotVersion,
		);
		expect(store.selectActiveForBranch("s-1", ["root", "b"], new Set(["root", "b"]))?.snapshotVersion).toBe(
			newerRoot.snapshotVersion,
		);
		expect(store.getCandidate("s-1", unactivatedB.snapshotVersion)).toBeDefined();
		expect(store.selectActiveForBranch("s-1", ["detached"], new Set(["detached"]))).toBeUndefined();
		expect(store.getActive("s-1")).toBeUndefined();
	});

	it("fails closed for activated legacy snapshots without an explicit branch binding", () => {
		store = new InMemorySnapshotStore();
		const legacy = store.putCandidate(makeSnapshot("s-1", { compactor: { promptVersion: "1", schemaVersion: 1 } }));
		store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: legacy.snapshotVersion });
		expect(store.selectActiveForBranch("s-1", ["root"], new Set(["root"]))).toBeUndefined();
		expect(store.getCandidate("s-1", legacy.snapshotVersion)).toBeDefined();
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

describe("JsonlSnapshotStore failure semantics", () => {
	it("persists activation history used for branch selection across restart", () => {
		const dir = mkdtempSync(join(tmpdir(), "snapshot-branches-"));
		tempDirs.push(dir);
		const store = new JsonlSnapshotStore(dir);
		const root = store.putCandidate(makeSnapshot("s-1", { taskLedgerRef: { branchId: "root", ledgerVersion: 1 } }));
		store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: root.snapshotVersion });
		const branchA = store.putCandidate(
			makeSnapshot("s-1", {
				parentVersion: root.snapshotVersion,
				taskLedgerRef: { branchId: "a", ledgerVersion: 2 },
			}),
		);
		store.activate("s-1", { expectedActiveVersion: root.snapshotVersion, candidateVersion: branchA.snapshotVersion });
		store.selectActiveForBranch("s-1", ["detached"], new Set(["detached"]));

		const reopened = new JsonlSnapshotStore(dir);
		expect(reopened.getActive("s-1")).toBeUndefined();
		expect(reopened.selectActiveForBranch("s-1", ["root", "a"], new Set(["root", "a"]))?.snapshotVersion).toBe(
			branchA.snapshotVersion,
		);
		expect(reopened.selectActiveForBranch("s-1", ["root", "b"], new Set(["root", "b"]))?.snapshotVersion).toBe(
			root.snapshotVersion,
		);
	});

	it("rolls memory back when candidate or active-pointer persistence fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "snapshot-store-"));
		tempDirs.push(dir);
		const store = new JsonlSnapshotStore(dir);
		const first = store.putCandidate(makeSnapshot("s-1"));
		const file = join(dir, "snapshots.jsonl");
		chmodSync(file, 0o400);
		expect(() => store.putCandidate(makeSnapshot("s-1"))).toThrow();
		expect(store.listVersions("s-1")).toHaveLength(1);
		expect(() =>
			store.activate("s-1", { expectedActiveVersion: 0, candidateVersion: first.snapshotVersion }),
		).toThrow();
		expect(store.getActive("s-1")).toBeUndefined();
		expect(store.selectActiveForBranch("s-1", ["root"], new Set(["root"]))).toBeUndefined();
		chmodSync(file, 0o600);
	});

	it("never exposes a parsed prefix after a corrupt tail", () => {
		const dir = mkdtempSync(join(tmpdir(), "snapshot-store-corrupt-"));
		tempDirs.push(dir);
		const store = new JsonlSnapshotStore(dir);
		store.putCandidate(makeSnapshot("s-1"));
		appendFileSync(join(dir, "snapshots.jsonl"), "{broken\n");
		const reopened = new JsonlSnapshotStore(dir);
		expect(() => reopened.listVersions("s-1")).toThrow();
		expect(() => reopened.listVersions("s-1")).toThrow();
	});
});
