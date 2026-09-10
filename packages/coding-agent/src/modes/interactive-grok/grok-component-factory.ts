import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { theme } from "../interactive/theme/theme.ts";
import { GrokEditorFrame } from "./components/grok-editor-frame.ts";
import { GrokFooter } from "./components/grok-footer.ts";
import { type GrokRenderDriver, GrokStatsBar } from "./components/grok-stats-bar.ts";
import { GrokStatus, type GrokStatusState } from "./components/grok-status.ts";
import { type GrokLocation, GrokTopBar } from "./components/grok-top-bar.ts";
import {
	createGrokInteractiveView,
	type GrokInteractiveView,
	type GrokInteractiveViewOptions,
} from "./grok-interactive-view.ts";

export interface GrokChromeTheme {
	text: (text: string) => string;
	accent: (text: string) => string;
	muted: (text: string) => string;
	dim: (text: string) => string;
	border: (text: string) => string;
	success: (text: string) => string;
	warning: (text: string) => string;
	error: (text: string) => string;
	thinkingLevel: (level: ThinkingLevel, text: string) => string;
}

export function createDefaultGrokChromeTheme(overrides: Partial<GrokChromeTheme> = {}): GrokChromeTheme {
	return {
		text: (text) => theme.fg("text", text),
		accent: (text) => theme.fg("accent", text),
		muted: (text) => theme.fg("muted", text),
		dim: (text) => theme.fg("dim", text),
		border: (text) => theme.fg("borderMuted", text),
		success: (text) => theme.fg("success", text),
		warning: (text) => theme.fg("warning", text),
		error: (text) => theme.fg("error", text),
		thinkingLevel: (level, text) => theme.getThinkingBorderColor(level)(text),
		...overrides,
	};
}

export class GrokComponentFactory {
	readonly theme: GrokChromeTheme;

	constructor(themeOverrides: Partial<GrokChromeTheme> = {}) {
		this.theme = createDefaultGrokChromeTheme(themeOverrides);
	}

	createTopBar(location: GrokLocation, contextPercent: number | null = null): GrokTopBar {
		return new GrokTopBar(location, contextPercent, this.theme);
	}

	createStatus(state: GrokStatusState = { kind: "idle", label: "Ready" }): GrokStatus {
		return new GrokStatus(state, this.theme);
	}

	createEditorFrame(editorHost: Component, session?: AgentSession): GrokEditorFrame {
		return new GrokEditorFrame(editorHost, { theme: this.theme, session });
	}

	createStatsBar(session: AgentSession, ui?: GrokRenderDriver): GrokStatsBar {
		return new GrokStatsBar(session, this.theme, ui);
	}

	createFooter(footerData?: ReadonlyFooterDataProvider): GrokFooter {
		return new GrokFooter(this.theme, footerData);
	}

	createInteractiveView(options: Omit<GrokInteractiveViewOptions, "theme">): GrokInteractiveView {
		return createGrokInteractiveView({ ...options, theme: this.theme });
	}
}
