import { type Component, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GrokChromeTheme } from "../grok-component-factory.ts";
import { renderContextMeter } from "./grok-context-meter.ts";

function truncateFromLeft(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";
	const keep = width - 1;
	return `…${sliceByColumn(text, Math.max(0, visibleWidth(text) - keep), keep, true)}`;
}

function singleLine(text: string): string {
	return text.replaceAll("\n", " ");
}

export interface GrokLocation {
	/** Pre-formatted display path (e.g. `~/Projects/wiki`). */
	path: string;
	branch?: string | null;
	sessionName?: string | null;
}

/**
 * Grok top bar: left shows the workspace location (path, git branch, session
 * name), right shows a color-coded context usage meter.
 */
export class GrokTopBar implements Component {
	private location: GrokLocation;
	private contextPercent: number | null;
	private readonly theme: GrokChromeTheme;

	constructor(location: GrokLocation, contextPercent: number | null, theme: GrokChromeTheme) {
		this.location = { ...location };
		this.contextPercent = contextPercent;
		this.theme = theme;
	}

	setLocation(location: GrokLocation): void {
		this.location = { ...location };
	}

	setContextPercent(percent: number | null): void {
		this.contextPercent = percent;
	}

	invalidate(): void {
		// The component has no render cache.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const meter = renderContextMeter(this.contextPercent, this.theme);
		const meterWidth = visibleWidth(meter);
		const leftWidth = Math.max(0, safeWidth - meterWidth - 1);
		const left = this.renderLocation(leftWidth);
		const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(left) - meterWidth));
		return [`${left}${padding}${meter}`];
	}

	private renderLocation(width: number): string {
		const path = singleLine(this.location.path);
		const branch = this.location.branch ? ` (${singleLine(this.location.branch)})` : "";
		const sessionName = this.location.sessionName ? ` • ${singleLine(this.location.sessionName)}` : "";
		const suffixWidth = visibleWidth(branch) + visibleWidth(sessionName);

		if (visibleWidth(path) + suffixWidth <= width) {
			return this.styleLocation(path, branch, sessionName);
		}

		// Shrink the path from the left so the branch/session suffix survives.
		const pathWidth = width - suffixWidth;
		if (pathWidth > 0) {
			return this.styleLocation(truncateFromLeft(path, pathWidth), branch, sessionName);
		}
		// Even the suffix does not fit: fall back to truncating the plain text.
		return this.theme.text(
			truncateToWidth(singleLine(`${path}${branch}${sessionName}`).trim(), Math.max(1, width), "…"),
		);
	}

	private styleLocation(path: string, branch: string, sessionName: string): string {
		return `${this.theme.text(path)}${branch ? this.theme.accent(branch) : ""}${
			sessionName ? this.theme.muted(sessionName) : ""
		}`;
	}
}
