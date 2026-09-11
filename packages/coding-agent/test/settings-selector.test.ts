import { fauxProvider } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("selects and independently resets a searchable Subagent model without touching root model settings", () => {
		const models = fauxProvider({
			provider: "ui-models",
			models: [{ id: "first" }, { id: `secondary/${"long-model-".repeat(10)}` }],
		}).models;
		const onSubagentModelChange = vi.fn();
		const onSubagentThinkingLevelChange = vi.fn();
		const onThinkingLevelChange = vi.fn();
		const config = { warnings: {}, availableThinkingLevels: [], subagentModels: models } as unknown as SettingsConfig;
		const callbacks = {
			onSubagentModelChange,
			onSubagentThinkingLevelChange,
			onThinkingLevelChange,
		} as unknown as SettingsCallbacks;
		const selector = new SettingsSelectorComponent(config, callbacks);
		const list = selector.getSettingsList();
		for (const character of "Subagent model") list.handleInput(character);
		list.handleInput("\r");
		expect(selector.render(80).join("\n")).toContain("Inherit caller");
		for (const character of "secondary") list.handleInput(character);
		for (const width of [40, 80, 120])
			expect(selector.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		list.handleInput("\r");
		expect(onSubagentModelChange).toHaveBeenCalledExactlyOnceWith(`ui-models/${models[1].id}`);
		list.handleInput("\r");
		list.handleInput("\x1b");
		expect(onSubagentModelChange).toHaveBeenCalledTimes(1);
		list.handleInput("\r");
		list.handleInput("\r");
		expect(onSubagentModelChange.mock.calls).toEqual([[`ui-models/${models[1].id}`], [undefined]]);
		expect(onSubagentThinkingLevelChange).not.toHaveBeenCalled();
		expect(onThinkingLevelChange).not.toHaveBeenCalled();
	});

	it("offers inherit and all effort levels even when the root has no reasoning", () => {
		const onSubagentThinkingLevelChange = vi.fn();
		const onThinkingLevelChange = vi.fn();
		const config = {
			warnings: {},
			availableThinkingLevels: ["off"],
			subagentModels: [],
		} as unknown as SettingsConfig;
		const selector = new SettingsSelectorComponent(config, {
			onSubagentThinkingLevelChange,
			onThinkingLevelChange,
		} as unknown as SettingsCallbacks);
		const list = selector.getSettingsList();
		for (const character of "Subagent effort") list.handleInput(character);
		list.handleInput("\r");
		for (let index = 0; index < 7; index++) list.handleInput("\x1b[B");
		expect(selector.render(80).join("\n")).toContain("Maximum reasoning");
		list.handleInput("\r");
		expect(onSubagentThinkingLevelChange).toHaveBeenCalledExactlyOnceWith("max");
		list.handleInput("\r");
		for (let index = 0; index < 7; index++) list.handleInput("\x1b[A");
		list.handleInput("\r");
		expect(onSubagentThinkingLevelChange.mock.calls).toEqual([["max"], [undefined]]);
		expect(onThinkingLevelChange).not.toHaveBeenCalled();
	});

	it("retains an unavailable saved model on cancel and offers inherit with an empty catalog", () => {
		const onSubagentModelChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			{ warnings: {}, subagentModels: [], subagentModel: "removed/model" } as unknown as SettingsConfig,
			{ onSubagentModelChange } as unknown as SettingsCallbacks,
		);
		const list = selector.getSettingsList();
		for (const character of "Subagent model") list.handleInput(character);
		list.handleInput("\r");
		expect(selector.render(100).join("\n")).toContain("Saved model is unavailable");
		list.handleInput("\x1b");
		expect(onSubagentModelChange).not.toHaveBeenCalled();
		expect(selector.render(100).join("\n")).toContain("removed/model");
		list.handleInput("\r");
		list.handleInput("\r");
		expect(onSubagentModelChange).toHaveBeenCalledExactlyOnceWith(undefined);
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});
});
