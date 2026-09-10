import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GrokChromeTheme } from "../grok-component-factory.ts";
import { renderContextMeter } from "./grok-context-meter.ts";

export interface GrokLocation {
	/** Pre-formatted display path (e.g. `~/Projects/wiki`). */
	path: string;
	branch?: string | null;
	sessionName?: string | null;
}

/**
 * Grok top bar: optional session name on the left, context usage on the right.
 * Workspace paths and git branches are deliberately omitted.
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
		const meter = truncateToWidth(renderContextMeter(this.contextPercent, this.theme), safeWidth, "");
		const meterWidth = visibleWidth(meter);
		const leftWidth = Math.max(0, safeWidth - meterWidth - 1);
		const left = this.theme.muted(
			truncateToWidth((this.location.sessionName ?? "").replaceAll("\n", " "), leftWidth, "…"),
		);
		const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(left) - meterWidth));
		return [`${left}${padding}${meter}`];
	}
}
