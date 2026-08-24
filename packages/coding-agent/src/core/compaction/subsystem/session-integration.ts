/**
 * CCTX-080: AgentSession integration host for the high-fidelity compaction
 * subsystem.
 *
 * The host owns one set of subsystem stores per session and exposes a narrow
 * API to AgentSession: record messages as events, evaluate the single trigger
 * policy, attempt compaction, rebuild active messages, and exact recall.
 * Unexpected subsystem errors fail closed; no legacy summary fallback exists.
 *
 * Feature flags (任务书 CCTX-080):
 *   offload_only            — deterministic offload only, no LLM
 *   structured_compaction   — full typed-snapshot pipeline without narrative
 *   full_pipeline           — typed snapshot + narrative bridge
 * AgentSession defaults to full_pipeline; explicit mode "off" disables the host.
 */

import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { contentText, type RetryCallbacks, type RetryPolicy } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { createCompactionSummaryMessage } from "../../messages.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "../../session-manager.ts";
import { completeSummarization } from "../compaction.ts";
import { type ArtifactStore, FileSystemArtifactStore, InMemoryArtifactStore } from "./artifact-store.ts";
import {
	BranchScopedEventLog,
	type ColdMessageRef,
	type EventLog,
	InMemoryEventLog,
	JsonlEventLog,
	sessionEntriesToEvents,
} from "./event-log.ts";
import { type GoalChangeOutcome, interpretGoalChange } from "./goal-interpreter.ts";
import { canonicalJson, sha256Hex } from "./hashing.ts";
import {
	COMPACTOR_POLICY_VERSION,
	COMPACTOR_SYSTEM_POLICY,
	detectInjections,
	wrapUntrusted,
} from "./injection-guard.ts";
import { AuditTrail } from "./observability.ts";
import { CompactionOrchestrator, type CompactResult, type OrchestratorDeps } from "./orchestrator.ts";
import { estimateRecoverableToolTokens, type OffloadPolicy } from "./payload-offload.ts";
import { buildPrompt, type PromptSection, renderPinnedLedgerLayer } from "./prompt-builder.ts";
import { rawRebuild } from "./rebuild.ts";
import {
	JsonlRecallPersister,
	RecallCatalog,
	type RecallSearchHit,
	type RecallSearchOptions,
} from "./recall-catalog.ts";
import {
	reconcileTaskContract as buildReconciliationReport,
	countSubstantiveUserEvents,
	type ReconciliationReport,
	verifyReconciliationReport,
} from "./reconciliation.ts";
import { InMemorySnapshotStore, JsonlSnapshotStore, type SnapshotStore } from "./snapshot-store.ts";
import { InMemoryContractStore, JsonlContractStore } from "./task-contract.ts";
import { type PendingGoalChange, replayTaskLedger, type TaskLedger } from "./task-ledger.ts";
import { replayLedger, ToolLedger } from "./tool-ledger.ts";
import { evaluateTriggers, type TriggerAction, type TriggerDecision } from "./trigger.ts";
import type {
	Authority,
	CompleteFn,
	RecallEntry,
	StructuredSnapshot,
	TokenStats,
	ZoneProjectionStats,
} from "./types.ts";

export type HfCompactionMode = "off" | "shadow" | "offload_only" | "structured_compaction" | "full_pipeline";

/** Read the feature flag from the environment. Returns undefined when unset (caller applies the default). */
export function getHfCompactionModeFromEnv(
	env: Record<string, string | undefined> = process.env,
): HfCompactionMode | undefined {
	const raw = env.PI_HF_COMPACTION;
	if (
		raw === "off" ||
		raw === "shadow" ||
		raw === "offload_only" ||
		raw === "structured_compaction" ||
		raw === "full_pipeline"
	) {
		return raw;
	}
	return undefined;
}

export interface HfTriggerEvaluation {
	decision: TriggerDecision;
	predictedNextRequestTokens: number;
	tokenEstimateProvenance: "provider_projection" | "provider_projection_with_recent_usage_floor";
	recoverableToolTokens: number;
	compactionCooldownRemaining: number;
	incrementalCompactionsSinceRebuild: number;
}

export interface ContextInspection {
	mode: HfCompactionMode;
	snapshotVersion: number;
	projectionKind: NonNullable<StructuredSnapshot["compactor"]["kind"]>;
	baseEventSeq: number;
	triggerEventSeq?: number;
	tailEventCount: number;
	toolsTokenEstimate: number;
	tokenStats: TokenStats;
	projectionStats: ZoneProjectionStats[];
	sections: PromptSection[];
	recallEntries: Array<Pick<RecallEntry, "refId" | "kind" | "preview" | "eventIds">>;
	systemPrompt?: { text: string; tokens: number };
}

export interface HfCompactionConfig {
	mode: HfCompactionMode;
	/** Compactor LLM. Tests inject a faux; production uses createPiAiCompleteFn per attempt. */
	complete?: CompleteFn;
	/** Optional independent Goal Interpreter injection; production falls back to the compactor adapter. */
	goalComplete?: CompleteFn;
	/** Interpret post-initial user turns into task-ledger proposals. Disabled unless explicitly enabled. */
	taskInterpretationEnabled?: boolean;
	/** Independent semantic reconciler injection; tests use a deterministic empty report. */
	reconcileComplete?: CompleteFn;
	/** Periodic semantic reconciliation. Disabled unless explicitly enabled. */
	reconciliationEnabled?: boolean;
	reconciliationIntervalTurns?: number;
	tenant?: string;
	keepRecentTokens?: number;
	outputReserveTokens?: number;
	minTokenGainFraction?: number;
	/** Payloads above this many bytes are offload candidates. Default 2000. */
	offloadThresholdBytes?: number;
	/** Reverse budget: newest N tool results stay inline. Default 1. */
	keepRecentToolResults?: number;
	/**
	 * Per-session durable state directory. When set, events/artifacts/contracts/
	 * snapshots persist under it; otherwise everything is in-memory.
	 */
	stateDir?: string;
	/** Overrides derived from stateDir (tests). */
	eventLogDir?: string;
	artifactDir?: string;
}

/** Local CLI user is the verified principal for contract creation. */
const LOCAL_USER = { kind: "user", id: "local-user", verified: true } as const;

/** Truncate a derived goal at a sentence/clause boundary, never mid-word. */
function truncateGoalText(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = text.slice(0, max);
	const lastStop = Math.max(
		head.lastIndexOf(". "),
		head.lastIndexOf("。"),
		head.lastIndexOf("; "),
		head.lastIndexOf(", "),
	);
	return lastStop > 40 ? head.slice(0, lastStop + 1) : `${head.trimEnd()}…`;
}

const RECALL_GUIDE_TEXT =
	"Use recall_search(query, kind?, limit?) to discover content published by the active branch snapshot, then recall_exact(refId) to restore it.";

function formatActivatedSummary(input: {
	action: Exclude<TriggerAction, "none">;
	snapshotVersion: number | undefined;
	tokensBefore: number | undefined;
	tokensAfter: number | undefined;
	offloadedBytes: number | undefined;
	narrative?: string;
}): string {
	const lines = [
		`[high-fidelity snapshot v${input.snapshotVersion ?? "unknown"} activated]`,
		`action: ${input.action}`,
	];
	if (input.tokensBefore !== undefined && input.tokensAfter !== undefined) {
		const changePercent =
			input.tokensBefore > 0 ? ((input.tokensBefore - input.tokensAfter) / input.tokensBefore) * 100 : 0;
		const changeLabel =
			changePercent >= 0
				? `${changePercent.toFixed(1)}% reduction`
				: `${Math.abs(changePercent).toFixed(1)}% increase`;
		lines.push(
			`tokens: ${input.tokensBefore.toLocaleString()} → ${input.tokensAfter.toLocaleString()} (${changeLabel})`,
		);
	}
	if (input.offloadedBytes !== undefined) {
		lines.push(`offloaded ${input.offloadedBytes} bytes`);
	}
	if (input.narrative?.trim()) {
		lines.push("", input.narrative.trim());
	}
	return lines.join("\n");
}

export class HfCompactionHost {
	readonly snapshotStore: SnapshotStore;
	readonly artifactStore: ArtifactStore;
	readonly contractStore: InMemoryContractStore | JsonlContractStore;
	readonly recallCatalog: RecallCatalog;
	readonly audit = new AuditTrail();
	/** Side-effect ledger (CCTX-013), replayed from the active branch view. */
	ledger: ToolLedger;
	/** Versioned task ledger (T-401), replayed from task events in the active branch view. */
	taskLedger: TaskLedger;
	/** Stable branch view over one durable append-only event log. */
	readonly eventLog: BranchScopedEventLog;

	private readonly sessionId: string;
	private readonly getSystemPrompt: () => string;
	private readonly config: HfCompactionConfig;
	private readonly tenant: string;
	private branchPathSignature = "";
	private contractReady = false;
	private goalDistilled = false;
	private readonly getToolsTokenEstimate: (() => number) | undefined;

	constructor(options: {
		sessionId: string;
		getSystemPrompt: () => string;
		config: HfCompactionConfig;
		/** Token estimate of the tool definitions sent with the next provider request. */
		getToolsTokenEstimate?: () => number;
	}) {
		this.sessionId = options.sessionId;
		this.getSystemPrompt = options.getSystemPrompt;
		this.config = options.config;
		this.tenant = options.config.tenant ?? "local";
		const stateDir = options.config.stateDir;
		const durableEventLog: EventLog = options.config.eventLogDir
			? new JsonlEventLog(options.config.eventLogDir)
			: stateDir
				? new JsonlEventLog(join(stateDir, "events"))
				: new InMemoryEventLog();
		this.eventLog = new BranchScopedEventLog(durableEventLog, this.sessionId, {
			onOrphan: (event) =>
				this.audit.record("branch_orphan_event", this.sessionId, {
					eventId: event.eventId.slice(0, 120),
					eventType: event.eventType,
				}),
		});
		this.artifactStore = stateDir
			? new FileSystemArtifactStore(join(stateDir, "artifacts"))
			: new InMemoryArtifactStore();
		this.contractStore = stateDir ? new JsonlContractStore(join(stateDir, "contracts")) : new InMemoryContractStore();
		this.snapshotStore = stateDir ? new JsonlSnapshotStore(join(stateDir, "snapshots")) : new InMemorySnapshotStore();
		this.recallCatalog = new RecallCatalog({
			store: this.artifactStore,
			tenant: this.tenant,
			persister: stateDir ? new JsonlRecallPersister(join(stateDir, "recall.jsonl")) : undefined,
		});
		this.getToolsTokenEstimate = options.getToolsTokenEstimate;
		this.taskLedger = replayTaskLedger([], {
			eventLog: this.eventLog,
			sessionId: this.sessionId,
			strictEventSourceValidation: true,
		});
		this.ledger = new ToolLedger({ eventLog: this.eventLog, sessionId: this.sessionId, agentId: "agent-local" });
	}

	private static readonly TOOL_RISK: Record<
		string,
		{ sideEffectClass: "none" | "filesystem" | "process"; riskLevel: "low" | "medium" | "high" }
	> = {
		bash: { sideEffectClass: "process", riskLevel: "high" },
		edit: { sideEffectClass: "filesystem", riskLevel: "medium" },
		write: { sideEffectClass: "filesystem", riskLevel: "medium" },
		read: { sideEffectClass: "none", riskLevel: "low" },
		grep: { sideEffectClass: "none", riskLevel: "low" },
		find: { sideEffectClass: "none", riskLevel: "low" },
		ls: { sideEffectClass: "none", riskLevel: "low" },
		recall_exact: { sideEffectClass: "none", riskLevel: "low" },
		recall_search: { sideEffectClass: "none", riskLevel: "low" },
	};

	/** Record a tool execution start in the ledger (planned + started). Never throws. */
	/** Record a tool execution start in the ledger (planned + started).
	 * Throws on ledger rejection: the caller must treat that as a dispatch gate,
	 * never as a best-effort mirror. */
	recordToolStarted(toolCallId: string, toolName: string, args: unknown): void {
		const classification = HfCompactionHost.TOOL_RISK[toolName] ?? {
			// Unknown tools are conservatively treated as side-effecting/high risk.
			sideEffectClass: "process" as const,
			riskLevel: "high" as const,
		};
		const argsHash = sha256Hex(canonicalJson(args ?? {}));
		this.ledger.recordPlanned({
			operationId: `op-${toolCallId}`,
			toolCallId,
			// A provider tool-call id identifies one logical operation. Identical
			// arguments in a later call are a new operation, not a replay.
			idempotencyKey: `${toolName}:${toolCallId}:${argsHash.slice(0, 16)}`,
			sideEffectClass: classification.sideEffectClass,
			riskLevel: classification.riskLevel,
			authority: LOCAL_USER,
		});
		this.ledger.recordStarted(toolCallId);
	}

	/** Record a tool execution outcome durably; persistence failure is observable. */
	recordToolFinished(toolCallId: string, isError: boolean): void {
		if (isError) {
			this.ledger.recordFailed(toolCallId, {});
		} else {
			this.ledger.recordSucceeded(toolCallId, { exitCode: 0 });
		}
	}

	/** Mark in-flight operations unknown on abort (interrupted side effects are never replayed blindly). */
	recordInflightUnknown(reason: string): void {
		try {
			for (const entry of this.ledger.list()) {
				if (entry.state === "started" || entry.state === "planned" || entry.state === "approved") {
					this.ledger.recordUnknown(entry.toolCallId, reason);
				}
			}
		} catch {
			// ignore
		}
	}

	/** Contract operations: the local CLI user is the verified principal. */
	getContract() {
		return this.contractStore.getActive(this.sessionId);
	}

	setContract(input: {
		goal: string;
		constraints: { id: string; kind: "positive" | "negative"; text: string }[];
		permissions?: { allow: string[]; deny: string[]; approvalRequired: string[] };
		budgets?: { maxTokens?: number; maxToolCalls?: number; maxDurationMs?: number };
		outputContract?: string;
	}) {
		const existing = this.contractStore.getActive(this.sessionId);
		if (existing) {
			throw new Error(
				`Contract already exists for session ${this.sessionId} (v${existing.version}); use updateContract`,
			);
		}
		const contract = this.contractStore.create({
			contractId: `contract-${this.sessionId}`,
			sessionId: this.sessionId,
			goal: input.goal,
			acceptanceCriteria: [],
			constraints: input.constraints.map((c) => ({ ...c, authority: LOCAL_USER })),
			permissions: input.permissions ?? { allow: [], deny: [], approvalRequired: [] },
			budgets: input.budgets ?? {},
			outputContract: input.outputContract,
			authority: LOCAL_USER,
			allowedUpdaters: [LOCAL_USER.id],
		});
		this.contractReady = true;
		return contract;
	}

	/** Authorized update by the local user: creates a new version with audit. */
	updateContract(
		patch: Omit<Parameters<InMemoryContractStore["proposeUpdate"]>[1], "constraints"> & {
			constraints?: { id: string; kind: "positive" | "negative"; text: string }[];
		},
		reason?: string,
	) {
		const normalized = {
			...patch,
			constraints: patch.constraints?.map((c) => ({ ...c, authority: LOCAL_USER })),
		};
		const proposal = this.contractStore.proposeUpdate(this.sessionId, normalized, LOCAL_USER, reason);
		return this.contractStore.approveProposal(this.sessionId, proposal.proposalId, LOCAL_USER);
	}

	/** Unverified update attempts only ever become proposals. */
	proposeContractUpdate(
		patch: Parameters<InMemoryContractStore["proposeUpdate"]>[1],
		proposedBy: Authority,
		reason?: string,
	) {
		return this.contractStore.proposeUpdate(this.sessionId, patch, proposedBy, reason);
	}

	/**
	 * Distill the current task into a clear goal sentence via the compactor and
	 * store it as an UNCONFIRMED derivedGoal (never the authority field).
	 * Injection-flagged output is dropped entirely.
	 */
	private async maybeDistillGoal(entries: SessionEntry[], complete: CompleteFn, signal?: AbortSignal): Promise<void> {
		if (this.goalDistilled) return;
		const active = this.contractStore.getActive(this.sessionId);
		if (!active || active.derivedGoal || active.version !== 1) return;
		this.goalDistilled = true;
		const substantive = entries
			.filter((e) => e.type === "message" && e.message.role === "user")
			.map((e) => (e.type === "message" && e.message.role === "user" ? contentText(e.message.content, "") : ""))
			.map((t) => t.replace(/\s+/g, " ").trim())
			.filter((t) => t.length >= 8 && !t.startsWith("/"));
		if (substantive.length === 0) return;
		const recent = substantive.slice(-3).join("\n");
		try {
			signal?.throwIfAborted();
			const response = await complete({
				systemPrompt: COMPACTOR_SYSTEM_POLICY,
				messages: [
					{
						role: "user",
						content: `${wrapUntrusted(recent)}\n\nState the user's current task goal in a single clear sentence. Output only the sentence.`,
					},
				],
				maxTokens: 200,
				promptVersion: COMPACTOR_POLICY_VERSION,
				signal,
			});
			signal?.throwIfAborted();
			if (response.stopReason !== "stop") return;
			const text = response.text.trim().replace(/\s+/g, " ").slice(0, 240);
			if (text.length < 8) return;
			if (detectInjections(text).some((f) => f.severity === "high")) return;
			const proposal = this.contractStore.proposeUpdate(
				this.sessionId,
				{
					derivedGoal: {
						text,
						confirmed: false,
						provenance: { sourceEventIds: [], source: "extractor", note: "auto-distilled goal sentence" },
					},
				},
				LOCAL_USER,
				"store unconfirmed distilled goal",
			);
			this.contractStore.approveProposal(this.sessionId, proposal.proposalId, LOCAL_USER);
		} catch (error) {
			if (signal?.aborted) {
				this.goalDistilled = false;
				throw error;
			}
			// Distillation is best-effort; the raw derived goal remains as fallback.
		}
	}

	/** Promote the pending distilled goal to the authoritative goal (new audited version). */
	confirmDerivedGoal() {
		const active = this.contractStore.getActive(this.sessionId);
		if (!active?.derivedGoal) {
			throw new Error("No derived goal to confirm");
		}
		const sourceEventId = this.appendUserControlEvent("/contract confirm");
		const focus = this.taskLedger.getFocusTask();
		if (!focus) {
			this.taskLedger.createTask({ goal: active.derivedGoal.text }, LOCAL_USER, sourceEventId);
		} else if (focus.goal.normalized !== active.derivedGoal.text) {
			this.taskLedger.apply(
				{ operation: "REFINE_TASK", taskId: focus.taskId, goal: active.derivedGoal.text },
				LOCAL_USER,
				sourceEventId,
			);
		}
		const proposal = this.contractStore.proposeUpdate(
			this.sessionId,
			{ goal: active.derivedGoal.text, derivedGoal: null },
			LOCAL_USER,
			"user confirmed distilled goal",
		);
		return this.contractStore.approveProposal(this.sessionId, proposal.proposalId, LOCAL_USER);
	}

	setCurrentTaskGoal(goal: string) {
		const normalized = goal.trim();
		if (!normalized) throw new Error("Task goal cannot be empty");
		const sourceEventId = this.appendUserControlEvent(`/contract set ${normalized}`);
		const focus = this.taskLedger.getFocusTask();
		const task = focus
			? this.taskLedger.apply(
					{ operation: "REFINE_TASK", taskId: focus.taskId, goal: normalized },
					LOCAL_USER,
					sourceEventId,
				)
			: this.taskLedger.createTask({ goal: normalized }, LOCAL_USER, sourceEventId);
		const contract = this.contractStore.getActive(this.sessionId);
		if (!contract) {
			this.setContract({ goal: normalized, constraints: [] });
		} else if (contract.derivedGoal) {
			this.updateContract({ derivedGoal: null }, "explicit focus goal replaced derived proposal");
		}
		return task;
	}

	buildPinnedLedgerLayer(): string {
		return renderPinnedLedgerLayer(this.taskLedger, this.contractStore.getActive(this.sessionId));
	}

	getLatestReconciliationReport(): ReconciliationReport | undefined {
		for (const event of this.eventLog.all(this.sessionId).reverse()) {
			if (event.eventType !== "state_change" || !event.payload || typeof event.payload !== "object") continue;
			const payload = event.payload as { kind?: unknown; report?: unknown };
			if (payload.kind !== "task_reconciliation_report" || !payload.report || typeof payload.report !== "object") {
				continue;
			}
			const report = structuredClone(payload.report) as ReconciliationReport;
			if (verifyReconciliationReport(report)) return report;
		}
		return undefined;
	}

	async runReconciliation(input: {
		branchEntries: SessionEntry[];
		complete?: CompleteFn;
	}): Promise<ReconciliationReport> {
		this.syncFromEntries(input.branchEntries);
		const previous = this.getLatestReconciliationReport();
		const boundary = this.eventLog.freeze(this.sessionId);
		const ledgerVersion = this.taskLedger.getLedgerVersion();
		const contractVersion = this.contractStore.getActive(this.sessionId)?.version;
		const branchId = this.eventLog.getProjectionState().branchHeadId;
		const focus = this.taskLedger.getFocusTask();
		const taskRef = focus ? `task://${focus.taskId}/v${focus.version}` : undefined;
		const newUserEvents = countSubstantiveUserEvents(
			this.eventLog.range(this.sessionId, previous ? previous.toEventSeq + 1 : 1, boundary.seq),
		);
		if (previous && newUserEvents === 0 && previous.ledgerVersion === ledgerVersion && previous.taskRef === taskRef) {
			return previous;
		}
		try {
			const report = await buildReconciliationReport({
				sessionId: this.sessionId,
				branchId,
				ledger: this.taskLedger,
				events: this.eventLog.range(this.sessionId, 1, boundary.seq),
				fromEventSeq: previous ? previous.toEventSeq + 1 : 1,
				toEventSeq: boundary.seq,
				actor: LOCAL_USER,
				complete: input.complete,
			});
			if (this.eventLog.getProjectionState().branchHeadId !== branchId) {
				throw new Error("reconciliation branch changed before report commit");
			}
			if (this.taskLedger.getLedgerVersion() !== ledgerVersion) {
				throw new Error("reconciliation attempted to mutate the task ledger");
			}
			if (this.contractStore.getActive(this.sessionId)?.version !== contractVersion) {
				throw new Error("reconciliation attempted to mutate the global contract");
			}
			if (previous?.reportHash === report.reportHash) return previous;
			this.eventLog.append({
				sessionId: this.sessionId,
				agentId: "task-reconciler",
				eventType: "state_change",
				payload: { kind: "task_reconciliation_report", report },
				authority: { kind: "system", id: "task-reconciler", verified: true },
			});
			this.audit.record("reconciliation", this.sessionId, {
				reportId: report.reportId,
				findings: report.findings.length,
				fromSeq: report.fromEventSeq,
				toSeq: report.toEventSeq,
			});
			return report;
		} catch (error) {
			this.audit.record("reconciliation_failed", this.sessionId, {
				error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
			});
			throw error;
		}
	}

	async maybeRunReconciliation(input: {
		branchEntries: SessionEntry[];
		complete?: CompleteFn;
	}): Promise<ReconciliationReport | undefined> {
		if (this.config.reconciliationEnabled !== true) return undefined;
		this.syncFromEntries(input.branchEntries);
		const previous = this.getLatestReconciliationReport();
		const boundary = this.eventLog.freeze(this.sessionId);
		const configuredInterval = this.config.reconciliationIntervalTurns ?? 8;
		const interval =
			Number.isFinite(configuredInterval) && configuredInterval >= 1 ? Math.floor(configuredInterval) : 8;
		const userTurns = countSubstantiveUserEvents(
			this.eventLog.range(this.sessionId, previous ? previous.toEventSeq + 1 : 1, boundary.seq),
		);
		if (userTurns < interval) return undefined;
		return this.runReconciliation(input);
	}

	getTaskLedgerState(): {
		branchId: string | undefined;
		ledgerVersion: number;
		focusTaskId: string | undefined;
		tasks: ReturnType<TaskLedger["listTasks"]>;
		pending: PendingGoalChange[];
	} {
		return {
			branchId: this.eventLog.getProjectionState().branchHeadId,
			ledgerVersion: this.taskLedger.getLedgerVersion(),
			focusTaskId: this.taskLedger.getFocusTaskId(),
			tasks: this.taskLedger.listTasks(),
			pending: this.taskLedger.getPendingGoalChanges(),
		};
	}

	private appendUserControlEvent(text: string): string {
		return this.eventLog.append({
			sessionId: this.sessionId,
			agentId: "interactive",
			eventType: "message",
			payload: { role: "user", text, control: true },
			authority: LOCAL_USER,
		}).eventId;
	}

	acceptPendingGoalChange(pendingChangeId: string, candidateTaskId?: string) {
		const sourceEventId = this.appendUserControlEvent(
			`/contract accept ${pendingChangeId}${candidateTaskId ? ` ${candidateTaskId}` : ""}`,
		);
		return this.taskLedger.acceptPendingGoalChange(pendingChangeId, LOCAL_USER, sourceEventId, {
			candidateTaskId,
		});
	}

	rejectPendingGoalChange(pendingChangeId: string) {
		const sourceEventId = this.appendUserControlEvent(`/contract reject ${pendingChangeId}`);
		return this.taskLedger.rejectPendingGoalChange(pendingChangeId, LOCAL_USER, sourceEventId);
	}

	/**
	 * Mirror and interpret one persisted user message before the assistant turn.
	 * The first message creates only T1; later messages go through the untrusted
	 * proposal → deterministic validation → commit path.
	 */
	async processUserMessage(input: {
		branchEntries: SessionEntry[];
		sourceEventId: string;
		userMessage: string;
		complete: CompleteFn;
	}): Promise<GoalChangeOutcome> {
		this.syncFromEntries(input.branchEntries);
		const created = this.ensureTaskLedgerFromEntries(input.branchEntries);
		if (created) {
			const focus = this.taskLedger.getFocusTask();
			const outcome: GoalChangeOutcome = focus
				? { outcome: "committed", tasks: [focus] }
				: { outcome: "rejected", reason: "no substantive user message available for initial task" };
			this.audit.record("goal_interpretation", this.sessionId, { outcome: outcome.outcome, initial: true });
			return outcome;
		}
		const outcome = await interpretGoalChange({
			userMessage: input.userMessage,
			sourceEventId: input.sourceEventId,
			ledger: this.taskLedger,
			complete: input.complete,
			actor: LOCAL_USER,
		});
		this.audit.record("goal_interpretation", this.sessionId, {
			outcome: outcome.outcome,
			reason: "reason" in outcome ? outcome.reason.slice(0, 160) : undefined,
		});
		return outcome;
	}

	/** Compactor LLM provided via config (tests); production passes one per attempt. */
	get configComplete(): CompleteFn | undefined {
		return this.config.complete;
	}

	get goalComplete(): CompleteFn | undefined {
		return this.config.goalComplete;
	}

	get taskInterpretationEnabled(): boolean {
		return this.config.taskInterpretationEnabled === true;
	}

	get reconciliationEnabled(): boolean {
		return this.config.reconciliationEnabled === true;
	}

	get reconcileComplete(): CompleteFn | undefined {
		return this.config.reconcileComplete;
	}

	get mode(): HfCompactionMode {
		return this.config.mode;
	}

	private catalogColdMessage(event: { eventId: string; payload?: unknown }): void {
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || !("coldMessage" in payload)) return;
		const cold = payload.coldMessage;
		if (
			!cold ||
			typeof cold !== "object" ||
			!("schemaVersion" in cold) ||
			cold.schemaVersion !== 1 ||
			!("artifactRef" in cold) ||
			typeof cold.artifactRef !== "string" ||
			!("hash" in cold) ||
			typeof cold.hash !== "string"
		) {
			return;
		}
		const coldMessage = cold as ColdMessageRef;
		const text = "text" in payload && typeof payload.text === "string" ? payload.text : "";
		const role = "role" in payload && typeof payload.role === "string" ? payload.role : "message";
		this.recallCatalog.addFromColdMessage({
			eventId: event.eventId,
			artifactRef: coldMessage.artifactRef,
			hash: coldMessage.hash,
			preview: text.trim() || `[${role} content with no text preview]`,
		});
	}

	/**
	 * Project the authoritative SessionManager path onto one durable log. Any
	 * path change (including equal-length siblings) replays both ledgers from
	 * the branch-visible event closure; append identity never changes.
	 */
	syncFromEntries(entries: SessionEntry[]): void {
		try {
			this.eventLog.setBranch(entries);
			const events = sessionEntriesToEvents(entries, this.sessionId, "agent-local", {
				artifactStore: this.artifactStore,
				tenant: this.tenant,
			});
			for (const event of events) {
				if (!this.eventLog.getBaseLog().get(event.eventId)) {
					this.eventLog.append({
						sessionId: this.sessionId,
						agentId: event.agentId,
						eventType: event.eventType,
						eventId: event.eventId,
						branchHeadId: event.branchHeadId,
						toolCallId: event.toolCallId,
						transactionId: event.transactionId,
						causalParentIds: event.causalParentIds,
						payload: event.payload,
						payloadRef: event.payloadRef,
						authority: event.authority,
						timestamp: event.timestamp,
					});
				}
				this.catalogColdMessage(event);
			}
			const projection = this.eventLog.setBranch(entries);
			const signature = projection.pathEntryIds.join("\u0000");
			if (signature === this.branchPathSignature) return;
			const visibleEvents = this.eventLog.all(this.sessionId);
			this.taskLedger = replayTaskLedger(visibleEvents, {
				eventLog: this.eventLog,
				sessionId: this.sessionId,
				strictEventSourceValidation: true,
			});
			this.ledger = replayLedger(visibleEvents, {
				eventLog: this.eventLog,
				sessionId: this.sessionId,
				agentId: "agent-local",
			});
			this.snapshotStore.selectActiveForBranch(
				this.sessionId,
				projection.pathEntryIds,
				new Set(projection.visibleEventIds),
			);
			this.branchPathSignature = signature;
			this.reconcileActiveSnapshotCommit();
		} catch (error) {
			// Fail closed: never leave a sibling branch's in-memory ledgers active
			// when the new projection could not be established durably.
			this.taskLedger = replayTaskLedger([], {
				eventLog: this.eventLog,
				sessionId: this.sessionId,
				strictEventSourceValidation: true,
			});
			this.ledger = new ToolLedger({
				eventLog: this.eventLog,
				sessionId: this.sessionId,
				agentId: "agent-local",
			});
			this.branchPathSignature = "";
			this.audit.record("branch_sync_failed", this.sessionId, {
				error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
			});
		}
	}

	/** Seed T1 from the latest substantive user event when migrating an existing session. */
	private ensureTaskLedgerFromEntries(entries: SessionEntry[]): boolean {
		if (this.taskLedger.listTasks().length > 0) return false;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = contentText(entry.message.content, "").replace(/\s+/g, " ").trim();
			if (!text || text.startsWith("/")) continue;
			this.taskLedger.createTask({ goal: truncateGoalText(text, 200) }, LOCAL_USER, entry.id);
			return true;
		}
		return false;
	}

	/**
	 * Seed the contract when none exists. The goal is the CURRENT task: the
	 * latest substantive user message in the branch (slash commands and trivial
	 * acks are skipped). An explicitly set contract always wins — auto-derivation
	 * only ever runs once, at the first compaction that needs a contract.
	 */
	private ensureContractFromEntries(entries: SessionEntry[]): void {
		if (this.contractReady) return;
		if (this.contractStore.getActive(this.sessionId)) {
			this.contractReady = true;
			return;
		}
		let goal: string | undefined;
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = contentText(entry.message.content, "");
			const trimmed = text.replace(/\s+/g, " ").trim();
			// Skip slash commands (/mode, /compact …) and trivial acknowledgements.
			if (trimmed.startsWith("/") || trimmed.length < 8) continue;
			goal = trimmed;
		}
		const derived = goal ? truncateGoalText(goal, 200) : "(no explicit goal captured)";
		this.contractStore.create({
			contractId: `contract-${this.sessionId}`,
			sessionId: this.sessionId,
			goal: derived,
			acceptanceCriteria: [],
			constraints: [],
			permissions: { allow: [], deny: [], approvalRequired: [] },
			budgets: {},
			authority: LOCAL_USER,
			allowedUpdaters: [LOCAL_USER.id],
		});
		this.contractReady = true;
	}

	reconcileActiveSnapshotCommit(): void {
		const active = this.snapshotStore.getActive(this.sessionId);
		if (!active) return;
		const alreadyLogged = this.eventLog.all(this.sessionId).some((event) => {
			const payload = event.payload;
			return (
				event.eventType === "compaction" &&
				payload !== null &&
				typeof payload === "object" &&
				"snapshotVersion" in payload &&
				payload.snapshotVersion === active.snapshotVersion
			);
		});
		if (alreadyLogged) return;
		try {
			this.eventLog.append({
				sessionId: this.sessionId,
				agentId: "compaction-recovery",
				eventType: "compaction",
				payload: {
					kind: "compaction_commit_recovered",
					snapshotVersion: active.snapshotVersion,
					baseEventSeq: active.baseEventSeq,
					tokensAfter: active.tokenStats.total,
				},
				authority: { kind: "system", id: "compaction-recovery", verified: true },
			});
		} catch (error) {
			this.audit.record("commit_log_failed", this.sessionId, {
				version: active.snapshotVersion,
				recovery: true,
				error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
			});
		}
	}

	private offloadPolicy(): OffloadPolicy {
		const highRiskTools = new Set(
			Object.entries(HfCompactionHost.TOOL_RISK)
				.filter(([, classification]) => classification.riskLevel === "high")
				.map(([name]) => name),
		);
		return {
			maxInlineBytes: this.config.offloadThresholdBytes ?? 2000,
			keepRecentToolResults: this.config.keepRecentToolResults ?? 1,
			toolExclusions: [],
			highRiskTools: [...highRiskTools],
		};
	}

	/** Refs must be both published by the active snapshot and linked to a branch-visible event. */
	private activeBranchRecallRefs(): Set<string> {
		const active = this.snapshotStore.getActive(this.sessionId);
		if (!active) return new Set();
		const snapshotRefs = new Set(active.recallCatalogRefs);
		const visibleEventIds = new Set(this.eventLog.getProjectionState().visibleEventIds);
		return new Set(
			this.recallCatalog
				.entries()
				.filter(
					(entry) =>
						snapshotRefs.has(entry.refId) && entry.eventIds.some((eventId) => visibleEventIds.has(eventId)),
				)
				.map((entry) => entry.refId),
		);
	}

	evaluateCompactionTrigger(input: {
		branchEntries: SessionEntry[];
		modelContextLimit: number;
		outputReserveTokens: number;
		currentInput?: string;
		currentInputExtraTokens?: number;
		/** Last trusted provider usage for the immediately preceding request. */
		recentProviderContextTokens?: number;
		previousCallOverflowed?: boolean;
	}): HfTriggerEvaluation {
		this.syncFromEntries(input.branchEntries);
		// Trigger evaluation is read-only. Contract/task seeding happens only once
		// an attempt is selected, so a no-op check cannot freeze an early goal.
		const contract = this.contractStore.getActive(this.sessionId);
		const active = this.snapshotStore.getActive(this.sessionId);
		const allEvents = this.eventLog.all(this.sessionId);
		const tailEvents = allEvents.filter((event) => event.seq > (active?.baseEventSeq ?? 0));
		const activeRecallRefs = this.activeBranchRecallRefs();
		const activeRecallEntries = this.recallCatalog.entries().filter((entry) => activeRecallRefs.has(entry.refId));
		const offloadByEventId = new Map(
			activeRecallEntries.flatMap((entry) => entry.eventIds.map((eventId) => [eventId, entry] as const)),
		);
		const projectedTailEvents = tailEvents.map((event) => {
			const offloaded = offloadByEventId.get(event.eventId);
			return offloaded
				? { ...event, payload: { text: `[offloaded ${offloaded.artifactRef}] ${offloaded.preview}` } }
				: event;
		});
		const built = buildPrompt({
			systemPrompt: this.getSystemPrompt(),
			contract,
			ledger: this.taskLedger,
			snapshot: active,
			recallGuide: activeRecallEntries.length > 0 ? RECALL_GUIDE_TEXT : undefined,
			tailEvents: projectedTailEvents,
			currentInput: input.currentInput ?? "",
			exactRecall: [],
			toolsTokenEstimate: this.getToolsTokenEstimate?.(),
			outputReserveTokens: input.outputReserveTokens,
			enforceRecentTailBudget: false,
		});
		const alreadyOffloadedEventIds = new Set(activeRecallEntries.flatMap((entry) => entry.eventIds));
		const policy = this.offloadPolicy();
		const projectionTokens = built.tokenStats.total + (input.currentInputExtraTokens ?? 0);
		const recentUsageFloor = Math.max(
			0,
			(input.recentProviderContextTokens ?? 0) +
				(input.currentInput ? Math.ceil(input.currentInput.length / 4) : 0) +
				(input.currentInputExtraTokens ?? 0),
		);
		const predictedNextRequestTokens = Math.max(projectionTokens, recentUsageFloor);
		const tokenEstimateProvenance =
			recentUsageFloor > projectionTokens ? "provider_projection_with_recent_usage_floor" : "provider_projection";
		const recoverableToolTokens = estimateRecoverableToolTokens({
			events: tailEvents,
			policy,
			alreadyOffloadedEventIds,
		});
		const triggerSeq = active?.compactor.triggerEventSeq;
		const triggerEvent = triggerSeq === undefined ? undefined : allEvents.find((event) => event.seq === triggerSeq);
		const triggerOnCurrentBranch =
			triggerEvent !== undefined &&
			(active?.compactor.triggerHeadEventId === undefined ||
				active.compactor.triggerHeadEventId === triggerEvent.eventId);
		const userTurnsAfterTrigger =
			triggerOnCurrentBranch && triggerSeq !== undefined
				? allEvents.filter(
						(event) =>
							event.seq > triggerSeq &&
							event.eventType === "message" &&
							event.authority.kind === "user" &&
							event.authority.verified,
					).length
				: 1;
		const compactionCooldownRemaining = triggerOnCurrentBranch && userTurnsAfterTrigger === 0 ? 1 : 0;
		let incrementalCompactionsSinceRebuild = 0;
		if (active && triggerOnCurrentBranch) {
			const versions = new Map(
				this.snapshotStore.listVersions(this.sessionId).map((snapshot) => [snapshot.snapshotVersion, snapshot]),
			);
			let cursor: typeof active | undefined = active;
			while (cursor) {
				const kind = cursor.compactor.kind ?? "incremental";
				if (kind === "rebuild") break;
				if (kind === "incremental") incrementalCompactionsSinceRebuild += 1;
				cursor = cursor.parentVersion === null ? undefined : versions.get(cursor.parentVersion);
			}
		}
		const decision = evaluateTriggers({
			predictedNextRequestTokens,
			modelContextLimit: input.modelContextLimit,
			recoverableToolTokens,
			previousCallOverflowed: input.previousCallOverflowed,
			incrementalCompactionsSinceRebuild,
			compactionCooldownRemaining,
		});
		return {
			decision,
			predictedNextRequestTokens,
			tokenEstimateProvenance,
			recoverableToolTokens,
			compactionCooldownRemaining,
			incrementalCompactionsSinceRebuild,
		};
	}

	getActiveTriggerBoundary(): { eventId: string; timestamp: string } | undefined {
		const active = this.snapshotStore.getActive(this.sessionId);
		if (!active) return undefined;
		const seq = active.compactor.triggerEventSeq;
		if (seq === undefined) return undefined;
		const event = this.eventLog.all(this.sessionId).find((candidate) => candidate.seq === seq);
		if (!event) return undefined;
		if (active.compactor.triggerHeadEventId && active.compactor.triggerHeadEventId !== event.eventId)
			return undefined;
		return { eventId: event.eventId, timestamp: event.timestamp };
	}

	/** Build a read-only view of the current compacted projection. */
	inspectActiveContext(options: { includeSystemPrompt?: boolean } = {}): ContextInspection | undefined {
		const active = this.snapshotStore.getActive(this.sessionId);
		if (!active) return undefined;
		const contract = this.contractStore.getActive(this.sessionId);
		const allEvents = this.eventLog.all(this.sessionId);
		const tailEvents = allEvents.filter(
			(event) => event.seq > active.baseEventSeq && event.eventType !== "compaction",
		);
		const activeRecallRefs = this.activeBranchRecallRefs();
		const recallEntries = this.recallCatalog.entries().filter((entry) => activeRecallRefs.has(entry.refId));
		const offloadByEventId = new Map(
			recallEntries.flatMap((entry) => entry.eventIds.map((eventId) => [eventId, entry] as const)),
		);
		const projectedTailEvents = tailEvents.map((event) => {
			const offloaded = offloadByEventId.get(event.eventId);
			return offloaded
				? { ...event, payload: { text: `[offloaded ${offloaded.artifactRef}] ${offloaded.preview}` } }
				: event;
		});
		const systemPrompt = this.getSystemPrompt();
		const built = buildPrompt({
			systemPrompt,
			contract,
			ledger: this.taskLedger,
			snapshot: active,
			recallGuide: recallEntries.length > 0 ? RECALL_GUIDE_TEXT : undefined,
			tailEvents: projectedTailEvents,
			currentInput: "",
			exactRecall: [],
			toolsTokenEstimate: this.getToolsTokenEstimate?.(),
			outputReserveTokens: this.config.outputReserveTokens ?? 0,
		});
		return {
			mode: this.config.mode,
			snapshotVersion: active.snapshotVersion,
			projectionKind: active.compactor.kind ?? "incremental",
			baseEventSeq: active.baseEventSeq,
			triggerEventSeq: active.compactor.triggerEventSeq,
			tailEventCount: tailEvents.length,
			toolsTokenEstimate: built.tokenStats.tools,
			tokenStats: { ...built.tokenStats },
			projectionStats: built.projectionStats.map((stats) => ({ ...stats })),
			sections: built.sections.map((section) => ({ ...section })),
			recallEntries: recallEntries.map(({ refId, kind, preview, eventIds }) => ({
				refId,
				kind,
				preview,
				eventIds: [...eventIds],
			})),
			...(options.includeSystemPrompt
				? { systemPrompt: { text: systemPrompt, tokens: built.tokenStats.system } }
				: {}),
		};
	}

	private orchestratorDeps(
		complete: CompleteFn,
		overrides?: { keepRecentTokens?: number; outputReserveTokens?: number },
	): OrchestratorDeps {
		return {
			sessionId: this.sessionId,
			eventLog: this.eventLog,
			artifactStore: this.artifactStore,
			contractStore: this.contractStore,
			snapshotStore: this.snapshotStore,
			recallCatalog: this.recallCatalog,
			audit: this.audit,
			complete,
			tenant: this.tenant,
			policy: this.offloadPolicy(),
			keepRecentTokens: overrides?.keepRecentTokens ?? this.config.keepRecentTokens ?? 8000,
			systemPrompt: this.getSystemPrompt(),
			toolsTokenEstimate: this.getToolsTokenEstimate?.(),
			outputReserveTokens: overrides?.outputReserveTokens ?? this.config.outputReserveTokens ?? 4096,
			minTokenGainFraction: this.config.minTokenGainFraction,
			narrativeEnabled: this.config.mode === "full_pipeline",
			ledger: this.taskLedger,
			getLedger: () => this.taskLedger,
			getBranchId: () => this.eventLog.getProjectionState().branchHeadId,
			rebuildRunner: async (_sessionId, boundarySeq, targetCoverageSeq) => {
				const rebuilt = await rawRebuild(
					{
						sessionId: this.sessionId,
						eventLog: this.eventLog,
						artifactStore: this.artifactStore,
						contractStore: this.contractStore,
						snapshotStore: this.snapshotStore,
						audit: this.audit,
						recallCatalog: this.recallCatalog,
					},
					{ toSeq: boundarySeq, coverageSeq: targetCoverageSeq },
				);
				if (rebuilt.gaps.length > 0) throw new Error(rebuilt.gaps.join("; "));
				return rebuilt.snapshot;
			},
		};
	}

	/**
	 * Attempt one subsystem compaction. Returns activated=true plus the rebuilt
	 * active messages on success; otherwise activated=false and leaves the live
	 * context unchanged.
	 */
	async attemptCompaction(options: {
		action: Exclude<TriggerAction, "none">;
		complete: CompleteFn;
		manual?: boolean;
		triggerReasons?: readonly string[];
		currentInput?: string;
		currentInputExtraTokens?: number;
		branchEntries: SessionEntry[];
		signal?: AbortSignal;
		/** Per-attempt overrides from live settings (defaults come from construction config). */
		keepRecentTokens?: number;
		outputReserveTokens?: number;
	}): Promise<{
		activated: boolean;
		/** True when a shadow candidate was produced (never activates, never an error). */
		shadow?: boolean;
		messages?: AgentMessage[];
		summaryText: string;
		result?: CompactResult;
		tokensBefore?: number;
		tokensAfter?: number;
	}> {
		this.syncFromEntries(options.branchEntries);
		this.ensureTaskLedgerFromEntries(options.branchEntries);
		this.ensureContractFromEntries(options.branchEntries);
		if (options.action !== "offload_only") {
			await this.maybeDistillGoal(options.branchEntries, options.complete, options.signal);
		}
		const orchestrator = new CompactionOrchestrator(
			this.orchestratorDeps(options.complete, {
				keepRecentTokens: options.keepRecentTokens,
				outputReserveTokens: options.outputReserveTokens,
			}),
		);
		const result = await orchestrator.compact(options.action, {
			manual: options.manual,
			triggerReasons: options.triggerReasons,
			currentInput: options.currentInput,
			currentInputExtraTokens: options.currentInputExtraTokens,
			signal: options.signal,
			shadow: this.config.mode === "shadow",
		});
		if (result.status === "shadow") {
			return {
				activated: false,
				shadow: true,
				summaryText: `shadow candidate v${result.snapshotVersion} (validated, not activated)`,
				result,
			};
		}
		if (result.status !== "activated" && result.status !== "rebuilt") {
			return { activated: false, summaryText: result.reason ?? "rejected", result };
		}
		const messages = this.buildActiveMessages(options.branchEntries);
		const committed = this.audit.byType("compact_committed").at(-1);
		const tokensBefore = committed?.details.tokensBefore as number | undefined;
		const tokensAfter = committed?.details.tokensAfter as number | undefined;
		const offloadedBytes = committed?.details.offloadedBytes as number | undefined;
		if (options.action === "offload_only") {
			if (!messages)
				return { activated: false, summaryText: "no active offload projection after activation", result };
			return {
				activated: true,
				messages,
				summaryText: formatActivatedSummary({
					action: options.action,
					snapshotVersion: result.snapshotVersion,
					tokensBefore,
					tokensAfter,
					offloadedBytes,
				}),
				result,
				tokensBefore,
				tokensAfter,
			};
		}
		if (!messages) {
			return { activated: false, summaryText: "no active snapshot after activation", result };
		}
		const narrative = this.snapshotStore.getActive(this.sessionId)?.narrative;
		return {
			activated: true,
			messages,
			summaryText: formatActivatedSummary({
				action: options.action,
				snapshotVersion: result.snapshotVersion,
				tokensBefore,
				tokensAfter,
				offloadedBytes,
				narrative,
			}),
			result,
			tokensBefore,
			tokensAfter,
		};
	}

	/**
	 * Rebuild the active message projection: pinned zones (contract, snapshot,
	 * narrative, recall guide) as one leading user message, then the verbatim
	 * atomic tail reconstructed from events after the snapshot boundary.
	 */
	buildActiveMessages(branchEntries?: SessionEntry[]): AgentMessage[] | undefined {
		const active = this.snapshotStore.getActive(this.sessionId);
		if (!active) return undefined;
		const contract = this.contractStore.getActive(this.sessionId);
		const all = this.eventLog.all(this.sessionId);
		const tailEvents = all.filter((e) => e.seq > active.baseEventSeq && e.eventType !== "compaction");
		const activeRecallRefs = this.activeBranchRecallRefs();

		const built = buildPrompt({
			systemPrompt: this.getSystemPrompt(),
			contract,
			ledger: this.taskLedger,
			snapshot: active,
			recallGuide: activeRecallRefs.size > 0 ? RECALL_GUIDE_TEXT : undefined,
			tailEvents: [],
			currentInput: "",
			exactRecall: [],
			toolsTokenEstimate: this.getToolsTokenEstimate?.(),
		});
		// The fixed layer is injected dynamically into the system prompt on every
		// provider turn. Keep only snapshot/working zones in the persisted message
		// projection so contract changes cannot leave a stale duplicate behind.
		const pinnedText = built.sections
			.filter((section) => section.zone !== "contract")
			.map((section) => section.text)
			.join("\n\n");

		// Rebuild the tail from the session entries (the truth), keyed by the
		// entryId each event references. Offloaded tool results are projected as
		// preview + recall ref. Falls back to event payloads when entries are
		// unavailable (library use without a SessionManager).
		const entryById = new Map((branchEntries ?? []).map((e) => [e.id, e] as const));
		const offloadByEntryId = new Map(
			this.recallCatalog
				.entries()
				.filter((entry) => activeRecallRefs.has(entry.refId))
				.flatMap((entry) => entry.eventIds.map((eventId) => [eventId, entry] as const)),
		);
		const tailMessages: AgentMessage[] = [];
		const seenEntryIds = new Set<string>();
		for (const event of tailEvents) {
			const payload = event.payload;
			const entryId =
				payload && typeof payload === "object" && "entryId" in payload
					? String((payload as { entryId: unknown }).entryId)
					: undefined;
			const dedupeKey = entryId ?? event.eventId;
			if (seenEntryIds.has(dedupeKey)) continue;
			seenEntryIds.add(dedupeKey);

			const entry = entryId ? entryById.get(entryId) : undefined;
			const offloaded = entryId ? offloadByEntryId.get(entryId) : undefined;
			if (offloaded) {
				const original = entry ? sessionEntryToContextMessages(entry)[0] : undefined;
				const role = original?.role === "toolResult" ? original : undefined;
				if (role) {
					tailMessages.push({
						...role,
						content: [
							{
								type: "text" as const,
								text: `[content moved out of context — recall_exact("${offloaded.refId}") to restore]\n${offloaded.preview}`,
							},
						],
					});
					continue;
				}
			}
			if (entry) {
				tailMessages.push(...sessionEntryToContextMessages(entry));
				continue;
			}
			// Fallback: payload-carried message (live-recorded shape).
			if (payload && typeof payload === "object" && "message" in payload) {
				tailMessages.push((payload as { message: AgentMessage }).message);
			}
		}

		const pinnedMessage: AgentMessage = createCompactionSummaryMessage(
			pinnedText,
			active.tokenStats.total,
			active.createdAt,
		);
		return [pinnedMessage, ...tailMessages];
	}

	/** Search only refs published by the active snapshot and linked to the current branch. */
	recallSearch(input: { query: string; kind?: RecallSearchOptions["kind"]; limit?: number }): RecallSearchHit[] {
		return this.recallCatalog.search(input.query, {
			kind: input.kind,
			limit: input.limit,
			allowedRefIds: this.activeBranchRecallRefs(),
		});
	}

	/** Exact recall by active branch ref; throws on inactive, unknown, or mismatch. */
	recallExact(refId: string): string {
		const known = this.recallCatalog.entries().some((entry) => entry.refId === refId);
		if (!known) {
			// Preserve the catalog's fail-closed unknown-ref error and metrics.
			this.recallCatalog.recallExact(refId);
		}
		if (!this.activeBranchRecallRefs().has(refId)) {
			throw new Error(`Recall ref ${refId} is not active on the current branch`);
		}
		const { data } = this.recallCatalog.recallExact(refId);
		return new TextDecoder().decode(data);
	}
}

/**
 * Production CompleteFn adapter over pi-ai's completeSummarization (which
 * already enforces toolChoice:"none" and retry discipline). Vendor-neutral:
 * any Model<any> works.
 */
export function createPiAiCompleteFn(options: {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
	callbacks?: RetryCallbacks;
}): CompleteFn {
	return async (request) => {
		const context = {
			systemPrompt: request.systemPrompt,
			// Compaction requests are single-shot user prompts; assistant-role
			// content is prefixed and sent as user text for type safety.
			messages: request.messages.map((m) => ({
				role: "user" as const,
				content: m.role === "user" ? m.content : `[assistant]: ${m.content}`,
				timestamp: Date.now(),
			})),
		};
		const response = await completeSummarization(
			options.model,
			context,
			{
				maxTokens: request.maxTokens,
				signal: request.signal,
				apiKey: options.apiKey,
				headers: options.headers,
				env: options.env,
			},
			options.streamFn,
			options.retry,
			options.callbacks,
		);
		if (response.stopReason === "error") {
			return { text: "", stopReason: "error", errorMessage: response.errorMessage ?? "unknown" };
		}
		if (response.stopReason === "aborted") {
			return { text: "", stopReason: "aborted" };
		}
		return {
			text: contentText(response.content),
			stopReason: "stop",
			usage: { input: response.usage.input, output: response.usage.output },
		};
	};
}
