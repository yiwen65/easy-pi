/**
 * CCTX-040: Structured state extractor.
 *
 * The model only PROPOSES deltas (facts, decisions, next actions) against a
 * strict JSON schema. Deterministic fields (constraints, permissions, task
 * and tool state) are read-only: any delta touching them is a schema-level
 * rejection. History input is wrapped as untrusted data; the request carries
 * no tool capability by construction. Merge is deterministic code. Anything
 * unconfirmable stays unverified.
 */

import { COMPACTOR_POLICY_VERSION, COMPACTOR_SYSTEM_POLICY, wrapUntrusted } from "./injection-guard.ts";
import type { DeterministicState } from "./reducer.ts";
import type {
	AtomicGroup,
	CompactionLLMResponse,
	CompleteFn,
	CoverageManifest,
	Decision,
	EventEnvelope,
	Fact,
	NextAction,
	StructuredSnapshot,
	TaskContract,
} from "./types.ts";

export class ExtractionError extends Error {}

export interface ExtractorInput {
	contract: TaskContract;
	signal?: AbortSignal;
	deterministicState: DeterministicState;
	priorSnapshot?: StructuredSnapshot;
	/** Prior extractor facts for incremental merge (from priorSnapshot usually). */
	priorFacts?: Fact[];
	coverageManifest: CoverageManifest;
	events: EventEnvelope[];
	groups: AtomicGroup[];
}

/** Extraction output budget scales with compacted input (long sessions produce more items). */
function extractionMaxTokens(input: ExtractorInput): number {
	const approxInputChars = input.events.reduce(
		(sum, e) => sum + JSON.stringify(e.payload ?? e.payloadRef ?? null).length,
		0,
	);
	return Math.min(16384, Math.max(4096, Math.ceil(approxInputChars / 8)));
}

export interface ExtractionResult {
	merged: { facts: Fact[]; decisions: Decision[]; nextActions: NextAction[] };
	droppedUnsourced: number;
	outOfRangeRefs: string[];
	/** Benign unknown item keys stripped during schema validation. */
	strippedUnknownKeys: number;
	/** True when the model output was truncated and salvaged at the last complete item. */
	salvaged: boolean;
	modelUsage?: { input: number; output: number };
}

/** Strict response schema: only narrative-state deltas; deterministic fields are not present. */
export const EXTRACTION_RESPONSE_SCHEMA: Record<string, unknown> = {
	type: "object",
	required: ["facts", "decisions", "nextActions"],
	additionalProperties: false,
	properties: {
		facts: {
			type: "array",
			items: {
				type: "object",
				required: ["text", "kind", "sourceEventIds"],
				additionalProperties: false,
				properties: {
					text: { type: "string" },
					kind: { type: "string", enum: ["fact", "assumption"] },
					sourceEventIds: { type: "array", items: { type: "string" } },
				},
			},
		},
		decisions: {
			type: "array",
			items: {
				type: "object",
				required: ["text", "sourceEventIds"],
				additionalProperties: false,
				properties: {
					text: { type: "string" },
					rationale: { type: "string" },
					alternativesRejected: { type: "array", items: { type: "string" } },
					causalParentDecisionIds: { type: "array", items: { type: "string" } },
					sourceEventIds: { type: "array", items: { type: "string" } },
				},
			},
		},
		nextActions: {
			type: "array",
			items: {
				type: "object",
				required: ["text", "sourceEventIds"],
				additionalProperties: false,
				properties: {
					text: { type: "string" },
					sourceEventIds: { type: "array", items: { type: "string" } },
				},
			},
		},
	},
};

/** Fields the extractor must never touch (deterministic or contract-owned). */
const FORBIDDEN_DELTA_KEYS = new Set([
	"constraints",
	"permissions",
	"tasks",
	"tools",
	"contract",
	"goal",
	"acceptanceCriteria",
	"budgets",
	"sideEffects",
	"approvals",
	"completed",
]);

interface RawDeltaItem {
	text?: unknown;
	kind?: unknown;
	sourceEventIds?: unknown;
	rationale?: unknown;
	alternativesRejected?: unknown;
	causalParentDecisionIds?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Hand-rolled strict validation against EXTRACTION_RESPONSE_SCHEMA (no runtime dep). */
function validateDeltaSchema(value: unknown): {
	facts: RawDeltaItem[];
	decisions: RawDeltaItem[];
	nextActions: RawDeltaItem[];
	strippedUnknownKeys: number;
} {
	if (!isRecord(value)) {
		throw new ExtractionError("Schema violation: extraction response is not an object");
	}
	let strippedUnknownKeys = 0;
	for (const key of Object.keys(value)) {
		if (FORBIDDEN_DELTA_KEYS.has(key)) {
			throw new ExtractionError(
				`Forbidden delta key "${key}": constraints, permissions, task/tool state are deterministic and read-only for the extractor`,
			);
		}
		if (!["facts", "decisions", "nextActions"].includes(key)) {
			throw new ExtractionError(`Schema violation: unexpected key "${key}" (additionalProperties: false)`);
		}
	}
	for (const required of ["facts", "decisions", "nextActions"] as const) {
		if (!Array.isArray(value[required])) {
			throw new ExtractionError(`Schema violation: "${required}" must be an array`);
		}
		for (const item of value[required] as unknown[]) {
			if (!isRecord(item) || typeof item.text !== "string" || item.text.length === 0) {
				throw new ExtractionError(`Schema violation: ${required} items require non-empty "text"`);
			}
			if (!isStringArray(item.sourceEventIds)) {
				throw new ExtractionError(`Schema violation: ${required} items require "sourceEventIds" (string array)`);
			}
			for (const key of Object.keys(item)) {
				const allowed =
					required === "decisions"
						? ["text", "rationale", "alternativesRejected", "causalParentDecisionIds", "sourceEventIds"]
						: required === "facts"
							? ["text", "kind", "sourceEventIds"]
							: ["text", "sourceEventIds"];
				if (!allowed.includes(key)) {
					// Benign extra metadata keys (models love adding "kind", "priority"…)
					// are stripped deterministically and counted, not schema-fatal.
					delete (item as Record<string, unknown>)[key];
					strippedUnknownKeys += 1;
				}
			}
			if (required === "facts" && item.kind !== undefined && item.kind !== "fact" && item.kind !== "assumption") {
				throw new ExtractionError(`Schema violation: fact kind must be "fact" or "assumption"`);
			}
		}
	}
	return {
		facts: value.facts as RawDeltaItem[],
		decisions: value.decisions as RawDeltaItem[],
		nextActions: value.nextActions as RawDeltaItem[],
		strippedUnknownKeys,
	};
}

function normalizeText(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildExtractionPrompt(input: ExtractorInput): string {
	const serializedEvents = input.events
		.map(
			(e) =>
				`[seq=${e.seq} id=${e.eventId} ${e.eventType}${e.toolCallId ? ` ${e.toolCallId}` : ""}] ${JSON.stringify(e.payload ?? e.payloadRef ?? null)}`,
		)
		.join("\n");
	const deterministicSummary = [
		`Deterministic state (read-only ground truth, do not restate as new facts):`,
		`- tools: ${input.deterministicState.tools.map((t) => `${t.name}[${t.toolCallId}]=${t.state}`).join(", ") || "(none)"}`,
		`- tasks: ${input.deterministicState.tasks.map((t) => `${t.id}=${t.state}`).join(", ") || "(none)"}`,
		`- unresolved errors: ${input.deterministicState.errors.filter((e) => !e.resolved).length}`,
	].join("\n");
	const contractSummary = [
		`Contract goal: ${input.contract.goal}`,
		`Constraints: ${input.contract.constraints.map((c) => c.text).join("; ") || "(none)"}`,
	].join("\n");
	return [
		wrapUntrusted(`${contractSummary}\n\n${deterministicSummary}\n\nEvents being compacted:\n${serializedEvents}`),
		"",
		"Extract NEW facts, decisions, and next actions from the untrusted events that are NOT already in the deterministic state.",
		'Use exactly these item shapes: facts=[{"text":string,"kind":"fact"|"assumption","sourceEventIds":string[]}], decisions=[{"text":string,"rationale"?:string,"alternativesRejected"?:string[],"causalParentDecisionIds"?:string[],"sourceEventIds":string[]}], nextActions=[{"text":string,"sourceEventIds":string[]}].',
		'Use the key "text", never "value", "description", or another alias. Do not add item keys outside the listed shapes.',
		'Every item MUST cite exact event ids copied from the "id=" field in the event header. Sequence numbers from "seq=" are not event ids and are invalid. If you cannot confirm an item from the events, either omit it or use kind "assumption".',
		'Respond with ONLY a JSON object: { "facts": [...], "decisions": [...], "nextActions": [...] }.',
	].join("\n");
}

/**
 * Salvage a truncated JSON extraction: cut at the last fully closed array item
 * and close open brackets. Lossy only at the tail (items dropped), never
 * wrong — and the validator still gates the result.
 */
export function salvageTruncatedJson(text: string): unknown | undefined {
	const start = text.indexOf("{");
	if (start === -1) return undefined;
	const s = text.slice(start);
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	let lastSafeCut = -1;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") {
			stack.push(ch);
			continue;
		}
		if (ch === "}" || ch === "]") {
			if (stack.length === 0) return undefined;
			stack.pop();
			// A closed object directly inside an array: a complete item boundary.
			if (ch === "}" && stack[stack.length - 1] === "[") {
				lastSafeCut = i + 1;
			}
		}
	}
	if (lastSafeCut === -1) return undefined;
	const closers = [...stack]
		.reverse()
		.map((c) => (c === "{" ? "}" : "]"))
		.join("");
	try {
		return JSON.parse(s.slice(0, lastSafeCut) + closers);
	} catch {
		return undefined;
	}
}

/**
 * Run structured extraction. Throws ExtractionError (fail closed) on empty
 * output, abort, schema violation, or forbidden delta keys.
 */
export async function extractState(input: ExtractorInput, complete: CompleteFn): Promise<ExtractionResult> {
	let response: CompactionLLMResponse;
	try {
		response = await complete({
			systemPrompt: COMPACTOR_SYSTEM_POLICY,
			messages: [{ role: "user", content: buildExtractionPrompt(input) }],
			maxTokens: extractionMaxTokens(input),
			responseSchema: EXTRACTION_RESPONSE_SCHEMA,
			promptVersion: COMPACTOR_POLICY_VERSION,
			signal: input.signal,
		});
	} catch (error) {
		throw new ExtractionError(
			`Extraction model call failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (response.stopReason !== "stop") {
		throw new ExtractionError(
			`Extraction did not complete cleanly (stopReason=${response.stopReason}): ${response.errorMessage ?? ""}`,
		);
	}
	if (!response.text || response.text.trim().length === 0) {
		throw new ExtractionError("Extraction returned empty output (fail closed)");
	}

	let parsed: unknown;
	let salvaged = false;
	try {
		// Tolerate markdown fences around the JSON object.
		const text = response.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
		parsed = JSON.parse(text);
	} catch {
		const salvagedParsed = salvageTruncatedJson(response.text);
		if (salvagedParsed === undefined) {
			throw new ExtractionError(
				`Extraction output is not valid JSON (first 160 chars: ${JSON.stringify(response.text.slice(0, 160))})`,
			);
		}
		parsed = salvagedParsed;
		salvaged = true;
	}
	const delta = validateDeltaSchema(parsed);

	// Deterministic merge with provenance enforcement.
	const coveredEventIds = new Set(input.events.map((e) => e.eventId));
	const eventIdBySeq = new Map(input.events.map((event) => [String(event.seq), event.eventId]));
	const canonicalizeRefs = (ids: string[]): string[] =>
		ids.map((id) => {
			if (coveredEventIds.has(id)) return id;
			const seqMatch = eventIdBySeq.get(id);
			if (seqMatch) return seqMatch;
			if (id.length < 8) return id;
			const prefixMatches = input.events.filter((event) => event.eventId.startsWith(id));
			return prefixMatches.length === 1 ? prefixMatches[0].eventId : id;
		});
	const outOfRangeRefs: string[] = [];
	let droppedUnsourced = 0;
	const priorFacts = input.priorFacts ?? input.priorSnapshot?.facts ?? [];
	const priorDecisions = input.priorSnapshot?.decisions ?? [];
	const priorNextActions = input.priorSnapshot?.nextActions ?? [];

	const mergedFacts: Fact[] = [...priorFacts];
	const mergedDecisions: Decision[] = [...priorDecisions];
	const mergedNextActions: NextAction[] = [...priorNextActions];

	const checkRefs = (ids: string[]): boolean => {
		if (ids.length === 0) return false;
		for (const id of ids) {
			if (!coveredEventIds.has(id) && !outOfRangeRefs.includes(id)) {
				outOfRangeRefs.push(id);
			}
		}
		return true;
	};

	let factCounter = mergedFacts.length;
	for (const item of delta.facts) {
		const sourceEventIds = canonicalizeRefs(item.sourceEventIds as string[]);
		if (!checkRefs(sourceEventIds)) {
			droppedUnsourced += 1;
			continue;
		}
		if (mergedFacts.some((f) => normalizeText(f.text) === normalizeText(item.text as string))) continue;
		factCounter += 1;
		mergedFacts.push({
			id: `f-x${factCounter}`,
			text: item.text as string,
			kind: item.kind === "assumption" ? "assumption" : "fact",
			// Extractor output is never auto-verified; verification comes from events/reducer.
			verified: false,
			provenance: { sourceEventIds, source: "extractor" },
		});
	}

	let decisionCounter = mergedDecisions.length;
	for (const item of delta.decisions) {
		const sourceEventIds = canonicalizeRefs(item.sourceEventIds as string[]);
		if (!checkRefs(sourceEventIds)) {
			droppedUnsourced += 1;
			continue;
		}
		if (mergedDecisions.some((d) => normalizeText(d.text) === normalizeText(item.text as string))) continue;
		decisionCounter += 1;
		mergedDecisions.push({
			id: `d-x${decisionCounter}`,
			text: item.text as string,
			rationale: typeof item.rationale === "string" ? item.rationale : undefined,
			alternativesRejected: isStringArray(item.alternativesRejected) ? item.alternativesRejected : undefined,
			causalParentDecisionIds: isStringArray(item.causalParentDecisionIds) ? item.causalParentDecisionIds : [],
			provenance: { sourceEventIds, source: "extractor" },
		});
	}

	let actionCounter = mergedNextActions.length;
	for (const item of delta.nextActions) {
		const sourceEventIds = canonicalizeRefs(item.sourceEventIds as string[]);
		if (!checkRefs(sourceEventIds)) {
			droppedUnsourced += 1;
			continue;
		}
		if (mergedNextActions.some((n) => normalizeText(n.text) === normalizeText(item.text as string))) continue;
		actionCounter += 1;
		mergedNextActions.push({
			id: `n-x${actionCounter}`,
			text: item.text as string,
			provenance: { sourceEventIds, source: "extractor" },
		});
	}

	return {
		merged: { facts: mergedFacts, decisions: mergedDecisions, nextActions: mergedNextActions },
		droppedUnsourced,
		outOfRangeRefs,
		strippedUnknownKeys: delta.strippedUnknownKeys,
		salvaged,
		modelUsage: response.usage,
	};
}
