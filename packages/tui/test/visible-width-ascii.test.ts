import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURSOR_MARKER } from "../src/tui.ts";
import { getGraphemeCellRange, sliceWithWidth, stripTerminalSequences, visibleWidth } from "../src/utils.ts";

const styled = (text: string): string => `\x1b[31m${text}\x1b[0m`;

describe("ASCII width fast paths", () => {
	it("counts every printable ASCII character after stripping terminal sequences", () => {
		const ascii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(0x20 + index)).join("");
		const prefixes = ["\x1b[1m", "\x1b]8;;https://example.com\x07", "\x1b]0;title\x1b\\", CURSOR_MARKER];
		for (const prefix of prefixes) {
			assert.equal(visibleWidth(`${prefix}${ascii}\x1b[0m`), 95);
		}
		assert.equal(visibleWidth(styled("")), 0);
		assert.equal(visibleWidth(`${CURSOR_MARKER}\tASCII\t`), 11);
	});

	it("keeps control characters and combining/keycap clusters on the Unicode path", () => {
		const cases: Array<[string, number]> = [
			["a\x00\x07\x08\x0a\x0d\x1fb\x7f", 2],
			["e\u0301", 1],
			["1\ufe0f\u20e3", 2],
			["#\ufe0f\u20e3", 2],
			["A界🙂e\u0301", 6],
			["a\u200db", 2],
			["\x1b", 0],
			["\x1b[", 1],
		];
		for (const [text, width] of cases) {
			assert.equal(visibleWidth(text), width, JSON.stringify(text));
			// Do not append an SGR suffix to malformed escapes: it may complete them.
			if (!text.includes("\x1b")) assert.equal(visibleWidth(styled(text)), width, JSON.stringify(text));
		}
	});

	it("uses the same ASCII cell widths in slicing and hit testing", () => {
		const ascii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(0x20 + index)).join("");
		const line = styled(ascii);
		for (let col = 0; col < ascii.length; col++) {
			assert.deepEqual(getGraphemeCellRange(line, col), { start: col, end: col + 1 });
			const slice = sliceWithWidth(line, col, 1, true);
			assert.equal(slice.width, 1);
			assert.equal(visibleWidth(slice.text), 1);
			assert.equal(stripTerminalSequences(slice.text), ascii[col]);
		}
		const mixed = styled("a1\ufe0f\u20e3e\u0301界z");
		assert.deepEqual(getGraphemeCellRange(mixed, 1), { start: 1, end: 3 });
		assert.deepEqual(getGraphemeCellRange(mixed, 3), { start: 3, end: 4 });
		assert.deepEqual(getGraphemeCellRange(mixed, 4), { start: 4, end: 6 });
		assert.equal(sliceWithWidth(mixed, 1, 1, true).width, 0);
		assert.equal(sliceWithWidth(mixed, 1, 2, true).width, 2);
	});
});
