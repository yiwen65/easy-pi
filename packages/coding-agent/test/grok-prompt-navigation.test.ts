import { describe, expect, test, vi } from "vitest";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { findPromptJumpTarget } from "../src/modes/interactive-grok/prompt-navigation.ts";

describe("Grok prompt navigation keybindings", () => {
	test("uses macOS-safe terminal sequences", () => {
		const keybindings = new KeybindingsManager();
		const matchingActions = (data: string) =>
			(Object.keys(KEYBINDINGS) as Array<keyof typeof KEYBINDINGS>).filter((action) =>
				keybindings.matches(data, action),
			);

		expect(matchingActions("\x1b[5$")).toEqual(["app.prompt.prev"]);
		expect(matchingActions("\x1b[5;2~")).toEqual(["app.prompt.prev"]);
		expect(matchingActions("\x1b[6$")).toEqual(["app.prompt.next"]);
		expect(matchingActions("\x1b[6;2~")).toEqual(["app.prompt.next"]);
		expect(matchingActions("\x1b[17~")).toEqual(["app.prompt.list"]);

		expect(keybindings.matches("\x1b[1;5A", "app.prompt.prev")).toBe(false);
		expect(keybindings.matches("\x1b[1;5B", "app.prompt.next")).toBe(false);
		expect(keybindings.matches("\x1bj", "app.prompt.list")).toBe(false);
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
