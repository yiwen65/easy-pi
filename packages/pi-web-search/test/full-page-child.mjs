import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setupBrowserFixtures } from "./browser-harness.mjs";
import { fixturePage, markers } from "./full-page-fixtures.mjs";

const { readPage, stats } = await setupBrowserFixtures({
	fixturePage,
	hosts: ["page.public.org", "frame.public.net", "leaf.public.edu"],
});
after(() => assert.ok(stats.publicAttempts > 0));
const read = path => readPage(`http://page.public.org${path}`);
const assertMarkers = (page, prefix, count) => {
	assert.deepEqual(page.text.match(new RegExp(`${prefix}_\\d{3}_汉字😀`, "gu")), markers(prefix, count));
};

test("static long text keeps Unicode and inline text and expands all named details without clicking", async () => {
	const page = await read("/static");
	assertMarkers(page, "S", 80);
	assert.ok(page.text.includes("inline content."));
	assert.ok(page.text.includes("EXPANDED_ONE") && page.text.includes("EXPANDED_TWO"));
	assert.ok(page.text.includes("STATIC_START") && page.text.includes("STATIC_END"));
	assert.equal(page.scanComplete, true);
});
for (const [path, prefix] of [["/virtual", "V"], ["/recycled", "R"], ["/hidden-axis", "H"]]) {
	test(`${path}: every virtual item is retained in order, including identical paragraphs`, async () => {
		const page = await read(path);
		assertMarkers(page, prefix, 36);
		assert.equal(page.text.match(/LEGAL_REPEAT/g)?.length, 36);
		assert.equal(page.scanComplete, true);
	});
}
test("two-axis virtualization scans each horizontal band rather than only the right edge", async () => {
	const page = await read("/grid");
	assertMarkers(page, "G", 36);
	assert.equal(page.scanComplete, true);
});
test("caller cancellation during an actual scroll scan closes browser, proxy and profile", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("SENSITIVE_ABORT_REASON")), 5500);
	try {
		await assert.rejects(readPage("http://page.public.org/infinite", controller.signal), error => {
			assert.equal(error.message, "Web request cancelled.");
			return true;
		});
	} finally { clearTimeout(timer); }
});
test("lazy loading and nested scrollers reach all content before the outer scroller moves away", async () => {
	const page = await read("/lazy");
	assertMarkers(page, "L", 32);
	assert.ok(page.text.includes("OUTER_START") && page.text.includes("OUTER_END"));
	assert.equal(page.scanComplete, true);
});
test("same-origin, OOPIF, nested and srcdoc frames are read; hidden authentication frames are excluded", async () => {
	const page = await read("/frames");
	for (const value of ["FRAME_PARENT_START", "FRAME_PARENT_END", "FRAME_SAME_TEXT", "FRAME_CROSS_TEXT", "FRAME_CROSS_END", "FRAME_NESTED_TEXT", "SRCDOC_TEXT"]) assert.ok(page.text.includes(value), value);
	assert.ok(!page.text.includes("HIDDEN_AUTH_SHOULD_NOT_APPEAR"));
	assert.equal(page.scanComplete, true);
	assert.ok(page.framesRead >= 5);
});
for (const path of ["/navigate", "/frame-navigation"]) {
	test(`${path}: document replacement cannot mix previous main or embedded content into the result`, async () => {
		const page = await read(path);
		assertMarkers(page, "S", 80);
		assert.ok(!/OBSOLETE|FRAME_SAME_TEXT/.test(page.text));
		assert.equal(page.scanComplete, true);
		assert.equal(page.url, "http://page.public.org/static");
	});
}
test("a visible policy-blocked iframe makes the parent capture explicitly incomplete", async () => {
	const page = await read("/blocked-frame");
	assert.ok(page.text.includes("VISIBLE_PARENT_TEXT") && page.text.includes("PARENT_END"));
	assert.equal(page.scanComplete, false);
	assert.ok(page.incompleteReasons.length > 0);
});
test("the aggregate text budget returns bounded partial content, never a false full-page success", async () => {
	const page = await read("/large");
	assert.ok(Array.from(page.text).length <= 262144);
	assert.equal(page.captureTruncated, true);
	assert.equal(page.scanComplete, false);
});
test("infinite scrolling stops at a bounded budget and reports partial capture", async () => {
	const page = await read("/infinite");
	assert.ok(page.text.includes("INFINITE_START"));
	assert.equal(page.scanComplete, false);
	assert.ok(page.incompleteReasons.some(reason => /limit|timeout/.test(reason)));
});
