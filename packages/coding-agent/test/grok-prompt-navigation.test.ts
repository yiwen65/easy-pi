import { describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatKeyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { findPromptJumpTarget } from "../src/modes/interactive-grok/prompt-navigation.ts";

describe("Grok prompt navigation keybindings", () => {
	test("uses Command and Alt shortcuts", () => {
		const keybindings = new KeybindingsManager();

		expect(keybindings.getKeys("app.prompt.prev")).toEqual(["super+up", "alt+up"]);
		expect(keybindings.getKeys("app.prompt.next")).toEqual(["super+down", "alt+down"]);
		expect(keybindings.getKeys("app.prompt.list")).toEqual(["super+g", "alt+g"]);

		expect(keybindings.matches("\x1b[1;9A", "app.prompt.prev")).toBe(true);
		expect(keybindings.matches("\x1b[1;3A", "app.prompt.prev")).toBe(true);
		expect(keybindings.matches("\x1b[1;9B", "app.prompt.next")).toBe(true);
		expect(keybindings.matches("\x1b[1;3B", "app.prompt.next")).toBe(true);
		expect(keybindings.matches("\x1b[103;9u", "app.prompt.list")).toBe(true);
		expect(keybindings.matches("\x1bg", "app.prompt.list")).toBe(true);

		expect(keybindings.matches("\x1b[5$", "app.prompt.prev")).toBe(false);
		expect(keybindings.matches("\x1b[6$", "app.prompt.next")).toBe(false);
		expect(keybindings.matches("\x1b[17~", "app.prompt.list")).toBe(false);
	});

	test("moves the conflicting dequeue shortcut", () => {
		const keybindings = new KeybindingsManager();

		expect(keybindings.getKeys("app.message.dequeue")).toEqual(["shift+alt+up"]);
		expect(keybindings.matches("\x1b[1;3A", "app.message.dequeue")).toBe(false);
		expect(keybindings.matches("\x1b[1;4A", "app.message.dequeue")).toBe(true);
	});

	test("labels Super as Cmd on macOS", () => {
		expect(formatKeyText("super+g", { capitalize: true })).toBe(process.platform === "darwin" ? "Cmd+G" : "Super+G");
	});
});

describe("InteractiveMode prompt navigation", () => {
	test("switches regular Grok mode to fullscreen before navigating", () => {
		const switchTuiMode = vi.fn(() => true);
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype) as object, {
			grokComponentFactory: {},
			transcriptScrollView: { scrollTop: 0 },
			renderer: { mode: "regular" },
			switchTuiMode,
			transcriptContentWidth: () => 80,
			computeChatChildOffsets: () => [],
			showStatus: vi.fn(),
		});
		const jumpToUserPrompt = Reflect.get(InteractiveMode.prototype, "jumpToUserPrompt") as (
			this: typeof fakeThis,
			direction: -1 | 1,
		) => void;

		jumpToUserPrompt.call(fakeThis, -1);

		expect(switchTuiMode).toHaveBeenCalledWith("fullscreen");
	});
});

describe("findPromptJumpTarget", () => {
	const starts = [10, 50, 90];

	test("returns undefined when there are no prompts", () => {
		expect(findPromptJumpTarget([], 0, -1)).toBeUndefined();
		expect(findPromptJumpTarget([], 0, 1)).toBeUndefined();
	});

	test("single prompt is always the target", () => {
		expect(findPromptJumpTarget([42], 0, -1)).toBe(0);
		expect(findPromptJumpTarget([42], 100, 1)).toBe(0);
	});

	test("previous jumps to the nearest prompt above the viewport top", () => {
		expect(findPromptJumpTarget(starts, 95, -1)).toBe(2);
		expect(findPromptJumpTarget(starts, 90, -1)).toBe(1);
		expect(findPromptJumpTarget(starts, 55, -1)).toBe(1);
	});

	test("previous wraps to the last prompt at the top", () => {
		expect(findPromptJumpTarget(starts, 10, -1)).toBe(2);
		expect(findPromptJumpTarget(starts, 0, -1)).toBe(2);
	});

	test("next jumps to the nearest prompt below the viewport top", () => {
		expect(findPromptJumpTarget(starts, 0, 1)).toBe(0);
		expect(findPromptJumpTarget(starts, 10, 1)).toBe(1);
		expect(findPromptJumpTarget(starts, 55, 1)).toBe(2);
	});

	test("next wraps to the first prompt at the bottom", () => {
		expect(findPromptJumpTarget(starts, 90, 1)).toBe(0);
		expect(findPromptJumpTarget(starts, 200, 1)).toBe(0);
	});
});
