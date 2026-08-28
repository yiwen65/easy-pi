import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GrokChromeTheme } from "../grok-component-factory.ts";

export type GrokStatusKind = "idle" | "working" | "success" | "warning" | "error";

export interface GrokStatusState {
	kind: GrokStatusKind;
	label: string;
	detail?: string;
}

export interface GrokStatusOptions {
	reserveLine?: boolean;
}

export class GrokStatus implements Component {
	private state: GrokStatusState;
	private readonly theme: GrokChromeTheme;
	private readonly reserveLine: boolean;

	constructor(state: GrokStatusState, theme: GrokChromeTheme, options: GrokStatusOptions = {}) {
		this.state = { ...state };
		this.theme = theme;
		this.reserveLine = options.reserveLine ?? false;
	}

	setState(state: GrokStatusState): void {
		this.state = { ...state };
	}

	setLabel(label: string, detail = this.state.detail): void {
		this.state = { ...this.state, label, ...(detail === undefined ? {} : { detail }) };
	}

	invalidate(): void {
		// The component has no render cache.
	}

	render(width: number): string[] {
		if (this.state.kind === "idle") return this.reserveLine ? [""] : [];

		const safeWidth = Math.max(1, Math.floor(width));
		const marker = "●";
		const markerStyle =
			this.state.kind === "error"
				? this.theme.error
				: this.state.kind === "warning"
					? this.theme.warning
					: this.state.kind === "success"
						? this.theme.success
						: this.theme.accent;
		const label = `${marker} ${this.state.label.replaceAll("\n", " ")}`;
		const detail = this.state.detail?.replaceAll("\n", " ") ?? "";
		const detailWidth = Math.min(visibleWidth(detail), Math.max(0, Math.floor(safeWidth / 2)));
		const fittedDetail = truncateToWidth(detail, detailWidth);
		const labelWidth = Math.max(0, safeWidth - visibleWidth(fittedDetail) - (fittedDetail ? 1 : 0));
		const fittedLabel = truncateToWidth(label, labelWidth);
		const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(fittedLabel) - visibleWidth(fittedDetail)));
		const markerWidth = Math.min(1, visibleWidth(fittedLabel));
		const labelTail = sliceLabelTail(fittedLabel, markerWidth);
		return [
			`${markerStyle(fittedLabel.slice(0, markerWidth))}${this.theme.muted(labelTail)}${padding}${this.theme.dim(fittedDetail)}`,
		];
	}
}

function sliceLabelTail(label: string, markerWidth: number): string {
	return markerWidth === 0 ? "" : label.slice(markerWidth);
}
