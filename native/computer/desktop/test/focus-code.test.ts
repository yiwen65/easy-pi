import assert from "node:assert/strict";
import { test } from "node:test";
import { segmentCode } from "../segment-projection.ts";

test("focus capability refusals survive bounded projection without exposing native strings", () => {
	assert.equal(segmentCode("focus_not_supported"), "focus_not_supported");
	assert.equal(segmentCode("focus_capability_unknown"), "focus_capability_unknown");
	assert.equal(segmentCode("arbitrary native detail"), "native_fault");
});
