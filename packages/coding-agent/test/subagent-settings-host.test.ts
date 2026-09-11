import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Container, Input, setKeybindings } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { spawnArgs } from "./collaboration-fixture.ts";

const showSettings = Reflect.get(InteractiveMode.prototype, "showSettingsSelector") as (this: object) => void;
const showSelector = Reflect.get(InteractiveMode.prototype, "showSelector");
const disposeActiveSelector = Reflect.get(InteractiveMode.prototype, "disposeActiveSelector");

test.each([
	{ tuiEngine: "grok", tuiMode: "regular" },
	{ tuiEngine: "grok", tuiMode: "fullscreen" },
	{ tuiEngine: "legacy", tuiMode: "regular" },
	{ tuiEngine: "legacy", tuiMode: "fullscreen" },
] as const)("/settings Subagent defaults persist and affect the next spawn in $tuiEngine/$tuiMode", async (layout) => {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-subagent-settings-ui-")));
	const agentDir = join(cwd, "agent");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	settingsManager.setCompactionEnabled(false);
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: "defaults-ui",
		tokensPerSecond: 0,
		models: [
			{ id: "root", reasoning: true },
			{ id: "child", reasoning: true },
		],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		modelRuntime: runtime,
		model: faux.getModel("root")!,
		thinkingLevel: "medium",
		sessionManager: SessionManager.inMemory(cwd),
	});
	await session.bindExtensions({ mode: "rpc" });
	const terminal = new VirtualTerminal(100, 30);
	const ui = createInteractiveTui({ ...layout, terminal, logDirectory: cwd, showHardwareCursor: false });
	const editor = new Input();
	editor.setValue("retained root draft");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	ui.setFocus(editor);
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
	const host = {
		ui,
		session,
		settingsManager,
		editor,
		editorContainer,
		themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => "dark" },
		hideThinkingBlock: false,
		showSelector,
		disposeActiveSelector,
	};
	const press = (...inputs: string[]) => {
		for (const input of inputs) terminal.sendInput(input);
		if ("flushActions" in ui && typeof ui.flushActions === "function") ui.flushActions();
		ui.renderNow();
	};
	const refresh = vi.spyOn(runtime, "refresh");
	ui.start();
	try {
		showSettings.call(host);
		press(..."Subagent model", "\r");
		expect((await terminal.flushAndGetViewport()).join("\n")).toContain("Inherit caller");
		press(..."defaults-ui/child", "\r");
		await settingsManager.flush();
		expect(settingsManager.getSubagentModel()).toBe("defaults-ui/child");
		press("\x1b");
		expect(editor.focused).toBe(true);
		showSettings.call(host);
		press(..."Subagent effort", "\r", ...Array<string>(5).fill("\x1b[B"), "\r");
		await settingsManager.flush();
		expect(settingsManager.getSubagentThinkingLevel()).toBe("high");
		press("\x1b");
		expect(editor.getValue()).toBe("retained root draft");
		expect(session.model?.id).toBe("root");
		expect(session.thinkingLevel).toBe("medium");
		expect(refresh).not.toHaveBeenCalled();
		expect(faux.state.callCount).toBe(0);
		const reopened = SettingsManager.create(cwd, agentDir);
		expect(reopened.getSubagentModel()).toBe("defaults-ui/child");
		expect(reopened.getSubagentThinkingLevel()).toBe("high");
		const captures: Array<{ model: string; effort: string | undefined }> = [];
		faux.setResponses([
			(context, options, _state, model) => {
				expect(JSON.stringify(context.messages)).toContain("/root/worker");
				captures.push({ model: model.id, effort: options?.reasoning });
				return fauxAssistantMessage("done");
			},
		]);
		await session.agent.state.tools
			.find((tool) => tool.name === "spawn_agent")!
			.execute(randomUUID(), spawnArgs("worker", "test settings"));
		await vi.waitFor(() => expect(captures).toEqual([{ model: "child", effort: "high" }]));
	} finally {
		refresh.mockRestore();
		ui.stop({ preserveScreen: true });
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await settingsManager.flush();
		await rm(cwd, { recursive: true, force: true });
	}
});
