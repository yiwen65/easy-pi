import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GrokChromeTheme } from "../grok-component-factory.ts";
import type { GrokRenderDriver } from "./grok-stats-bar.ts";

export type GrokStatusKind = "idle" | "working" | "success" | "warning" | "error";

export interface GrokStatusState {
	kind: GrokStatusKind;
	label: string;
	detail?: string;
}

export interface GrokStatusOptions {
	ui?: GrokRenderDriver;
}

const IDLE_PULSE_FRAMES = ["○", "◎"];
const IDLE_PULSE_MS = 900;

export class GrokStatus implements Component {
	private state: GrokStatusState;
	private readonly theme: GrokChromeTheme;
	private readonly ui: GrokRenderDriver | undefined;
	private active = true;
	private pulseFrame = 0;
	private pulseTimer: ReturnType<typeof setInterval> | undefined;

	constructor(state: GrokStatusState, theme: GrokChromeTheme, options: GrokStatusOptions = {}) {
		this.state = { ...state };
		this.theme = theme;
		this.ui = options.ui;
		this.syncPulse();
	}

	setState(state: GrokStatusState): void {
		this.state = { ...state };
		this.syncPulse();
	}

	setLabel(label: string, detail = this.state.detail): void {
		this.state = { ...this.state, label, ...(detail === undefined ? {} : { detail }) };
	}

	/**
	 * Whether the Grok status is the component currently shown in the status
	 * slot. The idle pulse only runs while visible so a hidden status never
	 * drives repaints.
	 */
	setActive(active: boolean): void {
		this.active = active;
		this.syncPulse();
	}

	dispose(): void {
		this.stopPulse();
	}

	invalidate(): void {
		// The component has no render cache.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const marker = this.state.kind === "idle" ? IDLE_PULSE_FRAMES[this.pulseFrame % IDLE_PULSE_FRAMES.length] : "●";
		const markerStyle =
			this.state.kind === "error"
				? this.theme.error
				: this.state.kind === "warning"
					? this.theme.warning
					: this.state.kind === "success"
						? this.theme.success
						: this.state.kind === "working"
							? this.theme.accent
							: this.theme.dim;
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

	private syncPulse(): void {
		const shouldPulse = this.active && this.state.kind === "idle" && this.ui !== undefined;
		if (shouldPulse && !this.pulseTimer) {
			this.pulseTimer = setInterval(() => {
				this.pulseFrame = (this.pulseFrame + 1) % IDLE_PULSE_FRAMES.length;
				this.ui?.requestRender();
			}, IDLE_PULSE_MS);
			this.pulseTimer.unref?.();
		} else if (!shouldPulse) {
			this.stopPulse();
		}
	}

	private stopPulse(): void {
		if (this.pulseTimer) {
			clearInterval(this.pulseTimer);
			this.pulseTimer = undefined;
		}
	}
}

function sliceLabelTail(label: string, markerWidth: number): string {
	return markerWidth === 0 ? "" : label.slice(markerWidth);
}
