import assert from "node:assert/strict";
import test from "node:test";
import * as legacy from "@earendil-works/pi-grok-tui";
import * as canonical from "@easy-pi/grok-tui";

test("legacy package name re-exports the canonical Grok TUI runtime", () => {
	assert.deepEqual(Object.keys(legacy).sort(), Object.keys(canonical).sort());
	assert.equal(legacy.createGrokTuiRuntime, canonical.createGrokTuiRuntime);
	assert.equal(legacy.GrokTuiRuntime, canonical.GrokTuiRuntime);
	assert.equal(legacy.GrokViewportTuiRuntime, canonical.GrokViewportTuiRuntime);
});
