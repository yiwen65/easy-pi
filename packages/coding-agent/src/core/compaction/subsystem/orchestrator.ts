/**
 * CCTX-051: Transactional compaction orchestrator.
 *
 * Frozen pipeline (任务书):
 *   read active snapshot + expected version → freeze event boundary →
 *   deterministic reduce → atomic cut → offload payloads, coverage manifest,
 *   recall catalog → structured extraction → narrative → validate / repair /
 *   raw rebuild → build the REAL next request and recount tokens → write
 *   immutable candidate → CAS activate → CompactionCommitted event.
 *
 * No locks are held across model calls (single-writer queue per session).
 * Events appended after the frozen boundary belong to the next version.
 * Every failure path fails closed: the old snapshot stays active, the losing
 * candidate remains auditable, and an audit event records the reason.
 */

import type { ArtifactStore } from "./artifact-store.ts";
import { buildAtomicGroups, planSafeCut } from "./atomic-groups.ts";
import type { EventLog } from "./event-log.ts";
import { COMPACTOR_POLICY_VERSION } from "./injection-guard.ts";
import { generateNarrative } from "./narrative.ts";
import type { AuditTrail } from "./observability.ts";
import { type OffloadPolicy, type OffloadRecord, offloadPayloads } from "./payload-offload.ts";
import { buildPrompt } from "./prompt-builder.ts";
import { type RecallCatalog, recallRefIdForHash } from "./recall-catalog.ts";
import { reduceEvents } from "./reducer.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import { ExtractionError, extractState } from "./state-extractor.ts";
import type { ContractStore } from "./task-contract.ts";
import type { TriggerAction } from "./trigger.ts";
import type { CompleteFn, EventEnvelope, StructuredSnapshot, ValidatorReport } from "./types.ts";
import { COMPACTION_SCHEMA_VERSION } from "./types.ts";
import { planRepair, type ValidationContext, validateCandidate } from "./validator.ts";

export interface OrchestratorDeps {
	/** The session this orchestrator compacts (single-writer per session). */
	sessionId: string;
	eventLog: EventLog;
	artifactStore: ArtifactStore;
	contractStore: ContractStore;
	snapshotStore: SnapshotStore;
	recallCatalog: RecallCatalog;
	audit: AuditTrail;
	complete: CompleteFn;
	tenant: string;
	policy: OffloadPolicy;
	keepRecentTokens: number;
	systemPrompt: string;
	/** Token estimate of the tool definitions sent with the next request. */
	toolsTokenEstimate?: number;
	outputReserveTokens?: number;
	minTokenGainFraction?: number;
	/** structured_compaction mode disables the narrative bridge entirely. */
	narrativeEnabled?: boolean;
	/** Task ledger (design correction): binds candidates to a ledger version (G9). */
	ledger?: import("./task-ledger.ts").TaskLedger;
	/** Raw rebuild hook (T-019). When absent, rebuild escalation rejects. */
	rebuildRunner?: (sessionId: string, boundarySeq: number) => Promise<Omit<StructuredSnapshot, "snapshotVersion">>;
}

export interface CompactOptions {
	currentInput?: string;
	manual?: boolean;
	triggerReasons?: readonly string[];
	currentInputExtraTokens?: number;
	/** Abort signal threaded into compactor model calls. */
	signal?: AbortSignal;
	/**
	 * Shadow mode (CCTX-081): generate + validate + audit the candidate, but
	 * never activate it and never append the commit event.
	 */
	shadow?: boolean;
}

export interface CompactResult {
	status: "activated" | "rejected" | "rebuilt" | "shadow";
	snapshotVersion?: number;
	report?: ValidatorReport;
	reason?: string;
}

const RECALL_GUIDE =
	"Content moved out of the active context can be recalled exactly with recall_exact(refId). Stable refs are listed in the snapshot.";

export class CompactionOrchestrator {
	private deps: OrchestratorDeps;
	private lastLedgerAtFreeze: StructuredSnapshot["taskLedgerRef"];

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
	}

	async compact(action: TriggerAction, options: CompactOptions = {}): Promise<CompactResult> {
		const { eventLog, contractStore, snapshotStore, audit, sessionId } = this.deps;
		audit.record("trigger", sessionId, {
			action,
			manual: options.manual === true,
			reasons: options.triggerReasons?.join("; ") ?? "",
		});

		const contract = contractStore.getActive(sessionId);
		if (!contract) {
			return this.reject("no verified active contract", undefined);
		}
		const active = snapshotStore.getActive(sessionId);
		const expectedActiveVersion = active?.snapshotVersion ?? 0;

		// Freeze the boundary: later events belong to the next version.
		const boundary = eventLog.freeze(sessionId);
		audit.record("boundary_frozen", sessionId, { seq: boundary.seq });
		// G9: bind the candidate to the task-ledger state at freeze time.
		const focusAtFreeze = this.deps.ledger?.getFocusTask();
		const ledgerAtFreeze = this.deps.ledger
			? Object.freeze({
					ledgerVersion: this.deps.ledger.getLedgerVersion(),
					...(focusAtFreeze
						? {
								focusTaskId: focusAtFreeze.taskId,
								focusContractVersion: focusAtFreeze.version,
								taskRef: `task://${focusAtFreeze.taskId}/v${focusAtFreeze.version}`,
							}
						: {}),
				})
			: undefined;
		this.lastLedgerAtFreeze = ledgerAtFreeze;
		const allEvents = eventLog.range(sessionId, 1, boundary.seq);
		if (allEvents.length === 0) {
			return this.reject("no events to compact", undefined);
		}
		const currentInput = options.currentInput ?? "";
		const currentInputExtraTokens = options.currentInputExtraTokens ?? 0;
		const activeTailEvents = allEvents.filter((event) => event.seq > (active?.baseEventSeq ?? 0));
		const priorRecords: OffloadRecord[] = this.deps.recallCatalog
			.entries()
			.filter((entry) => entry.artifactRef !== undefined)
			.flatMap((entry) =>
				entry.eventIds.map((eventId) => ({
					eventId,
					artifactRef: entry.artifactRef!,
					preview: entry.preview,
					hash: entry.hash,
					bytesOffloaded: 0,
				})),
			);

		const tokensBefore = this.countNextRequestWithProjections(
			contract,
			active,
			activeTailEvents,
			currentInput,
			currentInputExtraTokens,
			priorRecords,
		);

		// Deterministic stages first: reduce, groups, cut, offload (约束 10).
		const groups = buildAtomicGroups(allEvents);
		const manifest = planSafeCut(
			groups,
			action === "hard_compact" ? Math.floor(this.deps.keepRecentTokens / 2) : this.deps.keepRecentTokens,
		);
		audit.record("cut", sessionId, {
			cutAfterSeq: manifest.cutAfterSeq,
			keptGroups: manifest.keptGroupIds.length,
			compactedGroups: manifest.compactedGroupIds.length,
			unclosedGroups: manifest.unclosedGroupIds.length,
		});

		if (action === "offload_only") {
			// Offload only the live tail; history at/before the active snapshot
			// boundary is already represented by that snapshot.
			const offloadAll = offloadPayloads({
				events: activeTailEvents,
				store: this.deps.artifactStore,
				policy: this.deps.policy,
				tenant: this.deps.tenant,
				priorRecords,
			});
			audit.record("offload", sessionId, {
				offloaded: offloadAll.records.length,
				failed: offloadAll.failed.length,
				bytes: offloadAll.totalBytesOffloaded,
			});
			return this.compactOffloadOnly(
				sessionId,
				contract,
				active,
				expectedActiveVersion,
				activeTailEvents,
				tokensBefore,
				currentInput,
				currentInputExtraTokens,
				offloadAll.effectiveRecords,
				options.shadow === true,
			);
		}

		const compactedEvents = allEvents.filter((e) => e.seq <= manifest.cutAfterSeq);
		const tailEvents = allEvents.filter((e) => e.seq > manifest.cutAfterSeq);

		// Scan the whole live tail, not just the compacted region: a giant atomic
		// batch retained in the tail must still be recoverable by reference.
		const offload = offloadPayloads({
			events: activeTailEvents,
			store: this.deps.artifactStore,
			policy: this.deps.policy,
			tenant: this.deps.tenant,
			priorRecords,
		});
		audit.record("offload", sessionId, {
			offloaded: offload.records.length,
			failed: offload.failed.length,
			bytes: offload.totalBytesOffloaded,
		});
		manifest.offloadedRefs = offload.effectiveRecords.map((r) => r.artifactRef);

		if (action === "full_rebuild") {
			return this.runRebuild(
				sessionId,
				expectedActiveVersion,
				contract.version,
				boundary.seq,
				tokensBefore,
				currentInput,
				currentInputExtraTokens,
				options.shadow === true,
				offload.effectiveRecords,
			);
		}

		if (compactedEvents.length === 0) {
			// Nothing to compact: no generative work, but the validator still gates
			// activation (e.g. token-gain) so a no-op candidate can never activate.
			const candidate = this.assembleCandidate(
				sessionId,
				contract,
				active,
				active?.baseEventSeq ?? 0,
				reduceEvents([]),
				{
					facts: active?.facts ?? [],
					decisions: active?.decisions ?? [],
					nextActions: active?.nextActions ?? [],
				},
				active?.narrative,
				offload.effectiveRecords,
				boundary.seq,
				allEvents.at(-1)?.eventId,
			);
			const tokensAfter = this.countNextRequestWithProjections(
				contract,
				candidate,
				tailEvents,
				currentInput,
				currentInputExtraTokens,
				offload.effectiveRecords,
			);
			candidate.tokenStats.total = tokensAfter;
			const report = validateCandidate({
				contract,
				ledger: this.deps.ledger,
				candidate: { ...candidate, snapshotVersion: -1 },
				events: allEvents,
				groups,
				manifest,
				deterministicState: reduceEvents(allEvents.filter((e) => e.seq <= candidate.baseEventSeq)),
				tokenStatsBefore: tokensBefore,
				tokenStatsAfter: tokensAfter,
				minTokenGainFraction: this.deps.minTokenGainFraction,
			});
			audit.record("validate", sessionId, { passed: report.passed, reason: "empty-compaction" });
			if (options.shadow) {
				const written = snapshotStore.putCandidate({ ...candidate, validatorReport: report });
				audit.record(
					"shadow_candidate",
					sessionId,
					{ version: written.snapshotVersion, passed: report.passed, tokensBefore, tokensAfter, noop: true },
					written.snapshotVersion,
				);
				return { status: "shadow", snapshotVersion: written.snapshotVersion, report };
			}
			return this.reject("nothing to compact or insufficient token gain", report);
		}

		// Deterministic reduce over the compacted range (snapshot covers it; the tail stays verbatim).
		let deterministicState: ReturnType<typeof reduceEvents>;
		try {
			deterministicState = reduceEvents(compactedEvents);
		} catch (error) {
			return this.reject(`reduce failed: ${error instanceof Error ? error.message : String(error)}`, undefined);
		}
		audit.record("reduce", sessionId, {
			events: compactedEvents.length,
			tasks: deterministicState.tasks.length,
			tools: deterministicState.tools.length,
		});

		// Generative stages with repair escalation.
		let lastReport: ValidatorReport | undefined;
		for (let attempt = 0; attempt <= 2; attempt++) {
			let extracted: Awaited<ReturnType<typeof extractState>>;
			try {
				extracted = await extractState(
					{
						contract,
						deterministicState,
						priorSnapshot: active,
						coverageManifest: manifest,
						events: compactedEvents,
						groups,
						signal: options.signal,
					},
					this.deps.complete,
				);
			} catch (error) {
				if (error instanceof ExtractionError || error instanceof Error) {
					return this.reject(`extraction failed: ${error.message}`, lastReport);
				}
				throw error;
			}
			audit.record("extract", sessionId, {
				facts: extracted.merged.facts.length,
				decisions: extracted.merged.decisions.length,
				nextActions: extracted.merged.nextActions.length,
				droppedUnsourced: extracted.droppedUnsourced,
				outOfRangeRefs: extracted.outOfRangeRefs.length,
			});

			// Narrative bridge: lossy. A rejected narrative never blocks the typed candidate.
			const narrative = await generateNarrative(
				{
					contract,
					deterministicState,
					extracted: extracted.merged,
					priorNarrative: active?.narrative,
					events: compactedEvents,
					signal: options.signal,
					narrativeEnabled: this.deps.narrativeEnabled ?? true,
				},
				this.deps.complete,
			);
			audit.record("narrative", sessionId, {
				rejected: narrative.rejected,
				conflicts: narrative.conflicts.length,
				chars: narrative.text.length,
			});

			const candidate = this.assembleCandidate(
				sessionId,
				contract,
				active,
				manifest.cutAfterSeq,
				deterministicState,
				extracted.merged,
				narrative.rejected ? undefined : narrative.text,
				offload.effectiveRecords,
				boundary.seq,
				allEvents.at(-1)?.eventId,
			);

			// Build the REAL next request and recount tokens (验收: 完整下一请求重计).
			// Offloaded tail events render as ref+preview, so offload gains count.
			const tokensAfter = this.countNextRequestWithProjections(
				contract,
				candidate,
				tailEvents,
				currentInput,
				currentInputExtraTokens,
				offload.effectiveRecords,
			);
			candidate.tokenStats = {
				...candidate.tokenStats,
				total: tokensAfter,
			};

			const validationCtx: ValidationContext = {
				contract,
				ledger: this.deps.ledger,
				candidate: { ...candidate, snapshotVersion: -1 },
				events: allEvents,
				groups,
				manifest,
				deterministicState,
				tokenStatsBefore: tokensBefore,
				tokenStatsAfter: tokensAfter,
				minTokenGainFraction: this.deps.minTokenGainFraction,
			};
			const report = validateCandidate(validationCtx);
			lastReport = report;
			audit.record("validate", sessionId, {
				passed: report.passed,
				p0: report.failures.filter((f) => f.severity === "P0").length,
				p1: report.failures.filter((f) => f.severity === "P1").length,
				tokensBefore,
				tokensAfter,
			});

			// Shadow (CCTX-081): write the auditable candidate, record the shadow
			// outcome with token projections, and never repair/activate/commit.
			if (options.shadow) {
				const written = snapshotStore.putCandidate({ ...candidate, validatorReport: report });
				audit.record(
					"shadow_candidate",
					sessionId,
					{
						version: written.snapshotVersion,
						passed: report.passed,
						p0: report.failures.filter((f) => f.severity === "P0").length,
						tokensBefore,
						tokensAfter,
					},
					written.snapshotVersion,
				);
				if (report.passed) {
					return { status: "shadow", snapshotVersion: written.snapshotVersion, report };
				}
				return this.reject("shadow candidate failed validation", report);
			}

			if (report.passed) {
				// G9: the ledger must not have moved since the frozen boundary.
				if (ledgerAtFreeze && this.deps.ledger) {
					const currentVersion = this.deps.ledger.getLedgerVersion();
					if (currentVersion !== ledgerAtFreeze.ledgerVersion) {
						audit.record("cas_conflict", sessionId, {
							ledgerExpected: ledgerAtFreeze.ledgerVersion,
							ledgerActual: currentVersion,
						});
						return this.reject("task ledger drifted during compaction", {
							...report,
							passed: false,
							rejected: true,
							failures: [
								...report.failures,
								{
									code: "task-ledger-drift",
									severity: "P0",
									message: `task ledger version moved ${ledgerAtFreeze.ledgerVersion} → ${currentVersion} during compaction`,
								},
							],
						});
					}
				}
				return this.tryActivate(
					sessionId,
					candidate,
					expectedActiveVersion,
					manifest.cutAfterSeq,
					report,
					tokensBefore,
					tokensAfter,
					offload.totalBytesOffloaded,
					offload.effectiveRecords,
				);
			}

			const plan = planRepair(report, attempt);
			audit.record("repair", sessionId, { attempt, plan, failures: report.failures.map((f) => f.code).join(",") });
			if (plan === "repair") {
				continue; // one controlled repair: re-run extraction+narrative
			}
			if (plan === "rebuild") {
				const rebuilt = await this.runRebuild(
					sessionId,
					expectedActiveVersion,
					contract.version,
					boundary.seq,
					tokensBefore,
					currentInput,
					currentInputExtraTokens,
					false,
					offload.effectiveRecords,
				);
				if (rebuilt.status === "rebuilt" || rebuilt.status === "activated") {
					return rebuilt;
				}
				continue; // rebuild unavailable → loop reaches attempt limit → reject
			}
			return this.reject("validator rejected candidate", report);
		}
		return this.reject("repair attempts exhausted", lastReport);
	}

	/** Offload-only path: no summarization, no cut; deterministic candidate from prior state. */
	private async compactOffloadOnly(
		sessionId: string,
		contract: ReturnType<ContractStore["getActive"]> & object,
		active: StructuredSnapshot | undefined,
		expectedActiveVersion: number,
		allEvents: EventEnvelope[],
		tokensBefore: number,
		currentInput: string,
		currentInputExtraTokens: number,
		records: OffloadRecord[],
		shadow: boolean,
	): Promise<CompactResult> {
		const { audit } = this.deps;
		const groups = buildAtomicGroups(allEvents);
		const manifest = {
			cutAfterSeq: 0,
			keptGroupIds: groups.map((g) => g.groupId),
			compactedGroupIds: [] as string[],
			offloadedRefs: records.map((r) => r.artifactRef),
			unclosedGroupIds: groups.filter((g) => !g.closed).map((g) => g.groupId),
		};
		// Candidate mirrors the prior snapshot's coverage; only offload refs grow.
		const candidate: Omit<StructuredSnapshot, "snapshotVersion"> = {
			sessionId,
			parentVersion: active?.snapshotVersion ?? null,
			baseEventSeq: active?.baseEventSeq ?? 0,
			lineage: active ? [...active.lineage, active.snapshotVersion] : [],
			contractRef: { contractId: contract.contractId, version: contract.version },
			taskLedgerRef: this.lastLedgerAtFreeze,
			constraints: contract.constraints.map((c) => ({ ...c })),
			facts: active?.facts ?? [],
			decisions: active?.decisions ?? [],
			tasks: active?.tasks ?? [],
			tools: active?.tools ?? [],
			artifacts: active?.artifacts ?? [],
			errors: active?.errors ?? [],
			nextActions: active?.nextActions ?? [],
			recallCatalogRefs: [
				...new Set([
					...this.deps.recallCatalog.entries().map((entry) => entry.refId),
					...records.map((record) => recallRefIdForHash(record.hash)),
				]),
			],
			sourceEventRanges: active?.sourceEventRanges ?? [],
			narrative: active?.narrative,
			compactor: {
				promptVersion: COMPACTOR_POLICY_VERSION,
				schemaVersion: COMPACTION_SCHEMA_VERSION,
				kind: "offload_only",
				triggerEventSeq: allEvents.at(-1)?.seq,
				triggerHeadEventId: allEvents.at(-1)?.eventId,
			},
			tokenStats: emptyTokenStats(),
			createdAt: new Date().toISOString(),
			schemaVersion: COMPACTION_SCHEMA_VERSION,
		};
		// After-prompt: same events, with offloaded payloads projected as refs.
		const tokensAfter = this.countNextRequestWithProjections(
			contract,
			active,
			allEvents,
			currentInput,
			currentInputExtraTokens,
			records,
		);
		candidate.tokenStats.total = tokensAfter;
		const deterministicState = reduceEvents(allEvents.filter((e) => e.seq <= candidate.baseEventSeq));
		const report = validateCandidate({
			contract,
			ledger: this.deps.ledger,
			candidate: { ...candidate, snapshotVersion: -1 },
			events: allEvents,
			groups,
			manifest,
			deterministicState,
			tokenStatsBefore: tokensBefore,
			tokenStatsAfter: tokensAfter,
			minTokenGainFraction: this.deps.minTokenGainFraction,
		});
		audit.record("validate", sessionId, { passed: report.passed, mode: "offload_only" });
		if (!report.passed) {
			return this.reject("offload-only candidate failed validation", report);
		}
		if (shadow) {
			const written = this.deps.snapshotStore.putCandidate({ ...candidate, validatorReport: report });
			audit.record(
				"shadow_candidate",
				sessionId,
				{ version: written.snapshotVersion, passed: true, offloadOnly: true, tokensBefore, tokensAfter },
				written.snapshotVersion,
			);
			return { status: "shadow", snapshotVersion: written.snapshotVersion, report };
		}
		return this.tryActivate(
			sessionId,
			candidate,
			expectedActiveVersion,
			candidate.baseEventSeq,
			report,
			tokensBefore,
			tokensAfter,
			0,
			records,
		);
	}

	private async runRebuild(
		sessionId: string,
		expectedActiveVersion: number,
		expectedContractVersion: number,
		boundarySeq: number,
		tokensBefore: number,
		currentInput: string,
		currentInputExtraTokens: number,
		shadow: boolean,
		offloadRecords: OffloadRecord[],
	): Promise<CompactResult> {
		const { audit, eventLog, contractStore } = this.deps;
		if (!this.deps.rebuildRunner) {
			audit.record("rebuild", sessionId, { available: false });
			return { status: "rejected", reason: "raw rebuild unavailable" };
		}
		const started = Date.now();
		let rebuilt: Omit<StructuredSnapshot, "snapshotVersion">;
		try {
			rebuilt = await this.deps.rebuildRunner(sessionId, boundarySeq);
		} catch (error) {
			return this.reject(`raw rebuild failed: ${error instanceof Error ? error.message : String(error)}`, undefined);
		}
		const stagedRecallRefs = offloadRecords.map((record) => recallRefIdForHash(record.hash));
		const rebuiltWithRecall = {
			...rebuilt,
			recallCatalogRefs: [...new Set([...rebuilt.recallCatalogRefs, ...stagedRecallRefs])],
		};
		const candidate: Omit<StructuredSnapshot, "snapshotVersion"> = this.deps.ledger
			? { ...rebuiltWithRecall, taskLedgerRef: this.lastLedgerAtFreeze }
			: rebuiltWithRecall;
		const contract = contractStore.getActive(sessionId);
		if (!contract || contract.version !== expectedContractVersion) {
			return this.reject("global contract drifted during raw rebuild", undefined);
		}
		const events = eventLog.range(sessionId, 1, boundarySeq);
		const coveredEvents = events.filter((event) => event.seq <= candidate.baseEventSeq);
		const groups = buildAtomicGroups(events);
		const compactedGroups = groups.filter((group) => group.toSeq <= candidate.baseEventSeq);
		const manifest = {
			cutAfterSeq: candidate.baseEventSeq,
			keptGroupIds: groups.filter((group) => group.toSeq > candidate.baseEventSeq).map((group) => group.groupId),
			compactedGroupIds: compactedGroups.map((group) => group.groupId),
			offloadedRefs: candidate.recallCatalogRefs,
			unclosedGroupIds: groups.filter((group) => !group.closed).map((group) => group.groupId),
		};
		const tokensAfter = this.countNextRequestWithProjections(
			contract,
			candidate,
			events.filter((event) => event.seq > candidate.baseEventSeq),
			currentInput,
			currentInputExtraTokens,
			offloadRecords,
		);
		candidate.tokenStats.total = tokensAfter;
		const report = validateCandidate({
			contract,
			ledger: this.deps.ledger,
			candidate: { ...candidate, snapshotVersion: -1 },
			events,
			groups,
			manifest,
			deterministicState: reduceEvents(coveredEvents),
			tokenStatsBefore: tokensBefore,
			tokenStatsAfter: tokensAfter,
			minTokenGainFraction: this.deps.minTokenGainFraction,
		});
		audit.record("validate", sessionId, { passed: report.passed, rebuild: true });
		if (!report.passed) return this.reject("raw rebuild candidate failed validation", report);
		if (shadow) {
			const written = this.deps.snapshotStore.putCandidate({ ...candidate, validatorReport: report });
			audit.record(
				"shadow_candidate",
				sessionId,
				{ version: written.snapshotVersion, passed: true, rebuild: true, tokensBefore, tokensAfter },
				written.snapshotVersion,
			);
			return { status: "shadow", snapshotVersion: written.snapshotVersion, report };
		}
		const result = this.tryActivate(
			sessionId,
			candidate,
			expectedActiveVersion,
			candidate.baseEventSeq,
			report,
			tokensBefore,
			tokensAfter,
			0,
			offloadRecords,
		);
		if (result.status === "activated") {
			audit.record("rebuild", sessionId, { available: true, mttrMs: Date.now() - started }, result.snapshotVersion);
			return { ...result, status: "rebuilt" };
		}
		return result;
	}

	private assembleCandidate(
		sessionId: string,
		contract: NonNullable<ReturnType<ContractStore["getActive"]>>,
		active: StructuredSnapshot | undefined,
		baseEventSeq: number,
		deterministicState: ReturnType<typeof reduceEvents>,
		extracted: {
			facts: StructuredSnapshot["facts"];
			decisions: StructuredSnapshot["decisions"];
			nextActions: StructuredSnapshot["nextActions"];
		},
		narrative: string | undefined,
		offloadRecords: OffloadRecord[],
		triggerEventSeq: number,
		triggerHeadEventId: string | undefined,
	): Omit<StructuredSnapshot, "snapshotVersion"> {
		const artifacts = [...deterministicState.artifacts];
		for (const record of offloadRecords) {
			if (!artifacts.some((a) => a.ref === record.artifactRef)) {
				artifacts.push({
					ref: record.artifactRef,
					kind: "tool_result",
					size: record.bytesOffloaded,
					preview: record.preview,
					pinned: true,
					provenance: { sourceEventIds: [record.eventId], source: "reducer" },
				});
			}
		}
		return {
			sessionId,
			parentVersion: active?.snapshotVersion ?? null,
			baseEventSeq,
			lineage: active ? [...active.lineage, active.snapshotVersion] : [],
			contractRef: { contractId: contract.contractId, version: contract.version },
			taskLedgerRef: this.lastLedgerAtFreeze,
			// Constraints are copied verbatim from the verified contract — never summarized.
			constraints: contract.constraints.map((c) => ({ ...c })),
			facts: extracted.facts,
			decisions: extracted.decisions,
			tasks: deterministicState.tasks,
			tools: deterministicState.tools,
			artifacts,
			errors: deterministicState.errors,
			nextActions: extracted.nextActions,
			recallCatalogRefs: [
				...new Set([
					...this.deps.recallCatalog.entries().map((entry) => entry.refId),
					...offloadRecords.map((record) => recallRefIdForHash(record.hash)),
				]),
			],
			sourceEventRanges: baseEventSeq > 0 ? [{ fromSeq: 1, toSeq: baseEventSeq }] : [],
			narrative,
			compactor: {
				promptVersion: COMPACTOR_POLICY_VERSION,
				schemaVersion: COMPACTION_SCHEMA_VERSION,
				kind: "incremental",
				triggerEventSeq,
				triggerHeadEventId,
			},
			tokenStats: emptyTokenStats(),
			createdAt: new Date().toISOString(),
			schemaVersion: COMPACTION_SCHEMA_VERSION,
		};
	}

	private countNextRequest(
		contract: NonNullable<ReturnType<ContractStore["getActive"]>>,
		snapshot: StructuredSnapshot | Omit<StructuredSnapshot, "snapshotVersion"> | undefined,
		tailEvents: EventEnvelope[],
		currentInput: string,
		currentInputExtraTokens = 0,
	): number {
		const built = buildPrompt({
			systemPrompt: this.deps.systemPrompt,
			contract,
			ledger: this.deps.ledger,
			snapshot: snapshot as StructuredSnapshot | undefined,
			recallGuide:
				this.deps.recallCatalog.entries().length > 0 || (snapshot?.recallCatalogRefs.length ?? 0) > 0
					? RECALL_GUIDE
					: undefined,
			tailEvents,
			currentInput,
			exactRecall: [],
			toolsTokenEstimate: this.deps.toolsTokenEstimate,
			outputReserveTokens: this.deps.outputReserveTokens ?? 0,
		});
		return built.tokenStats.total + currentInputExtraTokens;
	}

	private countNextRequestWithProjections(
		contract: NonNullable<ReturnType<ContractStore["getActive"]>>,
		snapshot: StructuredSnapshot | Omit<StructuredSnapshot, "snapshotVersion"> | undefined,
		events: EventEnvelope[],
		currentInput: string,
		currentInputExtraTokens: number,
		records: OffloadRecord[],
	): number {
		const byEvent = new Map(records.map((r) => [r.eventId, r]));
		const projected = events.map((e) => {
			const record = byEvent.get(e.eventId);
			if (!record) return e;
			return {
				...e,
				payload: { text: `[offloaded ${record.artifactRef}] ${record.preview}` },
			};
		});
		return this.countNextRequest(contract, snapshot, projected, currentInput, currentInputExtraTokens);
	}

	private assertFrozenExternalState(expectedContractVersion: number): void {
		const activeContract = this.deps.contractStore.getActive(this.deps.sessionId);
		if (activeContract?.version !== expectedContractVersion) {
			throw new Error(
				`global contract version drifted: expected ${expectedContractVersion}, actual ${String(activeContract?.version)}`,
			);
		}

		const expected = this.lastLedgerAtFreeze;
		if (!expected) return;
		const ledger = this.deps.ledger;
		if (!ledger) throw new Error("task ledger unavailable at final activation");
		const focus = ledger.getFocusTask();
		const actual = {
			ledgerVersion: ledger.getLedgerVersion(),
			focusTaskId: ledger.getFocusTaskId(),
			focusContractVersion: focus?.version,
		};
		for (const field of ["ledgerVersion", "focusTaskId", "focusContractVersion"] as const) {
			if (actual[field] !== expected[field]) {
				throw new Error(
					`task ledger ${field} drifted: expected ${String(expected[field])}, actual ${String(actual[field])}`,
				);
			}
		}
	}

	private tryActivate(
		sessionId: string,
		candidate: Omit<StructuredSnapshot, "snapshotVersion">,
		expectedActiveVersion: number,
		baseEventSeq: number,
		report: ValidatorReport,
		tokensBefore: number,
		tokensAfter: number,
		offloadedBytes: number,
		offloadRecords: OffloadRecord[] = [],
	): CompactResult {
		const { snapshotStore, eventLog, audit } = this.deps;
		const written = snapshotStore.putCandidate({ ...candidate, validatorReport: report });
		audit.record("candidate_written", sessionId, { version: written.snapshotVersion, baseEventSeq });
		try {
			for (const record of offloadRecords) {
				this.deps.recallCatalog.addFromOffload(record, "tool_result");
			}
			snapshotStore.activate(sessionId, {
				expectedActiveVersion,
				candidateVersion: written.snapshotVersion,
				minBaseEventSeq: baseEventSeq,
				assertExternalState: () => this.assertFrozenExternalState(candidate.contractRef.version),
			});
		} catch (error) {
			// CAS/external-state conflict: the candidate stays auditable, old state untouched.
			const message = String(error);
			const code = message.includes("task ledger")
				? "task-ledger-drift"
				: message.includes("global contract")
					? "contract-drift"
					: "cas-conflict";
			audit.record("cas_conflict", sessionId, {
				version: written.snapshotVersion,
				error: message.slice(0, 120),
			});
			return {
				status: "rejected",
				report: {
					...report,
					passed: false,
					rejected: true,
					failures: [...report.failures, { code, severity: "P0", message }],
				},
				reason: "CAS activation conflict",
			};
		}
		audit.record("cas_activated", sessionId, { version: written.snapshotVersion }, written.snapshotVersion);
		try {
			eventLog.append({
				sessionId,
				agentId: "compaction-orchestrator",
				eventType: "compaction",
				payload: {
					kind: "compaction_committed",
					snapshotVersion: written.snapshotVersion,
					baseEventSeq,
					tokensBefore,
					tokensAfter,
					offloadedBytes,
				},
				authority: { kind: "system", id: "compaction-orchestrator", verified: true },
			});
		} catch (error) {
			audit.record("commit_log_failed", sessionId, {
				version: written.snapshotVersion,
				error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
			});
		}
		audit.record(
			"compact_committed",
			sessionId,
			{ version: written.snapshotVersion, tokensBefore, tokensAfter, offloadedBytes },
			written.snapshotVersion,
		);
		return { status: "activated", snapshotVersion: written.snapshotVersion, report };
	}

	private reject(reason: string, report: ValidatorReport | undefined): CompactResult {
		this.deps.audit.record("reject", this.deps.sessionId, {
			reason: reason.slice(0, 160),
			p0: report?.failures.filter((f) => f.severity === "P0").length ?? 0,
		});
		return { status: "rejected", reason, report };
	}
}

function emptyTokenStats() {
	return {
		system: 0,
		tools: 0,
		contract: 0,
		snapshot: 0,
		narrative: 0,
		recall: 0,
		recentTail: 0,
		currentInput: 0,
		outputReserve: 0,
		total: 0,
	};
}
