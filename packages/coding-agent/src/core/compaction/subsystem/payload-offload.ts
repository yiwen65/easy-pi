/**
 * CCTX-030: Payload classification and deterministic offload.
 *
 * Payloads are classified as must-keep-verbatim (approvals, contracts,
 * high-risk/excluded tool results), structured, summarizable, or offloadable.
 * Offload writes the bytes to the content-addressed store and the active
 * context keeps only call ID, status, exit code, preview, and ref. Raw events
 * are never rewritten — offload is a projection plus catalog record. Failures
 * keep inline content; re-running is idempotent.
 */

import type { ArtifactStore } from "./artifact-store.ts";
import { hashPayload } from "./hashing.ts";
import type { EventEnvelope, RecallEntry } from "./types.ts";

export type PayloadClass = "must_keep_verbatim" | "structured" | "summarizable" | "offloadable";

export interface OffloadPolicy {
	/** Payloads above this many bytes become offload candidates. */
	maxInlineBytes: number;
	/** Reverse budget: the N most recent tool results always stay inline. */
	keepRecentToolResults: number;
	/** Tools whose results are never offloaded. */
	toolExclusions: string[];
	/** High-risk tools: results never leave the trusted store path. */
	highRiskTools: string[];
}

export interface OffloadRecord {
	eventId: string;
	/** Event-range archives can cover many events without projecting any one tail event. */
	eventIds?: string[];
	recallKind?: RecallEntry["kind"];
	toolCallId?: string;
	artifactRef: string;
	preview: string;
	hash: string;
	bytesOffloaded: number;
}

export interface OffloadOutcome {
	/** Newly created offload records from this run. */
	records: OffloadRecord[];
	/** Records covering all offloaded events, including prior ones (for projections/catalog). */
	effectiveRecords: OffloadRecord[];
	skipped: { eventId: string; reason: string }[];
	failed: { eventId: string; error: string }[];
	alreadyOffloaded: string[];
	totalBytesOffloaded: number;
}

export interface OffloadedProjection {
	eventId: string;
	toolCallId?: string;
	status: "succeeded" | "failed" | "unknown";
	exitCode?: number;
	preview: string;
	ref?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function payloadText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (isRecord(payload)) {
		if (typeof payload.content === "string") return payload.content;
		if (Array.isArray(payload.content)) {
			return payload.content
				.filter(
					(b): b is { type: "text"; text: string } =>
						isRecord(b) && b.type === "text" && typeof b.text === "string",
				)
				.map((b) => b.text)
				.join("\n");
		}
		if (isRecord(payload.message)) {
			return payloadText(payload.message);
		}
	}
	return JSON.stringify(payload) ?? "";
}

function payloadBytes(payload: unknown): number {
	if (payload === undefined) return 0;
	return new TextEncoder().encode(payloadText(payload)).length;
}

function offloadCandidateEvents(events: EventEnvelope[], policy: OffloadPolicy): EventEnvelope[] {
	const toolNameByCall = new Map<string, string>();
	for (const event of events) {
		if (
			event.eventType === "tool_call" &&
			event.toolCallId &&
			isRecord(event.payload) &&
			typeof event.payload.name === "string"
		) {
			toolNameByCall.set(event.toolCallId, event.payload.name);
		}
		if (
			event.eventType === "tool_call" &&
			event.toolCallId &&
			isRecord(event.payload) &&
			isRecord(event.payload.message)
		) {
			const content = event.payload.message.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (
						isRecord(block) &&
						block.type === "toolCall" &&
						block.id === event.toolCallId &&
						typeof block.name === "string"
					) {
						toolNameByCall.set(event.toolCallId, block.name);
					}
				}
			}
		}
	}
	const keepInline = new Set(
		events
			.filter((event) => event.eventType === "tool_result")
			.sort((a, b) => b.seq - a.seq)
			.slice(0, Math.max(0, policy.keepRecentToolResults))
			.map((event) => event.eventId),
	);
	return events.filter((event) => {
		const toolName = event.toolCallId ? toolNameByCall.get(event.toolCallId) : undefined;
		return classifyPayload(event, policy, toolName) === "offloadable" && !keepInline.has(event.eventId);
	});
}

/** Pure estimate used by the trigger policy; applies the exact execution classifier and reverse budget. */
export function estimateRecoverableToolTokens(input: {
	events: EventEnvelope[];
	policy: OffloadPolicy;
	alreadyOffloadedEventIds?: ReadonlySet<string>;
}): number {
	return offloadCandidateEvents(input.events, input.policy)
		.filter((event) => !input.alreadyOffloadedEventIds?.has(event.eventId))
		.reduce((sum, event) => {
			const text = payloadText(event.payload);
			const inlineTokens = Math.max(1, Math.ceil(text.length / 4));
			// Execution keeps a 200-char preview plus ref/status/call metadata.
			// Subtract only the conservative net saving used by the trigger.
			const projectedTokens = Math.ceil((Math.min(text.length, 200) + 160) / 4);
			return sum + Math.max(0, inlineTokens - projectedTokens);
		}, 0);
}

function resultInfo(event: EventEnvelope): { isError: boolean; exitCode?: number } {
	const payload = event.payload;
	if (isRecord(payload)) {
		const isError = payload.isError === true;
		const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : undefined;
		if (payload.isError !== undefined || payload.exitCode !== undefined) {
			return { isError, exitCode };
		}
		if (isRecord(payload.message)) {
			return { isError: payload.message.isError === true, exitCode };
		}
	}
	return { isError: false };
}

/**
 * Classify one event's payload. Approvals, contracts, ledger transitions and
 * compaction markers never leave the trusted store. Big tool results and big
 * message payloads are offload candidates; everything else stays structured.
 */
export function classifyPayload(event: EventEnvelope, policy: OffloadPolicy, toolName?: string): PayloadClass {
	if (
		event.eventType === "approval" ||
		event.eventType === "contract" ||
		event.eventType === "ledger" ||
		event.eventType === "task" ||
		event.eventType === "compaction" ||
		event.eventType === "state_change"
	) {
		return "must_keep_verbatim";
	}
	// Tool calls keep their arguments verbatim: the provider needs them for a
	// valid call/result sequence, so call payloads are never offload candidates.
	if (event.eventType === "tool_call") {
		return "must_keep_verbatim";
	}
	if (event.eventType === "tool_result" && toolName) {
		if (policy.highRiskTools.includes(toolName) || policy.toolExclusions.includes(toolName)) {
			return "must_keep_verbatim";
		}
	}
	if (event.eventType === "tool_result" && payloadBytes(event.payload) > policy.maxInlineBytes) {
		return "offloadable";
	}
	if (event.eventType === "tool_result" || event.eventType === "message") {
		return "structured";
	}
	return "structured";
}

/**
 * Offload eligible payloads from the given (already cut) events to the store.
 * Raw events are never modified; the outcome records feed the recall catalog
 * and prompt projections. `priorRecords` makes re-runs idempotent.
 */
export function offloadPayloads(input: {
	events: EventEnvelope[];
	store: ArtifactStore;
	policy: OffloadPolicy;
	tenant: string;
	priorRecords?: OffloadRecord[];
}): OffloadOutcome {
	const { events, store, policy, tenant } = input;
	const priorByEvent = new Map((input.priorRecords ?? []).map((r) => [r.eventId, r]));

	const candidates = new Set(offloadCandidateEvents(events, policy).map((event) => event.eventId));

	const outcome: OffloadOutcome = {
		records: [],
		effectiveRecords: [],
		skipped: [],
		failed: [],
		alreadyOffloaded: [],
		totalBytesOffloaded: 0,
	};

	for (const event of events) {
		if (!candidates.has(event.eventId)) {
			const classification = classifyPayload(event, policy);
			if (classification === "must_keep_verbatim") {
				outcome.skipped.push({ eventId: event.eventId, reason: "must_keep_verbatim" });
			} else if (classification === "offloadable") {
				outcome.skipped.push({ eventId: event.eventId, reason: "recent_tool_result_budget" });
			}
			continue;
		}
		const prior = priorByEvent.get(event.eventId);
		if (prior && prior.hash === hashPayload(payloadText(event.payload))) {
			outcome.alreadyOffloaded.push(event.eventId);
			outcome.effectiveRecords.push(prior);
			continue;
		}
		try {
			const text = payloadText(event.payload);
			const meta = store.put(text, {
				contentType: "text/plain",
				source: `event:${event.eventId}`,
				tenant,
			});
			const record: OffloadRecord = {
				eventId: event.eventId,
				toolCallId: event.toolCallId,
				artifactRef: meta.ref,
				preview: meta.preview,
				hash: meta.hash,
				bytesOffloaded: meta.size,
			};
			outcome.records.push(record);
			outcome.effectiveRecords.push(record);
			outcome.totalBytesOffloaded += meta.size;
		} catch (error) {
			// Fail safe: keep inline content, record the failure, never drop data.
			outcome.failed.push({ eventId: event.eventId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return outcome;
}

/**
 * Project an event for the active context: offloaded events keep call ID,
 * status, exit code, preview, and ref; untouched events pass through with
 * their inline preview.
 */
export function projectOffloadedEvent(event: EventEnvelope, record: OffloadRecord | undefined): OffloadedProjection {
	const info = event.eventType === "tool_result" ? resultInfo(event) : { isError: false, exitCode: undefined };
	const status = event.eventType === "tool_result" ? (info.isError ? "failed" : "succeeded") : "unknown";
	if (record) {
		return {
			eventId: event.eventId,
			toolCallId: event.toolCallId,
			status,
			exitCode: info.exitCode,
			preview: record.preview,
			ref: record.artifactRef,
		};
	}
	return {
		eventId: event.eventId,
		toolCallId: event.toolCallId,
		status,
		exitCode: info.exitCode,
		preview: payloadText(event.payload).slice(0, 200),
		ref: event.payloadRef,
	};
}
