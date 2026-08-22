/**
 * Task Ledger (design correction, 2026-08-22): a session is a container for
 * events and tasks, not a single-task boundary. Task goals live in a
 * versioned, event-sourced ledger with a focus pointer — never a session
 * string rewritten by summaries.
 *
 * Invariants enforced here (任务书增补):
 *   G1 first message creates only the first task, never a permanent session goal
 *   G2 every active task has a resolvable user source event
 *   G3 no in-place mutation; every update creates a new version
 *   G4 only verified user events change goal/acceptance/permissions/constraints
 *   G6 creating a task never implicitly completes/cancels/overwrites another
 *   G7 completion requires evidence or explicit user confirmation
 *   G10 ambiguous goal changes become pending proposals, never destructive updates
 */

import type { EventLog } from "./event-log.ts";
import type { Authority, Constraint } from "./types.ts";

export type TaskOperation =
	| "CREATE_TASK"
	| "REFINE_TASK"
	| "EXTEND_TASK"
	| "CREATE_SUBTASK"
	| "SET_FOCUS"
	| "SUSPEND_TASK"
	| "RESUME_TASK"
	| "CANCEL_TASK"
	| "SUPERSEDE_TASK"
	| "REOPEN_TASK"
	| "ADD_CONSTRAINT"
	| "RELAX_CONSTRAINT"
	| "ADD_ACCEPTANCE_CRITERION"
	| "UPDATE_PERMISSIONS"
	| "UPDATE_BUDGETS"
	| "COMPLETE_TASK";

export type LedgerTaskStatus = "active" | "suspended" | "background" | "completed" | "cancelled" | "superseded";

export interface TaskGoal {
	/** Normalized statement used for execution and display. */
	normalized: string;
	/** User's original words — the authoritative evidence. */
	verbatimSourceEventIds: string[];
	scope?: string[];
	exclusions?: string[];
}

export interface LedgerTask {
	taskId: string;
	version: number;
	status: LedgerTaskStatus;
	goal: TaskGoal;
	acceptanceCriteria: string[];
	constraints: Constraint[];
	permissions: { allow: string[]; deny: string[]; approvalRequired: string[] };
	budgets: { maxTokens?: number; maxToolCalls?: number; maxDurationMs?: number };
	outputContract?: string;
	relations: { parentTaskId?: string; dependsOn: string[]; supersedes?: string };
	provenance: { createdBy: Authority; createdFromEvent: string; updatedFromEvents: string[] };
	blockers: string[];
	createdAt: string;
	updatedAt: string;
}

export interface OperationInput {
	operation: TaskOperation;
	taskId?: string;
	parentTaskId?: string;
	goal?: string;
	replacementGoal?: string;
	acceptanceCriterion?: string;
	constraint?: Constraint;
	permissions?: LedgerTask["permissions"];
	budgets?: LedgerTask["budgets"];
	dependsOn?: string[];
	setFocus?: boolean;
	/** Interpreter metadata retained while an operation is pending. */
	ambiguous?: boolean;
	candidateTaskIds?: string[];
	reason?: string;
}

export interface PendingGoalChange {
	pendingChangeId: string;
	candidateTaskIds: string[];
	reason: string;
	sourceEventId: string;
	recordedAt: string;
	/** Exact proposed batch; confirmation never reconstructs it from a summary. */
	operations: OperationInput[];
	ambiguous: boolean;
}

interface TaskHistory {
	current: LedgerTask;
	versions: LedgerTask[];
}

const TERMINAL: LedgerTaskStatus[] = ["completed", "cancelled", "superseded"];

function requireUser(actor: Authority | undefined, what: string): asserts actor is Authority {
	if (!actor || actor.kind !== "user" || !actor.verified) {
		const got = actor ? `${actor.kind}:${actor.id}` : "missing";
		throw new Error(`${what} requires a verified user authority (got ${got})`);
	}
}

function cloneValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function cloneTask(task: LedgerTask): LedgerTask {
	return cloneValue(task);
}

function clonePending(change: PendingGoalChange): PendingGoalChange {
	return cloneValue(change);
}

export class TaskLedger {
	private tasks = new Map<string, TaskHistory>();
	private focusTaskId: string | undefined;
	private focusStack: string[] = [];
	private ledgerVersion = 0;
	private pendingGoalChanges: PendingGoalChange[] = [];
	private eventLog: EventLog | undefined;
	private sessionId: string;
	private strictEventSourceValidation: boolean;
	private taskCounter = 0;
	private pendingCounter = 0;

	constructor(options: { eventLog?: EventLog; sessionId: string; strictEventSourceValidation?: boolean }) {
		if (options.strictEventSourceValidation && !options.eventLog) {
			throw new Error("Strict event-source validation requires an EventLog");
		}
		this.eventLog = options.eventLog;
		this.sessionId = options.sessionId;
		this.strictEventSourceValidation = options.strictEventSourceValidation === true;
	}

	private validateSourceEvent(sourceEventId: string, actor?: Authority, requireVerifiedUser = false): void {
		if (!sourceEventId) throw new Error("A source event id is required");
		if (!this.strictEventSourceValidation) return;
		const event = this.eventLog?.all(this.sessionId).find((candidate) => candidate.eventId === sourceEventId);
		if (!event || event.sessionId !== this.sessionId) {
			throw new Error(`Source event ${sourceEventId} is not resolvable in session ${this.sessionId}`);
		}
		if (requireVerifiedUser) {
			if (event.authority.kind !== "user" || !event.authority.verified) {
				throw new Error(`Source event ${sourceEventId} is not from a verified user`);
			}
			if (actor && event.authority.id !== actor.id) {
				throw new Error(`Source event ${sourceEventId} belongs to a different user`);
			}
		}
	}

	private validateEvidenceEvents(eventIds: string[]): void {
		if (!this.strictEventSourceValidation) return;
		const sessionEvents = this.eventLog?.all(this.sessionId) ?? [];
		for (const eventId of eventIds) {
			const event = sessionEvents.find((candidate) => candidate.eventId === eventId);
			if (!event || event.sessionId !== this.sessionId) {
				throw new Error(`Completion evidence event ${eventId} is not resolvable in session ${this.sessionId}`);
			}
		}
	}

	private emitBuffer: { kind: string; payload: Record<string, unknown> }[] | undefined;

	private emit(kind: string, payload: Record<string, unknown>): void {
		// Inside an atomic batch, events are buffered and only flushed on success,
		// so a rolled-back batch leaves no replayable trace.
		if (this.emitBuffer) {
			this.emitBuffer.push({ kind, payload });
			return;
		}
		this.eventLog?.append({
			sessionId: this.sessionId,
			agentId: "task-ledger",
			eventType: "task",
			payload: { kind, ...payload },
			authority: { kind: "system", id: "task-ledger", verified: true },
		});
	}

	private commit(next: LedgerTask | undefined, op: TaskOperation, sourceEventId: string): void {
		this.ledgerVersion += 1;
		this.emit("task_op", {
			operation: op,
			taskId: next?.taskId,
			version: next?.version,
			ledgerVersion: this.ledgerVersion,
			sourceEventId,
			task: next ? cloneTask(next) : undefined,
			focusTaskId: this.focusTaskId,
			focusStack: [...this.focusStack],
		});
	}

	private mustGet(taskId: string): TaskHistory {
		const history = this.tasks.get(taskId);
		if (!history) throw new Error(`Unknown task ${taskId}`);
		return history;
	}

	private assertMutable(history: TaskHistory, op: TaskOperation): void {
		if (TERMINAL.includes(history.current.status)) {
			throw new Error(
				`Task ${history.current.taskId} is ${history.current.status} (terminal); ${op} requires REOPEN first`,
			);
		}
	}

	private nextVersion(history: TaskHistory, mutator: (task: LedgerTask) => void, sourceEventId: string): LedgerTask {
		const next = cloneTask(history.current);
		mutator(next);
		next.version = history.current.version + 1;
		next.updatedAt = new Date().toISOString();
		next.provenance.updatedFromEvents = [...next.provenance.updatedFromEvents, sourceEventId];
		history.versions.push(history.current);
		history.current = next;
		return next;
	}

	createTask(
		input: { goal: string; dependsOn?: string[]; parentTaskId?: string; supersedes?: string; setFocus?: boolean },
		actor: Authority,
		sourceEventId: string,
	): LedgerTask {
		if (!input.goal || input.goal.trim().length === 0) throw new Error("Task creation requires a goal");
		requireUser(actor, "Task creation");
		this.validateSourceEvent(sourceEventId, actor, true);
		const dependsOn = [...new Set(input.dependsOn ?? [])];
		for (const dependencyId of dependsOn) this.mustGet(dependencyId);
		this.taskCounter += 1;
		const taskId = `T${this.taskCounter}`;
		const now = new Date().toISOString();
		const task: LedgerTask = {
			taskId,
			version: 1,
			status: "active",
			goal: { normalized: input.goal, verbatimSourceEventIds: [sourceEventId] },
			acceptanceCriteria: [],
			constraints: [],
			permissions: { allow: [], deny: [], approvalRequired: [] },
			budgets: {},
			relations: {
				parentTaskId: input.parentTaskId,
				dependsOn,
				supersedes: input.supersedes,
			},
			provenance: {
				createdBy: cloneValue(actor),
				createdFromEvent: sourceEventId,
				updatedFromEvents: [sourceEventId],
			},
			blockers: [],
			createdAt: now,
			updatedAt: now,
		};
		this.tasks.set(taskId, { current: task, versions: [] });
		// New tasks take focus by default; setFocus=false leaves the current task
		// active without stealing focus. T1 always becomes focus.
		if (input.setFocus !== false || !this.focusTaskId) {
			if (this.focusTaskId) {
				const currentFocus = this.tasks.get(this.focusTaskId)?.current;
				if (currentFocus && !TERMINAL.includes(currentFocus.status)) this.focusStack.push(this.focusTaskId);
			}
			this.focusTaskId = taskId;
		}
		this.commit(task, input.parentTaskId ? "CREATE_SUBTASK" : "CREATE_TASK", sourceEventId);
		return cloneTask(task);
	}

	apply(op: OperationInput, actor: Authority, sourceEventId: string): LedgerTask {
		this.validateSourceEvent(sourceEventId, actor, actor.kind === "user" && actor.verified);
		switch (op.operation) {
			case "CREATE_TASK":
				return this.createTask(
					{ goal: requiredGoal(op), dependsOn: op.dependsOn, setFocus: op.setFocus },
					actor,
					sourceEventId,
				);
			case "CREATE_SUBTASK": {
				if (!op.parentTaskId) throw new Error("CREATE_SUBTASK requires parentTaskId");
				this.mustGet(op.parentTaskId);
				return this.createTask(
					{
						goal: requiredGoal(op),
						parentTaskId: op.parentTaskId,
						dependsOn: op.dependsOn,
						setFocus: op.setFocus,
					},
					actor,
					sourceEventId,
				);
			}
			case "REFINE_TASK": {
				requireUser(actor, "Goal refinement");
				this.validateSourceEvent(sourceEventId, actor, true);
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				const goal = requiredGoal(op);
				if (goal === history.current.goal.normalized) throw new Error("REFINE_TASK would make no change");
				const next = this.nextVersion(
					history,
					(t) => {
						t.goal = {
							...t.goal,
							normalized: goal,
							verbatimSourceEventIds: [...t.goal.verbatimSourceEventIds, sourceEventId],
						};
					},
					sourceEventId,
				);
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			case "EXTEND_TASK":
			case "ADD_ACCEPTANCE_CRITERION": {
				requireUser(actor, "Acceptance-criteria change");
				this.validateSourceEvent(sourceEventId, actor, true);
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				const criterion = op.acceptanceCriterion?.trim();
				const goal = op.goal?.trim();
				if (op.operation === "ADD_ACCEPTANCE_CRITERION" && !criterion) {
					throw new Error("ADD_ACCEPTANCE_CRITERION requires a non-empty acceptanceCriterion");
				}
				if (criterion && history.current.acceptanceCriteria.includes(criterion)) {
					throw new Error(`Duplicate acceptance criterion: ${criterion}`);
				}
				const changesGoal = !!goal && goal !== history.current.goal.normalized;
				if (!criterion && !changesGoal) throw new Error(`${op.operation} would make no change`);
				const next = this.nextVersion(
					history,
					(t) => {
						if (criterion) t.acceptanceCriteria = [...t.acceptanceCriteria, criterion];
						if (changesGoal) {
							t.goal = {
								...t.goal,
								normalized: goal!,
								verbatimSourceEventIds: [...t.goal.verbatimSourceEventIds, sourceEventId],
							};
						}
					},
					sourceEventId,
				);
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			case "UPDATE_PERMISSIONS": {
				requireUser(actor, "Permission change");
				this.validateSourceEvent(sourceEventId, actor, true);
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				if (!op.permissions) throw new Error("UPDATE_PERMISSIONS requires permissions");
				for (const values of [op.permissions.allow, op.permissions.deny, op.permissions.approvalRequired]) {
					if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
						throw new Error("UPDATE_PERMISSIONS requires string arrays");
					}
				}
				if (JSON.stringify(op.permissions) === JSON.stringify(history.current.permissions)) {
					throw new Error("UPDATE_PERMISSIONS would make no change");
				}
				const permissions = cloneValue(op.permissions);
				const next = this.nextVersion(
					history,
					(task) => {
						task.permissions = permissions;
					},
					sourceEventId,
				);
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			case "UPDATE_BUDGETS": {
				requireUser(actor, "Budget change");
				this.validateSourceEvent(sourceEventId, actor, true);
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				if (!op.budgets) throw new Error("UPDATE_BUDGETS requires budgets");
				for (const value of Object.values(op.budgets)) {
					if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
						throw new Error("UPDATE_BUDGETS requires finite non-negative numbers");
					}
				}
				if (JSON.stringify(op.budgets) === JSON.stringify(history.current.budgets)) {
					throw new Error("UPDATE_BUDGETS would make no change");
				}
				const budgets = cloneValue(op.budgets);
				const next = this.nextVersion(
					history,
					(task) => {
						task.budgets = budgets;
					},
					sourceEventId,
				);
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			case "COMPLETE_TASK":
				return this.completeTask(requiredTaskId(op), actor, sourceEventId, { userConfirmed: true });
			case "ADD_CONSTRAINT": {
				requireUser(actor, "Constraint change");
				this.validateSourceEvent(sourceEventId, actor, true);
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				if (!op.constraint?.id) throw new Error("ADD_CONSTRAINT requires a constraint with an id");
				if (
					op.constraint.authority.kind !== "user" ||
					!op.constraint.authority.verified ||
					op.constraint.authority.id !== actor.id
				) {
					throw new Error("ADD_CONSTRAINT requires matching verified user constraint authority");
				}
				if (history.current.constraints.some((constraint) => constraint.id === op.constraint!.id)) {
					throw new Error(`Duplicate constraint ${op.constraint.id}`);
				}
				const constraint = cloneValue(op.constraint);
				const next = this.nextVersion(
					history,
					(t) => {
						t.constraints = [...t.constraints, constraint];
					},
					sourceEventId,
				);
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			case "RELAX_CONSTRAINT": {
				requireUser(actor, "Constraint relaxation");
				this.validateSourceEvent(sourceEventId, actor, true);
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				const constraintId = op.constraint?.id;
				if (!constraintId) throw new Error("RELAX_CONSTRAINT requires a constraint with an id");
				if (!history.current.constraints.some((constraint) => constraint.id === constraintId)) {
					throw new Error(`Constraint ${constraintId} does not exist`);
				}
				const next = this.nextVersion(
					history,
					(t) => {
						t.constraints = t.constraints.filter((constraint) => constraint.id !== constraintId);
					},
					sourceEventId,
				);
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			case "SET_FOCUS": {
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				if (this.focusTaskId && this.focusTaskId !== history.current.taskId) {
					this.focusStack = this.focusStack.filter((id) => id !== history.current.taskId);
					this.focusStack.push(this.focusTaskId);
				}
				this.focusTaskId = history.current.taskId;
				this.commit(undefined, op.operation, sourceEventId);
				return cloneTask(history.current);
			}
			case "SUSPEND_TASK": {
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				const next = this.nextVersion(
					history,
					(t) => {
						t.status = "suspended";
					},
					sourceEventId,
				);
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			case "RESUME_TASK": {
				const history = this.mustGet(requiredTaskId(op));
				if (history.current.status !== "suspended" && history.current.status !== "background") {
					throw new Error(
						`Task ${history.current.taskId} is ${history.current.status}; only suspended/background tasks resume`,
					);
				}
				const next = this.nextVersion(
					history,
					(t) => {
						t.status = "active";
					},
					sourceEventId,
				);
				if (this.focusTaskId && this.focusTaskId !== history.current.taskId) this.focusStack.push(this.focusTaskId);
				this.focusStack = this.focusStack.filter((id) => id !== history.current.taskId);
				this.focusTaskId = history.current.taskId;
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			case "CANCEL_TASK": {
				requireUser(actor, "Task cancellation");
				this.validateSourceEvent(sourceEventId, actor, true);
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				const next = this.nextVersion(
					history,
					(t) => {
						t.status = "cancelled";
					},
					sourceEventId,
				);
				this.refocusAfterTerminal(history.current.taskId);
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			case "SUPERSEDE_TASK": {
				requireUser(actor, "Task supersede");
				this.validateSourceEvent(sourceEventId, actor, true);
				const history = this.mustGet(requiredTaskId(op));
				this.assertMutable(history, op.operation);
				const supersededTaskId = history.current.taskId;
				const oldGoal = history.current.goal.normalized;
				const next = this.nextVersion(
					history,
					(t) => {
						t.status = "superseded";
					},
					sourceEventId,
				);
				this.refocusAfterTerminal(supersededTaskId);
				this.commit(next, op.operation, sourceEventId);
				return this.createTask(
					{
						goal: op.replacementGoal ?? op.goal ?? `${oldGoal} (replacement)`,
						supersedes: supersededTaskId,
					},
					actor,
					sourceEventId,
				);
			}
			case "REOPEN_TASK": {
				requireUser(actor, "Task reopen");
				this.validateSourceEvent(sourceEventId, actor, true);
				const history = this.mustGet(requiredTaskId(op));
				if (history.current.status !== "completed" && history.current.status !== "cancelled") {
					throw new Error(
						`Task ${history.current.taskId} is ${history.current.status}; only completed/cancelled tasks reopen`,
					);
				}
				const next = this.nextVersion(
					history,
					(t) => {
						t.status = "active";
					},
					sourceEventId,
				);
				if (this.focusTaskId && this.focusTaskId !== history.current.taskId) this.focusStack.push(this.focusTaskId);
				this.focusStack = this.focusStack.filter((id) => id !== history.current.taskId);
				this.focusTaskId = history.current.taskId;
				this.commit(next, op.operation, sourceEventId);
				return cloneTask(next);
			}
			default:
				throw new Error(`Unsupported operation ${(op as OperationInput).operation}`);
		}
	}

	private refocusAfterTerminal(taskId: string): void {
		this.focusStack = this.focusStack.filter((id) => id !== taskId);
		if (this.focusTaskId !== taskId) return;
		this.focusTaskId = undefined;
		while (this.focusStack.length > 0) {
			const candidate = this.focusStack.pop()!;
			const task = this.tasks.get(candidate)?.current;
			if (task && !TERMINAL.includes(task.status)) {
				this.focusTaskId = candidate;
				break;
			}
		}
	}

	/** G7: completion requires evidence or explicit user confirmation. */
	completeTask(
		taskId: string,
		actor: Authority,
		sourceEventId: string,
		options?: { evidenceEventIds?: string[]; userConfirmed?: boolean },
	): LedgerTask {
		const history = this.mustGet(taskId);
		this.assertMutable(history, "SET_FOCUS"); // any transition guard text
		const evidenceEventIds = [...(options?.evidenceEventIds ?? [])];
		const hasEvidence = evidenceEventIds.length > 0;
		if (!options?.userConfirmed && !hasEvidence) {
			throw new Error(
				`Task ${taskId} cannot complete without acceptance evidence or explicit user confirmation (G7)`,
			);
		}
		if (options?.userConfirmed) {
			requireUser(actor, "User-confirmed completion");
			this.validateSourceEvent(sourceEventId, actor, true);
		} else {
			this.validateSourceEvent(sourceEventId);
		}
		this.validateEvidenceEvents(evidenceEventIds);
		const next = this.nextVersion(
			history,
			(t) => {
				t.status = "completed";
			},
			sourceEventId,
		);
		this.refocusAfterTerminal(taskId);
		this.commit(next, "COMPLETE_TASK", sourceEventId);
		this.emit("task_completed", {
			taskId,
			version: next.version,
			evidenceEventIds,
			userConfirmed: options?.userConfirmed === true,
		});
		return cloneTask(next);
	}

	recordPendingGoalChange(change: {
		candidateTaskIds: string[];
		reason: string;
		sourceEventId: string;
		operations?: OperationInput[];
		ambiguous?: boolean;
		actor?: Authority;
	}): PendingGoalChange {
		if (change.actor) requireUser(change.actor, "Pending goal-change proposal");
		this.validateSourceEvent(change.sourceEventId, change.actor, true);
		this.pendingCounter += 1;
		const pending: PendingGoalChange = {
			pendingChangeId: `P${this.pendingCounter}`,
			candidateTaskIds: [...change.candidateTaskIds],
			reason: change.reason,
			sourceEventId: change.sourceEventId,
			recordedAt: new Date().toISOString(),
			operations: cloneValue(change.operations ?? []),
			ambiguous: change.ambiguous ?? change.candidateTaskIds.length > 1,
		};
		this.pendingGoalChanges.push(pending);
		this.ledgerVersion += 1;
		this.emit("pending_goal_change", { ...clonePending(pending), ledgerVersion: this.ledgerVersion });
		return clonePending(pending);
	}

	private removePendingGoalChange(
		index: number,
		action: "accepted" | "rejected",
		resolutionSourceEventId: string,
		selectedCandidateTaskId?: string,
	): PendingGoalChange {
		const removed = this.pendingGoalChanges[index];
		if (!removed) throw new Error(`No pending goal change at index ${index}`);
		this.pendingGoalChanges.splice(index, 1);
		this.ledgerVersion += 1;
		this.emit("pending_goal_change_resolved", {
			pendingChangeId: removed.pendingChangeId,
			sourceEventId: removed.sourceEventId,
			resolutionSourceEventId,
			action,
			selectedCandidateTaskId,
			ledgerVersion: this.ledgerVersion,
		});
		return clonePending(removed);
	}

	acceptPendingGoalChange(
		pendingChangeId: string,
		actor: Authority,
		sourceEventId: string,
		options?: { candidateTaskId?: string },
	): LedgerTask[] {
		requireUser(actor, "Pending goal-change acceptance");
		this.validateSourceEvent(sourceEventId, actor, true);
		const index = this.pendingGoalChanges.findIndex((pending) => pending.pendingChangeId === pendingChangeId);
		if (index === -1) throw new Error(`Unknown pending goal change ${pendingChangeId}`);
		const pending = this.pendingGoalChanges[index];
		const candidateTaskId = options?.candidateTaskId;
		if (pending.ambiguous && !candidateTaskId) {
			throw new Error(`Pending goal change ${pendingChangeId} is ambiguous; candidateTaskId is required`);
		}
		if (candidateTaskId && !pending.candidateTaskIds.includes(candidateTaskId)) {
			throw new Error(`Task ${candidateTaskId} is not a candidate for ${pendingChangeId}`);
		}
		if (pending.operations.length === 0) {
			throw new Error(`Pending goal change ${pendingChangeId} has no proposed operations`);
		}
		const operations = pending.operations.map((operation) => {
			const resolved = cloneValue(operation);
			if (candidateTaskId && resolved.operation === "CREATE_SUBTASK" && !resolved.parentTaskId) {
				resolved.parentTaskId = candidateTaskId;
				resolved.ambiguous = false;
			} else if (
				candidateTaskId &&
				(resolved.ambiguous || (!resolved.taskId && operationRequiresTaskId(resolved.operation)))
			) {
				resolved.taskId = candidateTaskId;
				resolved.ambiguous = false;
			}
			return resolved;
		});
		return this.runAtomic(() => {
			const committed = operations.map((operation) => this.apply(operation, actor, sourceEventId));
			this.removePendingGoalChange(index, "accepted", sourceEventId, candidateTaskId);
			return committed.map(cloneTask);
		});
	}

	rejectPendingGoalChange(pendingChangeId: string, actor: Authority, sourceEventId: string): PendingGoalChange {
		requireUser(actor, "Pending goal-change rejection");
		this.validateSourceEvent(sourceEventId, actor, true);
		const index = this.pendingGoalChanges.findIndex((pending) => pending.pendingChangeId === pendingChangeId);
		if (index === -1) throw new Error(`Unknown pending goal change ${pendingChangeId}`);
		return this.runAtomic(() => this.removePendingGoalChange(index, "rejected", sourceEventId));
	}

	/** @deprecated Prefer rejectPendingGoalChange with a stable pendingChangeId. */
	resolvePendingGoalChange(index: number, actor: Authority, sourceEventId: string): PendingGoalChange {
		const pending = this.pendingGoalChanges[index];
		if (!pending) throw new Error(`No pending goal change at index ${index}`);
		return this.rejectPendingGoalChange(pending.pendingChangeId, actor, sourceEventId);
	}

	private runAtomic<T>(operation: () => T): T {
		if (this.emitBuffer) throw new Error("Nested atomic ledger transactions are not supported");
		const snapshot = {
			tasks: new Map(
				[...this.tasks].map(([id, history]) => [
					id,
					{ current: cloneTask(history.current), versions: history.versions.map(cloneTask) },
				]),
			),
			focusTaskId: this.focusTaskId,
			focusStack: [...this.focusStack],
			ledgerVersion: this.ledgerVersion,
			pendingGoalChanges: this.pendingGoalChanges.map(clonePending),
			taskCounter: this.taskCounter,
			pendingCounter: this.pendingCounter,
		};
		this.emitBuffer = [];
		try {
			const result = operation();
			const buffered = this.emitBuffer ?? [];
			this.emitBuffer = undefined;
			// Persist the entire accepted proposal as one append-only record. A
			// storage failure therefore cannot leave a replayable operation prefix.
			if (buffered.length > 0) {
				this.emit("task_batch", { events: cloneValue(buffered), ledgerVersion: this.ledgerVersion });
			}
			return result;
		} catch (error) {
			this.emitBuffer = undefined;
			this.tasks = snapshot.tasks;
			this.focusTaskId = snapshot.focusTaskId;
			this.focusStack = snapshot.focusStack;
			this.ledgerVersion = snapshot.ledgerVersion;
			this.pendingGoalChanges = snapshot.pendingGoalChanges;
			this.taskCounter = snapshot.taskCounter;
			this.pendingCounter = snapshot.pendingCounter;
			throw error;
		}
	}

	/** Apply a batch of operations atomically: either every operation commits or none do. */
	applyAtomic(ops: OperationInput[], actor: Authority, sourceEventId: string): LedgerTask[] {
		if (ops.length === 0) return [];
		return this.runAtomic(() => ops.map((op) => this.apply(op, actor, sourceEventId)).map(cloneTask));
	}

	/** Replay application (used by replayTaskLedger). Trusts recorded state verbatim. */
	applyReplay(task: LedgerTask, focusTaskId: string | undefined, focusStack: string[], ledgerVersion: number): void {
		const replayedTask = cloneTask(task);
		const history = this.tasks.get(replayedTask.taskId) ?? { current: replayedTask, versions: [] };
		if (history.current.version < replayedTask.version) {
			history.versions.push(history.current);
			history.current = replayedTask;
		}
		this.tasks.set(replayedTask.taskId, history);
		const numeric = Number.parseInt(replayedTask.taskId.slice(1), 10);
		if (!Number.isNaN(numeric)) this.taskCounter = Math.max(this.taskCounter, numeric);
		this.focusTaskId = focusTaskId;
		this.focusStack = [...(focusStack ?? [])];
		this.ledgerVersion = Math.max(this.ledgerVersion, ledgerVersion);
	}

	/** @internal */
	applyPendingReplay(payload: Record<string, unknown>): void {
		const pendingChangeId = String(payload.pendingChangeId ?? `P${this.pendingCounter + 1}`);
		const numeric = Number.parseInt(pendingChangeId.slice(1), 10);
		if (!Number.isNaN(numeric)) this.pendingCounter = Math.max(this.pendingCounter, numeric);
		this.pendingGoalChanges.push({
			pendingChangeId,
			candidateTaskIds: cloneValue((payload.candidateTaskIds as string[]) ?? []),
			reason: String(payload.reason ?? ""),
			sourceEventId: String(payload.sourceEventId ?? ""),
			recordedAt: String(payload.recordedAt ?? ""),
			operations: cloneValue((payload.operations as OperationInput[]) ?? []),
			ambiguous:
				typeof payload.ambiguous === "boolean"
					? payload.ambiguous
					: ((payload.candidateTaskIds as string[] | undefined)?.length ?? 0) > 1,
		});
		this.ledgerVersion = Math.max(this.ledgerVersion, Number(payload.ledgerVersion ?? 0));
	}

	/** @internal Replay of a focus-only task_op (e.g. SET_FOCUS carries no task). */
	applyFocusReplay(focusTaskId: string | undefined, focusStack: string[], ledgerVersion: number): void {
		this.focusTaskId = focusTaskId;
		this.focusStack = [...(focusStack ?? [])];
		this.ledgerVersion = Math.max(this.ledgerVersion, ledgerVersion);
	}

	/** @internal Replay of pending_goal_change_resolved: drop the matching pending entry. */
	applyPendingResolutionReplay(payload: Record<string, unknown>): void {
		const pendingChangeId = String(payload.pendingChangeId ?? "");
		const sourceEventId = String(payload.sourceEventId ?? "");
		const index = this.pendingGoalChanges.findIndex((pending) =>
			pendingChangeId ? pending.pendingChangeId === pendingChangeId : pending.sourceEventId === sourceEventId,
		);
		if (index !== -1) this.pendingGoalChanges.splice(index, 1);
		this.ledgerVersion = Math.max(this.ledgerVersion, Number(payload.ledgerVersion ?? 0));
	}

	/** Current version of a task. */
	getTask(taskId: string): LedgerTask | undefined {
		const task = this.tasks.get(taskId)?.current;
		return task ? cloneTask(task) : undefined;
	}

	/** Full version history (oldest first), including the current version. */
	getTaskHistory(taskId: string): LedgerTask[] {
		const history = this.tasks.get(taskId);
		return history ? [...history.versions, history.current].map(cloneTask) : [];
	}

	getFocusTaskId(): string | undefined {
		return this.focusTaskId;
	}

	getFocusTask(): LedgerTask | undefined {
		const task = this.focusTaskId ? this.tasks.get(this.focusTaskId)?.current : undefined;
		return task ? cloneTask(task) : undefined;
	}

	getLedgerVersion(): number {
		return this.ledgerVersion;
	}

	getPendingGoalChanges(): PendingGoalChange[] {
		return this.pendingGoalChanges.map(clonePending);
	}

	/** Current version of every task, ordered by numeric task id. */
	listTasks(): LedgerTask[] {
		return [...this.tasks.values()]
			.map((history) => cloneTask(history.current))
			.sort((a, b) => Number.parseInt(a.taskId.slice(1), 10) - Number.parseInt(b.taskId.slice(1), 10));
	}

	/** Lossless index of non-terminal tasks for the pinned layer (never the full details). */
	nonTerminalIndex(): {
		taskId: string;
		status: LedgerTaskStatus;
		goal: string;
		blockers: string[];
		version: number;
	}[] {
		return [...this.tasks.values()]
			.filter((h) => !TERMINAL.includes(h.current.status))
			.map((h) => ({
				taskId: h.current.taskId,
				status: h.current.status,
				goal: h.current.goal.normalized,
				blockers: [...h.current.blockers],
				version: h.current.version,
			}));
	}
}

function operationRequiresTaskId(operation: TaskOperation): boolean {
	return operation !== "CREATE_TASK" && operation !== "CREATE_SUBTASK";
}

function requiredTaskId(op: OperationInput): string {
	if (!op.taskId) throw new Error(`${op.operation} requires taskId`);
	return op.taskId;
}

function requiredGoal(op: OperationInput): string {
	if (!op.goal || op.goal.trim().length === 0) throw new Error(`${op.operation} requires a goal`);
	return op.goal;
}

function replayTaskPayload(ledger: TaskLedger, payload: Record<string, unknown>): void {
	if (payload.kind === "task_batch") {
		const events = Array.isArray(payload.events) ? payload.events : [];
		for (const event of events) {
			if (!event || typeof event !== "object" || !("kind" in event) || !("payload" in event)) continue;
			const item = event as { kind: string; payload: Record<string, unknown> };
			replayTaskPayload(ledger, { kind: item.kind, ...item.payload });
		}
		return;
	}
	if (payload.kind === "task_op") {
		if (payload.task) {
			ledger.applyReplay(
				payload.task as LedgerTask,
				payload.focusTaskId as string | undefined,
				payload.focusStack as string[],
				payload.ledgerVersion as number,
			);
		} else {
			ledger.applyFocusReplay(
				payload.focusTaskId as string | undefined,
				(payload.focusStack as string[]) ?? [],
				Number(payload.ledgerVersion ?? 0),
			);
		}
	} else if (payload.kind === "pending_goal_change") {
		ledger.applyPendingReplay(payload);
	} else if (payload.kind === "pending_goal_change_resolved") {
		ledger.applyPendingResolutionReplay(payload);
	}
}

/** Rebuild a ledger from task events (event-sourced recovery). */
export function replayTaskLedger(
	events: { eventType: string; payload?: unknown }[],
	options: { eventLog?: EventLog; sessionId?: string; strictEventSourceValidation?: boolean } = {},
): TaskLedger {
	const ledger = new TaskLedger({
		eventLog: options.eventLog,
		sessionId: options.sessionId ?? "replay",
		strictEventSourceValidation: options.strictEventSourceValidation,
	});
	for (const event of events) {
		if (event.eventType !== "task") continue;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (payload) replayTaskPayload(ledger, payload);
	}
	return ledger;
}
