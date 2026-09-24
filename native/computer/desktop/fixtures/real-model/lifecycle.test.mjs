import assert from "node:assert/strict";
import test from "node:test";
import { closeNative } from "./lifecycle.mjs";

test("session failure cannot skip host close or be declared clean", async () => {
	let closed = 0;
	const result = await closeNative(
		{
			async shutdown() {
				throw Error("private native detail");
			},
		},
		{
			async close() {
				closed++;
			},
		},
	);
	assert.equal(closed, 1);
	assert.deepEqual(result, { nativeClosed: false, cleanupErrors: ["session_shutdown_unproved"] });
});
test("quarantine and incomplete shutdown stay failed without leaking error payloads", async () => {
	const result = await closeNative(
		{
			async shutdown() {
				return { complete: false };
			},
		},
		{
			async close() {
				throw { code: "desktop_quarantined", message: "private" };
			},
		},
	);
	assert.deepEqual(result, {
		nativeClosed: false,
		cleanupErrors: ["session_shutdown_incomplete", "desktop_quarantined"],
	});
});
test("both successful closures are required", async () => {
	assert.deepEqual(
		await closeNative(
			{
				async shutdown() {
					return { complete: true };
				},
			},
			{ async close() {} },
		),
		{ nativeClosed: true, cleanupErrors: [] },
	);
});
