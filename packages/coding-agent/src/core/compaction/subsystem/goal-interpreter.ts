/**
 * Goal Interpreter (design correction, 2026-08-22): new user messages become
 * GoalDeltaProposals via the model — but only deterministic code commits
 * state. Only permission-loosening interpretations require a second explicit
 * confirmation. Ambiguous references stay pending with all candidates preserved.
 */

import {
	COMPACTOR_POLICY_VERSION,
	COMPACTOR_SYSTEM_POLICY,
	detectInjections,
	wrapUntrusted,
} from "./injection-guard.ts";
import type {
	LedgerTask,
	OperationInput,
	PendingGoalChange,
	TaskContractPatch,
	TaskLedger,
	TaskOperation,
} from "./task-ledger.ts";
import type { Authority, CompactionLLMResponse, CompleteFn, Constraint } from "./types.ts";

export type GoalDeltaOperation = OperationInput;

export interface GoalChangeInput {
	userMessage: string;
	sourceEventId: string;
	ledger: TaskLedger;
	complete: CompleteFn;
	/** Authenticated principal for this message; never inferred by the interpreter. */
	actor: Authority;
}

export type GoalChangeOutcome =
	| { outcome: "committed"; tasks: LedgerTask[] }
	| { outcome: "pending"; reason: string }
	| { outcome: "rejected"; reason: string }
	| { outcome: "noop" };

const KNOWN_OPS = new Set<TaskOperation>([
	"CREATE_TASK",
	"REFINE_TASK",
	"EXTEND_TASK",
	"CREATE_SUBTASK",
	"SET_FOCUS",
	"SUSPEND_TASK",
	"RESUME_TASK",
	"CANCEL_TASK",
	"SUPERSEDE_TASK",
	"REOPEN_TASK",
	"ADD_CONSTRAINT",
	"RELAX_CONSTRAINT",
	"ADD_ACCEPTANCE_CRITERION",
	"PATCH_TASK_CONTRACT",
	"UPDATE_PERMISSIONS",
	"UPDATE_BUDGETS",
	"COMPLETE_TASK",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function interpreterTaskState(ledger: TaskLedger): string {
	const focus = ledger.getFocusTask();
	const focusContract = focus
		? {
				focusTaskId: focus.taskId,
				taskRef: `task://${focus.taskId}/v${focus.version}`,
				version: focus.version,
				status: focus.status,
				goal: {
					normalized: focus.goal.normalized,
					sourceEventIds: focus.goal.verbatimSourceEventIds,
					scope: focus.goal.scope ?? [],
					exclusions: focus.goal.exclusions ?? [],
				},
				acceptanceCriteria: focus.acceptanceCriteria,
				constraints: focus.constraints.map((constraint) => ({
					id: constraint.id,
					kind: constraint.kind,
					text: constraint.text,
				})),
				permissions: focus.permissions,
				budgets: focus.budgets,
				outputContract: focus.outputContract ?? null,
				blockers: focus.blockers,
				relations: focus.relations,
				provenance: {
					createdFromEvent: focus.provenance.createdFromEvent,
					updatedFromEvents: focus.provenance.updatedFromEvents,
				},
			}
		: null;
	const otherOpenTasks = ledger
		.nonTerminalIndex()
		.filter((task) => task.taskId !== focus?.taskId)
		.map((task) => ({
			taskId: task.taskId,
			version: task.version,
			status: task.status,
			goal: task.goal,
			blockers: task.blockers,
		}));
	return JSON.stringify({ focus: focusContract, otherOpenTasks });
}

function loosensPermissions(operation: GoalDeltaOperation, ledger: TaskLedger): boolean {
	const current = operation.taskId ? ledger.getTask(operation.taskId)?.permissions : undefined;
	if (!current) return operation.operation === "UPDATE_PERMISSIONS" || operation.taskPatch?.permissions !== undefined;
	const replacement =
		operation.operation === "UPDATE_PERMISSIONS"
			? operation.permissions
			: operation.operation === "PATCH_TASK_CONTRACT" && operation.taskPatch?.permissions
				? { ...current, ...operation.taskPatch.permissions }
				: undefined;
	if (!replacement) return false;
	return (
		replacement.allow.some((permission) => !current.allow.includes(permission)) ||
		current.deny.some((permission) => !replacement.deny.includes(permission)) ||
		current.approvalRequired.some((permission) => !replacement.approvalRequired.includes(permission))
	);
}

const NEGATED_APPROVAL_PATTERN =
	/\b(?:do not|don't|reject|decline|deny)\b.{0,48}\b(?:approve|authorize|accept|confirm)\b|(?:approve|authorize)\s+(?:nothing|none)|(?:不要|不|拒绝|不同意|未)(?:批准|授权|同意|确认)/i;
const APPROVAL_PREFIX_PATTERN =
	/^(?:[a-z][\w.-]*:\s*)?(?:(?:i|we)\s+)?(?:(?:hereby|explicitly|formally)\s+)*(?:approve|authorize|accept|confirm)\b|^(?:[\w.-]+：\s*)?(?:我(?:们)?(?:在此|正式)?|正式)?(?:批准|授权|同意|确认)/i;
const STRONG_APPROVAL_PATTERN =
	/^(?:[a-z][\w.-]*:\s*)?(?:(?:i|we)\s+)?(?:(?:hereby|explicitly|formally)\s+)*(?:approve|authorize)(?:\s+and\s+(?:approve|authorize))*(?:\s+(?:it|P\d+|this(?:\s+(?:permission|budget)\s+update)?|that|all|the\s+(?:pending(?:\s+(?:change|(?:permission|budget)\s+update))?|(?:permission|budget)(?:\s+update)?|execution\s+of\s+open\s+items)))?[.!]*$|^(?:[\w.-]+：\s*)?(?:我(?:们)?(?:在此|正式)?|正式)?(?:批准|授权)(?:并|和|及|、)?(?:批准|授权)?(?:它|此项|这个(?:权限|预算)更新|上述(?:权限|预算)更新|全部|所有开放项)?[。！!]*$/i;
const WEAK_CONTRACT_APPROVAL_PATTERN =
	/^(?:[a-z][\w.-]*:\s*)?(?:(?:i|we)\s+)?(?:accept|confirm)\b.*(?:permission|budget|pending|P\d+)|^(?:[\w.-]+：\s*)?(?:我(?:们)?|正式)?(?:同意|确认).*(?:权限|预算|授权|P\d+)/i;

export type PendingContractApprovalSelection =
	| { kind: "accept"; pendingChangeId: string }
	| { kind: "ambiguous"; reason: string }
	| { kind: "noop" };

export function selectPendingContractApproval(
	userMessage: string,
	pendingChanges: PendingGoalChange[],
): PendingContractApprovalSelection | undefined {
	const message = userMessage.trim();
	if (NEGATED_APPROVAL_PATTERN.test(message)) return { kind: "noop" };
	if (!STRONG_APPROVAL_PATTERN.test(message) && !WEAK_CONTRACT_APPROVAL_PATTERN.test(message)) {
		return APPROVAL_PREFIX_PATTERN.test(message) ? { kind: "noop" } : undefined;
	}

	const contractPending = pendingChanges.filter(
		(change) =>
			change.operations.length > 0 &&
			change.operations.every(
				(operation) =>
					["UPDATE_PERMISSIONS", "UPDATE_BUDGETS"].includes(operation.operation) ||
					(operation.operation === "PATCH_TASK_CONTRACT" && operation.taskPatch?.permissions !== undefined),
			),
	);
	if (contractPending.length === 0) return { kind: "noop" };

	const explicitIds = [...new Set([...message.matchAll(/\bP\d+\b/gi)].map((match) => match[0].toUpperCase()))];
	if (explicitIds.length > 1) {
		return { kind: "ambiguous", reason: "contract approval names multiple pending changes; select one P-id" };
	}
	const mentionsPermission = /\bpermission\b|权限/.test(message);
	const mentionsBudget = /\bbudget\b|预算/.test(message);
	const typeCandidates =
		mentionsPermission !== mentionsBudget
			? contractPending.filter((change) =>
					change.operations.some((operation) =>
						mentionsPermission
							? operation.operation === "UPDATE_PERMISSIONS" || operation.taskPatch?.permissions !== undefined
							: operation.operation === "UPDATE_BUDGETS",
					),
				)
			: contractPending;
	const selected = explicitIds[0]
		? contractPending.find((change) => change.pendingChangeId === explicitIds[0])
		: typeCandidates.length === 1 && (pendingChanges.length === 1 || mentionsPermission !== mentionsBudget)
			? typeCandidates[0]
			: undefined;
	return selected
		? { kind: "accept", pendingChangeId: selected.pendingChangeId }
		: { kind: "ambiguous", reason: "contract approval is ambiguous; use /contract accept <P-id>" };
}

function tryAcceptPendingContractUpdate(input: GoalChangeInput): GoalChangeOutcome | undefined {
	const selection = selectPendingContractApproval(input.userMessage, input.ledger.getPendingGoalChanges());
	if (!selection || selection.kind === "noop") return selection ? { outcome: "noop" } : undefined;
	if (selection.kind === "ambiguous") return { outcome: "pending", reason: selection.reason };

	try {
		return {
			outcome: "committed",
			tasks: input.ledger.acceptPendingGoalChange(selection.pendingChangeId, input.actor, input.sourceEventId),
		};
	} catch (error) {
		return { outcome: "rejected", reason: error instanceof Error ? error.message : String(error) };
	}
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`schema violation: ${key} must be a string`);
	return value;
}

function optionalBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`schema violation: ${key} must be a boolean`);
	return value;
}

function optionalStringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`schema violation: ${key} must be an array of strings`);
	}
	return [...value] as string[];
}

function optionalPermissions(raw: Record<string, unknown>): OperationInput["permissions"] {
	const value = raw.permissions;
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("schema violation: permissions must be an object");
	const allow = optionalStringArray(value, "allow");
	const deny = optionalStringArray(value, "deny");
	const approvalRequired = optionalStringArray(value, "approvalRequired");
	if (
		!allow ||
		!deny ||
		!approvalRequired ||
		Object.keys(value).some((key) => !["allow", "deny", "approvalRequired"].includes(key))
	) {
		throw new Error("schema violation: permissions require allow, deny, and approvalRequired arrays");
	}
	return { allow, deny, approvalRequired };
}

function optionalBudgets(raw: Record<string, unknown>): OperationInput["budgets"] {
	const value = raw.budgets;
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !["maxTokens", "maxToolCalls", "maxDurationMs"].includes(key))
	) {
		throw new Error("schema violation: budgets contain unknown fields");
	}
	const budgets: NonNullable<OperationInput["budgets"]> = {};
	for (const key of ["maxTokens", "maxToolCalls", "maxDurationMs"] as const) {
		const item = value[key];
		if (item === undefined) continue;
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
			throw new Error(`schema violation: ${key} must be a finite non-negative number`);
		}
		budgets[key] = item;
	}
	return budgets;
}

function optionalTaskPatch(raw: Record<string, unknown>): TaskContractPatch | undefined {
	const value = raw.taskPatch;
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("schema violation: taskPatch must be an object");
	const allowedFields = [
		"addScope",
		"removeScope",
		"addExclusions",
		"removeExclusions",
		"addAcceptanceCriteria",
		"removeAcceptanceCriteria",
		"permissions",
		"budgets",
		"outputContract",
		"addBlockers",
		"removeBlockers",
	] as const;
	const unknownField = Object.keys(value).find((key) => !(allowedFields as readonly string[]).includes(key));
	if (unknownField) throw new Error(`schema violation: unknown taskPatch field ${unknownField}`);
	const patch: TaskContractPatch = {};
	for (const key of [
		"addScope",
		"removeScope",
		"addExclusions",
		"removeExclusions",
		"addAcceptanceCriteria",
		"removeAcceptanceCriteria",
		"addBlockers",
		"removeBlockers",
	] as const) {
		const items = optionalStringArray(value, key);
		if (items !== undefined) patch[key] = items;
	}
	if (value.permissions !== undefined) {
		if (!isRecord(value.permissions)) throw new Error("schema violation: taskPatch.permissions must be an object");
		if (Object.keys(value.permissions).some((key) => !["allow", "deny", "approvalRequired"].includes(key))) {
			throw new Error("schema violation: taskPatch.permissions contain unknown fields");
		}
		const permissions: NonNullable<TaskContractPatch["permissions"]> = {};
		for (const key of ["allow", "deny", "approvalRequired"] as const) {
			const items = optionalStringArray(value.permissions, key);
			if (items !== undefined) permissions[key] = items;
		}
		patch.permissions = permissions;
	}
	if (value.budgets !== undefined) {
		if (!isRecord(value.budgets)) throw new Error("schema violation: taskPatch.budgets must be an object");
		if (Object.keys(value.budgets).some((key) => !["maxTokens", "maxToolCalls", "maxDurationMs"].includes(key))) {
			throw new Error("schema violation: taskPatch.budgets contain unknown fields");
		}
		const budgets: NonNullable<TaskContractPatch["budgets"]> = {};
		for (const key of ["maxTokens", "maxToolCalls", "maxDurationMs"] as const) {
			const item = value.budgets[key];
			if (item === undefined) continue;
			if (item !== null && (typeof item !== "number" || !Number.isFinite(item) || item < 0)) {
				throw new Error(`schema violation: taskPatch.budgets.${key} must be non-negative or null`);
			}
			budgets[key] = item;
		}
		patch.budgets = budgets;
	}
	if (Object.hasOwn(value, "outputContract")) {
		if (value.outputContract !== null && typeof value.outputContract !== "string") {
			throw new Error("schema violation: taskPatch.outputContract must be a string or null");
		}
		patch.outputContract = value.outputContract as string | null;
	}
	return patch;
}

function optionalConstraint(raw: Record<string, unknown>, actor: Authority): Constraint | undefined {
	const value = raw.constraint;
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		(value.kind !== "positive" && value.kind !== "negative") ||
		typeof value.text !== "string"
	) {
		throw new Error("schema violation: constraint must contain id, kind, and text");
	}
	// Authority is never accepted from model output. The authenticated source
	// event supplies it deterministically after parsing.
	return { id: value.id, kind: value.kind, text: value.text, authority: { ...actor } };
}

const OPERATION_FIELDS = new Set([
	"operation",
	"taskId",
	"parentTaskId",
	"goal",
	"replacementGoal",
	"acceptanceCriterion",
	"taskPatch",
	"constraint",
	"permissions",
	"budgets",
	"dependsOn",
	"setFocus",
	"ambiguous",
	"candidateTaskIds",
	"reason",
]);

export function parseGoalDeltaOperations(text: string, actor: Authority): GoalDeltaOperation[] {
	const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	const parsed: unknown = JSON.parse(cleaned);
	if (
		!isRecord(parsed) ||
		!Array.isArray(parsed.operations) ||
		Object.keys(parsed).some((key) => key !== "operations")
	) {
		throw new Error("schema violation: expected { operations: [...] }");
	}
	return parsed.operations.map((raw): GoalDeltaOperation => {
		if (!isRecord(raw) || typeof raw.operation !== "string" || !KNOWN_OPS.has(raw.operation as TaskOperation)) {
			throw new Error(`schema violation: unknown operation ${String(isRecord(raw) ? raw.operation : raw)}`);
		}
		const unknownField = Object.keys(raw).find((key) => !OPERATION_FIELDS.has(key));
		if (unknownField) throw new Error(`schema violation: unknown operation field ${unknownField}`);
		return {
			operation: raw.operation as TaskOperation,
			taskId: optionalString(raw, "taskId"),
			parentTaskId: optionalString(raw, "parentTaskId"),
			goal: optionalString(raw, "goal"),
			replacementGoal: optionalString(raw, "replacementGoal"),
			acceptanceCriterion: optionalString(raw, "acceptanceCriterion"),
			taskPatch: optionalTaskPatch(raw),
			constraint: optionalConstraint(raw, actor),
			permissions: optionalPermissions(raw),
			budgets: optionalBudgets(raw),
			dependsOn: optionalStringArray(raw, "dependsOn"),
			setFocus: optionalBoolean(raw, "setFocus"),
			ambiguous: optionalBoolean(raw, "ambiguous"),
			candidateTaskIds: optionalStringArray(raw, "candidateTaskIds"),
			reason: optionalString(raw, "reason"),
		};
	});
}

const INTERPRETER_INSTRUCTIONS = `You are classifying how the user's new message changes authoritative task state.
Current task-ledger state (the focus object is the complete current focus contract; other tasks are an index):
%s

Output ONLY a JSON object: {"operations": [...]}. Each operation:
- operation: one of CREATE_TASK | REFINE_TASK | EXTEND_TASK | CREATE_SUBTASK | SET_FOCUS | SUSPEND_TASK | RESUME_TASK | CANCEL_TASK | SUPERSEDE_TASK | REOPEN_TASK | ADD_CONSTRAINT | RELAX_CONSTRAINT | ADD_ACCEPTANCE_CRITERION | PATCH_TASK_CONTRACT | UPDATE_PERMISSIONS | UPDATE_BUDGETS | COMPLETE_TASK
- taskId / parentTaskId when targeting an existing task (never invent ids)
- goal: normalized one-sentence goal for CREATE/REFINE/EXTEND; replacementGoal for SUPERSEDE
- acceptanceCriterion, constraint, permissions, budgets, dependsOn, and setFocus when the operation needs them
- PATCH_TASK_CONTRACT uses taskPatch with field-level add/remove arrays: addScope/removeScope, addExclusions/removeExclusions, addAcceptanceCriteria/removeAcceptanceCriteria, addBlockers/removeBlockers; partial permissions; partial budgets (null clears one budget); outputContract string or null
- Preserve omitted taskPatch permission and budget fields. Use exact current strings when removing values.
- constraint is {id, kind: "positive" | "negative", text}; authority is assigned from the authenticated user event
- permissions is {allow: string[], deny: string[], approvalRequired: string[]}; budgets uses non-negative maxTokens/maxToolCalls/maxDurationMs
- If the reference is unclear, set ambiguous: true and list candidateTaskIds — never guess destructively.
- If the message does not change task state, output {"operations": []}.`;

export function validateGoalDeltaOperations(ops: GoalDeltaOperation[], ledger: TaskLedger): string | undefined {
	for (const op of ops) {
		const ambiguous = op.ambiguous === true || (op.candidateTaskIds?.length ?? 0) > 1;
		if ((op.operation === "CREATE_TASK" || op.operation === "CREATE_SUBTASK") && !op.goal?.trim()) {
			return `${op.operation} requires goal`;
		}
		if (op.operation === "CREATE_SUBTASK" && !op.parentTaskId && !ambiguous) {
			return "CREATE_SUBTASK requires parentTaskId";
		}
		if (op.operation !== "CREATE_TASK" && op.operation !== "CREATE_SUBTASK" && !op.taskId && !ambiguous) {
			return `${op.operation} requires taskId`;
		}
		if (op.operation === "ADD_ACCEPTANCE_CRITERION" && !op.acceptanceCriterion?.trim()) {
			return "ADD_ACCEPTANCE_CRITERION requires acceptanceCriterion";
		}
		if (op.operation === "PATCH_TASK_CONTRACT" && !op.taskPatch) {
			return "PATCH_TASK_CONTRACT requires taskPatch";
		}
		if (op.operation === "RELAX_CONSTRAINT" && !op.constraint?.id) {
			return "RELAX_CONSTRAINT requires constraint";
		}
		if (op.operation === "ADD_CONSTRAINT" && !op.constraint?.id) return "ADD_CONSTRAINT requires constraint";
		if (op.operation === "SUPERSEDE_TASK" && !op.replacementGoal?.trim() && !op.goal?.trim()) {
			return "SUPERSEDE_TASK requires replacementGoal";
		}
		if (op.operation === "UPDATE_PERMISSIONS" && !op.permissions) return "UPDATE_PERMISSIONS requires permissions";
		if (op.operation === "UPDATE_BUDGETS" && !op.budgets) return "UPDATE_BUDGETS requires budgets";
		if (op.setFocus !== undefined && op.operation !== "CREATE_TASK" && op.operation !== "CREATE_SUBTASK") {
			return `${op.operation} does not accept setFocus`;
		}
		if (op.taskId && !ledger.getTask(op.taskId)) return `unknown task ${op.taskId}`;
		if (op.parentTaskId && !ledger.getTask(op.parentTaskId)) return `unknown parent task ${op.parentTaskId}`;
		for (const dependencyId of op.dependsOn ?? []) {
			if (!ledger.getTask(dependencyId)) return `unknown dependency task ${dependencyId}`;
		}
		for (const candidateTaskId of op.candidateTaskIds ?? []) {
			if (!ledger.getTask(candidateTaskId)) return `unknown candidate task ${candidateTaskId}`;
		}
	}
	return undefined;
}

/**
 * Interpret one user message into task-ledger changes. The model only
 * proposes; deterministic validation decides what commits.
 */
export async function interpretGoalChange(input: GoalChangeInput): Promise<GoalChangeOutcome> {
	const actor = input.actor;
	if (!actor || actor.kind !== "user" || !actor.verified) {
		return { outcome: "rejected", reason: "goal interpretation requires an explicit verified user actor" };
	}

	// Fast path: message text with high-severity injection never reaches the model at all.
	if (detectInjections(input.userMessage).some((f) => f.severity === "high")) {
		return { outcome: "rejected", reason: "injection pattern in message" };
	}

	const acceptedContractUpdate = tryAcceptPendingContractUpdate(input);
	if (acceptedContractUpdate) return acceptedContractUpdate;

	let response: CompactionLLMResponse;
	try {
		response = await input.complete({
			systemPrompt: COMPACTOR_SYSTEM_POLICY,
			messages: [
				{
					role: "user",
					content: `${INTERPRETER_INSTRUCTIONS.replace("%s", interpreterTaskState(input.ledger))}\n\n${wrapUntrusted(input.userMessage)}`,
				},
			],
			maxTokens: 600,
			responseSchema: {
				type: "object",
				required: ["operations"],
				properties: { operations: { type: "array", items: { type: "object" } } },
				additionalProperties: false,
			},
			promptVersion: COMPACTOR_POLICY_VERSION,
		});
	} catch (error) {
		return {
			outcome: "rejected",
			reason: `interpreter call failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (
		!isRecord(response) ||
		response.stopReason !== "stop" ||
		typeof response.text !== "string" ||
		!response.text.trim()
	) {
		return { outcome: "rejected", reason: "interpreter returned invalid, empty, or aborted output" };
	}

	let ops: GoalDeltaOperation[];
	try {
		ops = parseGoalDeltaOperations(response.text, actor);
	} catch (error) {
		return { outcome: "rejected", reason: error instanceof Error ? error.message : String(error) };
	}
	if (ops.length === 0) return { outcome: "noop" };
	const semanticError = validateGoalDeltaOperations(ops, input.ledger);
	if (semanticError) return { outcome: "rejected", reason: semanticError };

	const ambiguous = ops.find((op) => op.ambiguous || (op.candidateTaskIds?.length ?? 0) > 1);
	const permissionLoosening = ops.some((operation) => loosensPermissions(operation, input.ledger));
	if (ambiguous || permissionLoosening) {
		const candidateTaskIds = [
			...new Set(
				ops.flatMap((op) => (op.candidateTaskIds?.length ? op.candidateTaskIds : op.taskId ? [op.taskId] : [])),
			),
		];
		const operationNames = ops.map((operation) => operation.operation).join(", ");
		const reason = ambiguous
			? (ambiguous.reason ?? `ambiguous operation requires user clarification: ${operationNames}`)
			: `security-sensitive permission loosening requires user confirmation: ${operationNames}`;
		try {
			input.ledger.recordPendingGoalChange({
				candidateTaskIds,
				reason,
				sourceEventId: input.sourceEventId,
				operations: ops,
				ambiguous: !!ambiguous,
				actor,
			});
		} catch (error) {
			return { outcome: "rejected", reason: error instanceof Error ? error.message : String(error) };
		}
		return { outcome: "pending", reason };
	}

	try {
		const committed = input.ledger.applyAtomic(ops, actor, input.sourceEventId);
		return { outcome: "committed", tasks: committed };
	} catch (error) {
		return { outcome: "rejected", reason: error instanceof Error ? error.message : String(error) };
	}
}
