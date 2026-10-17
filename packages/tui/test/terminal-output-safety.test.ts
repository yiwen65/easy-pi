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

	it("preserves host-generated hyperlinks and image protocol output", () => {
		const hyperlink = "\x1b]8;;https://example.test/docs\x1b\\docs\x1b]8;;\x1b\\";
		const kittyImage = "\x1b_Ga=T,f=100;UE5H\x1b\\";
		const itermImage = "\x1b]1337;File=inline=1:UE5H\x07";
		assert.strictEqual(
			normalizeTerminalOutput(hyperlink + kittyImage + itermImage),
			hyperlink + kittyImage + itermImage,
		);
	});

	it("preserves safe SGR styling", () => {
		assert.strictEqual(normalizeTerminalOutput("\x1b[31mred\x1b[0m"), "\x1b[31mred\x1b[0m");
	});
});
