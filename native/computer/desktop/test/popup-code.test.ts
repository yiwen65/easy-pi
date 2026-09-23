import assert from "node:assert/strict";
import { test } from "node:test";
import { segmentCode } from "../segment-projection.ts";

test("screen-pointer occlusion survives projection without exposing arbitrary native strings", () => {
	assert.equal(segmentCode("pointer_target_occluded"), "pointer_target_occluded");
	assert.equal(segmentCode("foreground_target_changed"), "foreground_target_changed");
	assert.equal(segmentCode("pointer_target_occluded: private detail"), "native_fault");
});
