import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { visibleWidth } from "../src/utils.ts";

describe("Box render cache", () => {
	it("reuses padded output without modifying child lines and detects in-place child updates", () => {
		const childLines = ["\x1b[31mASCII\x1b[0m", "界🙂"];
		const box = new Box(1, 1, (text) => `\x1b[44m${text}\x1b[0m`);
		box.addChild({ render: () => childLines, invalidate() {} });

		const first = box.render(12);
		assert.strictEqual(box.render(12), first);
		assert.deepEqual(childLines, ["\x1b[31mASCII\x1b[0m", "界🙂"]);
		assert.deepEqual(first, [
			"\x1b[44m            \x1b[0m",
			"\x1b[44m \x1b[31mASCII\x1b[0m      \x1b[0m",
			"\x1b[44m 界🙂       \x1b[0m",
			"\x1b[44m            \x1b[0m",
		]);

		childLines[0] = "updated";
		const updated = box.render(12);
		assert.notStrictEqual(updated, first);
		assert.equal(updated[1], "\x1b[44m updated    \x1b[0m");
		assert.ok(updated.every((line) => visibleWidth(line) === 12));
	});

	it("updates width and background without stale padding or theme output", () => {
		let color = 44;
		const box = new Box(1, 0, (text) => `\x1b[${color}m${text}\x1b[0m`);
		box.addChild({ render: () => ["x\t界"], invalidate() {} });

		assert.deepEqual(box.render(10), ["\x1b[44m x\t界   \x1b[0m"]);
		color = 45;
		assert.deepEqual(box.render(10), ["\x1b[45m x\t界   \x1b[0m"]);
		assert.deepEqual(box.render(8), ["\x1b[45m x\t界 \x1b[0m"]);
		box.setBgFn(undefined);
		assert.deepEqual(box.render(8), [" x\t界 "]);
	});

	it("invalidates cached geometry when children are added, removed, or cleared", () => {
		const box = new Box(1, 0);
		const first = { render: () => ["one"], invalidate() {} };
		const second = { render: () => ["two"], invalidate() {} };
		box.addChild(first);
		assert.deepEqual(box.render(6), [" one  "]);
		box.addChild(second);
		assert.deepEqual(box.render(6), [" one  ", " two  "]);
		box.removeChild(first);
		assert.deepEqual(box.render(6), [" two  "]);
		box.clear();
		assert.deepEqual(box.render(6), []);
	});
});
