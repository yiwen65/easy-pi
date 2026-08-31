import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CombinedAutocompleteProvider, type SlashCommand } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const commands: SlashCommand[] = [
	{ name: "model", description: "Switch model" },
	{ name: "skill:alpha", description: "Alpha skill" },
	{ name: "skill:beta", description: "Beta skill" },
	{ name: "skill:code-performance", description: "Performance skill" },
];

function createTestTUI(): TUI {
	return new TuiMainScreen(new VirtualTerminal(100, 30));
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

async function getSuggestions(provider: CombinedAutocompleteProvider, line: string) {
	return provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
}

describe("slash skill autocomplete", () => {
	it("offers commands and skills for the leading slash, then only skills for later slashes", async () => {
		const provider = new CombinedAutocompleteProvider(commands, "/tmp");

		const leading = await getSuggestions(provider, "/");
		assert.deepStrictEqual(
			leading?.items.map((item) => item.value),
			["model", "skill:alpha", "skill:beta", "skill:code-performance"],
		);

		for (const line of ["/model /", "explain this /", "/model /skill:alpha /"]) {
			const trailing = await getSuggestions(provider, line);
			assert.strictEqual(trailing?.prefix, "/");
			assert.deepStrictEqual(
				trailing?.items.map((item) => item.value),
				["skill:alpha", "skill:beta", "skill:code-performance"],
			);
		}
	});

	it("renders selected skills as colored atomic mentions while submitting backend invocations", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, "/tmp"));
		let submitted: string | undefined;
		editor.onSubmit = (text) => {
			submitted = text;
		};

		// A leading skill selection inserts a mention instead of submitting it like a command.
		editor.handleInput("/");
		await flushAutocomplete();
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		assert.strictEqual(submitted, undefined);
		assert.strictEqual(editor.getText(), "alpha ");

		const renderedMention = editor.render(100).join("\n");
		assert.match(renderedMention, /\x1b\[36m/);
		assert.match(stripVTControlCharacters(renderedMention), /alpha/);
		assert.doesNotMatch(stripVTControlCharacters(renderedMention), /skill:/);

		for (const char of "explain /") editor.handleInput(char);
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		const renderedMenu = stripVTControlCharacters(editor.render(100).join("\n"));
		assert.match(renderedMenu, /skill:alpha/);
		assert.doesNotMatch(renderedMenu, /Switch model/);

		editor.handleInput("\r");
		assert.strictEqual(submitted, undefined);
		assert.strictEqual(editor.getText(), "alpha explain alpha ");

		editor.handleInput("/");
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		editor.handleInput("\t");
		assert.strictEqual(editor.getText(), "alpha explain alpha alpha ");

		// Backspace removes the selected mention as one unit.
		editor.handleInput("\x7f");
		editor.handleInput("\x7f");
		assert.strictEqual(editor.getText(), "alpha explain alpha ");

		editor.handleInput("\r");
		assert.strictEqual(submitted, "/skill:alpha explain /skill:alpha");

		// History restores the display mention rather than exposing backend syntax.
		editor.addToHistory(submitted);
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "alpha explain alpha");
		assert.doesNotMatch(stripVTControlCharacters(editor.render(100).join("\n")), /skill:/);
	});

	it("preserves mention identity across editor round-trips and atomic cursor jumps", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, "/tmp"));
		for (const char of "/code") editor.handleInput(char);
		await flushAutocomplete();
		editor.handleInput("\r");

		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: "code-performance ".length });
		assert.strictEqual(editor.getTextForEditorTransfer(), "/skill:code-performance ");

		const externalText = editor.getExpandedText();
		editor.setText(externalText);
		assert.strictEqual(editor.getText(), "code-performance ");
		assert.match(editor.render(100).join("\n"), /\x1b\[36m/);

		editor.handleInput("\x01");
		editor.handleInput("\x1d");
		editor.handleInput("p");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		editor.handleInput("\x1b[3~");
		assert.strictEqual(editor.getText(), " ");

		editor.addToHistory(externalText);
		editor.setText("");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "code-performance");
		assert.doesNotMatch(stripVTControlCharacters(editor.render(100).join("\n")), /skill:/);
	});

	it("keeps skill mention styling across wrapped layout lines", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, "/tmp"));
		for (const char of "/code") editor.handleInput(char);
		await flushAutocomplete();
		editor.handleInput("\r");

		const rendered = editor.render(8);
		const contentLines = rendered.slice(1, -1).filter((line) => /[a-z]/.test(stripVTControlCharacters(line)));
		assert.ok(contentLines.length > 1);
		assert.ok(contentLines.every((line) => line.includes("\x1b[36m")));
		assert.strictEqual(stripVTControlCharacters(contentLines.join("")).replace(/\s/g, ""), "code-performance");
	});
});
