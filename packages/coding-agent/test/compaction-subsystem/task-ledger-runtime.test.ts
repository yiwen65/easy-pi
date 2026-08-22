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
	it("awaits goal interpretation between persisted user messages and assistant turns", async () => {
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
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
	});

	it("keeps the fixed layer on provider requests after tool calls", async () => {
		const h = await createHarness({
			contextWindow: 100_000,
			baseToolsOverride: { echo: echoTool() },
			responses: [{ toolCalls: [{ name: "echo", args: {} }] }, "done"],
		});
		harnesses.push(h);
		await h.session.prompt("ship the taskbook");
		expect(h.faux.contexts).toHaveLength(2);
		expect(h.faux.contexts[1].systemPrompt).toContain("Current focus task T1");
	});

	it("injects current focus and pending warnings before each provider call", async () => {
		const h = await createHarness({
			contextWindow: 100_000,
			hfCompaction: {
				mode: "full_pipeline",
				goalComplete: async (request) => ({
					text: JSON.stringify({
						operations: request.messages[0]?.content.includes("cancel this task")
							? [{ operation: "CANCEL_TASK", taskId: "T1" }]
							: [],
					}),
					stopReason: "stop",
				}),
			},
			responses: ["first answer", "second answer", "third answer"],
		});
		harnesses.push(h);
		await h.session.prompt("ship the taskbook");

		await h.session.prompt("cancel this task");
		expect(h.faux.contexts[1].systemPrompt).toContain("Current focus task T1");
		expect(JSON.stringify(h.faux.contexts[1].messages)).toContain("Pending goal changes");
		expect(JSON.stringify(h.faux.contexts[1].messages)).toContain("CANCEL_TASK");
		const pending = h.session.getTaskLedgerState().pending[0];
		h.session.acceptPendingGoalChange(pending.pendingChangeId);

		await h.session.prompt("continue");
		expect(JSON.stringify(h.faux.contexts[2].messages)).not.toContain("Pending goal changes");
		expect(h.session.getTaskLedgerState().tasks[0].status).toBe("cancelled");
	});
});

describe("HfCompactionHost task-ledger runtime wiring", () => {
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

	it("preserves dangerous proposals and exposes deterministic accept/reject controls", async () => {
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
		const second = userEntry("m-2", "replace it with an API design", "m-1");
		const pending = await host.processUserMessage({
			branchEntries: [first, second],
			sourceEventId: second.id,
			userMessage: "replace it with an API design",
			complete: completeOperations([
				{ operation: "SUPERSEDE_TASK", taskId: "T1", replacementGoal: "write the API design" },
			]),
		});
		expect(pending.outcome).toBe("pending");
		const proposal = host.getTaskLedgerState().pending[0];
		expect(proposal.operations).toEqual([
			{ operation: "SUPERSEDE_TASK", taskId: "T1", replacementGoal: "write the API design" },
		]);
		host.acceptPendingGoalChange(proposal.pendingChangeId);
		expect(host.getTaskLedgerState()).toMatchObject({
			focusTaskId: "T2",
			pending: [],
			tasks: [
				{ taskId: "T1", status: "superseded" },
				{ taskId: "T2", status: "active", goal: { normalized: "write the API design" } },
			],
		});

		const third = userEntry("m-3", "cancel the API design", "m-2");
		await host.processUserMessage({
			branchEntries: [first, second, third],
			sourceEventId: third.id,
			userMessage: "cancel the API design",
			complete: completeOperations([{ operation: "CANCEL_TASK", taskId: "T2" }]),
		});
		const toReject = host.getTaskLedgerState().pending[0];
		host.rejectPendingGoalChange(toReject.pendingChangeId);
		expect(host.getTaskLedgerState().tasks.find((task) => task.taskId === "T2")?.status).toBe("active");
		expect(host.getTaskLedgerState().pending).toEqual([]);
	});

	it("replays focus and pending proposals after restart, then persists acceptance", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "hf-task-ledger-"));
		tempDirs.push(stateDir);
		const first = userEntry("m-1", "write the taskbook", null);
		const second = userEntry("m-2", "replace it with an API design", "m-1");
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
			userMessage: "replace it with an API design",
			complete: completeOperations([
				{ operation: "SUPERSEDE_TASK", taskId: "T1", replacementGoal: "write the API design" },
			]),
		});
		const pendingId = host1.getTaskLedgerState().pending[0].pendingChangeId;

		const host2 = new HfCompactionHost({
			sessionId: "durable-ledger",
			getSystemPrompt: () => "system",
			config: { mode: "full_pipeline", stateDir },
		});
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
		expect(host3.getTaskLedgerState()).toMatchObject({
			focusTaskId: "T2",
			pending: [],
			tasks: [
				{ taskId: "T1", status: "superseded" },
				{ taskId: "T2", status: "active", goal: { normalized: "write the API design" } },
			],
		});
	});
});
