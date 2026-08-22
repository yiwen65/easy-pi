/**
 * CCTX-021: Deterministic reducer.
 *
 * Folds raw events into typed state. The LLM never decides exit codes, hashes,
 * completion status, or approvals — those come only from events. Supports both
 * full replay and incremental reduce; the two must produce identical state.
 * Gaps, duplicates, out-of-order sequences, and orphan tool results are
 * explicit errors, never silently absorbed.
 */

import { canonicalJson, sha256Hex } from "./hashing.ts";
import type { ArtifactRefEntry, ErrorEntry, EventEnvelope, Provenance, TaskNode, ToolStateEntry } from "./types.ts";

export class ReducerError extends Error {}

export interface DeterministicState {
	contractRef?: { contractId: string; version: number };
	tasks: TaskNode[];
	tools: ToolStateEntry[];
	artifacts: ArtifactRefEntry[];
	errors: ErrorEntry[];
	approvals: { toolCallId: string; approvedBy: string; at: string }[];
	lastEventSeq: number;
	/** Number of events folded in (including previously reduced ones). */
	eventCount: number;
}

export function emptyState(): DeterministicState {
	return {
		tasks: [],
		tools: [],
		artifacts: [],
		errors: [],
		approvals: [],
		lastEventSeq: 0,
		eventCount: 0,
	};
}

interface ToolCallInfo {
	name: string;
	argsHash: string;
}

interface ToolResultInfo {
	isError: boolean;
	exitCode?: number;
	resultRef?: string;
	preview: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extract tool call info from native payloads or session-adapter entry payloads. */
function extractToolCallInfo(event: EventEnvelope): ToolCallInfo | undefined {
	const payload = event.payload;
	if (isRecord(payload) && typeof payload.name === "string") {
		return { name: payload.name, argsHash: sha256Hex(canonicalJson(payload.arguments ?? {})) };
	}
	// Session-adapter shape: payload is a SessionMessageEntry wrapping an assistant message.
	if (isRecord(payload) && isRecord(payload.message) && Array.isArray(payload.message.content)) {
		for (const block of payload.message.content) {
			if (isRecord(block) && block.type === "toolCall" && block.id === event.toolCallId) {
				return {
					name: typeof block.name === "string" ? block.name : "unknown",
					argsHash: sha256Hex(canonicalJson(block.arguments ?? {})),
				};
			}
		}
	}
	return undefined;
}

function extractToolResultInfo(event: EventEnvelope): ToolResultInfo {
	const payload = event.payload;
	if (isRecord(payload) && isRecord(payload.message) && payload.message.role === "toolResult") {
		const message = payload.message;
		const content = Array.isArray(message.content) ? message.content : [];
		const text = content
			.filter(
				(b): b is { type: "text"; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string",
			)
			.map((b) => b.text)
			.join("\n");
		return { isError: message.isError === true, preview: text.slice(0, 200) };
	}
	if (isRecord(payload)) {
		return {
			isError: payload.isError === true,
			exitCode: typeof payload.exitCode === "number" ? payload.exitCode : undefined,
			resultRef: typeof payload.resultRef === "string" ? payload.resultRef : undefined,
			preview: typeof payload.content === "string" ? payload.content.slice(0, 200) : "",
		};
	}
	return { isError: false, preview: "" };
}

function provenance(eventId: string): Provenance {
	return { sourceEventIds: [eventId], source: "reducer" };
}

function mergeProvenance(existing: Provenance, eventId: string): Provenance {
	if (existing.sourceEventIds.includes(eventId)) return existing;
	return { ...existing, sourceEventIds: [...existing.sourceEventIds, eventId] };
}

function foldEvent(state: DeterministicState, event: EventEnvelope): void {
	switch (event.eventType) {
		case "contract": {
			const payload = event.payload;
			if (isRecord(payload) && typeof payload.contractId === "string" && typeof payload.version === "number") {
				state.contractRef = { contractId: payload.contractId, version: payload.version };
			}
			break;
		}
		case "state_change": {
			const payload = event.payload;
			if (!isRecord(payload)) break;
			if (payload.kind === "task_update" && typeof payload.taskId === "string") {
				const existing = state.tasks.find((t) => t.id === payload.taskId);
				const nextState = payload.state as TaskNode["state"] | undefined;
				if (!existing) {
					if (nextState === "done") {
						throw new ReducerError(
							`Task ${String(payload.taskId)} cannot become done without a prior task event (no completion evidence)`,
						);
					}
					state.tasks.push({
						id: payload.taskId,
						title: typeof payload.title === "string" ? payload.title : payload.taskId,
						state: nextState ?? "pending",
						blockers: Array.isArray(payload.blockers) ? payload.blockers.map(String) : [],
						provenance: provenance(event.eventId),
					});
				} else {
					if (nextState !== undefined) existing.state = nextState;
					if (typeof payload.title === "string") existing.title = payload.title;
					if (Array.isArray(payload.blockers)) existing.blockers = payload.blockers.map(String);
					existing.provenance = mergeProvenance(existing.provenance, event.eventId);
				}
			} else if (payload.kind === "error_resolved" && typeof payload.errorId === "string") {
				const error = state.errors.find((e) => e.id === payload.errorId);
				if (error) {
					error.resolved = true;
					error.provenance = mergeProvenance(error.provenance, event.eventId);
				}
			}
			break;
		}
		case "tool_call": {
			if (!event.toolCallId) break;
			const info = extractToolCallInfo(event);
			if (state.tools.some((t) => t.toolCallId === event.toolCallId)) {
				throw new ReducerError(`Duplicate tool call ${event.toolCallId} (event ${event.eventId})`);
			}
			state.tools.push({
				toolCallId: event.toolCallId,
				name: info?.name ?? "unknown",
				argsHash: info?.argsHash ?? "",
				// A call without a result is only ever "started" — never completed.
				state: "started",
				provenance: provenance(event.eventId),
			});
			break;
		}
		case "tool_result": {
			if (!event.toolCallId) break;
			const tool = state.tools.find((t) => t.toolCallId === event.toolCallId);
			if (!tool) {
				throw new ReducerError(
					`Orphan tool result for ${event.toolCallId}: no matching tool call (event ${event.eventId})`,
				);
			}
			const info = extractToolResultInfo(event);
			tool.state = info.isError ? "failed" : "succeeded";
			tool.exitCode = info.exitCode;
			tool.resultRef = info.resultRef ?? tool.resultRef;
			tool.provenance = mergeProvenance(tool.provenance, event.eventId);
			if (info.isError) {
				state.errors.push({
					id: `err-${event.eventId}`,
					message: info.preview || `tool ${tool.name} failed`,
					toolCallId: event.toolCallId,
					resolved: false,
					provenance: provenance(event.eventId),
				});
			}
			break;
		}
		case "approval": {
			const payload = event.payload;
			if (event.toolCallId && isRecord(payload)) {
				state.approvals.push({
					toolCallId: event.toolCallId,
					approvedBy: isRecord(payload.approvedBy) ? String(payload.approvedBy.id) : "unknown",
					at: event.timestamp,
				});
			}
			break;
		}
		case "artifact": {
			const payload = event.payload;
			if (isRecord(payload) && typeof payload.ref === "string") {
				if (!state.artifacts.some((a) => a.ref === payload.ref)) {
					state.artifacts.push({
						ref: payload.ref,
						kind: typeof payload.kind === "string" ? payload.kind : "unknown",
						size: typeof payload.size === "number" ? payload.size : 0,
						preview: typeof payload.preview === "string" ? payload.preview : "",
						pinned: payload.pinned === true,
						provenance: provenance(event.eventId),
					});
				}
			}
			break;
		}
		case "error": {
			const payload = event.payload;
			state.errors.push({
				id: `err-${event.eventId}`,
				message: isRecord(payload) && typeof payload.message === "string" ? payload.message : "unknown error",
				toolCallId: event.toolCallId,
				resolved: false,
				provenance: provenance(event.eventId),
			});
			break;
		}
		default:
			// message/compaction/ledger events do not feed deterministic state here
			// (ledger state is rebuilt separately via replayLedger).
			break;
	}
}

/**
 * Fold events into state. With `prior`, continues an incremental reduce;
 * otherwise performs a full replay from empty state. Both paths are
 * bit-identical for the same event stream.
 */
export function reduceEvents(events: EventEnvelope[], prior?: DeterministicState): DeterministicState {
	const state: DeterministicState = prior
		? {
				contractRef: prior.contractRef,
				tasks: prior.tasks.map((t) => ({
					...t,
					blockers: [...t.blockers],
					provenance: { ...t.provenance, sourceEventIds: [...t.provenance.sourceEventIds] },
				})),
				tools: prior.tools.map((t) => ({
					...t,
					provenance: { ...t.provenance, sourceEventIds: [...t.provenance.sourceEventIds] },
				})),
				artifacts: prior.artifacts.map((a) => ({
					...a,
					provenance: { ...a.provenance, sourceEventIds: [...a.provenance.sourceEventIds] },
				})),
				errors: prior.errors.map((e) => ({
					...e,
					provenance: { ...e.provenance, sourceEventIds: [...e.provenance.sourceEventIds] },
				})),
				approvals: [...prior.approvals],
				lastEventSeq: prior.lastEventSeq,
				eventCount: prior.eventCount,
			}
		: emptyState();

	const seenIds = new Set<string>();
	let expectedSeq = prior ? prior.lastEventSeq + 1 : 1;
	for (const event of events) {
		if (seenIds.has(event.eventId)) {
			throw new ReducerError(`Duplicate event ${event.eventId} in reduce input`);
		}
		seenIds.add(event.eventId);
		if (event.seq !== expectedSeq) {
			if (prior && event.seq > expectedSeq) {
				throw new ReducerError(
					`Event gap: incremental reduce expects seq ${expectedSeq} but got ${event.seq} (missing events between states)`,
				);
			}
			throw new ReducerError(
				`Out-of-order event seq: expected ${expectedSeq}, got ${event.seq} (event ${event.eventId})`,
			);
		}
		foldEvent(state, event);
		expectedSeq += 1;
		state.lastEventSeq = event.seq;
		state.eventCount += 1;
	}
	return state;
}
