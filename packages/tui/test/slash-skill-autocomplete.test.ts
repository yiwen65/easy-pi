import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CombinedAutocompleteProvider, type SlashCommand } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { encodeSkillMention, findSkillMentions, isSkillMention } from "../src/skill-mentions.ts";
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
	it("recognizes complete encoded skill mentions without treating ordinary text as metadata", () => {
		const mention = encodeSkillMention("code-performance");
		assert.strictEqual(isSkillMention(mention), true);
		assert.strictEqual(isSkillMention("code-performance"), false);
		assert.strictEqual(isSkillMention(`${mention} suffix`), false);
		assert.deepStrictEqual(
			findSkillMentions(`before ${mention} after`).map(({ name }) => name),
			["code-performance"],
		);
	});

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
			assert.deepStrictEqual(
				trailing?.items.map((item) => item.label),
				["Alpha", "Beta", "Code Performance"],
			);
			assert.deepStrictEqual(
				trailing?.items.map((item) => item.description),
				["[Skill] Alpha skill", "[Skill] Beta skill", "[Skill] Performance skill"],
			);
		}
	});

	it("preserves leading whitespace, command arguments, and trailing skill lookup", async () => {
		const argumentPrefixes: string[] = [];
		const provider = new CombinedAutocompleteProvider(
			[
				...commands,
				{
					name: "load-skills",
					getArgumentCompletions: (prefix) => {
						argumentPrefixes.push(prefix);
						return [{ value: "alpha", label: "alpha" }];
					},
				},
			],
			"/tmp",
		);
		for (const before of [" ", "  ", "\t", " \t"]) {
			const line = `${before}/mod suffix`;
			const cursorCol = before.length + "/mod".length;
			const result = await provider.getSuggestions([line], 0, cursorCol, { signal: new AbortController().signal });
			assert.ok(result);
			assert.strictEqual(result.prefix, "/mod");
			assert.deepStrictEqual(
				result.items.map((item) => item.value),
				["model"],
			);
			const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
			assert.strictEqual(applied.lines[0], `${before}/model  suffix`);
			assert.strictEqual(applied.cursorCol, `${before}/model `.length);
			assert.strictEqual(provider.shouldTriggerFileCompletion([`${before}/mod`], 0, before.length + 4), false);

			const argumentLine = `${before}/load-skills a`;
			const argumentsResult = await getSuggestions(provider, argumentLine);
			assert.ok(argumentsResult);
			assert.strictEqual(argumentsResult.prefix, "a");
			const argumentApplied = provider.applyCompletion(
				[argumentLine],
				0,
				argumentLine.length,
				argumentsResult.items[0]!,
				argumentsResult.prefix,
			);
			assert.strictEqual(argumentApplied.lines[0], `${before}/load-skills alpha`);
			assert.strictEqual(argumentApplied.cursorCol, argumentApplied.lines[0]!.length);

			const trailing = await getSuggestions(provider, `${before}/load-skills a /`);
			assert.strictEqual(trailing?.prefix, "/");
			assert.ok(trailing?.items.every((item) => item.value.startsWith("skill:")));
		}
		assert.deepStrictEqual(argumentPrefixes, ["a", "a", "a", "a"]);
	});

	it("completes indented commands via Tab and their arguments without submitting", async () => {
		for (const before of ["  ", "\t"]) {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(
					[{ name: "model", getArgumentCompletions: () => [{ value: "local", label: "local" }] }],
					"/tmp",
				),
			);
			let submitted: string | undefined;
			editor.onSubmit = (text) => {
				submitted = text;
			};
			editor.setText(`${before}/mod`);
			const indentation = editor.getText().slice(0, -4);
			editor.handleInput("\t");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);
			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), `${indentation}/model `);
			editor.handleInput("l");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);
			editor.handleInput("\r");
			assert.strictEqual(editor.getText(), `${indentation}/model local`);
			assert.strictEqual(submitted, undefined);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: editor.getText().length });
			editor.handleInput("\r");
			assert.strictEqual(submitted, "/model local");
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
		assert.match(renderedMenu, /Alpha\s+\[Skill] Alpha skill/);
		assert.doesNotMatch(renderedMenu, /skill:alpha/);
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
