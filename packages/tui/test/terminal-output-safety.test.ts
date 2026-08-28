import assert from "node:assert";
import { describe, it } from "node:test";
import { normalizeTerminalOutput } from "../src/utils.ts";

describe("terminal output safety", () => {
	it("removes alternate-screen mode switches from rendered content", () => {
		const output = [
			"before",
			"\x1b[?1049l",
			"\x1b[?1049h",
			"\x1b[?1047l",
			"\x1b[?1047h",
			"\x1b[?47l",
			"\x1b[?47h",
			"after",
		].join("");
		assert.strictEqual(normalizeTerminalOutput(output), "beforeafter");
	});

	it("preserves safe SGR styling", () => {
		assert.strictEqual(normalizeTerminalOutput("\x1b[31mred\x1b[0m"), "\x1b[31mred\x1b[0m");
	});
});
