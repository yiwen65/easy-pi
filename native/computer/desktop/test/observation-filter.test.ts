import assert from "node:assert/strict";
import { test } from "node:test";
import type { WindowStateOutput } from "@trycua/cua-driver";
import { parseDesktopInput } from "../contracts.ts";
import { projectObservation } from "../projection.ts";

function observation(): WindowStateOutput {
	return {
		pid: 1,
		windowId: 1n,
		snapshotId: "snapshot",
		images: [],
		elementsComplete: false,
		truncated: false,
		elements: [
			...Array.from({ length: 100 }, (_, i) => ({
				elementIndex: BigInt(i),
				depth: 0,
				role: "AXStaticText",
				value: "sidebar padding ".repeat(12),
				elementToken: `sidebar-${i}`,
			})),
			{
				elementIndex: 100n,
				depth: 0,
				role: "AXStaticText",
				value: `task.txt ${"x".repeat(512)}`,
				elementToken: "file",
			},
		],
	};
}

test("observe text filter is closed, literal and UTF-8 byte bounded", () => {
	assert.deepEqual(parseDesktopInput({ request: { op: "observe", text: "task.txt" } }), {
		request: { op: "observe", text: "task.txt" },
	});
	for (const text of ["", "中".repeat(86), "\ud800", {}, true])
		assert.throws(() => parseDesktopInput({ request: { op: "observe", text } }));
	assert.throws(() => parseDesktopInput({ request: { op: "observe", text: "task", regex: true } }));
});

test("filter before observation byte budget without claiming native completeness", () => {
	const input = observation();
	assert.equal(projectObservation(input).grant.refs.has("file"), false);
	const output = projectObservation(input, { text: "TASK.TXT" });
	assert.deepEqual([...output.grant.refs], ["file"]);
	assert.equal(output.details.filteredOut, 100);
	assert.equal(output.details.viewTruncated, false);
	assert.equal(output.details.nativeComplete, false);
	assert.equal(output.grant.legacyRefs.size, 0);
	assert.equal(output.grant.selectors.size, 0);
	assert.equal(projectObservation(input, { text: ".*" }).grant.refs.size, 0);
});

test("hidden duplicates still prevent selector uniqueness and identifier filtering grants only visible refs", () => {
	const input = observation();
	input.elementsComplete = true;
	input.elements = ["visible", "hidden"].map((identifier, i) => ({
		elementIndex: BigInt(i),
		depth: 0,
		role: "AXTextField",
		label: "Same label",
		identifier,
		elementToken: identifier,
		inWebContent: false,
	}));
	const output = projectObservation(input, { text: "VISIBLE" });
	assert.deepEqual([...output.grant.refs], ["visible"]);
	assert.equal(output.details.nativeComplete, true);
	assert.equal(output.details.filteredOut, 1);
	assert.equal(output.grant.selectors.size, 0);
});
