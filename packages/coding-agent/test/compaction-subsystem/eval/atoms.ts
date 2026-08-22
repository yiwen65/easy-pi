/**
 * CCTX-071: evaluation dataset model — ground-truth atoms.
 *
 * Atom kinds: F fact, C constraint, R causal, S execution state,
 * U unfinished TODO, D decision, T tool, P provenance.
 */

import type { Authority, EventType } from "../../../src/core/compaction/subsystem/types.ts";

export interface GroundTruthAtom {
	id: string;
	kind: "F" | "C" | "R" | "S" | "U" | "D" | "T" | "P";
	/** Human-readable description of what must be retained. */
	text: string;
	/** Exact strings (paths, versions, hashes, ids) that must survive verbatim. */
	exact?: string[];
	/** T atoms: tool call id and expected deterministic state. */
	toolCallId?: string;
	expectToolState?: string;
	/** S/U atoms: task id and expected state. */
	taskId?: string;
	expectTaskState?: string;
	/** R atoms: decision id whose causal parents must resolve. */
	decisionId?: string;
}

export interface FixtureEvent {
	eventType: EventType;
	toolCallId?: string;
	payload: unknown;
	authority?: Authority;
	id?: string;
}

export interface EvalFixture {
	name: string;
	contract: { goal: string; constraints: string[] };
	events: FixtureEvent[];
	/** Number of compactions to run over the trajectory. */
	compactionRounds: number;
	atoms: GroundTruthAtom[];
	/** Delayed-reveal queries: content that must be recallable after compaction. */
	needleQueries: { id: string; mustFind: string }[];
}

export interface AtomResult {
	atomId: string;
	kind: GroundTruthAtom["kind"];
	passed: boolean;
	detail: string;
}

export interface EvalReport {
	fixture: string;
	compactionRounds: number;
	atoms: AtomResult[];
	/** Retention rate per atom kind (1.0 = perfect). */
	retentionByKind: Record<string, number>;
	/** Overall key-atom retention. */
	overallRetention: number;
	/** Oracle check: rebuilt deterministic state equals full replay. */
	oracleConsistent: boolean;
	/** Token totals before first and after last compaction. */
	tokensBeforeFirst: number;
	tokensAfterLast: number;
	/** Compaction rounds that activated a candidate vs rejected. */
	roundsActivated: number;
	roundsRejected: number;
	rejectReasons: string[];
}
