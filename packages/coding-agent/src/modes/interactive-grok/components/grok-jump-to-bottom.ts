import { type Component, type ScrollView, visibleWidth } from "@earendil-works/pi-tui";
import type { GrokChromeTheme } from "../grok-component-factory.ts";

/** A fixed-height fullscreen control: hiding it must not move the editor or change the scroll range. */
export class GrokJumpToBottom implements Component {
	private readonly scrollView: ScrollView;
	private readonly theme: GrokChromeTheme;
	private hitStart = 0;
	private hitEnd = 0;

	constructor(scrollView: ScrollView, theme: GrokChromeTheme) {
		this.scrollView = scrollView;
		this.theme = theme;
	}

	invalidate(): void {
		this.hitEnd = 0;
	}

	render(width: number): string[] {
		this.hitEnd = 0;
		if (width <= 0 || this.scrollView.viewportHeight <= 0 || this.scrollView.isAtEnd) return [""];
		const label = width >= 4 ? " ⬇️ " : "↓";
		const labelWidth = visibleWidth(label);
		this.hitStart = Math.max(0, Math.floor((width - labelWidth) / 2));
		this.hitEnd = this.hitStart + labelWidth;
		return [" ".repeat(this.hitStart) + this.theme.accent(label)];
	}

	handleClick(row: number, col: number): boolean {
		if (row !== 0 || col < this.hitStart || col >= this.hitEnd || this.scrollView.isAtEnd) return false;
		this.scrollView.scrollToEnd();
		return true;
	}
}
