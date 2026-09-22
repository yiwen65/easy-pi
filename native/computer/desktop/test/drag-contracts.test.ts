import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ComputerImage } from "@trycua/cua-driver";
import { parseDesktopInput } from "../contracts.ts";
import { type ComputerDragInput, dragSegment } from "../drag-contracts.ts";
import { projectImagePair } from "../projection.ts";
import { validateDragEvidence, validateSegmentEvidence } from "../segment-evidence.ts";
import { segmentCode } from "../segment-projection.ts";
import { DesktopView } from "../view.ts";

function request(): ComputerDragInput["request"] {
	return {
		op: "drag_between",
		from: { ref: "source", x: 1, y: 2 },
		to: { ref: "destination", x: 3, y: 4 },
		expected: { kind: "visual", description: "Exactly one payload arrived" },
	};
}
function image(ref: string, windowId: bigint, width: number, height: number): ComputerImage {
	const png = new ArrayBuffer(33);
	const b = Buffer.from(png);
	b.set([137, 80, 78, 71, 13, 10, 26, 10]);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12);
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return {
		imageId: ref,
		pid: 1,
		windowId,
		png,
		geometry: {
			desktopX: 0,
			desktopY: 0,
			windowWidth: width,
			windowHeight: height,
			sourceWidth: width,
			sourceHeight: height,
			cropX: 0,
			cropY: 0,
			cropWidth: width,
			cropHeight: height,
			outputWidth: width,
			outputHeight: height,
		},
	};
}
function pair() {
	return projectImagePair(image("source", 1n, 2, 3), image("destination", 2n, 4, 5));
}

test("dedicated drag contract is closed, UTF-8 bounded, visual-only and normalizes the existing codec", () => {
	assert.deepEqual(parseDesktopInput({ request: request() }), { request: request() });
	const segment = dragSegment(request());
	assert.equal(segment.ref, "source");
	assert.deepEqual(segment.actions, [{ op: "drag", from: request().from, to: request().to, durationMs: 200 }]);
	for (const invalid of [
		{ intentRef: "forged" },
		{ maxDurationMs: 500 },
		{ route: "background" },
		{ durationMs: 0 },
		{ durationMs: 5001 },
		{ previousEffect: "confirmed" },
		{ expected: { kind: "window_focused" } },
		{ expected: { kind: "visual", description: "中".repeat(400) } },
		{ expected: { kind: "visual", description: "\ud800" } },
		{ from: { ref: "中".repeat(50), x: 0, y: 0 } },
		{ from: { ref: "source", x: Number.NaN, y: 0 } },
		{ from: { ref: "source", x: 2048, y: 0 } },
		{ to: { ref: "source", x: 0, y: 0 } },
	])
		assert.throws(() => parseDesktopInput({ request: { ...request(), ...invalid } }));
	for (const op of ["select_destination", "capture_pair"] as const) {
		const input = op === "select_destination" ? { op, ref: "catalog" } : { op, maxDimension: 512 };
		assert.deepEqual(parseDesktopInput({ request: input }), { request: input });
		assert.throws(() => parseDesktopInput({ request: { ...input, slot: "arbitrary" } }));
	}
});

test("pair projection has two ordered images, no duplicated bytes and distinct window authority", () => {
	const output = pair();
	assert.equal(output.content.filter((part) => part.type === "image").length, 2);
	assert.equal(output.grant.source.targetKey, "1:1");
	assert.equal(output.grant.destination.targetKey, "1:2");
	assert.doesNotMatch(JSON.stringify([output.grant, output.details]), /png|base64|data/);
	assert.throws(() => projectImagePair(image("a", 1n, 2, 3), image("b", 1n, 2, 3)), /Distinct/);
	assert.throws(() => projectImagePair(image("a", 1n, 2, 3), image("a", 2n, 2, 3)), /Distinct/);
});

test("each drag endpoint needs its own ordered current image and bounds; pair cannot authorize ordinary segments", () => {
	const grant = pair().grant;
	validateDragEvidence(request(), grant);
	for (const invalid of [
		{ ...request(), from: request().to, to: request().from },
		{ ...request(), from: { ref: "source", x: 2, y: 0 } },
		{ ...request(), to: { ref: "destination", x: 0, y: 5 } },
	])
		assert.throws(() => validateDragEvidence(invalid, grant), /stale_image_pair|bounds/);
	assert.throws(() => validateDragEvidence(request(), grant.source), /stale_image_pair/);
	assert.throws(() => validateSegmentEvidence(dragSegment(request()), grant), /stale_observation/);
});

test("filtering either image, changing ordering or compacting permanently invalidates the whole pair", () => {
	const output = pair();
	const message: ToolResultMessage = {
		role: "toolResult",
		toolName: "computer",
		toolCallId: "pair",
		isError: false,
		content: output.content,
		timestamp: 1,
	};
	for (const mode of ["source", "destination", "reorder", "compact", "disabled", "duplicate"] as const) {
		const view = new DesktopView<typeof output.grant>();
		view.publish("pair", output.content, output.grant);
		view.observeContext(true, [message]);
		const changed = structuredClone(message);
		if (mode === "source" || mode === "destination") changed.content.splice(mode === "source" ? 2 : 5, 1);
		if (mode === "reorder") changed.content.reverse();
		view.observeContext(
			mode !== "disabled",
			mode === "compact" ? [] : mode === "duplicate" ? [message, message] : [changed],
		);
		view.observeContext(true, [message]);
		assert.equal(view.consume(), undefined, mode);
	}
	const view = new DesktopView<typeof output.grant>();
	view.publish("pair", output.content, output.grant);
	view.observeContext(true, [message]);
	assert.deepEqual(view.consume(), output.grant);
	assert.equal(view.consume(), undefined);
});

test("cross-window static refusal and preparation codes survive without arbitrary native/UI text", () => {
	for (const code of [
		"drag_foreground_prepared",
		"drag_target_occluded",
		"pointer_hit_unknown",
		"input_monitoring_permission_denied",
		"foreground_input_conflict",
		"input_observer_unavailable",
	])
		assert.equal(segmentCode(code), code);
	assert.equal(segmentCode("PRIVATE app text"), "native_fault");
});
