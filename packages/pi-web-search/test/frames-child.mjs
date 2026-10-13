import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setupBrowserFixtures } from "./browser-harness.mjs";
import { fixturePage } from "./frames-fixtures.mjs";

const { readPage, stats } = await setupBrowserFixtures({
	fixturePage,
	hosts: ["page.public.org", "frame.public.net", "leaf.public.edu"],
});
after(() => assert.ok(stats.publicAttempts > 0));
const read = (path) => readPage(`http://page.public.org${path}`);

function framesOf(page) {
	assert.ok(
		Array.isArray(page.frames),
		"ScanResult.frames (frozen contract in TASK_STATUS 0.2.9) must list per-frame status",
	);
	return page.frames;
}
function entryFor(page, needle) {
	return framesOf(page).find((entry) => String(entry?.url ?? "").includes(needle));
}
function requireEntry(page, needle) {
	const entry = entryFor(page, needle);
	assert.ok(entry, `frames must contain an entry for ${needle}; got ${JSON.stringify(framesOf(page))}`);
	return entry;
}

test("F01: a frame that exhausts its own budget does not stop sibling frames or the main tail", async () => {
	const page = await read("/f01-main");
	for (const value of [
		"F01_MAIN_START",
		"SIBLING_ALPHA",
		"SIBLING_BETA",
		"MAIN_TAIL_ONE",
		"MAIN_TAIL_TWO",
		"MAIN_TAIL_THREE",
		"F01_MAIN_END",
	])
		assert.ok(page.text.includes(value), `captured text must include ${value}`);
	assert.ok(page.text.indexOf("SIBLING_ALPHA") < page.text.indexOf("SIBLING_BETA"), "sibling order");
	assert.equal(page.scanComplete, false, "an unreadable frame is a coverage gap, not a complete capture");
	assert.ok(
		page.incompleteReasons.includes("frame_incomplete"),
		`aggregate reasons must mark the frame coverage gap: ${JSON.stringify(page.incompleteReasons)}`,
	);
	const runaway = requireEntry(page, "/f01-runaway");
	assert.equal(runaway.status, "incomplete");
	assert.ok(
		runaway.reasons.some((reason) => /^frame_/.test(reason)),
		`a frame-local budget must use a frame-prefixed reason: ${JSON.stringify(runaway.reasons)}`,
	);
	assert.equal(requireEntry(page, "/f01-sibling").status, "complete");
});

test("F02: a completed frame whose DOM changes later is rechecked instead of frozen", async () => {
	const page = await read("/f02-main");
	assert.ok(page.text.includes("FRAME_EARLY_TEXT"), "the frame's first render is captured");
	assert.ok(
		page.text.includes("F02_TRIGGER_FIRED"),
		"fixture evidence: the page really mutated the already-read frame",
	);
	assert.ok(
		page.text.includes("FRAME_LATE_UPDATE"),
		"a bounded final recheck must pick up a later DOM update in an already-read frame",
	);
	assert.equal(page.text.includes("FRAME_PRE_UPDATE"), false, "a superseded value must not be presented as final");
	const entry = requireEntry(page, "/f02-child");
	if (page.scanComplete) assert.equal(entry.status, "complete");
	else assert.notEqual(entry.status, "complete", "an unsettled frame must not be reported as complete");
});

test("F03: a removed frame is invalidated and its replacement is read", async () => {
	const page = await read("/f03-main");
	assert.ok(page.text.includes("F03_TRIGGER_FIRED"), "fixture evidence: the page really removed iframe A");
	assert.ok(page.text.includes("FRAME_B_TEXT"), "the replacement frame is captured");
	assert.equal(page.text.includes("FRAME_A_TEXT"), false, "the removed frame's sample must be dropped");
	assert.ok(
		framesOf(page).every((entry) => entry.status === "complete" || !String(entry.url).includes("/f03-a")),
		`no complete entry may remain for the removed frame: ${JSON.stringify(framesOf(page))}`,
	);
	assert.equal(requireEntry(page, "/f03-b").status, "complete");
});

test("F04a: a same-URL frame reload replaces its samples instead of mixing generations", async () => {
	const page = await read("/f04-reload-main");
	assert.ok(page.text.includes("F04A_RELOAD_OBSERVED"), "fixture evidence: the frame really reloaded its own URL");
	assert.ok(page.text.includes("GEN2_TEXT"), "the reloaded generation is captured");
	assert.equal(page.text.includes("GEN1_TEXT"), false, "the previous generation must not stay in the result");
	const entry = requireEntry(page, "/f04-reload-frame");
	assert.equal(entry.status, "complete");
	assert.ok(String(entry.url).endsWith("/f04-reload-frame"), `frame URL is the current document: ${entry.url}`);
});

test("F04b: a frame whose current document fails does not keep the previous document's text", async () => {
	const page = await read("/f04-status-main");
	assert.ok(page.text.includes("F04_TRIGGER_FIRED"), "fixture evidence: the page really reloaded the readable frame");
	assert.equal(
		page.text.includes("F04_OK_TEXT"),
		false,
		"the readable document that was replaced by a 403 must not be presented as current content",
	);
	const entry = requireEntry(page, "/f04-status");
	assert.notEqual(entry.status, "complete", `frame status must follow the current document: ${entry.status}`);
	assert.equal(page.scanComplete, false, "an unreadable frame is a coverage gap");
	assert.ok(
		entry.reasons.length > 0 || page.incompleteReasons.includes("frame_http_error"),
		"the frame failure must stay attributable",
	);
});

test("F04c: main navigation after frames were read drops the previous document's frames", async () => {
	const page = await read("/f04-nav-main");
	assert.ok(page.text.includes("F04_TARGET_TEXT"), "the replacement main document is captured");
	assert.equal(page.text.includes("F04_NAV_MAIN_START"), false, "the previous main document must be gone");
	assert.equal(page.text.includes("F04_NAV_FRAME_TEXT"), false, "the previous document's frames must be gone");
	assert.equal(
		framesOf(page).some((entry) => String(entry.url).includes("frame.public.net")),
		false,
		`no stale frame may survive a main-document navigation: ${JSON.stringify(framesOf(page))}`,
	);
	assert.equal(page.scanComplete, true);
});

test("F05: hidden, guard-rejected and late frames are reported separately from a login verdict", async () => {
	const page = await read("/f05-main");
	assert.ok(page.text.includes("F05_TRIGGER_FIRED"), "fixture evidence: the page really inserted the late frame");
	assert.equal(page.text.includes("F05_HIDDEN_TEXT"), false, "a hidden frame is not document content");
	assert.equal(
		page.incompleteReasons.includes("password_form"),
		false,
		"a hidden password input must not become a login verdict",
	);
	const hidden = entryFor(page, "/f05-hidden");
	if (hidden) assert.equal(hidden.status, "skipped");
	const blocked = requireEntry(page, "restricted.public.net");
	assert.ok(
		["failed", "skipped"].includes(blocked.status),
		`a visible frame the guard refused must be reported per frame: ${blocked.status}`,
	);
	assert.ok(
		blocked.reasons.length > 0 || page.incompleteReasons.includes("frame_http_error"),
		"the refused frame's reason must be attributable to that frame",
	);
	assert.equal(page.scanComplete, false, "an unreadable visible frame is a coverage gap");
	assert.ok(page.incompleteReasons.includes("frame_incomplete"));
	const late = entryFor(page, "/f05-late");
	if (page.text.includes("FRAME_LATE_TEXT")) assert.equal(late?.status, "complete");
	else
		assert.ok(late && late.status !== "complete", "a late frame that was not read must be reported as a coverage gap");
});
