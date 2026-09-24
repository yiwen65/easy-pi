import assert from "node:assert/strict";
import test from "node:test";
import { percentile, summarize } from "./metrics.mjs";

test("empty and small samples do not fabricate percentiles", () => {
	assert.equal(percentile([], 0.95), null);
	assert.equal(percentile([3, 1, 2], 0.5), 2);
	assert.equal(percentile([3, 1, 2], 0.95), 3);
	assert.equal(summarize([]).allPassed, false);
});
test("failed and crashed runs remain in denominator and never become speed wins", () => {
	const base = {
		scenario: "save",
		strategy: "split",
		passed: true,
		exitCode: 0,
		closed: true,
		fixtureExit: { code: 0 },
		lease: "pi-computer-desktop-v1 C 0001",
		taskMs: 100,
		closeMs: 5,
		calls: [{}, {}],
	};
	const summary = summarize([base, { ...base, passed: false, taskMs: null }, { ...base, exitCode: 1, taskMs: 1 }]);
	assert.equal(summary.allPassed, false);
	assert.deepEqual(summary.groups[0], {
		scenario: "save",
		strategy: "split",
		attempts: 3,
		passed: 1,
		failed: 2,
		successfulTaskP50Ms: 100,
		successfulTaskP95Ms: 100,
		closeP95Ms: 5,
		callsP50: 2,
	});
	assert.equal(summary.groups[1].successfulTaskP50Ms, null);
});

test("success requires cleanup evidence and a finite nonnegative task duration", () => {
	const base = {
		scenario: "save",
		strategy: "combined",
		passed: true,
		exitCode: 0,
		closed: true,
		fixtureExit: { code: 0 },
		lease: "pi-computer-desktop-v1 C 0001",
		taskMs: 100,
		closeMs: 5,
		calls: [],
	};
	assert.equal(summarize([base]).allPassed, true);
	for (const change of [
		{ closed: false },
		{ fixtureExit: { code: 1 } },
		{ lease: "busy" },
		{ taskMs: null },
		{ taskMs: NaN },
		{ taskMs: -1 },
	]) {
		const summary = summarize([{ ...base, ...change }]);
		assert.equal(summary.allPassed, false);
		assert.equal(summary.groups[1].passed, 0);
		assert.equal(summary.groups[1].successfulTaskP50Ms, null);
	}
});
