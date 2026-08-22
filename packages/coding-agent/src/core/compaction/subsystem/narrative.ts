/**
 * CCTX-041: Narrative bridge summarizer.
 *
 * The narrative is a lossy bridge: progress, background, decision rationale,
 * next step. It never stores unique facts, never introduces permissions,
 * completion status, side-effect conclusions, or exact values that are not
 * grounded in typed state or source events. On any conflict the candidate is
 * rejected — typed state always wins.
 */

import {
	COMPACTOR_SYSTEM_POLICY,
	detectInjections,
	NARRATIVE_PROMPT_VERSION,
	wrapUntrusted,
} from "./injection-guard.ts";
import type { DeterministicState } from "./reducer.ts";
import type {
	CompactionLLMResponse,
	CompleteFn,
	Decision,
	EventEnvelope,
	Fact,
	NextAction,
	TaskContract,
} from "./types.ts";

export interface NarrativeInput {
	contract: TaskContract;
	deterministicState: DeterministicState;
	extracted: { facts: Fact[]; decisions: Decision[]; nextActions: NextAction[] };
	priorNarrative?: string;
	events: EventEnvelope[];
	/** Character budget ≈ tokens*4; over-budget text is truncated at a sentence boundary. */
	budgetTokens?: number;
	signal?: AbortSignal;
	/** When false, narrative generation is skipped entirely (structured_compaction mode). */
	narrativeEnabled?: boolean;
}

export interface NarrativeResult {
	text: string;
	rejected: boolean;
	conflicts: string[];
	modelUsage?: { input: number; output: number };
}

const NARRATIVE_INSTRUCTIONS = `Write a short narrative bridge for another agent continuing this work.
Rules:
- Describe current progress, why decisions were made, and what happens next.
- Do NOT assert that anything is complete, succeeded, fixed, or released unless the typed state says so.
- Do NOT introduce exact values (versions, paths, numbers, hashes) that are not in the typed state or events.
- Reference task/decision IDs when mentioning them.
- Plain prose, at most a few sentences.`;

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

/** Exact-value tokens: versions, absolute paths, long hashes, big numbers. */
const EXACT_VALUE_PATTERN = /\b\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?|\/[^\s,;"')]+|\b[0-9a-f]{16,}\b|\b\d{5,}\b/gi;

const COMPLETION_PATTERN =
	/\b(completed|complete|done|finished|fixed|resolved|released|deployed|succeeded)\b|已完成|已修复|已发布/gi;

export interface ConflictContext {
	deterministicState: DeterministicState;
	events: EventEnvelope[];
}

/**
 * Deterministic conflict check: narrative vs typed state and source events.
 * Returns human-readable conflict descriptions; empty means no conflict.
 */
export function checkNarrativeConflicts(text: string, context: ConflictContext): string[] {
	const conflicts: string[] = [];

	// 1. Injection / authority claims never belong in a narrative.
	for (const finding of detectInjections(text)) {
		conflicts.push(`injection pattern ${finding.patternId}: "${finding.matched}"`);
	}

	// 2. Exact values must be grounded in typed state or events.
	const groundTruth = [
		...context.events.map(eventText),
		...context.deterministicState.tasks.map((t) => `${t.id} ${t.title}`),
		...context.deterministicState.tools.map((t) => `${t.toolCallId} ${t.name}`),
		...context.deterministicState.artifacts.map((a) => a.ref),
	].join("\n");
	const seen = new Set<string>();
	for (const match of text.matchAll(EXACT_VALUE_PATTERN)) {
		const value = match[0];
		if (seen.has(value)) continue;
		seen.add(value);
		if (!groundTruth.includes(value)) {
			conflicts.push(`ungrounded exact value in narrative: "${value}"`);
		}
	}

	// 3. Completion claims about non-done tasks conflict with typed state.
	for (const task of context.deterministicState.tasks) {
		if (task.state === "done") continue;
		const titleIndex = text.indexOf(task.title);
		if (titleIndex === -1) continue;
		const window = text.slice(Math.max(0, titleIndex - 80), titleIndex + task.title.length + 80);
		COMPLETION_PATTERN.lastIndex = 0;
		if (COMPLETION_PATTERN.test(window)) {
			conflicts.push(
				`narrative claims completion of task ${task.id} ("${task.title}") but typed state is ${task.state}`,
			);
		}
	}

	return conflicts;
}

function truncateAtSentence(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = text.slice(0, maxChars);
	const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"), head.lastIndexOf("。"));
	if (lastStop > 0) {
		return head.slice(0, lastStop + 1);
	}
	return head;
}

/**
 * Generate the narrative bridge. Rejected narratives return rejected:true
 * with conflict details; callers must then drop the narrative (typed state
 * and the verbatim tail remain authoritative).
 */
export async function generateNarrative(input: NarrativeInput, complete: CompleteFn): Promise<NarrativeResult> {
	if (input.narrativeEnabled === false) {
		return { text: "", rejected: false, conflicts: [] };
	}
	const serialized = input.events.map((e) => `[${e.seq} ${e.eventType}] ${eventText(e)}`).join("\n");
	const typedSummary = [
		`Tasks: ${input.deterministicState.tasks.map((t) => `${t.id} "${t.title}" = ${t.state}`).join("; ") || "(none)"}`,
		`Tools: ${input.deterministicState.tools.map((t) => `${t.name}[${t.toolCallId}] = ${t.state}`).join("; ") || "(none)"}`,
		`Decisions: ${input.extracted.decisions.map((d) => `${d.id} ${d.text}`).join("; ") || "(none)"}`,
		`Next actions: ${input.extracted.nextActions.map((n) => `${n.id} ${n.text}`).join("; ") || "(none)"}`,
	].join("\n");
	const prompt = [
		wrapUntrusted(`Typed state:\n${typedSummary}\n\nEvents:\n${serialized}`),
		"",
		NARRATIVE_INSTRUCTIONS,
	].join("\n");

	let response: CompactionLLMResponse;
	try {
		response = await complete({
			systemPrompt: COMPACTOR_SYSTEM_POLICY,
			messages: [{ role: "user", content: prompt }],
			maxTokens: Math.min(1024, (input.budgetTokens ?? 500) * 2),
			promptVersion: NARRATIVE_PROMPT_VERSION,
			signal: input.signal,
		});
	} catch (error) {
		return {
			text: "",
			rejected: true,
			conflicts: [`model call failed: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	if (response.stopReason !== "stop" || !response.text || response.text.trim().length === 0) {
		return {
			text: "",
			rejected: true,
			conflicts: [`narrative generation failed (stopReason=${response.stopReason})`],
		};
	}

	const budget = (input.budgetTokens ?? 500) * 4;
	const text = truncateAtSentence(response.text.trim(), budget);
	const conflicts = checkNarrativeConflicts(text, {
		deterministicState: input.deterministicState,
		events: input.events,
	});
	if (conflicts.length > 0) {
		return { text: "", rejected: true, conflicts, modelUsage: response.usage };
	}
	return { text, rejected: false, conflicts: [], modelUsage: response.usage };
}
