import { Container, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ImageDecision } from "../src/core/images/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { TurnTranscriptContainer } from "../src/modes/interactive/components/turn-transcript-container.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createImagePng } from "./helpers/image-fixtures.ts";

const canonical = `image_${"a".repeat(24)}`;
function fixture(decisions: ImageDecision[] = []) {
	const manager = SessionManager.inMemory();
	const original = { type: "image" as const, mimeType: "image/png", data: createImagePng(8, 4).toString("base64") };
	const attached = manager.attachImageSource(
		{ ...original, data: createImagePng(4, 4).toString("base64") },
		original,
		{ originalWidth: 8, originalHeight: 4, width: 4, height: 4 },
	);
	manager.appendMessage({ role: "user", content: [attached], timestamp: 1 });
	const ui = new TuiMainScreen(new VirtualTerminal());
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
	const chat = new TurnTranscriptContainer();
	ui.addChild(chat);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	const session = {
		sessionManager: manager,
		settingsManager: { getShowImages: () => true, getImageWidthCells: () => 60 },
		getImageDecisions: () => decisions,
		getImageSelection: () => ({ omitImageIds: [] }),
		setImageSelection: vi.fn(),
		prompt: vi.fn(),
	};
	const mode = Object.assign(
		Object.create(InteractiveMode.prototype) as {
			setupEditorSubmitHandler(): void;
			handleImagesCommand(text: string): Promise<void>;
		},
		{
			runtimeHost: { session },
			ui,
			renderer: ui,
			keybindings,
			editor,
			defaultEditor: editor,
			editorContainer,
			chatContainer: chat,
			editorGeneration: 0,
			pendingUserInputs: [],
			showError: vi.fn(),
			showExtensionConfirm: vi.fn().mockResolvedValue(true),
		},
	);
	mode.setupEditorSubmitHandler();
	const render = () => stripAnsi(chat.render(140).join("\n"));
	const submit = (command: string) => {
		editor.setText(command);
		editor.handleInput("\r");
	};
	return { mode, manager, editor, session, chat, render, submit, original };
}
beforeEach(() => initTheme("dark"));
afterEach(() => setKeybindings(new KeybindingsManager()));

describe("interactive /images command consumer", () => {
	it("registers discovery/usage and renders all evidence stages without hiding nonselectable source/wire facts", async () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "images")).toMatchObject({
			argumentHint: expect.stringContaining("source <ID/prefix>"),
		});
		const { session, submit, render, editor } = fixture([
			{ imageId: "image_sourcehash", stage: "accepted", inputBytes: 90, reason: "received locally" },
			{
				imageId: canonical,
				stage: "prepared",
				protected: true,
				inputBytes: 90,
				encodedBytes: 80,
				width: 4,
				height: 4,
			},
			{
				imageId: `image_${"b".repeat(24)}`,
				stage: "omitted",
				protected: false,
				code: "image_budget",
				reason: "older tool image group",
			},
			{
				imageId: "wire:contents[0].image",
				stage: "serialized",
				encodedBytes: 80,
				reason: "local wire validation only",
			},
		]);
		submit("/images");
		await vi.waitFor(() => expect(render()).toContain("Remote image receipt: UNVERIFIED"));
		for (const text of [
			"accepted",
			"prepared",
			"serialized",
			"omitted",
			"canonical protected",
			"canonical historical",
			"source/wire fact; not selectable",
			"source 90 B",
			"inline 80 Base64 B",
			"image_budget",
		])
			expect(render()).toContain(text);
		expect(editor.getText()).toBe("");
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("lists and previews an in-memory original through editor submission, without canonical/provider mutations", async () => {
		const { mode, manager, session, submit, render, chat, original } = fixture();
		const entries = JSON.stringify(manager.getEntries());
		submit("/images sources");
		await vi.waitFor(() => expect(render()).toContain("Original attachments on the active branch"));
		const sourceId = /[a-f0-9]{64}/.exec(render())![0];
		expect(render()).toContain("8×4 → 4×4 px");
		expect(render()).not.toContain(original.data);
		submit(`/images source ${sourceId.slice(0, 8)}`);
		await vi.waitFor(() => expect(render()).toContain("Local original preview"));
		expect(render()).toContain(`source ${Buffer.from(original.data, "base64").length} B`);
		expect(render()).toContain("not a tool execution or provider message");
		expect(render()).toContain("CSS/DPR coordinates are not inferred");
		const count = chat.children.length;
		submit(`/images source ${sourceId}`);
		await vi.waitFor(() => expect(chat.children.length).toBe(count));
		expect(JSON.stringify(manager.getEntries())).toBe(entries);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("rejects another branch's original and arbitrary hashes locally", async () => {
		const { mode, manager, session, submit } = fixture();
		manager.resetLeaf();
		submit(`/images source ${"a".repeat(64)}`);
		await vi.waitFor(() => expect(mode.showError).toHaveBeenCalledWith(expect.stringContaining("storage_missing")));
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("does not apply a confirmation to a branch that changed while the dialog was open", async () => {
		const { mode, manager, session } = fixture();
		let confirm!: (value: boolean) => void;
		mode.showExtensionConfirm.mockReturnValue(
			new Promise<boolean>((resolve) => {
				confirm = resolve;
			}),
		);
		const pending = mode.handleImagesCommand(`/images omit ${canonical}`);
		manager.resetLeaf();
		confirm(true);
		await pending;
		expect(session.setImageSelection).not.toHaveBeenCalled();
	});
});
