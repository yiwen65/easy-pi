import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { canonicalizeProspectivePath } from "@easy-pi/permissions";
import { type TUnsafe, Type } from "typebox";
import { Value } from "typebox/value";
import {
	type CompiledSubagentDagRequest,
	type DagReadOnlyTaskContract,
	type DagTaskContract,
	EXTERNAL_WRITER_ROLE,
	type ExternalWriterTaskContract,
	HANDOFF_PROTOCOL_VERSION,
	SUBAGENT_TASK_ID_MAX_CHARS,
	SUBAGENT_TASK_ID_PATTERN,
	type SubagentBudget,
	type SubagentPolicy,
	WRITER_ROLE,
	type WriterTaskContract,
} from "./types.ts";

export const VALIDATION_COMMAND_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
export const MAX_SUBAGENT_REQUEST_BYTES = 128 * 1024;
export const MIN_SUBAGENT_TOKENS_PER_TASK = 100_000;
export const MAX_SUBAGENT_TOKENS_PER_TASK = 1_000_000_000;
const MANAGED_INTEGRATION_REF_PREFIX = "pi/subagent/integration";

const TaskIdSchema = Type.String({
	minLength: 1,
	maxLength: SUBAGENT_TASK_ID_MAX_CHARS,
	pattern: SUBAGENT_TASK_ID_PATTERN,
});
const RelativePathSchema = Type.String({
	minLength: 1,
	maxLength: 500,
	description: "Path relative to the workspace root; absolute paths and parent traversal are invalid",
});
const ExternalPathSchema = Type.String({
	minLength: 1,
	maxLength: 500,
	pattern: "^(?:/|[A-Za-z]:[\\\\/])",
	description: "Absolute live host path",
});
const ObjectiveSchema = Type.String({
	minLength: 1,
	maxLength: 2_000,
	description:
		"Describe the delegated outcome and scope plus only context or constraints the repository cannot supply; let the Subagent discover implementation details, and keep work in one task when it can be completed coherently",
});

interface ToolTaskFields {
	id: string;
	objective: string;
	nonGoals?: string[];
	focusPaths?: string[];
	acceptance?: string[];
	dependsOn?: string[];
	/** Controller-only direct API override; omitted from the provider-facing schema. */
	maxAttempts?: number;
}

export interface SubagentAnalystTaskRequest extends ToolTaskFields {
	role: "analyst";
}

export interface SubagentReviewerTaskRequest extends ToolTaskFields {
	role: "reviewer";
}

export interface SubagentWriterTaskRequest extends ToolTaskFields {
	role: "writer";
	ownedPaths: string[];
	/** Controller-only direct API selection; omitted from the provider-facing schema. */
	validationCommandIds?: string[];
}

export interface SubagentExternalWriterTaskRequest extends ToolTaskFields {
	role: "external-writer";
	externalOwnedPaths: string[];
}

export type SubagentTaskRequest =
	| SubagentAnalystTaskRequest
	| SubagentReviewerTaskRequest
	| SubagentWriterTaskRequest
	| SubagentExternalWriterTaskRequest;

export interface SubagentDagStartRequest {
	operation: "start";
	tasks: SubagentTaskRequest[];
	/** Controller-only durable label; omitted from the provider-facing schema. */
	objective?: string;
	/** Controller-only candidate override; omitted from the provider-facing schema. */
	createCandidate?: boolean;
	/** Controller-only expansion boundary; omitted from the provider-facing schema. */
	openGraph?: boolean;
}

export interface SubagentDagExpandRequest {
	operation: "expand";
	runId: string;
	tasks: SubagentTaskRequest[];
	sealGraph?: boolean;
}

export interface SubagentDagResumeRequest {
	operation: "resume";
	runId: string;
}

export interface SubagentDagInspectRequest {
	operation: "inspect";
	runId: string;
	/** Select one task for trusted embedding/operator inspection. */
	taskId?: string;
}

export interface SubagentDagTaskMessageRequest {
	operation: "message" | "follow_up";
	runId: string;
	taskId: string;
	message: string;
}

export interface SubagentDagTaskInterruptRequest {
	operation: "interrupt";
	runId: string;
	taskId: string;
}

export interface SubagentToolTaskRequest {
	id: string;
	objective: string;
	dependsOn?: string[];
	/** Presence selects an isolated workspace Writer; absence keeps the task report-only. */
	ownedPaths?: string[];
	/** Presence selects an irreversible external Writer. */
	externalOwnedPaths?: string[];
	/** Presence selects an independent Reviewer and implies dependencies on these task IDs. */
	reviewOf?: string[];
}

export interface SubagentToolRequest {
	tasks: SubagentToolTaskRequest[];
}

export const DEFAULT_SUBAGENT_POLICY: SubagentPolicy = {
	maxTasks: 32,
	maxConcurrency: 4,
	defaultBudget: {
		maxTokens: 10_000_000,
	},
	maximumBudget: {
		maxTokens: MAX_SUBAGENT_TOKENS_PER_TASK,
	},
	maxSnapshotFiles: 20_000,
	maxSnapshotBytes: 512 * 1024 * 1024,
	allowedValidationCommandIds: [],
	maxTaskAttempts: 3,
	leaseDurationMs: 30_000,
};

export function isValidationCommandId(value: string): boolean {
	return value.length >= 1 && value.length <= 64 && new RegExp(VALIDATION_COMMAND_ID_PATTERN).test(value);
}

export function assertValidationCommandId(value: string): void {
	if (!isValidationCommandId(value)) {
		throw new Error(
			`Validation command id must be 1-64 characters and match ${VALIDATION_COMMAND_ID_PATTERN}: ${value || "<empty>"}`,
		);
	}
}

export function createSubagentToolRequestSchema(
	policy: SubagentPolicy = DEFAULT_SUBAGENT_POLICY,
): TUnsafe<SubagentToolRequest> {
	const commonTaskProperties = {
		id: TaskIdSchema,
		objective: ObjectiveSchema,
		dependsOn: Type.Optional(
			Type.Array(TaskIdSchema, {
				maxItems: Math.max(0, policy.maxTasks - 1),
				uniqueItems: true,
				description: "Task IDs whose completed results or artifacts are required for execution ordering",
			}),
		),
		ownedPaths: Type.Optional(
			Type.Array(RelativePathSchema, {
				minItems: 1,
				maxItems: 64,
				uniqueItems: true,
				description:
					"Select an isolated Writer by listing its non-overlapping paths relative to the workspace root; omit for report-only or review tasks",
			}),
		),
		externalOwnedPaths: Type.Optional(
			Type.Array(ExternalPathSchema, {
				minItems: 1,
				maxItems: 64,
				uniqueItems: true,
				description:
					"Select an irreversible external Writer by listing absolute live host paths; omit for all other tasks",
			}),
		),
		reviewOf: Type.Optional(
			Type.Array(TaskIdSchema, {
				minItems: 1,
				maxItems: Math.max(1, policy.maxTasks - 1),
				uniqueItems: true,
				description:
					"Select an independent verdict task and name the task results it reviews; these IDs automatically become execution dependencies",
			}),
		),
	};
	const task = Type.Object(commonTaskProperties, { additionalProperties: false });
	policyMaximumTokens(policy);
	const root = Type.Object(
		{
			tasks: Type.Array(task, {
				minItems: 1,
				maxItems: policy.maxTasks,
				description: "Tasks for one bounded durable DAG run",
			}),
		},
		{ additionalProperties: false },
	);
	return Type.Unsafe<SubagentToolRequest>(root);
}

/** Default schema export for standalone consumers; the extension registers a policy-aware instance. */
export const SubagentToolRequestSchema = createSubagentToolRequestSchema();

function assertOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
	if (unexpected.length > 0) throw new Error(`${context} has fields that do not apply: ${unexpected.join(", ")}`);
}

function validateRequestTasks(tasks: unknown[]): void {
	for (const rawTask of tasks) {
		const task = rawTask as Record<string, unknown>;
		if (task.ownedPaths !== undefined && task.externalOwnedPaths !== undefined) {
			throw new Error(`Task ${String(task.id)} ownedPaths and externalOwnedPaths are mutually exclusive`);
		}
		if (task.reviewOf !== undefined && (task.ownedPaths !== undefined || task.externalOwnedPaths !== undefined)) {
			throw new Error(`Task ${String(task.id)} reviewOf cannot be combined with ownedPaths or externalOwnedPaths`);
		}
	}
}

/** Validate the flat Provider-facing schema plus structural field semantics. */
export function parseSubagentToolRequest(
	value: unknown,
	schema: TUnsafe<SubagentToolRequest> = SubagentToolRequestSchema,
): SubagentToolRequest {
	if (!Value.Check(schema, value)) throw new Error("Subagent request does not match the registered schema");
	const request = value as unknown as Record<string, unknown>;
	assertOnlyFields(request, new Set(["tasks"]), "Subagent request");
	if (!Array.isArray(request.tasks) || request.tasks.length === 0) throw new Error("Subagent request requires tasks");
	validateRequestTasks(request.tasks);
	return value as SubagentToolRequest;
}

export function assertSubagentToolRequestSize(request: unknown): void {
	let serialized: string;
	try {
		serialized = JSON.stringify(request);
	} catch (error) {
		throw new Error(
			`Subagent request is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > MAX_SUBAGENT_REQUEST_BYTES) {
		throw new Error(`Subagent request exceeds ${MAX_SUBAGENT_REQUEST_BYTES}-byte limit (${bytes} bytes)`);
	}
}

function policyMaximumTokens(policy: SubagentPolicy): number {
	const configured = policy.maximumBudget.maxTokens;
	if (!Number.isSafeInteger(configured) || configured < MIN_SUBAGENT_TOKENS_PER_TASK) {
		throw new RangeError(
			`Subagent maximum task budget must be a safe integer of at least ${MIN_SUBAGENT_TOKENS_PER_TASK.toLocaleString("en-US")} tokens`,
		);
	}
	return Math.min(configured, MAX_SUBAGENT_TOKENS_PER_TASK);
}

function policyBudget(policy: SubagentPolicy): SubagentBudget {
	const maximum = policyMaximumTokens(policy);
	const maxTokens = Math.min(policy.defaultBudget.maxTokens, maximum);
	if (!Number.isSafeInteger(maxTokens) || maxTokens < MIN_SUBAGENT_TOKENS_PER_TASK || maxTokens > maximum) {
		throw new RangeError(
			`Subagent task budget must be between ${MIN_SUBAGENT_TOKENS_PER_TASK.toLocaleString("en-US")} and ${maximum.toLocaleString("en-US")} tokens`,
		);
	}
	return { maxTokens };
}

function trimmedRequired(value: string, kind: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${kind} must contain non-whitespace text`);
	return trimmed;
}

function normalizedStrings(values: readonly string[] | undefined, kind: string): string[] {
	return (values ?? []).map((value) => trimmedRequired(value, kind));
}

function normalizedPathInput(value: string): string {
	const path = value.replaceAll("\\", "/").replace(/^\.\//, "");
	return path.length > 1 && path.endsWith("/") && !/^[A-Za-z]:\/$/.test(path) ? path.slice(0, -1) : path;
}

function normalizeFocusPaths(paths: readonly string[] | undefined, taskId: string): string[] {
	const normalized: string[] = [];
	for (const value of paths ?? []) {
		const path = normalizedPathInput(value);
		const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path);
		if (
			!path ||
			path === "." ||
			(!absolute && (path === ".." || path.startsWith("../") || path.includes("/../"))) ||
			path.includes("\0") ||
			path.split("/").includes(".git")
		) {
			throw new Error(
				`Task ${taskId} has an unsafe focus path: ${value}. Use a workspace-relative or absolute read path, or omit focusPaths to inspect the workspace.`,
			);
		}
		if (!normalized.includes(path)) normalized.push(path);
	}
	return normalized;
}

function normalizeExternalOwnedPaths(paths: readonly string[] | undefined, taskId: string): string[] {
	const normalized: string[] = [];
	for (const value of paths ?? []) {
		const path = normalizedPathInput(value);
		const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path);
		if (!path || !absolute || path.includes("\0")) {
			throw new Error(`External writer task ${taskId} requires normalized absolute externalOwnedPaths: ${value}`);
		}
		const canonical = isAbsolute(path) ? canonicalizeProspectivePath(path, path) : path;
		if (!normalized.includes(canonical)) normalized.push(canonical);
	}
	return normalized;
}

function normalizeOwnedPaths(paths: readonly string[] | undefined, taskId: string): string[] {
	const normalized: string[] = [];
	for (const value of paths ?? []) {
		const path = normalizedPathInput(value);
		if (
			!path ||
			path === "." ||
			path.startsWith("/") ||
			/^[A-Za-z]:\//.test(path) ||
			path === ".." ||
			path.startsWith("../") ||
			path.includes("/../") ||
			path.includes("\0") ||
			path === ".git" ||
			path.startsWith(".git/")
		) {
			throw new Error(
				`Task ${taskId} has an unsafe owned path: ${value}. Use a path relative to the workspace root.`,
			);
		}
		if (!normalized.includes(path)) normalized.push(path);
	}
	return normalized;
}

function contractHash(contract: Omit<DagTaskContract, "contractHash">): string {
	return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function assertAcyclic(tasks: readonly DagTaskContract[]): void {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (taskId: string): void => {
		if (visited.has(taskId)) return;
		if (visiting.has(taskId)) throw new Error(`Task dependency cycle includes ${taskId}`);
		visiting.add(taskId);
		const task = byId.get(taskId);
		if (!task) throw new Error(`Unknown task dependency: ${taskId}`);
		for (const dependency of task.dependsOn) visit(dependency);
		visiting.delete(taskId);
		visited.add(taskId);
	};
	for (const task of tasks) visit(task.id);
}

function pathsOverlap(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function compileSubagentDagRequest(
	request: SubagentDagStartRequest,
	policy: SubagentPolicy = DEFAULT_SUBAGENT_POLICY,
): CompiledSubagentDagRequest {
	if (request.tasks.length < 1 || request.tasks.length > policy.maxTasks) {
		throw new Error(`Subagent DAG requires 1-${policy.maxTasks} tasks`);
	}
	const budget = policyBudget(policy);
	const ids = new Set(request.tasks.map((task) => task.id));
	if (ids.size !== request.tasks.length) throw new Error("Subagent DAG task ids must be unique");
	const maxTaskAttempts = policy.maxTaskAttempts ?? 1;
	const allowedCommands = new Set(policy.allowedValidationCommandIds ?? []);
	const claimedPaths: Array<{ taskId: string; path: string }> = [];
	const claimedExternalPaths: Array<{ taskId: string; path: string }> = [];
	const hasExternalWriter = request.tasks.some((task) => task.role === EXTERNAL_WRITER_ROLE);
	const hasWriter = request.tasks.some((task) => task.role === WRITER_ROLE);
	const createCandidate = request.createCandidate ?? hasWriter;
	if (hasExternalWriter && hasWriter) {
		throw new Error("External writers cannot be mixed with isolated workspace writers in one DAG");
	}
	if (hasExternalWriter && createCandidate) {
		throw new Error("External writer DAGs cannot create candidates because live side effects are not rollbackable");
	}

	const tasks = request.tasks.map((task): DagTaskContract => {
		const dependsOn = [...new Set(task.dependsOn ?? [])];
		if (dependsOn.length > Math.max(0, policy.maxTasks - 1)) {
			throw new Error(`Task ${task.id} has too many dependencies`);
		}
		for (const dependency of dependsOn) {
			if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
			if (!ids.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
		}
		if (task.role === EXTERNAL_WRITER_ROLE && task.maxAttempts !== undefined && task.maxAttempts !== 1) {
			throw new Error(
				`External writer task ${task.id} must use maxAttempts 1 because live writes cannot be retried safely`,
			);
		}
		const maxAttempts =
			task.role === EXTERNAL_WRITER_ROLE ? 1 : Math.min(task.maxAttempts ?? maxTaskAttempts, maxTaskAttempts);
		const common = {
			id: task.id,
			objective: trimmedRequired(task.objective, `Task ${task.id} objective`),
			nonGoals: normalizedStrings(task.nonGoals, `Task ${task.id} non-goal`),
			readPaths: normalizeFocusPaths(task.focusPaths, task.id),
			acceptance: normalizedStrings(task.acceptance, `Task ${task.id} acceptance criterion`),
			dependsOn,
			maxAttempts,
		};
		if (task.role === "analyst" || task.role === "reviewer") {
			const unhashed: Omit<DagReadOnlyTaskContract, "contractHash"> = {
				...common,
				role: task.role === "reviewer" ? "reviewer" : "scout",
			};
			return { ...unhashed, contractHash: contractHash(unhashed) };
		}
		if (task.role === EXTERNAL_WRITER_ROLE) {
			const externalOwnedPaths = normalizeExternalOwnedPaths(task.externalOwnedPaths, task.id);
			if (externalOwnedPaths.length === 0) {
				throw new Error(`External writer task ${task.id} requires at least one externalOwnedPath`);
			}
			for (const path of externalOwnedPaths) {
				const existing = claimedExternalPaths.find((claimed) => pathsOverlap(claimed.path, path));
				if (existing) {
					throw new Error(
						`External writer task ${task.id} path ${path} overlaps ${existing.taskId}:${existing.path}`,
					);
				}
				claimedExternalPaths.push({ taskId: task.id, path });
			}
			const unhashed: Omit<ExternalWriterTaskContract, "contractHash"> = {
				...common,
				role: EXTERNAL_WRITER_ROLE,
				externalOwnedPaths,
			};
			return { ...unhashed, contractHash: contractHash(unhashed) };
		}

		const ownedPaths = normalizeOwnedPaths(task.ownedPaths, task.id);
		if (ownedPaths.length === 0) throw new Error(`Writer task ${task.id} requires at least one owned path`);
		for (const path of ownedPaths) {
			const existing = claimedPaths.find((claimed) => pathsOverlap(claimed.path, path));
			if (existing) {
				throw new Error(`Writer task ${task.id} owned path ${path} overlaps ${existing.taskId}:${existing.path}`);
			}
			claimedPaths.push({ taskId: task.id, path });
		}
		const validationCommandIds = [...new Set(task.validationCommandIds ?? [])];
		for (const commandId of validationCommandIds) {
			assertValidationCommandId(commandId);
			if (!allowedCommands.has(commandId)) {
				const registered = [...allowedCommands].sort().join(", ") || "none (omit validationCommandIds)";
				throw new Error(
					`Writer task ${task.id} requests unregistered validation command ${commandId}; registered: ${registered}`,
				);
			}
		}
		const unhashed: Omit<WriterTaskContract, "contractHash"> = {
			...common,
			role: WRITER_ROLE,
			ownedPaths,
			validationCommandIds,
		};
		return { ...unhashed, contractHash: contractHash(unhashed) };
	});

	if (createCandidate && allowedCommands.size > 0) {
		const missingValidation = tasks
			.filter((task): task is WriterTaskContract => task.role === WRITER_ROLE)
			.filter((task) => task.validationCommandIds.length === 0)
			.map((task) => task.id);
		if (missingValidation.length > 0) {
			throw new Error(
				`Candidate writer tasks require at least one registered validation command: ${missingValidation.join(", ")}`,
			);
		}
	}
	assertAcyclic(tasks);
	const objective =
		request.objective ??
		(request.tasks.length === 1 ? request.tasks[0]!.objective : `Coordinate ${request.tasks.length} delegated tasks`);
	return {
		version: 2,
		handoffProtocolVersion: HANDOFF_PROTOCOL_VERSION,
		objective: trimmedRequired(objective, "Subagent objective"),
		tasks,
		budget,
		budgetScope: "task",
		merge: { enabled: createCandidate, refPrefix: MANAGED_INTEGRATION_REF_PREFIX },
		graph: { sealed: !(request.openGraph ?? false) },
	};
}

function taskDependencyClosure(taskId: string, tasksById: ReadonlyMap<string, DagTaskContract>): Set<string> {
	const closure = new Set<string>();
	const visit = (id: string): void => {
		const task = tasksById.get(id);
		if (!task) return;
		for (const dependency of task.dependsOn) {
			if (closure.has(dependency)) continue;
			closure.add(dependency);
			visit(dependency);
		}
	};
	visit(taskId);
	return closure;
}

function assertCompleteProviderReviewCoverage(request: CompiledSubagentDagRequest): void {
	const writerIds = request.tasks.filter((task) => task.role === WRITER_ROLE).map((task) => task.id);
	const reviewers = request.tasks.filter((task) => task.role === "reviewer");
	if (writerIds.length === 0 || reviewers.length === 0) return;
	const tasksById = new Map(request.tasks.map((task) => [task.id, task]));
	const complete = reviewers.some((reviewer) => {
		const closure = taskDependencyClosure(reviewer.id, tasksById);
		return writerIds.every((writerId) => closure.has(writerId));
	});
	if (!complete) {
		throw new Error(
			`At least one review task must cover every isolated Writer through reviewOf or dependsOn: ${writerIds.join(", ")}`,
		);
	}
}

/** Compile the strict roleless Provider contract into the durable role-bound Controller contract. */
export function compileSubagentToolDagRequest(
	request: SubagentToolRequest,
	policy: SubagentPolicy = DEFAULT_SUBAGENT_POLICY,
	validationCommandIds: readonly string[] = [],
): CompiledSubagentDagRequest {
	const parsed = parseSubagentToolRequest(request, createSubagentToolRequestSchema(policy));
	const tasks: SubagentTaskRequest[] = parsed.tasks.map((task) => {
		const dependsOn = [...new Set([...(task.dependsOn ?? []), ...(task.reviewOf ?? [])])];
		const common = { id: task.id, objective: task.objective, dependsOn };
		if (task.externalOwnedPaths) {
			return { ...common, role: EXTERNAL_WRITER_ROLE, externalOwnedPaths: task.externalOwnedPaths };
		}
		if (task.ownedPaths) {
			return {
				...common,
				role: WRITER_ROLE,
				ownedPaths: task.ownedPaths,
				validationCommandIds: [...validationCommandIds],
			};
		}
		if (task.reviewOf) return { ...common, role: "reviewer" };
		return { ...common, role: "analyst" };
	});
	const compiled = compileSubagentDagRequest({ operation: "start", tasks }, policy);
	assertCompleteProviderReviewCoverage(compiled);
	return compiled;
}

function requestTaskFromCompiled(task: DagTaskContract): SubagentTaskRequest {
	const common = {
		id: task.id,
		objective: task.objective,
		nonGoals: [...task.nonGoals],
		focusPaths: [...task.readPaths],
		acceptance: [...task.acceptance],
		dependsOn: [...task.dependsOn],
		maxAttempts: task.maxAttempts,
	};
	if (task.role === "writer") {
		return {
			...common,
			role: "writer",
			ownedPaths: [...task.ownedPaths],
			validationCommandIds: [...task.validationCommandIds],
		};
	}
	if (task.role === EXTERNAL_WRITER_ROLE) {
		return { ...common, role: EXTERNAL_WRITER_ROLE, externalOwnedPaths: [...task.externalOwnedPaths] };
	}
	return { ...common, role: task.role === "reviewer" ? "reviewer" : "analyst" };
}

export function compileSubagentDagExpansion(
	existing: CompiledSubagentDagRequest,
	expansion: SubagentDagExpandRequest,
	policy: SubagentPolicy = DEFAULT_SUBAGENT_POLICY,
): CompiledSubagentDagRequest {
	if (existing.graph.sealed) throw new Error("Subagent DAG graph is sealed");
	if (expansion.tasks.length === 0) {
		if (expansion.sealGraph !== true) throw new Error("An empty expansion must seal the graph");
		return { ...structuredClone(existing), graph: { sealed: true } };
	}
	const combined = compileSubagentDagRequest(
		{
			operation: "start",
			objective: existing.objective,
			tasks: [...existing.tasks.map(requestTaskFromCompiled), ...expansion.tasks],
			createCandidate: existing.merge.enabled,
			openGraph: !(expansion.sealGraph ?? false),
		},
		policy,
	);
	const added = combined.tasks.slice(existing.tasks.length);
	return {
		...structuredClone(existing),
		tasks: [...structuredClone(existing.tasks), ...added],
		graph: { sealed: expansion.sealGraph ?? false },
	};
}
