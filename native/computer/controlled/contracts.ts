import { Buffer } from "node:buffer";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const reference = Type.String({ minLength: 1, maxLength: 128 });
const selector = Type.Object(
	{ role: Type.String({ minLength: 1, maxLength: 64 }), label: Type.String({ minLength: 1, maxLength: 256 }) },
	{ additionalProperties: false },
);
const address = Type.Union([
	Type.Object({ ref: reference }, { additionalProperties: false }),
	Type.Object({ selector }, { additionalProperties: false }),
]);
const text = Type.String({ maxLength: 16 * 1024 });

/** Model protocol for the native form profile, not handwritten UniFFI declarations or the P01 fake profile. */
export const ControlledFormInputSchema = Type.Object(
	{
		request: Type.Union([
			Type.Object({ op: StringEnum(["observe"] as const) }, { additionalProperties: false }),
			Type.Object(
				{
					op: StringEnum(["execute"] as const),
					ref: reference,
					steps: Type.Array(
						Type.Union([
							Type.Object(
								{ op: StringEnum(["fill"] as const), target: address, text },
								{ additionalProperties: false },
							),
							Type.Object(
								{ op: StringEnum(["press"] as const), target: address, expect: selector, value: text },
								{ additionalProperties: false },
							),
							Type.Object(
								{ op: StringEnum(["assert_value"] as const), selector, value: text },
								{ additionalProperties: false },
							),
						]),
						{ minItems: 1, maxItems: 8 },
					),
				},
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);
// Keep the desktop pixel-click language separate from token-based form/browser clicks.
export const ControlledComputerInputSchema = Type.Object(
	{
		request: Type.Union([
			ControlledFormInputSchema.properties.request,
			Type.Object(
				{ op: StringEnum(["observe"] as const), text: Type.String({ minLength: 1, maxLength: 256 }) },
				{ additionalProperties: false },
			),
			Type.Object(
				{ op: StringEnum(["click"] as const), ref: reference, target: reference },
				{ additionalProperties: false },
			),
			Type.Object(
				{ op: StringEnum(["select_option"] as const), ref: reference, target: reference },
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);
export type ControlledComputerInput = Static<typeof ControlledComputerInputSchema>;
export type ExecuteRequest = Extract<ControlledComputerInput["request"], { op: "execute" }>;
export type Selector = Static<typeof selector>;
export type Address = Static<typeof address>;

/** Reject before generic validation can echo sensitive arguments. Rust validates again at its boundary. */
export function parseControlledComputerInput(input: unknown): ControlledComputerInput {
	if (!Value.Check(ControlledComputerInputSchema, input)) throw new Error("Invalid computer request");
	const bounded = (value: string, max: number) => Buffer.byteLength(value, "utf8") <= max;
	const validSelector = (value: Selector) => bounded(value.role, 64) && bounded(value.label, 256);
	if (
		input.request.op === "observe" &&
		"text" in input.request &&
		(!input.request.text.trim() || !bounded(input.request.text, 256))
	)
		throw new Error("Invalid computer observation filter");
	if (
		(input.request.op === "click" || input.request.op === "select_option") &&
		(!bounded(input.request.ref, 128) || !bounded(input.request.target, 128))
	)
		throw new Error("Invalid computer reference");
	if (input.request.op === "execute") {
		if (!bounded(input.request.ref, 128)) throw new Error("Invalid computer reference");
		let bytes = 0;
		for (const step of input.request.steps) {
			bytes += Buffer.byteLength(step.op === "fill" ? step.text : step.value, "utf8");
			if (step.op === "assert_value") {
				if (!validSelector(step.selector)) throw new Error("Invalid computer selector");
			} else {
				const valid = "ref" in step.target ? bounded(step.target.ref, 128) : validSelector(step.target.selector);
				if (!valid || (step.op === "press" && !validSelector(step.expect)))
					throw new Error("Invalid computer target");
			}
		}
		if (bytes > 16 * 1024) throw new Error("Computer request text exceeds 16 KiB");
	}
	return structuredClone(input);
}
