import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	ComputerPointSchema,
	type ComputerSegmentInput,
	ComputerVisualExpectationSchema,
	parseComputerSegmentInput,
} from "./segment-contracts.ts";

const closed = { additionalProperties: false };
export const ComputerDragInputSchema = Type.Object(
	{
		request: Type.Object(
			{
				op: Type.Literal("drag_between"),
				from: ComputerPointSchema,
				to: ComputerPointSchema,
				durationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 200 })),
				expected: ComputerVisualExpectationSchema,
				previousEffect: Type.Optional(Type.Literal("observed")),
			},
			closed,
		),
	},
	closed,
);
export type ComputerDragInput = Static<typeof ComputerDragInputSchema>;

/** Reuse the genuine one-action segment codec; destination authority is a separate opaque capability. */
export function dragSegment(request: ComputerDragInput["request"]): ComputerSegmentInput["request"] {
	return {
		op: "segment",
		ref: request.from.ref,
		actions: [{ op: "drag", from: request.from, to: request.to, durationMs: request.durationMs ?? 200 }],
		expected: request.expected,
		...(request.previousEffect ? { previousEffect: request.previousEffect } : {}),
	};
}

export function parseComputerDragInput(input: unknown): ComputerDragInput {
	if (!Value.Check(ComputerDragInputSchema, input)) throw new Error("Invalid computer drag");
	if (input.request.from.ref === input.request.to.ref) throw new Error("Distinct drag images required");
	parseComputerSegmentInput({ request: dragSegment(input.request) });
	return structuredClone(input);
}
