/**
 * CCTX-042: Candidate validator and repair planning.
 *
 * Every compaction candidate passes P0 validators before activation:
 * schema, contract coverage/contradiction, exact fields, provenance, task
 * state transitions, tool pairing, loop atomicity, side-effect monotonicity,
 * injection, and token gain. P1 validators warn without blocking alone.
 *
 * Repair discipline: first repairable failure → one controlled repair; second
 * failure → raw rebuild; still failing → reject, old snapshot stays active.
 * Constraint, side-effect, and injection failures are never model-repairable.
 */

import { detectInjections } from "./injection-guard.ts";
import type { VersionedTaskLedgerLike } from "./prompt-builder.ts";
import type { DeterministicState } from "./reducer.ts";
import type {
	AtomicGroup,
	CoverageManifest,
	EventEnvelope,
	StructuredSnapshot,
	TaskContract,
	ValidatorFailure,
	ValidatorReport,
} from "./types.ts";

export interface ValidationContext {
	contract: TaskContract;
	/** Current task ledger used to verify the candidate's frozen ledger binding. */
	ledger?: VersionedTaskLedgerLike;
	candidate: StructuredSnapshot;
	events: EventEnvelope[];
	groups: AtomicGroup[];
	manifest: CoverageManifest;
	deterministicState: DeterministicState;
	tokenStatsBefore: number;
	tokenStatsAfter: number;
	/** Minimum fractional drop of the full next request. Default 5%. */
	minTokenGainFraction?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventText(event: EventEnvelope): string {
	const payload = event.payload;
	if (typeof payload === "string") return payload;
	if (isRecord(payload)) {
		if (typeof payload.text === "string") return payload.text;
		if (typeof payload.content === "string") return payload.content;
		if (Array.isArray(payload.content)) {
			return payload.content
				.filter((b): b is { type: string; text?: string; name?: unknown } => isRecord(b))
				.map((b) => (typeof b.text === "string" ? b.text : b.type === "toolCall" ? String(b.name ?? "") : ""))
				.filter((t) => t.length > 0)
				.join("\n");
		}
		if (isRecord(payload.message)) return eventText({ ...event, payload: payload.message });
	}
	return "";
}

const EXACT_VALUE_PATTERN = /\b\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?|\/[^\s,;"')]+|\b[0-9a-f]{16,}\b|\b\d{5,}\b/gi;

const REQUIRED_SNAPSHOT_FIELDS: (keyof StructuredSnapshot)[] = [
	"sessionId",
	"baseEventSeq",
	"lineage",
	"contractRef",
	"constraints",
	"facts",
	"decisions",
	"tasks",
	"tools",
	"artifacts",
	"errors",
	"nextActions",
	"recallCatalogRefs",
	"sourceEventRanges",
	"compactor",
	"tokenStats",
	"createdAt",
	"schemaVersion",
];

export function validateCandidate(ctx: ValidationContext): ValidatorReport {
	const failures: ValidatorFailure[] = [];
	const p0 = (code: string, message: string, refs?: string[]) =>
		failures.push({ code, severity: "P0", message, refs });
	const p1 = (code: string, message: string, refs?: string[]) =>
		failures.push({ code, severity: "P1", message, refs });

	// --- schema ---
	for (const field of REQUIRED_SNAPSHOT_FIELDS) {
		if (ctx.candidate[field] === undefined) {
			p0("schema", `snapshot missing required field "${field}"`);
		}
	}
	if (ctx.candidate.schemaVersion !== 1) {
		p0("schema", `unsupported snapshot schemaVersion ${ctx.candidate.schemaVersion}`);
	}

	// --- exact task-ledger binding ---
	if (ctx.ledger) {
		const focus = ctx.ledger.getFocusTask();
		const expected = {
			ledgerVersion: ctx.ledger.getLedgerVersion(),
			focusTaskId: focus?.taskId,
			focusContractVersion: focus?.version,
			taskRef: focus ? `task://${focus.taskId}/v${focus.version}` : undefined,
		};
		const actual = ctx.candidate.taskLedgerRef;
		if (!actual) {
			p0("task-ledger-ref", "candidate is missing the required frozen task-ledger reference");
		} else {
			for (const field of ["ledgerVersion", "focusTaskId", "focusContractVersion", "taskRef"] as const) {
				if (actual[field] !== expected[field]) {
					p0(
						"task-ledger-ref",
						`task-ledger reference ${field} mismatch: expected ${String(expected[field])}, got ${String(actual[field])}`,
					);
				}
			}
		}
	}

	// --- contract coverage + contradiction ---
	for (const constraint of ctx.contract.constraints) {
		const inCandidate = ctx.candidate.constraints.find((c) => c.id === constraint.id);
		if (!inCandidate) {
			p0("contract-coverage", `active constraint ${constraint.id} missing from candidate: "${constraint.text}"`, [
				constraint.id,
			]);
		} else if (inCandidate.text !== constraint.text || inCandidate.kind !== constraint.kind) {
			p0(
				"contract-contradiction",
				`constraint ${constraint.id} text/kind drifted: contract "${constraint.text}" vs candidate "${inCandidate.text}"`,
				[constraint.id],
			);
		}
	}

	// --- provenance: every critical field resolves to real events ---
	const eventIds = new Set(ctx.events.map((e) => e.eventId));
	const checkProvenance = (owner: string, sourceEventIds: string[]) => {
		if (sourceEventIds.length === 0) {
			p0("provenance", `${owner} has no source events`);
			return;
		}
		for (const id of sourceEventIds) {
			if (!eventIds.has(id)) {
				p0("provenance", `${owner} references unresolvable event ${id}`, [id]);
			}
		}
	};
	for (const f of ctx.candidate.facts) checkProvenance(`fact ${f.id}`, f.provenance.sourceEventIds);
	for (const d of ctx.candidate.decisions) checkProvenance(`decision ${d.id}`, d.provenance.sourceEventIds);
	for (const t of ctx.candidate.tasks) checkProvenance(`task ${t.id}`, t.provenance.sourceEventIds);
	for (const e of ctx.candidate.errors) checkProvenance(`error ${e.id}`, e.provenance.sourceEventIds);

	// --- exact fields: verified facts must ground their exact values in events ---
	for (const fact of ctx.candidate.facts) {
		if (!fact.verified) continue;
		const groundTruth = ctx.events.map(eventText).join("\n");
		const seen = new Set<string>();
		for (const match of fact.text.matchAll(EXACT_VALUE_PATTERN)) {
			const value = match[0];
			if (seen.has(value)) continue;
			seen.add(value);
			if (!groundTruth.includes(value)) {
				p0("exact-field", `verified fact ${fact.id} contains ungrounded exact value "${value}"`, [fact.id]);
			}
		}
	}

	// --- task state transitions: candidate must equal deterministic derivation ---
	for (const task of ctx.candidate.tasks) {
		const deterministic = ctx.deterministicState.tasks.find((t) => t.id === task.id);
		if (!deterministic) {
			p0("task-state", `phantom task ${task.id} not derivable from events`, [task.id]);
			continue;
		}
		if (task.state !== deterministic.state) {
			p0(
				"task-state",
				`task ${task.id} state mismatch: candidate=${task.state}, events=${deterministic.state}${task.state === "done" ? " (false completion)" : ""}`,
				[task.id],
			);
		}
	}
	for (const task of ctx.deterministicState.tasks) {
		if (!ctx.candidate.tasks.some((t) => t.id === task.id)) {
			p0("task-state", `task ${task.id} present in events but missing from candidate`, [task.id]);
		}
	}

	// --- tool pairing and state ---
	for (const tool of ctx.candidate.tools) {
		const deterministic = ctx.deterministicState.tools.find((t) => t.toolCallId === tool.toolCallId);
		if (!deterministic) {
			p0("tool-pairing", `candidate tool entry ${tool.toolCallId} has no matching event evidence`, [
				tool.toolCallId,
			]);
			continue;
		}
		if (tool.state !== deterministic.state) {
			p0(
				"tool-pairing",
				`tool ${tool.toolCallId} state mismatch: candidate=${tool.state}, events=${deterministic.state}`,
				[tool.toolCallId],
			);
		}
	}

	// --- side-effect monotonicity: candidate tool state may never lag event truth ---
	const stateRank = { planned: 0, approved: 1, started: 2, succeeded: 3, failed: 3, unknown: 2 } as const;
	for (const tool of ctx.candidate.tools) {
		const deterministic = ctx.deterministicState.tools.find((t) => t.toolCallId === tool.toolCallId);
		if (deterministic && stateRank[tool.state] < stateRank[deterministic.state]) {
			p0(
				"side-effect-monotonicity",
				`tool ${tool.toolCallId} regressed: candidate=${tool.state} < events=${deterministic.state}`,
				[tool.toolCallId],
			);
		}
	}

	// --- loop atomicity: every group is wholly kept or wholly compacted ---
	const kept = new Set(ctx.manifest.keptGroupIds);
	const compacted = new Set(ctx.manifest.compactedGroupIds);
	for (const group of ctx.groups) {
		const isKept = kept.has(group.groupId);
		const isCompacted = compacted.has(group.groupId);
		if (isKept && isCompacted) {
			p0("loop-atomicity", `group ${group.groupId} is in both kept and compacted sets`, [group.groupId]);
			continue;
		}
		if (!isKept && !isCompacted) {
			p0("loop-atomicity", `group ${group.groupId} is neither kept nor compacted (dropped)`, [group.groupId]);
			continue;
		}
		// A group straddles when the cut lands strictly inside its seq range.
		if (group.fromSeq <= ctx.manifest.cutAfterSeq && group.toSeq > ctx.manifest.cutAfterSeq) {
			p0(
				"loop-atomicity",
				`group ${group.groupId} (${group.kind}) straddles the cut at seq ${ctx.manifest.cutAfterSeq}`,
				[group.groupId],
			);
		}
	}

	// --- decision causal edges ---
	const decisionIds = new Set(ctx.candidate.decisions.map((d) => d.id));
	for (const decision of ctx.candidate.decisions) {
		for (const parent of decision.causalParentDecisionIds) {
			if (!decisionIds.has(parent)) {
				p1("decision-causal-edge", `decision ${decision.id} references unknown parent decision ${parent}`, [
					decision.id,
					parent,
				]);
			}
		}
	}

	// --- injection scan over free text ---
	if (ctx.candidate.narrative) {
		for (const finding of detectInjections(ctx.candidate.narrative)) {
			if (finding.severity === "high") {
				p0("injection", `narrative contains injection pattern ${finding.patternId}: "${finding.matched}"`);
			}
		}
	}
	for (const fact of ctx.candidate.facts) {
		for (const finding of detectInjections(fact.text)) {
			if (finding.severity === "high") {
				p0("injection", `fact ${fact.id} contains injection pattern ${finding.patternId}`, [fact.id]);
			}
		}
	}

	// --- token gain: full next request must drop by at least the threshold ---
	const minGain = ctx.minTokenGainFraction ?? 0.05;
	if (ctx.tokenStatsBefore > 0) {
		const gain = (ctx.tokenStatsBefore - ctx.tokenStatsAfter) / ctx.tokenStatsBefore;
		if (gain < minGain) {
			p0(
				"token-gain",
				`insufficient token gain: ${(gain * 100).toFixed(1)}% < ${(minGain * 100).toFixed(0)}% (before=${ctx.tokenStatsBefore}, after=${ctx.tokenStatsAfter})`,
			);
		}
	}

	const passed = !failures.some((f) => f.severity === "P0");
	return {
		passed,
		failures,
		repaired: false,
		rebuilt: false,
		rejected: !passed,
		checkedAt: new Date().toISOString(),
	};
}

/** P0 classes that must never be patched by a model. */
const NON_REPAIRABLE_CODES = new Set([
	"contract-coverage",
	"contract-contradiction",
	"task-state",
	"tool-pairing",
	"side-effect-monotonicity",
	"injection",
	"provenance",
	"loop-atomicity",
	"task-ledger-ref",
]);

export function classifyRepairability(report: ValidatorReport): "repairable" | "not-repairable" {
	const p0Failures = report.failures.filter((f) => f.severity === "P0");
	if (p0Failures.length === 0) return "repairable";
	return p0Failures.every((f) => !NON_REPAIRABLE_CODES.has(f.code)) ? "repairable" : "not-repairable";
}

/**
 * Repair discipline (任务书 CCTX-042): first failure → one controlled repair
 * (only when repairable); second → raw rebuild; still failing → reject.
 * Non-repairable failures skip model repair entirely.
 */
export function planRepair(report: ValidatorReport, attempt: number): "repair" | "rebuild" | "reject" {
	if (report.passed) return "reject"; // nothing to repair; caller should not call this
	if (classifyRepairability(report) === "not-repairable") {
		return attempt >= 2 ? "reject" : "rebuild";
	}
	if (attempt === 0) return "repair";
	if (attempt === 1) return "rebuild";
	return "reject";
}
