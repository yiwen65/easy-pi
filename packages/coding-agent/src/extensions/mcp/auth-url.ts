import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { getTextOutput } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";

/** Small, wrapped URL view with a configurable copy action and no external rendering assets. */
export class AuthUrlComponent implements Component {
	private readonly tui: TUI;
	private readonly url: string;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private message = "";

	constructor(tui: TUI, url: string, theme: Theme, keybindings: KeybindingsManager) {
		this.tui = tui;
		this.url = url;
		this.theme = theme;
		this.keybindings = keybindings;
	}

	async copy(): Promise<void> {
		try {
			await copyToClipboard(this.url);
			this.message = "Copied authorization URL";
		} catch {
			this.message = "Could not copy; select the URL manually";
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const keys = this.keybindings.getKeys("app.message.copy").join("/");
		const safeUrl = getTextOutput({ content: [{ type: "text", text: this.url }] }, false);
		return new Text(
			`${this.theme.fg("accent", safeUrl)}\n${this.theme.fg("dim", this.message || `${keys} copy URL`)}`,
			1,
			0,
		).render(width);
	}

	invalidate(): void {}
}
