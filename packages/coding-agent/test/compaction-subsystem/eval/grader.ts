/**
 * CCTX-071: deterministic graders. Exact fields are graded by exact string
 * equality against snapshot text, verbatim tail, or exact recall — never by
 * model judgment.
 */

import type { RecallCatalog } from "../../../src/core/compaction/subsystem/recall-catalog.ts";
import type { EventEnvelope, StructuredSnapshot, TaskContract } from "../../../src/core/compaction/subsystem/types.ts";
import type { AtomResult, GroundTruthAtom } from "./atoms.ts";

export interface GradingContext {
	contract: TaskContract;
	snapshot: StructuredSnapshot | undefined;
	tailEvents: EventEnvelope[];
	allEvents: EventEnvelope[];
	recallCatalog: RecallCatalog;
}

function tailText(ctx: GradingContext): string {
	return ctx.tailEvents.map((e) => JSON.stringify(e.payload ?? e.payloadRef ?? "")).join("\n");
}

function snapshotText(snapshot: StructuredSnapshot | undefined): string {
	if (!snapshot) return "";
	return [
		snapshot.narrative ?? "",
		...snapshot.facts.map((f) => f.text),
		...snapshot.decisions.map((d) => d.text),
		...snapshot.tasks.map((t) => t.title),
		...snapshot.nextActions.map((n) => n.text),
	].join("\n");
}

/** Try to find an exact string in snapshot, tail, or exact recall. */
function exactSurvives(value: string, ctx: GradingContext): boolean {
	if (snapshotText(ctx.snapshot).includes(value)) return true;
	if (tailText(ctx).includes(value)) return true;
	for (const entry of ctx.recallCatalog.entries()) {
		try {
			const { data } = ctx.recallCatalog.recallExact(entry.refId);
			if (new TextDecoder().decode(data).includes(value)) return true;
		} catch {
			// fail closed: unresolvable entries count as missing
		}
	}
	return false;
}

function gradeC(atom: GroundTruthAtom, ctx: GradingContext): AtomResult {
	const present = ctx.contract.constraints.some((c) => c.text === atom.text);
	// When a snapshot exists, its constraint copy must also carry it verbatim.
	const inSnapshot = ctx.snapshot ? ctx.snapshot.constraints.some((c) => c.text === atom.text) : true;
	return {
		atomId: atom.id,
		kind: "C",
		passed: present && inSnapshot,
		detail: present ? (inSnapshot ? "pinned" : "missing from snapshot copy") : "missing from contract",
	};
}

function gradeF(atom: GroundTruthAtom, ctx: GradingContext): AtomResult {
	const missing = (atom.exact ?? [atom.text]).filter((value) => !exactSurvives(value, ctx));
	return {
		atomId: atom.id,
		kind: "F",
		passed: missing.length === 0,
		detail: missing.length === 0 ? "retained" : `lost exact values: ${missing.join(", ")}`,
	};
}

function gradeT(atom: GroundTruthAtom, ctx: GradingContext): AtomResult {
	const inSnapshot = ctx.snapshot?.tools.find((t) => t.toolCallId === atom.toolCallId);
	if (inSnapshot) {
		return {
			atomId: atom.id,
			kind: "T",
			passed: inSnapshot.state === atom.expectToolState,
			detail: `snapshot state=${inSnapshot.state}`,
		};
	}
	// Still in the verbatim tail is a pass (truth preserved, just not compacted).
	const inTail = ctx.tailEvents.some((e) => e.toolCallId === atom.toolCallId);
	return { atomId: atom.id, kind: "T", passed: inTail, detail: inTail ? "verbatim in tail" : "lost" };
}

function tailTaskState(taskId: string, ctx: GradingContext): string | undefined {
	let state: string | undefined;
	for (const e of ctx.tailEvents) {
		const payload = e.payload;
		if (
			payload &&
			typeof payload === "object" &&
			"kind" in payload &&
			(payload as { kind?: unknown }).kind === "task_update" &&
			(payload as { taskId?: unknown }).taskId === taskId &&
			typeof (payload as { state?: unknown }).state === "string"
		) {
			state = (payload as { state?: unknown }).state as string;
		}
	}
	return state;
}

function gradeSorU(atom: GroundTruthAtom, ctx: GradingContext): AtomResult {
	// The tail is newer than the snapshot: effective state = latest tail update, else snapshot.
	const tailState = atom.taskId ? tailTaskState(atom.taskId, ctx) : undefined;
	if (tailState !== undefined) {
		return {
			atomId: atom.id,
			kind: atom.kind,
			passed: tailState === atom.expectTaskState,
			detail: `tail task state=${tailState}`,
		};
	}
	const task = ctx.snapshot?.tasks.find((t) => t.id === atom.taskId);
	if (task) {
		return {
			atomId: atom.id,
			kind: atom.kind,
			passed: task.state === atom.expectTaskState,
			detail: `snapshot task state=${task.state}`,
		};
	}
	return { atomId: atom.id, kind: atom.kind, passed: false, detail: "lost" };
}

function gradeD(atom: GroundTruthAtom, ctx: GradingContext): AtomResult {
	const found = ctx.snapshot?.decisions.some((d) => d.text.includes(atom.text));
	const inTail = tailText(ctx).includes(atom.text);
	return {
		atomId: atom.id,
		kind: "D",
		passed: found === true || inTail,
		detail: found ? "in snapshot" : inTail ? "in tail" : "lost",
	};
}

function gradeR(atom: GroundTruthAtom, ctx: GradingContext): AtomResult {
	const decision = ctx.snapshot?.decisions.find((d) => d.id === atom.decisionId);
	if (!decision) {
		// Not yet extracted — check tail presence.
		const inTail = tailText(ctx).includes(atom.decisionId ?? "\0");
		return { atomId: atom.id, kind: "R", passed: inTail, detail: inTail ? "in tail" : "lost" };
	}
	const ids = new Set(ctx.snapshot?.decisions.map((d) => d.id) ?? []);
	const unresolved = decision.causalParentDecisionIds.filter((p) => !ids.has(p));
	return {
		atomId: atom.id,
		kind: "R",
		passed: unresolved.length === 0,
		detail: unresolved.length === 0 ? "causal edges resolve" : `broken parents: ${unresolved.join(",")}`,
	};
}

function gradeP(atom: GroundTruthAtom, ctx: GradingContext): AtomResult {
	if (!ctx.snapshot) {
		return { atomId: atom.id, kind: "P", passed: true, detail: "no snapshot (no compaction)" };
	}
	const eventIds = new Set(ctx.allEvents.map((e) => e.eventId));
	const collections = [
		...ctx.snapshot.facts.map((f) => f.provenance),
		...ctx.snapshot.decisions.map((d) => d.provenance),
		...ctx.snapshot.tasks.map((t) => t.provenance),
		...ctx.snapshot.tools.map((t) => t.provenance),
		...ctx.snapshot.errors.map((e) => e.provenance),
	];
	const unresolved: string[] = [];
	for (const prov of collections) {
		for (const id of prov.sourceEventIds) {
			if (!eventIds.has(id)) unresolved.push(id);
		}
	}
	return {
		atomId: atom.id,
		kind: "P",
		passed: unresolved.length === 0,
		detail: unresolved.length === 0 ? "all provenance resolves" : `unresolvable: ${unresolved.join(",")}`,
	};
}

export function gradeAtom(atom: GroundTruthAtom, ctx: GradingContext): AtomResult {
	switch (atom.kind) {
		case "C":
			return gradeC(atom, ctx);
		case "F":
			return gradeF(atom, ctx);
		case "T":
			return gradeT(atom, ctx);
		case "S":
		case "U":
			return gradeSorU(atom, ctx);
		case "D":
			return gradeD(atom, ctx);
		case "R":
			return gradeR(atom, ctx);
		case "P":
			return gradeP(atom, ctx);
	}
}

export function gradeNeedles(needles: { id: string; mustFind: string }[], ctx: GradingContext): AtomResult[] {
	return needles.map((n) => ({
		atomId: n.id,
		kind: "F" as const,
		passed: exactSurvives(n.mustFind, ctx),
		detail: exactSurvives(n.mustFind, ctx) ? "needle recovered" : "needle lost",
	}));
}
