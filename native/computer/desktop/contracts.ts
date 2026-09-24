import { Buffer } from "node:buffer";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ControlledComputerInputSchema, parseControlledComputerInput } from "../controlled/contracts.ts";
import { ComputerDragInputSchema, parseComputerDragInput } from "./drag-contracts.ts";
import { ComputerSegmentInputSchema, parseComputerSegmentInput } from "./segment-contracts.ts";

const ref = Type.String({ minLength: 1, maxLength: 128 });
const coordinate = Type.Number({ minimum: 0, maximum: 2048 });
export const DesktopInputSchema = Type.Object(
	{
		request: Type.Union([
			ComputerDragInputSchema.properties.request,
			ComputerSegmentInputSchema.properties.request,
			ControlledComputerInputSchema.properties.request,
			Type.Object(
				{
					op: StringEnum(["observe"] as const),
					text: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					op: StringEnum(["discover"] as const),
					app: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
					title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
					focused: Type.Optional(Type.Literal(true)),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{ op: StringEnum(["select"] as const), ref, observe: Type.Optional(Type.Literal(true)) },
				{ additionalProperties: false },
			),
			Type.Object({ op: StringEnum(["select_destination"] as const), ref }, { additionalProperties: false }),
			Type.Object(
				{
					op: StringEnum(["capture", "capture_pair"] as const),
					maxDimension: Type.Integer({ minimum: 1, maximum: 2048 }),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{ op: StringEnum(["click"] as const), ref, x: coordinate, y: coordinate },
				{ additionalProperties: false },
			),
			Type.Object(
				{
					op: StringEnum(["scroll"] as const),
					ref,
					x: coordinate,
					y: coordinate,
					direction: StringEnum(["up", "down", "left", "right"] as const),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					op: StringEnum(["key"] as const),
					ref,
					key: StringEnum([
						"Return",
						"Tab",
						"Escape",
						"Space",
						"Delete",
						"Up",
						"Down",
						"Left",
						"Right",
						"Home",
						"End",
						"PageUp",
						"PageDown",
					] as const),
				},
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);
export type DesktopInput = Static<typeof DesktopInputSchema>;

export function parseDesktopInput(input: unknown): DesktopInput {
	if (!Value.Check(DesktopInputSchema, input)) throw new Error("Invalid computer request");
	const request = input.request;
	if (request.op === "discover") {
		for (const filter of [request.app, request.title]) {
			if (filter !== undefined && (Buffer.byteLength(filter) > 256 || /[\uD800-\uDFFF]/u.test(filter)))
				throw new Error("Invalid computer discovery filter");
		}
	}
	if (request.op === "observe" && "text" in request && request.text !== undefined) {
		if (Buffer.byteLength(request.text) > 256 || /[\uD800-\uDFFF]/u.test(request.text))
			throw new Error("Invalid computer observation filter");
	}
	if (request.op === "drag_between") return parseComputerDragInput(input);
	if (request.op === "segment") return parseComputerSegmentInput(input);
	if (request.op === "execute") return parseControlledComputerInput(input);
	if ("ref" in request && Buffer.byteLength(request.ref) > 128) throw new Error("Invalid computer reference");
	if ("x" in request && (!Number.isFinite(request.x) || !Number.isFinite(request.y)))
		throw new Error("Invalid computer coordinates");
	return structuredClone(input);
}
