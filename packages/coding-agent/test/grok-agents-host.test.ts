import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createGrokTuiRuntime } from "@earendil-works/pi-grok-tui";
import { Container, Input, Text } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const custom = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as ExtensionUIContext["custom"];

test.each(["regular", "fullscreen"] as const)(
	"/agents via real Grok %s host paints and releases editor focus",
	async (mode) => {
		const cwd = await mkdtemp(join(tmpdir(), "epi-agents-host-"));
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "agents-host-faux", tokensPerSecond: 0 });
		modelRuntime.registerNativeProvider(faux.provider);
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		});
		const terminal = new VirtualTerminal(100, 24);
		const ui = createGrokTuiRuntime({ mode, terminal });
		const editor = new Input();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		// A short empty-root preview must not look like four transcript lines
		// while the still-visible main editor silently loses keyboard focus.
		ui.addChild(new Text("root transcript sentinel\n".repeat(19), 0, 0));
		editor.setValue("root draft sentinel");
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		const host = {
			ui,
			editor: { getText: () => editor.getValue() },
			editorContainer,
			keybindings: new KeybindingsManager(),
		};
		initTheme("dark");
		ui.start();
		try {
			await session.bindExtensions({
				mode: "tui",
				uiContext: { ...session.extensionRunner.getUIContext(), custom: custom.bind(host) },
			});
			const command = session.prompt("/agents");
			await vi.waitFor(() => expect(ui.hasOverlay()).toBe(true));
			ui.renderNow();
			const screen = (await terminal.flushAndGetViewport()).join("\n");
			expect(screen).toContain("Agents — shared workspace");
			expect(screen).toContain("return to main session");
			expect(screen).not.toContain("root draft sentinel");
			expect(screen).not.toContain("root transcript sentinel");
			expect(screen).toContain("╭");
			terminal.resize(60, 18);
			ui.flushActions();
			ui.renderNow();
			const resized = (await terminal.flushAndGetViewport()).join("\n");
			expect(resized).toContain("return to main session");
			expect(resized).not.toContain("root draft sentinel");
			terminal.sendInput("\x1b");
			await command;
			expect(editor.focused).toBe(true);
			terminal.sendInput("continued");
			ui.flushActions();
			expect(editor.getValue()).toBe("continuedroot draft sentinel");
			expect(faux.state.callCount).toBe(0);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			ui.stop({ preserveScreen: true });
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
