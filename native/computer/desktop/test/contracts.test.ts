import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDesktopInput } from "../contracts.ts";

test("closed desktop requests accept bounded discovery, capture and image input", () => {
	for (const request of [
		{ op: "discover" },
		{ op: "select", ref: "opaque" },
		{ op: "capture", maxDimension: 1024 },
		{ op: "click", ref: "image", x: 0.5, y: 100 },
		{ op: "scroll", ref: "image", x: 0, y: 0, direction: "down" },
		{ op: "key", ref: "image", key: "Tab" },
		{ op: "observe" },
	]) {
		const input = { request };
		assert.deepEqual(parseDesktopInput(input), input);
		assert.notEqual(parseDesktopInput(input), input);
	}
});

test("arbitrary targets, scripts, chords, repeats and oversized values are rejected", () => {
	for (const request of [
		{ op: "discover", pid: 123 },
		{ op: "select", ref: "x", windowId: 1 },
		{ op: "capture", maxDimension: 2049 },
		{ op: "capture", maxDimension: 1.5 },
		{ op: "capture", maxDimension: 100, crop: [0, 0, 1, 1] },
		{ op: "click", ref: "x", x: NaN, y: 0 },
		{ op: "click", ref: "x", x: Infinity, y: 0 },
		{ op: "click", ref: "x", x: -1, y: 0 },
		{ op: "click", ref: "x", x: 0, y: 2049 },
		{ op: "scroll", ref: "x", x: 0, y: 0, direction: "down", count: 10 },
		{ op: "key", ref: "x", key: "Command+Q" },
		{ op: "key", ref: "x", key: "Tab", repeat: 2 },
		{ op: "select", ref: "界".repeat(128) },
		{ op: "script", code: "secret-value" },
	])
		assert.throws(() => parseDesktopInput({ request }), /^Error: Invalid computer (request|reference|coordinates)$/);
	assert.throws(() => parseDesktopInput({ request: { op: "discover" }, extra: true }));
});

test("semantic plans retain their existing aggregate UTF-8 budget", () => {
	const step = { op: "fill", target: { ref: "field" }, text: "x".repeat(9000) };
	assert.throws(
		() => parseDesktopInput({ request: { op: "execute", ref: "snapshot", steps: [step, step] } }),
		/16 KiB/,
	);
	assert.doesNotThrow(() => parseDesktopInput({ request: { op: "execute", ref: "snapshot", steps: [step] } }));
});
