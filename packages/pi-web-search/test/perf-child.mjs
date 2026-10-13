import assert from "node:assert/strict";
import { test } from "node:test";
import { ADVANCE_PAGE, LIGHT_SAMPLE_PAGE, SAMPLE_PAGE } from "../src/page-scan.ts";
import { setupBrowserFixtures } from "./browser-harness.mjs";
import { fixturePage as perfPage } from "./perf-fixtures.mjs";
import { fixturePage as samplingPage } from "./sampling-fixtures.mjs";

// WF07 real-browser evidence: M01 (an unchanged page is polled without rebuilding its
// text) and the M02 negative cases (late text, reflow, hash route, live counter).
// Run through the isolated wrapper: node test/full-page.mjs --child=perf-child.mjs
const fixturePage = (path) => perfPage(path) ?? samplingPage(path);
const { readPage } = await setupBrowserFixtures({ fixturePage, hosts: ["perf.public.org"] });
const read = (path) => readPage(`http://perf.public.org${path}`);

const occurrences = (text, value) => {
	const found = [];
	for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) found.push(at);
	return found;
};
const assertOnce = (text, value) => {
	const found = occurrences(text, value);
	assert.equal(found.length, 1, `${value}: expected exactly one occurrence, got ${found.length} in ${JSON.stringify(text)}`);
};
const assertOrdered = (text, first, second) => {
	const at = text.indexOf(first);
	const later = text.indexOf(second);
	assert.ok(at >= 0 && later > at, `${first} must appear before ${second} in ${JSON.stringify(text)}`);
};
/** Raw counters for the delivery report; the assertions below stay the acceptance gate. */
const report = (label, page) => {
	console.log(
		`${label}: samples=${page.metrics.samples} serializations=${page.metrics.serializations} cdpBytesIn=${page.metrics.cdpBytesIn} cdpBytesOut=${page.metrics.cdpBytesOut} textBytes=${Buffer.byteLength(page.text, "utf8")} elapsedMs=${Math.round(page.metrics.elapsedMs)} complete=${page.scanComplete} reasons=${page.incompleteReasons.join("|")}`,
	);
};

test("the isolated-world collector sources parse as browser JavaScript", () => {
	for (const [name, source] of [
		["SAMPLE_PAGE", SAMPLE_PAGE],
		["LIGHT_SAMPLE_PAGE", LIGHT_SAMPLE_PAGE],
		["ADVANCE_PAGE", ADVANCE_PAGE],
	]) {
		assert.doesNotThrow(() => new Function(source), `${name} must be valid browser JavaScript`);
	}
	assert.ok(LIGHT_SAMPLE_PAGE.length < 100, "the unchanged-poll expression must stay small on the wire");
});

test("M01: an unchanged static page is polled repeatedly without rebuilding its whole text", async () => {
	const page = await read("/m01-static");
	const { samples, serializations, cdpBytesIn } = page.metrics;
	const textBytes = Buffer.byteLength(page.text, "utf8");
	report("M01 /m01-static", page);
	assert.equal(page.scanComplete, true, `a static page must settle: ${page.incompleteReasons.join(",")}`);
	assert.ok(page.text.includes("M01_STATIC_START") && page.text.includes("M01_STATIC_END"));
	assert.ok(samples >= 8, `the unchanged page must be polled repeatedly, saw ${samples} samples`);
	assert.ok(serializations >= 1, "the first sample must rebuild the text once");
	assert.ok(
		serializations <= 3,
		`the full text must not be rebuilt per poll: ${serializations} serializations for ${samples} samples`,
	);
	assert.ok(serializations * 4 <= samples, `${samples} samples produced ${serializations} serializations`);
	// Sending the text on every sample would cost at least samples x textBytes; the light
	// answers must keep the read well below a quarter of that per-poll cost.
	assert.ok(
		cdpBytesIn * 4 < samples * textBytes,
		`cdpBytesIn ${cdpBytesIn} must stay under a quarter of the per-poll full-text cost ${samples * textBytes} (text ${textBytes} bytes)`,
	);
});

test("M01: an imported /c02 static fixture shows the same counter ratio", async () => {
	const page = await read("/c02");
	const { samples, serializations } = page.metrics;
	report("M01 /c02", page);
	assert.equal(page.scanComplete, true, `a static fixture must settle: ${page.incompleteReasons.join(",")}`);
	assert.equal(occurrences(page.text, "REPEAT_ME").length, 2, `captured text: ${page.text}`);
	assert.ok(samples >= 8, `saw ${samples} samples`);
	assert.ok(serializations <= 3, `saw ${serializations} serializations for ${samples} samples`);
	assert.ok(serializations * 4 <= samples, `${samples} samples produced ${serializations} serializations`);
});

test("M02a: text appended after a sample was taken is captured, not presented as a complete capture without it", async () => {
	const page = await read("/m02-late");
	report("M02a /m02-late", page);
	assert.ok(page.text.includes("M02_LATE_TRIGGER_FIRED"), `the fixture trigger must have run: ${page.text}`);
	assertOnce(page.text, "M02_LATE_START");
	assertOnce(page.text, "M02_LATE_TAIL");
	const captured = page.text.includes("M02_LATE_ONE") && page.text.includes("M02_LATE_TWO");
	if (captured) assertOrdered(page.text, "M02_LATE_ONE", "M02_LATE_TWO");
	assert.ok(
		captured || page.scanComplete === false,
		`late text must be captured or the scan marked incomplete: ${JSON.stringify(page.text)}`,
	);
	assert.equal(page.incompleteReasons.includes("timeout"), false, `no timeout for a late append: ${page.incompleteReasons}`);
	assert.ok(page.metrics.elapsedMs < 60_000, `the read must not chase the appending page: ${page.metrics.elapsedMs}ms`);
});

test("M02b: a font reflow that moves existing text neither duplicates nor drops it", async () => {
	const page = await read("/m02-reflow");
	report("M02b /m02-reflow", page);
	assert.ok(page.text.includes("M02_REFLOW_APPLIED"), `the fixture reflow must have run during the scan: ${page.text}`);
	for (const value of ["M02_REFLOW_START", "REFLOW_ALPHA", "REFLOW_BETA", "REFLOW_GAMMA", "M02_REFLOW_TAIL"])
		assertOnce(page.text, value);
	assertOrdered(page.text, "REFLOW_ALPHA", "REFLOW_BETA");
	assertOrdered(page.text, "REFLOW_BETA", "REFLOW_GAMMA");
	assert.equal(page.scanComplete, true, `a one-shot reflow must settle: ${page.incompleteReasons.join(",")}`);
});

test("M02c: a same-document hash route change replaces the previous route instead of mixing both", async () => {
	const page = await read("/m02-hash");
	report("M02c /m02-hash", page);
	assert.ok(page.url.endsWith("#m02-route-2"), `the final URL must be the routed one: ${page.url}`);
	assert.ok(page.text.includes("M02_HASH_ROUTED"), `the fixture route change must have run: ${page.text}`);
	assert.ok(page.text.includes("M02_ROUTE2_TEXT"), `the routed content must be captured: ${page.text}`);
	assert.equal(
		page.text.includes("M02_ROUTE1_TEXT"),
		false,
		`the replaced route must not stay in the capture: ${JSON.stringify(page.text)}`,
	);
	assertOnce(page.text, "M02_HASH_TAIL");
	assert.ok(
		page.scanComplete || page.incompleteReasons.length > 0,
		"the routed document must be reported as complete or explicitly incomplete",
	);
});

test("M02d: a continuously updating counter ends within the 90s policy and is never a false complete", async () => {
	const page = await read("/m02-counter");
	report("M02d /m02-counter", page);
	assert.ok(page.text.includes("M02_COUNTER_START"), `partial content must still be returned: ${page.text}`);
	assert.match(page.text, /M02_COUNT \d+/, "the counter element must be captured");
	assert.equal(page.scanComplete, false, "a page that keeps changing must not be reported as a complete capture");
	assert.ok(
		page.incompleteReasons.some((reason) => reason === "timeout" || reason === "content_changed_during_scan"),
		`the changing page must be marked incomplete: ${page.incompleteReasons.join(",")}`,
	);
	assert.ok(
		page.metrics.elapsedMs <= 92_000,
		`the read must end within the existing 90s policy: ${page.metrics.elapsedMs}ms`,
	);
});
