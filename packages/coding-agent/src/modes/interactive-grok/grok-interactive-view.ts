import { type Component, Container, VStack } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { GrokEditorFrame } from "./components/grok-editor-frame.ts";
import { GrokFooter } from "./components/grok-footer.ts";
import { type GrokRenderDriver, GrokStatsBar } from "./components/grok-stats-bar.ts";
import { GrokStatus, type GrokStatusState } from "./components/grok-status.ts";
import { type GrokLocation, GrokTopBar } from "./components/grok-top-bar.ts";
import type { GrokChromeTheme } from "./grok-component-factory.ts";

export interface GrokInteractiveViewOptions {
	document: Component;
	transcriptViewport: Component;
	editorHost: Component;
	location: GrokLocation;
	contextPercent: number | null;
	/** When provided, a stats bar with native Pi token/model info is mounted. */
	session?: AgentSession;
	/** Render driver for flash/pulse animations. Omit for a fully static chrome. */
	ui?: GrokRenderDriver;
	status?: GrokStatusState;
	footerData?: ReadonlyFooterDataProvider;
	pendingMessages?: Component;
	beforeEditor?: readonly Component[];
	afterEditor?: readonly Component[];
	theme: GrokChromeTheme;
}

export class GrokInteractiveView {
	readonly topBar: GrokTopBar;
	readonly status: GrokStatus;
	readonly editorFrame: GrokEditorFrame;
	readonly statsBar: GrokStatsBar | undefined;
	readonly footer: GrokFooter;
	private readonly statusSlot: Container;
	readonly regularComponents: readonly Component[];
	readonly fullscreenRoot: Component;

	constructor(options: GrokInteractiveViewOptions) {
		const theme = options.theme;
		this.topBar = new GrokTopBar(options.location, options.contextPercent, theme);
		this.status = new GrokStatus(options.status ?? { kind: "idle", label: "Ready" }, theme, { ui: options.ui });
		this.editorFrame = new GrokEditorFrame(options.editorHost, { theme });
		this.statsBar = options.session
			? new GrokStatsBar(options.session, theme, options.footerData, options.ui)
			: undefined;
		this.footer = new GrokFooter(theme, options.footerData);
		this.statusSlot = new Container();
		this.statusSlot.addChild(this.status);

		const pending = options.pendingMessages ? [options.pendingMessages] : [];
		const before = [...(options.beforeEditor ?? [])];
		const after = [...(options.afterEditor ?? [])];
		const stats = this.statsBar ? [this.statsBar] : [];
		const dock = new VStack([
			...pending.map((component) => ({ component, shrink: 1, minSize: 0 })),
			{ component: this.statusSlot, shrink: 1, minSize: 0 },
			...before.map((component) => ({ component, shrink: 1, minSize: 0 })),
			{ component: this.editorFrame, shrink: 1, minSize: 3 },
			...stats.map((component) => ({ component, shrink: 1, minSize: 1 })),
			...after.map((component) => ({ component, shrink: 1, minSize: 0 })),
			{ component: this.footer, shrink: 1, minSize: 0 },
		]);
		this.fullscreenRoot = new VStack([
			{ component: this.topBar, basis: 1, grow: 0, shrink: 0, minSize: 1 },
			{ component: options.transcriptViewport, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		this.regularComponents = [
			this.topBar,
			options.document,
			...pending,
			this.statusSlot,
			...before,
			this.editorFrame,
			...stats,
			...after,
			this.footer,
		];
	}

	setEditorHost(editorHost: Component): void {
		this.editorFrame.setEditorHost(editorHost);
	}

	setLocation(location: GrokLocation): void {
		this.topBar.setLocation(location);
	}

	setContextPercent(percent: number | null): void {
		this.topBar.setContextPercent(percent);
	}

	setSession(session: AgentSession): void {
		this.statsBar?.setSession(session);
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.statsBar?.setAutoCompactEnabled(enabled);
	}

	setStatus(status: GrokStatusState): void {
		this.status.setState(status);
	}

	setStatusComponent(component?: Component): void {
		this.status.setActive(component === undefined);
		this.statusSlot.clear();
		this.statusSlot.addChild(component ?? this.status);
	}

	setStatusVisible(visible: boolean): void {
		this.status.setActive(visible);
		this.statusSlot.clear();
		if (visible) this.statusSlot.addChild(this.status);
	}

	setFooterVisible(visible: boolean): void {
		this.footer.setVisible(visible);
	}

	dispose(): void {
		this.status.dispose();
		this.statsBar?.dispose();
	}
}

export function createGrokInteractiveView(options: GrokInteractiveViewOptions): GrokInteractiveView {
	return new GrokInteractiveView(options);
}
