/**
 * CCTX-071: evaluation runner. Runs a fixture trajectory through the
 * subsystem with any CompleteFn (faux in tests, production adapter for real
 * models — swap one function to evaluate real providers).
 */

import { InMemoryArtifactStore } from "../../../src/core/compaction/subsystem/artifact-store.ts";
import { InMemoryEventLog } from "../../../src/core/compaction/subsystem/event-log.ts";
import { AuditTrail } from "../../../src/core/compaction/subsystem/observability.ts";
import { CompactionOrchestrator } from "../../../src/core/compaction/subsystem/orchestrator.ts";
import { RecallCatalog } from "../../../src/core/compaction/subsystem/recall-catalog.ts";
import { reduceEvents } from "../../../src/core/compaction/subsystem/reducer.ts";
import { InMemorySnapshotStore } from "../../../src/core/compaction/subsystem/snapshot-store.ts";
import { InMemoryContractStore } from "../../../src/core/compaction/subsystem/task-contract.ts";
import type { CompleteFn } from "../../../src/core/compaction/subsystem/types.ts";
import type { EvalFixture, EvalReport } from "./atoms.ts";
import { type GradingContext, gradeAtom, gradeNeedles } from "./grader.ts";

const EVAL_USER = { kind: "user", id: "eval-user", verified: true } as const;

function roundEnd(events: EvalFixture["events"], start: number, round: number, rounds: number): number {
	if (round === rounds - 1) return events.length;
	const target = Math.max(start + 1, Math.ceil((events.length * (round + 1)) / rounds));
	const openToolCalls = new Set<string>();
	let lastClosed = start;
	for (let index = start; index < events.length; index++) {
		const event = events[index];
		if (event.eventType === "message" && event.authority?.kind === "user" && event.authority.verified) {
			openToolCalls.clear();
		}
		if (event.eventType === "tool_call" && event.toolCallId) openToolCalls.add(event.toolCallId);
		if (event.eventType === "tool_result" && event.toolCallId) openToolCalls.delete(event.toolCallId);
		if (openToolCalls.size === 0) lastClosed = index + 1;
		if (index + 1 === target && openToolCalls.size === 0) return target;
		if (index + 1 === target && lastClosed > start) return lastClosed;
		if (index + 1 > target && openToolCalls.size === 0) return index + 1;
	}
	return events.length;
}

export async function runEval(fixture: EvalFixture, complete: CompleteFn): Promise<EvalReport> {
	const sessionId = `eval-${fixture.name}`;
	const eventLog = new InMemoryEventLog();
	const artifactStore = new InMemoryArtifactStore();
	const contractStore = new InMemoryContractStore();
	contractStore.create({
		contractId: `c-${fixture.name}`,
		sessionId,
		goal: fixture.contract.goal,
		acceptanceCriteria: [],
		constraints: fixture.contract.constraints.map((text, i) => ({
			id: `c-${i + 1}`,
			kind: "negative" as const,
			text,
			authority: EVAL_USER,
		})),
		permissions: { allow: [], deny: [], approvalRequired: [] },
		budgets: {},
		authority: EVAL_USER,
		allowedUpdaters: [EVAL_USER.id],
	});

	let counter = 0;
	const deps = {
		sessionId,
		eventLog,
		artifactStore,
		contractStore,
		snapshotStore: new InMemorySnapshotStore(),
		recallCatalog: new RecallCatalog({ store: artifactStore, tenant: "eval" }),
		audit: new AuditTrail(),
		complete,
		tenant: "eval",
		policy: { maxInlineBytes: 1200, keepRecentToolResults: 0, toolExclusions: [], highRiskTools: [] },
		keepRecentTokens: 150,
		systemPrompt: "EVAL",
		outputReserveTokens: 256,
		minTokenGainFraction: 0,
	};

	// Reveal a closed segment before each attempt so multi-round evaluation
	// measures growth -> compaction -> growth -> compaction. Never split an open
	// tool call from its result merely to hit an even segment size.
	let tokensBeforeFirst = 0;
	let tokensAfterLast = 0;
	let roundsActivated = 0;
	let roundsRejected = 0;
	const rejectReasons: string[] = [];
	let appended = 0;
	for (let round = 0; round < fixture.compactionRounds; round++) {
		const end = roundEnd(fixture.events, appended, round, fixture.compactionRounds);
		for (const spec of fixture.events.slice(appended, end)) {
			counter += 1;
			eventLog.append({
				sessionId,
				agentId: "agent-eval",
				eventId: spec.id ?? `ev-${counter}`,
				eventType: spec.eventType,
				toolCallId: spec.toolCallId,
				payload: spec.payload,
				authority: spec.authority ?? { kind: "agent", id: "agent-eval", verified: true },
			});
		}
		appended = end;
		const orchestrator = new CompactionOrchestrator(deps);
		const result = await orchestrator.compact("soft_compact", { currentInput: "" });
		if (result.status === "activated" || result.status === "rebuilt") {
			roundsActivated += 1;
		} else {
			roundsRejected += 1;
			const validationFailures = result.report?.failures
				.map((failure) => `${failure.code}: ${failure.message}`)
				.join(" | ");
			rejectReasons.push(
				validationFailures
					? `${result.reason ?? result.status}: ${validationFailures}`
					: (result.reason ?? result.status),
			);
		}
		const committed = deps.audit.byType("compact_committed").at(-1);
		if (roundsActivated === 1 && tokensBeforeFirst === 0 && committed) {
			tokensBeforeFirst = committed.details.tokensBefore as number;
		}
		if (committed) {
			tokensAfterLast = committed.details.tokensAfter as number;
		}
	}

	// Oracle: full replay vs snapshot-deterministic state on the covered range.
	const allEvents = eventLog.all(sessionId);
	const active = deps.snapshotStore.getActive(sessionId);
	const oracleConsistent = active
		? JSON.stringify(reduceEvents(allEvents.filter((e) => e.seq <= active.baseEventSeq)).tasks) ===
				JSON.stringify(active.tasks) &&
			JSON.stringify(reduceEvents(allEvents.filter((e) => e.seq <= active.baseEventSeq)).tools) ===
				JSON.stringify(active.tools)
		: true;

	const ctx: GradingContext = {
		contract: contractStore.getActive(sessionId)!,
		snapshot: active,
		tailEvents: active ? allEvents.filter((e) => e.seq > active.baseEventSeq) : allEvents,
		allEvents,
		recallCatalog: deps.recallCatalog,
	};

	const atoms = [...fixture.atoms.map((a) => gradeAtom(a, ctx)), ...gradeNeedles(fixture.needleQueries, ctx)];
	const retentionByKind: Record<string, number> = {};
	for (const kind of ["F", "C", "R", "S", "U", "D", "T", "P"]) {
		const ofKind = atoms.filter((a) => a.kind === kind);
		if (ofKind.length === 0) continue;
		retentionByKind[kind] = ofKind.filter((a) => a.passed).length / ofKind.length;
	}
	const overallRetention = atoms.length === 0 ? 1 : atoms.filter((a) => a.passed).length / atoms.length;

	return {
		fixture: fixture.name,
		compactionRounds: fixture.compactionRounds,
		atoms,
		retentionByKind,
		overallRetention,
		oracleConsistent,
		tokensBeforeFirst,
		tokensAfterLast,
		roundsActivated,
		roundsRejected,
		rejectReasons,
	};
}
