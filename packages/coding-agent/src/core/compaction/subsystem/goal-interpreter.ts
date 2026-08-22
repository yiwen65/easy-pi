/**
 * Goal Interpreter (design correction, 2026-08-22): new user messages become
 * GoalDeltaProposals via the model — but only deterministic code commits
 * state. Dangerous interpretations (cancel/supersede/relax/add acceptance)
 * never auto-commit: they become pending goal changes for user confirmation.
 * Ambiguous references stay pending with all candidates preserved.
 */

import {
	COMPACTOR_POLICY_VERSION,
	COMPACTOR_SYSTEM_POLICY,
	detectInjections,
	wrapUntrusted,
} from "./injection-guard.ts";
import type { LedgerTask, OperationInput, TaskLedger, TaskOperation } from "./task-ledger.ts";
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

const DESTRUCTIVE = new Set<TaskOperation>([
	"CANCEL_TASK",
	"SUPERSEDE_TASK",
	"RELAX_CONSTRAINT",
	"ADD_ACCEPTANCE_CRITERION",
	"UPDATE_PERMISSIONS",
	"UPDATE_BUDGETS",
	"COMPLETE_TASK",
]);
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
	"UPDATE_PERMISSIONS",
	"UPDATE_BUDGETS",
	"COMPLETE_TASK",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskIndex(ledger: TaskLedger): string {
	const lines = ledger.nonTerminalIndex().map((t) => `- ${t.taskId} [${t.status}] v${t.version}: ${t.goal}`);
	return lines.length > 0 ? lines.join("\n") : "(no active tasks)";
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
	"constraint",
	"permissions",
	"budgets",
	"dependsOn",
	"setFocus",
	"ambiguous",
	"candidateTaskIds",
	"reason",
]);

function parseProposals(text: string, actor: Authority): GoalDeltaOperation[] {
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

const INTERPRETER_INSTRUCTIONS = `You are classifying how the user's new message changes task state.
Current non-terminal tasks:
%s

Output ONLY a JSON object: {"operations": [...]}. Each operation:
- operation: one of CREATE_TASK | REFINE_TASK | EXTEND_TASK | CREATE_SUBTASK | SET_FOCUS | SUSPEND_TASK | RESUME_TASK | CANCEL_TASK | SUPERSEDE_TASK | REOPEN_TASK | ADD_CONSTRAINT | RELAX_CONSTRAINT | ADD_ACCEPTANCE_CRITERION | UPDATE_PERMISSIONS | UPDATE_BUDGETS | COMPLETE_TASK
- taskId / parentTaskId when targeting an existing task (never invent ids)
- goal: normalized one-sentence goal for CREATE/REFINE/EXTEND; replacementGoal for SUPERSEDE
- acceptanceCriterion, constraint, permissions, budgets, dependsOn, and setFocus when the operation needs them
- constraint is {id, kind: "positive" | "negative", text}; authority is assigned from the authenticated user event
- permissions is {allow: string[], deny: string[], approvalRequired: string[]}; budgets uses non-negative maxTokens/maxToolCalls/maxDurationMs
- If the reference is unclear, set ambiguous: true and list candidateTaskIds — never guess destructively.
- If the message does not change task state, output {"operations": []}.`;

function validateProposalSemantics(ops: GoalDeltaOperation[], ledger: TaskLedger): string | undefined {
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

	let response: CompactionLLMResponse;
	try {
		response = await input.complete({
			systemPrompt: COMPACTOR_SYSTEM_POLICY,
			messages: [
				{
					role: "user",
					content: `${INTERPRETER_INSTRUCTIONS.replace("%s", taskIndex(input.ledger))}\n\n${wrapUntrusted(input.userMessage)}`,
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
		ops = parseProposals(response.text, actor);
	} catch (error) {
		return { outcome: "rejected", reason: error instanceof Error ? error.message : String(error) };
	}
	if (ops.length === 0) return { outcome: "noop" };
	const semanticError = validateProposalSemantics(ops, input.ledger);
	if (semanticError) return { outcome: "rejected", reason: semanticError };

	const ambiguous = ops.find((op) => op.ambiguous || (op.candidateTaskIds?.length ?? 0) > 1);
	const isDangerous = ops.some((op) => DESTRUCTIVE.has(op.operation));
	if (ambiguous || isDangerous) {
		const candidateTaskIds = [
			...new Set(
				ops.flatMap((op) => (op.candidateTaskIds?.length ? op.candidateTaskIds : op.taskId ? [op.taskId] : [])),
			),
		];
		const reason =
			ambiguous?.reason ??
			`dangerous operation requires user confirmation: ${ops.map((operation) => operation.operation).join(", ")}`;
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
