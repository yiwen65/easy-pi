import { describe, expect, test } from "vitest";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("UserMessageSelectorComponent", () => {
	test("keeps the fork title and description by default", () => {
		initTheme("dark");
		const selector = new UserMessageSelectorComponent(
			[{ id: "a", text: "hello" }],
			() => {},
			() => {},
		);
		const rendered = stripAnsi(selector.render(80).join("\n"));
		expect(rendered).toContain("Fork from Message");
		expect(rendered).toContain("copy the active path");
	});

	test("supports a jump-mode title and description", () => {
		initTheme("dark");
		const selector = new UserMessageSelectorComponent(
			[
				{ id: "0", text: "first prompt" },
				{ id: "1", text: "second prompt" },
			],
			() => {},
			() => {},
			"1",
			{ title: "Jump to Prompt", description: "Select a user prompt to scroll the transcript to it" },
		);
		const rendered = stripAnsi(selector.render(80).join("\n"));
		expect(rendered).toContain("Jump to Prompt");
		expect(rendered).toContain("scroll the transcript");
		expect(rendered).not.toContain("Fork from Message");
		expect(rendered).toContain("second prompt");
	});
});
