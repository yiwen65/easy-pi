import { type Component, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { GrokChromeTheme } from "../grok-component-factory.ts";

export interface GrokEditorFrameOptions {
	theme: GrokChromeTheme;
}

function isEditorBorder(line: string): boolean {
	return /^─+$/.test(stripTerminalSequences(line).trim());
}

export class GrokEditorFrame implements Component {
	private editorHost: Component;
	private readonly theme: GrokChromeTheme;

	constructor(editorHost: Component, options: GrokEditorFrameOptions) {
		this.editorHost = editorHost;
		this.theme = options.theme;
	}

	setEditorHost(editorHost: Component): void {
		this.editorHost = editorHost;
	}

	getEditorHost(): Component {
		return this.editorHost;
	}

	handleInput(data: string): void {
		this.editorHost.handleInput?.(data);
	}

	invalidate(): void {
		this.editorHost.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth < 4) return [this.theme.border("─".repeat(safeWidth))];

		const interiorWidth = safeWidth - 2;
		const prompt = "❯ ";
		const promptWidth = visibleWidth(prompt);
		const hostWidth = Math.max(1, interiorWidth - promptWidth);
		const hostLines = this.editorHost.render(hostWidth).filter((line) => !isEditorBorder(line));
		const contentLines = hostLines.length > 0 ? hostLines : [""];
		const top = this.theme.border(`╭${"─".repeat(interiorWidth)}╮`);
		const body = contentLines.map((line, index) => {
			const prefix = index === 0 ? this.theme.accent(prompt) : " ".repeat(promptWidth);
			const fitted = sliceByColumn(line, 0, hostWidth, true);
			const padding = " ".repeat(Math.max(0, hostWidth - visibleWidth(fitted)));
			return `${this.theme.border("│")}${prefix}${fitted}${padding}${this.theme.border("│")}`;
		});
		const bottom = this.theme.border(`╰${"─".repeat(interiorWidth)}╯`);
		return [top, ...body, bottom];
	}
}
