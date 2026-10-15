import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodexServiceTier, CodexServiceTierStatus } from "../src/core/codex-service-tier.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { formatCodexServiceTierStatus } from "../src/modes/interactive/codex-service-tier-ui.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { mapAgentSessionEvent } from "../src/modes/interactive-grok/pi-session-events.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface FastPrototype {
	setupEditorSubmitHandler(this: unknown): void;
	handleFastCommand(this: unknown, text: string): void;
	handleFollowUp(this: unknown): Promise<void>;
	showSettingsSelector(this: unknown): void;
	handleEvent(
		this: unknown,
		event: { type: "codex_service_tier_changed"; status: CodexServiceTierStatus },
	): Promise<void>;
}
const prototype = InteractiveMode.prototype as unknown as FastPrototype;

function commandContext(preference?: CodexServiceTier, available = true) {
	const status: CodexServiceTierStatus = { preference, available, source: preference ? "settings" : "none" };
	const session = {
		get codexServiceTier() {
			return status.preference;
		},
		setCodexServiceTier: vi.fn((tier: CodexServiceTier | undefined) => {
			if (tier === "fast" && !available) throw new Error("Fast unavailable: unsupported or unknown model");
			status.preference = tier;
			status.source = "session";
		}),
		getCodexServiceTierStatus: () => ({ ...status }),
		prompt: vi.fn(),
		isStreaming: true,
		isCompacting: true,
	};
	const context = {
		session,
		status,
		footer: { invalidate: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		editor: { setText: vi.fn(), getText: () => "/fast invalid" },
		defaultEditor: {} as { onSubmit?: (text: string) => Promise<void> },
		handleFastCommand: (text: string) => prototype.handleFastCommand.call(context, text),
	};
	return context;
}

describe("InteractiveMode /fast", () => {
	beforeAll(() => initTheme("dark"));
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("is discoverable and toggles resolved preference without changing saved defaults", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual(
			expect.objectContaining({ name: "fast", argumentHint: "[on|off|status]" }),
		);
		const context = commandContext();
		prototype.handleFastCommand.call(context, "/fast");
		expect(context.session.setCodexServiceTier).toHaveBeenLastCalledWith("fast");
		expect(context.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("next model request"));
		prototype.handleFastCommand.call(context, "/fast");
		expect(context.session.setCodexServiceTier).toHaveBeenLastCalledWith("default");
		const configured = commandContext("fast");
		prototype.handleFastCommand.call(configured, "/fast");
		expect(configured.session.setCodexServiceTier).toHaveBeenLastCalledWith("default");
	});

	it.each(["/fast on", "/fast off", "/fast status", "/fast invalid", "/fast on off", "/fast\ton extra"])(
		"consumes %s locally even while streaming/compacting",
		async (text) => {
			const context = commandContext();
			prototype.setupEditorSubmitHandler.call(context);
			await context.defaultEditor.onSubmit?.(text);
			expect(context.session.prompt).not.toHaveBeenCalled();
			expect(context.editor.setText).toHaveBeenCalledWith("");
			if (text.includes("invalid") || text.includes("extra") || text.endsWith("on off")) {
				expect(context.showError).toHaveBeenCalledWith("Usage: /fast [on|off|status]");
				expect(context.session.setCodexServiceTier).not.toHaveBeenCalled();
			}
		},
	);

	it("also consumes invalid /fast from the follow-up shortcut", async () => {
		const context = commandContext();
		await prototype.handleFollowUp.call(context);
		expect(context.showError).toHaveBeenCalledWith("Usage: /fast [on|off|status]");
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("rejects unsupported activation but allows explicit Standard and read-only status", () => {
		const context = commandContext(undefined, false);
		prototype.handleFastCommand.call(context, "/fast on");
		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
		expect(context.status.preference).toBeUndefined();
		prototype.handleFastCommand.call(context, "/fast off");
		expect(context.status.preference).toBe("default");
		context.session.setCodexServiceTier.mockClear();
		context.status.sent = "priority";
		context.status.reported = "default";
		context.status.costEstimated = true;
		prototype.handleFastCommand.call(context, "/fast status");
		expect(context.session.setCodexServiceTier).not.toHaveBeenCalled();
		const output = context.showStatus.mock.calls.at(-1)?.[0];
		for (const label of [
			"Standard requested",
			"Source: session",
			"no (unsupported",
			'sent: "priority"',
			'reported: "default"',
			"latest upstream Standard",
			"estimates",
			"extra usage",
		])
			expect(output).toContain(label);
	});

	it("renders unknown upstream honestly and escapes raw untrusted tier text", () => {
		const output = formatCodexServiceTierStatus({
			source: "settings",
			preference: "fast",
			available: true,
			reported: "\x1b[2J",
		});
		expect(output).toContain("upstream tier unknown");
		expect(output).not.toContain("\x1b");
	});

	it("maps the state event and rerenders both UI engines", async () => {
		const status: CodexServiceTierStatus = { preference: "fast", source: "session", available: true };
		const event = { type: "codex_service_tier_changed" as const, status };
		expect(mapAgentSessionEvent(event, 4)).toEqual({ sequence: 4, kind: "codex-service-tier", status });
		for (const grok of [false, true]) {
			const context = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				grokView: grok ? {} : undefined,
				refreshGrokChrome: vi.fn(),
				ui: { requestRender: vi.fn() },
			};
			await prototype.handleEvent.call(context, event);
			expect(context.footer.invalidate).toHaveBeenCalled();
			expect(context.ui.requestRender).toHaveBeenCalled();
		}
	});

	it("updates the real session preference without changing its configured default or effort", async () => {
		const harness = await createHarness({ settings: { codexServiceTier: "default" }, hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		const model = harness.session.model;
		if (!model) throw new Error("Missing faux model");
		harness.session.agent.state.model = {
			...model,
			provider: "openai-codex",
			api: "openai-codex-responses",
			compat: { supportsFastMode: true },
		};
		const effort = harness.session.thinkingLevel;
		const context = {
			session: harness.session,
			footer: { invalidate: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		prototype.handleFastCommand.call(context, "/fast on");
		expect(harness.session.getCodexServiceTierStatus()).toMatchObject({
			preference: "fast",
			source: "session",
			available: true,
		});
		prototype.handleFastCommand.call(context, "/fast off");
		expect(harness.session.codexServiceTier).toBe("default");
		expect(harness.settingsManager.getCodexServiceTier()).toBe("default");
		expect(harness.session.thinkingLevel).toBe(effort);
		expect(harness.session.model?.id).toBe(model.id);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("saves all three defaults, resets the session override and tolerates unavailable current model", async () => {
		const harness = await createHarness({ hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		harness.session.setCodexServiceTier("default");
		let selector: SettingsSelectorComponent | undefined;
		const context = {
			session: harness.session,
			settingsManager: harness.settingsManager,
			themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => "dark" },
			ui: { mode: "regular" },
			footer: { invalidate: vi.fn() },
			showStatus: vi.fn(),
			showSelector: (create: (done: () => void) => { component: Component }) => {
				selector = create(() => {}).component as SettingsSelectorComponent;
			},
		};
		prototype.showSettingsSelector.call(context);
		const list = selector!.getSettingsList();
		for (const character of "Codex service tier default") list.handleInput(character);
		for (const preference of ["default", "fast", undefined] as const) {
			list.handleInput("\r");
			expect(harness.settingsManager.getCodexServiceTier()).toBe(preference);
			expect(harness.session.getCodexServiceTierStatus()).toMatchObject({
				available: false,
				source: preference ? "settings" : "none",
			});
		}
		expect(context.showStatus).toHaveBeenCalledTimes(3);
	});
});
