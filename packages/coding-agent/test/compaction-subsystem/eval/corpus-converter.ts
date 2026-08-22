/**
 * Corpus converter: real session entries (v3 JSONL parsed) → EvalFixture.
 *
 * Deterministic atoms (T/S/P) come from the reducer — the events themselves
 * are the ground truth. F atoms are mined exact values (paths, versions,
 * hashes) flagged for human review. Needles are generated from large tool
 * results (the offload candidates). Constraints and goal overrides come from
 * sidecar/manual labels.
 */

import { sessionEntriesToEvents } from "../../../src/core/compaction/subsystem/event-log.ts";
import { reduceEvents } from "../../../src/core/compaction/subsystem/reducer.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import type { EvalFixture, FixtureEvent, GroundTruthAtom } from "./atoms.ts";

export interface CorpusConvertOptions {
	name: string;
	/** Keep only the first N entries (prefix replay). */
	maxEntries?: number;
	goal?: string;
	constraints?: string[];
	compactionRounds?: number;
	/** Tool results with at least this many text bytes become needles. Default 3000. */
	needleMinBytes?: number;
	/** Cap on mined exact-value atoms. Default 12. */
	maxExactAtoms?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const content =
		entry.message.role === "assistant" || entry.message.role === "user" || entry.message.role === "toolResult"
			? entry.message.content
			: undefined;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(b): b is { type: "text"; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string",
			)
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

const EXACT_VALUE_PATTERN = /\bv?\d+\.\d+\.\d+(?:-[a-z0-9.]+)?|\/[^\s,;"')]+|\b[0-9a-f]{40,}\b/gi;

export function convertSessionToFixture(entries: SessionEntry[], options: CorpusConvertOptions): EvalFixture {
	const sliced = options.maxEntries !== undefined ? entries.slice(0, options.maxEntries) : entries;
	const events = sessionEntriesToEvents(sliced, `corpus-${options.name}`, "agent-corpus");

	const fixtureEvents: FixtureEvent[] = events.map((e) => ({
		eventType: e.eventType,
		toolCallId: e.toolCallId,
		payload: e.payload,
		id: e.eventId,
	}));

	// Contract: goal from the first user message (or override), constraints manual.
	let goal = options.goal ?? "";
	if (!goal) {
		for (const entry of sliced) {
			if (entry.type === "message" && entry.message.role === "user") {
				goal = entryText(entry).replace(/\s+/g, " ").trim().slice(0, 200);
				break;
			}
		}
	}

	// Deterministic atoms from the reducer (the events are the ground truth).
	const state = reduceEvents(events);
	const atoms: GroundTruthAtom[] = [];
	for (const tool of state.tools) {
		if (tool.state === "succeeded" || tool.state === "failed") {
			atoms.push({
				id: `T-${tool.toolCallId}`,
				kind: "T",
				text: `${tool.name} ${tool.state}`,
				toolCallId: tool.toolCallId,
				expectToolState: tool.state,
			});
		}
	}
	for (const task of state.tasks) {
		atoms.push({
			id: `${task.state === "done" ? "S" : "U"}-${task.id}`,
			kind: task.state === "done" ? "S" : "U",
			text: task.title,
			taskId: task.id,
			expectTaskState: task.state,
		});
	}
	for (const [i, text] of (options.constraints ?? []).entries()) {
		atoms.push({ id: `C-${i + 1}`, kind: "C", text });
	}
	atoms.push({ id: "P-1", kind: "P", text: "provenance resolves" });

	// F atoms: mine exact values from all event text, deduped and capped.
	const allText = sliced.map(entryText).join("\n");
	const mined = new Set<string>();
	for (const match of allText.matchAll(EXACT_VALUE_PATTERN)) {
		const value = match[0];
		if (value.length >= 4) mined.add(value);
	}
	const cap = options.maxExactAtoms ?? 12;
	for (const value of [...mined].sort().slice(0, cap)) {
		atoms.push({ id: `F-${value.slice(0, 24)}`, kind: "F", text: `exact value ${value}`, exact: [value] });
	}

	// Needles from big tool results (the offload candidates).
	const needleMinBytes = options.needleMinBytes ?? 3000;
	const needleQueries: EvalFixture["needleQueries"] = [];
	for (const entry of sliced) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const text = entryText(entry);
		if (text.length < needleMinBytes) continue;
		const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text.slice(0, 80);
		needleQueries.push({ id: `N-${entry.id}`, mustFind: firstLine.slice(0, 80) });
	}

	return {
		name: options.name,
		contract: { goal, constraints: options.constraints ?? [] },
		events: fixtureEvents,
		compactionRounds: options.compactionRounds ?? 2,
		atoms,
		needleQueries,
	};
}
