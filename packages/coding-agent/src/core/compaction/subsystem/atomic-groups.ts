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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolName(event: EventEnvelope): string | undefined {
	if (event.eventType !== "tool_call" || !isRecord(event.payload)) return undefined;
	return typeof event.payload.name === "string" ? event.payload.name : undefined;
}

function bashCommand(event: EventEnvelope): string | undefined {
	if (toolName(event) !== "bash" || !isRecord(event.payload)) return undefined;
	const args = event.payload.arguments;
	if (!isRecord(args)) return undefined;
	return typeof args.command === "string" ? args.command : undefined;
}

function isPatchCall(event: EventEnvelope): boolean {
	const name = toolName(event);
	return name === "edit" || name === "write";
}

function isTestCall(event: EventEnvelope): boolean {
	const command = bashCommand(event);
	if (command === undefined) return false;
	return /(?:^|[;&|]\s*)(?:(?:\.\/)?[^\s;&|]*test\.sh|vitest|jest|pytest|go\s+test|cargo\s+test|node\s+--test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck))(?:\s|$)/i.test(
		command,
	);
}

function isVerifiedUserMessage(event: EventEnvelope): boolean {
	return event.eventType === "message" && event.authority.kind === "user" && event.authority.verified;
}

function hasAssistantCompletion(events: EventEnvelope[]): boolean {
	return events.some(
		(event) => event.eventType === "message" && isRecord(event.payload) && event.payload.role === "assistant",
	);
}

function buildTurnGroups(events: EventEnvelope[]): AtomicGroup[] {
	const starts = events.flatMap((event, index) => (isVerifiedUserMessage(event) ? [index] : []));
	return starts.map((start, index) => {
		const followingTurn = starts[index + 1];
		const nextStart = followingTurn ?? events.length;
		const members = events.slice(start, nextStart);
		return makeGroup("turn", members, followingTurn !== undefined || hasAssistantCompletion(members));
	});
}

/**
 * Transaction ids and their matching tool results may be separated by durable
 * ledger/control events. Treat the entire observed interval as one atom.
 */
function buildTransactionGroups(events: EventEnvelope[], resultIndexByToolCall: Map<string, number>): AtomicGroup[] {
	const indexesByTransaction = new Map<string, number[]>();
	for (const [index, event] of events.entries()) {
		if (!event.transactionId) continue;
		const indexes = indexesByTransaction.get(event.transactionId) ?? [];
		indexes.push(index);
		indexesByTransaction.set(event.transactionId, indexes);
	}

	return [...indexesByTransaction.entries()].map(([, indexes]) => {
		let endIndex = indexes[indexes.length - 1];
		let closed = true;
		for (const index of indexes) {
			const event = events[index];
			if (event.eventType !== "tool_call" || !event.toolCallId) continue;
			const resultIndex = resultIndexByToolCall.get(event.toolCallId);
			if (resultIndex === undefined) {
				closed = false;
			} else {
				endIndex = Math.max(endIndex, resultIndex);
			}
		}
		return makeGroup("transaction", events.slice(indexes[0], endIndex + 1), closed);
	});
}

/**
 * Recognize the built-in edit/write -> bash validation workflow. There is no
 * patch/test field in schema v1, so the classifier intentionally uses only
 * tool names and command shapes emitted by the current session adapter.
 */
function buildPatchTestGroups(events: EventEnvelope[], resultIndexByToolCall: Map<string, number>): AtomicGroup[] {
	const groups: AtomicGroup[] = [];
	let patchStart: number | undefined;

	for (const [index, event] of events.entries()) {
		if (isVerifiedUserMessage(event)) patchStart = undefined;
		if (isPatchCall(event)) {
			patchStart ??= index;
			continue;
		}
		if (patchStart === undefined || !isTestCall(event)) continue;

		const resultIndex = event.toolCallId ? resultIndexByToolCall.get(event.toolCallId) : undefined;
		const endIndex = resultIndex ?? index;
		groups.push(makeGroup("patch_test", events.slice(patchStart, endIndex + 1), resultIndex !== undefined));
		patchStart = undefined;
	}

	return groups;
}

const GROUP_KIND_PRIORITY: Record<AtomicGroup["kind"], number> = {
	message: 0,
	tool_pair: 1,
	parallel_batch: 2,
	tool_loop: 3,
	transaction: 4,
	turn: 5,
	patch_test: 6,
};

/** Flatten nested/overlapping candidates into disjoint atoms for cut planning. */
function mergeOverlappingGroups(groups: AtomicGroup[], events: EventEnvelope[]): AtomicGroup[] {
	const bySeq = new Map(events.map((event, index) => [event.seq, index]));
	const ordered = groups
		.map((group) => ({ ...group }))
		.sort((left, right) => left.fromSeq - right.fromSeq || left.toSeq - right.toSeq);
	const merged: AtomicGroup[] = [];

	for (const group of ordered) {
		const previous = merged[merged.length - 1];
		if (!previous || group.fromSeq > previous.toSeq) {
			merged.push(group);
			continue;
		}

		const fromIndex = bySeq.get(Math.min(previous.fromSeq, group.fromSeq));
		const toIndex = bySeq.get(Math.max(previous.toSeq, group.toSeq));
		if (fromIndex === undefined || toIndex === undefined) {
			throw new Error("Atomic group references an event outside the source stream");
		}
		const members = events.slice(fromIndex, toIndex + 1);
		const kind = GROUP_KIND_PRIORITY[group.kind] > GROUP_KIND_PRIORITY[previous.kind] ? group.kind : previous.kind;
		merged[merged.length - 1] = makeGroup(kind, members, previous.closed && group.closed);
	}

	return merged;
}

/**
 * Build atomic groups from an ordered event stream. The stream must already be
 * in seq order (event-log guarantee).
 */
export function buildAtomicGroups(events: EventEnvelope[]): AtomicGroup[] {
	const groups: AtomicGroup[] = [];
	const resultIndexByToolCall = new Map<string, number>();
	const nextUserBoundaryByIndex = new Map<number, number>();
	let nextUserBoundary: number | undefined;
	for (let index = events.length - 1; index >= 0; index--) {
		if (isVerifiedUserMessage(events[index])) nextUserBoundary = index;
		if (nextUserBoundary !== undefined) nextUserBoundaryByIndex.set(index, nextUserBoundary);
	}
	for (const [index, event] of events.entries()) {
		if (event.eventType === "tool_result" && event.toolCallId) {
			resultIndexByToolCall.set(event.toolCallId, index);
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

		// Transaction intervals are assembled below after every occurrence and
		// matching result are known. Keep a singleton candidate here so the base
		// partition remains complete without prematurely declaring the interval
		// open when ledger/control events separate a call from its result.
		if (event.transactionId) {
			consumed.add(event.eventId);
			groups.push(makeGroup("transaction", [event], true));
			i += 1;
			continue;
		}

		// Tool call run: consecutive calls form one batch. The atom spans through
		// the last matching result so intervening durable ledger/control events
		// cannot create overlapping group ranges or an unsafe cut.
		if (event.eventType === "tool_call") {
			const startIndex = i;
			const calls: EventEnvelope[] = [];
			while (i < events.length && events[i].eventType === "tool_call" && !events[i].transactionId) {
				calls.push(events[i]);
				i += 1;
			}
			let endIndex = i - 1;
			let closed = true;
			for (let cursor = startIndex; cursor <= endIndex; cursor++) {
				const member = events[cursor];
				if (member.eventType !== "tool_call" || !member.toolCallId) continue;
				const resultIndex = resultIndexByToolCall.get(member.toolCallId);
				if (resultIndex === undefined) {
					// A later verified user turn closes the conversational batch even
					// when the provider never emitted a tool result (for example after
					// interruption). The reducer still preserves the tool as unknown;
					// this only prevents an abandoned batch from pinning all future
					// context as one permanently open atomic group.
					const userBoundary = nextUserBoundaryByIndex.get(cursor);
					if (userBoundary === undefined || userBoundary <= cursor) closed = false;
				} else {
					endIndex = Math.max(endIndex, resultIndex);
				}
			}
			const members = events.slice(startIndex, endIndex + 1);
			for (const member of members) consumed.add(member.eventId);
			const toolCallCount = members.filter((member) => member.eventType === "tool_call").length;
			const kind = toolCallCount > calls.length ? "tool_loop" : calls.length > 1 ? "parallel_batch" : "tool_pair";
			groups.push(makeGroup(kind, members, closed));
			i = endIndex + 1;
			continue;
		}

		// Anything else (messages, state changes, compaction markers) is a singleton atom.
		consumed.add(event.eventId);
		groups.push(makeGroup("message", [event], true));
		i += 1;
	}

	const toolGroups = mergeToolLoops(groups, events);
	return mergeOverlappingGroups(
		[
			...toolGroups,
			...buildTransactionGroups(events, resultIndexByToolCall),
			...buildTurnGroups(events),
			...buildPatchTestGroups(events, resultIndexByToolCall),
		],
		events,
	);
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
		if (accumulated + group.tokenEstimate > keepRecentTokens) {
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
