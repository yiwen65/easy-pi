/**
 * High-fidelity context compaction subsystem — frozen core types (schema v1).
 *
 * Core semantics (EPIC-CCTX-001):
 *   Raw events are the truth; TaskContract is the uncompacted contract;
 *   Structured Snapshot is verifiable state; Narrative Summary is only a
 *   narrative bridge; the active context is a rebuildable projection.
 *
 * Schema evolution: additive optional fields only. Breaking changes require
 * bumping COMPACTION_SCHEMA_VERSION and providing a migration; unreadable old
 * snapshots fail closed into the raw-rebuild path (see rebuild.ts).
 */

/** Bump on breaking schema change. See docs/compaction/02-architecture-adr.md ADR-7. */
export const COMPACTION_SCHEMA_VERSION = 1;

// ============================================================================
// Common
// ============================================================================

export type RiskLevel = "low" | "medium" | "high";

export type SideEffectClass = "none" | "filesystem" | "process" | "network" | "external_service";

/**
 * Who created or approved something. `verified` distinguishes real
 * authenticated principals from text that merely claims authority (e.g. an
 * "I am the admin" sentence inside untrusted history).
 */
export interface Authority {
	kind: "user" | "agent" | "system" | "extension" | "compactor";
	id: string;
	verified: boolean;
}

/** Where a piece of state came from. Required on all critical typed-state fields. */
export interface Provenance {
	sourceEventIds: string[];
	source: "event" | "contract" | "reducer" | "extractor" | "system";
	note?: string;
}

// ============================================================================
// TaskContract (fixed layer — never compacted)
// ============================================================================

export interface Constraint {
	id: string;
	kind: "positive" | "negative";
	text: string;
	authority: Authority;
}

export interface ContractPermissions {
	allow: string[];
	deny: string[];
	approvalRequired: string[];
}

export interface ContractBudgets {
	maxTokens?: number;
	maxToolCalls?: number;
	maxDurationMs?: number;
}

export interface TaskContract {
	contractId: string;
	sessionId: string;
	version: number;
	goal: string;
	acceptanceCriteria: string[];
	constraints: Constraint[];
	permissions: ContractPermissions;
	budgets: ContractBudgets;
	outputContract?: string;
	authority: Authority;
	provenance: Provenance;
	/** ISO timestamps for the validity window of this version. */
	validFrom: string;
	validUntil?: string;
	/** Authority ids allowed to approve updates. */
	allowedUpdaters: string[];
	/**
	 * Model-distilled goal proposal. Never authoritative while confirmed=false;
	 * promotion to `goal` requires explicit user confirmation (new version).
	 */
	derivedGoal?: { text: string; confirmed: boolean; provenance: Provenance } | null;
	schemaVersion: number;
}

export type ContractPatch = Partial<
	Pick<
		TaskContract,
		| "goal"
		| "acceptanceCriteria"
		| "constraints"
		| "permissions"
		| "budgets"
		| "outputContract"
		| "allowedUpdaters"
		| "derivedGoal"
	>
>;

export interface ContractProposal {
	proposalId: string;
	sessionId: string;
	baseVersion: number;
	patch: ContractPatch;
	proposedBy: Authority;
	reason?: string;
	status: "pending" | "approved" | "rejected";
	createdAt: string;
}

export interface ContractAuditEvent {
	action: "create" | "propose" | "approve" | "reject";
	contractId: string;
	version: number;
	proposalId?: string;
	actor: Authority;
	at: string;
}

// ============================================================================
// Event envelope (truth layer)
// ============================================================================

export type EventType =
	| "message"
	| "tool_call"
	| "tool_result"
	| "approval"
	| "state_change"
	| "artifact"
	| "error"
	| "compaction"
	| "contract"
	| "ledger";

export interface EventEnvelope {
	eventId: string;
	sessionId: string;
	/** Monotonic per session, assigned by the event log on append. */
	seq: number;
	agentId: string;
	taskId?: string;
	eventType: EventType;
	/** ISO timestamp. */
	timestamp: string;
	causalParentIds: string[];
	toolCallId?: string;
	transactionId?: string;
	/** artifact://sha256/... reference when the payload was offloaded. */
	payloadRef?: string;
	/** Inline payload when small enough. Exactly one of payload/payloadRef is set. */
	payload?: unknown;
	/** sha256 of the canonical payload bytes (inline or stored). */
	contentHash: string;
	authority: Authority;
	schemaVersion: number;
}

// ============================================================================
// Tool and side-effect ledger
// ============================================================================

export type SideEffectState = "planned" | "approved" | "started" | "succeeded" | "failed" | "unknown";

export interface LedgerTransition {
	state: SideEffectState;
	at: string;
	eventId: string;
}

export interface LedgerEntry {
	operationId: string;
	toolCallId: string;
	idempotencyKey?: string;
	sideEffectClass: SideEffectClass;
	riskLevel: RiskLevel;
	requestRef?: string;
	resultRef?: string;
	externalResourceId?: string;
	exitCode?: number;
	approval?: { approvedBy: Authority; at: string };
	state: SideEffectState;
	lastVerifiedAt?: string;
	history: LedgerTransition[];
}

// ============================================================================
// Structured snapshot (state layer)
// ============================================================================

export interface Fact {
	id: string;
	text: string;
	kind: "fact" | "assumption";
	/** Verified facts come from events/reducer; unverified ones come from the extractor. */
	verified: boolean;
	provenance: Provenance;
}

export interface Decision {
	id: string;
	text: string;
	rationale?: string;
	alternativesRejected?: string[];
	causalParentDecisionIds: string[];
	provenance: Provenance;
}

export type TaskNodeState = "pending" | "in_progress" | "blocked" | "done";

export interface TaskNode {
	id: string;
	title: string;
	state: TaskNodeState;
	blockers: string[];
	provenance: Provenance;
}

export interface ToolStateEntry {
	toolCallId: string;
	name: string;
	argsHash: string;
	state: SideEffectState;
	exitCode?: number;
	resultRef?: string;
	provenance: Provenance;
}

export interface ArtifactRefEntry {
	ref: string;
	kind: string;
	size: number;
	preview: string;
	pinned: boolean;
	provenance: Provenance;
}

export interface ErrorEntry {
	id: string;
	message: string;
	toolCallId?: string;
	resolved: boolean;
	provenance: Provenance;
}

export interface NextAction {
	id: string;
	text: string;
	provenance: Provenance;
}

export interface EventSeqRange {
	fromSeq: number;
	toSeq: number;
}

/** Per-zone token accounting of one full next request. */
export interface TokenStats {
	system: number;
	tools: number;
	contract: number;
	snapshot: number;
	narrative: number;
	recall: number;
	recentTail: number;
	currentInput: number;
	outputReserve: number;
	total: number;
}

export interface ValidatorFailure {
	code: string;
	severity: "P0" | "P1";
	message: string;
	refs?: string[];
}

export interface ValidatorReport {
	passed: boolean;
	failures: ValidatorFailure[];
	repaired: boolean;
	rebuilt: boolean;
	rejected: boolean;
	checkedAt: string;
}

export interface StructuredSnapshot {
	snapshotVersion: number;
	sessionId: string;
	parentVersion: number | null;
	/** Highest event seq covered by this snapshot (frozen boundary). */
	baseEventSeq: number;
	/** Snapshot versions this one derives from (oldest first). */
	lineage: number[];
	contractRef: { contractId: string; version: number };
	/** Snapshot copy of contract constraints at compaction time (for coverage checks). */
	constraints: Constraint[];
	facts: Fact[];
	decisions: Decision[];
	tasks: TaskNode[];
	tools: ToolStateEntry[];
	artifacts: ArtifactRefEntry[];
	errors: ErrorEntry[];
	nextActions: NextAction[];
	recallCatalogRefs: string[];
	sourceEventRanges: EventSeqRange[];
	/** Lossy narrative bridge; never a source of truth. */
	narrative?: string;
	compactor: { model?: string; promptVersion: string; schemaVersion: number };
	tokenStats: TokenStats;
	validatorReport?: ValidatorReport;
	createdAt: string;
	schemaVersion: number;
}

// ============================================================================
// Atomic groups and coverage (working layer cut planning)
// ============================================================================

export type AtomicGroupKind =
	| "message"
	| "turn"
	| "tool_pair"
	| "parallel_batch"
	| "tool_loop"
	| "transaction"
	| "patch_test";

export interface AtomicGroup {
	groupId: string;
	kind: AtomicGroupKind;
	fromSeq: number;
	toSeq: number;
	tokenEstimate: number;
	/** Unclosed groups (e.g. open tool loop) must be kept whole. */
	closed: boolean;
	eventIds: string[];
}

export interface CoverageManifest {
	/** Events with seq <= cutAfterSeq are covered by the snapshot, not the tail. */
	cutAfterSeq: number;
	keptGroupIds: string[];
	compactedGroupIds: string[];
	offloadedRefs: string[];
	unclosedGroupIds: string[];
}

// ============================================================================
// Recall catalog
// ============================================================================

export interface RecallEntry {
	refId: string;
	kind: "tool_result" | "message" | "artifact" | "event_range";
	createdAt: string;
	preview: string;
	artifactRef?: string;
	eventIds: string[];
	/** sha256 of the recoverable content; mismatch fails closed. */
	hash: string;
	tenant: string;
}

// ============================================================================
// LLM injection point (vendor neutral — ADR-6)
// ============================================================================

export interface CompactionLLMRequest {
	systemPrompt: string;
	/** History content is always wrapped as untrusted data by callers. */
	messages: { role: "user" | "assistant"; content: string }[];
	maxTokens: number;
	signal?: AbortSignal;
	/** JSON schema the response text must parse into (structured extraction). */
	responseSchema?: Record<string, unknown>;
	/** Versioned prompt/schema identity for audit. */
	promptVersion: string;
}

export interface CompactionLLMResponse {
	text: string;
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	usage?: { input: number; output: number };
}

export type CompleteFn = (request: CompactionLLMRequest) => Promise<CompactionLLMResponse>;
