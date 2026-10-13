import assert from "node:assert/strict";
import { test } from "node:test";
import { setupBrowserFixtures } from "./browser-harness.mjs";
import { fixturePage, markers } from "./sampling-fixtures.mjs";

const { readPage } = await setupBrowserFixtures({ fixturePage, hosts: ["sample.public.org"] });
const read = (path) => readPage(`http://sample.public.org${path}`);

const occurrences = (text, value) => {
	const found = [];
	for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) found.push(at);
	return found;
};
/** Assert one occurrence and quote the captured text so a failure is diagnosable. */
const assertOnce = (text, value, options = {}) => {
	const found = occurrences(text, value);
	assert.equal(
		found.length,
		1,
		`${value}: expected exactly one occurrence, got ${found.length} in captured text ${JSON.stringify(text)}`,
	);
	if (options.after !== undefined) {
		const other = occurrences(text, options.after);
		assert.ok(
			other.length > 0 && found[0] > other[0],
			`${value} must appear after ${options.after} in ${JSON.stringify(text)}`,
		);
	}
};
const assertAbsent = (text, value) => {
	assert.equal(occurrences(text, value).length, 0, `${value} must not be captured in ${JSON.stringify(text)}`);
};

test("C01: a pure layout shift above two paragraphs leaves each of them exactly once", async () => {
	const page = await read("/c01");
	assert.ok(page.text.includes("PHASE_APPLIED"), `the fixture change must have run during the read: ${page.text}`);
	assertOnce(page.text, "C01_TOP");
	assertOnce(page.text, "ALPHA");
	assertOnce(page.text, "BETA", { after: "ALPHA" });
	assertOnce(page.text, "C01_TAIL");
});

test("C02: identical paragraphs at different positions are both kept (no global text de-duplication)", async () => {
	const page = await read("/c02");
	assert.equal(occurrences(page.text, "REPEAT_ME").length, 2, `both paragraphs must be kept: ${page.text}`);
	assertOnce(page.text, "C02_END");
});

test("C03: an in-place text update replaces the old text instead of keeping both versions", async () => {
	const page = await read("/c03");
	assert.ok(page.text.includes("PHASE_APPLIED"), `the fixture change must have run during the read: ${page.text}`);
	assertOnce(page.text, "NEW_VALUE");
	assertAbsent(page.text, "OLD_VALUE");
	assertOnce(page.text, "C03_TAIL");
});

test("C04: deleting a block removes its text and does not duplicate the paragraphs that shift up", async () => {
	const page = await read("/c04");
	assert.ok(page.text.includes("PHASE_APPLIED"), `the fixture change must have run during the read: ${page.text}`);
	assertAbsent(page.text, "DELETE_ME");
	assertOnce(page.text, "C04_BEFORE_1");
	assertOnce(page.text, "C04_BEFORE_2");
	assertOnce(page.text, "C04_AFTER_1");
	assertOnce(page.text, "C04_AFTER_2", { after: "C04_AFTER_1" });
	assertOnce(page.text, "C04_AFTER_3", { after: "C04_AFTER_2" });
	assertOnce(page.text, "C04_TAIL");
});

test("C05: a recycled virtual list with explicit logical keys keeps every item in order", async () => {
	const page = await read("/c05");
	assert.deepEqual(page.text.match(/V_\d{3}_汉字😀/gu), markers("V", 36), `captured text: ${page.text}`);
	assert.equal(occurrences(page.text, "LEGAL_REPEAT").length, 36, `captured text: ${page.text}`);
	assert.equal(page.scanComplete, true, `unexpected incomplete reasons: ${page.incompleteReasons.join(",")}`);
});

test("C06: recycled rows without a logical key keep every item and disclose the identity ambiguity", async () => {
	const page = await read("/c06");
	const missing = [];
	const duplicated = [];
	for (const value of markers("M", 24)) {
		const found = occurrences(page.text, value).length;
		if (found === 0) missing.push(value);
		if (found > 2) duplicated.push(`${value}x${found}`);
	}
	assert.deepEqual(missing, [], `no item may be overwritten away: ${page.text}`);
	assert.deepEqual(duplicated, [], `duplicates must stay bounded: ${page.text}`);
	const disclosed =
		page.incompleteReasons.includes("identity_ambiguous") ||
		(page.ambiguities ?? []).includes("identity_ambiguous");
	assert.ok(
		disclosed,
		`an unkeyed recycled container must be reported as ambiguous (reasons: ${page.incompleteReasons.join(",")}; ambiguities: ${(page.ambiguities ?? []).join(",")})`,
	);
});

test("C07: display:contents text, nested inline text and pre newlines are all captured", async () => {
	const page = await read("/c07");
	assert.ok(page.text.includes("CONTENTS_DIRECT_TEXT"), `display:contents text was dropped: ${page.text}`);
	assert.ok(page.text.includes("nested inline tail"), `inline text must stay joined with single spaces: ${page.text}`);
	assertOnce(page.text, "AFTER_CONTENTS");
	assert.ok(page.text.includes("PRE_LINE_1\nPRE_LINE_2\n  PRE_INDENT"), `pre lines must be preserved: ${page.text}`);
	assertOnce(page.text, "C07_END");
});

test("C08: invisible text is excluded while override and off-viewport text survive", async () => {
	const page = await read("/c08");
	assertOnce(page.text, "VISIBLE_MAIN");
	assertAbsent(page.text, "HIDDEN_OPACITY_TEXT");
	assertAbsent(page.text, "HIDDEN_DISPLAY_TEXT");
	assertOnce(page.text, "VISIBLE_OVERRIDE_TEXT");
	assertOnce(page.text, "BELOW_FOLD_TEXT");
	assertOnce(page.text, "C08_END");
});

test("C09: duplicate data ids and a font reflow neither overwrite nor duplicate blocks", async () => {
	const page = await read("/c09");
	assert.ok(page.text.includes("PHASE_APPLIED"), `the fixture change must have run during the read: ${page.text}`);
	assert.ok(!page.incompleteReasons.includes("timeout"), `the page must settle: ${page.text}`);
	assert.equal(
		occurrences(page.text, "DUP_SAME").length,
		3,
		`three distinct blocks sharing one data id must all be kept: ${page.text}`,
	);
	assertOnce(page.text, "C09_TAIL");
	assertOnce(page.text, "C09_END");
	assert.ok(page.text.includes("EXPANDED_ONE"), `details content must still be captured: ${page.text}`);
});

test("C09b: duplicate data ids with different text must not stall the read until its deadline", async () => {
	const page = await read("/c09-thrash");
	assert.ok(page.text.includes("PHASE_APPLIED"), `the fixture change must have run during the read: ${page.text}`);
	assert.ok(!page.incompleteReasons.includes("timeout"), `a duplicated data id may not stall the scan: ${page.text}`);
	assertOnce(page.text, "DUP_A");
	assertOnce(page.text, "DUP_B");
	assertOnce(page.text, "DUP_C");
	assertOnce(page.text, "C09B_BETWEEN");
	assertOnce(page.text, "C09B_END");
});
