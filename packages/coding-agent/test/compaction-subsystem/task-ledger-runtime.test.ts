import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { HfCompactionHost } from "../../src/core/compaction/subsystem/session-integration.ts";
import type { CompleteFn } from "../../src/core/compaction/subsystem/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../test-harness.ts";

const harnesses: Harness[] = [];
const tempDirs: string[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function userEntry(id: string, text: string, parentId: string | null): Extract<SessionEntry, { type: "message" }> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	};
}

function echoTool(): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Returns ok",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
	};
}

function completeOperations(operations: unknown[]): CompleteFn {
	return async () => ({
		text: JSON.stringify({ operations }),
		stopReason: "stop",
		usage: { input: 1, output: 1 },
	});
}

describe("AgentSession task-ledger message wiring", () => {
	it("does not call task interpretation or reconciliation by default without compaction pressure", async () => {
		let goalInterpreterCalls = 0;
		let reconcileCalls = 0;
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				goalComplete: async () => {
					goalInterpreterCalls += 1;
					return { text: JSON.stringify({ operations: [] }), stopReason: "stop" };
				},
				reconcileComplete: async () => {
					reconcileCalls += 1;
					return { text: JSON.stringify({ findings: [] }), stopReason: "stop" };
				},
			},
			responses: ["first answer", "second answer"],
		});
		harnesses.push(h);

		await h.session.prompt("ship the taskbook");
		await h.session.prompt("continue without changing the goal");

		expect(goalInterpreterCalls).toBe(0);
		expect(reconcileCalls).toBe(0);
	});

	it("awaits goal interpretation between persisted user messages and assistant turns", async () => {
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				taskInterpretationEnabled: true,
				goalComplete: completeOperations([
					{ operation: "REFINE_TASK", taskId: "T1", goal: "ship the taskbook with interactive controls" },
				]),
			},
			responses: ["first answer", "second answer"],
		});
		harnesses.push(h);
		await h.session.prompt("ship the taskbook");
		expect(h.session.getTaskLedgerState()).toMatchObject({ focusTaskId: "T1", tasks: [{ version: 1 }] });
		await h.session.prompt("also add interactive controls");
		expect(h.session.getTaskLedgerState().tasks[0]).toMatchObject({
			version: 2,
			goal: { normalized: "ship the taskbook with interactive controls" },
		});
		expect(h.faux.contexts[1].systemPrompt).toContain("contract v2");
		expect(h.faux.contexts[1].systemPrompt).toContain("ship the taskbook with interactive controls");
		expect(JSON.stringify(h.faux.contexts[1].messages)).not.toContain("# Current focus task T1");
	});

	it("interprets requirement changes even when the old keyword gate would miss them", async () => {
		let goalInterpreterCalls = 0;
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				taskInterpretationEnabled: true,
				goalComplete: async (request) => {
					goalInterpreterCalls += 1;
					const content = request.messages[0]?.content ?? "";
					return {
						text: JSON.stringify({
							operations: content.includes("不要改 README")
								? [
										{
											operation: "PATCH_TASK_CONTRACT",
											taskId: "T1",
											taskPatch: { addExclusions: ["README"] },
										},
									]
								: [],
						}),
						stopReason: "stop",
					};
				},
			},
			responses: ["first answer", "second answer", "third answer"],
		});
		harnesses.push(h);

		await h.session.prompt("ship the taskbook");
		await h.session.prompt("把回答控制在三段内，不要改 README");
		expect(goalInterpreterCalls).toBe(1);
		expect(h.session.getTaskLedgerState().tasks[0]).toMatchObject({
			version: 2,
			goal: { exclusions: ["README"] },
		});
		expect(h.faux.contexts[1].systemPrompt).toContain("Goal exclusions: README");
		expect(JSON.stringify(h.faux.contexts[1].messages)).not.toContain("# Current focus task T1");

		await h.session.prompt("thanks for the explanation");
		expect(goalInterpreterCalls).toBe(2);
		expect(h.session.getTaskLedgerState().tasks[0].version).toBe(2);
	});

	it("runs semantic reconciliation periodically with an independent evaluator", async () => {
		let reconcileCalls = 0;
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				taskInterpretationEnabled: true,
				reconciliationEnabled: true,
				reconciliationIntervalTurns: 2,
				goalComplete: async () => ({ text: JSON.stringify({ operations: [] }), stopReason: "stop" }),
				reconcileComplete: async () => {
					reconcileCalls += 1;
					return { text: JSON.stringify({ findings: [] }), stopReason: "stop" };
				},
			},
			responses: ["one", "two", "three", "four"],
		});
		harnesses.push(h);

		await h.session.prompt("first requirement");
		expect(reconcileCalls).toBe(0);
		await h.session.prompt("second requirement");
		expect(reconcileCalls).toBe(1);
		const firstReport = h.session.getLatestTaskReconciliation();
		expect(firstReport).toMatchObject({ branchId: expect.any(String), findings: [] });

		await h.session.prompt("third requirement");
		expect(reconcileCalls).toBe(1);
		await h.session.prompt("fourth requirement");
		expect(reconcileCalls).toBe(2);
		expect(h.session.getLatestTaskReconciliation()?.reportId).not.toBe(firstReport?.reportId);
		expect(h.session.getTaskLedgerState().tasks[0].version).toBe(1);
	});

	it("disables periodic reconciliation without disabling explicit force", async () => {
		let reconcileCalls = 0;
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				reconciliationEnabled: false,
				reconciliationIntervalTurns: 1,
				reconcileComplete: async () => {
					reconcileCalls += 1;
					return { text: JSON.stringify({ findings: [] }), stopReason: "stop" };
				},
			},
			responses: ["one", "two"],
		});
		harnesses.push(h);
		await h.session.prompt("first requirement");
		await h.session.prompt("second requirement");
		expect(reconcileCalls).toBe(0);
		await h.session.reconcileTaskContract();
		expect(reconcileCalls).toBe(1);
	});

	it("supports forced read-only reconciliation before the periodic interval", async () => {
		let reconcileCalls = 0;
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				reconciliationIntervalTurns: 8,
				reconcileComplete: async () => {
					reconcileCalls += 1;
					return { text: JSON.stringify({ findings: [] }), stopReason: "stop" };
				},
			},
			responses: ["one"],
		});
		harnesses.push(h);
		await h.session.prompt("first requirement");
		const versionBefore = h.session.getTaskLedgerState().ledgerVersion;

		const report = await h.session.reconcileTaskContract();

		expect(reconcileCalls).toBe(1);
		expect(report.findings).toEqual([]);
		expect(h.session.getLatestTaskReconciliation()?.reportId).toBe(report.reportId);
		expect(h.session.getTaskLedgerState().ledgerVersion).toBe(versionBefore);
	});

	it("resolves a single pending permission update from explicit verified-user approval text", async () => {
		let goalInterpreterCalls = 0;
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				taskInterpretationEnabled: true,
				goalComplete: async (request) => {
					goalInterpreterCalls += 1;
					if (!request.messages[0]?.content.includes("allow network")) {
						throw new Error("explicit approval must not call the proposal model");
					}
					return {
						text: JSON.stringify({
							operations: [
								{
									operation: "UPDATE_PERMISSIONS",
									taskId: "T1",
									permissions: { allow: ["network"], deny: [], approvalRequired: [] },
								},
							],
						}),
						stopReason: "stop",
					};
				},
			},
			responses: ["first answer", "proposal answer", "unrelated answer", "declined answer", "approval answer"],
		});
		harnesses.push(h);

		await h.session.prompt("ship the taskbook");
		await h.session.prompt("allow network access");
		expect(h.session.getTaskLedgerState()).toMatchObject({
			pending: [{ operations: [{ operation: "UPDATE_PERMISSIONS", taskId: "T1" }] }],
			tasks: [{ permissions: { allow: [] } }],
		});

		await h.session.prompt("I approve the analysis.");
		expect(goalInterpreterCalls).toBe(1);
		expect(h.session.getTaskLedgerState().pending).toHaveLength(1);
		expect(h.faux.contexts[2].systemPrompt).toContain("Pending goal changes");

		await h.session.prompt("Do not approve or authorize it.");
		expect(goalInterpreterCalls).toBe(1);
		expect(h.session.getTaskLedgerState().pending).toHaveLength(1);
		expect(h.faux.contexts[3].systemPrompt).toContain("Pending goal changes");

		await h.session.prompt("Approve and authorize it.");

		expect(goalInterpreterCalls).toBe(1);
		expect(h.session.getTaskLedgerState()).toMatchObject({
			pending: [],
			tasks: [{ permissions: { allow: ["network"], deny: [], approvalRequired: [] } }],
		});
		expect(h.faux.contexts[4].systemPrompt).toContain("allow: network");
		expect(JSON.stringify(h.faux.contexts[4].messages)).not.toContain("Pending goal changes");
		expect(JSON.stringify(h.faux.contexts[4].messages)).not.toContain("# Current focus task T1");
	});

	it("commits an explicit budget update without second approval", async () => {
		let goalInterpreterCalls = 0;
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				taskInterpretationEnabled: true,
				goalComplete: async (request) => {
					goalInterpreterCalls += 1;
					if (!request.messages[0]?.content.includes("update budget")) {
						throw new Error("unexpected proposal-model call");
					}
					return {
						text: JSON.stringify({
							operations: [{ operation: "UPDATE_BUDGETS", taskId: "T1", budgets: { maxTokens: 200_000 } }],
						}),
						stopReason: "stop",
					};
				},
			},
			responses: ["first answer", "updated answer"],
		});
		harnesses.push(h);

		await h.session.prompt("ship the taskbook");
		await h.session.prompt("update budget max tokens to 200000");

		expect(goalInterpreterCalls).toBe(1);
		expect(h.session.getTaskLedgerState()).toMatchObject({
			pending: [],
			tasks: [{ budgets: { maxTokens: 200_000 } }],
		});
		expect(h.faux.contexts[1].systemPrompt).toContain("max tokens: 200000");
		expect(JSON.stringify(h.faux.contexts[1].messages)).not.toContain("# Current focus task T1");
		expect(JSON.stringify(h.faux.contexts[1].messages)).not.toContain("Pending goal changes");
	});

	it("keeps the fixed layer on provider requests after tool calls", async () => {
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: { mode: "full_pipeline", taskInterpretationEnabled: true },
			baseToolsOverride: { echo: echoTool() },
			responses: [{ toolCalls: [{ name: "echo", args: {} }] }, "done"],
		});
		harnesses.push(h);
		await h.session.prompt("ship the taskbook");
		expect(h.faux.contexts).toHaveLength(2);
		expect(h.faux.contexts[1].systemPrompt).toContain("Current focus task T1");
	});

	it("keeps current focus and pending warnings in the authoritative system layer", async () => {
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				taskInterpretationEnabled: true,
				goalComplete: async (request) => ({
					text: JSON.stringify({
						operations: request.messages[0]?.content.includes("allow network")
							? [
									{
										operation: "UPDATE_PERMISSIONS",
										taskId: "T1",
										permissions: { allow: ["network"], deny: [], approvalRequired: [] },
									},
								]
							: [],
					}),
					stopReason: "stop",
				}),
			},
			responses: ["first answer", "second answer", "third answer"],
		});
		harnesses.push(h);
		await h.session.prompt("ship the taskbook");

		await h.session.prompt("allow network");
		expect(h.faux.contexts[1].systemPrompt).toContain("Current focus task T1");
		expect(h.faux.contexts[1].systemPrompt).toContain("Pending goal changes");
		expect(h.faux.contexts[1].systemPrompt).toContain("UPDATE_PERMISSIONS");
		expect(JSON.stringify(h.faux.contexts[1].messages)).not.toContain("# Current focus task T1");
		const pending = h.session.getTaskLedgerState().pending[0];
		h.session.acceptPendingGoalChange(pending.pendingChangeId);

		await h.session.prompt("continue");
		expect(JSON.stringify(h.faux.contexts[2].messages)).not.toContain("Pending goal changes");
		expect(h.session.getTaskLedgerState().tasks[0].permissions.allow).toEqual(["network"]);
	});
});

describe("HfCompactionHost task-ledger runtime wiring", () => {
	it("records repeated identical tool invocations as distinct operations", () => {
		const host = new HfCompactionHost({
			sessionId: "repeated-tool-call",
			getSystemPrompt: () => "system",
			config: { mode: "full_pipeline" },
		});
		const root = userEntry("root", "inspect the repository", null);
		host.syncFromEntries([root]);

		host.recordToolStarted("tool-1", "read", { path: "README.md" });
		host.recordToolFinished("tool-1", false);
		host.recordToolStarted("tool-2", "read", { path: "README.md" });
		host.recordToolFinished("tool-2", false);

		expect(host.ledger.list()).toMatchObject([
			{ toolCallId: "tool-1", state: "succeeded" },
			{ toolCallId: "tool-2", state: "succeeded" },
		]);
	});

	it("creates T1 from the first persisted user event and interprets later messages", async () => {
		const host = new HfCompactionHost({
			sessionId: "runtime-1",
			getSystemPrompt: () => "system",
			config: { mode: "full_pipeline" },
		});
		const first = userEntry("m-1", "write the implementation taskbook", null);
		let providerCalls = 0;
		const initial = await host.processUserMessage({
			branchEntries: [first],
			sourceEventId: first.id,
			userMessage: first.message.role === "user" ? String(first.message.content) : "",
			complete: async () => {
				providerCalls += 1;
				return { text: JSON.stringify({ operations: [] }), stopReason: "stop" };
			},
		});
		expect(initial.outcome).toBe("committed");
		expect(providerCalls).toBe(0);
		expect(host.getTaskLedgerState()).toMatchObject({
			ledgerVersion: 1,
			focusTaskId: "T1",
			tasks: [{ taskId: "T1", goal: { normalized: "write the implementation taskbook" } }],
		});

		const second = userEntry("m-2", "refine it with recovery tests", "m-1");
		const refined = await host.processUserMessage({
			branchEntries: [first, second],
			sourceEventId: second.id,
			userMessage: "refine it with recovery tests",
			complete: completeOperations([
				{ operation: "REFINE_TASK", taskId: "T1", goal: "write the taskbook with recovery tests" },
			]),
		});
		expect(refined.outcome).toBe("committed");
		expect(host.getTaskLedgerState().tasks[0]).toMatchObject({
			version: 2,
			goal: { normalized: "write the taskbook with recovery tests", verbatimSourceEventIds: ["m-1", "m-2"] },
		});
	});

	it("preserves security and ambiguity proposals with deterministic accept/reject controls", async () => {
		const host = new HfCompactionHost({
			sessionId: "runtime-2",
			getSystemPrompt: () => "system",
			config: { mode: "full_pipeline" },
		});
		const first = userEntry("m-1", "write the taskbook", null);
		await host.processUserMessage({
			branchEntries: [first],
			sourceEventId: first.id,
			userMessage: "write the taskbook",
			complete: completeOperations([]),
		});
		const second = userEntry("m-2", "allow network", "m-1");
		const pending = await host.processUserMessage({
			branchEntries: [first, second],
			sourceEventId: second.id,
			userMessage: "allow network",
			complete: completeOperations([
				{
					operation: "UPDATE_PERMISSIONS",
					taskId: "T1",
					permissions: { allow: ["network"], deny: [], approvalRequired: [] },
				},
			]),
		});
		expect(pending.outcome).toBe("pending");
		const proposal = host.getTaskLedgerState().pending[0];
		expect(proposal.operations[0]).toMatchObject({ operation: "UPDATE_PERMISSIONS", taskId: "T1" });
		host.acceptPendingGoalChange(proposal.pendingChangeId);
		expect(host.getTaskLedgerState()).toMatchObject({
			focusTaskId: "T1",
			pending: [],
			tasks: [{ taskId: "T1", permissions: { allow: ["network"] } }],
		});

		const third = userEntry("m-3", "focus that task", "m-2");
		await host.processUserMessage({
			branchEntries: [first, second, third],
			sourceEventId: third.id,
			userMessage: "focus that task",
			complete: completeOperations([
				{
					operation: "SET_FOCUS",
					ambiguous: true,
					candidateTaskIds: ["T1"],
					reason: "target requires clarification",
				},
			]),
		});
		const toReject = host.getTaskLedgerState().pending[0];
		host.rejectPendingGoalChange(toReject.pendingChangeId);
		expect(host.getTaskLedgerState().focusTaskId).toBe("T1");
		expect(host.getTaskLedgerState().pending).toEqual([]);
	});

	it("isolates sibling task and tool ledgers across equal-length switches and restart", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "hf-branch-ledger-"));
		tempDirs.push(stateDir);
		const root = userEntry("root", "build the taskbook", null);
		const branchA = userEntry("branch-a", "use branch A goal", "root");
		const branchB = userEntry("branch-b", "use branch B goal", "root");
		const host = new HfCompactionHost({
			sessionId: "branch-ledger",
			getSystemPrompt: () => "system",
			config: { mode: "full_pipeline", stateDir },
		});
		const durableLog = host.eventLog.getBaseLog();
		await host.processUserMessage({
			branchEntries: [root],
			sourceEventId: root.id,
			userMessage: "build the taskbook",
			complete: completeOperations([]),
		});
		await host.processUserMessage({
			branchEntries: [root, branchA],
			sourceEventId: branchA.id,
			userMessage: "use branch A goal",
			complete: completeOperations([{ operation: "REFINE_TASK", taskId: "T1", goal: "branch A goal" }]),
		});
		host.recordToolStarted("tool-a", "read", { path: "a" });
		host.recordToolFinished("tool-a", false);

		host.syncFromEntries([root]);
		expect(host.getTaskLedgerState()).toMatchObject({
			branchId: "root",
			tasks: [{ goal: { normalized: "build the taskbook" } }],
		});
		expect(host.ledger.list()).toEqual([]);
		expect(host.eventLog.getBaseLog()).toBe(durableLog);

		await host.processUserMessage({
			branchEntries: [root, branchB],
			sourceEventId: branchB.id,
			userMessage: "use branch B goal",
			complete: completeOperations([{ operation: "REFINE_TASK", taskId: "T1", goal: "branch B goal" }]),
		});
		host.recordToolStarted("tool-b", "read", { path: "b" });
		host.recordToolFinished("tool-b", false);

		host.syncFromEntries([root, branchA]);
		expect(host.getTaskLedgerState()).toMatchObject({
			branchId: "branch-a",
			tasks: [{ version: 2, goal: { normalized: "branch A goal" } }],
		});
		expect(host.ledger.list().map((item) => item.toolCallId)).toEqual(["tool-a"]);

		host.syncFromEntries([root, branchB]);
		expect(host.getTaskLedgerState()).toMatchObject({
			branchId: "branch-b",
			tasks: [{ version: 2, goal: { normalized: "branch B goal" } }],
		});
		expect(host.ledger.list().map((item) => item.toolCallId)).toEqual(["tool-b"]);

		const restarted = new HfCompactionHost({
			sessionId: "branch-ledger",
			getSystemPrompt: () => "system",
			config: { mode: "full_pipeline", stateDir },
		});
		restarted.syncFromEntries([root, branchA]);
		expect(restarted.getTaskLedgerState().tasks[0].goal.normalized).toBe("branch A goal");
		expect(restarted.ledger.list().map((item) => item.toolCallId)).toEqual(["tool-a"]);
		restarted.syncFromEntries([root, branchB]);
		expect(restarted.getTaskLedgerState().tasks[0].goal.normalized).toBe("branch B goal");
		expect(restarted.ledger.list().map((item) => item.toolCallId)).toEqual(["tool-b"]);
	});

	it("replays focus and pending proposals after restart, then persists acceptance", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "hf-task-ledger-"));
		tempDirs.push(stateDir);
		const first = userEntry("m-1", "write the taskbook", null);
		const second = userEntry("m-2", "allow network", "m-1");
		const host1 = new HfCompactionHost({
			sessionId: "durable-ledger",
			getSystemPrompt: () => "system",
			config: { mode: "full_pipeline", stateDir },
		});
		await host1.processUserMessage({
			branchEntries: [first],
			sourceEventId: first.id,
			userMessage: "write the taskbook",
			complete: completeOperations([]),
		});
		await host1.processUserMessage({
			branchEntries: [first, second],
			sourceEventId: second.id,
			userMessage: "allow network",
			complete: completeOperations([
				{
					operation: "UPDATE_PERMISSIONS",
					taskId: "T1",
					permissions: { allow: ["network"], deny: [], approvalRequired: [] },
				},
			]),
		});
		const pendingId = host1.getTaskLedgerState().pending[0].pendingChangeId;

		const host2 = new HfCompactionHost({
			sessionId: "durable-ledger",
			getSystemPrompt: () => "system",
			config: { mode: "full_pipeline", stateDir },
		});
		host2.syncFromEntries([first, second]);
		expect(host2.getTaskLedgerState()).toMatchObject({
			focusTaskId: "T1",
			pending: [{ pendingChangeId: pendingId }],
		});
		host2.acceptPendingGoalChange(pendingId);

		const host3 = new HfCompactionHost({
			sessionId: "durable-ledger",
			getSystemPrompt: () => "system",
			config: { mode: "full_pipeline", stateDir },
		});
		host3.syncFromEntries([first, second]);
		expect(host3.getTaskLedgerState()).toMatchObject({
			focusTaskId: "T1",
			pending: [],
			tasks: [{ taskId: "T1", status: "active", permissions: { allow: ["network"] } }],
		});
	});
});
