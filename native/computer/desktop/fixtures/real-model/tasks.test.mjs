import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { caseIds, checkOracle, chromeTasks, pageHtml } from "./tasks.mjs";

test("every task has an explicit outcome and missing results fail", () => {
	assert.equal(new Set(caseIds).size, caseIds.length);
	for (const id of caseIds) {
		assert.equal(checkOracle(id, undefined), false);
		assert.equal(checkOracle(id, {}), false);
	}
	assert.equal(checkOracle("unknown", { passed: true }), false);
});
test("MiniWoB requires completed episode and exact raw reward, not narration", () => {
	assert.equal(checkOracle("miniwob:enter-text", { done: true, rawReward: 1, reward: 0.2 }), true);
	for (const value of [
		{ done: false, rawReward: 1 },
		{ done: true, rawReward: -1 },
		{ done: true, rawReward: 0.5 },
		{ done: true, rawReward: "1" },
	])
		assert.equal(checkOracle("miniwob:enter-text", value), false);
});
test("scroll completion requires a scrolled viewport and a visible button", () => {
	for (const value of [
		{ bottom: true },
		{ bottom: true, scrolled: false, targetVisible: true },
		{ bottom: true, scrolled: true, targetVisible: false },
	])
		assert.equal(checkOracle("chrome-scroll", value), false);
});
test("Chrome validators check exact fields and character content", () => {
	const values = {
		"chrome-form": { name: "王小明 café", city: "Hangzhou", consent: "on", plan: "Pro" },
		"chrome-navigation": { record: "R-204", note: "reviewed 你好" },
		"chrome-tabs": { answer: "REF-729" },
		"chrome-scroll": { bottom: true, scrolled: true, targetVisible: true },
		"chrome-dialog": { comment: "approved 你好" },
	};
	for (const [id, value] of Object.entries(values)) {
		assert.equal(checkOracle(id, value), true);
		for (const key of Object.keys(value)) assert.equal(checkOracle(id, { ...value, [key]: "incorrect" }), false);
	}
});
test("scroll fixture measures viewport geometry at the actual click", () => {
	const html = pageHtml("chrome-scroll", "Owned test", "/");
	const handler = /<button onclick="([^"]+)">Bottom confirmation<\/button>/.exec(html)?.[1];
	assert.ok(handler);
	for (const [scrollY, top, bottom, expected] of [
		[0, 2500, 2550, false],
		[0, 100, 150, false],
		[2400, -20, 30, false],
		[2400, 760, 810, false],
		[2400, 100, 150, true],
	]) {
		let called = 0;
		runInNewContext(handler, {
			scrollY,
			innerHeight: 800,
			getBoundingClientRect: () => ({ top, bottom }),
			done(value) {
				called++;
				assert.equal(checkOracle("chrome-scroll", value), expected);
			},
		});
		assert.equal(called, 1);
	}
});
test("fixtures expose user controls, not evaluator success shortcuts", () => {
	for (const id of Object.keys(chromeTasks)) {
		const html = pageHtml(id, "Owned test", "/");
		assert.ok(html.includes("<title>Owned test</title>"));
		assert.ok(html.includes("Saved receipt:"));
		assert.ok(!html.includes("undefined"));
	}
	assert.ok(pageHtml("chrome-navigation", "Owned test", "/records").includes('href="/record"'));
	assert.ok(pageHtml("chrome-tabs", "Owned test", "/reference").includes("REF-729"));
});
