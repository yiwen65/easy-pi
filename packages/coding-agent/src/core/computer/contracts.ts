import { Buffer } from "node:buffer";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const COMPUTER_MAX_STEPS = 8;
export const COMPUTER_MAX_INPUT_BYTES = 16 * 1024;
export const COMPUTER_MAX_OBSERVATION_BYTES = 4 * 1024;

const opaqueReference = Type.String({ minLength: 1, maxLength: 128 });
const inputText = Type.String({ maxLength: COMPUTER_MAX_INPUT_BYTES });
const stepSchema = Type.Union([
	Type.Object(
		{ op: StringEnum(["fill"] as const), target: opaqueReference, text: inputText },
		{ additionalProperties: false },
	),
	Type.Object(
		{ op: StringEnum(["assert_value"] as const), target: opaqueReference, value: inputText },
		{ additionalProperties: false },
	),
]);

/** P01 host protocol, not a native SDK or generated binding. */
export const ComputerInputSchema = Type.Object(
	{
		request: Type.Union([
			Type.Object({ op: StringEnum(["observe"] as const) }, { additionalProperties: false }),
			Type.Object(
				{
					op: StringEnum(["execute"] as const),
					ref: opaqueReference,
					steps: Type.Array(stepSchema, { minItems: 1, maxItems: COMPUTER_MAX_STEPS }),
				},
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);

export type ComputerInput = Static<typeof ComputerInputSchema>;
export type ComputerExecuteRequest = Extract<ComputerInput["request"], { op: "execute" }>;
export type ComputerStep = ComputerExecuteRequest["steps"][number];

/** Validate before generic tool validation can include raw arguments in an error. */
export function parseComputerInput(input: unknown): ComputerInput {
	if (!Value.Check(ComputerInputSchema, input)) throw new Error("Invalid computer request");
	if (input.request.op === "execute") {
		const bytes = input.request.steps.reduce(
			(total, step) => total + Buffer.byteLength(step.op === "fill" ? step.text : step.value, "utf8"),
			0,
		);
		if (bytes > COMPUTER_MAX_INPUT_BYTES) throw new Error("Computer request text exceeds 16 KiB");
	}
	return structuredClone(input);
}

export const ComputerExecutionResultSchema = Type.Object(
	{
		status: StringEnum(["completed", "partial", "failed", "cancelled", "outcome_unknown"] as const),
		/** Number of consecutive steps whose required effects/conditions are confirmed. */
		completedSteps: Type.Integer({ minimum: 0, maximum: COMPUTER_MAX_STEPS }),
		error: Type.Optional(
			StringEnum([
				"invalid_request",
				"native_unavailable",
				"session_closed",
				"stale_observation",
				"target_ambiguous",
				"condition_unsatisfied",
				"condition_unknown",
				"cancelled_before_dispatch",
				"cancelled",
				"outcome_unknown",
				"native_fault",
			] as const),
		),
	},
	{ additionalProperties: false },
);

export type ComputerExecutionResult = Static<typeof ComputerExecutionResultSchema>;
export type ComputerErrorCode = NonNullable<ComputerExecutionResult["error"]>;

export interface ComputerObservation {
	ref: string;
	/** Model-visible observation only; never copied into diagnostics. */
	text: string;
	truncated?: boolean;
}

export interface ComputerResult extends ComputerExecutionResult {
	/** Zero-based index; absent when all requested steps completed or no plan was admitted. */
	firstUncompletedStep?: number;
	observation?: ComputerObservation;
}

export interface ComputerToolDetails extends ComputerExecutionResult {
	firstUncompletedStep?: number;
	observationRef?: string;
	observationTruncated?: boolean;
}

/** Host-injected capability. Every promise must settle only after its operation is terminal. */
export interface ComputerBackend {
	observe(signal?: AbortSignal): Promise<ComputerObservation>;
	/** Stop at the first unconfirmed step; never retry, replay, or reinterpret a stale ref. */
	execute(request: ComputerExecuteRequest, signal?: AbortSignal): Promise<ComputerExecutionResult>;
	close(): Promise<void>;
}

export type ComputerBackendFactory = () => ComputerBackend | Promise<ComputerBackend>;
