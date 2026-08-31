import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import { type CustomMessage, createSkillPromptMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});

	test("renders built-in skill prompt messages without exposing wrapper XML", () => {
		initTheme("dark");
		const message = createSkillPromptMessage(
			"code-debug",
			"/tmp/code-debug/SKILL.md",
			"/tmp/code-debug",
			"# Debug\n\nFind the first divergence.",
		);
		const component = new CustomMessageComponent(message);

		const collapsed = component.render(80).map(stripAnsi).join("\n");
		expect(collapsed).toContain("[skill] code-debug");
		expect(collapsed).not.toContain("<skill>");

		component.setExpanded(true);
		const expanded = component.render(80).map(stripAnsi).join("\n");
		expect(expanded).toContain("Find the first divergence.");
		expect(expanded).not.toContain("<skill>");
	});
});
