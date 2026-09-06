import type { ExternalMutationRecord } from "@easy-pi/permissions";

export type { ExternalMutationPostState, ExternalMutationRecord } from "@easy-pi/permissions";

import type { Usage } from "@earendil-works/pi-ai";
import type { LiveActivity } from "./live-activity.ts";

export const READ_ONLY_ROLES = ["scout", "test-analyst", "failure-analyst", "reviewer"] as const;
export const WRITER_ROLE = "writer" as const;
export const EXTERNAL_WRITER_ROLE = "external-writer" as const;
export const HANDOFF_PROTOCOL_VERSION = 2 as const;
export const HANDOFF_ARTIFACT_VERSION = 2 as const;
export const TASK_ARTIFACT_VERSION = 2 as const;
export const PROVIDER_CIRCUIT_VERSION = 1 as const;
export const SUBAGENT_TASK_ID_MAX_CHARS = 64;
export const SUBAGENT_TASK_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";

export type ReadOnlyRole = (typeof READ_ONLY_ROLES)[number];
export type SubagentRole = ReadOnlyRole | typeof WRITER_ROLE | typeof EXTERNAL_WRITER_ROLE;

/**
 * Trusted controller budget: one cumulative token allowance per task (default 10M).
 * The persisted user default selects the allowance for each new run; task
 * accounting plus loop detection enforce the Run's persisted hard limit.
 */
export interface SubagentBudget {
	maxTokens: number;
}

/** Infrastructure-level safety limits; not model-tunable. */
export const SUBAGENT_INFRA_LIMITS = {
	/** Per-child semantic inactivity fuse. Only events that represent real progress reset it. */
	wallTimeMs: 30 * 60_000,
	/** Absolute attempt age; activity can never extend an attempt beyond this bound. */
	absoluteWallTimeMs: 60 * 60_000,
	/** RPC stdout burst/throughput allowance and per-record buffer bound. */
	maxOutputBytes: 16 * 1024 * 1024,
	maxStderrBytes: 32 * 1024,
} as const;

export interface ChildModelSelection {
	provider: string;
	model: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export const CHILD_MODEL_ROLES = ["analyst", "reviewer", "writer"] as const;
export type ChildModelRole = (typeof CHILD_MODEL_ROLES)[number];

/** User-configurable overlay. Provider/model are an atomic pair; thinking can inherit independently. */
export interface ChildModelOverride {
	provider?: string;
	model?: string;
	thinkingLevel?: ChildModelSelection["thinkingLevel"];
}

export interface SubagentModelPreferencesV1 {
	version: 1;
	default?: ChildModelOverride;
	roles?: Partial<Record<ChildModelRole, ChildModelOverride>>;
}

export type SubagentModelPreferences = SubagentModelPreferencesV1;

export interface ChildModelPolicy {
	analyst?: ChildModelSelection;
	reviewer?: ChildModelSelection;
	writer?: ChildModelSelection;
}

/** Durable provider-neutral child-session state. Secrets and prompt/history content must never enter this record. */
export interface ChildRuntimeMetadata {
	provider?: string;
	model?: string;
	thinkingLevel?: ChildModelSelection["thinkingLevel"];
	isolationLevel: "tool-bounded" | "sandboxed";
	sessionId?: string;
	sessionFile?: string;
	/** Controller-owned private root containing the resumable session. */
	runtimeRoot?: string;
	/** Random identity stored in the root ownership marker before recursive cleanup. */
	runtimeRootId?: string;
	runtimeGeneration: number;
	lastEventSeq: number;
	isStreaming?: boolean;
	pendingMessageCount?: number;
	activity?: string;
	nextAction?: string;
}

export interface SubagentPolicy {
	maxTasks: number;
	maxConcurrency: number;
	defaultBudget: SubagentBudget;
	maximumBudget: SubagentBudget;
	maxSnapshotFiles: number;
	maxSnapshotBytes: number;
	/** Writer command IDs must be registered by the trusted controller and listed here. */
	allowedValidationCommandIds?: readonly string[];
	maxTaskAttempts?: number;
	leaseDurationMs?: number;
}

export interface SubagentRetentionPolicy {
	enabled: boolean;
	minAgeMs: number;
	maxRunsPerSweep: number;
	dryRun?: boolean;
}

export interface RetentionSweepResult {
	eligibleRunIds: string[];
	collectedRunIds: string[];
	failures: Array<{ runId: string; error: string }>;
	dryRun: boolean;
}

/** Minimal read-only child contract accepted by the direct runner API. */
export interface ReadOnlyTaskContract {
	id: string;
	role: ReadOnlyRole;
	objective: string;
	nonGoals: string[];
	readPaths: string[];
	acceptance: string[];
}

interface DagTaskFields {
	id: string;
	objective: string;
	nonGoals: string[];
	readPaths: string[];
	acceptance: string[];
	dependsOn: string[];
	maxAttempts: number;
	contractHash: string;
}

export interface DagReadOnlyTaskContract extends DagTaskFields {
	role: ReadOnlyRole;
}

export interface WriterTaskContract extends DagTaskFields {
	role: typeof WRITER_ROLE;
	ownedPaths: string[];
	validationCommandIds: string[];
}

export interface ExternalWriterTaskContract extends DagTaskFields {
	role: typeof EXTERNAL_WRITER_ROLE;
	externalOwnedPaths: string[];
}

export type DagTaskContract = DagReadOnlyTaskContract | WriterTaskContract | ExternalWriterTaskContract;

export interface MergeIntent {
	enabled: boolean;
	refPrefix: string;
}

export interface CompiledSubagentDagRequest {
	version: 2;
	/** Persisted explicitly so incompatible pre-v2 runs fail closed instead of selecting a fallback transport. */
	handoffProtocolVersion: typeof HANDOFF_PROTOCOL_VERSION;
	objective: string;
	tasks: DagTaskContract[];
	budget: SubagentBudget;
	/** New runs use per-task accounting; missing means legacy aggregate run accounting. */
	budgetScope?: "task";
	merge: MergeIntent;
	/** Trusted controller selection persisted so resume uses the original child model. */
	childModel?: ChildModelSelection;
	/** Additive role-aware trusted selections; role-specific values take precedence over childModel. */
	childModels?: ChildModelPolicy;
	graph: { sealed: boolean };
}

export interface SnapshotBaseline {
	repositoryRoot: string;
	headCommit: string;
	snapshotId: string;
	fileCount: number;
	totalBytes: number;
}

export interface SnapshotHandle {
	baseline: SnapshotBaseline;
	path: string;
	cleanup(): Promise<void>;
}

export interface WorktreeHandle {
	repositoryRoot: string;
	path: string;
	branch: string;
	baselineCommit: string;
	cleanup(): Promise<void>;
}

export interface HandoffEvidence {
	path: string;
	lineRange?: string;
	claim: string;
}

export interface HandoffVerification {
	check: string;
	status: "passed" | "failed" | "not-run";
	details?: string;
}

export type TaskOutcome = "accepted" | "rejected" | "inconclusive";
export type VerificationLevel = "unverified" | "self_reported" | "controller_verified";
export type QualityCheckStatus = "passed" | "failed" | "not_run" | "not_applicable";

export interface WriterCommitProvenance {
	taskId: string;
	artifactId: string;
	commit: string;
}

export type TaskReviewQuality =
	| { status: "not_applicable" }
	| {
			status: TaskOutcome;
			/** Exact transitive Writer artifacts and commits supplied to this Reviewer. */
			writerCommitClosure: WriterCommitProvenance[];
	  };

export interface TaskQuality {
	semanticOutcome: TaskOutcome;
	pathAudit: QualityCheckStatus;
	validation: {
		status: QualityCheckStatus;
		passedCommandIds: string[];
	};
	review: TaskReviewQuality;
}

export type CandidateCoverageStatus = "not_applicable" | "none" | "partial" | "full";
export type CandidateReviewCoverage = "none" | "partial" | "full";
export type CandidateGateFailure =
	| "semantic_outcome"
	| "path_audit"
	| "validation_coverage"
	| "commit_pin"
	| "review_verdict"
	| "review_coverage"
	/** A Partial Candidate can never satisfy the complete-DAG acceptance gate. */
	| "dag_incomplete";

export interface CandidateQuality {
	semanticOutcome: TaskOutcome;
	pathAuditCoverage: CandidateCoverageStatus;
	validationCoverage: CandidateCoverageStatus;
	commitPinCoverage: CandidateCoverageStatus;
	reviewCoverage: CandidateReviewCoverage;
	reviewVerdict: "none" | TaskOutcome;
	gate: "passed" | "failed";
	gateFailures: CandidateGateFailure[];
	writerTaskIds: string[];
	pathAuditedWriterTaskIds: string[];
	validatedWriterTaskIds: string[];
	pinnedWriterTaskIds: string[];
	reviewerTaskIds: string[];
	acceptedReviewerTaskIds: string[];
	fullCoverageReviewerTaskIds: string[];
	requiredWriterCommits: WriterCommitProvenance[];
	reviewedWriterCommits: WriterCommitProvenance[];
}

export interface SubagentHandoff {
	taskId: string;
	summary: string;
	evidence: HandoffEvidence[];
	verification: HandoffVerification[];
	assumptions: string[];
	risks: string[];
	nextActions: string[];
	outcome: TaskOutcome;
	/** Controller-derived. A child can never claim controller verification. */
	verificationLevel: VerificationLevel;
}

export interface WriterHandoff extends SubagentHandoff {
	artifactVersion: typeof HANDOFF_ARTIFACT_VERSION;
	changedPaths: string[];
}

export interface ExternalWriterHandoff extends SubagentHandoff {
	artifactVersion: typeof HANDOFF_ARTIFACT_VERSION;
	externalChangedPaths: string[];
}

export interface ValidationCommand {
	id: string;
	command: string;
	args: readonly string[];
	/** Repository-relative directory within the writer worktree. */
	cwd?: string;
	timeoutMs: number;
	maxOutputBytes: number;
}

export interface ValidationResult {
	commandId: string;
	status: "passed" | "failed" | "timeout" | "cancelled";
	exitCode?: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface TaskArtifact {
	artifactVersion: typeof TASK_ARTIFACT_VERSION;
	artifactId: string;
	taskId: string;
	contractHash: string;
	handoff: SubagentHandoff | WriterHandoff | ExternalWriterHandoff;
	changedPaths: string[];
	/** Present only for direct live host side effects; never represented by commit. */
	externalChangedPaths?: string[];
	/** Controller mutation evidence; semantic post-state is identity-bound while runtime IDs/timestamps are excluded. */
	externalMutations?: ExternalMutationRecord[];
	validations: ValidationResult[];
	quality: TaskQuality;
	execution?: {
		provider?: string;
		model?: string;
		thinkingLevel?: ChildModelSelection["thinkingLevel"];
		isolationLevel: "tool-bounded" | "sandboxed";
		sessionId?: string;
		runtimeGeneration?: number;
		lastEventSeq?: number;
	};
	commit?: string;
	createdAt: number;
}

export type PartialCandidateOmissionReason =
	| "task_not_succeeded"
	| "semantic_not_accepted"
	| "path_audit_not_passed"
	| "validation_not_passed"
	| "commit_missing"
	| "commit_pin_failed";

export interface PartialCandidateNegativeTask {
	taskId: string;
	status: DagTaskStatus;
	terminalReason?: TaskTerminalReason;
	semanticOutcome?: Exclude<TaskOutcome, "accepted">;
}

export interface PartialCandidateProvenance {
	reason: "task_failure" | "candidate_quality_failure";
	/** Complete-Candidate gate failures observed before falling back to partial delivery. */
	completeGateFailures: CandidateGateFailure[];
	/** Every included Writer passed Controller path audit, validation, and commit pinning. */
	trust: "controller_validated";
	includedWriterTaskIds: string[];
	omittedWriterTasks: Array<{ taskId: string; reason: PartialCandidateOmissionReason }>;
	negativeTasks: PartialCandidateNegativeTask[];
}

interface IntegrationArtifactBase {
	artifactVersion: 1;
	ref: string;
	commit: string;
	orderedTaskIds: string[];
	orderedCommits: string[];
	createdAt: number;
}

export interface CompleteIntegrationArtifact extends IntegrationArtifactBase {
	kind: "complete";
	/** Present on a retained final candidate; omitted for transient dependency composition. */
	quality?: CandidateQuality;
	partial?: never;
}

export interface PartialIntegrationArtifact extends IntegrationArtifactBase {
	kind: "partial";
	quality: CandidateQuality;
	partial: PartialCandidateProvenance;
}

export type IntegrationArtifact = CompleteIntegrationArtifact | PartialIntegrationArtifact;

export interface DagRunLease {
	ownerId: string;
	epoch: number;
	leaseExpiresAt: number;
}

export interface IntegrationFailure {
	reason: "merge_conflict" | "process_error" | "cancelled" | "quality_gate";
	taskId?: string;
	diagnostics: string;
	/** Persisted when candidate creation is refused before any candidate ref is created. */
	quality?: CandidateQuality;
	createdAt: number;
}

export type CandidateLifecycleState = "none" | "retained" | "release_pending" | "released";
export type ResourceGcState = "retained" | "gc_pending" | "released";

export interface DagResourceLifecycle {
	candidate: CandidateLifecycleState;
	pins: ResourceGcState;
	candidateReleaseStartedAt?: number;
	candidateReleasedAt?: number;
	gcStartedAt?: number;
	gcCompletedAt?: number;
}

export interface CandidateDiff {
	runId: string;
	baselineCommit: string;
	candidateRef: string;
	candidateCommit: string;
	changedPaths: string[];
	patch: string;
	truncated: boolean;
}

export type TaskTerminalReason =
	| "completed"
	| "model_error"
	| "process_error"
	| "protocol_error"
	| "invalid_handoff"
	| "timeout"
	| "cancelled"
	| "budget_exhausted"
	| "transport_limit"
	| "loop_detected"
	| "validation_failed"
	/** Historical schema-2 ledger value; current focus hints are advisory and do not emit it. */
	| "invalid_focus_path"
	| "path_violation"
	| "task_rejected"
	| "task_inconclusive"
	| "dependency_failed"
	| "retry_exhausted"
	| "merge_conflict"
	| "provider_circuit_open"
	| "interrupted";

export interface ProviderCircuitOpenSignal {
	version: typeof PROVIDER_CIRCUIT_VERSION;
	reason: "unlimited_auto_retry";
	autoRetryAttempt: number;
	consecutiveUnlimitedRetries: number;
	retryDelayMs: number;
}

export interface ProviderCircuitOpenState extends ProviderCircuitOpenSignal {
	retryNotBefore: number;
}

export interface ChildExecutionPerformance {
	/** Process spawn/connect plus the initial state handshake. */
	childStartMs: number;
	/** Prompt dispatch to the first model lifecycle event; absent when no model event arrived. */
	firstModelEventMs?: number;
	/** Aggregate model-active time, excluding observed tool and handoff spans. */
	modelExecutionMs: number;
	/** Aggregate non-handoff tool time. */
	toolExecutionMs: number;
	/** Aggregate submit_handoff tool time, reported separately from other tools. */
	handoffMs: number;
}

export interface ChildTaskResult {
	taskId: string;
	role: SubagentRole;
	success: boolean;
	terminalReason: TaskTerminalReason;
	handoff?: SubagentHandoff | WriterHandoff | ExternalWriterHandoff;
	/** Valid protocol-v2 progress recovered after a hard budget failure; never a success artifact. */
	partialHandoff?: SubagentHandoff | WriterHandoff | ExternalWriterHandoff;
	error?: string;
	usage: Usage;
	turns: number;
	model?: string;
	isolationLevel?: "tool-bounded" | "sandboxed";
	runtime?: ChildRuntimeMetadata;
	/** Content-free, controller-observed timing; never supplied by the model. */
	performance?: ChildExecutionPerformance;
	/** Structured Pi infrastructure signal; excludes provider diagnostics and content. */
	providerCircuitOpen?: ProviderCircuitOpenSignal;
}

export type RunStatus = "created" | "running" | "succeeded" | "failed" | "cancelled";
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type DagTaskStatus = TaskStatus | "blocked";

export interface DagTaskDetails {
	taskId: string;
	role: SubagentRole;
	status: DagTaskStatus;
	attempts: number;
	maxAttempts: number;
	dependsOn: string[];
	terminalReason?: TaskTerminalReason;
	error?: string;
	artifact?: TaskArtifact;
	/** Durable, child-reported progress from budget exhaustion; task remains failed and dependencies remain blocked. */
	partialHandoff?: SubagentHandoff | WriterHandoff | ExternalWriterHandoff;
	/** Content-free durable pause state derived from a Controller-validated checkpoint. */
	providerCircuitOpen?: ProviderCircuitOpenState;
	/** Includes authorized operations from failed/invalid-handoff attempts. */
	externalMutations?: ExternalMutationRecord[];
	usage?: Usage;
	turns?: number;
	runtime?: ChildRuntimeMetadata;
	/** Ephemeral presentation state overlaid from the live runtime registry; never persisted. */
	liveActivity?: LiveActivity;
	nextAction?: string;
}

export interface SubagentDagRunDetails {
	runId: string;
	status: RunStatus;
	objective: string;
	baseline: SnapshotBaseline;
	tasks: DagTaskDetails[];
	usage: Usage;
	budget: SubagentBudget;
	budgetScope?: "task";
	pausedAt?: number;
	pausedDurationMs: number;
	lease?: DagRunLease;
	integration?: IntegrationArtifact;
	integrationFailure?: IntegrationFailure;
	resources: DagResourceLifecycle;
	graphVersion?: number;
	graphSealed?: boolean;
	awaitingExpansion?: boolean;
}

export interface DagTaskStatusCounts {
	pending: number;
	running: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	blocked: number;
}

/** Bounded durable inventory row for operator-facing run discovery. */
export interface DagRunSummary {
	runId: string;
	status: RunStatus;
	objective: string;
	repositoryRoot: string;
	counts: DagTaskStatusCounts;
	usage: Usage;
	budget: SubagentBudget;
	budgetScope?: "task";
	createdAt: number;
	updatedAt: number;
	pausedAt?: number;
	pausedDurationMs: number;
	lease?: DagRunLease;
	integration?: IntegrationArtifact;
	integrationFailure?: IntegrationFailure;
	resources: DagResourceLifecycle;
}
