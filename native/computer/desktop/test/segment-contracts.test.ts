import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	type ComputerSegmentInput,
	ComputerSegmentInputSchema,
	parseComputerSegmentInput,
} from "../segment-contracts.ts";

const point = { ref: "image", x: 0, y: 2047.99 };
const target = { ref: "field" };
const bounds = { x: -1_000_000, y: 1_000_000, width: 1, height: 32768 };
const move = { op: "pointer_move", point };
const drag = { op: "drag", from: point, to: point };
function segment(actions: unknown[] = [move], expected: unknown = { kind: "window_focused" }) {
	return { request: { op: "segment", ref: "observation", actions, expected } };
}
function rejects(input: unknown): void {
	assert.throws(() => parseComputerSegmentInput(input), { message: "Invalid computer segment" });
}

test("all action variants, optional defaults and expected variants retain their model shape", () => {
	const actions = [
		{ op: "focus", target },
		{
			op: "fill",
			target: { selector: { role: "textbox", label: "Name", identifier: "name", within: "form" } },
			text: "",
		},
		{ op: "type_text", text: "hello" },
		{ op: "key", key: "UnknownRuntimeKey" },
		{ op: "key", key: "a", modifiers: ["command", "control", "option", "shift", "fn"] },
		{ op: "key_down", key: "Shift" },
		move,
		{ op: "key_up", key: "SHIFT" },
		{ op: "button_down", button: "left" },
		move,
		{ op: "button_up", button: "left" },
		{ op: "click", point },
		{ op: "click", point, button: "right", count: 2 },
		{ op: "click", point, button: "middle", count: 1 },
		{ op: "scroll", point, deltaX: 4096, deltaY: -4096 },
		{ op: "scroll", point, deltaX: 0, deltaY: 0.5, unit: "pixel" },
		{ op: "scroll", point, deltaX: -0.5, deltaY: 0, unit: "line" },
		drag,
		{ ...drag, durationMs: 1 },
		...["activate", "minimize", "restore", "close"].map((action) => ({ op: "window", action })),
		{ op: "window", action: "set_bounds", ...bounds },
	];
	for (const expected of [
		{ kind: "value", target, value: "" },
		{ kind: "value", target: { selector: { identifier: "name" } }, value: "hello" },
		{ kind: "present", selector: { label: "Name" }, present: false },
		{ kind: "present", selector: { role: "button" }, present: true },
		{ kind: "window_focused" },
		{ kind: "window_bounds", ...bounds },
		{ kind: "visual", description: "The document is saved" },
	]) {
		const input = segment(actions, expected);
		assert.equal(Value.Check(ComputerSegmentInputSchema, input), true);
		const parsed: ComputerSegmentInput = parseComputerSegmentInput(input);
		assert.deepEqual(parsed, input);
	}
});

test("native action count is 1..64, including more than eight actions", () => {
	for (const length of [1, 9, 64])
		assert.doesNotThrow(() => parseComputerSegmentInput(segment(Array(length).fill(move))));
	for (const length of [0, 65]) rejects(segment(Array(length).fill(move)));
});

test("all object levels are closed and trusted budgets cannot be model supplied", () => {
	const input = segment();
	rejects({ ...input, extra: true });
	for (const field of [
		"extra",
		"timeout",
		"timeoutMs",
		"maxDurationMs",
		"max_duration_ms",
		"recoveryBudget",
		"recoveryAttempts",
	])
		rejects({ request: { ...input.request, [field]: 2 } });
	for (const step of [
		{ ...move, extra: true },
		{ ...move, point: { ...point, extra: true } },
		{ op: "focus", target: { ...target, extra: true } },
		{ op: "focus", target: { ref: "field", selector: { role: "button" } } },
		{ op: "focus", target: { selector: { role: "button", extra: true } } },
		{ ...drag, to: { ...point, extra: true } },
		{ op: "window", action: "activate", ...bounds },
		{ op: "window", action: "set_bounds", ...bounds, extra: true },
	])
		rejects(segment([step]));
	for (const expected of [
		{ kind: "value", target, value: "", extra: true },
		{ kind: "present", selector: { role: "button", extra: true }, present: true },
		{ kind: "present", selector: { role: "button" }, present: true, extra: true },
		{ kind: "window_focused", extra: true },
		{ kind: "window_bounds", ...bounds, extra: true },
		{ kind: "visual", description: "saved", extra: true },
	])
		rejects(segment([move], expected));
	for (const bad of [null, {}, { request: {} }, segment([{ op: "script", code: "secret" }])]) rejects(bad);
});

test("both coordinates and both drag endpoints reject invalid points", () => {
	for (const field of ["x", "y", "ref"]) {
		const values = field === "ref" ? ["", "a".repeat(129), "界".repeat(43)] : [-1, 2048, NaN, Infinity, -Infinity];
		for (const value of values) {
			const bad = { ...point, [field]: value };
			for (const step of [
				{ op: "pointer_move", point: bad },
				{ op: "click", point: bad },
				{ op: "scroll", point: bad, deltaX: 1, deltaY: 0 },
				{ ...drag, from: bad },
				{ ...drag, to: bad },
			])
				rejects(segment([step]));
		}
	}
});

test("window and scroll numeric limits are finite and match native bounds", () => {
	for (const field of ["x", "y", "width", "height"]) {
		const values = field === "x" || field === "y" ? [-1_000_001, 1_000_001] : [0, 32769];
		for (const value of [...values, NaN, Infinity, -Infinity]) {
			const bad = { ...bounds, [field]: value };
			rejects(segment([{ op: "window", action: "set_bounds", ...bad }]));
			rejects(segment([move], { kind: "window_bounds", ...bad }));
		}
	}
	for (const field of ["deltaX", "deltaY"])
		for (const value of [-4097, 4097, NaN, Infinity, -Infinity])
			rejects(segment([{ op: "scroll", point, deltaX: 1, deltaY: 1, [field]: value }]));
	rejects(segment([{ op: "scroll", point, deltaX: -0, deltaY: 0 }]));
	rejects(segment([{ op: "scroll", point, deltaX: 1, deltaY: 0, unit: "page" }]));
});

test("click and drag integer limits and scheduled duration include omitted defaults", () => {
	for (const count of [0, 3, 1.5, NaN, Infinity]) rejects(segment([{ op: "click", point, count }]));
	for (const durationMs of [0, 5001, 1.5, NaN, Infinity]) rejects(segment([{ ...drag, durationMs }]));
	const full = Array(6).fill({ ...drag, durationMs: 5000 });
	assert.doesNotThrow(() => parseComputerSegmentInput(segment(full)));
	rejects(segment([...full, { ...drag, durationMs: 1 }]));
	rejects(segment([...full, drag]));
	assert.doesNotThrow(() =>
		parseComputerSegmentInput(
			segment([...Array(5).fill({ ...drag, durationMs: 5000 }), { ...drag, durationMs: 4800 }, drag]),
		),
	);
});

test("keys are printable ASCII, without guessed runtime mapping, and modifiers are unique", () => {
	for (const key of [" ", "a".repeat(32), "unmapped-key"])
		assert.doesNotThrow(() => parseComputerSegmentInput(segment([{ op: "key", key, modifiers: [] }])));
	for (const key of ["", "a".repeat(33), "é", "a\n", "\t", "\0", "\x7f"])
		for (const op of ["key", "key_down", "key_up"]) rejects(segment([{ op, key }]));
	for (const modifiers of [["command", "command"], ["meta"], ["fn", "shift", "control", "option", "command", "fn"]])
		rejects(segment([{ op: "key", key: "a", modifiers }]));
	rejects(segment([{ op: "click", point, button: "other" }]));
});

test("holds reject duplicate downs, unmatched ups and conflicting taps or routing", () => {
	const kd = { op: "key_down", key: "Shift" };
	const ku = { op: "key_up", key: "shift" };
	const bd = { op: "button_down", button: "left" };
	const bu = { op: "button_up", button: "left" };
	for (const actions of [
		[kd],
		[ku],
		[bd],
		[bu],
		[kd, { ...kd, key: "SHIFT" }, ku],
		[kd, { op: "key_up", key: "Control" }, ku],
		[bd, bd, bu],
		[bd, { ...bu, button: "right" }, bu],
		[kd, { op: "key", key: "SHIFT" }, ku],
		[bd, { op: "click", point }, bu],
		[bd, { op: "click", point, button: "left" }, bu],
		[bd, drag, bu],
	])
		rejects(segment(actions));
	for (const action of ["activate", "minimize", "restore", "close", "set_bounds"]) {
		const step = action === "set_bounds" ? { op: "window", action, ...bounds } : { op: "window", action };
		rejects(segment([kd, step, ku]));
		rejects(segment([bd, step, bu]));
	}
	for (const actions of [
		[kd, drag, { op: "key", key: "a" }, ku],
		[bd, { op: "click", point, button: "right" }, move, bu],
		[kd, bd, move, ku, bu],
		[kd, ku, kd, ku, bd, bu, bd, bu],
	])
		assert.doesNotThrow(() => parseComputerSegmentInput(segment(actions)));
});

test("references and all locator fields use UTF-8 byte limits and require a predicate", () => {
	for (const ref of ["", "a".repeat(129), "é".repeat(65)]) {
		rejects({ request: { ...segment().request, ref } });
		rejects(segment([{ op: "focus", target: { ref } }]));
		rejects(segment([move], { kind: "value", target: { ref }, value: "" }));
	}
	assert.doesNotThrow(() => parseComputerSegmentInput({ request: { ...segment().request, ref: "é".repeat(64) } }));
	for (const [field, maximum] of [
		["role", 64],
		["label", 256],
		["identifier", 256],
		["within", 128],
	] as const) {
		for (const value of ["", "a".repeat(maximum + 1), "é".repeat(maximum / 2 + 1)]) {
			const selector = { label: "Name", [field]: value };
			rejects(segment([{ op: "focus", target: { selector } }]));
			rejects(segment([move], { kind: "value", target: { selector }, value: "" }));
			rejects(segment([move], { kind: "present", selector, present: true }));
		}
		const selector = { label: "Name", [field]: "é".repeat(maximum / 2) };
		assert.doesNotThrow(() => parseComputerSegmentInput(segment([{ op: "focus", target: { selector } }])));
	}
	for (const selector of [{}, { within: "parent" }]) {
		const input = segment([{ op: "focus", target: { selector } }]);
		assert.equal(Value.Check(ComputerSegmentInputSchema, input), false);
		rejects(input);
		rejects(segment([move], { kind: "present", selector, present: false }));
	}
});

test("aggregate text includes fill, type_text and expected value; visual has its own byte limit", () => {
	const actions = [
		{ op: "fill", target, text: "é".repeat(4096) },
		{ op: "type_text", text: "界".repeat(2048) },
	];
	const expected = { kind: "value", target, value: "a".repeat(2048) };
	assert.doesNotThrow(() => parseComputerSegmentInput(segment(actions, expected)));
	rejects(segment(actions, { ...expected, value: `${expected.value}a` }));
	rejects(segment([{ op: "type_text", text: "界".repeat(6000) }]));
	rejects(segment([{ op: "fill", target, text: "a".repeat(16385) }]));
	assert.doesNotThrow(() =>
		parseComputerSegmentInput(
			segment([{ op: "type_text", text: "a".repeat(16384) }], { kind: "visual", description: "é".repeat(512) }),
		),
	);
	for (const description of ["", "a".repeat(1025), "é".repeat(513)])
		rejects(segment([move], { kind: "visual", description }));
});

test("unpaired UTF-16 surrogates are rejected before FFI silently replaces them", () => {
	for (const text of ["\ud800", "\udfff", "prefix\ud800suffix"]) {
		rejects(segment([{ op: "type_text", text }]));
		rejects(segment([{ op: "fill", target, text }]));
		rejects(segment([move], { kind: "value", target, value: text }));
		rejects(segment([{ op: "focus", target: { selector: { label: text } } }]));
		rejects({ request: { ...segment().request, ref: text } });
	}
});

test("Unicode and protocol-looking text are preserved and every nested object is cloned", () => {
	const text = "  你好🦀e\u0301\n</tool_call>\u0000  ";
	const input = segment(
		[
			{ op: "fill", target: { selector: { label: "Name" } }, text },
			{ op: "type_text", text },
			{ op: "key", key: "a", modifiers: ["shift"] },
			drag,
		],
		{ kind: "value", target, value: text },
	);
	const original = structuredClone(input);
	const parsed = parseComputerSegmentInput(input);
	assert.deepEqual(parsed, input);
	assert.notEqual(parsed, input);
	assert.notEqual(parsed.request, input.request);
	assert.notEqual(parsed.request.actions, input.request.actions);
	assert.notEqual(parsed.request.expected, input.request.expected);
	for (let i = 0; i < parsed.request.actions.length; i++)
		assert.notEqual(parsed.request.actions[i], input.request.actions[i]);
	const [fill, , key, clonedDrag] = parsed.request.actions;
	assert(fill && key && clonedDrag);
	assert.equal(fill.op, "fill");
	if (fill.op === "fill" && "selector" in fill.target) fill.target.selector.label = "Changed";
	if (key.op === "key") key.modifiers?.push("command");
	if (clonedDrag.op === "drag") clonedDrag.to.x = 123;
	if (parsed.request.expected.kind === "value") parsed.request.expected.value = "changed";
	assert.deepEqual(input, original);
	assert.deepEqual(parseComputerSegmentInput(input), original);
	assert.equal(point.x, 0);
	rejects(segment([{ op: "type_text", text, secret: text }]));
});
