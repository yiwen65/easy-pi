import assert from "node:assert/strict";
import test from "node:test";
import { encodeComputerSegment } from "../segment-codec.ts";
import { parseComputerSegmentInput } from "../segment-contracts.ts";
import { candidateSdk } from "./sdk.ts";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
const sdk = candidateSdk;
const point = { ref: "image-one", x: 1.25, y: 30.5 };
const target = { selector: { role: "AXTextField", label: "Name", identifier: "name", within: "form" } };
const request = (actions: unknown[], expected: unknown = { kind: "visual", description: "Expected result" }) =>
	parseComputerSegmentInput({ request: { op: "segment", ref: "observation-one", actions, expected } }).request;

test("genuine target click ABI is distinct from image click and refuses composite input", { skip: !enabled }, () => {
	const api = sdk();
	const encoded = encodeComputerSegment(api, request([{ op: "click", target: { ref: "s00000001:2" } }]), "intent");
	const click = encoded.actions[0];
	assert(api.ComputerInput.ClickTarget.instanceOf(click));
	assert.equal(click.inner.reference, "s00000001:2");
	assert.equal(api.ComputerInput.Click.instanceOf(click), false);
	assert.doesNotThrow(() => api.validateComputerSegment(encoded));
	for (const actions of [[click, click], [new api.ComputerInput.ClickTarget({ reference: "" })]]) {
		assert.throws(
			() => api.validateComputerSegment({ ...encoded, actions }),
			(error: unknown) => api.ComputerError.Refused.instanceOf(error),
		);
	}
});

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
		const encoded = encodeComputerSegment(api, parsed, "trusted-test-intent");
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
		const encoded = encodeComputerSegment(
			api,
			request([{ op: "type_text", text: "x" }], expected),
			"trusted-test-intent",
		);
		assert.doesNotThrow(() => api.validateComputerSegment(encoded));
	}
});

test("genuine result codec preserves actual routes without claiming business success", { skip: !enabled }, () => {
	const api = sdk();
	const encoded = encodeComputerSegment(api, request([{ op: "type_text", text: "x" }]), "trusted-test-intent");
	for (const route of [
		api.ActionRoute.Accessibility,
		api.ActionRoute.SyntheticEvents,
		api.ActionRoute.GlobalInput,
		api.ActionRoute.SystemApi,
		api.ActionRoute.Dom,
		api.ActionRoute.TrustedInput,
	]) {
		const result = api.ComputerSegmentResult.create({
			status: api.ComputerSegmentStatus.NeedsObservation,
			actions: [
				api.ComputerInputResult.create({
					index: 0,
					dispatch: api.ComputerDispatch.Dispatched,
					action: {
						effect: api.ActionEffect.Unverifiable,
						route,
						delivery: { mode: api.ActionDeliveryMode.Foreground, deliveredCount: 2 },
					},
				}),
			],
			condition: api.ComputerCondition.Unknown,
			recoveryAttempts: 0,
			remainingDurationMs: 29_990,
			elapsedMs: 10n,
		});
		assert.doesNotThrow(() => api.validateComputerSegmentResult(encoded, result));
		assert.throws(
			() =>
				api.validateComputerSegmentResult(encoded, {
					...result,
					status: api.ComputerSegmentStatus.Confirmed,
					condition: api.ComputerCondition.Satisfied,
				}),
			(error: unknown) => api.ComputerError.Refused.instanceOf(error),
		);
	}
});

test("genuine result codec rejects contradictory delivery, prefix and recovery facts", { skip: !enabled }, () => {
	const api = sdk();
	const encoded = encodeComputerSegment(api, request([{ op: "type_text", text: "x" }]), "trusted-test-intent");
	const row = api.ComputerInputResult.create({
		index: 0,
		dispatch: api.ComputerDispatch.NotDispatched,
	});
	const result = api.ComputerSegmentResult.create({
		status: api.ComputerSegmentStatus.Paused,
		actions: [row],
		condition: api.ComputerCondition.Unknown,
		firstUnfinishedAction: 0,
		recoveryAttempts: 0,
		remainingDurationMs: 30_000,
		elapsedMs: 0n,
	});
	assert.doesNotThrow(() => api.validateComputerSegmentResult(encoded, result));
	for (const invalid of [
		{ ...result, recoveryAttempts: 3 },
		{ ...result, remainingDurationMs: 30_001 },
		{ ...result, firstUnfinishedAction: 1 },
		{ ...result, actions: [{ ...row, index: 1 }] },
		{ ...result, actions: [row, row] },
		{ ...result, status: api.ComputerSegmentStatus.OutcomeUnknown },
		{ ...result, actions: [{ ...row, dispatch: api.ComputerDispatch.Dispatched }] },
		{ ...result, actions: [{ ...row, code: "private input text" }] },
	]) {
		assert.throws(
			() => api.validateComputerSegmentResult(encoded, invalid),
			(error: unknown) => api.ComputerError.Refused.instanceOf(error),
		);
	}
});

test(
	"native validation rejects direct-SDK invalid data even when the model parser is bypassed",
	{ skip: !enabled },
	() => {
		const api = sdk();
		const valid = encodeComputerSegment(api, request([{ op: "type_text", text: "x" }]), "trusted-test-intent");
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
