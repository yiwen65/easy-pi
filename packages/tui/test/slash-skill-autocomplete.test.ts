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
			["model", "skill:alpha", "skill:beta"],
		);

		for (const line of ["/model /", "explain this /", "/model /skill:alpha /"]) {
			const trailing = await getSuggestions(provider, line);
			assert.strictEqual(trailing?.prefix, "/");
			assert.deepStrictEqual(
				trailing?.items.map((item) => item.value),
				["skill:alpha", "skill:beta"],
			);
		}
	});

	it("renders and repeatedly inserts trailing skills without submitting the draft", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, "/tmp"));
		let submitted: string | undefined;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setText("/model ");

		editor.handleInput("/");
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		const rendered = stripVTControlCharacters(editor.render(100).join("\n"));
		assert.match(rendered, /skill:alpha/);
		assert.doesNotMatch(rendered, /Switch model/);

		editor.handleInput("\r");
		assert.strictEqual(submitted, undefined);
		assert.strictEqual(editor.getText(), "/model /skill:alpha ");

		editor.handleInput("/");
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		editor.handleInput("\t");
		assert.strictEqual(editor.getText(), "/model /skill:alpha /skill:alpha ");
	});
});
