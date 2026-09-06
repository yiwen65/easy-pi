import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type {
	ExternalWriterHandoff,
	HandoffEvidence,
	SubagentHandoff,
	SubagentRole,
	TaskOutcome,
	WriterHandoff,
} from "./types.ts";
import {
	EXTERNAL_WRITER_ROLE,
	HANDOFF_ARTIFACT_VERSION,
	HANDOFF_PROTOCOL_VERSION,
	SUBAGENT_TASK_ID_MAX_CHARS,
	SUBAGENT_TASK_ID_PATTERN,
	WRITER_ROLE,
} from "./types.ts";

export const HANDOFF_LIMITS = {
	maxJsonBytes: 48 * 1024,
	maxEnvelopeBytes: 64 * 1024,
	summaryChars: 2_048,
	evidenceItems: 12,
	changedPaths: 64,
	pathChars: 500,
	lineRangeChars: 100,
	claimChars: 500,
} as const;

const ANALYST_OUTCOME_GUIDANCE =
	"Set outcome based on whether the assigned analysis is complete, not whether its findings favor the subject being analyzed. An evidence-backed completed analysis is accepted even when the findings recommend against an option or show that a proposed claim is false. Use rejected only when the delivered analysis is known not to satisfy a task acceptance criterion; use inconclusive only when the available evidence is insufficient to complete the requested analysis safely.";

const REVIEWER_OUTCOME_GUIDANCE =
	"For a Reviewer, outcome is the review verdict. Use accepted only when the reviewed work satisfies the task acceptance criteria. Use rejected when evidence proves an acceptance criterion is not met. Use inconclusive when the available evidence is insufficient to decide the review safely.";

export const WRITER_OUTCOME_GUIDANCE =
	"Set outcome to accepted when a usable implementation is complete and ready for Controller audit; accepted does not claim that unavailable checks passed. Include checks performed, unavailable checks, and material risks in summary. The Parent Controller owns changed-path audit, registered validation, and the Git commit, so repository commit requirements are not a Child blocker. Use rejected only when available evidence proves the implementation fails the task; use inconclusive only when no safe usable implementation could be completed.";

const EXTERNAL_WRITER_OUTCOME_GUIDANCE =
	"Set outcome to accepted when a usable external change is complete and ready for Controller mutation-journal audit; accepted does not claim that unavailable checks passed. Include checks performed, unavailable checks, and material risks in summary. The Parent Controller owns mutation-journal and post-state audit. Use rejected only when available evidence proves the external change fails the task; use inconclusive only when no safe usable external change could be completed.";

export function outcomeGuidanceForRole(role: SubagentRole): string {
	if (role === "reviewer") return REVIEWER_OUTCOME_GUIDANCE;
	if (role === WRITER_ROLE) return WRITER_OUTCOME_GUIDANCE;
	if (role === EXTERNAL_WRITER_ROLE) return EXTERNAL_WRITER_OUTCOME_GUIDANCE;
	return ANALYST_OUTCOME_GUIDANCE;
}

const EvidenceSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: HANDOFF_LIMITS.pathChars }),
		lineRange: Type.Optional(Type.String({ minLength: 1, maxLength: HANDOFF_LIMITS.lineRangeChars })),
		claim: Type.String({ minLength: 1, maxLength: HANDOFF_LIMITS.claimChars }),
	},
	{ additionalProperties: false },
);

const OutcomeSchema = Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("inconclusive")]);

function assertTaskId(taskId: string): void {
	if (
		taskId.length < 1 ||
		taskId.length > SUBAGENT_TASK_ID_MAX_CHARS ||
		!new RegExp(SUBAGENT_TASK_ID_PATTERN).test(taskId)
	) {
		throw new Error(
			`Subagent taskId must be 1-${SUBAGENT_TASK_ID_MAX_CHARS} characters and match ${SUBAGENT_TASK_ID_PATTERN}`,
		);
	}
}

/** Controller identity, protocol version, and audited paths are injected after submission. */
export function createSubmitHandoffSchema(): TSchema {
	return Type.Object(
		{
			summary: Type.String({ minLength: 1, maxLength: HANDOFF_LIMITS.summaryChars }),
			outcome: OutcomeSchema,
			evidence: Type.Optional(Type.Array(EvidenceSchema, { maxItems: HANDOFF_LIMITS.evidenceItems })),
		},
		{ additionalProperties: false },
	);
}

function encodedBytes(value: unknown, context: string, limit: number): { text: string; bytes: number } {
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw new Error(`${context} is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (text === undefined) throw new Error(`${context} is not JSON-serializable`);
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > limit) throw new Error(`${context} exceeds ${limit}-byte JSON limit (${bytes} bytes)`);
	return { text, bytes };
}

function parseJson(text: string, context: string, limit: number): unknown {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > limit) throw new Error(`${context} exceeds ${limit}-byte JSON limit (${bytes} bytes)`);
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${context} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function commonHandoff(record: Record<string, unknown>, taskId: string): SubagentHandoff {
	const evidence = ((record.evidence as HandoffEvidence[] | undefined) ?? []).map((item) => ({ ...item }));
	return {
		taskId,
		summary: record.summary as string,
		outcome: record.outcome as TaskOutcome,
		evidence,
		verification: [],
		assumptions: [],
		risks: [],
		nextActions: [],
		verificationLevel: "unverified",
	};
}

export type DecodedHandoff = SubagentHandoff | WriterHandoff | ExternalWriterHandoff;

/** Preserve validated child evidence while making hard-limit incompleteness authoritative. */
export function asInconclusivePartialHandoff(handoff: DecodedHandoff): DecodedHandoff {
	return { ...structuredClone(handoff), outcome: "inconclusive" };
}

export interface DecodedHandoffSubmission {
	/** Canonical child-owned fields persisted in the one-shot envelope. */
	payload: Record<string, unknown>;
	/** Controller-normalized handoff with internal legacy-shape defaults. */
	handoff: DecodedHandoff;
}

/** Strictly decode one v2 tool payload for the exact controller-bound task and role. */
export function decodeHandoffSubmission(
	value: unknown,
	expectedTaskId: string,
	expectedRole: SubagentRole,
): DecodedHandoffSubmission {
	assertTaskId(expectedTaskId);
	encodedBytes(value, "Subagent handoff", HANDOFF_LIMITS.maxJsonBytes);
	const schema = createSubmitHandoffSchema();
	if (!Value.Check(schema, value)) {
		throw new Error("Subagent handoff does not match the task-bound protocol v2 schema");
	}
	const record = value as Record<string, unknown>;
	const handoff = commonHandoff(record, expectedTaskId);
	const commonPayload = {
		taskId: expectedTaskId,
		role: expectedRole,
		summary: handoff.summary,
		outcome: handoff.outcome,
		evidence: handoff.evidence.map((item) => ({ ...item })),
		verification: handoff.verification.map((item) => ({ ...item })),
		assumptions: [...handoff.assumptions],
		risks: [...handoff.risks],
		nextActions: [...handoff.nextActions],
	};
	if (expectedRole === WRITER_ROLE) {
		return {
			payload: { ...commonPayload, artifactVersion: HANDOFF_ARTIFACT_VERSION, changedPaths: [] },
			handoff: { ...handoff, artifactVersion: HANDOFF_ARTIFACT_VERSION, changedPaths: [] },
		};
	}
	if (expectedRole === EXTERNAL_WRITER_ROLE) {
		return {
			payload: { ...commonPayload, artifactVersion: HANDOFF_ARTIFACT_VERSION, externalChangedPaths: [] },
			handoff: { ...handoff, artifactVersion: HANDOFF_ARTIFACT_VERSION, externalChangedPaths: [] },
		};
	}
	return { payload: commonPayload, handoff };
}

export function createHandoffEnvelope(submission: DecodedHandoffSubmission): {
	protocolVersion: typeof HANDOFF_PROTOCOL_VERSION;
	payload: Record<string, unknown>;
} {
	return { protocolVersion: HANDOFF_PROTOCOL_VERSION, payload: structuredClone(submission.payload) };
}

/** Parent-side decoder for the Controller-normalized process-boundary envelope. */
export function decodeHandoffEnvelope(
	text: string,
	expectedTaskId: string,
	expectedRole: SubagentRole,
): DecodedHandoff {
	const value = parseJson(text, "Structured handoff envelope", HANDOFF_LIMITS.maxEnvelopeBytes);
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => key !== "protocolVersion" && key !== "payload") ||
		(value as Record<string, unknown>).protocolVersion !== HANDOFF_PROTOCOL_VERSION
	) {
		throw new Error("Structured handoff envelope must contain only protocolVersion 2 and payload");
	}
	const payload = (value as Record<string, unknown>).payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Structured handoff envelope payload must be an object");
	}
	const record = payload as Record<string, unknown>;
	const normalizedListFields = ["verification", "assumptions", "risks", "nextActions"] as const;
	const controllerFields = new Set(["taskId", "role", ...normalizedListFields]);
	if (expectedRole === WRITER_ROLE) {
		controllerFields.add("artifactVersion");
		controllerFields.add("changedPaths");
	} else if (expectedRole === EXTERNAL_WRITER_ROLE) {
		controllerFields.add("artifactVersion");
		controllerFields.add("externalChangedPaths");
	}
	const modelFields = new Set(["summary", "outcome", "evidence"]);
	if (Object.keys(record).some((key) => !controllerFields.has(key) && !modelFields.has(key))) {
		throw new Error("Structured handoff envelope payload contains unexpected fields");
	}
	if (record.taskId !== expectedTaskId || record.role !== expectedRole) {
		throw new Error("Structured handoff envelope identity does not match the task contract");
	}
	if (normalizedListFields.some((key) => !Array.isArray(record[key]) || record[key].length > 0)) {
		throw new Error("Structured handoff envelope has invalid Controller-normalized lists");
	}
	if (expectedRole === WRITER_ROLE) {
		if (
			record.artifactVersion !== HANDOFF_ARTIFACT_VERSION ||
			!Array.isArray(record.changedPaths) ||
			record.changedPaths.length > 0
		) {
			throw new Error("Structured writer handoff envelope has invalid Controller fields");
		}
	} else if (expectedRole === EXTERNAL_WRITER_ROLE) {
		if (
			record.artifactVersion !== HANDOFF_ARTIFACT_VERSION ||
			!Array.isArray(record.externalChangedPaths) ||
			record.externalChangedPaths.length > 0
		) {
			throw new Error("Structured external-writer handoff envelope has invalid Controller fields");
		}
	}
	const modelPayload = Object.fromEntries(Object.entries(record).filter(([key]) => modelFields.has(key)));
	return decodeHandoffSubmission(modelPayload, expectedTaskId, expectedRole).handoff;
}

/** Narrow helper for tests and adapters that already hold JSON text. Production uses submit_handoff. */
export function decodeHandoffJson(
	text: string,
	expectedTaskId: string,
	expectedRole: SubagentRole,
): DecodedHandoffSubmission {
	return decodeHandoffSubmission(
		parseJson(text, "Subagent handoff", HANDOFF_LIMITS.maxJsonBytes),
		expectedTaskId,
		expectedRole,
	);
}
