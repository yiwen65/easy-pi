import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import type { ComputerDiscoveredWindow, ComputerImage } from "@trycua/cua-driver";
import { projectImage, projectWindows } from "../projection.ts";

function image(): ComputerImage {
	const bytes = new ArrayBuffer(33);
	const buffer = Buffer.from(bytes);
	buffer.set([137, 80, 78, 71, 13, 10, 26, 10]);
	buffer.writeUInt32BE(13, 8);
	buffer.write("IHDR", 12);
	buffer.writeUInt32BE(2, 16);
	buffer.writeUInt32BE(3, 20);
	return {
		imageId: "opaque",
		pid: 1,
		windowId: 1n,
		png: bytes,
		geometry: {
			desktopX: -100,
			desktopY: 20,
			windowWidth: 2,
			windowHeight: 3,
			sourceWidth: 2,
			sourceHeight: 3,
			cropX: 0,
			cropY: 0,
			cropWidth: 2,
			cropHeight: 3,
			outputWidth: 2,
			outputHeight: 3,
		},
	};
}

test("image projection has one flat encoded image and no duplicate bytes in details or grant", () => {
	const input = image();
	const output = projectImage(input);
	assert.deepEqual(output.content[1], {
		type: "image",
		mimeType: "image/png",
		data: Buffer.from(input.png).toString("base64"),
	});
	assert.deepEqual(output.details, { status: "captured", imageRef: "opaque", width: 2, height: 3 });
	assert.deepEqual(output.grant, { kind: "image", ref: "opaque", targetKey: "1:1", width: 2, height: 3 });
});

test("malformed headers and out-of-budget dimensions or carriers are rejected", () => {
	for (const mutate of [
		(value: ComputerImage) => {
			value.geometry.outputWidth = 2049;
		},
		(value: ComputerImage) => {
			value.geometry.outputHeight = 0;
		},
		(value: ComputerImage) => {
			value.geometry.outputWidth = 3;
		},
		(value: ComputerImage) => {
			value.png = new ArrayBuffer(32);
		},
		(value: ComputerImage) => {
			new Uint8Array(value.png)[0] = 0;
		},
		(value: ComputerImage) => {
			value.imageId = "";
		},
	]) {
		const value = image();
		mutate(value);
		assert.throws(() => projectImage(value), /Invalid native/);
	}
});

test("only window references whose full row is displayed receive grants", () => {
	const windows: ComputerDiscoveredWindow[] = Array.from({ length: 10 }, (_, i) => ({
		reference: `window-${i}`,
		appName: "fixture",
		title: "x".repeat(2048),
		bounds: { x: 0, y: 0, width: 100, height: 100 },
		isOnScreen: true,
	}));
	const output = projectWindows(windows, 2);
	assert.ok(output.grant.refs.size > 0 && output.grant.refs.size < windows.length);
	assert.equal(output.details.omittedWindows, 12 - output.grant.refs.size);
	for (const window of windows)
		assert.equal(output.content[0]?.text.includes(window.reference), output.grant.refs.has(window.reference));
	assert.throws(() => projectWindows(windows, -1));
	assert.throws(() => projectWindows([windows[0]!, windows[0]!], 0));
});
