import { Container, type EditorComponent, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { ImageInputError } from "../src/core/images/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
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
	restoreRejectedImageDraft(input: { text: string }, error: unknown): void;
	handleImagesCommand(text: string): Promise<void>;
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
		runtimeHost: {
			session: {
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				sessionManager: SessionManager.inMemory(),
			},
		},
		pendingUserInputs: [] as Array<{ text: string }>,
		flushPendingBashComponents: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
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

	it("restores a rejected normal image draft with its numbered attachment", () => {
		const { mode, editor } = fixture();
		editor.setText("keep normal ");
		const attachment = { type: "image", data: "bad", mimeType: "image/png" };
		editor.insertAttachmentAtCursor("Image", attachment);
		editor.handleInput("\r");
		expect(editor.getText()).toBe("");
		mode.restoreRejectedImageDraft(mode.pendingUserInputs[0], new ImageInputError("invalid_image", "Invalid image"));
		expect(editor.getText()).toBe("keep normal [Image #1]");
		expect(editor.getAttachments()).toEqual([attachment]);
	});

	it("requires confirmation before excluding historical images and supports reset", async () => {
		const { mode } = fixture();
		const setImageSelection = vi.fn();
		const confirm = vi.fn().mockResolvedValue(false);
		Object.assign(mode, { showExtensionConfirm: confirm, showStatus: vi.fn() });
		Object.assign(mode.runtimeHost.session, { setImageSelection });
		const id = `image_${"a".repeat(24)}`;
		await mode.handleImagesCommand(`/images omit ${id}`);
		expect(confirm).toHaveBeenCalledOnce();
		expect(setImageSelection).not.toHaveBeenCalled();
		confirm.mockResolvedValue(true);
		await mode.handleImagesCommand(`/images omit ${id}`);
		expect(setImageSelection).toHaveBeenLastCalledWith([id]);
		await mode.handleImagesCommand("/images reset");
		expect(setImageSelection).toHaveBeenLastCalledWith([]);
	});

	it("restores a rejected streaming image draft with its numbered attachment", async () => {
		const { mode, editor } = fixture();
		Object.assign(mode.runtimeHost.session, {
			isStreaming: true,
			prompt: vi.fn().mockRejectedValue(new ImageInputError("invalid_image", "Invalid image")),
		});
		editor.setText("keep this ");
		const attachment = { type: "image", data: "bad", mimeType: "image/png" };
		editor.insertAttachmentAtCursor("Image", attachment);
		editor.handleInput("\r");
		await vi.waitFor(() => expect(editor.getText()).toBe("keep this [Image #1]"));
		expect(editor.getAttachments()).toEqual([attachment]);
		expect(mode.showError).toHaveBeenCalledWith("Invalid image");
	});

	it("does not restore rejected images over a newer draft", async () => {
		const { mode, editor } = fixture();
		let reject!: (error: Error) => void;
		const prompt = new Promise<void>((_resolve, rej) => {
			reject = rej;
		});
		Object.assign(mode.runtimeHost.session, { isStreaming: true, prompt: vi.fn(() => prompt) });
		editor.setText("old ");
		editor.insertAttachmentAtCursor("Image", { type: "image", data: "bad", mimeType: "image/png" });
		editor.handleInput("\r");
		editor.handleInput("new draft");
		reject(new ImageInputError("invalid_image", "Invalid image"));
		await vi.waitFor(() => expect(mode.showError).toHaveBeenCalled());
		expect(editor.getText()).toBe("new draft");
		expect(editor.getAttachments()).toEqual([]);
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
