import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "../../src/core/compaction/subsystem/artifact-store.ts";
import { InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import { AuditTrail } from "../../src/core/compaction/subsystem/observability.ts";
import { CompactionOrchestrator, type OrchestratorDeps } from "../../src/core/compaction/subsystem/orchestrator.ts";
import { renderPinnedLedgerLayer } from "../../src/core/compaction/subsystem/prompt-builder.ts";
import { rawRebuild } from "../../src/core/compaction/subsystem/rebuild.ts";
import { RecallCatalog } from "../../src/core/compaction/subsystem/recall-catalog.ts";
import { type ActivateRequest, InMemorySnapshotStore } from "../../src/core/compaction/subsystem/snapshot-store.ts";
import { InMemoryContractStore } from "../../src/core/compaction/subsystem/task-contract.ts";
import { TaskLedger } from "../../src/core/compaction/subsystem/task-ledger.ts";

const user = { kind: "user" as const, id: "user-1", verified: true };

function makeLedger(): TaskLedger {
	const ledger = new TaskLedger({ sessionId: "s-1" });
	ledger.createTask({ goal: "write the implementation taskbook", constraints: undefined } as never, user, "ev-001");
	ledger.apply(
		{ operation: "ADD_ACCEPTANCE_CRITERION", taskId: "T1", acceptanceCriterion: "must include phase gates" },
		user,
		"ev-002",
	);
	ledger.apply({ operation: "CREATE_TASK", goal: "research memory retrieval" }, user, "ev-003");
	ledger.apply({ operation: "SET_FOCUS", taskId: "T1" }, user, "ev-004");
	return ledger;
}

describe("renderPinnedLedgerLayer", () => {
	it("renders the focus task fully, others as lossless index, plus pending changes", () => {
		const ledger = makeLedger();
		ledger.recordPendingGoalChange({ candidateTaskIds: ["T2"], reason: "ambiguous scope", sourceEventId: "ev-009" });
		const text = renderPinnedLedgerLayer(ledger);
		// Focus task: full contract.
		expect(text).toContain("T1");
		expect(text).toContain("write the implementation taskbook");
		expect(text).toContain("must include phase gates");
		// Non-terminal index: the other task appears as a one-line index entry.
		expect(text).toContain("T2");
		expect(text).toMatch(/T2[^\n]*(research memory retrieval)/);
		// Pending change surfaced.
		expect(text).toContain("ambiguous scope");
	});
});

describe("orchestrator + task ledger CAS", () => {
	function setup(mutate?: (deps: OrchestratorDeps) => void): OrchestratorDeps & { ledger: TaskLedger } {
		const sessionId = "s-1";
		const eventLog = new InMemoryEventLog();
		eventLog.append({
			sessionId,
			agentId: "a-1",
			eventId: "e-1",
			eventType: "message",
			payload: { text: `user: ${"work ".repeat(300)}` },
			authority: user,
		});
		eventLog.append({
			sessionId,
			agentId: "a-1",
			eventId: "e-2",
			eventType: "tool_call",
			toolCallId: "tc-1",
			payload: { name: "bash", arguments: { command: "build" } },
			authority: user,
		});
		eventLog.append({
			sessionId,
			agentId: "a-1",
			eventId: "e-3",
			eventType: "tool_result",
			toolCallId: "tc-1",
			payload: { isError: false, content: `log ${"x".repeat(4000)}`, exitCode: 0 },
			authority: user,
		});
		eventLog.append({
			sessionId,
			agentId: "a-1",
			eventId: "e-4",
			eventType: "message",
			payload: { text: "assistant: built" },
			authority: user,
		});
		const contractStore = new InMemoryContractStore();
		contractStore.create({
			contractId: "c-1",
			sessionId,
			goal: "g",
			acceptanceCriteria: [],
			constraints: [{ id: "c-1", kind: "negative", text: "Never delete raw events", authority: user }],
			permissions: { allow: [], deny: [], approvalRequired: [] },
			budgets: {},
			authority: user,
			allowedUpdaters: ["user-1"],
		});
		const artifactStore = new InMemoryArtifactStore();
		const ledger = makeLedger();
		const deps: OrchestratorDeps & { ledger: TaskLedger } = {
			sessionId,
			eventLog,
			artifactStore,
			contractStore,
			snapshotStore: new InMemorySnapshotStore(),
			recallCatalog: new RecallCatalog({ store: artifactStore, tenant: "t-1" }),
			audit: new AuditTrail(),
			complete: async (req) => ({
				text: req.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "narrative",
				stopReason: "stop",
				usage: { input: 10, output: 10 },
			}),
			tenant: "t-1",
			policy: { maxInlineBytes: 1000, keepRecentToolResults: 0, toolExclusions: [], highRiskTools: [] },
			keepRecentTokens: 50,
			systemPrompt: "SYS",
			outputReserveTokens: 100,
			minTokenGainFraction: -1,
			ledger,
		};
		mutate?.(deps);
		return deps;
	}

	it("commits when the ledger version is stable; snapshot stores only the ref", async () => {
		const deps = setup();
		const result = await new CompactionOrchestrator(deps).compact("soft_compact", { currentInput: "go" });
		expect(result.status).toBe("activated");
		const active = deps.snapshotStore.getActive("s-1")!;
		expect(active.taskLedgerRef).toBeDefined();
		expect(active.taskLedgerRef!.focusTaskId).toBe("T1");
		expect(active.taskLedgerRef!.ledgerVersion).toBe(deps.ledger.getLedgerVersion());
		expect(active.taskLedgerRef!.focusContractVersion).toBe(2);
		expect(active.taskLedgerRef!.taskRef).toBe("task://T1/v2");
		// The snapshot must not duplicate the goal's authoritative text.
		expect(JSON.stringify(active)).not.toContain("write the implementation taskbook");
	});

	it("rejects the candidate when the ledger version drifts during compaction", async () => {
		const deps = setup((d) => {
			const original = d.complete;
			d.complete = async (req) => {
				// A new task arrives mid-compaction.
				if (req.responseSchema && d.ledger!.getLedgerVersion() === 4) {
					d.ledger!.createTask({ goal: "urgent new task" }, user, "ev-100");
				}
				return original(req);
			};
		});
		const result = await new CompactionOrchestrator(deps).compact("soft_compact", { currentInput: "go" });
		expect(result.status).toBe("rejected");
		expect(result.report?.failures.some((f) => f.code === "task-ledger-ref")).toBe(true);
		expect(deps.snapshotStore.getActive("s-1")).toBeUndefined();
	});

	it("rejects a ledger race induced inside the final activation assertion", async () => {
		const deps = setup();
		let raced = false;
		class FinalActivationRaceStore extends InMemorySnapshotStore {
			override activate(sessionId: string, request: ActivateRequest) {
				return super.activate(sessionId, {
					...request,
					assertExternalState: () => {
						if (!raced) {
							raced = true;
							deps.ledger.createTask({ goal: "arrived at final activation" }, user, "ev-final-race");
						}
						request.assertExternalState?.();
					},
				});
			}
		}
		deps.snapshotStore = new FinalActivationRaceStore();

		const result = await new CompactionOrchestrator(deps).compact("soft_compact", { currentInput: "go" });
		expect(raced).toBe(true);
		expect(result.status).toBe("rejected");
		expect(result.report?.failures.some((failure) => failure.code === "task-ledger-drift")).toBe(true);
		expect(deps.snapshotStore.getActive("s-1")).toBeUndefined();
		expect(deps.snapshotStore.listVersions("s-1")).toHaveLength(1);
	});

	it("rejects a global-contract race induced inside the final activation assertion", async () => {
		const deps = setup();
		let raced = false;
		class FinalContractRaceStore extends InMemorySnapshotStore {
			override activate(sessionId: string, request: ActivateRequest) {
				return super.activate(sessionId, {
					...request,
					assertExternalState: () => {
						if (!raced) {
							raced = true;
							const proposal = deps.contractStore.proposeUpdate("s-1", { budgets: { maxTokens: 1234 } }, user);
							deps.contractStore.approveProposal("s-1", proposal.proposalId, user);
						}
						request.assertExternalState?.();
					},
				});
			}
		}
		deps.snapshotStore = new FinalContractRaceStore();

		const result = await new CompactionOrchestrator(deps).compact("soft_compact", { currentInput: "go" });
		expect(result.status).toBe("rejected");
		expect(result.report?.failures.some((failure) => failure.code === "contract-drift")).toBe(true);
		expect(deps.snapshotStore.getActive("s-1")).toBeUndefined();
	});

	it("freezes the ledger ref on offload-only and rebuild candidates", async () => {
		const offloadDeps = setup();
		const offloaded = await new CompactionOrchestrator(offloadDeps).compact("offload_only", { currentInput: "go" });
		expect(offloaded.status).toBe("activated");
		expect(offloadDeps.snapshotStore.getActive("s-1")?.taskLedgerRef?.taskRef).toBe("task://T1/v2");

		const rebuildDeps = setup();
		const first = await new CompactionOrchestrator(rebuildDeps).compact("soft_compact", { currentInput: "go" });
		expect(first.status).toBe("activated");
		rebuildDeps.rebuildRunner = async (_sessionId, boundarySeq) =>
			(await rawRebuild(rebuildDeps, { toSeq: boundarySeq })).snapshot;
		const rebuilt = await new CompactionOrchestrator(rebuildDeps).compact("full_rebuild", { currentInput: "go" });
		expect(rebuilt.status).toBe("rebuilt");
		expect(rebuildDeps.snapshotStore.getActive("s-1")?.taskLedgerRef).toEqual({
			ledgerVersion: rebuildDeps.ledger.getLedgerVersion(),
			focusTaskId: "T1",
			focusContractVersion: 2,
			taskRef: "task://T1/v2",
		});
	});
	describe("orchestrator tools token accounting (T-005)", () => {
		it("counts the tool-definition estimate into the next-request token totals", async () => {
			const base = setup();
			const withTools = setup((d) => {
				d.toolsTokenEstimate = 5000;
			});
			const resultBase = await new CompactionOrchestrator(base).compact("soft_compact", { currentInput: "go" });
			const resultTools = await new CompactionOrchestrator(withTools).compact("soft_compact", {
				currentInput: "go",
			});
			expect(resultBase.status).toBe("activated");
			expect(resultTools.status).toBe("activated");
			const totalBase = base.snapshotStore.getActive("s-1")!.tokenStats.total;
			const totalTools = withTools.snapshotStore.getActive("s-1")!.tokenStats.total;
			expect(totalTools - totalBase).toBe(5000);
		});

		it("counts pending input image tokens in both activation totals", async () => {
			const base = setup();
			const withImages = setup();
			const resultBase = await new CompactionOrchestrator(base).compact("soft_compact", { currentInput: "go" });
			const resultImages = await new CompactionOrchestrator(withImages).compact("soft_compact", {
				currentInput: "go",
				currentInputExtraTokens: 2400,
			});
			expect(resultBase.status).toBe("activated");
			expect(resultImages.status).toBe("activated");
			expect(
				withImages.snapshotStore.getActive("s-1")!.tokenStats.total -
					base.snapshotStore.getActive("s-1")!.tokenStats.total,
			).toBe(2400);
		});
	});
});
