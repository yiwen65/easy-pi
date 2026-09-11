import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { pastedImagePath, readPastedImage } from "../../../utils/pasted-image.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private imagePasteGeneration = 0;
	private imagePastePending = false;
	private deferredInput: string[] = [];
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	override setText(text: string): void {
		// Draft/session replacement must not receive an earlier asynchronous paste.
		this.imagePasteGeneration++;
		this.imagePastePending = false;
		this.deferredInput = [];
		super.setText(text);
	}

	protected override handlePaste(text: string): void {
		const path = pastedImagePath(text);
		if (!path || this.getText().trimStart().startsWith("!")) {
			super.handlePaste(text);
			return;
		}
		const generation = ++this.imagePasteGeneration;
		this.imagePastePending = true;
		// Preserve input ordering without blocking the UI on filesystem reads.
		let timeout: ReturnType<typeof setTimeout>;
		const deadline = new Promise<undefined>((resolve) => {
			timeout = setTimeout(() => resolve(undefined), 3000);
		});
		void Promise.race([readPastedImage(path), deadline]).then((image) => {
			clearTimeout(timeout);
			if (generation !== this.imagePasteGeneration) return;
			if (image) this.insertAttachmentAtCursor("Image", image);
			else super.handlePaste(text);
			this.imagePastePending = false;
			const queued = this.deferredInput;
			this.deferredInput = [];
			for (const input of queued) this.handleInput(input);
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (this.imagePastePending) {
			this.deferredInput.push(data);
			return;
		}
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
