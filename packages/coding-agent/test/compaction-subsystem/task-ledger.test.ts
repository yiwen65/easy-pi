import { describe, expect, it } from "vitest";
import { type AppendEventInput, InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import { replayTaskLedger, TaskLedger } from "../../src/core/compaction/subsystem/task-ledger.ts";

const user = { kind: "user" as const, id: "user-1", verified: true };
const agent = { kind: "agent" as const, id: "agent-1", verified: true };

function setup() {
	const eventLog = new InMemoryEventLog();
	const ledger = new TaskLedger({ eventLog, sessionId: "s-1" });
	return { eventLog, ledger };
}

describe("TaskLedger operations", () => {
	it("creates tasks with verbatim source refs; first message creates the first task only", () => {
		const { ledger } = setup();
		const t1 = ledger.createTask({ goal: "调研主流 Agent 的 Context Compaction" }, user, "ev-001");
		expect(t1.taskId).toBe("T1");
		expect(t1.version).toBe(1);
		expect(t1.status).toBe("active");
		expect(t1.goal.verbatimSourceEventIds).toEqual(["ev-001"]);
		expect(ledger.getFocusTaskId()).toBe("T1");
		expect(ledger.getLedgerVersion()).toBe(1);
	});

	it("new task creation never implicitly completes or cancels older tasks (G6)", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "task one" }, user, "ev-001");
		const t2 = ledger.createTask({ goal: "task two" }, user, "ev-002");
		expect(ledger.getTask("T1")?.status).toBe("active"); // not auto-completed
		expect(t2.taskId).toBe("T2");
		expect(ledger.getFocusTaskId()).toBe("T2");
		expect(ledger.getTaskHistory("T1")).toHaveLength(1);
		const background = ledger.createTask({ goal: "task three", dependsOn: ["T1"], setFocus: false }, user, "ev-003");
		expect(background.relations.dependsOn).toEqual(["T1"]);
		expect(ledger.getFocusTaskId()).toBe("T2");
		expect(() => ledger.createTask({ goal: "dangling", dependsOn: ["T9"] }, user, "ev-004")).toThrow(
			/unknown task T9/i,
		);
	});

	it("REFINE keeps task_id and bumps version with provenance; EXTEND adds acceptance criteria", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "write the taskbook" }, user, "ev-001");
		const refined = ledger.apply(
			{ operation: "REFINE_TASK", taskId: "T1", goal: "write the taskbook with failure-recovery tests" },
			user,
			"ev-002",
		);
		expect(refined.taskId).toBe("T1");
		expect(refined.version).toBe(2);
		expect(refined.goal.normalized).toContain("failure-recovery");
		expect(refined.provenance.updatedFromEvents).toContain("ev-002");
		const extended = ledger.apply(
			{ operation: "ADD_ACCEPTANCE_CRITERION", taskId: "T1", acceptanceCriterion: "include drift evaluation" },
			user,
			"ev-003",
		);
		expect(extended.acceptanceCriteria).toContain("include drift evaluation");
		expect(extended.version).toBe(3);
	});

	it("SUSPEND + subtask switches focus; RESUME restores it via the focus stack", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "main task" }, user, "ev-001");
		ledger.apply({ operation: "SUSPEND_TASK", taskId: "T1" }, user, "ev-002");
		const sub = ledger.apply(
			{ operation: "CREATE_SUBTASK", parentTaskId: "T1", goal: "urgent analysis" },
			user,
			"ev-003",
		);
		expect(ledger.getTask("T1")?.status).toBe("suspended");
		expect(ledger.getFocusTaskId()).toBe(sub.taskId);
		expect(ledger.getTask("T1")!.status).toBe("suspended");
		ledger.apply({ operation: "SUPERSEDE_TASK", taskId: sub.taskId, replacementGoal: undefined }, user, "ev-004");
		// After the subtask ends, resume pops the stack back to T1.
		ledger.apply({ operation: "RESUME_TASK", taskId: "T1" }, user, "ev-005");
		expect(ledger.getFocusTaskId()).toBe("T1");
		expect(ledger.getTask("T1")?.status).toBe("active");
	});

	it("SUPERSEDE marks the old task and links the replacement", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "taskbook" }, user, "ev-001");
		const t5 = ledger.apply(
			{ operation: "SUPERSEDE_TASK", taskId: "T1", replacementGoal: "API design doc" },
			user,
			"ev-002",
		);
		expect(ledger.getTask("T1")?.status).toBe("superseded");
		expect(t5.relations.supersedes).toBe("T1");
		expect(ledger.getFocusTaskId()).toBe(t5.taskId);
	});

	it("G4: goal/acceptance/permissions/hard-constraint changes require verified user authority", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "g" }, user, "ev-001");
		expect(() => ledger.apply({ operation: "REFINE_TASK", taskId: "T1", goal: "hijacked" }, agent, "ev-002")).toThrow(
			/user|authority/i,
		);
		expect(() =>
			ledger.apply(
				{
					operation: "ADD_CONSTRAINT",
					taskId: "T1",
					constraint: { id: "c-9", kind: "negative", text: "x", authority: agent },
				},
				agent,
				"ev-003",
			),
		).toThrow(/user|authority/i);
	});

	it("G7: completion requires evidence or explicit user confirmation", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "g" }, user, "ev-001");
		expect(() => ledger.completeTask("T1", agent, "ev-002")).toThrow(/evidence|user/i);
		const doneTask = ledger.completeTask("T1", user, "ev-003", { userConfirmed: true });
		expect(doneTask.status).toBe("completed");
	});

	it("G2: task creation requires a resolvable user source event", () => {
		const { ledger } = setup();
		expect(() => ledger.createTask({ goal: "orphan" }, user, "")).toThrow(/source/i);
	});

	it("unknown operations targets and illegal transitions are rejected explicitly", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "g" }, user, "ev-001");
		expect(() => ledger.apply({ operation: "REFINE_TASK", taskId: "T9" }, user, "ev-002")).toThrow(
			/unknown|not exist/i,
		);
		ledger.completeTask("T1", user, "ev-003", { userConfirmed: true });
		expect(() => ledger.apply({ operation: "REFINE_TASK", taskId: "T1", goal: "z" }, user, "ev-004")).toThrow(
			/completed|terminal|reopen/i,
		);
	});

	it("the user's own example sequence (T1→T2→T3) is expressible", () => {
		const { ledger } = setup();
		const t1 = ledger.createTask({ goal: "调研主流 Agent 的 Context Compaction" }, user, "ev-001");
		ledger.completeTask(t1.taskId, user, "ev-010", { userConfirmed: true });
		const t2 = ledger.apply(
			{ operation: "CREATE_TASK", goal: "将调研结论转换为 Agent 实施任务书", dependsOn: ["T1"] },
			user,
			"ev-011",
		);
		ledger.completeTask(t2.taskId, user, "ev-020", { userConfirmed: true });
		ledger.apply(
			{ operation: "CREATE_SUBTASK", parentTaskId: "T2", goal: "分析固定层中 goal 如何随多轮任务更新" },
			user,
			"ev-021",
		);
		expect(ledger.getFocusTaskId()).toBe("T3");
		expect(ledger.getTask("T3")?.relations.parentTaskId).toBe("T2");
		expect(ledger.nonTerminalIndex().map((t) => t.taskId)).toEqual(["T3"]);
		// Completed tasks stay out of the non-terminal index but keep artifacts.
		expect(ledger.getTask("T1")?.status).toBe("completed");
	});

	it("is event-sourced: replay rebuilds identical state and ledger version", () => {
		const { eventLog, ledger } = setup();
		ledger.createTask({ goal: "a" }, user, "ev-001");
		ledger.apply({ operation: "CREATE_SUBTASK", parentTaskId: "T1", goal: "b" }, user, "ev-002");
		ledger.apply({ operation: "SUSPEND_TASK", taskId: "T2" }, user, "ev-003");
		const rebuilt = replayTaskLedger(eventLog.all("s-1"));
		expect(rebuilt.getFocusTaskId()).toBe(ledger.getFocusTaskId());
		expect(rebuilt.getLedgerVersion()).toBe(ledger.getLedgerVersion());
		expect(rebuilt.getTaskHistory("T1").length).toBe(ledger.getTaskHistory("T1").length);
	});

	it("pending goal changes are recorded for ambiguous updates (G10)", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "a" }, user, "ev-001");
		ledger.createTask({ goal: "b" }, user, "ev-002");
		ledger.recordPendingGoalChange({
			candidateTaskIds: ["T1", "T2"],
			reason: "reference 'this' is ambiguous",
			sourceEventId: "ev-003",
		});
		expect(ledger.getPendingGoalChanges()).toHaveLength(1);
		// No state was destructively modified.
		expect(ledger.getTask("T1")?.status).toBe("active");
		expect(ledger.getTask("T2")?.status).toBe("active");
	});
});

describe("TaskLedger replay fidelity and atomicity (T-001 regressions)", () => {
	it("replay preserves focus changes made by SET_FOCUS (taskless task_op events)", () => {
		const { eventLog, ledger } = setup();
		ledger.createTask({ goal: "a" }, user, "ev-001");
		ledger.createTask({ goal: "b" }, user, "ev-002"); // focus moves to T2
		ledger.apply({ operation: "SET_FOCUS", taskId: "T1" }, user, "ev-003"); // emits task_op without task
		expect(ledger.getFocusTaskId()).toBe("T1");
		const rebuilt = replayTaskLedger(eventLog.all("s-1"));
		expect(rebuilt.getFocusTaskId()).toBe("T1");
		expect(rebuilt.getLedgerVersion()).toBe(ledger.getLedgerVersion());
	});

	it("resolvePendingGoalChange bumps the ledger version and replays symmetrically", () => {
		const { eventLog, ledger } = setup();
		ledger.createTask({ goal: "a" }, user, "ev-001");
		ledger.recordPendingGoalChange({ candidateTaskIds: ["T1"], reason: "ambiguous", sourceEventId: "ev-002" });
		const before = ledger.getLedgerVersion();
		ledger.resolvePendingGoalChange(0, user, "ev-003");
		expect(ledger.getPendingGoalChanges()).toHaveLength(0);
		expect(ledger.getLedgerVersion()).toBe(before + 1);
		const rebuilt = replayTaskLedger(eventLog.all("s-1"));
		expect(rebuilt.getPendingGoalChanges()).toHaveLength(0);
		expect(rebuilt.getLedgerVersion()).toBe(ledger.getLedgerVersion());
	});

	it("resolving a missing pending change fails explicitly", () => {
		const { ledger } = setup();
		expect(() => ledger.resolvePendingGoalChange(0, user, "ev-001")).toThrow(/pending|index/i);
	});

	it("applyAtomic commits all operations or none (state, version, and events)", () => {
		const { eventLog, ledger } = setup();
		ledger.createTask({ goal: "a" }, user, "ev-001");
		const versionBefore = ledger.getLedgerVersion();
		const eventsBefore = eventLog.all("s-1").length;
		expect(() =>
			ledger.applyAtomic(
				[
					{ operation: "SUSPEND_TASK", taskId: "T1" },
					{ operation: "REFINE_TASK", taskId: "T9", goal: "ghost" },
				],
				user,
				"ev-002",
			),
		).toThrow(/unknown/i);
		// Nothing committed: state, ledger version, and event log are all untouched.
		expect(ledger.getTask("T1")?.status).toBe("active");
		expect(ledger.getTask("T1")?.version).toBe(1);
		expect(ledger.getLedgerVersion()).toBe(versionBefore);
		expect(eventLog.all("s-1")).toHaveLength(eventsBefore);

		// Success path commits everything and replays identically.
		const committed = ledger.applyAtomic(
			[
				{ operation: "SUSPEND_TASK", taskId: "T1" },
				{ operation: "RESUME_TASK", taskId: "T1" },
			],
			user,
			"ev-003",
		);
		expect(committed).toHaveLength(2);
		expect(ledger.getTask("T1")?.status).toBe("active");
		const rebuilt = replayTaskLedger(eventLog.all("s-1"));
		expect(rebuilt.getLedgerVersion()).toBe(ledger.getLedgerVersion());
		expect(rebuilt.getTask("T1")?.version).toBe(ledger.getTask("T1")?.version);
	});
});

describe("TaskLedger library closure regressions (T-401/T-402)", () => {
	it("deep-clones task and pending values at every public boundary", () => {
		const { ledger } = setup();
		const created = ledger.createTask({ goal: "original" }, user, "ev-001");
		created.goal.normalized = "mutated";
		created.goal.verbatimSourceEventIds.push("forged");
		created.provenance.createdBy.id = "forged";
		const fetched = ledger.getFocusTask()!;
		fetched.permissions.allow.push("everything");
		ledger.getTaskHistory("T1")[0].relations.dependsOn.push("T9");
		expect(ledger.getTask("T1")).toMatchObject({
			goal: { normalized: "original", verbatimSourceEventIds: ["ev-001"] },
			permissions: { allow: [] },
			provenance: { createdBy: { id: "user-1" } },
			relations: { dependsOn: [] },
		});

		const pending = ledger.recordPendingGoalChange({
			candidateTaskIds: ["T1"],
			reason: "confirm",
			sourceEventId: "ev-002",
			operations: [{ operation: "CANCEL_TASK", taskId: "T1", dependsOn: ["T9"] }],
		});
		pending.candidateTaskIds.push("T9");
		pending.operations[0].dependsOn!.push("T8");
		ledger.getPendingGoalChanges()[0].operations[0].taskId = "T9";
		expect(ledger.getPendingGoalChanges()[0]).toMatchObject({
			candidateTaskIds: ["T1"],
			operations: [{ operation: "CANCEL_TASK", taskId: "T1", dependsOn: ["T9"] }],
		});
	});

	it("rejects no-op acceptance/extension and duplicate or missing constraints while retaining goal sources", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "g" }, user, "ev-001");
		expect(() => ledger.apply({ operation: "EXTEND_TASK", taskId: "T1" }, user, "ev-002")).toThrow(/no change/i);
		expect(() =>
			ledger.apply(
				{ operation: "ADD_ACCEPTANCE_CRITERION", taskId: "T1", acceptanceCriterion: "  " },
				user,
				"ev-002",
			),
		).toThrow(/requires|empty/i);
		ledger.apply(
			{ operation: "ADD_ACCEPTANCE_CRITERION", taskId: "T1", acceptanceCriterion: "passes" },
			user,
			"ev-003",
		);
		expect(() =>
			ledger.apply(
				{ operation: "ADD_ACCEPTANCE_CRITERION", taskId: "T1", acceptanceCriterion: "passes" },
				user,
				"ev-004",
			),
		).toThrow(/duplicate/i);
		const constraint = { id: "c1", kind: "negative" as const, text: "no network", authority: user };
		ledger.apply({ operation: "ADD_CONSTRAINT", taskId: "T1", constraint }, user, "ev-005");
		constraint.text = "externally mutated";
		expect(ledger.getTask("T1")?.constraints[0].text).toBe("no network");
		expect(() => ledger.apply({ operation: "ADD_CONSTRAINT", taskId: "T1", constraint }, user, "ev-006")).toThrow(
			/duplicate/i,
		);
		expect(() => ledger.apply({ operation: "RELAX_CONSTRAINT", taskId: "T1" }, user, "ev-007")).toThrow(/requires/i);
		expect(() =>
			ledger.apply(
				{ operation: "RELAX_CONSTRAINT", taskId: "T1", constraint: { ...constraint, id: "missing" } },
				user,
				"ev-008",
			),
		).toThrow(/does not exist/i);
		ledger.apply({ operation: "EXTEND_TASK", taskId: "T1", goal: "g extended" }, user, "ev-009");
		expect(ledger.getTask("T1")?.goal.verbatimSourceEventIds).toEqual(["ev-001", "ev-009"]);
	});

	it("replays SUPERSEDE links and skips terminal tasks when restoring focus", () => {
		const { eventLog, ledger } = setup();
		ledger.createTask({ goal: "first" }, user, "ev-001");
		ledger.createTask({ goal: "second" }, user, "ev-002");
		ledger.apply({ operation: "SET_FOCUS", taskId: "T1" }, user, "ev-003");
		const replacement = ledger.apply(
			{ operation: "SUPERSEDE_TASK", taskId: "T1", replacementGoal: "replacement" },
			user,
			"ev-004",
		);
		ledger.apply({ operation: "CANCEL_TASK", taskId: replacement.taskId }, user, "ev-005");
		expect(ledger.getFocusTaskId()).toBe("T2");
		const rebuilt = replayTaskLedger(eventLog.all("s-1"));
		expect(rebuilt.getTask(replacement.taskId)?.relations.supersedes).toBe("T1");
		expect(rebuilt.getTask(replacement.taskId)?.version).toBe(2);
		expect(rebuilt.getTaskHistory(replacement.taskId)[0]).toMatchObject({
			version: 1,
			relations: { supersedes: "T1" },
		});
		expect(rebuilt.getFocusTaskId()).toBe("T2");
		expect(rebuilt.getLedgerVersion()).toBe(ledger.getLedgerVersion());
	});

	it("optionally validates verified-user sources and resolvable completion evidence", () => {
		const eventLog = new InMemoryEventLog();
		for (const [eventId, authority] of [
			["user-source", user],
			["agent-source", agent],
		] as const) {
			eventLog.append({ sessionId: "strict", agentId: "test", eventId, eventType: "message", authority });
		}
		const ledger = new TaskLedger({ eventLog, sessionId: "strict", strictEventSourceValidation: true });
		expect(() => ledger.createTask({ goal: "orphan" }, user, "missing")).toThrow(/resolvable/i);
		expect(() => ledger.createTask({ goal: "forged" }, user, "agent-source")).toThrow(/verified user/i);
		ledger.createTask({ goal: "grounded" }, user, "user-source");
		expect(() => ledger.completeTask("T1", agent, "agent-source", { evidenceEventIds: ["missing"] })).toThrow(
			/evidence.*resolvable/i,
		);
		eventLog.append({
			sessionId: "strict",
			agentId: "test",
			eventId: "evidence",
			eventType: "tool_result",
			authority: agent,
		});
		expect(ledger.completeTask("T1", agent, "agent-source", { evidenceEventIds: ["evidence"] }).status).toBe(
			"completed",
		);
	});

	it("replays full pending batches and requires an explicit ambiguous candidate", () => {
		const { eventLog, ledger } = setup();
		ledger.createTask({ goal: "a" }, user, "ev-001");
		ledger.createTask({ goal: "b" }, user, "ev-002");
		const pending = ledger.recordPendingGoalChange({
			candidateTaskIds: ["T1", "T2"],
			reason: "ambiguous focus",
			sourceEventId: "ev-003",
			operations: [{ operation: "SET_FOCUS", ambiguous: true, candidateTaskIds: ["T1", "T2"], dependsOn: ["T2"] }],
			ambiguous: true,
		});
		expect(replayTaskLedger(eventLog.all("s-1")).getPendingGoalChanges()[0]).toEqual(pending);
		expect(() => ledger.acceptPendingGoalChange(pending.pendingChangeId, user, "ev-004")).toThrow(/candidate/i);
		ledger.acceptPendingGoalChange(pending.pendingChangeId, user, "ev-004", { candidateTaskId: "T1" });
		expect(ledger.getFocusTaskId()).toBe("T1");
		expect(ledger.getPendingGoalChanges()).toEqual([]);
		const rebuilt = replayTaskLedger(eventLog.all("s-1"));
		expect(rebuilt.getFocusTaskId()).toBe("T1");
		expect(rebuilt.getPendingGoalChanges()).toEqual([]);
	});

	it("keeps failed accepted batches atomic and requires verified-user rejection", () => {
		const { ledger } = setup();
		ledger.createTask({ goal: "a" }, user, "ev-001");
		const pending = ledger.recordPendingGoalChange({
			candidateTaskIds: ["T1"],
			reason: "dangerous batch",
			sourceEventId: "ev-002",
			operations: [
				{ operation: "SUSPEND_TASK", taskId: "T1" },
				{ operation: "REOPEN_TASK", taskId: "T1" },
			],
		});
		const before = ledger.getLedgerVersion();
		expect(() => ledger.acceptPendingGoalChange(pending.pendingChangeId, user, "ev-003")).toThrow(/only completed/i);
		expect(ledger.getTask("T1")?.status).toBe("active");
		expect(ledger.getPendingGoalChanges()).toEqual([pending]);
		expect(ledger.getLedgerVersion()).toBe(before);
		expect(() => ledger.rejectPendingGoalChange(pending.pendingChangeId, agent, "ev-004")).toThrow(/verified user/i);
		ledger.rejectPendingGoalChange(pending.pendingChangeId, user, "ev-005");
		expect(ledger.getPendingGoalChanges()).toEqual([]);
	});

	it("persists an accepted proposal as one event and rolls back if that append fails", () => {
		class FailingBatchLog extends InMemoryEventLog {
			override append(input: AppendEventInput) {
				if (
					input.eventType === "task" &&
					input.payload &&
					typeof input.payload === "object" &&
					"kind" in input.payload &&
					input.payload.kind === "task_batch"
				) {
					throw new Error("durable batch append failed");
				}
				return super.append(input);
			}
		}
		const eventLog = new FailingBatchLog();
		const ledger = new TaskLedger({ eventLog, sessionId: "s-atomic" });
		ledger.createTask({ goal: "a" }, user, "ev-001");
		const pending = ledger.recordPendingGoalChange({
			candidateTaskIds: ["T1"],
			reason: "cancel",
			sourceEventId: "ev-002",
			operations: [{ operation: "CANCEL_TASK", taskId: "T1" }],
		});
		const beforeEvents = eventLog.all("s-atomic");
		const beforeVersion = ledger.getLedgerVersion();
		expect(() => ledger.acceptPendingGoalChange(pending.pendingChangeId, user, "ev-003")).toThrow(
			/durable batch append failed/,
		);
		expect(ledger.getTask("T1")?.status).toBe("active");
		expect(ledger.getPendingGoalChanges()).toEqual([pending]);
		expect(ledger.getLedgerVersion()).toBe(beforeVersion);
		expect(eventLog.all("s-atomic")).toEqual(beforeEvents);
	});
});
