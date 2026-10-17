import { Container, type EditorComponent, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const clipboard = vi.hoisted(() => ({
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
	copyToClipboard: vi.fn(),
}));
vi.mock("../src/utils/clipboard.ts", () => ({
	readClipboardText: clipboard.readClipboardText,
	copyToClipboard: clipboard.copyToClipboard,
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({ readClipboardImage: clipboard.readClipboardImage }));

type ModeMethods = {
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	createExtensionUIContext(): ExtensionUIContext;
	handleClipboardPaste(): Promise<void>;
	handleRightClickPaste(): Promise<void>;
	clearEditor(): void;
};

function fixture() {
	const ui = new TuiMainScreen(new VirtualTerminal());
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	ui.setFocus(editor);
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as ModeMethods, {
		ui,
		renderer: ui,
		keybindings,
		editor: editor as EditorComponent,
		defaultEditor: editor,
		editorContainer,
		editorGeneration: 0,
		runtimeHost: { session: { isStreaming: false, isCompacting: false, isBashRunning: false } },
		pendingUserInputs: [] as Array<{ text: string }>,
		flushPendingBashComponents: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showWarning: vi.fn(),
	});
	mode.setupKeyHandlers();
	mode.setupEditorSubmitHandler();
	return { mode, editor, extensionUI: mode.createExtensionUIContext() };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

beforeEach(() => {
	initTheme("dark");
	clipboard.readClipboardImage.mockReset();
	clipboard.readClipboardText.mockReset();
	clipboard.readClipboardText.mockResolvedValue(null);
});
afterEach(() => setKeybindings(new KeybindingsManager()));

const image = { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" };
const mutations = ["clear", "submit", "new session", "editor replacement", "draft ABA", "ordinary edit"] as const;

describe("InteractiveMode async clipboard ownership", () => {
	it.each(["image", "text"] as const)("inserts %s into an unchanged draft", async (kind) => {
		const { mode, editor } = fixture();
		editor.setText("before ");
		clipboard.readClipboardImage.mockResolvedValue(kind === "image" ? image : null);
		clipboard.readClipboardText.mockResolvedValue("clipboard text");
		await mode.handleClipboardPaste();
		expect(editor.getText()).toBe(kind === "image" ? "before [Image #1]" : "before clipboard text");
		expect(editor.getAttachments()).toEqual(
			kind === "image" ? [{ type: "image", mimeType: "image/png", data: "AQID" }] : [],
		);
	});

	it.each(mutations.flatMap((mutation) => (["image", "text"] as const).map((kind) => [mutation, kind] as const)))(
		"ignores clipboard completion after %s (%s)",
		async (mutation, kind) => {
			const { mode, editor, extensionUI } = fixture();
			editor.setText(mutation === "submit" ? "send this" : "");
			const imageRead = deferred<{ bytes: Uint8Array; mimeType: string } | null>();
			const textRead = deferred<string | null>();
			clipboard.readClipboardImage.mockReturnValue(kind === "image" ? imageRead.promise : Promise.resolve(null));
			clipboard.readClipboardText.mockReturnValue(textRead.promise);
			const paste = mode.handleClipboardPaste();
			// Let the text-fallback path reach its second await before mutating the draft.
			await Promise.resolve();
			if (kind === "text") expect(clipboard.readClipboardText).toHaveBeenCalledOnce();
			if (mutation === "clear") mode.clearEditor();
			else if (mutation === "submit") editor.handleInput("\r");
			else if (mutation === "new session") mode.runtimeHost.session = { ...mode.runtimeHost.session };
			else if (mutation === "editor replacement")
				extensionUI.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
			else if (mutation === "draft ABA") {
				extensionUI.setEditorText("temporary");
				extensionUI.setEditorText("");
			} else editor.handleInput("new input");
			const expectedText = mode.editor.getText();
			imageRead.resolve(image);
			textRead.resolve("clipboard text");
			await paste;
			expect(mode.editor.getText()).toBe(expectedText);
			expect(mode.editor.getAttachments?.()).toEqual([]);
			expect(editor.getAttachments()).toEqual([]);
			if (mutation === "submit") expect(mode.pendingUserInputs).toEqual([{ text: "send this" }]);
		},
	);

	it.each(["clear", "submit", "new session"])(
		"ignores right-click paste completion after %s with unchanged focus",
		async (mutation) => {
			const { mode, editor } = fixture();
			const textRead = deferred<string | null>();
			clipboard.readClipboardText.mockReturnValue(textRead.promise);
			if (mutation === "submit") editor.setText("send this");
			const paste = mode.handleRightClickPaste();
			if (mutation === "clear") mode.clearEditor();
			else if (mutation === "submit") editor.handleInput("\r");
			else mode.runtimeHost.session = { ...mode.runtimeHost.session };
			textRead.resolve("clipboard text");
			await paste;
			expect(editor.getText()).toBe("");
		},
	);

	it("does not read fallback text after the image read becomes stale", async () => {
		const { mode } = fixture();
		const pending = deferred<null>();
		clipboard.readClipboardImage.mockReturnValue(pending.promise);
		const paste = mode.handleClipboardPaste();
		mode.clearEditor();
		pending.resolve(null);
		await paste;
		expect(clipboard.readClipboardText).not.toHaveBeenCalled();
	});

	it("a custom editor submit invalidates a pending paste even without an onChange notification", async () => {
		const { mode, extensionUI } = fixture();
		extensionUI.setEditorComponent(() => ({
			getText: () => "",
			setText: vi.fn(),
			handleInput: vi.fn(),
			insertAttachmentAtCursor: vi.fn(),
			render: () => [],
			invalidate: vi.fn(),
		}));
		const pending = deferred<typeof image>();
		clipboard.readClipboardImage.mockReturnValue(pending.promise);
		const paste = mode.handleClipboardPaste();
		mode.editor.onSubmit?.("send this");
		pending.resolve(image);
		await paste;
		expect(mode.editor.insertAttachmentAtCursor).not.toHaveBeenCalled();
		expect(mode.pendingUserInputs).toEqual([{ text: "send this" }]);
	});

	it("warns only for a current custom editor without image attachment support", async () => {
		const { mode, extensionUI } = fixture();
		extensionUI.setEditorComponent(() => ({
			getText: () => "",
			setText: vi.fn(),
			handleInput: vi.fn(),
			render: () => [],
			invalidate: vi.fn(),
		}));
		clipboard.readClipboardImage.mockResolvedValue(image);
		await mode.handleClipboardPaste();
		expect(mode.showWarning).toHaveBeenCalledExactlyOnceWith(
			"The active custom editor does not support image attachments",
		);
	});

	it("ignores clipboard read errors without modifying the draft", async () => {
		const { mode, editor } = fixture();
		editor.setText("unchanged");
		clipboard.readClipboardImage.mockRejectedValue(new Error("unavailable"));
		await expect(mode.handleClipboardPaste()).resolves.toBeUndefined();
		expect(editor.getText()).toBe("unchanged");
		expect(mode.showWarning).not.toHaveBeenCalled();
	});
});
