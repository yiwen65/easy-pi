import assert from "node:assert";
import { describe, it } from "node:test";
import { getOsc8LinkAtColumn, sliceByColumn, sliceWithWidth, visibleWidth } from "../src/utils.ts";

// https://github.com/earendil-works/pi/issues/10169
describe("sliceByColumn ANSI order regression", () => {
	it("keeps a reset at the slice start after earlier style codes", () => {
		const line = "\x1b[32mfoo\x1b[39m bar";
		assert.strictEqual(sliceByColumn(line, 3, 4, true), "\x1b[32m\x1b[39m bar");
	});

	it("does not leak color into text after a highlighted token", () => {
		const line = "Another \x1b[35malpha\x1b[39m line with \x1b[35mbeta\x1b[39m later.";
		const after = sliceByColumn(line, 13, 100, true);
		assert.strictEqual(after, "\x1b[35m\x1b[39m line with \x1b[35mbeta\x1b[39m later.");
	});

	it("preserves multiple inherited and boundary SGR codes without duplication", () => {
		const line = "\x1b[1m\x1b[32mfoo\x1b[39m\x1b[22m bar";
		for (const strict of [false, true]) {
			assert.deepStrictEqual(sliceWithWidth(line, 3, 4, strict), {
				text: "\x1b[1m\x1b[32m\x1b[39m\x1b[22m bar",
				width: 4,
			});
		}
	});

	for (const [name, terminator] of [
		["BEL", "\x07"],
		["ST", "\x1b\\"],
	]) {
		it(`keeps an OSC 8 close after its inherited open with ${name} termination`, () => {
			const open = `\x1b]8;id=token;https://example.com${terminator}`;
			const close = `\x1b]8;;${terminator}`;
			const slice = sliceWithWidth(`${open}foo${close} bar`, 3, 4, true);
			assert.deepStrictEqual(slice, { text: `${open}${close} bar`, width: 4 });
			assert.strictEqual(getOsc8LinkAtColumn(slice.text, 0), undefined);
		});
	}

	it("keeps wide-grapheme boundaries and reported widths unchanged", () => {
		const line = "\x1b[32mfoo\x1b[39m界🙂\tz";
		const prefix = "\x1b[32m\x1b[39m";
		const full = sliceWithWidth(line, 3, 7, true);
		assert.deepStrictEqual(full, { text: `${prefix}界🙂\t`, width: 7 });
		assert.strictEqual(visibleWidth(full.text), full.width);
		const strict = sliceWithWidth(line, 3, 1, true);
		assert.strictEqual(strict.width, 0);
		assert.strictEqual(visibleWidth(strict.text), 0);
		assert.deepStrictEqual(sliceWithWidth(line, 3, 1), { text: `${prefix}界`, width: 2 });
		assert.deepStrictEqual(sliceWithWidth(line, 4, 3, true), { text: `${prefix}🙂`, width: 2 });
	});

	it("preserves inherited-only styling and excludes codes at the right boundary", () => {
		const line = "\x1b[32mfoobar\x1b[0m";
		assert.deepStrictEqual(sliceWithWidth(line, 3, 3, true), { text: "\x1b[32mbar", width: 3 });
		assert.deepStrictEqual(sliceWithWidth(line, 0, 3, true), { text: "\x1b[32mfoo", width: 3 });
		assert.deepStrictEqual(sliceWithWidth("foobar", 3, 3, true), { text: "bar", width: 3 });
		assert.deepStrictEqual(sliceWithWidth(line, 3, 0, true), { text: "", width: 0 });
		assert.deepStrictEqual(sliceWithWidth(line, 3, -1, true), { text: "", width: 0 });
	});
});
