import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "../../src/core/compaction/subsystem/artifact-store.ts";
import { InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import { AuditTrail } from "../../src/core/compaction/subsystem/observability.ts";
import { type RebuildDeps, rawRebuild, rollbackToVersion } from "../../src/core/compaction/subsystem/rebuild.ts";
import { RecallCatalog } from "../../src/core/compaction/subsystem/recall-catalog.ts";
import { reduceEvents } from "../../src/core/compaction/subsystem/reducer.ts";
import { InMemorySnapshotStore } from "../../src/core/compaction/subsystem/snapshot-store.ts";
import { InMemoryContractStore } from "../../src/core/compaction/subsystem/task-contract.ts";
import type { StructuredSnapshot } from "../../src/core/compaction/subsystem/types.ts";

const user = { kind: "user" as const, id: "user-1", verified: true };

function makeDeps(mutate?: (deps: RebuildDeps & { artifactStore: InMemoryArtifactStore }) => void) {
	const eventLog = new InMemoryEventLog();
	const artifactStore = new InMemoryArtifactStore();
	const contractStore = new InMemoryContractStore();
	contractStore.create({
		contractId: "c-1",
		sessionId: "s-1",
		goal: "g",
		acceptanceCriteria: [],
		constraints: [{ id: "c-1", kind: "negative", text: "Never delete raw events", authority: user }],
		permissions: { allow: [], deny: [], approvalRequired: [] },
		budgets: {},
		authority: user,
		allowedUpdaters: ["user-1"],
	});
	const deps = {
		sessionId: "s-1",
		eventLog,
		artifactStore,
		contractStore,
		snapshotStore: new InMemorySnapshotStore(),
		audit: new AuditTrail(),
		recallCatalog: new RecallCatalog({ store: artifactStore, tenant: "t-1" }),
	};
	mutate?.(deps);
	return deps;
}

function seed(deps: ReturnType<typeof makeDeps>): void {
	deps.eventLog.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-1",
		eventType: "state_change",
		payload: { kind: "task_update", taskId: "t-1", title: "Task one", state: "in_progress" },
		authority: user,
	});
	deps.eventLog.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-2",
		eventType: "tool_call",
		toolCallId: "tc-1",
		payload: { name: "write", arguments: { path: "/a.ts" } },
		authority: user,
	});
	deps.eventLog.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-3",
		eventType: "tool_result",
		toolCallId: "tc-1",
		payload: { isError: false, content: "ok", exitCode: 0 },
		authority: user,
	});
	deps.eventLog.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-4",
		eventType: "state_change",
		payload: { kind: "task_update", taskId: "t-1", state: "done" },
		authority: user,
	});
}

describe("rawRebuild", () => {
	it("rebuilds state from seq 0 that matches the full-replay oracle", async () => {
		const deps = makeDeps();
		seed(deps);
		const { snapshot, gaps } = await rawRebuild(deps);
		const oracle = reduceEvents(deps.eventLog.all("s-1"));
		expect(snapshot.tasks).toEqual(oracle.tasks);
		expect(snapshot.tools).toEqual(oracle.tools);
		expect(snapshot.errors).toEqual(oracle.errors);
		expect(snapshot.baseEventSeq).toBe(4);
		expect(gaps).toEqual([]);
		// Constraints come from the verified contract, verbatim.
		expect(snapshot.constraints.map((c) => c.text)).toEqual(["Never delete raw events"]);
		// Narrative is dropped on rebuild (it is lossy and must not accumulate).
		expect(snapshot.narrative).toBeUndefined();
	});

	it("honors the orchestrator-frozen boundary and leaves later events out of the rebuilt snapshot", async () => {
		const deps = makeDeps();
		seed(deps);
		const { snapshot } = await rawRebuild(deps, { toSeq: 2 });
		expect(snapshot.baseEventSeq).toBe(2);
		expect(snapshot.sourceEventRanges).toEqual([{ fromSeq: 1, toSeq: 2 }]);
		expect(snapshot.compactor).toMatchObject({ kind: "rebuild", triggerEventSeq: 2, triggerHeadEventId: "e-2" });
		expect(snapshot.tasks.some((task) => task.state === "done")).toBe(false);
	});

	it("reports missing objects as explicit gaps instead of failing silently", async () => {
		const deps = makeDeps();
		seed(deps);
		deps.eventLog.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: "e-5",
			eventType: "tool_call",
			toolCallId: "tc-9",
			payload: { name: "read", arguments: { path: "/big.log" } },
			authority: user,
		});
		// Result payload was externalized, but the artifact is missing from the store.
		deps.eventLog.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: "e-6",
			eventType: "tool_result",
			toolCallId: "tc-9",
			payloadRef: `artifact://sha256/${"b".repeat(64)}`,
			authority: user,
		});
		const { gaps, snapshot } = await rawRebuild(deps);
		expect(gaps.length).toBeGreaterThan(0);
		expect(gaps[0]).toContain("artifact://sha256/");
		// Rebuild still succeeds and marks the gap explicitly.
		expect(snapshot.baseEventSeq).toBe(6);
	});

	it("reports dangling recall refs from the active snapshot as explicit gaps", async () => {
		const deps = makeDeps();
		seed(deps);
		const { snapshot } = await rawRebuild(deps);
		snapshot.recallCatalogRefs = ["rc-missing"];
		const candidate = deps.snapshotStore.putCandidate(snapshot);
		deps.snapshotStore.activate("s-1", { expectedActiveVersion: 0, candidateVersion: candidate.snapshotVersion });
		const rebuilt = await rawRebuild(deps);
		expect(rebuilt.gaps).toContainEqual(expect.stringContaining("unresolvable recall rc-missing"));
	});

	it("never re-executes tools or side effects during rebuild", async () => {
		const deps = makeDeps();
		seed(deps);
		const eventsBefore = deps.eventLog.all("s-1").length;
		await rawRebuild(deps);
		const after = deps.eventLog.all("s-1");
		// Only read operations: no new tool_call/ledger events; an audit marker is allowed.
		const newEvents = after.slice(eventsBefore);
		expect(newEvents.every((e) => e.eventType === "compaction" || e.eventType === "state_change")).toBe(true);
	});

	it("records MTTR in the audit trail", async () => {
		const deps = makeDeps();
		seed(deps);
		await rawRebuild(deps);
		const audit = deps.audit.byType("rebuild");
		expect(audit).toHaveLength(1);
		expect(typeof audit[0].details.mttrMs).toBe("number");
	});

	it("carries prior extractor items forward as unverified, never as truth", async () => {
		const deps = makeDeps();
		seed(deps);
		// Seed an active snapshot containing an extractor-sourced fact.
		const prior: Omit<StructuredSnapshot, "snapshotVersion"> = {
			sessionId: "s-1",
			parentVersion: null,
			baseEventSeq: 2,
			lineage: [],
			contractRef: { contractId: "c-1", version: 1 },
			constraints: [],
			facts: [
				{
					id: "f-x1",
					text: "model-claimed fact",
					kind: "fact",
					verified: false,
					provenance: { sourceEventIds: ["e-1"], source: "extractor" },
				},
			],
			decisions: [],
			tasks: [],
			tools: [],
			artifacts: [],
			errors: [],
			nextActions: [],
			recallCatalogRefs: [],
			sourceEventRanges: [{ fromSeq: 1, toSeq: 2 }],
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
			createdAt: "t",
			schemaVersion: 1,
		};
		const v1 = deps.snapshotStore.putCandidate(prior);
		deps.snapshotStore.activate("s-1", { expectedActiveVersion: 0, candidateVersion: v1.snapshotVersion });

		const { snapshot } = await rawRebuild(deps);
		const carried = snapshot.facts.find((f) => f.text === "model-claimed fact");
		expect(carried).toBeDefined();
		expect(carried!.verified).toBe(false);
	});
});

describe("rollbackToVersion", () => {
	it("rolls the active pointer back to a previous (possibly polluted-away) version", async () => {
		const deps = makeDeps();
		seed(deps);
		const { snapshot: s1 } = await rawRebuild(deps);
		const v1 = deps.snapshotStore.putCandidate(s1);
		deps.snapshotStore.activate("s-1", { expectedActiveVersion: 0, candidateVersion: v1.snapshotVersion });
		// A later, "polluted" snapshot activates.
		const polluted: Omit<StructuredSnapshot, "snapshotVersion"> = {
			...s1,
			parentVersion: 1,
			narrative: "polluted narrative with wrong claims",
			facts: [
				{
					id: "f-bad",
					text: "false claim",
					kind: "fact",
					verified: false,
					provenance: { sourceEventIds: ["e-1"], source: "extractor" },
				},
			],
		};
		const v2 = deps.snapshotStore.putCandidate(polluted);
		deps.snapshotStore.activate("s-1", { expectedActiveVersion: 1, candidateVersion: v2.snapshotVersion });

		const restored = rollbackToVersion(deps, 1);
		expect(restored.snapshotVersion).toBe(1);
		expect(deps.snapshotStore.getActive("s-1")?.narrative).toBeUndefined();
		expect(deps.audit.byType("rollback")).toHaveLength(1);
	});
});
