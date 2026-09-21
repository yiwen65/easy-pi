import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopInput } from "../contracts.ts";
import { projectWindows } from "../projection.ts";

const window = (reference: string, title: string, appName = "Finder") => ({
	reference,
	title,
	appName,
	bounds: { x: 1, y: 2, width: 600, height: 400 },
	isOnScreen: true,
});

test("discovery title/app filters stay closed and byte bounded", () => {
	assert.deepEqual(parseDesktopInput({ request: { op: "discover", app: "Finder", title: "工作" } }), {
		request: { op: "discover", app: "Finder", title: "工作" },
	});
	for (const query of ["", "x".repeat(257), "界".repeat(100), "\ud800"]) {
		assert.throws(() => parseDesktopInput({ request: { op: "discover", title: query } }));
	}
	assert.throws(() => parseDesktopInput({ request: { op: "discover", script: "unused" } }));
});

test("filter before the output byte budget so later known windows remain discoverable", () => {
	const rows = Array.from({ length: 80 }, (_, i) => window(`old-${i}`, `${i}-${"padding".repeat(24)}`));
	rows.push(window("target", `needle-view${"x".repeat(240)}`));
	assert.equal(projectWindows(rows, 3).grant.refs.has("target"), false);
	const filtered = projectWindows(rows, 3, { app: "FINDER", title: "NEEDLE" });
	assert.deepEqual([...filtered.grant.refs], ["target"]);
	assert.equal(filtered.details.omittedWindows, 3, "native omissions are still unknown, not filtered away");
	assert.equal(filtered.details.filteredOut, 80);
	assert.ok(!JSON.stringify(filtered.content).includes("padding"));
});

test("filters are literal conjunctions, never regex or authority to select hidden refs", () => {
	const rows = [window("a", "[.*]"), window("b", "[.*]", "Other"), window("c", "ordinary")];
	assert.deepEqual([...projectWindows(rows, 0, { app: "find", title: "[.*]" }).grant.refs], ["a"]);
	assert.equal(projectWindows(rows, 5, { title: "missing" }).grant.refs.size, 0);
	assert.equal(projectWindows(rows, 5, { title: "missing" }).details.omittedWindows, 5);
});
