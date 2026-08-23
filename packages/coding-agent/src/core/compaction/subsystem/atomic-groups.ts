/**
 * CCTX-022: Atomic groups and safe cut planner.
 *
 * Events are grouped into atoms that must never be split: tool call/result
 * pairs, parallel tool batches, tool loops (chains of pairs), and external
 * transactions. The safe-cut planner keeps the most recent WHOLE groups that
 * fit the token budget; unclosed groups (e.g. an open tool loop) are always
 * kept whole. Output is a coverage manifest describing exactly which groups
 * were compacted and which remain verbatim.
 */

import { canonicalJson } from "./hashing.ts";
import type { AtomicGroup, CoverageManifest, EventEnvelope } from "./types.ts";

function estimateEventTokens(event: EventEnvelope): number {
	if (event.payload !== undefined) {
		return Math.max(1, Math.ceil(canonicalJson(event.payload).length / 4));
	}
	if (event.payloadRef !== undefined) {
		// Offloaded payload: only the reference and metadata live in context.
		return Math.max(1, Math.ceil((event.payloadRef.length + 64) / 4));
	}
	return 1;
}

function sumTokens(events: EventEnvelope[]): number {
	return events.reduce((sum, e) => sum + estimateEventTokens(e), 0);
}

function makeGroup(kind: AtomicGroup["kind"], events: EventEnvelope[], closed: boolean): AtomicGroup {
	// Deterministic id: same event range → same group id, across processes.
	return {
		groupId: `g-${events[0].seq}-${events[events.length - 1].seq}-${kind}`,
		kind,
		fromSeq: events[0].seq,
		toSeq: events[events.length - 1].seq,
		tokenEstimate: sumTokens(events),
		closed,
		eventIds: events.map((e) => e.eventId),
	};
}

/**
 * Build atomic groups from an ordered event stream. The stream must already be
 * in seq order (event-log guarantee).
 */
export function buildAtomicGroups(events: EventEnvelope[]): AtomicGroup[] {
	const groups: AtomicGroup[] = [];
	const resultByToolCall = new Map<string, EventEnvelope>();
	for (const event of events) {
		if (event.eventType === "tool_result" && event.toolCallId) {
			resultByToolCall.set(event.toolCallId, event);
		}
	}

	const consumed = new Set<string>();
	let i = 0;
	while (i < events.length) {
		const event = events[i];
		if (consumed.has(event.eventId)) {
			i += 1;
			continue;
		}

		// Transaction: all consecutive events sharing the transaction id form one atom.
		if (event.transactionId) {
			const txId = event.transactionId;
			const txEvents: EventEnvelope[] = [];
			while (i < events.length && events[i].transactionId === txId) {
				txEvents.push(events[i]);
				consumed.add(events[i].eventId);
				i += 1;
			}
			const calls = txEvents.filter((e) => e.eventType === "tool_call" && e.toolCallId);
			const closed = calls.every((c) => {
				const result = resultByToolCall.get(c.toolCallId!);
				return result !== undefined && consumed.has(result.eventId);
			});
			groups.push(makeGroup("transaction", txEvents, closed));
			continue;
		}

		// Tool call run: consecutive calls form one batch; their results join the atom.
		if (event.eventType === "tool_call") {
			const calls: EventEnvelope[] = [];
			while (i < events.length && events[i].eventType === "tool_call" && !events[i].transactionId) {
				calls.push(events[i]);
				consumed.add(events[i].eventId);
				i += 1;
			}
			const results: EventEnvelope[] = [];
			for (const call of calls) {
				if (!call.toolCallId) continue;
				const result = resultByToolCall.get(call.toolCallId);
				if (result) {
					results.push(result);
					consumed.add(result.eventId);
				}
			}
			const members = [...calls, ...results].sort((a, b) => a.seq - b.seq);
			const closed = calls.every((c) => c.toolCallId && resultByToolCall.has(c.toolCallId));
			groups.push(makeGroup(calls.length > 1 ? "parallel_batch" : "tool_pair", members, closed));
			continue;
		}

		// Anything else (messages, state changes, compaction markers) is a singleton atom.
		consumed.add(event.eventId);
		groups.push(makeGroup("message", [event], true));
		i += 1;
	}

	return mergeToolLoops(groups, events);
}

/**
 * Merge causally chained tool pairs/batches into tool loops: when the first
 * call of group N+1 causally follows an event of group N, they are one loop.
 */
function mergeToolLoops(groups: AtomicGroup[], events: EventEnvelope[]): AtomicGroup[] {
	const byId = new Map(events.map((e) => [e.eventId, e]));
	const isToolish = (g: AtomicGroup) =>
		g.kind === "tool_pair" || g.kind === "parallel_batch" || g.kind === "tool_loop";

	const merged: AtomicGroup[] = [];
	for (const group of groups) {
		const previous = merged[merged.length - 1];
		if (!previous || !isToolish(previous) || !isToolish(group)) {
			merged.push({ ...group });
			continue;
		}
		// Chained when this group's first call causally parents from the previous group.
		const firstEvent = byId.get(group.eventIds[0]);
		const chained = firstEvent?.causalParentIds.some((p) => previous.eventIds.includes(p)) === true;
		if (!chained) {
			merged.push({ ...group });
			continue;
		}
		// Merge into one loop.
		const prevIndex = merged.length - 1;
		const combinedIds = [...previous.eventIds, ...group.eventIds];
		const combinedEvents = combinedIds.map((id) => byId.get(id)!).filter(Boolean);
		merged[prevIndex] = {
			groupId: previous.groupId,
			kind: "tool_loop",
			fromSeq: previous.fromSeq,
			toSeq: group.toSeq,
			tokenEstimate: previous.tokenEstimate + group.tokenEstimate,
			closed: previous.closed && group.closed,
			eventIds: combinedEvents.sort((a, b) => a.seq - b.seq).map((e) => e.eventId),
		};
	}
	return merged;
}

/**
 * Choose the cut point: keep the newest whole groups within token budget.
 * Unclosed groups are always kept whole regardless of budget.
 *
 * Returns a coverage manifest; events with seq <= cutAfterSeq are candidates
 * for snapshotting, events after it stay verbatim in the recent tail.
 */
export function planSafeCut(groups: AtomicGroup[], keepRecentTokens: number): CoverageManifest {
	if (groups.length === 0) {
		return { cutAfterSeq: 0, keptGroupIds: [], compactedGroupIds: [], offloadedRefs: [], unclosedGroupIds: [] };
	}

	const unclosed = groups.filter((g) => !g.closed);
	const unclosedIds = unclosed.map((g) => g.groupId);

	// Walk from newest, accumulating whole groups until the budget is spent.
	let accumulated = 0;
	let firstKeptIndex = groups.length;
	for (let i = groups.length - 1; i >= 0; i--) {
		const group = groups[i];
		if (accumulated + group.tokenEstimate > keepRecentTokens && firstKeptIndex < groups.length) {
			break;
		}
		accumulated += group.tokenEstimate;
		firstKeptIndex = i;
	}

	// Unclosed groups must be kept whole: extend the kept region to include any
	// unclosed group that would otherwise be cut.
	for (const group of unclosed) {
		const index = groups.indexOf(group);
		if (index < firstKeptIndex) {
			firstKeptIndex = index;
		}
	}

	const kept = groups.slice(firstKeptIndex);
	const compacted = groups.slice(0, firstKeptIndex);
	const cutAfterSeq = compacted.length > 0 ? compacted[compacted.length - 1].toSeq : 0;

	return {
		cutAfterSeq,
		keptGroupIds: kept.map((g) => g.groupId),
		compactedGroupIds: compacted.map((g) => g.groupId),
		offloadedRefs: [],
		unclosedGroupIds: unclosedIds,
	};
}
