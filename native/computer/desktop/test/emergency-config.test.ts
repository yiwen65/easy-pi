import assert from "node:assert/strict";
import test from "node:test";
import { parseEmergencyChord } from "../emergency-config.ts";

test("physical chord maps app modifiers without text or Fn synthesis", () => {
	assert.deepEqual(parseEmergencyChord("ctrl+alt+escape"), { key: "escape", modifiers: ["Control", "Option"] });
	assert.deepEqual(parseEmergencyChord(["super+shift+a"]), { key: "a", modifiers: ["Command", "Shift"] });
	assert.equal(parseEmergencyChord("ctrl+delete").key, "forward_delete");
	assert.equal(parseEmergencyChord("ctrl+pageUp").key, "pageup");
});

test("unsupported, empty and multiple configurations are explicit failures", () => {
	for (const value of [
		[],
		["ctrl+a", "ctrl+b"],
		["ctrl+a", "ctrl+a"],
		"",
		"escape",
		"ctrl+",
		"fn+escape",
		"ctrl+ctrl+a",
		"ctrl+!",
		"ctrl+insert",
		"ctrl+shift",
		"ctrl+é",
	])
		assert.throws(() => parseEmergencyChord(value));
});
