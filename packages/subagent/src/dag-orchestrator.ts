import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Usage } from "@earendil-works/pi-ai";
import type { ChildHarnessContextProvider } from "@easy-pi/permissions";
import {
	createExternalMutationJournal,
	EXTERNAL_MUTATION_JOURNAL_VERSION,
	type ExternalMutationJournalHandle,
	ExternalMutationJournalReader,
	openExternalMutationJournal,
} from "@easy-pi/permissions/journal";
import { attachExecutionMetadata, createReadOnlyArtifact } from "./artifact-pipeline.ts";
import { AttemptRuntimeRegistry } from "./attempt-runtime-registry.ts";
import { allocateConcurrentBudgets, budgetExhausted, remainingBudget, remainingSoftTokenLimit } from "./budget.ts";
import type { TrustedSandboxLauncher } from "./child-runtime-policy.ts";
import { compileSubagentDagExpansion, type SubagentDagExpandRequest } from "./contracts.ts";
import { progressCounts, stableTopologicalTasks } from "./dag-scheduler.ts";
import { asInconclusivePartialHandoff } from "./handoff.ts";
import type { DagRunInspection, DagTaskClaim, LedgerDagRunRecord, ListDagRunsOptions, RunLedger } from "./ledger.ts";
import { RUNTIME_METADATA_PERSIST_INTERVAL, ZERO_USAGE } from "./ledger.ts";
import { createLedgerRepositories } from "./ledger-repositories.ts";
import {
	inspectMergeCandidateDiff,
	inspectMergeCandidateRef,
	MergeConflictError,
	type MergeCoordinatorOptions,
	mergeTaskCommits,
	releaseMergeCandidateRef,
} from "./merge-coordinator.ts";
import { type AttemptPerformanceStage, SUBAGENT_PERFORMANCE_VERSION } from "./performance.ts";
import { cleanupChildRuntimeRoot, type RunChildTaskOptions, runChildTask } from "./process-runner.ts";
import {
	createExternalWriterArtifact,
	evaluateCandidateQuality,
	evaluatePartialCandidateQuality,
	type ValidateAndCommitWriterTaskOptions,
	ValidationRegistry,
	validateAndCommitWriterTask,
	WriterQualityError,
} from "./quality.ts";
import { decideRetry } from "./retry-policy.ts";
import { detailsFromLedgerRun } from "./run-lifecycle.ts";
import { createRepositorySnapshot } from "./snapshot.ts";
import type {
	CandidateDiff,
	CandidateQuality,
	ChildRuntimeMetadata,
	ChildTaskResult,
	CompiledSubagentDagRequest,
	DagRunLease,
	DagRunSummary,
	DagTaskContract,
	ExternalWriterHandoff,
	IntegrationArtifact,
	IntegrationFailure,
	PartialCandidateNegativeTask,
	PartialCandidateOmissionReason,
	RetentionSweepResult,
	SnapshotHandle,
	SubagentBudget,
	SubagentDagRunDetails,
	SubagentPolicy,
	SubagentRetentionPolicy,
	TaskArtifact,
	TaskTerminalReason,
	WorktreeHandle,
	WriterHandoff,
} from "./types.ts";
import { TASK_ARTIFACT_VERSION } from "./types.ts";
import {
	createFrozenBaseline,
	createTaskWorktree,
	type FrozenBaselineHandle,
	pinRunBaseline,
	pinTaskCommit,
	reconcileTaskWorktrees,
	releaseRunBaselinePin,
	releaseTaskCommitPin,
	validateWorktreeOwnership,
} from "./worktree.ts";

export interface DagOrchestratorProgressCounts {
	total: number;
	completed: number;
	pending: number;
	running: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	blocked: number;
}

export interface DagOrchestratorProgress extends DagOrchestratorProgressCounts {
	details: SubagentDagRunDetails;
	counts: DagOrchestratorProgressCounts;
}

export interface DagWorkspaceOperations {
	createFrozenBaseline: typeof createFrozenBaseline;
	pinRunBaseline: typeof pinRunBaseline;
	releaseRunBaselinePin: typeof releaseRunBaselinePin;
	pinTaskCommit: typeof pinTaskCommit;
	releaseTaskCommitPin: typeof releaseTaskCommitPin;
	reconcileTaskWorktrees: typeof reconcileTaskWorktrees;
	createTaskWorktree: typeof createTaskWorktree;
	validateWorktreeOwnership: typeof validateWorktreeOwnership;
	createSnapshot: (repositoryPath: string, policy: SubagentPolicy, signal?: AbortSignal) => Promise<SnapshotHandle>;
}

export interface DagOrchestratorDependencies {
	ledger: RunLedger;
	policy: SubagentPolicy;
	validationRegistry?: ValidationRegistry;
	/** Function and object forms are both accepted to keep test/embedding adapters small. */
	runner?:
		| ((options: RunChildTaskOptions) => Promise<ChildTaskResult>)
		| { runTask(options: RunChildTaskOptions): Promise<ChildTaskResult> };
	runTask?: (options: RunChildTaskOptions) => Promise<ChildTaskResult>;
	workspace?: Partial<DagWorkspaceOperations>;
	/** Direct workspace overrides are aliases for small embedding/test seams. */
	createFrozenBaseline?: typeof createFrozenBaseline;
	pinRunBaseline?: typeof pinRunBaseline;
	releaseRunBaselinePin?: typeof releaseRunBaselinePin;
	pinTaskCommit?: typeof pinTaskCommit;
	releaseTaskCommitPin?: typeof releaseTaskCommitPin;
	reconcileTaskWorktrees?: typeof reconcileTaskWorktrees;
	createTaskWorktree?: typeof createTaskWorktree;
	validateWorktreeOwnership?: typeof validateWorktreeOwnership;
	createSnapshot?: DagWorkspaceOperations["createSnapshot"];
	quality?:
		| ((options: ValidateAndCommitWriterTaskOptions) => Promise<TaskArtifact>)
		| { validateAndCommitWriterTask(options: ValidateAndCommitWriterTaskOptions): Promise<TaskArtifact> };
	validateAndCommitWriterTask?: (options: ValidateAndCommitWriterTaskOptions) => Promise<TaskArtifact>;
	merge?:
		| ((options: MergeCoordinatorOptions) => Promise<IntegrationArtifact>)
		| { mergeTaskCommits(options: MergeCoordinatorOptions): Promise<IntegrationArtifact> };
	mergeTaskCommits?: (options: MergeCoordinatorOptions) => Promise<IntegrationArtifact>;
	releaseMergeCandidateRef?: typeof releaseMergeCandidateRef;
	inspectMergeCandidateRef?: typeof inspectMergeCandidateRef;
	inspectMergeCandidateDiff?: typeof inspectMergeCandidateDiff;
	createRunId?: () => string;
	createOwnerId?: (runId: string) => string;
	now?: () => number;
	temporaryDirectory?: string;
	controllerEnvironment?: Readonly<NodeJS.ProcessEnv>;
	/** Trusted wrapper for Child Pi only. */
	sandboxLauncher?: TrustedSandboxLauncher;
	/** Independent trusted wrapper for controller-run validation commands. */
	validationSandboxLauncher?: TrustedSandboxLauncher;
	createChildHarnessContext?: ChildHarnessContextProvider;
	retentionPolicy?: SubagentRetentionPolicy;
}

export interface StartDagRunOptions {
	request: CompiledSubagentDagRequest;
	repositoryPath: string;
	signal?: AbortSignal;
	onProgress?: (progress: DagOrchestratorProgress) => void;
}

export interface ResumeDagRunOptions {
	runId: string;
	signal?: AbortSignal;
	onProgress?: (progress: DagOrchestratorProgress) => void;
}

export interface ExpandDagRunOptions extends SubagentDagExpandRequest {
	/** Controller-read CAS value; never supplied by the model-facing schema. */
	expectedGraphVersion: number;
	signal?: AbortSignal;
}

export interface TaskControlOptions {
	runId: string;
	taskId: string;
	operation: "message" | "follow_up" | "interrupt";
	message?: string;
}

export interface DagOperatorOptions {
	runId: string;
	signal?: AbortSignal;
}

export interface CandidateDiffOptions extends DagOperatorOptions {
	maxBytes?: number;
	maxPaths?: number;
}

export class DagRunInterruptedError extends Error {
	readonly runId: string;
	readonly details?: SubagentDagRunDetails;

	constructor(message: string, runId: string, details?: SubagentDagRunDetails, options?: ErrorOptions) {
		super(message, options);
		this.name = "DagRunInterruptedError";
		this.runId = runId;
		this.details = details;
	}
}

class ProviderCircuitPauseError extends Error {
	readonly runId: string;
	readonly taskId: string;

	constructor(runId: string, taskId: string) {
		super(`Provider circuit opened for ${runId}/${taskId}`);
		this.name = "ProviderCircuitPauseError";
		this.runId = runId;
		this.taskId = taskId;
	}
}

export class SubagentDagRunError extends Error {
	readonly details: SubagentDagRunDetails;

	constructor(message: string, details: SubagentDagRunDetails, options?: ErrorOptions) {
		super(message, options);
		this.name = "SubagentDagRunError";
		this.details = details;
	}
}

interface ActiveRun {
	runId: string;
	controller: AbortController;
	interrupted: boolean;
	userCancelled: boolean;
	/** Post-child quality/commit work is allowed to reach a durable boundary before pause aborts. */
	nonInterruptible: number;
	done: Promise<void>;
	resolveDone(): void;
}

interface ClaimBudgetReservation {
	budget: SubagentBudget;
	softTokenLimit?: number;
}

interface Runtime {
	active: ActiveRun;
	ownerId: string;
	lease: DagRunLease;
	leaseLost?: unknown;
	topologicalTasks: DagTaskContract[];
	aggregateUsage: Usage;
	aggregateTurns: number;
	onProgress?: (progress: DagOrchestratorProgress) => void;
}

function cloneUsage(usage: Usage = ZERO_USAGE): Usage {
	return structuredClone(usage);
}

function addUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.cost.input += source.cost.input;
	target.cost.output += source.cost.output;
	target.cost.cacheRead += source.cost.cacheRead;
	target.cost.cacheWrite += source.cost.cacheWrite;
	target.cost.total += source.cost.total;
	if (source.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + source.cacheWrite1h;
	if (source.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + source.reasoning;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function writerRetryDiagnostic(error: unknown): string {
	if (!(error instanceof WriterQualityError) || error.validations.length === 0) return errorMessage(error);
	const printable = (value: string): string =>
		value
			.replace(/[\p{Cc}\p{Cf}]/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
	const rows = error.validations
		.filter((validation) => validation.status !== "passed")
		.slice(0, 2)
		.map((validation) => {
			const output = printable(validation.stderr || validation.stdout).slice(0, 480);
			return [
				`${validation.commandId}: status=${validation.status}`,
				validation.exitCode === undefined ? undefined : `exitCode=${validation.exitCode}`,
				output ? `untrustedOutput=${JSON.stringify(output)}` : undefined,
			]
				.filter((value): value is string => Boolean(value))
				.join("; ");
		});
	return `${error.message}; validation diagnostics: ${rows.join(" | ")}`.slice(0, 1_200);
}

async function waitForStateChange(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(finish, delayMs);
		timer.unref();
		function finish(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		}
		signal.addEventListener("abort", finish, { once: true });
	});
}

interface StateChangeTimer {
	promise: Promise<"elapsed" | "aborted" | "cancelled">;
	cancel(): void;
}

function createStateChangeTimer(delayMs: number, signal: AbortSignal): StateChangeTimer {
	let finish!: (outcome: "elapsed" | "aborted" | "cancelled") => void;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<"elapsed" | "aborted" | "cancelled">((resolve) => {
		finish = (outcome) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = (): void => finish("aborted");
		if (signal.aborted) {
			finish("aborted");
			return;
		}
		timer = setTimeout(() => finish("elapsed"), Math.max(0, delayMs));
		timer.unref();
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return { promise, cancel: () => finish("cancelled") };
}

function stableTopologicalOrder(tasks: readonly DagTaskContract[]): DagTaskContract[] {
	return stableTopologicalTasks(tasks);
}

function detailsFromRecord(run: LedgerDagRunRecord): SubagentDagRunDetails {
	return detailsFromLedgerRun(run);
}

function progressFromRecord(run: LedgerDagRunRecord): DagOrchestratorProgress {
	const counts = progressCounts(run);
	return { details: detailsFromRecord(run), counts, ...counts };
}

interface InterruptedAttemptAccounting {
	usage: Usage;
	turns: number;
}

function validUsage(value: unknown): value is Usage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<Usage>;
	return (
		typeof candidate.totalTokens === "number" && Boolean(candidate.cost) && typeof candidate.cost?.total === "number"
	);
}

function isAvailabilityRetryCheckpoint(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const checkpoint = value as Record<string, unknown>;
	return (
		checkpoint.version === 1 && (checkpoint.phase === "availability_retry" || checkpoint.availabilityRetry === true)
	);
}

function checkpointAttemptAccounting(value: unknown): InterruptedAttemptAccounting | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const checkpoint = value as Record<string, unknown>;
	if (
		checkpoint.version !== 1 ||
		(checkpoint.phase !== "interrupted" &&
			checkpoint.phase !== "artifact_ready" &&
			checkpoint.phase !== "provider_circuit_open" &&
			!isAvailabilityRetryCheckpoint(checkpoint))
	) {
		return undefined;
	}
	if (!validUsage(checkpoint.attemptUsage) || !Number.isSafeInteger(checkpoint.attemptTurns)) return undefined;
	const turns = Number(checkpoint.attemptTurns);
	return turns >= 0 ? { usage: structuredClone(checkpoint.attemptUsage), turns } : undefined;
}

function cumulativeAttemptAccounting(
	checkpoint: unknown,
	result: ChildTaskResult | undefined,
): InterruptedAttemptAccounting {
	const prior = checkpointAttemptAccounting(checkpoint);
	const usage = cloneUsage(prior?.usage);
	if (result) addUsage(usage, result.usage);
	return { usage, turns: (prior?.turns ?? 0) + (result?.turns ?? 0) };
}

function artifactReadyCheckpoint(
	value: unknown,
	task: DagTaskContract,
): { artifact: TaskArtifact; usage: Usage; turns: number } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const checkpoint = value as Record<string, unknown>;
	if (checkpoint.version !== 1 || checkpoint.phase !== "artifact_ready") return undefined;
	const artifact = checkpoint.artifact;
	const usage = checkpoint.attemptUsage;
	const turns = checkpoint.attemptTurns;
	if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return undefined;
	const record = artifact as Record<string, unknown>;
	if (
		record.artifactVersion !== TASK_ARTIFACT_VERSION ||
		record.taskId !== task.id ||
		record.contractHash !== task.contractHash ||
		typeof record.artifactId !== "string"
	) {
		return undefined;
	}
	if (!validUsage(usage) || !Number.isSafeInteger(turns) || Number(turns) < 0) return undefined;
	return {
		artifact: structuredClone(artifact as TaskArtifact),
		usage: structuredClone(usage),
		turns: Number(turns),
	};
}

function readOnlyArtifact(
	task: DagTaskContract,
	result: ChildTaskResult,
	now: number,
	dependencyArtifacts: readonly TaskArtifact[],
): TaskArtifact {
	return createReadOnlyArtifact(task, result, now, dependencyArtifacts);
}

function selectedChildModel(request: CompiledSubagentDagRequest, task: DagTaskContract) {
	const role =
		task.role === "writer" || task.role === "external-writer"
			? "writer"
			: task.role === "reviewer"
				? "reviewer"
				: "analyst";
	return request.childModels?.[role] ?? request.childModel;
}

function withExecutionMetadata(artifact: TaskArtifact, result: ChildTaskResult): TaskArtifact {
	return attachExecutionMetadata(artifact, result);
}

function retryFeedbackFromCheckpoint(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const checkpoint = value as Record<string, unknown>;
	return checkpoint.version === 1 && checkpoint.phase === "retry_pending" && typeof checkpoint.feedback === "string"
		? checkpoint.feedback
		: undefined;
}

function terminalReason(error: unknown): Exclude<TaskTerminalReason, "completed"> {
	if (error instanceof WriterQualityError) return error.terminalReason;
	if (error instanceof MergeConflictError) return "merge_conflict";
	if (error instanceof DagRunInterruptedError) return "interrupted";
	if (error instanceof Error && error.name === "AbortError") return "cancelled";
	return "process_error";
}

function integrationFailure(error: unknown, now: number): IntegrationFailure {
	if (error instanceof MergeConflictError) {
		return {
			reason: "merge_conflict",
			taskId: error.taskId,
			diagnostics: error.diagnostics,
			createdAt: now,
		};
	}
	if (error instanceof Error && error.name === "AbortError") {
		return { reason: "cancelled", diagnostics: error.message, createdAt: now };
	}
	return { reason: "process_error", diagnostics: errorMessage(error), createdAt: now };
}

function qualityGateDiagnostics(
	quality: CandidateQuality,
	pinErrors: readonly { taskId: string; error: string }[],
): string {
	const missing = (required: readonly string[], covered: readonly string[]): string => {
		const present = new Set(covered);
		return required.filter((taskId) => !present.has(taskId)).join(", ") || "none";
	};
	return [
		`Candidate quality gate failed: ${quality.gateFailures.join(", ") || "unknown"}`,
		`writers without path audit: ${missing(quality.writerTaskIds, quality.pathAuditedWriterTaskIds)}`,
		`writers without passed registered validation: ${missing(quality.writerTaskIds, quality.validatedWriterTaskIds)}`,
		`writers without exact commit pin: ${missing(quality.writerTaskIds, quality.pinnedWriterTaskIds)}`,
		`review coverage: ${quality.reviewCoverage}; full reviewers: ${quality.fullCoverageReviewerTaskIds.join(", ") || "none"}`,
		...pinErrors.map((failure) => `pin ${failure.taskId}: ${failure.error}`),
	].join("; ");
}

/** Durable DAG controller. It never checks out or modifies the caller's branch/worktree. */
export class SubagentDagOrchestrator {
	private readonly dependencies: DagOrchestratorDependencies;
	private readonly activeRuns = new Map<string, ActiveRun>();
	private readonly attemptRuntimes = new AttemptRuntimeRegistry();
	private readonly repositories: ReturnType<typeof createLedgerRepositories>;
	private shuttingDown = false;

	constructor(dependencies: DagOrchestratorDependencies) {
		this.dependencies = dependencies;
		this.repositories = createLedgerRepositories(dependencies.ledger);
	}

	abortAll(): void {
		for (const active of this.activeRuns.values()) {
			active.userCancelled = true;
			active.controller.abort();
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		const active = [...this.activeRuns.values()];
		for (const run of active) {
			if (!run.userCancelled) run.interrupted = true;
			if (run.nonInterruptible === 0) run.controller.abort();
		}
		await Promise.all(active.map((run) => run.done));
		if (active.length > 0) {
			const first = active[0]!;
			const persisted = this.dependencies.ledger.getDagRun(first.runId);
			throw new DagRunInterruptedError(
				"DAG orchestrator shut down with active durable runs",
				first.runId,
				persisted ? detailsFromRecord(persisted) : undefined,
			);
		}
	}

	inspect(runId: string | ResumeDagRunOptions): SubagentDagRunDetails {
		const id = typeof runId === "string" ? runId : runId.runId;
		const run = this.dependencies.ledger.getDagRun(id);
		if (!run) throw new Error(`Unknown DAG run: ${id}`);
		return detailsFromRecord(run);
	}

	async controlTask(options: TaskControlOptions): Promise<SubagentDagRunDetails> {
		const run = this.dependencies.ledger.getDagRun(options.runId);
		if (!run) throw new Error(`Unknown DAG run: ${options.runId}`);
		const task = run.tasks.find((candidate) => candidate.taskId === options.taskId);
		if (!task) throw new Error(`Unknown DAG task: ${options.runId}/${options.taskId}`);
		if (task.status !== "running") throw new Error(`DAG task is not running: ${options.runId}/${options.taskId}`);
		const active = this.attemptRuntimes.get(options.runId, options.taskId);
		if (!active || active.attemptId !== task.activeAttemptId || active.runtime.closed) {
			throw new Error(`DAG task has no live child runtime: ${options.runId}/${options.taskId}`);
		}
		const message = options.message?.trim();
		if (options.operation !== "interrupt" && (!message || message.length > 4_000 || message.includes("\0"))) {
			throw new Error(`Subagent ${options.operation} requires a valid message of at most 4000 characters`);
		}
		try {
			await this.attemptRuntimes.control(active, options.operation, message);
			this.repositories.attempts.recordControl(
				options.runId,
				options.taskId,
				active.attemptId,
				active.ownerId,
				options.operation,
				message,
				true,
				this.now(),
				active.runLease(),
			);
		} catch (error) {
			try {
				this.repositories.attempts.recordControl(
					options.runId,
					options.taskId,
					active.attemptId,
					active.ownerId,
					options.operation,
					message,
					false,
					this.now(),
					active.runLease(),
					errorMessage(error),
				);
			} catch {
				// The original runtime/control failure remains authoritative.
			}
			throw error;
		}
		return this.inspect(options.runId);
	}

	list(options: ListDagRunsOptions = {}): DagRunSummary[] {
		return this.dependencies.ledger.listDagRuns(options);
	}

	inspectOperator(runId: string, eventLimit?: number): DagRunInspection {
		const run = this.dependencies.ledger.inspectDagRun(runId, eventLimit);
		if (!run) throw new Error(`Unknown DAG run: ${runId}`);
		return run;
	}

	async pause(options: DagOperatorOptions): Promise<SubagentDagRunDetails> {
		const initial = this.dependencies.ledger.getDagRun(options.runId);
		if (!initial) throw new Error(`Unknown DAG run: ${options.runId}`);
		if (initial.status !== "created" && initial.status !== "running") {
			throw new SubagentDagRunError(`DAG run ${options.runId} is ${initial.status}`, detailsFromRecord(initial));
		}
		if (initial.pausedAt !== undefined) return detailsFromRecord(initial);
		const unsafeExternalWriter = initial.tasks.find(
			(task) => task.role === "external-writer" && task.status === "running",
		);
		if (unsafeExternalWriter) {
			throw new SubagentDagRunError(
				`DAG run cannot pause while external-writer ${unsafeExternalWriter.taskId} has uncheckpointed live side effects`,
				detailsFromRecord(initial),
			);
		}
		const active = this.activeRuns.get(options.runId);
		if (active) {
			if (!active.userCancelled) {
				active.interrupted = true;
				if (active.nonInterruptible === 0) active.controller.abort();
			}
			await active.done;
		}
		if (options.signal?.aborted) {
			const error = new Error("Pause cancelled");
			error.name = "AbortError";
			throw error;
		}
		this.dependencies.ledger.markDagRunPaused(options.runId, this.now());
		return this.inspect(options.runId);
	}

	async cancel(options: DagOperatorOptions): Promise<SubagentDagRunDetails> {
		const initial = this.dependencies.ledger.getDagRun(options.runId);
		if (!initial) throw new Error(`Unknown DAG run: ${options.runId}`);
		if (initial.status === "cancelled") return detailsFromRecord(initial);
		if (initial.status !== "created" && initial.status !== "running") {
			throw new SubagentDagRunError(`DAG run ${options.runId} is ${initial.status}`, detailsFromRecord(initial));
		}
		const active = this.activeRuns.get(options.runId);
		if (active) {
			// Explicit terminal cancellation wins every race with a resumable pause.
			active.interrupted = false;
			active.userCancelled = true;
			active.controller.abort();
			await active.done;
			return this.inspect(options.runId);
		}
		if (options.signal?.aborted) {
			const error = new Error("Cancellation cancelled");
			error.name = "AbortError";
			throw error;
		}
		const ownerId = (this.dependencies.createOwnerId ?? ((id) => `${id}-${randomUUID()}`))(options.runId);
		const lease = this.dependencies.ledger.acquireDagRunLease(
			options.runId,
			ownerId,
			this.now(),
			this.dependencies.policy.leaseDurationMs ?? 30_000,
		);
		if (!lease) throw new Error(`DAG run has a live controller lease: ${options.runId}`);
		this.dependencies.ledger.setDagRunStatus(options.runId, "cancelled", this.now(), lease);
		return this.inspect(options.runId);
	}

	async diffCandidate(options: CandidateDiffOptions): Promise<CandidateDiff> {
		const run = this.dependencies.ledger.getDagRun(options.runId);
		if (!run) throw new Error(`Unknown DAG run: ${options.runId}`);
		if (!run.integration) throw new Error(`DAG run has no integration candidate: ${options.runId}`);
		if (run.resources.candidate !== "retained") {
			throw new Error(`Integration candidate is ${run.resources.candidate}: ${options.runId}`);
		}
		return await (this.dependencies.inspectMergeCandidateDiff ?? inspectMergeCandidateDiff)({
			repositoryPath: run.baseline.repositoryRoot,
			runId: run.runId,
			baselineCommit: run.baseline.headCommit,
			ref: run.integration.ref,
			expectedCommit: run.integration.commit,
			...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
			...(options.maxPaths === undefined ? {} : { maxPaths: options.maxPaths }),
			signal: options.signal,
		});
	}

	async releaseCandidate(options: DagOperatorOptions): Promise<SubagentDagRunDetails> {
		let run = this.dependencies.ledger.getDagRun(options.runId);
		if (!run) throw new Error(`Unknown DAG run: ${options.runId}`);
		if (!run.integration) throw new Error(`DAG run has no integration candidate: ${options.runId}`);
		if (run.resources.candidate === "released") return detailsFromRecord(run);
		this.dependencies.ledger.beginDagCandidateRelease(options.runId, this.now());
		const inspectRef = this.dependencies.inspectMergeCandidateRef ?? inspectMergeCandidateRef;
		const state = await inspectRef(
			run.baseline.repositoryRoot,
			run.integration.ref,
			run.integration.commit,
			options.signal,
		);
		if (state === "mismatch") throw new Error("Integration candidate ref no longer matches its persisted commit");
		if (state === "exact") {
			const released = await (this.dependencies.releaseMergeCandidateRef ?? releaseMergeCandidateRef)(
				run.baseline.repositoryRoot,
				run.integration.ref,
				run.integration.commit,
				options.signal,
			);
			if (!released) {
				const after = await inspectRef(
					run.baseline.repositoryRoot,
					run.integration.ref,
					run.integration.commit,
					options.signal,
				);
				if (after !== "absent") throw new Error("Integration candidate release lost its exact-value CAS");
			}
		}
		this.dependencies.ledger.completeDagCandidateRelease(options.runId, this.now());
		run = this.dependencies.ledger.getDagRun(options.runId)!;
		return detailsFromRecord(run);
	}

	async gc(options: DagOperatorOptions): Promise<SubagentDagRunDetails> {
		let run = this.dependencies.ledger.getDagRun(options.runId);
		if (!run) throw new Error(`Unknown DAG run: ${options.runId}`);
		if (run.resources.pins === "released") return detailsFromRecord(run);
		this.dependencies.ledger.beginDagResourceGc(options.runId, this.now());
		for (const task of run.tasks) {
			await this.workspace().reconcileTaskWorktrees(
				run.baseline.repositoryRoot,
				run.runId,
				task.taskId,
				options.signal,
			);
			await this.workspace().releaseTaskCommitPin(
				run.baseline.repositoryRoot,
				run.runId,
				task.taskId,
				task.artifact?.commit,
				options.signal,
			);
		}
		await this.workspace().releaseRunBaselinePin(
			run.baseline.repositoryRoot,
			run.runId,
			run.baseline.headCommit,
			options.signal,
		);
		this.dependencies.ledger.completeDagResourceGc(options.runId, this.now());
		run = this.dependencies.ledger.getDagRun(options.runId)!;
		return detailsFromRecord(run);
	}

	async sweepRetention(
		policy: SubagentRetentionPolicy | undefined = this.dependencies.retentionPolicy,
	): Promise<RetentionSweepResult> {
		if (!policy?.enabled)
			return { eligibleRunIds: [], collectedRunIds: [], failures: [], dryRun: policy?.dryRun ?? false };
		if (!Number.isSafeInteger(policy.minAgeMs) || policy.minAgeMs < 0) {
			throw new Error("Retention minAgeMs must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(policy.maxRunsPerSweep) || policy.maxRunsPerSweep < 1 || policy.maxRunsPerSweep > 100) {
			throw new Error("Retention maxRunsPerSweep must be between 1 and 100");
		}
		const cutoff = this.now() - policy.minAgeMs;
		const eligible = this.dependencies.ledger
			.listDagRuns({ statuses: ["succeeded", "failed", "cancelled"], limit: 100 })
			.filter(
				(run) =>
					run.updatedAt <= cutoff &&
					run.resources.pins !== "released" &&
					(run.resources.candidate === "none" || run.resources.candidate === "released") &&
					!this.activeRuns.has(run.runId),
			)
			.slice(0, policy.maxRunsPerSweep);
		const result: RetentionSweepResult = {
			eligibleRunIds: eligible.map((run) => run.runId),
			collectedRunIds: [],
			failures: [],
			dryRun: policy.dryRun ?? false,
		};
		if (result.dryRun) return result;
		for (const run of eligible) {
			try {
				await this.gc({ runId: run.runId });
				result.collectedRunIds.push(run.runId);
			} catch (error) {
				result.failures.push({ runId: run.runId, error: errorMessage(error).slice(0, 1_000) });
			}
		}
		return result;
	}

	async start(options: StartDagRunOptions): Promise<SubagentDagRunDetails> {
		if (this.shuttingDown) throw new Error("DAG orchestrator is shut down");
		const runId = (this.dependencies.createRunId ?? randomUUID)();
		const active = this.activate(runId, options.signal);
		let frozen: FrozenBaselineHandle | undefined;
		let baselinePinned = false;
		try {
			this.throwForAbort(active);
			frozen = await this.workspace().createFrozenBaseline(options.repositoryPath, {
				temporaryDirectory: this.dependencies.temporaryDirectory,
				runId,
				signal: active.controller.signal,
			});
			this.throwForAbort(active);
			await this.workspace().pinRunBaseline(
				frozen.repositoryRoot,
				runId,
				frozen.baselineCommit,
				active.controller.signal,
			);
			baselinePinned = true;
			const baseline = {
				repositoryRoot: frozen.repositoryRoot,
				headCommit: frozen.baselineCommit,
				snapshotId: createHash("sha256").update(`pi-frozen-baseline-v1\0${frozen.baselineCommit}`).digest("hex"),
				fileCount: 0,
				totalBytes: 0,
			};
			// The commit must be reachable before the temporary index which created it is removed.
			await frozen.cleanup();
			frozen = undefined;
			this.throwForAbort(active);
			this.dependencies.ledger.createDagRun({ runId, request: options.request, baseline });
			const ownerId = (this.dependencies.createOwnerId ?? ((id) => `${id}-${randomUUID()}`))(runId);
			const lease = await this.acquireLease(runId, ownerId, active);
			this.dependencies.ledger.setDagRunStatus(runId, "running", this.now(), lease);
			return await this.runPersisted(runId, active, lease, options.onProgress);
		} catch (error) {
			if (!this.dependencies.ledger.getDagRun(runId) && baselinePinned) {
				await this.workspace()
					.releaseRunBaselinePin(options.repositoryPath, runId)
					.catch(() => undefined);
			}
			if (active.interrupted && !(error instanceof DagRunInterruptedError)) {
				throw new DagRunInterruptedError("DAG run interrupted during startup", runId, undefined, { cause: error });
			}
			throw error;
		} finally {
			await frozen?.cleanup().catch(() => undefined);
			this.deactivate(active, options.signal);
		}
	}

	async expand(options: ExpandDagRunOptions): Promise<SubagentDagRunDetails> {
		if (this.shuttingDown) throw new Error("DAG orchestrator is shut down");
		if (options.signal?.aborted) {
			const error = new Error("DAG expansion cancelled");
			error.name = "AbortError";
			throw error;
		}
		if (this.activeRuns.has(options.runId)) throw new Error(`DAG run has a live controller: ${options.runId}`);
		const persisted = this.dependencies.ledger.getDagRun(options.runId);
		if (!persisted) throw new Error(`Unknown DAG run: ${options.runId}`);
		if (!persisted.awaitingExpansion) throw new Error(`DAG run is not awaiting expansion: ${options.runId}`);
		if (persisted.graphVersion !== options.expectedGraphVersion) {
			throw new Error(
				`Stale DAG graph version: expected ${options.expectedGraphVersion}, current ${persisted.graphVersion}`,
			);
		}
		const expanded = compileSubagentDagExpansion(persisted.request, options, this.dependencies.policy);
		const ownerId = (this.dependencies.createOwnerId ?? ((id) => `${id}-${randomUUID()}`))(options.runId);
		const now = this.now();
		const lease = this.dependencies.ledger.acquireDagRunLease(
			options.runId,
			ownerId,
			now,
			this.dependencies.policy.leaseDurationMs ?? 30_000,
		);
		if (!lease) throw new Error(`DAG run has a live controller lease: ${options.runId}`);
		try {
			this.dependencies.ledger.expandDagRun(
				options.runId,
				options.expectedGraphVersion,
				expanded,
				this.now(),
				lease,
			);
		} finally {
			this.dependencies.ledger.releaseDagRunLease(options.runId, lease, this.now());
		}
		return this.inspect(options.runId);
	}

	async resume(options: ResumeDagRunOptions): Promise<SubagentDagRunDetails> {
		if (this.shuttingDown) throw new Error("DAG orchestrator is shut down");
		const persisted = this.dependencies.ledger.getDagRun(options.runId);
		if (!persisted) throw new Error(`Unknown DAG run: ${options.runId}`);
		if (this.activeRuns.has(options.runId)) throw new Error(`DAG run is already active: ${options.runId}`);
		if (persisted.status === "succeeded") return detailsFromRecord(persisted);
		if (persisted.status !== "running" && persisted.status !== "created") {
			throw new SubagentDagRunError(`DAG run ${options.runId} is ${persisted.status}`, detailsFromRecord(persisted));
		}
		const active = this.activate(options.runId, options.signal);
		try {
			const ownerId = (this.dependencies.createOwnerId ?? ((id) => `${id}-${randomUUID()}`))(options.runId);
			const lease = await this.acquireLease(options.runId, ownerId, active);
			if (persisted.status === "created") {
				this.dependencies.ledger.setDagRunStatus(options.runId, "running", this.now(), lease);
			}
			this.dependencies.ledger.clearDagRunPause(options.runId, this.now(), lease);
			// Recovery is deliberately scoped to this durable run. Task worktrees are reconciled only after a claim.
			this.dependencies.ledger.recoverDagRun(options.runId, this.now(), lease);
			return await this.runPersisted(options.runId, active, lease, options.onProgress);
		} finally {
			this.deactivate(active, options.signal);
		}
	}

	private activate(runId: string, parentSignal?: AbortSignal): ActiveRun {
		if (this.activeRuns.has(runId)) throw new Error(`DAG run is already active: ${runId}`);
		const controller = new AbortController();
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const active: ActiveRun = {
			runId,
			controller,
			interrupted: false,
			userCancelled: false,
			nonInterruptible: 0,
			done,
			resolveDone,
		};
		const onAbort = (): void => {
			active.userCancelled = true;
			controller.abort();
		};
		parentSignal?.addEventListener("abort", onAbort, { once: true });
		if (parentSignal?.aborted) onAbort();
		// Keep the exact callback without another controller-side registry.
		if (parentSignal)
			(active as ActiveRun & { parentSignal: AbortSignal; onParentAbort: () => void }).parentSignal = parentSignal;
		if (parentSignal) (active as ActiveRun & { onParentAbort: () => void }).onParentAbort = onAbort;
		this.activeRuns.set(runId, active);
		return active;
	}

	private deactivate(active: ActiveRun, _parentSignal?: AbortSignal): void {
		const linked = active as ActiveRun & { parentSignal?: AbortSignal; onParentAbort?: () => void };
		linked.parentSignal?.removeEventListener("abort", linked.onParentAbort!);
		this.activeRuns.delete(active.runId);
		active.resolveDone();
	}

	private throwForAbort(active: ActiveRun, details?: SubagentDagRunDetails): void {
		if (active.interrupted)
			throw new DagRunInterruptedError("DAG run interrupted for shutdown", active.runId, details);
		if (active.controller.signal.aborted) {
			const error = new Error("DAG run cancelled");
			error.name = "AbortError";
			throw error;
		}
	}

	private now(): number {
		return (this.dependencies.now ?? Date.now)();
	}

	private renewRunLease(runId: string, runtime: Runtime): void {
		const renewed = this.dependencies.ledger.heartbeatDagRunLease(
			runId,
			runtime.lease,
			this.now(),
			this.dependencies.policy.leaseDurationMs ?? 30_000,
		);
		if (!renewed) {
			runtime.leaseLost = new Error(`Lost DAG run lease before Git mutation: ${runId}`);
			throw new DagRunInterruptedError(
				"DAG controller lease was lost before Git mutation",
				runId,
				detailsFromRecord(this.dependencies.ledger.getDagRun(runId)!),
				{ cause: runtime.leaseLost },
			);
		}
		runtime.lease = renewed;
	}

	private async acquireLease(runId: string, ownerId: string, active: ActiveRun): Promise<DagRunLease> {
		const leaseDuration = this.dependencies.policy.leaseDurationMs ?? 30_000;
		for (;;) {
			this.throwForAbort(active);
			const now = this.now();
			const lease = this.dependencies.ledger.acquireDagRunLease(runId, ownerId, now, leaseDuration);
			if (lease) return lease;
			const run = this.dependencies.ledger.getDagRun(runId);
			if (!run) throw new Error(`Unknown DAG run: ${runId}`);
			if (run.status !== "created" && run.status !== "running") {
				throw new SubagentDagRunError(`DAG run ${runId} is ${run.status}`, detailsFromRecord(run));
			}
			const delay = run.lease ? Math.max(1, Math.min(100, run.lease.leaseExpiresAt - now + 1)) : 1;
			await waitForStateChange(delay, active.controller.signal);
		}
	}

	private workspace(): DagWorkspaceOperations {
		const overrides = this.dependencies.workspace ?? {};
		return {
			createFrozenBaseline:
				this.dependencies.createFrozenBaseline ?? overrides.createFrozenBaseline ?? createFrozenBaseline,
			pinRunBaseline: this.dependencies.pinRunBaseline ?? overrides.pinRunBaseline ?? pinRunBaseline,
			releaseRunBaselinePin:
				this.dependencies.releaseRunBaselinePin ?? overrides.releaseRunBaselinePin ?? releaseRunBaselinePin,
			pinTaskCommit: this.dependencies.pinTaskCommit ?? overrides.pinTaskCommit ?? pinTaskCommit,
			releaseTaskCommitPin:
				this.dependencies.releaseTaskCommitPin ?? overrides.releaseTaskCommitPin ?? releaseTaskCommitPin,
			reconcileTaskWorktrees:
				this.dependencies.reconcileTaskWorktrees ?? overrides.reconcileTaskWorktrees ?? reconcileTaskWorktrees,
			createTaskWorktree: this.dependencies.createTaskWorktree ?? overrides.createTaskWorktree ?? createTaskWorktree,
			validateWorktreeOwnership:
				this.dependencies.validateWorktreeOwnership ??
				overrides.validateWorktreeOwnership ??
				validateWorktreeOwnership,
			createSnapshot:
				this.dependencies.createSnapshot ??
				overrides.createSnapshot ??
				(async (repositoryPath, policy, signal) =>
					await createRepositorySnapshot(repositoryPath, {
						maxSnapshotFiles: policy.maxSnapshotFiles,
						maxSnapshotBytes: policy.maxSnapshotBytes,
						temporaryDirectory: this.dependencies.temporaryDirectory,
						signal,
					})),
		};
	}

	private runner(): (options: RunChildTaskOptions) => Promise<ChildTaskResult> {
		if (this.dependencies.runTask) return this.dependencies.runTask;
		const runner = this.dependencies.runner;
		if (typeof runner === "function") return runner;
		if (runner) return (options) => runner.runTask(options);
		return runChildTask;
	}

	private quality(): (options: ValidateAndCommitWriterTaskOptions) => Promise<TaskArtifact> {
		if (this.dependencies.validateAndCommitWriterTask) return this.dependencies.validateAndCommitWriterTask;
		const quality = this.dependencies.quality;
		if (typeof quality === "function") return quality;
		if (quality) return (options) => quality.validateAndCommitWriterTask(options);
		return validateAndCommitWriterTask;
	}

	private merger(): (options: MergeCoordinatorOptions) => Promise<IntegrationArtifact> {
		if (this.dependencies.mergeTaskCommits) return this.dependencies.mergeTaskCommits;
		const merge = this.dependencies.merge;
		if (typeof merge === "function") return merge;
		if (merge) return (options) => merge.mergeTaskCommits(options);
		return mergeTaskCommits;
	}

	private emit(runId: string, callback?: (progress: DagOrchestratorProgress) => void): void {
		if (!callback) return;
		const run = this.dependencies.ledger.getDagRun(runId);
		if (!run) return;
		const progress = progressFromRecord(run);
		for (const task of progress.details.tasks) {
			const live = this.attemptRuntimes.get(runId, task.taskId);
			if (!live) continue;
			task.runtime = structuredClone(live.metadata);
			if (live.liveActivity) task.liveActivity = structuredClone(live.liveActivity);
			task.nextAction = live.metadata.nextAction ?? "wait or send task control";
		}
		try {
			callback(progress);
		} catch {
			// Progress observers are non-authoritative and must not leak a lease or
			// alter durable execution when a UI callback fails.
		}
	}

	private async runPersisted(
		runId: string,
		active: ActiveRun,
		lease: DagRunLease,
		onProgress?: (progress: DagOrchestratorProgress) => void,
	): Promise<SubagentDagRunDetails> {
		let run = this.dependencies.ledger.getDagRun(runId);
		if (!run) throw new Error(`Unknown DAG run: ${runId}`);

		const leaseDuration = this.dependencies.policy.leaseDurationMs ?? 30_000;
		const runtime: Runtime = {
			active,
			ownerId: lease.ownerId,
			lease,
			topologicalTasks: stableTopologicalOrder(run.request.tasks),
			aggregateUsage: cloneUsage(run.usage),
			aggregateTurns: run.turns,
			onProgress,
		};
		const runHeartbeat = (): void => {
			const renewed = this.dependencies.ledger.heartbeatDagRunLease(runId, runtime.lease, this.now(), leaseDuration);
			if (!renewed) {
				runtime.leaseLost = new Error(`Lost DAG run lease: ${runId}`);
				active.controller.abort();
				return;
			}
			runtime.lease = renewed;
		};
		const runHeartbeatTimer = setInterval(runHeartbeat, Math.max(1, Math.floor(leaseDuration / 3)));
		runHeartbeatTimer.unref();
		this.emit(runId, onProgress);
		const activeClaims = new Map<string, Promise<{ attemptId: string; reservedTokens: number; error?: unknown }>>();
		let activeLegacyReservation = 0;
		const drainActiveClaims = async (): Promise<void> => {
			if (activeClaims.size === 0) return;
			await Promise.all(activeClaims.values());
			activeClaims.clear();
			activeLegacyReservation = 0;
		};
		const recordSchedulerWait = (
			startedAt: number,
			finishedAt: number,
			capacity: number,
			reason: "active" | "eligibility" | "lease",
			nextEligibleAt?: number,
		): void => {
			try {
				this.dependencies.ledger.recordDagSchedulerWait(
					runId,
					{
						version: SUBAGENT_PERFORMANCE_VERSION,
						startedAt,
						finishedAt,
						capacity,
						reason,
						...(nextEligibleAt === undefined ? {} : { nextEligibleAt }),
						runnableButIdleMs:
							capacity > 0 && nextEligibleAt !== undefined
								? Math.max(0, finishedAt - Math.max(startedAt, nextEligibleAt))
								: 0,
					},
					finishedAt,
					runtime.lease,
				);
			} catch {
				// Telemetry is best-effort and cannot alter scheduler or lease outcomes.
			}
		};

		try {
			await this.recoverExternalMutationJournals(runId, runtime);
			for (;;) {
				run = this.dependencies.ledger.getDagRun(runId)!;
				if (runtime.leaseLost) {
					throw new DagRunInterruptedError("DAG controller lease was lost", runId, detailsFromRecord(run), {
						cause: runtime.leaseLost,
					});
				}
				if (active.interrupted)
					throw new DagRunInterruptedError("DAG run interrupted for shutdown", runId, detailsFromRecord(run));
				if (active.userCancelled) {
					await drainActiveClaims();
					run = this.dependencies.ledger.getDagRun(runId)!;
					return this.cancelRun(run, runtime.lease, "DAG run cancelled by user", onProgress);
				}
				if (run.status === "succeeded") return detailsFromRecord(run);
				if (run.status !== "running")
					throw new SubagentDagRunError(`DAG run ${runId} is ${run.status}`, detailsFromRecord(run));

				if (run.integrationFailure) {
					const message = `Final integration ${run.integrationFailure.reason}: ${run.integrationFailure.diagnostics}`;
					if (run.integrationFailure.reason === "cancelled") {
						return this.cancelRun(run, runtime.lease, message, onProgress);
					}
					return this.failRun(run, runtime.lease, message, onProgress);
				}
				const settled = run.tasks.every((task) => task.status !== "pending" && task.status !== "running");
				if (settled) {
					const failed = run.tasks.some((task) => ["failed", "cancelled", "blocked"].includes(task.status));
					const semanticFailure = run.tasks.find(
						(task) => task.status === "succeeded" && task.artifact?.quality.semanticOutcome !== "accepted",
					);
					if (failed || semanticFailure) {
						if (!run.graphSealed) {
							return this.failRun(run, runtime.lease, this.failureSummary(run), onProgress);
						}
						return await this.finishFailedRun(run, runtime, this.failureSummary(run), "task_failure");
					}
					if (!run.graphSealed) {
						this.dependencies.ledger.releaseDagRunLease(runId, runtime.lease, this.now());
						this.dependencies.ledger.markDagRunPaused(runId, this.now());
						const awaiting = this.dependencies.ledger.getDagRun(runId)!;
						this.emit(runId, onProgress);
						return detailsFromRecord(awaiting);
					}
					return await this.finishSuccessfulRun(run, runtime);
				}

				const limit = Math.max(1, Math.min(this.dependencies.policy.maxConcurrency, run.tasks.length));
				const persistedRunning = run.tasks.filter((task) => task.status === "running").length;
				const occupiedSlots = Math.max(persistedRunning, activeClaims.size);
				const capacity = Math.max(0, limit - occupiedSlots);
				const claims =
					capacity === 0
						? []
						: this.dependencies.ledger.claimRunnableTasks(
								runId,
								runtime.ownerId,
								this.now(),
								leaseDuration,
								capacity,
								runtime.lease,
							);
				if (claims.length > 0) {
					const budgets = this.reserveClaimBudgets(claims, runtime, activeLegacyReservation);
					for (let index = 0; index < claims.length; index++) {
						const claim = claims[index]!;
						const reservation = budgets[index]!;
						const reservedTokens = run.request.budgetScope === "task" ? 0 : reservation.budget.maxTokens;
						activeLegacyReservation += reservedTokens;
						const execution = this.processClaim(
							claim,
							reservation.budget,
							reservation.softTokenLimit,
							runtime,
						).then(
							() => ({ attemptId: claim.attemptId, reservedTokens }),
							(error: unknown) => ({ attemptId: claim.attemptId, reservedTokens, error }),
						);
						activeClaims.set(claim.attemptId, execution);
					}
					this.emit(runId, onProgress);
				}
				if (activeClaims.size > 0) {
					const waitState = this.dependencies.ledger.getDagRun(runId)!;
					const waitingOccupiedSlots = Math.max(
						waitState.tasks.filter((task) => task.status === "running").length,
						activeClaims.size,
					);
					const waitingCapacity = Math.max(0, limit - waitingOccupiedSlots);
					const eligibility = this.dependencies.ledger.nextDagTaskEligibility(runId, runtime.ownerId);
					const wakeups: Array<{ at: number; reason: "eligibility" | "lease" }> = [];
					if (waitingCapacity > 0 && eligibility.retryAt !== undefined) {
						wakeups.push({ at: eligibility.retryAt, reason: "eligibility" });
					}
					if (eligibility.foreignLeaseAt !== undefined) {
						wakeups.push({ at: eligibility.foreignLeaseAt, reason: "lease" });
					}
					wakeups.sort((left, right) => left.at - right.at || left.reason.localeCompare(right.reason));
					const nextWake = wakeups[0];
					const waitStartedAt = this.now();
					const activeSettlement = Promise.race(activeClaims.values()).then((settled) => ({
						kind: "active" as const,
						settled,
					}));
					const wakeTimer = nextWake
						? createStateChangeTimer(nextWake.at - waitStartedAt, active.controller.signal)
						: undefined;
					const winner = wakeTimer
						? await Promise.race([
								activeSettlement,
								wakeTimer.promise.then((outcome) => ({ kind: "wake" as const, outcome })),
							])
						: await activeSettlement;
					const waitFinishedAt = Math.max(waitStartedAt, this.now());
					if (winner.kind === "wake") {
						if (winner.outcome === "elapsed") {
							recordSchedulerWait(
								waitStartedAt,
								waitFinishedAt,
								waitingCapacity,
								nextWake!.reason,
								nextWake!.at,
							);
							if (nextWake!.reason === "lease") {
								this.dependencies.ledger.recoverDagRun(runId, waitFinishedAt, runtime.lease);
								const recoveredAccounting = this.dependencies.ledger.reconcileDagRunAccounting(
									runId,
									waitFinishedAt,
									runtime.lease,
								);
								runtime.aggregateUsage = recoveredAccounting.usage;
								runtime.aggregateTurns = recoveredAccounting.turns;
							}
						}
						continue;
					}
					wakeTimer?.cancel();
					recordSchedulerWait(waitStartedAt, waitFinishedAt, waitingCapacity, "active", nextWake?.at);
					const { settled } = winner;
					activeClaims.delete(settled.attemptId);
					activeLegacyReservation = Math.max(0, activeLegacyReservation - settled.reservedTokens);
					if (settled.error instanceof DagRunInterruptedError) throw settled.error;
					if (settled.error instanceof ProviderCircuitPauseError) {
						const current = this.dependencies.ledger.getDagRun(runId)!;
						const unsafeExternalWriter = current.tasks.some(
							(task) => task.role === "external-writer" && task.status === "running",
						);
						if (!unsafeExternalWriter) {
							active.interrupted = true;
							if (active.nonInterruptible === 0) active.controller.abort();
						}
						await drainActiveClaims();
						const pausedRun = this.dependencies.ledger.getDagRun(runId)!;
						if (active.userCancelled) {
							return this.cancelRun(pausedRun, runtime.lease, "DAG run cancelled by user", onProgress);
						}
						this.dependencies.ledger.releaseDagRunLease(runId, runtime.lease, this.now());
						this.dependencies.ledger.markDagRunPaused(runId, this.now());
						const paused = this.dependencies.ledger.getDagRun(runId)!;
						this.emit(runId, onProgress);
						return detailsFromRecord(paused);
					}
					if (settled.error !== undefined) {
						const current = this.dependencies.ledger.getDagRun(runId)!;
						if (active.userCancelled) {
							await drainActiveClaims();
							return this.cancelRun(current, runtime.lease, "DAG run cancelled by user", onProgress);
						}
						active.controller.abort(settled.error);
						await drainActiveClaims();
						throw settled.error;
					}
					this.emit(runId, onProgress);
					continue;
				}
				const refreshed = this.dependencies.ledger.getDagRun(runId)!;
				const idleOccupiedSlots = refreshed.tasks.filter((task) => task.status === "running").length;
				const idleCapacity = Math.max(0, limit - idleOccupiedSlots);
				const idleEligibility = this.dependencies.ledger.nextDagTaskEligibility(runId, runtime.ownerId);
				const idleWakeups: Array<{ at: number; reason: "eligibility" | "lease" }> = [];
				if (idleCapacity > 0 && idleEligibility.retryAt !== undefined) {
					idleWakeups.push({ at: idleEligibility.retryAt, reason: "eligibility" });
				}
				if (idleEligibility.foreignLeaseAt !== undefined) {
					idleWakeups.push({ at: idleEligibility.foreignLeaseAt, reason: "lease" });
				}
				idleWakeups.sort((left, right) => left.at - right.at || left.reason.localeCompare(right.reason));
				const idleWake = idleWakeups[0];
				if (idleWake) {
					const waitStartedAt = this.now();
					await waitForStateChange(Math.max(0, idleWake.at - waitStartedAt), active.controller.signal);
					if (active.controller.signal.aborted) continue;
					const waitFinishedAt = Math.max(waitStartedAt, this.now());
					recordSchedulerWait(waitStartedAt, waitFinishedAt, idleCapacity, idleWake.reason, idleWake.at);
					if (idleWake.reason === "lease") {
						this.dependencies.ledger.recoverDagRun(runId, waitFinishedAt, runtime.lease);
						const recoveredAccounting = this.dependencies.ledger.reconcileDagRunAccounting(
							runId,
							waitFinishedAt,
							runtime.lease,
						);
						runtime.aggregateUsage = recoveredAccounting.usage;
						runtime.aggregateTurns = recoveredAccounting.turns;
					}
					continue;
				}
				return this.failRun(
					refreshed,
					runtime.lease,
					"DAG run has unfinished tasks but none are runnable",
					onProgress,
				);
			}
		} finally {
			await drainActiveClaims();
			clearInterval(runHeartbeatTimer);
			const persisted = this.dependencies.ledger.getDagRun(runId);
			if (persisted?.status === "running") {
				this.dependencies.ledger.releaseDagRunLease(runId, runtime.lease, this.now());
			}
		}
	}

	private reserveClaimBudgets(
		claims: readonly DagTaskClaim[],
		runtime: Runtime,
		activeLegacyReservation = 0,
	): ClaimBudgetReservation[] {
		const run = this.dependencies.ledger.getDagRun(claims[0]!.runId)!;
		if (run.request.budgetScope === "task") {
			return claims.map((claim) => {
				const task = run.tasks.find((candidate) => candidate.taskId === claim.taskId);
				if (!task) throw new Error(`Unknown claimed task: ${claim.taskId}`);
				const usage = cloneUsage();
				let turns = 0;
				for (const attempt of task.attemptRecords) {
					addUsage(usage, attempt.usage);
					turns += attempt.turns;
				}
				const used = { turns, usage };
				const softTokenLimit = remainingSoftTokenLimit(run.request.budget, used);
				return {
					budget: remainingBudget(run.request.budget, used),
					...(softTokenLimit === undefined ? {} : { softTokenLimit }),
				};
			});
		}
		// Legacy persisted runs retain aggregate accounting and concurrent hard partitioning without new soft-limit semantics.
		const remaining = remainingBudget(run.request.budget, {
			turns: runtime.aggregateTurns,
			usage: {
				...runtime.aggregateUsage,
				totalTokens: runtime.aggregateUsage.totalTokens + activeLegacyReservation,
			},
		});
		return allocateConcurrentBudgets(remaining, claims.length).map((budget) => ({ budget }));
	}

	private transitiveArtifacts(run: LedgerDagRunRecord, task: DagTaskContract): TaskArtifact[] {
		const byId = new Map(run.tasks.map((record) => [record.taskId, record]));
		const ancestors = new Set<string>();
		const visit = (taskId: string): void => {
			if (ancestors.has(taskId)) return;
			const record = byId.get(taskId);
			if (!record) throw new Error(`Unknown dependency task: ${taskId}`);
			for (const dependency of record.contract.dependsOn) visit(dependency);
			ancestors.add(taskId);
		};
		for (const dependency of task.dependsOn) visit(dependency);
		return stableTopologicalOrder(run.request.tasks)
			.filter((candidate) => ancestors.has(candidate.id))
			.map((candidate) => {
				const artifact = byId.get(candidate.id)?.artifact;
				if (!artifact) throw new Error(`Dependency ${candidate.id} has no durable artifact`);
				return structuredClone(artifact);
			});
	}

	private async recoverExternalMutationJournals(runId: string, runtime: Runtime): Promise<void> {
		const { ledger } = this.dependencies;
		for (const source of ledger.listOpenDagExternalMutationJournals(runId)) {
			if (source.attemptStatus === "running") continue;
			const handle = openExternalMutationJournal(source.policy);
			const reader = new ExternalMutationJournalReader(handle.policy);
			reader.drain((event) => {
				ledger.recordDagExternalMutationEvent(handle.policy, event, undefined, this.now(), runtime.lease);
			});
			ledger.releaseDagExternalMutationJournal(handle.policy, undefined, this.now(), runtime.lease);
			await handle.cleanup();
		}
	}

	private async processClaim(
		claim: DagTaskClaim,
		budget: SubagentBudget,
		softTokenLimit: number | undefined,
		runtime: Runtime,
	): Promise<void> {
		const { ledger } = this.dependencies;
		const leaseDuration = this.dependencies.policy.leaseDurationMs ?? 30_000;
		const operationController = new AbortController();
		const attemptStartedAt = this.now();
		const attemptStartedMonotonic = performance.now();
		const performanceStages: Partial<Record<AttemptPerformanceStage, number>> = {};
		const addPerformanceStage = (stage: AttemptPerformanceStage, durationMs: number): void => {
			if (!Number.isFinite(durationMs) || durationMs < 0) return;
			performanceStages[stage] = (performanceStages[stage] ?? 0) + durationMs;
		};
		const measurePerformanceStage = async <T>(
			stage: AttemptPerformanceStage,
			operation: () => Promise<T>,
		): Promise<T> => {
			const startedAt = performance.now();
			try {
				return await operation();
			} finally {
				addPerformanceStage(stage, Math.max(0, performance.now() - startedAt));
			}
		};
		let childExecutionStarted = false;
		let heartbeatError: unknown;
		let latestRuntimeMetadata: ChildRuntimeMetadata | undefined;
		let lastRuntimeSeen: { generation: number; sequence: number } | undefined;
		let lastRuntimePersisted: { generation: number; sequence: number } | undefined;
		const persistRuntimeMetadata = (metadata: ChildRuntimeMetadata, force = false): void => {
			if (
				!Number.isSafeInteger(metadata.runtimeGeneration) ||
				metadata.runtimeGeneration < 1 ||
				!Number.isSafeInteger(metadata.lastEventSeq) ||
				metadata.lastEventSeq < 0
			) {
				throw new Error("Child runtime metadata has an invalid generation or sequence");
			}
			if (
				lastRuntimeSeen &&
				(metadata.runtimeGeneration < lastRuntimeSeen.generation ||
					(metadata.runtimeGeneration === lastRuntimeSeen.generation &&
						metadata.lastEventSeq < lastRuntimeSeen.sequence))
			) {
				throw new Error(`Stale child runtime metadata: ${claim.runId}/${claim.taskId}/${claim.attemptId}`);
			}
			latestRuntimeMetadata = metadata;
			lastRuntimeSeen = { generation: metadata.runtimeGeneration, sequence: metadata.lastEventSeq };
			const shouldPersist =
				force ||
				!lastRuntimePersisted ||
				metadata.runtimeGeneration > lastRuntimePersisted.generation ||
				(metadata.runtimeGeneration === lastRuntimePersisted.generation &&
					metadata.lastEventSeq - lastRuntimePersisted.sequence >= RUNTIME_METADATA_PERSIST_INTERVAL);
			if (!shouldPersist) return;
			this.repositories.attempts.recordRuntime(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				metadata,
				this.now(),
				runtime.lease,
				force,
			);
			lastRuntimePersisted = { generation: metadata.runtimeGeneration, sequence: metadata.lastEventSeq };
		};
		let lastProgressSignature = "";
		let lastProgressAt = Number.NEGATIVE_INFINITY;
		const emitRuntimeProgress = (metadata: ChildRuntimeMetadata, force = false): void => {
			const signature = [
				metadata.activity ?? "",
				metadata.nextAction ?? "",
				metadata.isStreaming === undefined ? "" : String(metadata.isStreaming),
				metadata.pendingMessageCount === undefined ? "" : String(metadata.pendingMessageCount),
			].join("\0");
			const now = this.now();
			if (!force && signature === lastProgressSignature && now - lastProgressAt < 1_000) return;
			lastProgressSignature = signature;
			lastProgressAt = now;
			this.emit(claim.runId, runtime.onProgress);
		};
		const onRunAbort = (): void => operationController.abort();
		runtime.active.controller.signal.addEventListener("abort", onRunAbort, { once: true });
		if (runtime.active.controller.signal.aborted) operationController.abort();
		const heartbeat = (): void => {
			try {
				ledger.heartbeatAttempt(
					claim.runId,
					claim.taskId,
					claim.attemptId,
					claim.ownerId,
					this.now(),
					leaseDuration,
					runtime.lease,
				);
			} catch (error) {
				heartbeatError = error;
				operationController.abort();
			}
		};
		const heartbeatTimer = setInterval(heartbeat, Math.max(1, Math.floor(leaseDuration / 3)));
		heartbeatTimer.unref();
		let worktree: WorktreeHandle | undefined;
		let snapshot: SnapshotHandle | undefined;
		let mutationJournal: ExternalMutationJournalHandle | undefined;
		let mutationJournalCleanupSafe = false;
		let result: ChildTaskResult | undefined;
		let attemptAccounting = cumulativeAttemptAccounting(claim.checkpoint, undefined);
		const resumedAvailabilityRetry = isAvailabilityRetryCheckpoint(claim.checkpoint);
		let composition: IntegrationArtifact | undefined;
		let deferredPauseBoundary = false;
		try {
			const retryFeedback = retryFeedbackFromCheckpoint(claim.checkpoint);
			const recovered = artifactReadyCheckpoint(claim.checkpoint, claim.contract);
			if (recovered) {
				let checkpointUsable = true;
				if (recovered.artifact.commit) {
					try {
						this.renewRunLease(claim.runId, runtime);
						await this.workspace().pinTaskCommit(
							this.repository(claim.runId),
							claim.runId,
							claim.taskId,
							recovered.artifact.commit,
							operationController.signal,
						);
					} catch (error) {
						if (error instanceof DagRunInterruptedError) throw error;
						checkpointUsable = false;
					}
				}
				if (checkpointUsable) {
					this.repositories.attempts.recordAccounting(
						claim.runId,
						claim.taskId,
						claim.attemptId,
						claim.ownerId,
						recovered.usage,
						recovered.turns,
						this.now(),
						runtime.lease,
					);
					const aggregate = ledger.reconcileDagRunAccounting(claim.runId, this.now(), runtime.lease);
					runtime.aggregateUsage = aggregate.usage;
					runtime.aggregateTurns = aggregate.turns;
					ledger.completeDagTask(
						claim.runId,
						claim.taskId,
						claim.attemptId,
						claim.ownerId,
						{ artifact: recovered.artifact, usage: recovered.usage, turns: recovered.turns },
						this.now(),
						runtime.lease,
					);
					return;
				}
				// The checkpoint's Git object is unavailable; rerun from the immutable baseline.
			}
			if (budgetExhausted(budget)) {
				ledger.completeDagTask(
					claim.runId,
					claim.taskId,
					claim.attemptId,
					claim.ownerId,
					{
						terminalReason: "budget_exhausted",
						error:
							ledger.getDagRun(claim.runId)?.request.budgetScope === "task"
								? "No task token budget remains for this attempt"
								: "No aggregate run budget remains for this attempt",
					},
					this.now(),
					runtime.lease,
				);
				return;
			}
			ledger.checkpointAttempt(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				{
					version: 1,
					phase: "claimed",
					attemptNumber: claim.attemptNumber,
					...(resumedAvailabilityRetry
						? {
								availabilityRetry: true,
								attemptUsage: attemptAccounting.usage,
								attemptTurns: attemptAccounting.turns,
							}
						: {}),
				},
				this.now(),
				runtime.lease,
			);
			// A pin left by a commit whose ledger completion was not acknowledged is orphaned for this new claim.
			await measurePerformanceStage("workspace_prepare", async () => {
				await this.workspace().releaseTaskCommitPin(
					this.repository(claim.runId),
					claim.runId,
					claim.taskId,
					undefined,
					operationController.signal,
				);
				await this.workspace().reconcileTaskWorktrees(
					this.repository(claim.runId),
					claim.runId,
					claim.taskId,
					operationController.signal,
				);
			});

			const run = ledger.getDagRun(claim.runId)!;
			const prerequisites = this.transitiveArtifacts(run, claim.contract);
			const writerDependencies = prerequisites
				.filter((artifact) => artifact.commit !== undefined)
				.map((artifact) => ({ taskId: artifact.taskId, commit: artifact.commit! }));
			let baseCommit = run.baseline.headCommit;
			if (writerDependencies.length > 0) {
				composition = await this.merger()({
					repositoryPath: run.baseline.repositoryRoot,
					baselineCommit: run.baseline.headCommit,
					runId: claim.runId,
					refPrefix: `pi/subagent/dependencies/${claim.taskId}`,
					taskCommits: writerDependencies,
					temporaryDirectory: this.dependencies.temporaryDirectory,
					retainRef: true,
					signal: operationController.signal,
				});
				baseCommit = composition.commit;
			}
			const preparedWorktree = await measurePerformanceStage(
				"worktree_prepare",
				async () =>
					await this.workspace().createTaskWorktree({
						repositoryPath: run.baseline.repositoryRoot,
						baselineCommit: baseCommit,
						runId: claim.runId,
						taskId: claim.taskId,
						temporaryDirectory: this.dependencies.temporaryDirectory,
						signal: operationController.signal,
					}),
			);
			worktree = preparedWorktree;
			if (composition) {
				await (this.dependencies.releaseMergeCandidateRef ?? releaseMergeCandidateRef)(
					run.baseline.repositoryRoot,
					composition.ref,
					composition.commit,
					operationController.signal,
				);
				composition = undefined;
			}
			if (claim.contract.role === "writer") {
				await this.workspace().validateWorktreeOwnership(
					preparedWorktree,
					claim.contract.ownedPaths,
					operationController.signal,
				);
			} else {
				// Reader tasks must not share a mutable materialization. Pi children run
				// under the controller UID, so filesystem mode bits alone are not an
				// isolation boundary between concurrent attempts.
				snapshot = await measurePerformanceStage(
					"snapshot_prepare",
					async () =>
						await this.workspace().createSnapshot(
							preparedWorktree.path,
							this.dependencies.policy,
							operationController.signal,
						),
				);
			}
			ledger.checkpointAttempt(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				{
					version: 1,
					phase: "running_child",
					baseCommit,
					prerequisiteArtifactIds: prerequisites.map((artifact) => artifact.artifactId),
					...(resumedAvailabilityRetry
						? {
								availabilityRetry: true,
								attemptUsage: attemptAccounting.usage,
								attemptTurns: attemptAccounting.turns,
							}
						: {}),
				},
				this.now(),
				runtime.lease,
			);
			if (claim.contract.role === "external-writer") {
				const identity = {
					runId: claim.runId,
					taskId: claim.taskId,
					attemptId: claim.attemptId,
					attemptNumber: claim.attemptNumber,
				};
				mutationJournal = claim.externalMutationJournalPath
					? openExternalMutationJournal({
							version: EXTERNAL_MUTATION_JOURNAL_VERSION,
							path: claim.externalMutationJournalPath,
							...identity,
						})
					: await createExternalMutationJournal(identity, this.dependencies.temporaryDirectory);
				ledger.registerDagExternalMutationJournal(mutationJournal.policy, claim.ownerId, this.now(), runtime.lease);
			}
			// The production runner selects prerequisite payloads through task.dependsOn. Expand that
			// view for this invocation so the child receives the complete transitive artifact set.
			const runnerTask = { ...claim.contract, dependsOn: prerequisites.map((artifact) => artifact.taskId) };
			childExecutionStarted = true;
			result = await this.runner()({
				task: runnerTask,
				budget,
				...(softTokenLimit === undefined ? {} : { softTokenLimit }),
				transport: "rpc",
				snapshotPath: snapshot?.path ?? worktree.path,
				workspaceRoot: run.baseline.repositoryRoot,
				childModel: selectedChildModel(run.request, claim.contract),
				prerequisiteArtifacts: prerequisites,
				retryFeedback,
				resumeRuntime: claim.runtime,
				controllerEnvironment: this.dependencies.controllerEnvironment,
				sandboxLauncher: this.dependencies.sandboxLauncher,
				createChildHarnessContext: this.dependencies.createChildHarnessContext,
				...(mutationJournal
					? {
							externalMutationJournal: {
								policy: mutationJournal.policy,
								onEvent: (event) => {
									try {
										ledger.recordDagExternalMutationEvent(
											mutationJournal!.policy,
											event,
											claim.ownerId,
											this.now(),
											runtime.lease,
										);
									} catch (error) {
										heartbeatError = error;
										operationController.abort();
										throw error;
									}
								},
							},
						}
					: {}),
				signal: operationController.signal,
				onRuntimeReady: (childRuntime, metadata) => {
					try {
						persistRuntimeMetadata(metadata, true);
						this.attemptRuntimes.set({
							runId: claim.runId,
							taskId: claim.taskId,
							attemptId: claim.attemptId,
							ownerId: claim.ownerId,
							runtime: childRuntime,
							metadata,
							runLease: () => runtime.lease,
						});
						emitRuntimeProgress(metadata, true);
					} catch (error) {
						heartbeatError = error;
						operationController.abort();
					}
				},
				onRuntimeEvent: (childRuntime, _event, metadata) => {
					try {
						persistRuntimeMetadata(metadata);
						this.attemptRuntimes.update(claim.runId, claim.taskId, childRuntime, metadata);
						emitRuntimeProgress(metadata);
					} catch (error) {
						heartbeatError = error;
						operationController.abort();
					}
				},
				onLiveActivity: (childRuntime, activity) => {
					this.attemptRuntimes.updateLiveActivity(claim.runId, claim.taskId, childRuntime, activity);
					this.emit(claim.runId, runtime.onProgress);
				},
				onRuntimeClosed: (childRuntime, metadata) => {
					try {
						persistRuntimeMetadata(metadata, true);
					} catch (error) {
						heartbeatError = error;
						operationController.abort();
					}
					this.attemptRuntimes.update(claim.runId, claim.taskId, childRuntime, metadata);
					this.attemptRuntimes.delete(claim.runId, claim.taskId, childRuntime);
				},
			});
			if (result.performance) {
				addPerformanceStage("child_start", result.performance.childStartMs);
				if (result.performance.firstModelEventMs !== undefined) {
					addPerformanceStage("first_model_event", result.performance.firstModelEventMs);
				}
				addPerformanceStage("model_execution", result.performance.modelExecutionMs);
				addPerformanceStage("tool_execution", result.performance.toolExecutionMs);
				addPerformanceStage("handoff", result.performance.handoffMs);
			}
			if (latestRuntimeMetadata) persistRuntimeMetadata(latestRuntimeMetadata, true);
			// Once a child has completed, do not abort quality/commit work for pause.
			// Reaching artifact_ready prevents rerunning already-paid model work.
			runtime.active.nonInterruptible++;
			deferredPauseBoundary = true;
			attemptAccounting = cumulativeAttemptAccounting(claim.checkpoint, result);
			this.repositories.attempts.recordAccounting(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				attemptAccounting.usage,
				attemptAccounting.turns,
				this.now(),
				runtime.lease,
			);
			const aggregate = ledger.reconcileDagRunAccounting(claim.runId, this.now(), runtime.lease);
			runtime.aggregateUsage = aggregate.usage;
			runtime.aggregateTurns = aggregate.turns;
			if (runtime.active.interrupted && runtime.active.controller.signal.aborted) {
				this.tryCheckpointInterrupted(claim, result, runtime);
				throw new DagRunInterruptedError(
					"DAG attempt interrupted for shutdown",
					claim.runId,
					detailsFromRecord(ledger.getDagRun(claim.runId)!),
				);
			}
			if (heartbeatError) {
				throw new DagRunInterruptedError(
					"DAG attempt lease was lost",
					claim.runId,
					detailsFromRecord(ledger.getDagRun(claim.runId)!),
					{
						cause: heartbeatError,
					},
				);
			}
			if (
				claim.role !== "external-writer" &&
				!result.success &&
				result.terminalReason === "provider_circuit_open" &&
				result.providerCircuitOpen
			) {
				const openedAt = this.now();
				const retryNotBefore = openedAt + result.providerCircuitOpen.retryDelayMs;
				if (!Number.isSafeInteger(retryNotBefore)) {
					throw new Error("Provider circuit retry eligibility exceeds the safe integer range");
				}
				ledger.openDagProviderCircuit(
					claim.runId,
					claim.taskId,
					claim.attemptId,
					claim.ownerId,
					result.providerCircuitOpen,
					attemptAccounting.usage,
					attemptAccounting.turns,
					retryNotBefore,
					openedAt,
					runtime.lease,
				);
				throw new ProviderCircuitPauseError(claim.runId, claim.taskId);
			}
			const resultAvailabilityRetry =
				claim.role !== "external-writer" &&
				!result.success &&
				decideRetry({ reason: result.terminalReason, error: result.error }).unlimited === true;
			ledger.checkpointAttempt(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				resultAvailabilityRetry
					? {
							version: 1,
							phase: "availability_retry",
							attemptUsage: attemptAccounting.usage,
							attemptTurns: attemptAccounting.turns,
						}
					: {
							version: 1,
							phase: "child_complete",
							result,
							attemptUsage: attemptAccounting.usage,
							attemptTurns: attemptAccounting.turns,
							...(resumedAvailabilityRetry ? { availabilityRetry: true } : {}),
						},
				this.now(),
				runtime.lease,
			);
			if (mutationJournal) {
				ledger.releaseDagExternalMutationJournal(mutationJournal.policy, claim.ownerId, this.now(), runtime.lease);
				mutationJournalCleanupSafe = true;
			}
			if (runtime.active.userCancelled || result.terminalReason === "cancelled") {
				if (result.runtime) await cleanupChildRuntimeRoot(result.runtime).catch(() => undefined);
				ledger.completeDagTask(
					claim.runId,
					claim.taskId,
					claim.attemptId,
					claim.ownerId,
					{
						terminalReason: "cancelled",
						error: result.error ?? "Task cancelled",
						usage: attemptAccounting.usage,
						turns: attemptAccounting.turns,
					},
					this.now(),
					runtime.lease,
				);
				return;
			}
			if (!result.success || !result.handoff) {
				const reason =
					!result.success && result.terminalReason !== "completed" ? result.terminalReason : "protocol_error";
				if (reason === "provider_circuit_open" && claim.role === "external-writer" && result.runtime) {
					await cleanupChildRuntimeRoot(result.runtime).catch(() => undefined);
				}
				if (
					reason === "budget_exhausted" &&
					result.partialHandoff &&
					result.partialHandoff.taskId === claim.taskId
				) {
					this.checkpointBudgetPartial(claim, result.partialHandoff, attemptAccounting, runtime);
				} else if (!resultAvailabilityRetry) {
					this.checkpointRetryFeedback(claim, reason, result.error, runtime, attemptAccounting);
				}
				ledger.completeDagTask(
					claim.runId,
					claim.taskId,
					claim.attemptId,
					claim.ownerId,
					{
						terminalReason: reason,
						error: result.error ?? "Child did not return a valid handoff",
						usage: attemptAccounting.usage,
						turns: attemptAccounting.turns,
					},
					this.now(),
					runtime.lease,
				);
				return;
			}
			const exceededBudget =
				run.request.budgetScope === "task"
					? result.usage.totalTokens > budget.maxTokens
					: runtime.aggregateUsage.totalTokens > run.request.budget.maxTokens;
			if (exceededBudget) {
				this.checkpointBudgetPartial(claim, result.handoff, attemptAccounting, runtime);
				ledger.completeDagTask(
					claim.runId,
					claim.taskId,
					claim.attemptId,
					claim.ownerId,
					{
						terminalReason: "budget_exhausted",
						error:
							run.request.budgetScope === "task"
								? "Child result exceeded the remaining task budget"
								: "Child result exceeded the remaining aggregate run budget",
						usage: attemptAccounting.usage,
						turns: attemptAccounting.turns,
					},
					this.now(),
					runtime.lease,
				);
				return;
			}

			let artifact: TaskArtifact;
			if (claim.contract.role === "writer") {
				artifact = await this.quality()({
					handle: worktree,
					task: claim.contract,
					handoff: result.handoff as WriterHandoff,
					registry: this.dependencies.validationRegistry ?? new ValidationRegistry([]),
					sandboxLauncher: this.dependencies.validationSandboxLauncher,
					signal: operationController.signal,
					onPerformance: addPerformanceStage,
				});
				artifact = withExecutionMetadata(artifact, result);
				if (!artifact.commit) throw new WriterQualityError("path_violation", "Writer quality returned no commit");
				this.renewRunLease(claim.runId, runtime);
				await this.workspace().pinTaskCommit(
					run.baseline.repositoryRoot,
					claim.runId,
					claim.taskId,
					artifact.commit,
					operationController.signal,
				);
			} else if (claim.contract.role === "external-writer") {
				const externalMutations =
					ledger
						.getDagRun(claim.runId)
						?.tasks.find((task) => task.taskId === claim.taskId)
						?.attemptRecords.find((attempt) => attempt.attemptId === claim.attemptId)?.externalMutations ?? [];
				artifact = await createExternalWriterArtifact({
					task: claim.contract,
					handoff: result.handoff as ExternalWriterHandoff,
					externalMutations,
				});
				artifact = withExecutionMetadata(artifact, result);
			} else {
				artifact = readOnlyArtifact(claim.contract, result, this.now(), prerequisites);
			}
			if (runtime.active.interrupted && runtime.active.controller.signal.aborted) {
				this.tryCheckpointInterrupted(claim, { result, artifact }, runtime);
				throw new DagRunInterruptedError(
					"DAG attempt interrupted for shutdown",
					claim.runId,
					detailsFromRecord(ledger.getDagRun(claim.runId)!),
				);
			}
			ledger.checkpointAttempt(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				{
					version: 1,
					phase: "artifact_ready",
					artifact,
					attemptUsage: attemptAccounting.usage,
					attemptTurns: attemptAccounting.turns,
				},
				this.now(),
				runtime.lease,
			);
			ledger.completeDagTask(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				{
					artifact,
					usage: attemptAccounting.usage,
					turns: attemptAccounting.turns,
				},
				this.now(),
				runtime.lease,
			);
		} catch (error) {
			if (error instanceof ProviderCircuitPauseError) throw error;
			const abortingInterruption = runtime.active.interrupted && runtime.active.controller.signal.aborted;
			if (abortingInterruption) {
				this.tryCheckpointInterrupted(claim, { result, stageError: errorMessage(error) }, runtime);
			}
			if (abortingInterruption || error instanceof DagRunInterruptedError || heartbeatError) {
				throw error instanceof DagRunInterruptedError
					? error
					: new DagRunInterruptedError(
							"DAG attempt interrupted",
							claim.runId,
							detailsFromRecord(ledger.getDagRun(claim.runId)!),
							{
								cause: heartbeatError ?? error,
							},
						);
			}
			const current = ledger.getDagRun(claim.runId)?.tasks.find((task) => task.taskId === claim.taskId);
			if (current?.status === "running" && current.activeAttemptId === claim.attemptId) {
				const reason = runtime.active.userCancelled ? "cancelled" : terminalReason(error);
				if (runtime.active.userCancelled && result?.runtime) {
					await cleanupChildRuntimeRoot(result.runtime).catch(() => undefined);
				}
				const diagnostic = writerRetryDiagnostic(error);
				this.checkpointRetryFeedback(claim, reason, diagnostic, runtime, attemptAccounting);
				ledger.completeDagTask(
					claim.runId,
					claim.taskId,
					claim.attemptId,
					claim.ownerId,
					{
						terminalReason: reason,
						error: diagnostic,
						...(result ? { usage: attemptAccounting.usage, turns: attemptAccounting.turns } : {}),
					},
					this.now(),
					runtime.lease,
				);
			}
		} finally {
			if (childExecutionStarted) {
				try {
					const finishedAt = Math.max(attemptStartedAt, this.now());
					addPerformanceStage("attempt_wall", Math.max(0, performance.now() - attemptStartedMonotonic));
					const attempt = ledger
						.getDagRun(claim.runId)
						?.tasks.find((task) => task.taskId === claim.taskId)
						?.attemptRecords.find((candidate) => candidate.attemptId === claim.attemptId);
					const persistedReason = attempt?.terminalReason;
					const reason =
						persistedReason ??
						(runtime.active.userCancelled
							? "cancelled"
							: runtime.active.interrupted
								? "interrupted"
								: result && !result.success && result.terminalReason !== "completed"
									? result.terminalReason
									: "process_error");
					ledger.recordDagAttemptPerformance(
						claim.runId,
						claim.taskId,
						claim.attemptId,
						claim.ownerId,
						{
							version: SUBAGENT_PERFORMANCE_VERSION,
							attemptId: claim.attemptId,
							attemptNumber: claim.attemptNumber,
							role: claim.role,
							startedAt: attemptStartedAt,
							finishedAt,
							success: reason === "completed",
							terminalReason: reason,
							stages: performanceStages,
						},
						finishedAt,
						runtime.lease,
					);
				} catch {
					// Telemetry is best-effort and cannot alter task, quality, or lease outcomes.
				}
			}
			if (deferredPauseBoundary) {
				runtime.active.nonInterruptible--;
				if (runtime.active.interrupted && runtime.active.nonInterruptible === 0) {
					runtime.active.controller.abort();
				}
			}
			clearInterval(heartbeatTimer);
			runtime.active.controller.signal.removeEventListener("abort", onRunAbort);
			await snapshot?.cleanup().catch(() => undefined);
			await worktree?.cleanup().catch(() => undefined);
			if (mutationJournal && mutationJournalCleanupSafe) {
				await mutationJournal.cleanup().catch(() => undefined);
			}
			if (composition) {
				await (this.dependencies.releaseMergeCandidateRef ?? releaseMergeCandidateRef)(
					this.repository(claim.runId),
					composition.ref,
					composition.commit,
				).catch(() => undefined);
			}
		}
	}

	private checkpointBudgetPartial(
		claim: DagTaskClaim,
		handoff: NonNullable<ChildTaskResult["handoff"]>,
		accounting: InterruptedAttemptAccounting,
		runtime: Runtime,
	): void {
		this.dependencies.ledger.checkpointAttempt(
			claim.runId,
			claim.taskId,
			claim.attemptId,
			claim.ownerId,
			{
				version: 1,
				phase: "budget_exhausted_partial",
				partialHandoff: asInconclusivePartialHandoff(handoff),
				attemptUsage: accounting.usage,
				attemptTurns: accounting.turns,
			},
			this.now(),
			runtime.lease,
		);
	}

	private checkpointRetryFeedback(
		claim: DagTaskClaim,
		reason: Exclude<TaskTerminalReason, "completed">,
		error: unknown,
		runtime: Runtime,
		accounting: InterruptedAttemptAccounting,
	): void {
		const decision = decideRetry({ reason, error });
		const checkpoint =
			decision.unlimited === true && claim.role !== "external-writer"
				? {
						version: 1,
						phase: "availability_retry",
						attemptUsage: accounting.usage,
						attemptTurns: accounting.turns,
					}
				: decision.feedback
					? { version: 1, phase: "retry_pending", feedback: decision.feedback }
					: undefined;
		if (!checkpoint) return;
		this.dependencies.ledger.checkpointAttempt(
			claim.runId,
			claim.taskId,
			claim.attemptId,
			claim.ownerId,
			checkpoint,
			this.now(),
			runtime.lease,
		);
	}

	private tryCheckpointInterrupted(claim: DagTaskClaim, value: unknown, runtime: Runtime): void {
		try {
			const payload =
				value && typeof value === "object" && !Array.isArray(value)
					? (value as Record<string, unknown>)
					: undefined;
			const nested = payload?.result;
			const candidate =
				nested && typeof nested === "object" && !Array.isArray(nested)
					? (nested as Record<string, unknown>)
					: payload;
			const childResult =
				candidate &&
				validUsage(candidate.usage) &&
				Number.isSafeInteger(candidate.turns) &&
				Number(candidate.turns) >= 0
					? (candidate as unknown as ChildTaskResult)
					: undefined;
			const accounting = cumulativeAttemptAccounting(claim.checkpoint, childResult);
			this.repositories.attempts.recordAccounting(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				accounting.usage,
				accounting.turns,
				this.now(),
				runtime.lease,
			);
			const aggregate = this.dependencies.ledger.reconcileDagRunAccounting(claim.runId, this.now(), runtime.lease);
			runtime.aggregateUsage = aggregate.usage;
			runtime.aggregateTurns = aggregate.turns;
			this.dependencies.ledger.checkpointAttempt(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				{
					version: 1,
					phase: "interrupted",
					value,
					attemptUsage: accounting.usage,
					attemptTurns: accounting.turns,
				},
				this.now(),
				runtime.lease,
			);
		} catch {
			// Lease recovery remains authoritative if shutdown races expiry.
		}
	}

	private repository(runId: string): string {
		const run = this.dependencies.ledger.getDagRun(runId);
		if (!run) throw new Error(`Unknown DAG run: ${runId}`);
		return run.baseline.repositoryRoot;
	}

	private async finishFailedRun(
		run: LedgerDagRunRecord,
		runtime: Runtime,
		message: string,
		reason: "task_failure" | "candidate_quality_failure",
		completeGateFailures: readonly CandidateQuality["gateFailures"][number][] = [],
		failedPinTaskIds: readonly string[] = [],
	): Promise<never> {
		if (run.request.merge.enabled && !run.integration && !run.integrationFailure) {
			const byId = new Map(run.tasks.map((task) => [task.taskId, task]));
			const failedPins = new Set(failedPinTaskIds);
			const included: Array<{ contract: DagTaskContract; artifact: TaskArtifact }> = [];
			const omittedWriterTasks: Array<{ taskId: string; reason: PartialCandidateOmissionReason }> = [];
			for (const contract of runtime.topologicalTasks) {
				if (contract.role !== "writer") continue;
				const task = byId.get(contract.id);
				const artifact = task?.artifact;
				let omission: PartialCandidateOmissionReason | undefined;
				if (task?.status !== "succeeded" || !artifact) omission = "task_not_succeeded";
				else if (artifact.quality.semanticOutcome !== "accepted") omission = "semantic_not_accepted";
				else if (artifact.quality.pathAudit !== "passed") omission = "path_audit_not_passed";
				else if (
					contract.validationCommandIds.length === 0 ||
					artifact.quality.validation.status !== "passed" ||
					!contract.validationCommandIds.every((commandId) =>
						artifact.validations.some((result) => result.commandId === commandId && result.status === "passed"),
					)
				) {
					omission = "validation_not_passed";
				} else if (!artifact.commit) omission = "commit_missing";
				else if (failedPins.has(contract.id)) omission = "commit_pin_failed";
				if (omission) {
					omittedWriterTasks.push({ taskId: contract.id, reason: omission });
					continue;
				}
				if (!artifact?.commit) throw new Error(`Eligible Partial Candidate Writer ${contract.id} has no commit`);
				this.throwForAbort(runtime.active, detailsFromRecord(run));
				try {
					this.renewRunLease(run.runId, runtime);
					await this.workspace().pinTaskCommit(
						run.baseline.repositoryRoot,
						run.runId,
						contract.id,
						artifact.commit!,
						runtime.active.controller.signal,
					);
					included.push({ contract, artifact });
				} catch (error) {
					if (error instanceof DagRunInterruptedError) throw error;
					this.throwForAbort(runtime.active, detailsFromRecord(run));
					omittedWriterTasks.push({ taskId: contract.id, reason: "commit_pin_failed" });
				}
			}
			if (included.length > 0) {
				const includedWriterIds = new Set(included.map(({ contract }) => contract.id));
				const qualityTasks = runtime.topologicalTasks.flatMap((contract) => {
					const task = byId.get(contract.id);
					if (task?.status !== "succeeded" || !task.artifact) return [];
					if (contract.role === "writer" && !includedWriterIds.has(contract.id)) return [];
					return [{ contract, artifact: task.artifact }];
				});
				const negativeTasks = runtime.topologicalTasks.flatMap((contract): PartialCandidateNegativeTask[] => {
					const task = byId.get(contract.id);
					if (!task) return [];
					const semanticOutcome = task.artifact?.quality.semanticOutcome;
					if (task.status === "failed" || task.status === "cancelled" || task.status === "blocked") {
						return [
							{
								taskId: task.taskId,
								status: task.status,
								...(task.terminalReason ? { terminalReason: task.terminalReason } : {}),
								...(semanticOutcome === "rejected" || semanticOutcome === "inconclusive"
									? { semanticOutcome }
									: {}),
							},
						];
					}
					if (semanticOutcome === "rejected" || semanticOutcome === "inconclusive") {
						return [{ taskId: task.taskId, status: task.status, semanticOutcome }];
					}
					return [];
				});
				const includedWriterTaskIds = included.map(({ contract }) => contract.id);
				const quality = evaluatePartialCandidateQuality(qualityTasks, includedWriterTaskIds);
				let unpersistedCandidate: IntegrationArtifact | undefined;
				try {
					this.renewRunLease(run.runId, runtime);
					const merged = await this.merger()({
						repositoryPath: run.baseline.repositoryRoot,
						baselineCommit: run.baseline.headCommit,
						runId: run.runId,
						refPrefix: run.request.merge.refPrefix,
						taskCommits: included.map(({ contract, artifact }) => ({
							taskId: contract.id,
							commit: artifact.commit!,
						})),
						temporaryDirectory: this.dependencies.temporaryDirectory,
						retainRef: true,
						signal: runtime.active.controller.signal,
					});
					unpersistedCandidate = merged;
					const integration: IntegrationArtifact = {
						...merged,
						kind: "partial",
						quality,
						partial: {
							reason,
							completeGateFailures: [...completeGateFailures],
							trust: "controller_validated",
							includedWriterTaskIds,
							omittedWriterTasks,
							negativeTasks,
						},
					};
					this.dependencies.ledger.recordDagIntegration(run.runId, integration, this.now(), runtime.lease);
					unpersistedCandidate = undefined;
				} catch (error) {
					let integrationError = error;
					if (unpersistedCandidate) {
						try {
							await (this.dependencies.releaseMergeCandidateRef ?? releaseMergeCandidateRef)(
								run.baseline.repositoryRoot,
								unpersistedCandidate.ref,
								unpersistedCandidate.commit,
							);
						} catch (cleanupError) {
							integrationError = new AggregateError(
								[error, cleanupError],
								"Partial Candidate persistence failed and its ref could not be released",
							);
						}
					}
					if (runtime.active.interrupted) {
						throw new DagRunInterruptedError(
							"DAG Partial Candidate integration interrupted",
							run.runId,
							detailsFromRecord(this.dependencies.ledger.getDagRun(run.runId)!),
							{ cause: integrationError },
						);
					}
					this.dependencies.ledger.recordDagIntegrationFailure(
						run.runId,
						integrationFailure(integrationError, this.now()),
						this.now(),
						runtime.lease,
					);
					if (runtime.active.userCancelled) {
						return this.cancelRun(
							this.dependencies.ledger.getDagRun(run.runId)!,
							runtime.lease,
							"DAG run cancelled by user",
							runtime.onProgress,
						);
					}
					return this.failRun(
						this.dependencies.ledger.getDagRun(run.runId)!,
						runtime.lease,
						`${message}; Partial Candidate integration failed: ${errorMessage(integrationError)}`,
						runtime.onProgress,
					);
				}
			}
		}
		if (runtime.active.interrupted) {
			throw new DagRunInterruptedError(
				"DAG run interrupted before durable failure",
				run.runId,
				detailsFromRecord(this.dependencies.ledger.getDagRun(run.runId)!),
			);
		}
		if (runtime.active.userCancelled) {
			return this.cancelRun(
				this.dependencies.ledger.getDagRun(run.runId)!,
				runtime.lease,
				"DAG run cancelled by user",
				runtime.onProgress,
			);
		}
		return this.failRun(this.dependencies.ledger.getDagRun(run.runId)!, runtime.lease, message, runtime.onProgress);
	}

	private async finishSuccessfulRun(run: LedgerDagRunRecord, runtime: Runtime): Promise<SubagentDagRunDetails> {
		let integration = run.integration;
		if (run.request.merge.enabled && !integration) {
			const byId = new Map(run.tasks.map((task) => [task.taskId, task]));
			const qualityTasks = runtime.topologicalTasks.map((contract) => {
				const artifact = byId.get(contract.id)?.artifact;
				if (!artifact) throw new Error(`Succeeded task ${contract.id} has no durable artifact`);
				return { contract, artifact };
			});
			const commits = qualityTasks.flatMap(({ contract, artifact }) =>
				artifact.commit ? [{ taskId: contract.id, commit: artifact.commit }] : [],
			);
			try {
				const pinnedWriterTaskIds: string[] = [];
				const pinErrors: Array<{ taskId: string; error: string }> = [];
				for (const { contract, artifact } of qualityTasks) {
					if (contract.role !== "writer" || !artifact.commit) continue;
					this.throwForAbort(runtime.active, detailsFromRecord(run));
					try {
						this.renewRunLease(run.runId, runtime);
						await this.workspace().pinTaskCommit(
							run.baseline.repositoryRoot,
							run.runId,
							contract.id,
							artifact.commit,
							runtime.active.controller.signal,
						);
						pinnedWriterTaskIds.push(contract.id);
					} catch (error) {
						this.throwForAbort(runtime.active, detailsFromRecord(run));
						pinErrors.push({ taskId: contract.id, error: errorMessage(error) });
					}
				}
				const quality = evaluateCandidateQuality(qualityTasks, pinnedWriterTaskIds);
				if (quality.gate === "failed") {
					return await this.finishFailedRun(
						this.dependencies.ledger.getDagRun(run.runId)!,
						runtime,
						qualityGateDiagnostics(quality, pinErrors),
						"candidate_quality_failure",
						quality.gateFailures,
						pinErrors.map((failure) => failure.taskId),
					);
				}
				this.renewRunLease(run.runId, runtime);
				integration = await this.merger()({
					repositoryPath: run.baseline.repositoryRoot,
					baselineCommit: run.baseline.headCommit,
					runId: run.runId,
					refPrefix: run.request.merge.refPrefix,
					taskCommits: commits,
					temporaryDirectory: this.dependencies.temporaryDirectory,
					retainRef: true,
					signal: runtime.active.controller.signal,
				});
				integration = { ...integration, quality };
				// Persist the candidate before observing cancellation so a returned ref is never unmanaged.
				this.dependencies.ledger.recordDagIntegration(run.runId, integration, this.now(), runtime.lease);
			} catch (error) {
				if (runtime.active.interrupted) {
					throw new DagRunInterruptedError(
						"DAG final integration interrupted",
						run.runId,
						detailsFromRecord(this.dependencies.ledger.getDagRun(run.runId)!),
						{ cause: error },
					);
				}
				if (error instanceof SubagentDagRunError) throw error;
				this.dependencies.ledger.recordDagIntegrationFailure(
					run.runId,
					integrationFailure(error, this.now()),
					this.now(),
					runtime.lease,
				);
				if (runtime.active.userCancelled) {
					return this.cancelRun(
						this.dependencies.ledger.getDagRun(run.runId)!,
						runtime.lease,
						"DAG run cancelled by user",
						runtime.onProgress,
					);
				}
				return this.failRun(
					this.dependencies.ledger.getDagRun(run.runId)!,
					runtime.lease,
					`Final integration failed: ${errorMessage(error)}`,
					runtime.onProgress,
				);
			}
		}
		if (runtime.active.interrupted) {
			throw new DagRunInterruptedError(
				"DAG run interrupted before durable success",
				run.runId,
				detailsFromRecord(this.dependencies.ledger.getDagRun(run.runId)!),
			);
		}
		if (runtime.active.userCancelled) {
			return this.cancelRun(
				this.dependencies.ledger.getDagRun(run.runId)!,
				runtime.lease,
				"DAG run cancelled by user",
				runtime.onProgress,
			);
		}
		const aggregate = this.dependencies.ledger.reconcileDagRunAccounting(run.runId, this.now(), runtime.lease);
		runtime.aggregateUsage = aggregate.usage;
		runtime.aggregateTurns = aggregate.turns;
		this.dependencies.ledger.setDagRunStatus(run.runId, "succeeded", this.now(), runtime.lease);
		const succeeded = this.dependencies.ledger.getDagRun(run.runId)!;
		this.emit(run.runId, runtime.onProgress);
		// Baseline and accepted task pins remain durable artifact roots until an explicit future GC operation.
		return detailsFromRecord(succeeded);
	}

	private cancelRun(
		run: LedgerDagRunRecord,
		lease: DagRunLease,
		message: string,
		onProgress?: (progress: DagOrchestratorProgress) => void,
	): never {
		if (run.status === "running" || run.status === "created") {
			this.dependencies.ledger.setDagRunStatus(run.runId, "cancelled", this.now(), lease);
		}
		const current = this.dependencies.ledger.getDagRun(run.runId)!;
		this.emit(run.runId, onProgress);
		throw new SubagentDagRunError(message, detailsFromRecord(current));
	}

	private failRun(
		run: LedgerDagRunRecord,
		lease: DagRunLease,
		message: string,
		onProgress?: (progress: DagOrchestratorProgress) => void,
	): never {
		if (run.status === "running" || run.status === "created") {
			this.dependencies.ledger.setDagRunStatus(run.runId, "failed", this.now(), lease);
		}
		const current = this.dependencies.ledger.getDagRun(run.runId)!;
		this.emit(run.runId, onProgress);
		throw new SubagentDagRunError(message, detailsFromRecord(current));
	}

	private failureSummary(run: LedgerDagRunRecord): string {
		const failures = run.tasks.flatMap((task) => {
			if (["failed", "cancelled", "blocked"].includes(task.status)) {
				return [`${task.taskId}: ${task.terminalReason ?? task.status}${task.error ? ` (${task.error})` : ""}`];
			}
			const outcome = task.artifact?.quality.semanticOutcome;
			return outcome && outcome !== "accepted" ? [`${task.taskId}: semantic outcome ${outcome}`] : [];
		});
		return `Subagent DAG run failed: ${failures.join("; ")}`;
	}
}
