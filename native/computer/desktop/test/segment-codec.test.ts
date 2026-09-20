import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import type * as CuaSdk from "@trycua/cua-driver";
import { encodeComputerSegment } from "../segment-codec.ts";
import { parseComputerSegmentInput } from "../segment-contracts.ts";

const sdkDirectory = process.env.CUA_DRIVER_TYPESCRIPT_DIR;
const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true" && sdkDirectory !== undefined;
function sdk(): typeof CuaSdk {
	assert(sdkDirectory && isAbsolute(sdkDirectory), "Explicit absolute SDK directory required");
	return createRequire(import.meta.url)(join(sdkDirectory, "dist/computer.js")) as typeof CuaSdk;
}
const point = { ref: "image-one", x: 1.25, y: 30.5 };
const target = { selector: { role: "AXTextField", label: "Name", identifier: "name", within: "form" } };
const request = (actions: unknown[], expected: unknown = { kind: "visual", description: "Expected result" }) =>
	parseComputerSegmentInput({ request: { op: "segment", ref: "observation-one", actions, expected } }).request;

test(
	"genuine segment codecs and native validator accept all action variants without creating a host",
	{ skip: !enabled },
	() => {
		const api = sdk();
		const text = "你好🦀e\u0301\n</tool_call>";
		const parsed = request([
			{ op: "focus", target },
			{ op: "fill", target: { ref: "field" }, text },
			{ op: "type_text", text },
			{ op: "key", key: "a", modifiers: ["command", "control", "option", "shift", "fn"] },
			{ op: "key_down", key: "Shift" },
			{ op: "pointer_move", point },
			{ op: "key_up", key: "shift" },
			{ op: "button_down", button: "middle" },
			{ op: "pointer_move", point },
			{ op: "button_up", button: "middle" },
			{ op: "click", point },
			{ op: "click", point, button: "right", count: 2 },
			{ op: "scroll", point, deltaX: 0, deltaY: -2 },
			{ op: "scroll", point, deltaX: 12.5, deltaY: 0, unit: "pixel" },
			{ op: "drag", from: point, to: { ...point, ref: "image-two" } },
			...["activate", "minimize", "restore", "close"].map((action) => ({ op: "window", action })),
			{ op: "window", action: "set_bounds", x: -100, y: 40, width: 700, height: 500 },
		]);
		const encoded = encodeComputerSegment(api, parsed);
		assert.equal(encoded.actions.length, 20);
		assert.equal(encoded.observationRef, parsed.ref);
		assert.equal(encoded.maxDurationMs, 30_000);
		assert.doesNotThrow(() => api.validateComputerSegment(encoded));
		const fill = encoded.actions[1];
		assert(api.ComputerInput.Fill.instanceOf(fill));
		assert.equal(fill.inner.text, text);
		const click = encoded.actions[10];
		assert(api.ComputerInput.Click.instanceOf(click));
		assert.equal(click.inner.button, api.ComputerMouseButton.Left);
		assert.equal(click.inner.count, 1);
		const drag = encoded.actions[14];
		assert(api.ComputerInput.Drag.instanceOf(drag));
		assert.equal(drag.inner.durationMs, 200);
		assert.equal(drag.inner.to.imageRef, "image-two");
	},
);

test("genuine segment postcondition codecs preserve explicit expected state", { skip: !enabled }, () => {
	const api = sdk();
	for (const expected of [
		{ kind: "value", target, value: "保存" },
		{ kind: "present", selector: { identifier: "saved" }, present: false },
		{ kind: "window_focused" },
		{ kind: "window_bounds", x: -40, y: 20, width: 500, height: 400 },
		{ kind: "visual", description: "A visible success notification" },
	]) {
		const encoded = encodeComputerSegment(api, request([{ op: "type_text", text: "x" }], expected));
		assert.doesNotThrow(() => api.validateComputerSegment(encoded));
	}
});

test(
	"native validation rejects direct-SDK invalid data even when the model parser is bypassed",
	{ skip: !enabled },
	() => {
		const api = sdk();
		const valid = encodeComputerSegment(api, request([{ op: "type_text", text: "x" }]));
		for (const invalid of [
			{ ...valid, maxDurationMs: 30_001 },
			{ ...valid, actions: [] },
			{ ...valid, actions: [new api.ComputerInput.KeyDown({ key: "Shift" })] },
			{ ...valid, actions: [new api.ComputerInput.TypeText({ text: "界".repeat(6000) })] },
			{
				...valid,
				actions: [
					new api.ComputerInput.PointerMove({
						point: api.ComputerPoint.create({ imageRef: "image", x: NaN, y: 1 }),
					}),
				],
			},
		]) {
			assert.throws(
				() => api.validateComputerSegment(invalid),
				(error: unknown) => api.ComputerError.Refused.instanceOf(error),
			);
		}
	},
);
