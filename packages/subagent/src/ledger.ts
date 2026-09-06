import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExternalMutationJournalEvent, ExternalMutationJournalPolicy } from "@easy-pi/permissions/journal";
import {
	ATTEMPT_PERFORMANCE_EVENT,
	ATTEMPT_PERFORMANCE_STAGES,
	type AttemptPerformanceTelemetry,
	buildSubagentPerformanceReport,
	SCHEDULER_WAIT_EVENT,
	type SchedulerWaitTelemetry,
	SUBAGENT_PERFORMANCE_VERSION,
	type SubagentPerformanceReport,
} from "./performance.ts";
import { evaluateCandidateQuality, evaluatePartialCandidateQuality } from "./quality-model.ts";
import { decideRetry, retryDelayMs } from "./retry-policy.ts";
import type {
	ChildRuntimeMetadata,
	CompiledSubagentDagRequest,
	DagResourceLifecycle,
	DagRunLease,
	DagRunSummary,
	DagTaskContract,
	DagTaskStatus,
	ExternalMutationRecord,
	IntegrationArtifact,
	IntegrationFailure,
	PartialCandidateNegativeTask,
	PartialCandidateOmissionReason,
	ProviderCircuitOpenSignal,
	RunStatus,
	SnapshotBaseline,
	SubagentRole,
	TaskArtifact,
	TaskStatus,
	TaskTerminalReason,
} from "./types.ts";
import { HANDOFF_PROTOCOL_VERSION, TASK_ARTIFACT_VERSION } from "./types.ts";

export interface LedgerEvent {
	sequence: number;
	runId: string;
	taskId?: string;
	type: string;
	payload: unknown;
	createdAt: number;
}

export interface CreateDagRunRecord {
	runId: string;
	request: CompiledSubagentDagRequest;
	baseline: SnapshotBaseline;
	usage?: Usage;
}

export interface DagAttemptRecord {
	attemptId: string;
	attemptNumber: number;
	ownerId: string;
	status: "running" | "succeeded" | "failed" | "expired";
	leaseExpiresAt: number;
	checkpoint?: unknown;
	terminalReason?: TaskTerminalReason;
	error?: string;
	usage: Usage;
	turns: number;
	runtime?: ChildRuntimeMetadata;
	externalMutations: ExternalMutationRecord[];
	createdAt: number;
	updatedAt: number;
}

export interface DagExternalMutationJournalSource {
	policy: ExternalMutationJournalPolicy;
	attemptStatus: DagAttemptRecord["status"];
	consumedSequence: number;
}

export interface DagTaskEligibility {
	retryAt?: number;
	foreignLeaseAt?: number;
}

export interface DagTaskClaim {
	runId: string;
	taskId: string;
	role: SubagentRole;
	contract: DagTaskContract;
	attemptId: string;
	attemptNumber: number;
	ownerId: string;
	leaseExpiresAt: number;
	checkpoint?: unknown;
	/** Runtime continuity; availability retries receive an identity-free generation seed. */
	runtime?: ChildRuntimeMetadata;
	/** Internal private journal source for an external-writer attempt. */
	externalMutationJournalPath?: string;
}

export interface DagTaskCompletionSuccess {
	artifact: TaskArtifact;
	/** Absolute cumulative accounting for this attempt. */
	usage?: Usage;
	turns?: number;
}

export interface DagTaskCompletionFailure {
	artifact?: never;
	terminalReason: Exclude<TaskTerminalReason, "completed">;
	error?: string;
	/** Absolute cumulative accounting for this attempt. */
	usage?: Usage;
	turns?: number;
}

export type DagTaskCompletion = DagTaskCompletionSuccess | DagTaskCompletionFailure;

export interface LedgerDagTaskRecord {
	runId: string;
	taskId: string;
	role: SubagentRole;
	contract: DagTaskContract;
	status: DagTaskStatus;
	attempts: number;
	attemptRecords: DagAttemptRecord[];
	ownerId?: string;
	activeAttemptId?: string;
	leaseExpiresAt?: number;
	checkpoint?: unknown;
	terminalReason?: TaskTerminalReason;
	error?: string;
	artifact?: TaskArtifact;
	usage: Usage;
	turns: number;
	createdAt: number;
	updatedAt: number;
}

export interface LedgerDagRunRecord {
	runId: string;
	status: RunStatus;
	objective: string;
	request: CompiledSubagentDagRequest;
	baseline: SnapshotBaseline;
	tasks: LedgerDagTaskRecord[];
	usage: Usage;
	turns: number;
	pausedAt?: number;
	pausedDurationMs: number;
	graphVersion: number;
	graphSealed: boolean;
	awaitingExpansion: boolean;
	lease?: DagRunLease;
	integration?: IntegrationArtifact;
	integrationFailure?: IntegrationFailure;
	resources: DagResourceLifecycle;
	createdAt: number;
	updatedAt: number;
}

export type DagRunRecord = LedgerDagRunRecord;
export type DagTaskRecord = LedgerDagTaskRecord;
export type DagAttemptClaim = DagTaskClaim;
export type DagLedgerEvent = LedgerEvent;

export interface ListDagRunsOptions {
	/** Defaults to 20 and is capped at 100. */
	limit?: number;
	statuses?: readonly RunStatus[];
	/** Exact persisted Git worktree root; applied before ordering and LIMIT. */
	repositoryRoot?: string;
}

export interface DagRunInspection extends LedgerDagRunRecord {
	/** Latest bounded events, returned in ascending sequence order. */
	events: DagLedgerEvent[];
	/** On-demand aggregate over content-free durable performance events. */
	performance: SubagentPerformanceReport;
}

interface EventRow {
	sequence: number;
	run_id: string;
	task_id: string | null;
	event_type: string;
	payload_json: string;
	created_at: number;
}

interface DagRunRow {
	run_id: string;
	repository_root: string;
	request_json: string;
	status: RunStatus;
	baseline_json: string;
	usage_json: string;
	turns: number;
	owner_id: string | null;
	owner_epoch: number;
	run_lease_expires_at: number | null;
	integration_json: string | null;
	integration_failure_json: string | null;
	paused_at: number | null;
	paused_duration_ms: number;
	graph_version: number;
	graph_sealed: number;
	candidate_release_state: "retained" | "release_pending" | "released";
	candidate_release_started_at: number | null;
	candidate_released_at: number | null;
	resource_gc_state: "retained" | "gc_pending" | "released";
	gc_started_at: number | null;
	gc_completed_at: number | null;
	created_at: number;
	updated_at: number;
}

interface DagRunOwnershipRow {
	status: RunStatus;
	owner_id: string | null;
	owner_epoch: number;
	run_lease_expires_at: number | null;
}

interface DagTaskRow {
	run_id: string;
	task_id: string;
	task_order: number;
	role: SubagentRole;
	contract_json: string;
	status: DagTaskStatus;
	max_attempts: number;
	attempt_count: number;
	current_attempt_id: string | null;
	owner_id: string | null;
	lease_expires_at: number | null;
	checkpoint_json: string | null;
	terminal_reason: TaskTerminalReason | null;
	error: string | null;
	artifact_json: string | null;
	usage_json: string;
	turns: number;
	retry_not_before: number | null;
	created_at: number;
	updated_at: number;
}

interface DagAttemptRow {
	attempt_id: string;
	run_id: string;
	task_id: string;
	attempt_number: number;
	owner_id: string;
	status: "running" | "succeeded" | "failed" | "expired";
	lease_expires_at: number;
	checkpoint_json: string | null;
	terminal_reason: TaskTerminalReason | null;
	error: string | null;
	usage_json: string;
	turns: number;
	runtime_json: string | null;
	created_at: number;
	updated_at: number;
}

interface ExternalMutationJournalRow {
	attempt_id: string;
	run_id: string;
	task_id: string;
	journal_path: string;
	consumed_sequence: number;
	released_at: number | null;
	created_at: number;
	updated_at: number;
}

interface ExternalMutationRow {
	mutation_id: string;
	run_id: string;
	task_id: string;
	attempt_id: string;
	attempt_number: number;
	authorization_sequence: number;
	tool_call_id: string;
	operation: "write" | "edit";
	canonical_path: string;
	authorized_at: number;
	tool_result: "succeeded" | "failed" | null;
	observed_at: number | null;
	post_state_json: string | null;
	created_at: number;
	updated_at: number;
}

export const SUBAGENT_LEDGER_SCHEMA_VERSION = 3;
export const RUNTIME_METADATA_PERSIST_INTERVAL = 64;

export class UnsupportedLedgerSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedLedgerSchemaError";
	}
}

const MAX_INTEGRATION_DIAGNOSTIC_BYTES = 32 * 1024;
const DEFAULT_OPERATOR_RUN_LIMIT = 20;
const MAX_OPERATOR_RUN_LIMIT = 100;
const DEFAULT_OPERATOR_EVENT_LIMIT = 100;
const MAX_OPERATOR_EVENT_LIMIT = 500;

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
	created: ["running", "failed", "cancelled"],
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

function encode(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError("Ledger values must be JSON-serializable");
	return encoded;
}

function decode<T>(value: string): T {
	return JSON.parse(value) as T;
}

function normalizedIntegrationArtifact(value: unknown): IntegrationArtifact {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Persisted integration artifact is invalid");
	}
	const candidate = value as Partial<IntegrationArtifact> & { kind?: unknown; partial?: unknown };
	if (candidate.artifactVersion !== 1) throw new Error("Persisted integration artifact version is unsupported");
	const kind = candidate.kind ?? "complete";
	if (kind !== "complete" && kind !== "partial") throw new Error("Persisted integration artifact kind is invalid");
	if (kind === "partial") {
		const partial = candidate.partial as Record<string, unknown> | undefined;
		if (
			!partial ||
			(partial.reason !== "task_failure" && partial.reason !== "candidate_quality_failure") ||
			partial.trust !== "controller_validated" ||
			!Array.isArray(partial.completeGateFailures) ||
			!Array.isArray(partial.includedWriterTaskIds) ||
			!Array.isArray(partial.omittedWriterTasks) ||
			!Array.isArray(partial.negativeTasks) ||
			candidate.quality?.gate !== "failed" ||
			!Array.isArray(candidate.quality.gateFailures) ||
			!candidate.quality.gateFailures.includes("dag_incomplete")
		) {
			throw new Error("Partial integration artifact requires non-accepted quality and provenance");
		}
		return { ...candidate, kind } as IntegrationArtifact;
	}
	if (candidate.partial !== undefined)
		throw new Error("Complete integration artifact cannot contain partial provenance");
	return { ...candidate, kind } as IntegrationArtifact;
}

function decodeIntegrationArtifact(value: string): IntegrationArtifact {
	return normalizedIntegrationArtifact(decode<unknown>(value));
}

function externalMutationFromRow(row: ExternalMutationRow): ExternalMutationRecord {
	return {
		mutationId: row.mutation_id,
		runId: row.run_id,
		taskId: row.task_id,
		attemptId: row.attempt_id,
		attemptNumber: row.attempt_number,
		authorizationSequence: row.authorization_sequence,
		toolCallId: row.tool_call_id,
		operation: row.operation,
		path: row.canonical_path,
		authorizationStatus: "authorized",
		authorizedAt: row.authorized_at,
		...(row.tool_result ? { toolResult: row.tool_result } : {}),
		...(row.observed_at === null ? {} : { observedAt: row.observed_at }),
		...(row.post_state_json ? { postState: decode<ExternalMutationRecord["postState"]>(row.post_state_json) } : {}),
	};
}

function cloneUsage(usage: Usage | undefined): Usage {
	return decode<Usage>(encode(usage ?? ZERO_USAGE));
}

function addUsageValues(left: Usage, right: Usage): Usage {
	const total = cloneUsage(left);
	total.input += right.input;
	total.output += right.output;
	total.cacheRead += right.cacheRead;
	total.cacheWrite += right.cacheWrite;
	total.totalTokens += right.totalTokens;
	total.cost.input += right.cost.input;
	total.cost.output += right.cost.output;
	total.cost.cacheRead += right.cost.cacheRead;
	total.cost.cacheWrite += right.cost.cacheWrite;
	total.cost.total += right.cost.total;
	if (right.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + right.cacheWrite1h;
	if (right.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + right.reasoning;
	return total;
}

function usageAtLeast(next: Usage, previous: Usage): boolean {
	return (
		next.input >= previous.input &&
		next.output >= previous.output &&
		next.cacheRead >= previous.cacheRead &&
		next.cacheWrite >= previous.cacheWrite &&
		next.totalTokens >= previous.totalTokens &&
		next.cost.input >= previous.cost.input &&
		next.cost.output >= previous.cost.output &&
		next.cost.cacheRead >= previous.cost.cacheRead &&
		next.cost.cacheWrite >= previous.cost.cacheWrite &&
		next.cost.total >= previous.cost.total &&
		(next.cacheWrite1h ?? 0) >= (previous.cacheWrite1h ?? 0) &&
		(next.reasoning ?? 0) >= (previous.reasoning ?? 0)
	);
}

function boundedDiagnostic(value: string): string {
	const bytes = Buffer.from(value);
	if (bytes.byteLength <= MAX_INTEGRATION_DIAGNOSTIC_BYTES) return value;
	return bytes
		.subarray(0, MAX_INTEGRATION_DIAGNOSTIC_BYTES)
		.toString("utf8")
		.replace(/\uFFFD$/u, "");
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertExactRecordKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (!equalStrings(actual, sortedExpected)) throw new Error(`${name} has unexpected fields`);
}

function normalizedAttemptPerformance(value: AttemptPerformanceTelemetry): AttemptPerformanceTelemetry {
	const record = value as unknown as Record<string, unknown>;
	assertExactRecordKeys(
		record,
		[
			"version",
			"attemptId",
			"attemptNumber",
			"role",
			"startedAt",
			"finishedAt",
			"success",
			"terminalReason",
			"stages",
		],
		"Attempt performance telemetry",
	);
	if (
		value.version !== SUBAGENT_PERFORMANCE_VERSION ||
		!value.attemptId ||
		!Number.isSafeInteger(value.attemptNumber) ||
		value.attemptNumber < 1 ||
		!Number.isSafeInteger(value.startedAt) ||
		!Number.isSafeInteger(value.finishedAt) ||
		value.finishedAt < value.startedAt ||
		typeof value.success !== "boolean" ||
		!value.terminalReason ||
		!value.stages ||
		typeof value.stages !== "object" ||
		Array.isArray(value.stages)
	) {
		throw new Error("Attempt performance telemetry is invalid");
	}
	const stageRecord = value.stages as Record<string, unknown>;
	const unknownStages = Object.keys(stageRecord).filter(
		(stage) => !ATTEMPT_PERFORMANCE_STAGES.includes(stage as never),
	);
	if (unknownStages.length > 0) throw new Error("Attempt performance telemetry has an unknown stage");
	const stages: AttemptPerformanceTelemetry["stages"] = {};
	for (const stage of ATTEMPT_PERFORMANCE_STAGES) {
		const duration = stageRecord[stage];
		if (duration === undefined) continue;
		if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
			throw new Error("Attempt performance telemetry has an invalid duration");
		}
		stages[stage] = duration;
	}
	return { ...value, stages };
}

function normalizedProviderCircuitSignal(value: ProviderCircuitOpenSignal): ProviderCircuitOpenSignal {
	const record = value as unknown as Record<string, unknown>;
	assertExactRecordKeys(
		record,
		["version", "reason", "autoRetryAttempt", "consecutiveUnlimitedRetries", "retryDelayMs"],
		"Provider circuit signal",
	);
	if (
		value.version !== 1 ||
		value.reason !== "unlimited_auto_retry" ||
		!Number.isSafeInteger(value.autoRetryAttempt) ||
		value.autoRetryAttempt < 1 ||
		!Number.isSafeInteger(value.consecutiveUnlimitedRetries) ||
		value.consecutiveUnlimitedRetries < 1 ||
		!Number.isSafeInteger(value.retryDelayMs) ||
		value.retryDelayMs < 0
	) {
		throw new Error("Provider circuit signal is invalid");
	}
	return { ...value };
}

function normalizedSchedulerWait(value: SchedulerWaitTelemetry): SchedulerWaitTelemetry {
	const record = value as unknown as Record<string, unknown>;
	const expected = ["version", "startedAt", "finishedAt", "capacity", "reason", "runnableButIdleMs"];
	if (value.nextEligibleAt !== undefined) expected.push("nextEligibleAt");
	assertExactRecordKeys(record, expected, "Scheduler wait telemetry");
	if (
		value.version !== SUBAGENT_PERFORMANCE_VERSION ||
		!Number.isSafeInteger(value.startedAt) ||
		!Number.isSafeInteger(value.finishedAt) ||
		value.finishedAt < value.startedAt ||
		!Number.isSafeInteger(value.capacity) ||
		value.capacity < 0 ||
		!(["active", "eligibility", "lease"] as const).includes(value.reason) ||
		(value.nextEligibleAt !== undefined && !Number.isSafeInteger(value.nextEligibleAt)) ||
		!Number.isFinite(value.runnableButIdleMs) ||
		value.runnableButIdleMs < 0
	) {
		throw new Error("Scheduler wait telemetry is invalid");
	}
	return { ...value };
}

function checkpointRecord(value: string | null): Record<string, unknown> | undefined {
	if (!value) return undefined;
	try {
		const checkpoint = decode<unknown>(value);
		if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return undefined;
		const record = checkpoint as Record<string, unknown>;
		return record.version === 1 && typeof record.phase === "string" ? record : undefined;
	} catch {
		return undefined;
	}
}

function isAvailabilityRetryCheckpoint(value: string | null): boolean {
	const checkpoint = checkpointRecord(value);
	return checkpoint?.phase === "availability_retry" || checkpoint?.availabilityRetry === true;
}

function providerCircuitRetryNotBefore(value: string | null): number | undefined {
	const checkpoint = checkpointRecord(value);
	if (
		checkpoint?.phase !== "provider_circuit_open" ||
		!Number.isSafeInteger(checkpoint.retryNotBefore) ||
		Number(checkpoint.retryNotBefore) < 0
	) {
		return undefined;
	}
	return Number(checkpoint.retryNotBefore);
}

function freshRuntimeGenerationSeed(runtime: ChildRuntimeMetadata): ChildRuntimeMetadata {
	const seed = { ...runtime };
	delete seed.sessionId;
	delete seed.sessionFile;
	delete seed.runtimeRoot;
	delete seed.runtimeRootId;
	return seed;
}

function isControllerResumableCheckpoint(value: string | null, role: SubagentRole): boolean {
	const checkpoint = checkpointRecord(value);
	const phase = checkpoint?.phase;
	// artifact_ready only fast-forwards durable Controller completion. Interrupted
	// and availability retries rerun Child work, which is unsafe for live writers.
	return (
		phase === "artifact_ready" ||
		(role !== "external-writer" &&
			(phase === "interrupted" || phase === "provider_circuit_open" || isAvailabilityRetryCheckpoint(value)))
	);
}

function dagResourceLifecycle(row: DagRunRow): DagResourceLifecycle {
	return {
		candidate: row.integration_json === null ? "none" : row.candidate_release_state,
		pins: row.resource_gc_state,
		...(row.candidate_release_started_at === null
			? {}
			: { candidateReleaseStartedAt: row.candidate_release_started_at }),
		...(row.candidate_released_at === null ? {} : { candidateReleasedAt: row.candidate_released_at }),
		...(row.gc_started_at === null ? {} : { gcStartedAt: row.gc_started_at }),
		...(row.gc_completed_at === null ? {} : { gcCompletedAt: row.gc_completed_at }),
	};
}

function decodeCompiledDagRequest(value: string): CompiledSubagentDagRequest {
	const request = decode<CompiledSubagentDagRequest>(value);
	if (
		request.version !== 2 ||
		request.handoffProtocolVersion !== HANDOFF_PROTOCOL_VERSION ||
		typeof request.graph?.sealed !== "boolean"
	) {
		throw new Error("Persisted Subagent DAG request uses an unsupported protocol version");
	}
	return request;
}

function stableTopologicalTaskIds(request: CompiledSubagentDagRequest): string[] {
	const completed = new Set<string>();
	const ordered: string[] = [];
	while (ordered.length < request.tasks.length) {
		const next = request.tasks.find(
			(task) => !completed.has(task.id) && task.dependsOn.every((dependency) => completed.has(dependency)),
		);
		if (!next) throw new Error("Persisted DAG request is cyclic or has an unknown dependency");
		completed.add(next.id);
		ordered.push(next.id);
	}
	return ordered;
}

/** Durable run/task state and append-only lifecycle events backed by node:sqlite. */
export class RunLedger {
	private readonly database: DatabaseSync;
	private readonly runtimeHighWatermarks = new Map<string, { generation: number; sequence: number }>();
	private closed = false;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.database = new DatabaseSync(path);
		try {
			this.initializeSchema(path);
		} catch (error) {
			this.closed = true;
			try {
				this.database.close();
			} catch {
				// Preserve the schema error.
			}
			throw error;
		}
	}

	private initializeSchema(path: string): void {
		this.database.exec("PRAGMA busy_timeout = 5000");
		this.database.exec("PRAGMA foreign_keys = ON");
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const tables = new Set(
				(
					this.database
						.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
						.all() as unknown as Array<{ name: string }>
				).map((row) => row.name),
			);
			if (tables.size === 0) {
				this.database.exec(`
					CREATE TABLE ledger_schema (
						singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
						version INTEGER NOT NULL
					);
					INSERT INTO ledger_schema (singleton, version) VALUES (1, ${SUBAGENT_LEDGER_SCHEMA_VERSION});

					CREATE TABLE dag_runs (
						run_id TEXT PRIMARY KEY,
						repository_root TEXT NOT NULL,
						request_json TEXT NOT NULL,
						status TEXT NOT NULL CHECK (status IN ('created', 'running', 'succeeded', 'failed', 'cancelled')),
						baseline_json TEXT NOT NULL,
						usage_json TEXT NOT NULL,
						turns INTEGER NOT NULL DEFAULT 0,
						owner_id TEXT,
						owner_epoch INTEGER NOT NULL DEFAULT 0,
						run_lease_expires_at INTEGER,
						integration_json TEXT,
						integration_failure_json TEXT,
						paused_at INTEGER,
						paused_duration_ms INTEGER NOT NULL DEFAULT 0,
						graph_version INTEGER NOT NULL DEFAULT 1,
						graph_sealed INTEGER NOT NULL DEFAULT 1,
						candidate_release_state TEXT NOT NULL DEFAULT 'retained',
						candidate_release_started_at INTEGER,
						candidate_released_at INTEGER,
						resource_gc_state TEXT NOT NULL DEFAULT 'retained',
						gc_started_at INTEGER,
						gc_completed_at INTEGER,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL
					);
					CREATE TABLE dag_tasks (
						run_id TEXT NOT NULL REFERENCES dag_runs(run_id) ON DELETE CASCADE,
						task_id TEXT NOT NULL,
						task_order INTEGER NOT NULL,
						role TEXT NOT NULL CHECK (role IN ('scout', 'test-analyst', 'failure-analyst', 'reviewer', 'writer', 'external-writer')),
						contract_json TEXT NOT NULL,
						status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'blocked')),
						max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
						attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= max_attempts),
						current_attempt_id TEXT,
						owner_id TEXT,
						lease_expires_at INTEGER,
						checkpoint_json TEXT,
						terminal_reason TEXT,
						error TEXT,
						artifact_json TEXT,
						usage_json TEXT NOT NULL,
						turns INTEGER NOT NULL DEFAULT 0,
						retry_not_before INTEGER,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						PRIMARY KEY (run_id, task_id),
						UNIQUE (run_id, task_order)
					);
					CREATE TABLE dag_dependencies (
						run_id TEXT NOT NULL,
						task_id TEXT NOT NULL,
						dependency_task_id TEXT NOT NULL,
						PRIMARY KEY (run_id, task_id, dependency_task_id),
						FOREIGN KEY (run_id, task_id) REFERENCES dag_tasks(run_id, task_id) ON DELETE CASCADE,
						FOREIGN KEY (run_id, dependency_task_id) REFERENCES dag_tasks(run_id, task_id) ON DELETE CASCADE
					);
					CREATE TABLE dag_attempts (
						attempt_id TEXT PRIMARY KEY,
						run_id TEXT NOT NULL,
						task_id TEXT NOT NULL,
						attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
						owner_id TEXT NOT NULL,
						status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'expired')),
						lease_expires_at INTEGER NOT NULL,
						checkpoint_json TEXT,
						terminal_reason TEXT,
						error TEXT,
						usage_json TEXT NOT NULL,
						turns INTEGER NOT NULL DEFAULT 0,
						runtime_json TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						UNIQUE (run_id, task_id, attempt_number),
						FOREIGN KEY (run_id, task_id) REFERENCES dag_tasks(run_id, task_id) ON DELETE CASCADE
					);
					CREATE TABLE dag_external_mutation_journals (
						attempt_id TEXT PRIMARY KEY REFERENCES dag_attempts(attempt_id) ON DELETE CASCADE,
						run_id TEXT NOT NULL,
						task_id TEXT NOT NULL,
						journal_path TEXT NOT NULL,
						consumed_sequence INTEGER NOT NULL DEFAULT 0 CHECK (consumed_sequence >= 0),
						released_at INTEGER,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						UNIQUE (run_id, task_id, attempt_id),
						FOREIGN KEY (run_id, task_id) REFERENCES dag_tasks(run_id, task_id) ON DELETE CASCADE
					);
					CREATE TABLE dag_external_mutations (
						mutation_id TEXT PRIMARY KEY,
						run_id TEXT NOT NULL,
						task_id TEXT NOT NULL,
						attempt_id TEXT NOT NULL REFERENCES dag_attempts(attempt_id) ON DELETE CASCADE,
						attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
						authorization_sequence INTEGER NOT NULL CHECK (authorization_sequence >= 1),
						tool_call_id TEXT NOT NULL,
						operation TEXT NOT NULL CHECK (operation IN ('write', 'edit')),
						canonical_path TEXT NOT NULL,
						authorized_at INTEGER NOT NULL,
						tool_result TEXT CHECK (tool_result IN ('succeeded', 'failed')),
						observed_at INTEGER,
						post_state_json TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						UNIQUE (attempt_id, authorization_sequence),
						UNIQUE (attempt_id, tool_call_id),
						FOREIGN KEY (run_id, task_id) REFERENCES dag_tasks(run_id, task_id) ON DELETE CASCADE
					);
					CREATE TABLE dag_events (
						sequence INTEGER PRIMARY KEY AUTOINCREMENT,
						run_id TEXT NOT NULL REFERENCES dag_runs(run_id) ON DELETE CASCADE,
						task_id TEXT,
						event_type TEXT NOT NULL,
						payload_json TEXT NOT NULL,
						created_at INTEGER NOT NULL,
						FOREIGN KEY (run_id, task_id) REFERENCES dag_tasks(run_id, task_id)
					);
					CREATE INDEX dag_tasks_by_run_status ON dag_tasks(run_id, status, task_order);
					CREATE INDEX dag_dependencies_by_dependency ON dag_dependencies(run_id, dependency_task_id);
					CREATE INDEX dag_attempts_by_task ON dag_attempts(run_id, task_id, attempt_number);
					CREATE INDEX dag_external_mutations_by_attempt ON dag_external_mutations(attempt_id, authorization_sequence);
					CREATE INDEX dag_events_by_run ON dag_events(run_id, sequence);
				`);
			} else {
				let version: number | undefined;
				try {
					version = (
						this.database.prepare("SELECT version FROM ledger_schema WHERE singleton = 1").get() as
							| { version: number }
							| undefined
					)?.version;
				} catch {
					throw new UnsupportedLedgerSchemaError(
						`Subagent ledger ${path} is legacy or unversioned; schema ${SUBAGENT_LEDGER_SCHEMA_VERSION} is required. Reset the ledger before using this version.`,
					);
				}
				if (version === 2) {
					this.database.exec("ALTER TABLE dag_tasks ADD COLUMN retry_not_before INTEGER");
					this.database
						.prepare("UPDATE ledger_schema SET version = ? WHERE singleton = 1 AND version = 2")
						.run(SUBAGENT_LEDGER_SCHEMA_VERSION);
					version = SUBAGENT_LEDGER_SCHEMA_VERSION;
				}
				if (version !== SUBAGENT_LEDGER_SCHEMA_VERSION) {
					throw new UnsupportedLedgerSchemaError(
						`Subagent ledger ${path} has unsupported schema ${String(version)}; schema ${SUBAGENT_LEDGER_SCHEMA_VERSION} is required. Reset the ledger before using this version.`,
					);
				}
				const required = [
					"dag_runs",
					"dag_tasks",
					"dag_dependencies",
					"dag_attempts",
					"dag_external_mutation_journals",
					"dag_external_mutations",
					"dag_events",
				];
				const missing = required.filter((name) => !tables.has(name));
				if (missing.length > 0) {
					throw new UnsupportedLedgerSchemaError(
						`Subagent ledger ${path} schema ${SUBAGENT_LEDGER_SCHEMA_VERSION} is incomplete; missing tables: ${missing.join(", ")}.`,
					);
				}
			}
			this.database.exec("COMMIT");
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Preserve the schema error.
			}
			throw error;
		}
		this.database.exec("PRAGMA journal_mode = WAL");
	}

	private ensureOpen(): void {
		if (this.closed) throw new Error("Ledger is closed");
	}

	private transaction<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Preserve the original failure.
			}
			throw error;
		}
	}

	private readTransaction<T>(operation: () => T): T {
		this.database.exec("BEGIN");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Preserve the original failure.
			}
			throw error;
		}
	}

	private reconcileDagRunAccountingInTransaction(runId: string, now: number): { usage: Usage; turns: number } {
		const run = this.database.prepare("SELECT usage_json, turns FROM dag_runs WHERE run_id = ?").get(runId) as
			| { usage_json: string; turns: number }
			| undefined;
		if (!run) throw new Error(`Unknown DAG run: ${runId}`);
		const attempts = this.database
			.prepare("SELECT usage_json, turns FROM dag_attempts WHERE run_id = ? ORDER BY task_id, attempt_number")
			.all(runId) as unknown as Array<{ usage_json: string; turns: number }>;
		let usage = cloneUsage(ZERO_USAGE);
		let turns = 0;
		for (const attempt of attempts) {
			usage = addUsageValues(usage, decode<Usage>(attempt.usage_json));
			turns += attempt.turns;
		}
		if (!Number.isSafeInteger(turns)) throw new Error(`DAG run turns exceed the safe integer range: ${runId}`);
		const usageJson = encode(usage);
		if (usageJson !== run.usage_json || turns !== run.turns) {
			const result = this.database
				.prepare("UPDATE dag_runs SET usage_json = ?, turns = ?, updated_at = ? WHERE run_id = ?")
				.run(usageJson, turns, now, runId);
			if (result.changes !== 1) throw new Error(`Unknown DAG run: ${runId}`);
			this.insertDagEvent(runId, "run.usage", { usage, turns, source: "attempts" }, now);
		}
		return { usage: cloneUsage(usage), turns };
	}

	private insertDagEvent(runId: string, type: string, payload: unknown, now: number, taskId?: string): void {
		this.database
			.prepare(
				"INSERT INTO dag_events (run_id, task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(runId, taskId ?? null, type, encode(payload), now);
	}

	private assertDagRunMutationLease(
		runId: string,
		row: DagRunOwnershipRow,
		now: number,
		lease: DagRunLease | undefined,
		terminal = false,
	): void {
		if (terminal && !lease) throw new Error(`DAG run lease is required for terminal transition: ${runId}`);
		if (row.owner_id === null) {
			if (lease) throw new Error(`Stale DAG run lease: ${runId}`);
			return;
		}
		if (
			!lease ||
			lease.ownerId !== row.owner_id ||
			lease.epoch !== row.owner_epoch ||
			lease.leaseExpiresAt !== row.run_lease_expires_at ||
			row.run_lease_expires_at === null ||
			row.run_lease_expires_at <= now
		) {
			throw new Error(`Stale DAG run lease: ${runId}`);
		}
	}

	private blockDagDescendants(runId: string, now: number): void {
		for (;;) {
			const rows = this.database
				.prepare(
					`SELECT DISTINCT task.task_id, task.task_order
					 FROM dag_tasks task
					 JOIN dag_dependencies dependency
					   ON dependency.run_id = task.run_id AND dependency.task_id = task.task_id
					 JOIN dag_tasks prerequisite
					   ON prerequisite.run_id = dependency.run_id
					  AND prerequisite.task_id = dependency.dependency_task_id
					 WHERE task.run_id = ? AND task.status = 'pending'
					   AND (
					     prerequisite.status IN ('failed', 'cancelled', 'blocked')
					     OR (
					       prerequisite.status = 'succeeded'
					       AND json_extract(prerequisite.artifact_json, '$.quality.semanticOutcome') IN ('rejected', 'inconclusive')
					     )
					   )
					 ORDER BY task.task_order`,
				)
				.all(runId) as unknown as Array<{ task_id: string }>;
			if (rows.length === 0) return;
			for (const row of rows) {
				const result = this.database
					.prepare(
						`UPDATE dag_tasks
						 SET status = 'blocked', terminal_reason = 'dependency_failed',
						     error = 'A task dependency did not succeed', updated_at = ?
						 WHERE run_id = ? AND task_id = ? AND status = 'pending'`,
					)
					.run(now, runId, row.task_id);
				if (result.changes === 1) {
					this.insertDagEvent(
						runId,
						"task.blocked",
						{ status: "blocked", terminalReason: "dependency_failed" },
						now,
						row.task_id,
					);
				}
			}
		}
	}

	acquireDagRunLease(runId: string, ownerId: string, now: number, leaseDurationMs: number): DagRunLease | undefined {
		this.ensureOpen();
		if (!ownerId) throw new Error("ownerId is required");
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
			throw new Error("leaseDurationMs must be a positive safe integer");
		}
		const leaseExpiresAt = now + leaseDurationMs;
		if (!Number.isSafeInteger(leaseExpiresAt)) throw new Error("lease expiry exceeds the safe integer range");
		return this.transaction(() => {
			const row = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			if (row.status !== "created" && row.status !== "running") return undefined;
			if (row.owner_id !== null && row.run_lease_expires_at !== null && row.run_lease_expires_at > now) {
				return undefined;
			}
			const epoch = row.owner_epoch + 1;
			if (!Number.isSafeInteger(epoch)) throw new Error("DAG run lease epoch exceeds the safe integer range");
			const result = this.database
				.prepare(
					`UPDATE dag_runs
					 SET owner_id = ?, owner_epoch = ?, run_lease_expires_at = ?, updated_at = ?
					 WHERE run_id = ? AND owner_epoch = ? AND owner_id IS ? AND run_lease_expires_at IS ?
					   AND status IN ('created', 'running')`,
				)
				.run(ownerId, epoch, leaseExpiresAt, now, runId, row.owner_epoch, row.owner_id, row.run_lease_expires_at);
			if (result.changes !== 1) return undefined;
			const lease = { ownerId, epoch, leaseExpiresAt };
			this.insertDagEvent(runId, "run.lease.acquired", lease, now);
			return lease;
		});
	}

	heartbeatDagRunLease(
		runId: string,
		lease: DagRunLease,
		now: number,
		leaseDurationMs: number,
	): DagRunLease | undefined {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
			throw new Error("leaseDurationMs must be a positive safe integer");
		}
		const leaseExpiresAt = now + leaseDurationMs;
		if (!Number.isSafeInteger(leaseExpiresAt)) throw new Error("lease expiry exceeds the safe integer range");
		return this.transaction(() => {
			const result = this.database
				.prepare(
					`UPDATE dag_runs
					 SET run_lease_expires_at = ?, updated_at = ?
					 WHERE run_id = ? AND owner_id = ? AND owner_epoch = ? AND run_lease_expires_at = ?
					   AND run_lease_expires_at > ? AND status IN ('created', 'running')`,
				)
				.run(leaseExpiresAt, now, runId, lease.ownerId, lease.epoch, lease.leaseExpiresAt, now);
			if (result.changes !== 1) return undefined;
			const renewed = { ownerId: lease.ownerId, epoch: lease.epoch, leaseExpiresAt };
			this.insertDagEvent(runId, "run.lease.heartbeat", renewed, now);
			return renewed;
		});
	}

	releaseDagRunLease(runId: string, lease: DagRunLease, now = Date.now()): boolean {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		return this.transaction(() => {
			const result = this.database
				.prepare(
					`UPDATE dag_runs
					 SET owner_id = NULL, run_lease_expires_at = NULL, updated_at = ?
					 WHERE run_id = ? AND owner_id = ? AND owner_epoch = ? AND run_lease_expires_at = ?
					   AND status IN ('created', 'running')`,
				)
				.run(now, runId, lease.ownerId, lease.epoch, lease.leaseExpiresAt);
			if (result.changes !== 1) return false;
			this.insertDagEvent(runId, "run.lease.released", { ownerId: lease.ownerId, epoch: lease.epoch }, now);
			return true;
		});
	}

	markDagRunPaused(runId: string, now = Date.now()): boolean {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		return this.transaction(() => {
			const row = this.database
				.prepare("SELECT status, paused_at, owner_id, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as
				| {
						status: RunStatus;
						paused_at: number | null;
						owner_id: string | null;
						run_lease_expires_at: number | null;
				  }
				| undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			if (row.status !== "created" && row.status !== "running") return false;
			if (row.paused_at !== null) return true;
			if (row.owner_id !== null && row.run_lease_expires_at !== null && row.run_lease_expires_at > now) {
				throw new Error(`DAG run has a live controller lease: ${runId}`);
			}
			const runningTasks = this.database
				.prepare(
					`SELECT * FROM dag_tasks
					 WHERE run_id = ? AND status = 'running'
					 ORDER BY task_order`,
				)
				.all(runId) as unknown as DagTaskRow[];
			const unsafe = runningTasks.find((task) => !isControllerResumableCheckpoint(task.checkpoint_json, task.role));
			if (unsafe) {
				throw new Error(`DAG run cannot pause with non-resumable task: ${runId}/${unsafe.task_id}`);
			}
			for (const task of runningTasks) {
				if (!task.current_attempt_id || !task.owner_id) {
					throw new Error(`Running DAG task has no active attempt: ${runId}/${task.task_id}`);
				}
				const attemptResult = this.database
					.prepare(
						`UPDATE dag_attempts
						 SET status = 'expired', terminal_reason = 'interrupted', error = 'Attempt interrupted by DAG pause', updated_at = ?
						 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'`,
					)
					.run(now, task.current_attempt_id, runId, task.task_id, task.owner_id);
				if (attemptResult.changes !== 1) {
					throw new Error(`Concurrent DAG attempt pause detected: ${runId}/${task.task_id}`);
				}
				const taskResult = this.database
					.prepare(
						`UPDATE dag_tasks
						 SET status = 'pending', current_attempt_id = NULL, owner_id = NULL,
						     lease_expires_at = NULL, terminal_reason = NULL, error = NULL, updated_at = ?
						 WHERE run_id = ? AND task_id = ? AND status = 'running'
						   AND current_attempt_id = ? AND owner_id = ?`,
					)
					.run(now, runId, task.task_id, task.current_attempt_id, task.owner_id);
				if (taskResult.changes !== 1) {
					throw new Error(`Concurrent DAG task pause detected: ${runId}/${task.task_id}`);
				}
				this.insertDagEvent(
					runId,
					"task.requeued",
					{
						attemptId: task.current_attempt_id,
						attemptNumber: task.attempt_count,
						reason: "paused",
					},
					now,
					task.task_id,
				);
			}
			const result = this.database
				.prepare(
					`UPDATE dag_runs
					 SET paused_at = ?, owner_id = NULL, run_lease_expires_at = NULL, updated_at = ?
					 WHERE run_id = ? AND status IN ('created', 'running') AND paused_at IS NULL
					   AND (owner_id IS NULL OR run_lease_expires_at IS NULL OR run_lease_expires_at <= ?)`,
				)
				.run(now, now, runId, now);
			if (result.changes !== 1) throw new Error(`Concurrent DAG pause detected: ${runId}`);
			this.insertDagEvent(runId, "run.paused", { pausedAt: now }, now);
			return true;
		});
	}

	clearDagRunPause(runId: string, now: number, lease: DagRunLease): boolean {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		return this.transaction(() => {
			const row = this.database
				.prepare(
					`SELECT status, owner_id, owner_epoch, run_lease_expires_at, paused_at, paused_duration_ms
					 FROM dag_runs WHERE run_id = ?`,
				)
				.get(runId) as (DagRunOwnershipRow & { paused_at: number | null; paused_duration_ms: number }) | undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, row, now, lease);
			if (row.paused_at === null) return false;
			const duration = Math.max(0, now - row.paused_at);
			const total = row.paused_duration_ms + duration;
			if (!Number.isSafeInteger(total)) throw new Error("Paused duration exceeds the safe integer range");
			const result = this.database
				.prepare(
					`UPDATE dag_runs SET paused_at = NULL, paused_duration_ms = ?, updated_at = ?
					 WHERE run_id = ? AND paused_at = ? AND owner_id = ? AND owner_epoch = ? AND run_lease_expires_at = ?`,
				)
				.run(total, now, runId, row.paused_at, lease.ownerId, lease.epoch, lease.leaseExpiresAt);
			if (result.changes !== 1) throw new Error(`Concurrent DAG resume detected: ${runId}`);
			this.insertDagEvent(
				runId,
				"run.resumed",
				{ pausedAt: row.paused_at, resumedAt: now, pausedDurationMs: duration },
				now,
			);
			return true;
		});
	}

	beginDagCandidateRelease(runId: string, now = Date.now()): "pending" | "released" {
		this.ensureOpen();
		return this.transaction(() => {
			const row = this.database
				.prepare("SELECT status, integration_json, candidate_release_state FROM dag_runs WHERE run_id = ?")
				.get(runId) as
				| { status: RunStatus; integration_json: string | null; candidate_release_state: string }
				| undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			if (!["succeeded", "failed", "cancelled"].includes(row.status))
				throw new Error(`DAG run is not terminal: ${runId}`);
			if (!row.integration_json) throw new Error(`DAG run has no integration candidate: ${runId}`);
			if (row.candidate_release_state === "released") return "released";
			if (row.candidate_release_state === "release_pending") return "pending";
			const result = this.database
				.prepare(
					`UPDATE dag_runs SET candidate_release_state = 'release_pending', candidate_release_started_at = ?, updated_at = ?
					 WHERE run_id = ? AND candidate_release_state = 'retained'`,
				)
				.run(now, now, runId);
			if (result.changes !== 1) throw new Error(`Concurrent candidate release detected: ${runId}`);
			this.insertDagEvent(runId, "run.candidate_release_started", { startedAt: now }, now);
			return "pending";
		});
	}

	completeDagCandidateRelease(runId: string, now = Date.now()): void {
		this.ensureOpen();
		this.transaction(() => {
			const row = this.database
				.prepare("SELECT candidate_release_state FROM dag_runs WHERE run_id = ?")
				.get(runId) as { candidate_release_state: string } | undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			if (row.candidate_release_state === "released") return;
			if (row.candidate_release_state !== "release_pending")
				throw new Error(`Candidate release was not started: ${runId}`);
			this.database
				.prepare(
					`UPDATE dag_runs SET candidate_release_state = 'released', candidate_released_at = ?, updated_at = ?
					 WHERE run_id = ? AND candidate_release_state = 'release_pending'`,
				)
				.run(now, now, runId);
			this.insertDagEvent(runId, "run.candidate_released", { releasedAt: now }, now);
		});
	}

	beginDagResourceGc(runId: string, now = Date.now()): "pending" | "released" {
		this.ensureOpen();
		return this.transaction(() => {
			const row = this.database
				.prepare(
					"SELECT status, integration_json, candidate_release_state, resource_gc_state FROM dag_runs WHERE run_id = ?",
				)
				.get(runId) as
				| {
						status: RunStatus;
						integration_json: string | null;
						candidate_release_state: string;
						resource_gc_state: string;
				  }
				| undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			if (!["succeeded", "failed", "cancelled"].includes(row.status))
				throw new Error(`DAG run is not terminal: ${runId}`);
			if (row.integration_json && row.candidate_release_state !== "released") {
				throw new Error(`Release the integration candidate before resource GC: ${runId}`);
			}
			if (row.resource_gc_state === "released") return "released";
			if (row.resource_gc_state === "gc_pending") return "pending";
			const result = this.database
				.prepare(
					`UPDATE dag_runs SET resource_gc_state = 'gc_pending', gc_started_at = ?, updated_at = ?
					 WHERE run_id = ? AND resource_gc_state = 'retained'`,
				)
				.run(now, now, runId);
			if (result.changes !== 1) throw new Error(`Concurrent resource GC detected: ${runId}`);
			this.insertDagEvent(runId, "run.gc_started", { startedAt: now }, now);
			return "pending";
		});
	}

	completeDagResourceGc(runId: string, now = Date.now()): void {
		this.ensureOpen();
		this.transaction(() => {
			const row = this.database.prepare("SELECT resource_gc_state FROM dag_runs WHERE run_id = ?").get(runId) as
				| { resource_gc_state: string }
				| undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			if (row.resource_gc_state === "released") return;
			if (row.resource_gc_state !== "gc_pending") throw new Error(`Resource GC was not started: ${runId}`);
			this.database
				.prepare(
					`UPDATE dag_runs SET resource_gc_state = 'released', gc_completed_at = ?, updated_at = ?
					 WHERE run_id = ? AND resource_gc_state = 'gc_pending'`,
				)
				.run(now, now, runId);
			this.insertDagEvent(runId, "run.gc_completed", { completedAt: now }, now);
		});
	}

	createDagRun(record: CreateDagRunRecord): void {
		this.ensureOpen();
		if (!record.runId) throw new Error("runId is required");
		if (record.request.version !== 2) throw new Error("DAG request version must be 2");
		const taskIds = new Set(record.request.tasks.map((task) => task.id));
		if (taskIds.size !== record.request.tasks.length) throw new Error("DAG task ids must be unique");
		if (record.request.tasks.length === 0) throw new Error("DAG run requires at least one task");
		const tasksById = new Map(record.request.tasks.map((task) => [task.id, task]));
		for (const task of record.request.tasks) {
			if (!Number.isSafeInteger(task.maxAttempts) || task.maxAttempts < 1) {
				throw new Error(`Task ${task.id} maxAttempts must be a positive safe integer`);
			}
			for (const dependency of task.dependsOn) {
				if (dependency === task.id || !taskIds.has(dependency)) {
					throw new Error(`Task ${task.id} has invalid dependency ${dependency}`);
				}
			}
		}
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (taskId: string): void => {
			if (visited.has(taskId)) return;
			if (visiting.has(taskId)) throw new Error(`DAG task dependency cycle includes ${taskId}`);
			visiting.add(taskId);
			for (const dependency of tasksById.get(taskId)?.dependsOn ?? []) visit(dependency);
			visiting.delete(taskId);
			visited.add(taskId);
		};
		for (const task of record.request.tasks) visit(task.id);
		const now = Date.now();
		const usage = cloneUsage(record.usage);
		const request = decodeCompiledDagRequest(encode(record.request));
		const baseline = decode<SnapshotBaseline>(encode(record.baseline));
		this.transaction(() => {
			this.database
				.prepare(
					`INSERT INTO dag_runs
					 (run_id, repository_root, request_json, status, baseline_json, usage_json,
					  graph_version, graph_sealed, created_at, updated_at)
					 VALUES (?, ?, ?, 'created', ?, ?, 1, ?, ?, ?)`,
				)
				.run(
					record.runId,
					baseline.repositoryRoot,
					encode(request),
					encode(baseline),
					encode(usage),
					request.graph.sealed ? 1 : 0,
					now,
					now,
				);
			this.insertDagEvent(record.runId, "run.created", { status: "created", request, baseline }, now);
			for (const [taskOrder, task] of request.tasks.entries()) {
				this.database
					.prepare(
						`INSERT INTO dag_tasks
						 (run_id, task_id, task_order, role, contract_json, status, max_attempts,
						  attempt_count, usage_json, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)`,
					)
					.run(
						record.runId,
						task.id,
						taskOrder,
						task.role,
						encode(task),
						task.maxAttempts,
						encode(ZERO_USAGE),
						now,
						now,
					);
			}
			for (const task of request.tasks) {
				for (const dependency of task.dependsOn) {
					this.database
						.prepare("INSERT INTO dag_dependencies (run_id, task_id, dependency_task_id) VALUES (?, ?, ?)")
						.run(record.runId, task.id, dependency);
				}
				this.insertDagEvent(record.runId, "task.created", { status: "pending", contract: task }, now, task.id);
			}
		});
	}

	expandDagRun(
		runId: string,
		expectedGraphVersion: number,
		expandedRequest: CompiledSubagentDagRequest,
		now = Date.now(),
		lease?: DagRunLease,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(expectedGraphVersion) || expectedGraphVersion < 1) {
			throw new Error("expectedGraphVersion must be a positive safe integer");
		}
		this.transaction(() => {
			const row = this.database.prepare("SELECT * FROM dag_runs WHERE run_id = ?").get(runId) as
				| DagRunRow
				| undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, row, now, lease);
			if (row.status !== "running" && row.status !== "created")
				throw new Error(`DAG run is ${row.status}: ${runId}`);
			if (row.paused_at === null) throw new Error(`DAG run is not awaiting expansion: ${runId}`);
			if (row.integration_json !== null || row.integration_failure_json !== null) {
				throw new Error(`DAG run already has integration state: ${runId}`);
			}
			if (row.graph_sealed !== 0) throw new Error(`DAG graph is sealed: ${runId}`);
			if (row.graph_version !== expectedGraphVersion) {
				throw new Error(`Stale DAG graph version: expected ${expectedGraphVersion}, current ${row.graph_version}`);
			}
			const current = decodeCompiledDagRequest(row.request_json);
			if (expandedRequest.tasks.length < current.tasks.length) throw new Error("Expanded DAG cannot remove tasks");
			if (encode(expandedRequest.tasks.slice(0, current.tasks.length)) !== encode(current.tasks)) {
				throw new Error("Expanded DAG cannot modify persisted tasks");
			}
			const { tasks: _currentTasks, graph: _currentGraph, ...currentStatic } = current;
			const { tasks: _expandedTasks, graph: _expandedGraph, ...expandedStatic } = expandedRequest;
			if (encode(currentStatic) !== encode(expandedStatic)) throw new Error("Expanded DAG cannot modify run policy");
			stableTopologicalTaskIds(expandedRequest);
			const ids = new Set(expandedRequest.tasks.map((task) => task.id));
			if (ids.size !== expandedRequest.tasks.length) throw new Error("Expanded DAG task ids must be unique");
			const ownership: Array<{ taskId: string; path: string }> = [];
			for (const task of expandedRequest.tasks) {
				if (!Number.isSafeInteger(task.maxAttempts) || task.maxAttempts < 1) {
					throw new Error(`Expanded task ${task.id} has invalid maxAttempts`);
				}
				if (task.role !== "writer") continue;
				for (const path of task.ownedPaths) {
					const overlap = ownership.find(
						(claimed) =>
							path === claimed.path ||
							path.startsWith(`${claimed.path}/`) ||
							claimed.path.startsWith(`${path}/`),
					);
					if (overlap) throw new Error(`Expanded writer ownership overlaps: ${task.id}/${overlap.taskId}`);
					ownership.push({ taskId: task.id, path });
				}
			}
			const incomplete = this.database
				.prepare("SELECT task_id, status FROM dag_tasks WHERE run_id = ? AND status <> 'succeeded' LIMIT 1")
				.get(runId) as { task_id: string; status: DagTaskStatus } | undefined;
			if (incomplete) {
				throw new Error(`Cannot expand before task ${incomplete.task_id} is succeeded (${incomplete.status})`);
			}
			const added = expandedRequest.tasks.slice(current.tasks.length);
			for (const [offset, task] of added.entries()) {
				this.database
					.prepare(
						`INSERT INTO dag_tasks
						 (run_id, task_id, task_order, role, contract_json, status, max_attempts,
						  attempt_count, usage_json, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)`,
					)
					.run(
						runId,
						task.id,
						current.tasks.length + offset,
						task.role,
						encode(task),
						task.maxAttempts,
						encode(ZERO_USAGE),
						now,
						now,
					);
			}
			for (const task of added) {
				for (const dependency of task.dependsOn) {
					this.database
						.prepare("INSERT INTO dag_dependencies (run_id, task_id, dependency_task_id) VALUES (?, ?, ?)")
						.run(runId, task.id, dependency);
				}
				this.insertDagEvent(runId, "task.created", { status: "pending", contract: task }, now, task.id);
			}
			const nextVersion = row.graph_version + 1;
			const sealed = expandedRequest.graph.sealed;
			const result = this.database
				.prepare(
					`UPDATE dag_runs SET request_json = ?, graph_version = ?, graph_sealed = ?, updated_at = ?
					 WHERE run_id = ? AND graph_version = ? AND graph_sealed = 0 AND status IN ('created','running')`,
				)
				.run(encode(expandedRequest), nextVersion, sealed ? 1 : 0, now, runId, expectedGraphVersion);
			if (result.changes !== 1) throw new Error(`Concurrent DAG graph expansion detected: ${runId}`);
			this.insertDagEvent(
				runId,
				"run.graph_expanded",
				{
					fromVersion: row.graph_version,
					toVersion: nextVersion,
					addedTaskIds: added.map((task) => task.id),
					sealed,
				},
				now,
			);
		});
	}

	setDagRunStatus(runId: string, nextStatus: RunStatus, now = Date.now(), lease?: DagRunLease): void {
		this.ensureOpen();
		this.transaction(() => {
			const row = this.database
				.prepare(
					`SELECT status, request_json, integration_json, integration_failure_json,
					        owner_id, owner_epoch, run_lease_expires_at, paused_at,
					        paused_duration_ms, graph_sealed
					 FROM dag_runs WHERE run_id = ?`,
				)
				.get(runId) as
				| (DagRunOwnershipRow & {
						request_json: string;
						integration_json: string | null;
						integration_failure_json: string | null;
						paused_at: number | null;
						paused_duration_ms: number;
						graph_sealed: number;
				  })
				| undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			const terminal = nextStatus === "succeeded" || nextStatus === "failed" || nextStatus === "cancelled";
			const alreadyTerminal = row.status === "succeeded" || row.status === "failed" || row.status === "cancelled";
			if (alreadyTerminal) {
				if (row.status === nextStatus) return;
				throw new Error(`Invalid DAG run transition: ${row.status} -> ${nextStatus}`);
			}
			this.assertDagRunMutationLease(runId, row, now, lease, terminal);
			if (row.status === nextStatus) return;
			if (!RUN_TRANSITIONS[row.status].includes(nextStatus)) {
				throw new Error(`Invalid DAG run transition: ${row.status} -> ${nextStatus}`);
			}
			if (nextStatus === "succeeded") {
				if (row.paused_at !== null) throw new Error(`Paused DAG run cannot succeed: ${runId}`);
				if (row.graph_sealed === 0) throw new Error(`Unsealed DAG run cannot succeed: ${runId}`);
				if (row.integration_failure_json) {
					throw new Error(`DAG run ${runId} has an integration failure`);
				}
				const incomplete = this.database
					.prepare("SELECT task_id FROM dag_tasks WHERE run_id = ? AND status <> 'succeeded' LIMIT 1")
					.get(runId) as { task_id: string } | undefined;
				if (incomplete) throw new Error(`DAG run cannot succeed while task ${incomplete.task_id} is not succeeded`);
				const request = decodeCompiledDagRequest(row.request_json);
				if (request.merge.enabled && !row.integration_json) {
					throw new Error(`DAG run ${runId} requires an integration artifact before succeeding`);
				}
				if (row.integration_json) {
					const integration = decodeIntegrationArtifact(row.integration_json);
					if (integration.kind !== "complete" || integration.quality?.gate !== "passed") {
						throw new Error(`DAG run ${runId} cannot succeed with a Partial Candidate`);
					}
				}
			}

			if (nextStatus === "failed" || nextStatus === "cancelled") {
				const taskStatus: TaskStatus = nextStatus === "cancelled" ? "cancelled" : "failed";
				const terminalReason: TaskTerminalReason = nextStatus === "cancelled" ? "cancelled" : "interrupted";
				const error = nextStatus === "cancelled" ? "DAG run cancelled" : "DAG run failed";
				const fencedTasks = this.database
					.prepare(
						`SELECT task.task_id, task.status, task.usage_json AS task_usage_json,
						        task.turns AS task_turns, attempt.usage_json AS attempt_usage_json,
						        attempt.turns AS attempt_turns
						 FROM dag_tasks task
						 LEFT JOIN dag_attempts attempt ON attempt.attempt_id = task.current_attempt_id
						 WHERE task.run_id = ? AND task.status IN ('pending', 'running')
						 ORDER BY task.task_order`,
					)
					.all(runId) as unknown as Array<{
					task_id: string;
					status: DagTaskStatus;
					task_usage_json: string;
					task_turns: number;
					attempt_usage_json: string | null;
					attempt_turns: number | null;
				}>;
				for (const task of fencedTasks) {
					if (task.status !== "running" || task.attempt_usage_json === null) continue;
					const taskUsage = addUsageValues(
						decode<Usage>(task.task_usage_json),
						decode<Usage>(task.attempt_usage_json),
					);
					const taskTurns = task.task_turns + (task.attempt_turns ?? 0);
					if (!Number.isSafeInteger(taskTurns)) {
						throw new Error(`DAG task turns exceed the safe integer range: ${runId}/${task.task_id}`);
					}
					this.database
						.prepare(
							"UPDATE dag_tasks SET usage_json = ?, turns = ? WHERE run_id = ? AND task_id = ? AND status = 'running'",
						)
						.run(encode(taskUsage), taskTurns, runId, task.task_id);
				}
				this.database
					.prepare(
						`UPDATE dag_attempts
						 SET status = 'failed', terminal_reason = ?, error = ?, updated_at = ?
						 WHERE run_id = ? AND status = 'running'
						   AND EXISTS (SELECT 1 FROM dag_runs run WHERE run.run_id = dag_attempts.run_id AND run.status = ?)`,
					)
					.run(terminalReason, error, now, runId, row.status);
				this.database
					.prepare(
						`UPDATE dag_tasks
						 SET status = ?, current_attempt_id = NULL, owner_id = NULL, lease_expires_at = NULL,
						     retry_not_before = NULL, terminal_reason = ?, error = ?, artifact_json = NULL, updated_at = ?
						 WHERE run_id = ? AND status IN ('pending', 'running')
						   AND EXISTS (SELECT 1 FROM dag_runs run WHERE run.run_id = dag_tasks.run_id AND run.status = ?)`,
					)
					.run(taskStatus, terminalReason, error, now, runId, row.status);
				for (const task of fencedTasks) {
					this.insertDagEvent(
						runId,
						`task.${taskStatus}`,
						{ status: taskStatus, terminalReason, error, reason: "run_terminal" },
						now,
						task.task_id,
					);
				}
			}

			if (nextStatus === "failed" || nextStatus === "cancelled") {
				this.reconcileDagRunAccountingInTransaction(runId, now);
			}
			const terminalPausedDuration =
				row.paused_at === null ? row.paused_duration_ms : row.paused_duration_ms + Math.max(0, now - row.paused_at);
			if (!Number.isSafeInteger(terminalPausedDuration)) {
				throw new Error(`Paused duration exceeds the safe integer range: ${runId}`);
			}
			const result = this.database
				.prepare(
					`UPDATE dag_runs
					 SET status = ?, updated_at = ?,
					     owner_id = CASE WHEN ? THEN NULL ELSE owner_id END,
					     run_lease_expires_at = CASE WHEN ? THEN NULL ELSE run_lease_expires_at END,
					     paused_at = CASE WHEN ? THEN NULL ELSE paused_at END,
					     paused_duration_ms = CASE WHEN ? THEN ? ELSE paused_duration_ms END
					 WHERE run_id = ? AND status = ?`,
				)
				.run(
					nextStatus,
					now,
					terminal ? 1 : 0,
					terminal ? 1 : 0,
					terminal ? 1 : 0,
					terminal ? 1 : 0,
					terminalPausedDuration,
					runId,
					row.status,
				);
			if (result.changes !== 1) throw new Error(`Concurrent DAG run transition detected: ${runId}`);
			this.insertDagEvent(runId, "run.transition", { from: row.status, to: nextStatus }, now);
		});
	}

	setDagRunUsage(runId: string, usage: Usage, now = Date.now(), lease?: DagRunLease, turns = 0): void {
		this.ensureOpen();
		const persisted = cloneUsage(usage);
		if (!Number.isSafeInteger(turns) || turns < 0)
			throw new Error("DAG run turns must be a non-negative safe integer");
		this.transaction(() => {
			const row = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, row, now, lease);
			const result = this.database
				.prepare("UPDATE dag_runs SET usage_json = ?, turns = ?, updated_at = ? WHERE run_id = ?")
				.run(encode(persisted), turns, now, runId);
			if (result.changes !== 1) throw new Error(`Unknown DAG run: ${runId}`);
			this.insertDagEvent(runId, "run.usage", { usage: persisted, turns }, now);
		});
	}

	reconcileDagRunAccounting(runId: string, now = Date.now(), lease?: DagRunLease): { usage: Usage; turns: number } {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		return this.transaction(() => {
			const run = this.database
				.prepare(
					"SELECT status, owner_id, owner_epoch, run_lease_expires_at, usage_json, turns FROM dag_runs WHERE run_id = ?",
				)
				.get(runId) as (DagRunOwnershipRow & { usage_json: string; turns: number }) | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			return this.reconcileDagRunAccountingInTransaction(runId, now);
		});
	}

	claimRunnableTasks(
		runId: string,
		ownerId: string,
		now: number,
		leaseDurationMs: number,
		limit: number,
		lease?: DagRunLease,
	): DagTaskClaim[] {
		this.ensureOpen();
		if (!ownerId) throw new Error("ownerId is required");
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
			throw new Error("leaseDurationMs must be a positive safe integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("claim limit must be a positive safe integer");
		const leaseExpiresAt = now + leaseDurationMs;
		if (!Number.isSafeInteger(leaseExpiresAt)) throw new Error("lease expiry exceeds the safe integer range");

		return this.transaction(() => {
			const run = this.database
				.prepare(
					"SELECT status, owner_id, owner_epoch, run_lease_expires_at, paused_at FROM dag_runs WHERE run_id = ?",
				)
				.get(runId) as (DagRunOwnershipRow & { paused_at: number | null }) | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			if (run.status !== "running" || run.paused_at !== null) return [];
			const rows = (
				this.database
					.prepare(
						`SELECT task.*
						 FROM dag_tasks task
						 WHERE task.run_id = ? AND task.status = 'pending'
						   AND (task.retry_not_before IS NULL OR task.retry_not_before <= ?)
						   AND NOT EXISTS (
						     SELECT 1
						     FROM dag_dependencies dependency
						     JOIN dag_tasks prerequisite
						       ON prerequisite.run_id = dependency.run_id
						      AND prerequisite.task_id = dependency.dependency_task_id
						     WHERE dependency.run_id = task.run_id
						       AND dependency.task_id = task.task_id
						       AND prerequisite.status <> 'succeeded'
						   )
						 ORDER BY task.task_order`,
					)
					.all(runId, now) as unknown as DagTaskRow[]
			)
				.filter(
					(row) =>
						row.attempt_count < row.max_attempts ||
						isControllerResumableCheckpoint(row.checkpoint_json, row.role),
				)
				.slice(0, limit);
			const claims: DagTaskClaim[] = [];
			for (const row of rows) {
				const resumed = isControllerResumableCheckpoint(row.checkpoint_json, row.role) && row.attempt_count > 0;
				const availabilityRetry = isAvailabilityRetryCheckpoint(row.checkpoint_json);
				const priorAttempt = resumed
					? (this.database
							.prepare(
								`SELECT attempt.attempt_id, attempt.runtime_json, journal.journal_path
								 FROM dag_attempts attempt
								 LEFT JOIN dag_external_mutation_journals journal ON journal.attempt_id = attempt.attempt_id
								 WHERE attempt.run_id = ? AND attempt.task_id = ?
								   AND attempt.attempt_number = ? AND attempt.status = 'expired'`,
							)
							.get(runId, row.task_id, row.attempt_count) as
							| { attempt_id: string; runtime_json: string | null; journal_path: string | null }
							| undefined)
					: undefined;
				if (resumed && !priorAttempt)
					throw new Error(`Interrupted DAG attempt is not recoverable: ${runId}/${row.task_id}`);
				const attemptId = priorAttempt?.attempt_id ?? randomUUID();
				const attemptNumber = resumed ? row.attempt_count : row.attempt_count + 1;
				const priorRuntime = priorAttempt?.runtime_json
					? decode<ChildRuntimeMetadata>(priorAttempt.runtime_json)
					: undefined;
				const result = this.database
					.prepare(
						`UPDATE dag_tasks
						 SET status = 'running', attempt_count = ?, current_attempt_id = ?, owner_id = ?,
						     lease_expires_at = ?, retry_not_before = NULL, terminal_reason = NULL, error = NULL, updated_at = ?
						 WHERE run_id = ? AND task_id = ? AND status = 'pending' AND attempt_count = ?
						   AND (retry_not_before IS NULL OR retry_not_before <= ?)
						   AND EXISTS (
						     SELECT 1 FROM dag_runs run
						     WHERE run.run_id = dag_tasks.run_id AND run.status = 'running' AND run.paused_at IS NULL
						   )`,
					)
					.run(attemptNumber, attemptId, ownerId, leaseExpiresAt, now, runId, row.task_id, row.attempt_count, now);
				if (result.changes !== 1) throw new Error(`Concurrent DAG task claim detected: ${runId}/${row.task_id}`);
				if (resumed) {
					const resumedAttempt = this.database
						.prepare(
							`UPDATE dag_attempts
							 SET owner_id = ?, status = 'running', lease_expires_at = ?, terminal_reason = NULL,
							     error = NULL, updated_at = ?
							 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND attempt_number = ? AND status = 'expired'`,
						)
						.run(ownerId, leaseExpiresAt, now, attemptId, runId, row.task_id, attemptNumber);
					if (resumedAttempt.changes !== 1)
						throw new Error(`Concurrent DAG attempt resume detected: ${runId}/${row.task_id}`);
				} else {
					this.database
						.prepare(
							`INSERT INTO dag_attempts
							 (attempt_id, run_id, task_id, attempt_number, owner_id, status, lease_expires_at,
							  checkpoint_json, usage_json, created_at, updated_at)
							 VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
						)
						.run(
							attemptId,
							runId,
							row.task_id,
							attemptNumber,
							ownerId,
							leaseExpiresAt,
							row.checkpoint_json,
							encode(ZERO_USAGE),
							now,
							now,
						);
				}
				const contract = decode<DagTaskContract>(row.contract_json);
				const claim: DagTaskClaim = {
					runId,
					taskId: row.task_id,
					role: contract.role,
					contract,
					attemptId,
					attemptNumber,
					ownerId,
					leaseExpiresAt,
					checkpoint: row.checkpoint_json ? decode<unknown>(row.checkpoint_json) : undefined,
					// Availability retries start a fresh Child/root because the prior root
					// is normally cleaned after a model error. Preserve only a sanitized
					// seed so the replacement runtime advances the same attempt generation.
					...(priorRuntime
						? { runtime: availabilityRetry ? freshRuntimeGenerationSeed(priorRuntime) : priorRuntime }
						: {}),
					...(priorAttempt?.journal_path ? { externalMutationJournalPath: priorAttempt.journal_path } : {}),
				};
				claims.push(claim);
				this.insertDagEvent(
					runId,
					"task.claimed",
					{ attemptId, attemptNumber, ownerId, leaseExpiresAt, resumed },
					now,
					row.task_id,
				);
			}
			if (claims.length > 0) {
				this.database
					.prepare("UPDATE dag_runs SET updated_at = ? WHERE run_id = ? AND status = 'running'")
					.run(now, runId);
			}
			return claims;
		});
	}

	nextDagRetryAt(runId: string): number | undefined {
		return this.nextDagTaskEligibility(runId, "").retryAt;
	}

	nextDagTaskEligibility(runId: string, ownerId: string): DagTaskEligibility {
		this.ensureOpen();
		return this.readTransaction(() => {
			const retry = this.database
				.prepare(
					`SELECT MIN(task.retry_not_before) AS retry_at
					 FROM dag_tasks task
					 JOIN dag_runs run ON run.run_id = task.run_id
					 WHERE task.run_id = ? AND task.status = 'pending' AND task.retry_not_before IS NOT NULL
					   AND run.status = 'running' AND run.paused_at IS NULL
					   AND NOT EXISTS (
					     SELECT 1
					     FROM dag_dependencies dependency
					     JOIN dag_tasks prerequisite
					       ON prerequisite.run_id = dependency.run_id
					      AND prerequisite.task_id = dependency.dependency_task_id
					     WHERE dependency.run_id = task.run_id
					       AND dependency.task_id = task.task_id
					       AND prerequisite.status <> 'succeeded'
					   )`,
				)
				.get(runId) as { retry_at: number | null } | undefined;
			const foreignLease = this.database
				.prepare(
					`SELECT MIN(task.lease_expires_at) AS lease_at
					 FROM dag_tasks task
					 JOIN dag_runs run ON run.run_id = task.run_id
					 WHERE task.run_id = ? AND task.status = 'running' AND task.lease_expires_at IS NOT NULL
					   AND task.owner_id IS NOT NULL AND task.owner_id <> ?
					   AND run.status = 'running' AND run.paused_at IS NULL`,
				)
				.get(runId, ownerId) as { lease_at: number | null } | undefined;
			return {
				...(retry?.retry_at === null || retry?.retry_at === undefined ? {} : { retryAt: retry.retry_at }),
				...(foreignLease?.lease_at === null || foreignLease?.lease_at === undefined
					? {}
					: { foreignLeaseAt: foreignLease.lease_at }),
			};
		});
	}

	heartbeatAttempt(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		now: number,
		leaseDurationMs: number,
		lease?: DagRunLease,
	): number {
		this.ensureOpen();
		if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
			throw new Error("leaseDurationMs must be a positive safe integer");
		}
		const leaseExpiresAt = now + leaseDurationMs;
		if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseExpiresAt)) {
			throw new Error("heartbeat timestamps must be safe integers");
		}
		return this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			const taskResult = this.database
				.prepare(
					`UPDATE dag_tasks SET lease_expires_at = ?, updated_at = ?
					 WHERE run_id = ? AND task_id = ? AND status = 'running'
					   AND current_attempt_id = ? AND owner_id = ? AND lease_expires_at > ?
					   AND EXISTS (SELECT 1 FROM dag_runs run WHERE run.run_id = dag_tasks.run_id AND run.status = 'running')`,
				)
				.run(leaseExpiresAt, now, runId, taskId, attemptId, ownerId, now);
			if (taskResult.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			const attemptResult = this.database
				.prepare(
					`UPDATE dag_attempts SET lease_expires_at = ?, updated_at = ?
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'
					   AND EXISTS (SELECT 1 FROM dag_runs run WHERE run.run_id = dag_attempts.run_id AND run.status = 'running')`,
				)
				.run(leaseExpiresAt, now, attemptId, runId, taskId, ownerId);
			if (attemptResult.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			this.insertDagEvent(runId, "attempt.heartbeat", { attemptId, ownerId, leaseExpiresAt }, now, taskId);
			return leaseExpiresAt;
		});
	}

	checkpointAttempt(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		checkpoint: unknown,
		now = Date.now(),
		lease?: DagRunLease,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		const checkpointJson = encode(checkpoint);
		this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			const taskResult = this.database
				.prepare(
					`UPDATE dag_tasks SET checkpoint_json = ?, updated_at = ?
					 WHERE run_id = ? AND task_id = ? AND status = 'running'
					   AND current_attempt_id = ? AND owner_id = ? AND lease_expires_at > ?
					   AND EXISTS (SELECT 1 FROM dag_runs run WHERE run.run_id = dag_tasks.run_id AND run.status = 'running')`,
				)
				.run(checkpointJson, now, runId, taskId, attemptId, ownerId, now);
			if (taskResult.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			const attemptResult = this.database
				.prepare(
					`UPDATE dag_attempts SET checkpoint_json = ?, updated_at = ?
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'
					   AND EXISTS (SELECT 1 FROM dag_runs run WHERE run.run_id = dag_attempts.run_id AND run.status = 'running')`,
				)
				.run(checkpointJson, now, attemptId, runId, taskId, ownerId);
			if (attemptResult.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			this.insertDagEvent(runId, "attempt.checkpoint", { attemptId, checkpoint }, now, taskId);
		});
	}

	openDagProviderCircuit(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		signal: ProviderCircuitOpenSignal,
		usage: Usage,
		turns: number,
		retryNotBefore: number,
		now = Date.now(),
		lease?: DagRunLease,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now) || !Number.isSafeInteger(retryNotBefore) || retryNotBefore < now) {
			throw new Error("Provider circuit timestamps are invalid");
		}
		if (!Number.isSafeInteger(turns) || turns < 0) {
			throw new Error("Provider circuit turns must be a non-negative safe integer");
		}
		const persistedSignal = normalizedProviderCircuitSignal(signal);
		if (retryNotBefore - now !== persistedSignal.retryDelayMs) {
			throw new Error("Provider circuit retry delay does not match its eligibility");
		}
		const persistedUsage = cloneUsage(usage);
		const checkpoint = {
			version: 1,
			phase: "provider_circuit_open",
			providerCircuitOpen: persistedSignal,
			retryNotBefore,
			attemptUsage: persistedUsage,
			attemptTurns: turns,
		};
		const checkpointJson = encode(checkpoint);
		this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			const current = this.database
				.prepare(
					`SELECT attempt.usage_json, attempt.turns, task.role
					 FROM dag_attempts attempt
					 JOIN dag_tasks task ON task.run_id = attempt.run_id AND task.task_id = attempt.task_id
					 WHERE attempt.attempt_id = ? AND attempt.run_id = ? AND attempt.task_id = ?
					   AND attempt.owner_id = ? AND attempt.status = 'running'`,
				)
				.get(attemptId, runId, taskId, ownerId) as
				| { usage_json: string; turns: number; role: SubagentRole }
				| undefined;
			if (!current) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			if (current.role === "external-writer") {
				throw new Error("Provider circuit pause is unsafe for an external-writer attempt");
			}
			if (!usageAtLeast(persistedUsage, decode<Usage>(current.usage_json)) || turns < current.turns) {
				throw new Error(`DAG attempt accounting regressed: ${runId}/${taskId}/${attemptId}`);
			}
			const taskResult = this.database
				.prepare(
					`UPDATE dag_tasks
					 SET checkpoint_json = ?, retry_not_before = ?, updated_at = ?
					 WHERE run_id = ? AND task_id = ? AND status = 'running'
					   AND current_attempt_id = ? AND owner_id = ? AND lease_expires_at > ?
					   AND EXISTS (SELECT 1 FROM dag_runs run WHERE run.run_id = dag_tasks.run_id AND run.status = 'running')`,
				)
				.run(checkpointJson, retryNotBefore, now, runId, taskId, attemptId, ownerId, now);
			if (taskResult.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			const attemptResult = this.database
				.prepare(
					`UPDATE dag_attempts
					 SET checkpoint_json = ?, usage_json = ?, turns = ?, updated_at = ?
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'`,
				)
				.run(checkpointJson, encode(persistedUsage), turns, now, attemptId, runId, taskId, ownerId);
			if (attemptResult.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			this.reconcileDagRunAccountingInTransaction(runId, now);
			this.insertDagEvent(
				runId,
				"provider.circuit_open",
				{
					attemptId,
					retryNotBefore,
					reason: persistedSignal.reason,
					autoRetryAttempt: persistedSignal.autoRetryAttempt,
					consecutiveUnlimitedRetries: persistedSignal.consecutiveUnlimitedRetries,
					retryDelayMs: persistedSignal.retryDelayMs,
				},
				now,
				taskId,
			);
		});
	}

	recordDagAttemptAccounting(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		usage: Usage,
		turns: number,
		now = Date.now(),
		lease?: DagRunLease,
	): boolean {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		if (!Number.isSafeInteger(turns) || turns < 0) {
			throw new Error("DAG attempt turns must be a non-negative safe integer");
		}
		const persistedUsage = cloneUsage(usage);
		return this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			const current = this.database
				.prepare(
					`SELECT usage_json, turns FROM dag_attempts
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'`,
				)
				.get(attemptId, runId, taskId, ownerId) as { usage_json: string; turns: number } | undefined;
			if (!current) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			const previousUsage = decode<Usage>(current.usage_json);
			if (!usageAtLeast(persistedUsage, previousUsage) || turns < current.turns) {
				throw new Error(`DAG attempt accounting regressed: ${runId}/${taskId}/${attemptId}`);
			}
			const usageJson = encode(persistedUsage);
			if (usageJson === current.usage_json && turns === current.turns) return false;
			const result = this.database
				.prepare(
					`UPDATE dag_attempts SET usage_json = ?, turns = ?, updated_at = ?
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'`,
				)
				.run(usageJson, turns, now, attemptId, runId, taskId, ownerId);
			if (result.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			this.insertDagEvent(runId, "attempt.accounting", { attemptId, usage: persistedUsage, turns }, now, taskId);
			return true;
		});
	}

	recordDagAttemptRuntime(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		runtime: ChildRuntimeMetadata,
		now = Date.now(),
		lease?: DagRunLease,
		force = false,
	): boolean {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		if (!Number.isSafeInteger(runtime.runtimeGeneration) || runtime.runtimeGeneration < 1) {
			throw new Error("Child runtime generation must be a positive safe integer");
		}
		if (!Number.isSafeInteger(runtime.lastEventSeq) || runtime.lastEventSeq < 0) {
			throw new Error("Child runtime event sequence must be a non-negative safe integer");
		}
		const runtimeJson = encode(runtime);
		const highWatermarkKey = `${runId}\0${taskId}\0${attemptId}`;
		return this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			const current = this.database
				.prepare(
					`SELECT runtime_json FROM dag_attempts
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'`,
				)
				.get(attemptId, runId, taskId, ownerId) as { runtime_json: string | null } | undefined;
			if (!current) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			const persisted = current.runtime_json ? decode<ChildRuntimeMetadata>(current.runtime_json) : undefined;
			const inMemory = this.runtimeHighWatermarks.get(highWatermarkKey);
			const previous =
				inMemory ??
				(persisted ? { generation: persisted.runtimeGeneration, sequence: persisted.lastEventSeq } : undefined);
			if (
				previous &&
				(runtime.runtimeGeneration < previous.generation ||
					(runtime.runtimeGeneration === previous.generation && runtime.lastEventSeq < previous.sequence))
			) {
				throw new Error(`Stale child runtime metadata: ${runId}/${taskId}/${attemptId}`);
			}
			this.runtimeHighWatermarks.set(highWatermarkKey, {
				generation: runtime.runtimeGeneration,
				sequence: runtime.lastEventSeq,
			});
			const shouldPersist =
				force ||
				!persisted ||
				runtime.runtimeGeneration > persisted.runtimeGeneration ||
				(runtime.runtimeGeneration === persisted.runtimeGeneration &&
					runtime.lastEventSeq - persisted.lastEventSeq >= RUNTIME_METADATA_PERSIST_INTERVAL);
			if (!shouldPersist || current.runtime_json === runtimeJson) return false;
			const result = this.database
				.prepare(
					`UPDATE dag_attempts SET runtime_json = ?, updated_at = ?
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'`,
				)
				.run(runtimeJson, now, attemptId, runId, taskId, ownerId);
			if (result.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			this.insertDagEvent(
				runId,
				"attempt.runtime",
				{
					attemptId,
					provider: runtime.provider,
					model: runtime.model,
					thinkingLevel: runtime.thinkingLevel,
					isolationLevel: runtime.isolationLevel,
					sessionId: runtime.sessionId,
					runtimeGeneration: runtime.runtimeGeneration,
					lastEventSeq: runtime.lastEventSeq,
					isStreaming: runtime.isStreaming,
					pendingMessageCount: runtime.pendingMessageCount,
					activity: runtime.activity,
					nextAction: runtime.nextAction,
					forced: force,
				},
				now,
				taskId,
			);
			return true;
		});
	}

	registerDagExternalMutationJournal(
		policy: ExternalMutationJournalPolicy,
		ownerId: string,
		now = Date.now(),
		lease?: DagRunLease,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		if (!policy.path || policy.path.includes("\0")) throw new Error("External mutation journal path is invalid");
		this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(policy.runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${policy.runId}`);
			this.assertDagRunMutationLease(policy.runId, run, now, lease);
			const attempt = this.database
				.prepare(
					`SELECT attempt.attempt_number, task.contract_json
					 FROM dag_attempts attempt
					 JOIN dag_tasks task ON task.run_id = attempt.run_id AND task.task_id = attempt.task_id
					 WHERE attempt.attempt_id = ? AND attempt.run_id = ? AND attempt.task_id = ?
					   AND attempt.owner_id = ? AND attempt.status = 'running'`,
				)
				.get(policy.attemptId, policy.runId, policy.taskId, ownerId) as
				| { attempt_number: number; contract_json: string }
				| undefined;
			if (!attempt) throw new Error(`Stale DAG attempt: ${policy.runId}/${policy.taskId}/${policy.attemptId}`);
			const contract = decode<DagTaskContract>(attempt.contract_json);
			if (contract.role !== "external-writer" || attempt.attempt_number !== policy.attemptNumber) {
				throw new Error("External mutation journals are restricted to their external-writer attempt");
			}
			const existing = this.database
				.prepare("SELECT * FROM dag_external_mutation_journals WHERE attempt_id = ?")
				.get(policy.attemptId) as ExternalMutationJournalRow | undefined;
			if (existing) {
				if (
					existing.run_id !== policy.runId ||
					existing.task_id !== policy.taskId ||
					existing.journal_path !== policy.path
				) {
					throw new Error(`External mutation journal is immutable: ${policy.attemptId}`);
				}
				return;
			}
			this.database
				.prepare(
					`INSERT INTO dag_external_mutation_journals
					 (attempt_id, run_id, task_id, journal_path, consumed_sequence, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 0, ?, ?)`,
				)
				.run(policy.attemptId, policy.runId, policy.taskId, policy.path, now, now);
			this.insertDagEvent(
				policy.runId,
				"external_mutation.journal_ready",
				{ attemptId: policy.attemptId, attemptNumber: policy.attemptNumber },
				now,
				policy.taskId,
			);
		});
	}

	recordDagExternalMutationEvent(
		policy: ExternalMutationJournalPolicy,
		event: ExternalMutationJournalEvent,
		ownerId: string | undefined,
		now = Date.now(),
		lease?: DagRunLease,
	): boolean {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		return this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(policy.runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${policy.runId}`);
			this.assertDagRunMutationLease(policy.runId, run, now, lease);
			const attempt = this.database
				.prepare(
					`SELECT attempt_number, owner_id, status FROM dag_attempts
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ?`,
				)
				.get(policy.attemptId, policy.runId, policy.taskId) as
				| { attempt_number: number; owner_id: string; status: DagAttemptRecord["status"] }
				| undefined;
			if (
				!attempt ||
				attempt.attempt_number !== policy.attemptNumber ||
				(attempt.status === "running" ? ownerId !== attempt.owner_id : ownerId !== undefined)
			) {
				throw new Error(`Stale DAG attempt: ${policy.runId}/${policy.taskId}/${policy.attemptId}`);
			}
			const journal = this.database
				.prepare("SELECT * FROM dag_external_mutation_journals WHERE attempt_id = ?")
				.get(policy.attemptId) as ExternalMutationJournalRow | undefined;
			if (
				!journal ||
				journal.run_id !== policy.runId ||
				journal.task_id !== policy.taskId ||
				journal.journal_path !== policy.path
			) {
				throw new Error(`Unknown external mutation journal: ${policy.attemptId}`);
			}
			if (!Number.isSafeInteger(event.journalSequence) || event.journalSequence < 1) {
				throw new Error("External mutation journal sequence is invalid");
			}

			const existingMutation =
				event.type === "authorized"
					? (this.database
							.prepare("SELECT * FROM dag_external_mutations WHERE mutation_id = ?")
							.get(event.mutation.mutationId) as ExternalMutationRow | undefined)
					: (this.database
							.prepare("SELECT * FROM dag_external_mutations WHERE mutation_id = ?")
							.get(event.mutationId) as ExternalMutationRow | undefined);
			if (event.journalSequence <= journal.consumed_sequence) {
				if (!existingMutation) throw new Error("Consumed external mutation event has no durable record");
				if (event.type === "authorized") {
					const persisted = externalMutationFromRow(existingMutation);
					const authorized = { ...persisted, toolResult: undefined, observedAt: undefined, postState: undefined };
					if (encode(authorized) !== encode(event.mutation)) {
						throw new Error(`External mutation replay differs: ${event.mutation.mutationId}`);
					}
				} else if (
					existingMutation.tool_result !== event.toolResult ||
					existingMutation.observed_at !== event.observedAt ||
					existingMutation.post_state_json !== encode(event.postState)
				) {
					throw new Error(`External mutation observation replay differs: ${event.mutationId}`);
				}
				return false;
			}
			if (journal.released_at !== null) {
				throw new Error(`External mutation journal is already released: ${policy.attemptId}`);
			}
			if (event.journalSequence !== journal.consumed_sequence + 1) {
				throw new Error(`External mutation journal event gap: ${policy.attemptId}`);
			}

			if (event.type === "authorized") {
				const mutation = event.mutation;
				if (
					mutation.runId !== policy.runId ||
					mutation.taskId !== policy.taskId ||
					mutation.attemptId !== policy.attemptId ||
					mutation.attemptNumber !== policy.attemptNumber ||
					mutation.authorizationStatus !== "authorized"
				) {
					throw new Error("External mutation event identity differs from its journal");
				}
				if (existingMutation) throw new Error(`External mutation ID is duplicated: ${mutation.mutationId}`);
				this.database
					.prepare(
						`INSERT INTO dag_external_mutations
						 (mutation_id, run_id, task_id, attempt_id, attempt_number, authorization_sequence,
						  tool_call_id, operation, canonical_path, authorized_at, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						mutation.mutationId,
						mutation.runId,
						mutation.taskId,
						mutation.attemptId,
						mutation.attemptNumber,
						mutation.authorizationSequence,
						mutation.toolCallId,
						mutation.operation,
						mutation.path,
						mutation.authorizedAt,
						now,
						now,
					);
				this.insertDagEvent(policy.runId, "external_mutation.authorized", mutation, now, policy.taskId);
			} else {
				if (!existingMutation)
					throw new Error(`External mutation observation has no authorization: ${event.mutationId}`);
				if (existingMutation.tool_result !== null) {
					throw new Error(`External mutation already has a post-state observation: ${event.mutationId}`);
				}
				const result = this.database
					.prepare(
						`UPDATE dag_external_mutations
						 SET tool_result = ?, observed_at = ?, post_state_json = ?, updated_at = ?
						 WHERE mutation_id = ? AND attempt_id = ? AND tool_result IS NULL`,
					)
					.run(
						event.toolResult,
						event.observedAt,
						encode(event.postState),
						now,
						event.mutationId,
						policy.attemptId,
					);
				if (result.changes !== 1) throw new Error(`Concurrent external mutation observation: ${event.mutationId}`);
				this.insertDagEvent(
					policy.runId,
					"external_mutation.observed",
					{
						attemptId: policy.attemptId,
						mutationId: event.mutationId,
						toolResult: event.toolResult,
						postState: event.postState,
					},
					now,
					policy.taskId,
				);
			}
			const advanced = this.database
				.prepare(
					`UPDATE dag_external_mutation_journals SET consumed_sequence = ?, updated_at = ?
					 WHERE attempt_id = ? AND consumed_sequence = ?`,
				)
				.run(event.journalSequence, now, policy.attemptId, journal.consumed_sequence);
			if (advanced.changes !== 1)
				throw new Error(`Concurrent external mutation journal update: ${policy.attemptId}`);
			return true;
		});
	}

	listOpenDagExternalMutationJournals(runId: string): DagExternalMutationJournalSource[] {
		this.ensureOpen();
		return this.readTransaction(() => {
			const rows = this.database
				.prepare(
					`SELECT journal.*, attempt.attempt_number, attempt.status AS attempt_status
					 FROM dag_external_mutation_journals journal
					 JOIN dag_attempts attempt ON attempt.attempt_id = journal.attempt_id
					 WHERE journal.run_id = ? AND journal.released_at IS NULL
					 ORDER BY attempt.attempt_number, journal.task_id, journal.attempt_id`,
				)
				.all(runId) as unknown as Array<
				ExternalMutationJournalRow & {
					attempt_number: number;
					attempt_status: DagAttemptRecord["status"];
				}
			>;
			return rows.map((row) => ({
				policy: {
					version: 1,
					path: row.journal_path,
					runId: row.run_id,
					taskId: row.task_id,
					attemptId: row.attempt_id,
					attemptNumber: row.attempt_number,
				},
				attemptStatus: row.attempt_status,
				consumedSequence: row.consumed_sequence,
			}));
		});
	}

	releaseDagExternalMutationJournal(
		policy: ExternalMutationJournalPolicy,
		ownerId: string | undefined,
		now = Date.now(),
		lease?: DagRunLease,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(policy.runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${policy.runId}`);
			this.assertDagRunMutationLease(policy.runId, run, now, lease);
			const attempt = this.database
				.prepare(
					`SELECT attempt_number, owner_id, status FROM dag_attempts
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ?`,
				)
				.get(policy.attemptId, policy.runId, policy.taskId) as
				| { attempt_number: number; owner_id: string; status: DagAttemptRecord["status"] }
				| undefined;
			if (
				!attempt ||
				attempt.attempt_number !== policy.attemptNumber ||
				(attempt.status === "running" ? ownerId !== attempt.owner_id : ownerId !== undefined)
			) {
				throw new Error(`Stale DAG attempt: ${policy.runId}/${policy.taskId}/${policy.attemptId}`);
			}
			const journal = this.database
				.prepare("SELECT * FROM dag_external_mutation_journals WHERE attempt_id = ?")
				.get(policy.attemptId) as ExternalMutationJournalRow | undefined;
			if (
				!journal ||
				journal.run_id !== policy.runId ||
				journal.task_id !== policy.taskId ||
				journal.journal_path !== policy.path
			) {
				throw new Error(`Unknown external mutation journal: ${policy.attemptId}`);
			}
			if (journal.released_at !== null) return;
			const result = this.database
				.prepare(
					`UPDATE dag_external_mutation_journals SET released_at = ?, updated_at = ?
					 WHERE attempt_id = ? AND released_at IS NULL`,
				)
				.run(now, now, policy.attemptId);
			if (result.changes !== 1) throw new Error(`Concurrent external mutation journal release: ${policy.attemptId}`);
			this.insertDagEvent(
				policy.runId,
				"external_mutation.journal_released",
				{ attemptId: policy.attemptId, consumedSequence: journal.consumed_sequence },
				now,
				policy.taskId,
			);
		});
	}

	recordDagTaskControl(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		operation: "message" | "follow_up" | "interrupt",
		message: string | undefined,
		accepted: boolean,
		now = Date.now(),
		lease?: DagRunLease,
		error?: string,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			const active = this.database
				.prepare(
					`SELECT 1 AS present FROM dag_attempts
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'`,
				)
				.get(attemptId, runId, taskId, ownerId) as { present: number } | undefined;
			if (!active) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			this.insertDagEvent(
				runId,
				"task.control",
				{
					attemptId,
					operation,
					accepted,
					...(message === undefined ? {} : { message }),
					...(error === undefined ? {} : { error: boundedDiagnostic(error) }),
				},
				now,
				taskId,
			);
		});
	}

	completeDagTask(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		completion: DagTaskCompletion,
		now = Date.now(),
		lease?: DagRunLease,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		this.transaction(() => {
			const completedArtifact = completion.artifact;
			const rawTerminalReason = (completion as { terminalReason?: TaskTerminalReason }).terminalReason;
			if (completedArtifact === undefined && (!rawTerminalReason || rawTerminalReason === "completed")) {
				throw new Error("A failed DAG task requires a non-completed terminalReason");
			}
			const row = this.database
				.prepare(
					`SELECT task.status, task.current_attempt_id, task.owner_id, task.lease_expires_at,
					        task.contract_json, task.checkpoint_json, task.artifact_json, task.usage_json,
					        task.turns, task.attempt_count, task.max_attempts, run.status AS run_status,
					        run.owner_id AS run_owner_id,
					        run.owner_epoch, run.run_lease_expires_at
					 FROM dag_tasks task
					 JOIN dag_runs run ON run.run_id = task.run_id
					 WHERE task.run_id = ? AND task.task_id = ?`,
				)
				.get(runId, taskId) as
				| {
						status: DagTaskStatus;
						current_attempt_id: string | null;
						owner_id: string | null;
						lease_expires_at: number | null;
						contract_json: string;
						checkpoint_json: string | null;
						artifact_json: string | null;
						usage_json: string;
						turns: number;
						attempt_count: number;
						max_attempts: number;
						run_status: RunStatus;
						run_owner_id: string | null;
						owner_epoch: number;
						run_lease_expires_at: number | null;
				  }
				| undefined;
			if (!row) throw new Error(`Unknown DAG task: ${runId}/${taskId}`);
			this.assertDagRunMutationLease(
				runId,
				{
					status: row.run_status,
					owner_id: row.run_owner_id,
					owner_epoch: row.owner_epoch,
					run_lease_expires_at: row.run_lease_expires_at,
				},
				now,
				lease,
			);
			const priorAttempt = this.database
				.prepare(
					`SELECT status, terminal_reason, error, usage_json, turns
					 FROM dag_attempts
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ?`,
				)
				.get(attemptId, runId, taskId, ownerId) as
				| {
						status: string;
						terminal_reason: string | null;
						error: string | null;
						usage_json: string;
						turns: number;
				  }
				| undefined;
			if (!priorAttempt) throw new Error(`Unknown DAG attempt: ${runId}/${taskId}/${attemptId}`);
			const contract = decode<DagTaskContract>(row.contract_json);
			const failure = completedArtifact === undefined ? (completion as DagTaskCompletionFailure) : undefined;
			const retryDecision = failure ? decideRetry({ reason: rawTerminalReason, error: failure.error }) : undefined;
			const availabilityRetry =
				contract.role !== "external-writer" &&
				retryDecision?.shouldRetry === true &&
				retryDecision.unlimited === true;
			if (row.status === "succeeded") {
				if (
					completedArtifact !== undefined &&
					row.current_attempt_id === attemptId &&
					row.owner_id === ownerId &&
					row.artifact_json === encode(completedArtifact) &&
					(completion.usage === undefined || priorAttempt.usage_json === encode(cloneUsage(completion.usage))) &&
					(completion.turns === undefined || priorAttempt.turns === completion.turns)
				) {
					return;
				}
				throw new Error(`Succeeded DAG task is immutable: ${runId}/${taskId}`);
			}
			if (failure) {
				if (
					priorAttempt.status === "failed" &&
					priorAttempt.terminal_reason === rawTerminalReason &&
					priorAttempt.error === (failure.error ?? null) &&
					(completion.usage === undefined || priorAttempt.usage_json === encode(cloneUsage(completion.usage))) &&
					(completion.turns === undefined || priorAttempt.turns === completion.turns)
				) {
					return;
				}
				if (
					availabilityRetry &&
					row.status === "pending" &&
					priorAttempt.status === "expired" &&
					isAvailabilityRetryCheckpoint(row.checkpoint_json)
				) {
					return;
				}
			}
			if (
				row.run_status !== "running" ||
				row.status !== "running" ||
				row.current_attempt_id !== attemptId ||
				row.owner_id !== ownerId ||
				row.lease_expires_at === null ||
				row.lease_expires_at <= now
			) {
				throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			}

			const previousAttemptUsage = decode<Usage>(priorAttempt.usage_json);
			const attemptUsage = cloneUsage(completion.usage ?? previousAttemptUsage);
			const attemptTurns = completion.turns ?? priorAttempt.turns;
			if (!Number.isSafeInteger(attemptTurns) || attemptTurns < priorAttempt.turns) {
				throw new Error(`DAG attempt turns regressed: ${runId}/${taskId}/${attemptId}`);
			}
			if (!usageAtLeast(attemptUsage, previousAttemptUsage)) {
				throw new Error(`DAG attempt usage regressed: ${runId}/${taskId}/${attemptId}`);
			}
			let status: TaskStatus;
			let terminalReason: TaskTerminalReason | null;
			let attemptTerminalReason: TaskTerminalReason;
			let error: string | undefined;
			let artifactJson: string | null;
			let currentAttemptId: string | null = attemptId;
			let currentOwnerId: string | null = ownerId;
			let retryNotBefore: number | null = null;
			let checkpointJson = row.checkpoint_json;
			let availabilityRetryNumber: number | undefined;
			if (completedArtifact !== undefined) {
				if (completedArtifact.artifactVersion !== TASK_ARTIFACT_VERSION) {
					throw new Error(`Task artifactVersion must be ${TASK_ARTIFACT_VERSION}`);
				}
				if (completedArtifact.taskId !== taskId) throw new Error("Task artifact taskId does not match the task");
				if (completedArtifact.contractHash !== contract.contractHash) {
					throw new Error("Task artifact contractHash does not match the task contract");
				}
				status = "succeeded";
				terminalReason = "completed";
				attemptTerminalReason = "completed";
				artifactJson = encode(completedArtifact);
			} else {
				attemptTerminalReason = rawTerminalReason as TaskTerminalReason;
				error = failure?.error;
				artifactJson = null;
				if (
					availabilityRetry ||
					(contract.role !== "external-writer" &&
						retryDecision?.shouldRetry &&
						row.attempt_count < row.max_attempts)
				) {
					status = "pending";
					terminalReason = null;
					currentAttemptId = null;
					currentOwnerId = null;
					if (availabilityRetry) {
						const priorAvailabilityRetries = this.database
							.prepare(
								`SELECT COUNT(*) AS retry_count FROM dag_events
								 WHERE run_id = ? AND task_id = ? AND event_type = 'task.requeued'
								   AND json_extract(payload_json, '$.reason') = 'availability_failure'`,
							)
							.get(runId, taskId) as { retry_count: number };
						availabilityRetryNumber = priorAvailabilityRetries.retry_count + 1;
						if (!Number.isSafeInteger(availabilityRetryNumber)) {
							throw new Error(`DAG availability retry count exceeds the safe integer range: ${runId}/${taskId}`);
						}
						checkpointJson = encode({
							version: 1,
							phase: "availability_retry",
							attemptUsage,
							attemptTurns,
						});
					}
					const delay = retryDelayMs(
						retryDecision!,
						availabilityRetryNumber ?? row.attempt_count,
						`${runId}\0${taskId}`,
					);
					retryNotBefore = delay === 0 ? null : now + delay;
					if (retryNotBefore !== null && !Number.isSafeInteger(retryNotBefore)) {
						throw new Error(`DAG retry eligibility exceeds the safe integer range: ${runId}/${taskId}`);
					}
				} else {
					status = attemptTerminalReason === "cancelled" ? "cancelled" : "failed";
					terminalReason = attemptTerminalReason;
				}
			}
			// Availability restarts are the same semantic attempt. Keep its cumulative
			// accounting in dag_attempts and fold it into the task exactly once when
			// that attempt finally succeeds or terminates for a non-availability reason.
			const taskUsage = availabilityRetry
				? decode<Usage>(row.usage_json)
				: addUsageValues(decode<Usage>(row.usage_json), attemptUsage);
			const taskTurns = availabilityRetry ? row.turns : row.turns + attemptTurns;
			const result = this.database
				.prepare(
					`UPDATE dag_tasks
					 SET status = ?, current_attempt_id = ?, owner_id = ?, lease_expires_at = NULL,
					     checkpoint_json = ?, retry_not_before = ?, terminal_reason = ?, error = ?, artifact_json = ?,
					     usage_json = ?, turns = ?, updated_at = ?
					 WHERE run_id = ? AND task_id = ? AND status = 'running'
					   AND current_attempt_id = ? AND owner_id = ? AND lease_expires_at > ?
					   AND EXISTS (SELECT 1 FROM dag_runs run WHERE run.run_id = dag_tasks.run_id AND run.status = 'running')`,
				)
				.run(
					status,
					currentAttemptId,
					currentOwnerId,
					checkpointJson,
					retryNotBefore,
					terminalReason,
					status === "pending" ? null : (error ?? null),
					artifactJson,
					encode(taskUsage),
					taskTurns,
					now,
					runId,
					taskId,
					attemptId,
					ownerId,
					now,
				);
			if (result.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			const attemptResult = this.database
				.prepare(
					`UPDATE dag_attempts
					 SET status = ?, checkpoint_json = ?, terminal_reason = ?, error = ?, usage_json = ?, turns = ?, updated_at = ?
					 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'
					   AND EXISTS (SELECT 1 FROM dag_runs run WHERE run.run_id = dag_attempts.run_id AND run.status = 'running')`,
				)
				.run(
					availabilityRetry ? "expired" : status === "succeeded" ? "succeeded" : "failed",
					checkpointJson,
					availabilityRetry ? null : attemptTerminalReason,
					availabilityRetry ? null : (error ?? null),
					encode(attemptUsage),
					attemptTurns,
					now,
					attemptId,
					runId,
					taskId,
					ownerId,
				);
			if (attemptResult.changes !== 1) throw new Error(`Stale DAG attempt: ${runId}/${taskId}/${attemptId}`);
			this.reconcileDagRunAccountingInTransaction(runId, now);
			this.runtimeHighWatermarks.delete(`${runId}\0${taskId}\0${attemptId}`);
			const runResult = this.database
				.prepare("UPDATE dag_runs SET updated_at = ? WHERE run_id = ? AND status = 'running'")
				.run(now, runId);
			if (runResult.changes !== 1) throw new Error(`DAG run is not running: ${runId}`);
			if (status === "pending") {
				this.insertDagEvent(
					runId,
					"task.requeued",
					availabilityRetry
						? {
								attemptId,
								attemptNumber: row.attempt_count,
								reason: "availability_failure",
								availabilityRetry: availabilityRetryNumber,
								retryNotBefore,
							}
						: {
								attemptId,
								attemptNumber: row.attempt_count,
								reason: "attempt_failed",
								terminalReason: attemptTerminalReason,
								error,
								usage: attemptUsage,
								turns: attemptTurns,
								retryNotBefore,
							},
					now,
					taskId,
				);
			} else {
				this.insertDagEvent(
					runId,
					"task.completed",
					{
						attemptId,
						ownerId,
						status,
						terminalReason,
						error,
						artifact: completedArtifact,
						usage: attemptUsage,
						turns: attemptTurns,
					},
					now,
					taskId,
				);
			}
			if (
				status === "failed" ||
				status === "cancelled" ||
				completedArtifact?.quality.semanticOutcome === "rejected" ||
				completedArtifact?.quality.semanticOutcome === "inconclusive"
			) {
				this.blockDagDescendants(runId, now);
			}
		});
	}

	recoverDagRun(runId: string, now: number, lease?: DagRunLease): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			if (run.status !== "running") return 0;
			const expired = this.database
				.prepare(
					`SELECT * FROM dag_tasks
					 WHERE run_id = ? AND status = 'running' AND lease_expires_at <= ?
					 ORDER BY task_order`,
				)
				.all(runId, now) as unknown as DagTaskRow[];
			for (const task of expired) {
				if (!task.current_attempt_id || !task.owner_id) {
					throw new Error(`Running DAG task has no active attempt: ${runId}/${task.task_id}`);
				}
				const attempt = this.database
					.prepare(
						`SELECT usage_json, turns FROM dag_attempts
						 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'`,
					)
					.get(task.current_attempt_id, runId, task.task_id, task.owner_id) as
					| { usage_json: string; turns: number }
					| undefined;
				if (!attempt) throw new Error(`Running DAG task has no active attempt: ${runId}/${task.task_id}`);
				const attemptResult = this.database
					.prepare(
						`UPDATE dag_attempts
						 SET status = 'expired', terminal_reason = 'interrupted', error = 'Attempt lease expired', updated_at = ?
						 WHERE attempt_id = ? AND run_id = ? AND task_id = ? AND owner_id = ? AND status = 'running'`,
					)
					.run(now, task.current_attempt_id, runId, task.task_id, task.owner_id);
				if (attemptResult.changes !== 1) {
					throw new Error(`Concurrent DAG attempt recovery detected: ${runId}/${task.task_id}`);
				}
				const resumable = isControllerResumableCheckpoint(task.checkpoint_json, task.role);
				const recoveredUsage = resumable
					? decode<Usage>(task.usage_json)
					: addUsageValues(decode<Usage>(task.usage_json), decode<Usage>(attempt.usage_json));
				const recoveredTurns = resumable ? task.turns : task.turns + attempt.turns;
				if (!Number.isSafeInteger(recoveredTurns)) {
					throw new Error(`DAG task turns exceed the safe integer range: ${runId}/${task.task_id}`);
				}
				const canStartNewAttempt = task.role !== "external-writer" && task.attempt_count < task.max_attempts;
				if (canStartNewAttempt || resumable) {
					const retryNotBefore = resumable
						? (providerCircuitRetryNotBefore(task.checkpoint_json) ?? null)
						: now +
							retryDelayMs(
								decideRetry({ reason: "interrupted", error: "Attempt lease expired" }),
								task.attempt_count,
								`${runId}\0${task.task_id}`,
							);
					if (retryNotBefore !== null && !Number.isSafeInteger(retryNotBefore)) {
						throw new Error(`DAG retry eligibility exceeds the safe integer range: ${runId}/${task.task_id}`);
					}
					const taskResult = this.database
						.prepare(
							`UPDATE dag_tasks
							 SET status = 'pending', current_attempt_id = NULL, owner_id = NULL,
							     lease_expires_at = NULL, retry_not_before = ?, terminal_reason = NULL, error = NULL,
							     usage_json = ?, turns = ?, updated_at = ?
							 WHERE run_id = ? AND task_id = ? AND status = 'running'
							   AND current_attempt_id = ? AND owner_id = ? AND lease_expires_at <= ?`,
						)
						.run(
							retryNotBefore,
							encode(recoveredUsage),
							recoveredTurns,
							now,
							runId,
							task.task_id,
							task.current_attempt_id,
							task.owner_id,
							now,
						);
					if (taskResult.changes !== 1) {
						throw new Error(`Concurrent DAG task recovery detected: ${runId}/${task.task_id}`);
					}
					this.insertDagEvent(
						runId,
						"task.requeued",
						{
							attemptId: task.current_attempt_id,
							attemptNumber: task.attempt_count,
							reason: resumable ? "resumable_interruption" : "lease_expired",
							retryNotBefore,
						},
						now,
						task.task_id,
					);
				} else {
					const taskResult = this.database
						.prepare(
							`UPDATE dag_tasks
							 SET status = 'failed', lease_expires_at = NULL, terminal_reason = 'retry_exhausted',
							     error = 'Task attempts exhausted after lease expiry',
							     usage_json = ?, turns = ?, updated_at = ?
							 WHERE run_id = ? AND task_id = ? AND status = 'running'
							   AND current_attempt_id = ? AND owner_id = ? AND lease_expires_at <= ?`,
						)
						.run(
							encode(recoveredUsage),
							recoveredTurns,
							now,
							runId,
							task.task_id,
							task.current_attempt_id,
							task.owner_id,
							now,
						);
					if (taskResult.changes !== 1) {
						throw new Error(`Concurrent DAG task recovery detected: ${runId}/${task.task_id}`);
					}
					this.insertDagEvent(
						runId,
						"task.failed",
						{ attemptId: task.current_attempt_id, terminalReason: "retry_exhausted" },
						now,
						task.task_id,
					);
				}
			}
			this.blockDagDescendants(runId, now);
			if (expired.length > 0) {
				this.reconcileDagRunAccountingInTransaction(runId, now);
				this.database.prepare("UPDATE dag_runs SET updated_at = ? WHERE run_id = ?").run(now, runId);
			}
			return expired.length;
		});
	}

	recordDagIntegration(runId: string, integration: IntegrationArtifact, now = Date.now(), lease?: DagRunLease): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		const persistedIntegration = normalizedIntegrationArtifact(integration);
		const integrationJson = encode(persistedIntegration);
		this.transaction(() => {
			const row = this.database
				.prepare(
					`SELECT status, owner_id, owner_epoch, run_lease_expires_at,
					        integration_json, integration_failure_json, request_json
					 FROM dag_runs WHERE run_id = ?`,
				)
				.get(runId) as
				| (DagRunOwnershipRow & {
						integration_json: string | null;
						integration_failure_json: string | null;
						request_json: string;
				  })
				| undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, row, now, lease);
			if (row.status !== "running") throw new Error(`DAG run is not running: ${runId}`);
			if (row.integration_failure_json !== null) throw new Error(`DAG run ${runId} has an integration failure`);
			if (row.integration_json !== null) {
				if (row.integration_json === integrationJson) return;
				throw new Error(`DAG integration is immutable: ${runId}`);
			}
			const request = decodeCompiledDagRequest(row.request_json);
			if (!request.merge.enabled) throw new Error(`DAG run did not request an integration candidate: ${runId}`);
			const taskRows = this.database
				.prepare(
					`SELECT task_id, status, terminal_reason, artifact_json
					 FROM dag_tasks WHERE run_id = ? ORDER BY task_order`,
				)
				.all(runId) as unknown as Array<{
				task_id: string;
				status: DagTaskStatus;
				terminal_reason: TaskTerminalReason | null;
				artifact_json: string | null;
			}>;
			const taskRowsById = new Map(taskRows.map((task) => [task.task_id, task]));
			const contractsById = new Map(request.tasks.map((contract) => [contract.id, contract]));
			const artifactsById = new Map<string, TaskArtifact>();
			for (const task of taskRows) {
				if (task.artifact_json) artifactsById.set(task.task_id, decode<TaskArtifact>(task.artifact_json));
			}
			const topologicalTaskIds = stableTopologicalTaskIds(request);

			if (persistedIntegration.kind === "complete") {
				if (persistedIntegration.quality?.gate !== "passed") {
					throw new Error("Complete DAG integration requires a passed candidate quality gate");
				}
				const incomplete = taskRows.find((task) => task.status !== "succeeded");
				if (incomplete) throw new Error(`DAG integration requires succeeded task ${incomplete.task_id}`);
				for (const contract of request.tasks) {
					if (!artifactsById.has(contract.id)) throw new Error(`Succeeded task ${contract.id} has no artifact`);
				}
				const expected = topologicalTaskIds.flatMap((taskId) => {
					const taskArtifact = artifactsById.get(taskId)!;
					return taskArtifact.commit === undefined ? [] : [{ taskId, commit: taskArtifact.commit }];
				});
				if (
					!equalStrings(
						persistedIntegration.orderedTaskIds,
						expected.map((item) => item.taskId),
					) ||
					!equalStrings(
						persistedIntegration.orderedCommits,
						expected.map((item) => item.commit),
					)
				) {
					throw new Error("DAG integration does not match persisted task artifacts");
				}
				const expectedQuality = evaluateCandidateQuality(
					request.tasks.map((contract) => ({ contract, artifact: artifactsById.get(contract.id)! })),
					persistedIntegration.quality.pinnedWriterTaskIds,
				);
				if (encode(expectedQuality) !== encode(persistedIntegration.quality)) {
					throw new Error("DAG integration quality does not match persisted task artifacts");
				}
			} else {
				if (
					persistedIntegration.partial.reason !== "task_failure" &&
					persistedIntegration.partial.reason !== "candidate_quality_failure"
				) {
					throw new Error("Partial DAG integration has an invalid failure reason");
				}
				if (taskRows.some((task) => task.status === "pending" || task.status === "running")) {
					throw new Error("Partial DAG integration requires every task branch to be settled");
				}
				const includedWriterTaskIds = persistedIntegration.partial.includedWriterTaskIds;
				if (includedWriterTaskIds.length === 0) throw new Error("Partial DAG integration requires a Writer commit");
				if (!equalStrings(persistedIntegration.orderedTaskIds, includedWriterTaskIds)) {
					throw new Error("Partial DAG integration task order does not match its provenance");
				}
				const included = new Set(includedWriterTaskIds);
				if (included.size !== includedWriterTaskIds.length) {
					throw new Error("Partial DAG integration contains duplicate Writer tasks");
				}
				const expectedIncludedOrder = topologicalTaskIds.filter((taskId) => included.has(taskId));
				if (!equalStrings(includedWriterTaskIds, expectedIncludedOrder)) {
					throw new Error("Partial DAG integration Writer order is not topological");
				}
				const expectedCommits: string[] = [];
				const omittedWriterTasks: Array<{ taskId: string; reason: PartialCandidateOmissionReason }> = [];
				for (const taskId of topologicalTaskIds) {
					const contract = contractsById.get(taskId)!;
					if (contract.role !== "writer") continue;
					const task = taskRowsById.get(taskId)!;
					const artifact = artifactsById.get(taskId);
					let omission: PartialCandidateOmissionReason | undefined;
					if (task.status !== "succeeded" || !artifact) omission = "task_not_succeeded";
					else if (artifact.quality.semanticOutcome !== "accepted") omission = "semantic_not_accepted";
					else if (artifact.quality.pathAudit !== "passed") omission = "path_audit_not_passed";
					else if (
						contract.validationCommandIds.length === 0 ||
						artifact.quality.validation.status !== "passed" ||
						!contract.validationCommandIds.every((commandId) =>
							artifact.validations.some(
								(result) => result.commandId === commandId && result.status === "passed",
							),
						)
					) {
						omission = "validation_not_passed";
					} else if (!artifact.commit) omission = "commit_missing";
					if (included.has(taskId)) {
						if (omission) throw new Error(`Partial DAG integration includes ineligible Writer ${taskId}`);
						expectedCommits.push(artifact!.commit!);
					} else {
						omittedWriterTasks.push({ taskId, reason: omission ?? "commit_pin_failed" });
					}
				}
				if (!equalStrings(persistedIntegration.orderedCommits, expectedCommits)) {
					throw new Error("Partial DAG integration commits do not match persisted Writer artifacts");
				}
				const negativeTasks = topologicalTaskIds.flatMap((taskId): PartialCandidateNegativeTask[] => {
					const task = taskRowsById.get(taskId)!;
					const semanticOutcome = artifactsById.get(taskId)?.quality.semanticOutcome;
					if (task.status === "failed" || task.status === "cancelled" || task.status === "blocked") {
						return [
							{
								taskId,
								status: task.status,
								...(task.terminal_reason ? { terminalReason: task.terminal_reason } : {}),
								...(semanticOutcome === "rejected" || semanticOutcome === "inconclusive"
									? { semanticOutcome }
									: {}),
							},
						];
					}
					if (semanticOutcome === "rejected" || semanticOutcome === "inconclusive") {
						return [{ taskId, status: task.status, semanticOutcome }];
					}
					return [];
				});
				const completeGateFailures = persistedIntegration.partial.completeGateFailures;
				const validCompleteGateFailures = new Set([
					"semantic_outcome",
					"path_audit",
					"validation_coverage",
					"commit_pin",
					"review_verdict",
					"review_coverage",
				]);
				if (
					!Array.isArray(completeGateFailures) ||
					new Set(completeGateFailures).size !== completeGateFailures.length ||
					completeGateFailures.some((failure) => !validCompleteGateFailures.has(failure))
				) {
					throw new Error("Partial DAG integration has invalid Complete Candidate gate failures");
				}
				const expectedPartial = {
					reason: persistedIntegration.partial.reason,
					completeGateFailures,
					trust: "controller_validated" as const,
					includedWriterTaskIds,
					omittedWriterTasks,
					negativeTasks,
				};
				if (encode(expectedPartial) !== encode(persistedIntegration.partial)) {
					throw new Error("Partial DAG integration provenance does not match persisted tasks");
				}
				if (
					persistedIntegration.partial.reason === "task_failure" &&
					(negativeTasks.length === 0 || completeGateFailures.length !== 0)
				) {
					throw new Error(
						"Task-failure Partial Candidate requires terminal negatives and no complete-gate fallback",
					);
				}
				const qualityTasks = topologicalTaskIds.flatMap((taskId) => {
					const task = taskRowsById.get(taskId)!;
					const contract = contractsById.get(taskId)!;
					const artifact = artifactsById.get(taskId);
					if (task.status !== "succeeded" || !artifact) return [];
					if (contract.role === "writer" && !included.has(taskId)) return [];
					return [{ contract, artifact }];
				});
				const expectedQuality = evaluatePartialCandidateQuality(qualityTasks, includedWriterTaskIds);
				if (encode(expectedQuality) !== encode(persistedIntegration.quality)) {
					throw new Error("Partial DAG integration quality does not match persisted task artifacts");
				}
				if (persistedIntegration.partial.reason === "candidate_quality_failure") {
					if (completeGateFailures.length === 0) {
						throw new Error("Candidate-quality Partial Candidate requires an observed complete-gate failure");
					}
					for (const failure of completeGateFailures) {
						if (failure === "commit_pin") {
							if (!omittedWriterTasks.some((task) => task.reason === "commit_pin_failed")) {
								throw new Error("Complete commit-pin failure is not reflected in Partial Candidate provenance");
							}
						} else if (!expectedQuality.gateFailures.includes(failure)) {
							throw new Error(`Complete gate failure ${failure} is not reflected in Partial Candidate quality`);
						}
					}
				}
			}
			const result = this.database
				.prepare(
					`UPDATE dag_runs SET integration_json = ?, updated_at = ?
					 WHERE run_id = ? AND status = 'running' AND integration_json IS NULL
					   AND integration_failure_json IS NULL`,
				)
				.run(integrationJson, now, runId);
			if (result.changes !== 1) throw new Error(`Concurrent DAG integration update detected: ${runId}`);
			this.insertDagEvent(runId, "run.integration", persistedIntegration, now);
		});
	}

	recordDagIntegrationFailure(
		runId: string,
		failure: IntegrationFailure,
		now = Date.now(),
		lease?: DagRunLease,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		if (!Number.isSafeInteger(failure.createdAt))
			throw new Error("Integration failure createdAt must be a safe integer");
		if (!["merge_conflict", "process_error", "cancelled", "quality_gate"].includes(failure.reason)) {
			throw new Error(`Invalid integration failure reason: ${String(failure.reason)}`);
		}
		if (failure.taskId !== undefined && !failure.taskId)
			throw new Error("Integration failure taskId cannot be empty");
		if (typeof failure.diagnostics !== "string") throw new Error("Integration failure diagnostics must be text");
		if (failure.reason === "quality_gate" && failure.quality?.gate !== "failed") {
			throw new Error("Quality-gate integration failure requires failed candidate quality");
		}
		if (failure.reason !== "quality_gate" && failure.quality !== undefined) {
			throw new Error("Candidate quality applies only to quality-gate integration failures");
		}
		const persisted: IntegrationFailure = {
			reason: failure.reason,
			...(failure.taskId === undefined ? {} : { taskId: failure.taskId }),
			diagnostics: boundedDiagnostic(failure.diagnostics),
			...(failure.quality === undefined ? {} : { quality: structuredClone(failure.quality) }),
			createdAt: failure.createdAt,
		};
		const failureJson = encode(persisted);
		this.transaction(() => {
			const row = this.database
				.prepare(
					`SELECT status, owner_id, owner_epoch, run_lease_expires_at,
					        integration_json, integration_failure_json
					 FROM dag_runs WHERE run_id = ?`,
				)
				.get(runId) as
				| (DagRunOwnershipRow & { integration_json: string | null; integration_failure_json: string | null })
				| undefined;
			if (!row) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, row, now, lease);
			if (row.status !== "running") throw new Error(`DAG run is not running: ${runId}`);
			if (row.integration_json !== null) throw new Error(`DAG run ${runId} already has an integration artifact`);
			if (row.integration_failure_json !== null) {
				if (row.integration_failure_json === failureJson) return;
				throw new Error(`DAG integration failure is immutable: ${runId}`);
			}
			const result = this.database
				.prepare(
					`UPDATE dag_runs SET integration_failure_json = ?, updated_at = ?
					 WHERE run_id = ? AND status = 'running' AND integration_json IS NULL
					   AND integration_failure_json IS NULL`,
				)
				.run(failureJson, now, runId);
			if (result.changes !== 1) throw new Error(`Concurrent DAG integration failure update detected: ${runId}`);
			this.insertDagEvent(runId, "run.integration_failed", persisted, now);
		});
	}

	recordDagAttemptPerformance(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		telemetry: AttemptPerformanceTelemetry,
		now = Date.now(),
		lease?: DagRunLease,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		const persisted = normalizedAttemptPerformance(telemetry);
		if (persisted.attemptId !== attemptId) throw new Error("Attempt performance identity mismatch");
		if (persisted.success !== (persisted.terminalReason === "completed")) {
			throw new Error("Attempt performance outcome mismatch");
		}
		this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			const attempt = this.database
				.prepare(
					`SELECT attempt.attempt_number, attempt.owner_id, task.role
					 FROM dag_attempts attempt
					 JOIN dag_tasks task ON task.run_id = attempt.run_id AND task.task_id = attempt.task_id
					 WHERE attempt.attempt_id = ? AND attempt.run_id = ? AND attempt.task_id = ?`,
				)
				.get(attemptId, runId, taskId) as
				| { attempt_number: number; owner_id: string; role: SubagentRole }
				| undefined;
			if (!attempt) throw new Error(`Unknown DAG attempt: ${runId}/${taskId}/${attemptId}`);
			if (
				attempt.owner_id !== ownerId ||
				attempt.attempt_number !== persisted.attemptNumber ||
				attempt.role !== persisted.role
			) {
				throw new Error("Attempt performance identity mismatch");
			}
			this.insertDagEvent(runId, ATTEMPT_PERFORMANCE_EVENT, persisted, now, taskId);
		});
	}

	recordDagSchedulerWait(
		runId: string,
		telemetry: SchedulerWaitTelemetry,
		now = Date.now(),
		lease?: DagRunLease,
	): void {
		this.ensureOpen();
		if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
		const persisted = normalizedSchedulerWait(telemetry);
		this.transaction(() => {
			const run = this.database
				.prepare("SELECT status, owner_id, owner_epoch, run_lease_expires_at FROM dag_runs WHERE run_id = ?")
				.get(runId) as DagRunOwnershipRow | undefined;
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			this.assertDagRunMutationLease(runId, run, now, lease);
			this.insertDagEvent(runId, SCHEDULER_WAIT_EVENT, persisted, now);
		});
	}

	private readDagRun(runId: string): LedgerDagRunRecord | undefined {
		const run = this.database.prepare("SELECT * FROM dag_runs WHERE run_id = ?").get(runId) as DagRunRow | undefined;
		if (!run) return undefined;
		const tasks = this.database
			.prepare("SELECT * FROM dag_tasks WHERE run_id = ? ORDER BY task_order")
			.all(runId) as unknown as DagTaskRow[];
		return {
			runId: run.run_id,
			status: run.status,
			objective: decodeCompiledDagRequest(run.request_json).objective,
			request: decodeCompiledDagRequest(run.request_json),
			baseline: decode<SnapshotBaseline>(run.baseline_json),
			tasks: tasks.map((task) => {
				const contract = decode<DagTaskContract>(task.contract_json);
				const attempts = this.database
					.prepare("SELECT * FROM dag_attempts WHERE run_id = ? AND task_id = ? ORDER BY attempt_number")
					.all(runId, task.task_id) as unknown as DagAttemptRow[];
				const externalMutations = this.database
					.prepare(
						`SELECT * FROM dag_external_mutations
						 WHERE run_id = ? AND task_id = ?
						 ORDER BY attempt_number, authorization_sequence`,
					)
					.all(runId, task.task_id) as unknown as ExternalMutationRow[];
				const mutationsByAttempt = new Map<string, ExternalMutationRecord[]>();
				for (const row of externalMutations) {
					const records = mutationsByAttempt.get(row.attempt_id) ?? [];
					records.push(externalMutationFromRow(row));
					mutationsByAttempt.set(row.attempt_id, records);
				}
				return {
					runId: task.run_id,
					taskId: task.task_id,
					role: contract.role,
					contract,
					status: task.status,
					attempts: task.attempt_count,
					attemptRecords: attempts.map((attempt) => ({
						attemptId: attempt.attempt_id,
						attemptNumber: attempt.attempt_number,
						ownerId: attempt.owner_id,
						status: attempt.status,
						leaseExpiresAt: attempt.lease_expires_at,
						checkpoint: attempt.checkpoint_json ? decode<unknown>(attempt.checkpoint_json) : undefined,
						terminalReason: attempt.terminal_reason ?? undefined,
						error: attempt.error ?? undefined,
						usage: decode<Usage>(attempt.usage_json),
						turns: attempt.turns,
						runtime: attempt.runtime_json ? decode<ChildRuntimeMetadata>(attempt.runtime_json) : undefined,
						externalMutations: mutationsByAttempt.get(attempt.attempt_id) ?? [],
						createdAt: attempt.created_at,
						updatedAt: attempt.updated_at,
					})),
					ownerId: task.status === "running" ? (task.owner_id ?? undefined) : undefined,
					activeAttemptId: task.status === "running" ? (task.current_attempt_id ?? undefined) : undefined,
					leaseExpiresAt: task.status === "running" ? (task.lease_expires_at ?? undefined) : undefined,
					checkpoint: task.checkpoint_json ? decode<unknown>(task.checkpoint_json) : undefined,
					terminalReason: task.terminal_reason ?? undefined,
					error: task.error ?? undefined,
					artifact: task.artifact_json ? decode<TaskArtifact>(task.artifact_json) : undefined,
					usage: decode<Usage>(task.usage_json),
					turns: task.turns,
					createdAt: task.created_at,
					updatedAt: task.updated_at,
				};
			}),
			usage: decode<Usage>(run.usage_json),
			turns: run.turns,
			pausedAt: run.paused_at ?? undefined,
			pausedDurationMs: run.paused_duration_ms,
			graphVersion: run.graph_version,
			graphSealed: run.graph_sealed !== 0,
			awaitingExpansion:
				run.status === "running" &&
				run.graph_sealed === 0 &&
				run.paused_at !== null &&
				tasks.every((task) => task.status === "succeeded"),
			lease:
				run.owner_id !== null && run.run_lease_expires_at !== null
					? { ownerId: run.owner_id, epoch: run.owner_epoch, leaseExpiresAt: run.run_lease_expires_at }
					: undefined,
			integration: run.integration_json ? decodeIntegrationArtifact(run.integration_json) : undefined,
			integrationFailure: run.integration_failure_json
				? decode<IntegrationFailure>(run.integration_failure_json)
				: undefined,
			resources: dagResourceLifecycle(run),
			createdAt: run.created_at,
			updatedAt: run.updated_at,
		};
	}

	getDagRun(runId: string): LedgerDagRunRecord | undefined {
		this.ensureOpen();
		return this.readTransaction(() => this.readDagRun(runId));
	}

	listDagRuns(options: ListDagRunsOptions = {}): DagRunSummary[] {
		this.ensureOpen();
		const limit = options.limit ?? DEFAULT_OPERATOR_RUN_LIMIT;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OPERATOR_RUN_LIMIT) {
			throw new Error(`DAG run list limit must be an integer between 1 and ${MAX_OPERATOR_RUN_LIMIT}`);
		}
		const statuses = options.statuses ? [...new Set(options.statuses)] : [];
		for (const status of statuses) {
			if (!Object.hasOwn(RUN_TRANSITIONS, status))
				throw new Error(`Invalid DAG run status filter: ${String(status)}`);
		}
		if (options.statuses && statuses.length === 0) return [];
		if (options.repositoryRoot !== undefined && options.repositoryRoot.length === 0) {
			throw new Error("DAG run repositoryRoot filter cannot be empty");
		}
		return this.readTransaction(() => {
			const clauses: string[] = [];
			const parameters: Array<string | number> = [];
			if (statuses.length > 0) {
				clauses.push(`run.status IN (${statuses.map(() => "?").join(", ")})`);
				parameters.push(...statuses);
			}
			if (options.repositoryRoot !== undefined) {
				clauses.push("run.repository_root = ?");
				parameters.push(options.repositoryRoot);
			}
			const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
			const rows = this.database
				.prepare(
					`SELECT run.*,
					        SUM(CASE WHEN task.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
					        SUM(CASE WHEN task.status = 'running' THEN 1 ELSE 0 END) AS running_count,
					        SUM(CASE WHEN task.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
					        SUM(CASE WHEN task.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
					        SUM(CASE WHEN task.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
					        SUM(CASE WHEN task.status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count
					 FROM dag_runs run
					 LEFT JOIN dag_tasks task ON task.run_id = run.run_id
					 ${where}
					 GROUP BY run.run_id
					 ORDER BY run.updated_at DESC, run.created_at DESC, run.run_id ASC
					 LIMIT ?`,
				)
				.all(...parameters, limit) as unknown as Array<
				DagRunRow & {
					pending_count: number;
					running_count: number;
					succeeded_count: number;
					failed_count: number;
					cancelled_count: number;
					blocked_count: number;
				}
			>;
			return rows.map((row) => {
				const request = decodeCompiledDagRequest(row.request_json);
				return {
					runId: row.run_id,
					status: row.status,
					objective: request.objective,
					repositoryRoot: row.repository_root,
					counts: {
						pending: row.pending_count,
						running: row.running_count,
						succeeded: row.succeeded_count,
						failed: row.failed_count,
						cancelled: row.cancelled_count,
						blocked: row.blocked_count,
					},
					usage: decode<Usage>(row.usage_json),
					budget: request.budget,
					...(request.budgetScope ? { budgetScope: request.budgetScope } : {}),
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					pausedAt: row.paused_at ?? undefined,
					pausedDurationMs: row.paused_duration_ms,
					lease:
						row.owner_id !== null && row.run_lease_expires_at !== null
							? { ownerId: row.owner_id, epoch: row.owner_epoch, leaseExpiresAt: row.run_lease_expires_at }
							: undefined,
					integration: row.integration_json ? decodeIntegrationArtifact(row.integration_json) : undefined,
					integrationFailure: row.integration_failure_json
						? decode<IntegrationFailure>(row.integration_failure_json)
						: undefined,
					resources: dagResourceLifecycle(row),
				};
			});
		});
	}

	inspectDagRun(runId: string, eventLimit = DEFAULT_OPERATOR_EVENT_LIMIT): DagRunInspection | undefined {
		this.ensureOpen();
		if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > MAX_OPERATOR_EVENT_LIMIT) {
			throw new Error(`DAG event limit must be an integer between 1 and ${MAX_OPERATOR_EVENT_LIMIT}`);
		}
		return this.readTransaction(() => {
			const run = this.readDagRun(runId);
			if (!run) return undefined;
			const rows = this.database
				.prepare("SELECT * FROM dag_events WHERE run_id = ? ORDER BY sequence DESC LIMIT ?")
				.all(runId, eventLimit) as unknown as EventRow[];
			const events = rows.reverse().map((row) => ({
				sequence: row.sequence,
				runId: row.run_id,
				taskId: row.task_id ?? undefined,
				type: row.event_type,
				payload: decode<unknown>(row.payload_json),
				createdAt: row.created_at,
			}));
			const performanceRows = this.database
				.prepare(
					`SELECT * FROM dag_events
					 WHERE run_id = ? AND event_type IN (?, ?, 'task.requeued')
					 ORDER BY sequence`,
				)
				.all(runId, ATTEMPT_PERFORMANCE_EVENT, SCHEDULER_WAIT_EVENT) as unknown as EventRow[];
			const performanceEvents = performanceRows.map((row) => ({
				sequence: row.sequence,
				runId: row.run_id,
				taskId: row.task_id ?? undefined,
				type: row.event_type,
				payload: decode<unknown>(row.payload_json),
				createdAt: row.created_at,
			}));
			return { ...run, events, performance: buildSubagentPerformanceReport(run, performanceEvents) };
		});
	}

	listDagEvents(runId: string): DagLedgerEvent[] {
		this.ensureOpen();
		const rows = this.database
			.prepare("SELECT * FROM dag_events WHERE run_id = ? ORDER BY sequence")
			.all(runId) as unknown as EventRow[];
		return rows.map((row) => ({
			sequence: row.sequence,
			runId: row.run_id,
			taskId: row.task_id ?? undefined,
			type: row.event_type,
			payload: decode<unknown>(row.payload_json),
			createdAt: row.created_at,
		}));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.database.close();
	}
}

export const DurableLedger = RunLedger;

export function openRunLedger(path: string): RunLedger {
	return new RunLedger(path);
}
