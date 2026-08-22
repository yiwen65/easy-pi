/**
 * CCTX-080: AgentSession integration host for the high-fidelity compaction
 * subsystem.
 *
 * The host owns one set of subsystem stores per session and exposes a narrow
 * API to AgentSession: record messages as events, attempt compaction, rebuild
 * active messages, exact recall. All methods are fail-safe toward the host
 * session: unexpected subsystem errors surface as "not handled" so the caller
 * can fall back to the legacy compaction path.
 *
 * Feature flags (任务书 CCTX-080):
 *   offload_only            — deterministic offload only, no LLM
 *   structured_compaction   — full typed-snapshot pipeline without narrative
 *   full_pipeline           — typed snapshot + narrative bridge
 * Default off; when off the legacy history path is bit-identical to before.
 */

import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { contentText, type RetryCallbacks, type RetryPolicy } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { type SessionEntry, sessionEntryToContextMessages } from "../../session-manager.ts";
import { completeSummarization } from "../compaction.ts";
import { type ArtifactStore, FileSystemArtifactStore, InMemoryArtifactStore } from "./artifact-store.ts";
import { type EventLog, InMemoryEventLog, JsonlEventLog, sessionEntriesToEvents } from "./event-log.ts";
import { canonicalJson, sha256Hex } from "./hashing.ts";
import {
	COMPACTOR_POLICY_VERSION,
	COMPACTOR_SYSTEM_POLICY,
	detectInjections,
	wrapUntrusted,
} from "./injection-guard.ts";
import { AuditTrail } from "./observability.ts";
import { CompactionOrchestrator, type CompactResult, type OrchestratorDeps } from "./orchestrator.ts";
import { buildPrompt } from "./prompt-builder.ts";
import { RecallCatalog } from "./recall-catalog.ts";
import { InMemorySnapshotStore, JsonlSnapshotStore, type SnapshotStore } from "./snapshot-store.ts";
import { InMemoryContractStore, JsonlContractStore } from "./task-contract.ts";
import { ToolLedger } from "./tool-ledger.ts";
import type { Authority, CompleteFn } from "./types.ts";

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

export interface HfCompactionConfig {
	mode: HfCompactionMode;
	/** Compactor LLM. Tests inject a faux; production uses createPiAiCompleteFn per attempt. */
	complete?: CompleteFn;
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
	"Content moved out of the active context can be recalled exactly with recall_exact(refId). Stable refs are listed in the snapshot.";

export class HfCompactionHost {
	readonly snapshotStore: SnapshotStore;
	readonly artifactStore: ArtifactStore;
	readonly contractStore: InMemoryContractStore | JsonlContractStore;
	readonly recallCatalog: RecallCatalog;
	readonly audit = new AuditTrail();
	/** Side-effect ledger (CCTX-013), event-sourced into the session event log. */
	readonly ledger: ToolLedger;
	/** Mutable: syncFromEntries may rebuild the log when the branch shape changes. */
	eventLog: EventLog;

	private readonly sessionId: string;
	private readonly getSystemPrompt: () => string;
	private readonly config: HfCompactionConfig;
	private readonly tenant: string;
	private seededCount = 0;
	private contractReady = false;
	private goalDistilled = false;

	constructor(options: {
		sessionId: string;
		getSystemPrompt: () => string;
		config: HfCompactionConfig;
	}) {
		this.sessionId = options.sessionId;
		this.getSystemPrompt = options.getSystemPrompt;
		this.config = options.config;
		this.tenant = options.config.tenant ?? "local";
		const stateDir = options.config.stateDir;
		this.eventLog = options.config.eventLogDir
			? new JsonlEventLog(options.config.eventLogDir)
			: stateDir
				? new JsonlEventLog(join(stateDir, "events"))
				: new InMemoryEventLog();
		this.artifactStore = stateDir
			? new FileSystemArtifactStore(join(stateDir, "artifacts"))
			: new InMemoryArtifactStore();
		this.contractStore = stateDir ? new JsonlContractStore(join(stateDir, "contracts")) : new InMemoryContractStore();
		this.snapshotStore = stateDir ? new JsonlSnapshotStore(join(stateDir, "snapshots")) : new InMemorySnapshotStore();
		this.recallCatalog = new RecallCatalog({ store: this.artifactStore, tenant: this.tenant });
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
	};

	/** Record a tool execution start in the ledger (planned + started). Never throws. */
	recordToolStarted(toolCallId: string, toolName: string, args: unknown): void {
		try {
			const classification = HfCompactionHost.TOOL_RISK[toolName] ?? {
				sideEffectClass: "none" as const,
				riskLevel: "low" as const,
			};
			const argsHash = sha256Hex(canonicalJson(args ?? {}));
			this.ledger.recordPlanned({
				operationId: `op-${toolCallId}`,
				toolCallId,
				idempotencyKey: `${toolName}:${argsHash.slice(0, 16)}`,
				sideEffectClass: classification.sideEffectClass,
				riskLevel: classification.riskLevel,
				authority: LOCAL_USER,
			});
			this.ledger.recordStarted(toolCallId);
		} catch {
			// Ledger mirroring must never break tool execution.
		}
	}

	/** Record a tool execution outcome. Never throws. */
	recordToolFinished(toolCallId: string, isError: boolean): void {
		try {
			if (isError) {
				this.ledger.recordFailed(toolCallId, {});
			} else {
				this.ledger.recordSucceeded(toolCallId, { exitCode: 0 });
			}
		} catch {
			// ignore ledger mirror failures
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
	private async maybeDistillGoal(entries: SessionEntry[], complete: CompleteFn): Promise<void> {
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
			});
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
		} catch {
			// Distillation is best-effort; the raw derived goal remains as fallback.
		}
	}

	/** Promote the pending distilled goal to the authoritative goal (new audited version). */
	confirmDerivedGoal() {
		const active = this.contractStore.getActive(this.sessionId);
		if (!active?.derivedGoal) {
			throw new Error("No derived goal to confirm");
		}
		const proposal = this.contractStore.proposeUpdate(
			this.sessionId,
			{ goal: active.derivedGoal.text, derivedGoal: null },
			LOCAL_USER,
			"user confirmed distilled goal",
		);
		return this.contractStore.approveProposal(this.sessionId, proposal.proposalId, LOCAL_USER);
	}

	/** Compactor LLM provided via config (tests); production passes one per attempt. */
	get configComplete(): CompleteFn | undefined {
		return this.config.complete;
	}

	get mode(): HfCompactionMode {
		return this.config.mode;
	}

	/**
	 * Sync the event log from the authoritative session entries. Grows by
	 * delta; a shrinking branch (navigation/fork) triggers a full re-seed.
	 */
	syncFromEntries(entries: SessionEntry[]): void {
		try {
			if (entries.length < this.seededCount) {
				// Branch changed shape: rebuild the event log from scratch.
				this.seededCount = 0;
				const fresh = new InMemoryEventLog();
				const events = sessionEntriesToEvents(entries, this.sessionId, "agent-local");
				for (const event of events) {
					fresh.append({
						sessionId: this.sessionId,
						agentId: event.agentId,
						eventType: event.eventType,
						eventId: event.eventId,
						toolCallId: event.toolCallId,
						transactionId: event.transactionId,
						causalParentIds: event.causalParentIds,
						payload: event.payload,
						payloadRef: event.payloadRef,
						authority: event.authority,
						timestamp: event.timestamp,
					});
				}
				this.eventLog = fresh;
				this.seededCount = entries.length;
				return;
			}
			const delta = entries.slice(this.seededCount);
			if (delta.length === 0) return;
			const events = sessionEntriesToEvents(delta, this.sessionId, "agent-local");
			for (const event of events) {
				if (this.eventLog.get(event.eventId)) continue;
				this.eventLog.append({
					sessionId: this.sessionId,
					agentId: event.agentId,
					eventType: event.eventType,
					eventId: event.eventId,
					toolCallId: event.toolCallId,
					transactionId: event.transactionId,
					causalParentIds: event.causalParentIds,
					payload: event.payload,
					payloadRef: event.payloadRef,
					authority: event.authority,
					timestamp: event.timestamp,
				});
			}
			this.seededCount = entries.length;
		} catch {
			// Never let event mirroring break the session.
		}
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
			policy: {
				maxInlineBytes: this.config.offloadThresholdBytes ?? 2000,
				keepRecentToolResults: this.config.keepRecentToolResults ?? 1,
				toolExclusions: [],
				highRiskTools: [],
			},
			keepRecentTokens: overrides?.keepRecentTokens ?? this.config.keepRecentTokens ?? 8000,
			systemPrompt: this.getSystemPrompt(),
			outputReserveTokens: overrides?.outputReserveTokens ?? this.config.outputReserveTokens ?? 4096,
			minTokenGainFraction: this.config.minTokenGainFraction,
			narrativeEnabled: this.config.mode === "full_pipeline",
		};
	}

	/**
	 * Attempt one subsystem compaction. Returns activated=true plus the rebuilt
	 * active messages on success; otherwise activated=false so the caller can
	 * fall back to the legacy path.
	 */
	async attemptCompaction(options: {
		action: "offload_only" | "soft_compact" | "hard_compact";
		complete: CompleteFn;
		manual?: boolean;
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
		this.ensureContractFromEntries(options.branchEntries);
		if (options.action !== "offload_only") {
			await this.maybeDistillGoal(options.branchEntries, options.complete);
		}
		const orchestrator = new CompactionOrchestrator(
			this.orchestratorDeps(options.complete, {
				keepRecentTokens: options.keepRecentTokens,
				outputReserveTokens: options.outputReserveTokens,
			}),
		);
		const result = await orchestrator.compact(options.action, {
			manual: options.manual,
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
		if (options.action === "offload_only") {
			// Offload leaves representation unchanged; the caller keeps its messages.
			const committed = this.audit.byType("compact_committed").at(-1);
			return {
				activated: true,
				summaryText: `offloaded ${committed?.details.offloadedBytes ?? 0} bytes`,
				result,
				tokensBefore: committed?.details.tokensBefore as number | undefined,
				tokensAfter: committed?.details.tokensAfter as number | undefined,
			};
		}
		const messages = this.buildActiveMessages(options.branchEntries);
		if (!messages) {
			return { activated: false, summaryText: "no active snapshot after activation", result };
		}
		const committed = this.audit.byType("compact_committed").at(-1);
		const narrative = this.snapshotStore.getActive(this.sessionId)?.narrative;
		return {
			activated: true,
			messages,
			summaryText: `[high-fidelity snapshot v${result.snapshotVersion} activated]\n${narrative ?? ""}`.trim(),
			result,
			tokensBefore: committed?.details.tokensBefore as number | undefined,
			tokensAfter: committed?.details.tokensAfter as number | undefined,
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

		const built = buildPrompt({
			systemPrompt: this.getSystemPrompt(),
			contract,
			snapshot: active,
			recallGuide: this.recallCatalog.entries().length > 0 ? RECALL_GUIDE_TEXT : undefined,
			tailEvents: [],
			currentInput: "",
			exactRecall: [],
		});
		const pinnedText = built.sections.map((s) => s.text).join("\n\n");

		// Rebuild the tail from the session entries (the truth), keyed by the
		// entryId each event references. Offloaded tool results are projected as
		// preview + recall ref. Falls back to event payloads when entries are
		// unavailable (library use without a SessionManager).
		const entryById = new Map((branchEntries ?? []).map((e) => [e.id, e] as const));
		const offloadByEntryId = new Map(this.recallCatalog.entries().map((r) => [r.eventIds[0], r]));
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

		const pinnedMessage: AgentMessage = {
			role: "user",
			content: pinnedText,
			timestamp: Date.now(),
		};
		return [pinnedMessage, ...tailMessages];
	}

	/** Exact recall by stable ID; throws on unknown/mismatch (fail closed). */
	recallExact(refId: string): string {
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
