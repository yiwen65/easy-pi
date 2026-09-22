import { Buffer } from "node:buffer";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const closed = { additionalProperties: false };
const reference = Type.String({ minLength: 1, maxLength: 128 });
const role = Type.String({ minLength: 1, maxLength: 64 });
const label = Type.String({ minLength: 1, maxLength: 256 });
const selectorFields = {
	role: Type.Optional(role),
	label: Type.Optional(label),
	identifier: Type.Optional(label),
	within: Type.Optional(reference),
};
const selector = Type.Union([
	Type.Object({ ...selectorFields, role }, closed),
	Type.Object({ ...selectorFields, label }, closed),
	Type.Object({ ...selectorFields, identifier: label }, closed),
]);
const target = Type.Union([Type.Object({ ref: reference }, closed), Type.Object({ selector }, closed)]);
const coordinate = Type.Number({ minimum: 0, exclusiveMaximum: 2048 });
const point = Type.Object({ ref: reference, x: coordinate, y: coordinate }, closed);
export const ComputerPointSchema = point;
export const ComputerVisualExpectationSchema = Type.Object(
	{ kind: Type.Literal("visual"), description: Type.String({ minLength: 1, maxLength: 1024 }) },
	closed,
);
const button = Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]);
const key = Type.String({ minLength: 1, maxLength: 32, pattern: "^[ -~]+(?![\\s\\S])" });
const text = Type.String({ maxLength: 16 * 1024 });
const position = Type.Number({ minimum: -1_000_000, maximum: 1_000_000 });
const dimension = Type.Number({ minimum: 1, maximum: 32768 });
const bounds = { x: position, y: position, width: dimension, height: dimension };
const delta = Type.Number({ minimum: -4096, maximum: 4096 });
const action = Type.Union([
	Type.Object({ op: Type.Literal("focus"), target }, closed),
	Type.Object({ op: Type.Literal("fill"), target, text }, closed),
	Type.Object({ op: Type.Literal("type_text"), text }, closed),
	Type.Object(
		{
			op: Type.Literal("key"),
			key,
			modifiers: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("command"),
						Type.Literal("control"),
						Type.Literal("option"),
						Type.Literal("shift"),
						Type.Literal("fn"),
					]),
					{ maxItems: 5, uniqueItems: true, default: [] },
				),
			),
		},
		closed,
	),
	Type.Object({ op: Type.Literal("key_down"), key }, closed),
	Type.Object({ op: Type.Literal("key_up"), key }, closed),
	Type.Object({ op: Type.Literal("pointer_move"), point }, closed),
	Type.Object({ op: Type.Literal("button_down"), button }, closed),
	Type.Object({ op: Type.Literal("button_up"), button }, closed),
	Type.Object(
		{
			op: Type.Literal("click"),
			point,
			button: Type.Optional(Type.Union(button.anyOf, { default: "left" })),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 2, default: 1 })),
		},
		closed,
	),
	Type.Object(
		{
			op: Type.Literal("scroll"),
			point,
			deltaX: delta,
			deltaY: delta,
			unit: Type.Optional(Type.Union([Type.Literal("line"), Type.Literal("pixel")], { default: "line" })),
		},
		closed,
	),
	Type.Object(
		{
			op: Type.Literal("drag"),
			from: point,
			to: point,
			durationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 200 })),
		},
		closed,
	),
	Type.Object(
		{
			op: Type.Literal("window"),
			action: Type.Union([
				Type.Literal("activate"),
				Type.Literal("minimize"),
				Type.Literal("restore"),
				Type.Literal("close"),
			]),
		},
		closed,
	),
	Type.Object({ op: Type.Literal("window"), action: Type.Literal("set_bounds"), ...bounds }, closed),
]);

/** Model contract only. Native execution owns the trusted timeout and recovery limits. */
export const ComputerSegmentInputSchema = Type.Object(
	{
		request: Type.Object(
			{
				op: Type.Literal("segment"),
				previousEffect: Type.Optional(Type.Literal("observed")),
				ref: reference,
				actions: Type.Array(action, { minItems: 1, maxItems: 64 }),
				expected: Type.Union([
					Type.Object({ kind: Type.Literal("value"), target, value: text }, closed),
					Type.Object({ kind: Type.Literal("present"), selector, present: Type.Boolean() }, closed),
					Type.Object({ kind: Type.Literal("window_focused") }, closed),
					Type.Object({ kind: Type.Literal("window_bounds"), ...bounds }, closed),
					ComputerVisualExpectationSchema,
				]),
			},
			closed,
		),
	},
	closed,
);
export type ComputerSegmentInput = Static<typeof ComputerSegmentInputSchema>;

function checkBytes(value: string, maximum: number): number {
	const bytes = Buffer.byteLength(value, "utf8");
	// Rust strings are UTF-8. Reject lone UTF-16 surrogates rather than allowing
	// the FFI encoder to silently replace requested text or target identifiers.
	if (/[\uD800-\uDFFF]/u.test(value) || bytes > maximum) throw new Error("Invalid computer segment");
	return bytes;
}

function checkSelector(value: Static<typeof selector>): void {
	if (value.role !== undefined) checkBytes(value.role, 64);
	if (value.label !== undefined) checkBytes(value.label, 256);
	if (value.identifier !== undefined) checkBytes(value.identifier, 256);
	if (value.within !== undefined) checkBytes(value.within, 128);
}

function checkTarget(value: Static<typeof target>): void {
	if ("ref" in value) checkBytes(value.ref, 128);
	else checkSelector(value.selector);
}

/** Static pairing does not replace native cancellation and release obligations. Never echo input in errors. */
export function parseComputerSegmentInput(input: unknown): ComputerSegmentInput {
	if (!Value.Check(ComputerSegmentInputSchema, input)) throw new Error("Invalid computer segment");
	const { request } = input;
	checkBytes(request.ref, 128);
	const keys = new Set<string>();
	const buttons = new Set<string>();
	let textBytes = 0;
	let scheduledMs = 0;
	for (const step of request.actions) {
		if ("target" in step) checkTarget(step.target);
		if ("text" in step) textBytes += checkBytes(step.text, 16 * 1024);
		if ("point" in step) checkBytes(step.point.ref, 128);
		switch (step.op) {
			case "key_down": {
				const name = step.key.toLowerCase();
				if (keys.has(name)) throw new Error("Invalid computer segment");
				keys.add(name);
				break;
			}
			case "key_up":
				if (!keys.delete(step.key.toLowerCase())) throw new Error("Invalid computer segment");
				break;
			case "key":
				if (keys.has(step.key.toLowerCase())) throw new Error("Invalid computer segment");
				break;
			case "button_down":
				if (buttons.has(step.button)) throw new Error("Invalid computer segment");
				buttons.add(step.button);
				break;
			case "button_up":
				if (!buttons.delete(step.button)) throw new Error("Invalid computer segment");
				break;
			case "click":
				if (buttons.has(step.button ?? "left")) throw new Error("Invalid computer segment");
				break;
			case "scroll":
				if (step.deltaX === 0 && step.deltaY === 0) throw new Error("Invalid computer segment");
				break;
			case "drag":
				checkBytes(step.from.ref, 128);
				checkBytes(step.to.ref, 128);
				if (buttons.size > 0) throw new Error("Invalid computer segment");
				scheduledMs += step.durationMs ?? 200;
				break;
			case "window":
				if (keys.size > 0 || buttons.size > 0) throw new Error("Invalid computer segment");
				break;
		}
	}
	const expected = request.expected;
	if (expected.kind === "value") {
		checkTarget(expected.target);
		textBytes += checkBytes(expected.value, 16 * 1024);
	} else if (expected.kind === "present") checkSelector(expected.selector);
	else if (expected.kind === "visual") checkBytes(expected.description, 1024);
	if (keys.size > 0 || buttons.size > 0 || textBytes > 16 * 1024 || scheduledMs > 30_000)
		throw new Error("Invalid computer segment");
	return structuredClone(input);
}
