import {
	type Component,
	Container,
	ScrollView,
	type StackEntryOptions,
	stripTerminalSequences,
	truncateToWidth,
	VStack,
} from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { GrokEditorFrame } from "./components/grok-editor-frame.ts";
import { GrokFooter } from "./components/grok-footer.ts";
import { GrokJumpToBottom } from "./components/grok-jump-to-bottom.ts";
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
	/** Render driver for stats-bar flash animations. Omit for fully static stats. */
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
	private readonly ui: GrokRenderDriver | undefined;
	private transientStatusTimer: ReturnType<typeof setTimeout> | undefined;
	readonly regularComponents: readonly Component[];
	readonly fullscreenRoot: Component;

	constructor(options: GrokInteractiveViewOptions) {
		const theme = options.theme;
		this.topBar = new GrokTopBar(options.location, options.contextPercent, theme);
		this.ui = options.ui;
		this.status = new GrokStatus(options.status ?? { kind: "idle", label: "Ready" }, theme, { reserveLine: true });
		this.editorFrame = new GrokEditorFrame(options.editorHost, { theme, session: options.session });
		this.statsBar = options.session ? new GrokStatsBar(options.session, theme, options.ui) : undefined;
		this.footer = new GrokFooter(theme, options.footerData);
		this.statusSlot = new Container();
		this.statusSlot.addChild(this.status);

		const pending = options.pendingMessages ? [options.pendingMessages] : [];
		const before = [...(options.beforeEditor ?? [])];
		const after = [...(options.afterEditor ?? [])];
		const stats = this.statsBar ? [this.statsBar] : [];
		const jumpToBottom =
			options.transcriptViewport instanceof ScrollView
				? [new GrokJumpToBottom(options.transcriptViewport, theme)]
				: [];
		// The regular frame retains complete metadata. Fullscreen switches to compact
		// chrome before wrapped model/footer rows can displace the transcript or input.
		const roomy: NonNullable<StackEntryOptions["visible"]> = ({ width, height }) => width >= 24 && height >= 12;
		const short: NonNullable<StackEntryOptions["visible"]> = ({ height }) => height < 12;
		const narrow: NonNullable<StackEntryOptions["visible"]> = ({ width, height }) => width < 24 && height >= 12;
		const compactInput: Component = {
			render: (width) => this.editorFrame.renderCompactInput(width),
			invalidate: () => this.editorFrame.invalidate(),
		};
		const compactMetadata: Component = {
			render: (width) => this.editorFrame.renderCompactMetadata(width),
			invalidate: () => {},
		};
		const roomyStatus: Component = {
			render: (width) => {
				const lines = this.statusSlot.render(width);
				// Native Loader status starts with decoration. If allocation shrinks to
				// one row it must still show the authoritative label, not a blank.
				const start = lines.findIndex((line) => stripTerminalSequences(line).trim());
				return start < 0 ? [] : lines.slice(start);
			},
			invalidate: () => this.statusSlot.invalidate(),
		};
		const compactStatus: Component = {
			render: (width) => {
				const lines = this.statusSlot.children.flatMap((component) =>
					component === this.status ? this.status.render(width, false) : component.render(width),
				);
				// Runtime retry/compaction indicators are authoritative, but include padding
				// and may wrap. Keep their label in one row so they cannot displace input.
				const label = lines.filter((line) => stripTerminalSequences(line).trim()).join(" · ");
				return label ? [truncateToWidth(label, width, "…")] : [];
			},
			invalidate: () => this.statusSlot.invalidate(),
		};
		const oneRow = (component: Component): Component => ({
			render: (width) => {
				const lines = component.render(width);
				return lines.length ? [truncateToWidth(lines.join(" "), width, "…")] : [];
			},
			invalidate: () => component.invalidate(),
		});
		const compactJump = jumpToBottom.map(
			(component): Component => ({
				render: (width) => component.render(width).filter((line) => line.trim().length > 0),
				invalidate: () => component.invalidate(),
				handleClick: (row, col) => component.handleClick(row, col),
			}),
		);
		const compactDock = (compressMetadata: boolean) =>
			new VStack([
				...pending.map((component) => ({ component, shrink: 1, minSize: 0 })),
				{ component: compactStatus, shrink: 0 },
				...before.map((component) => ({ component, shrink: 1, minSize: 0 })),
				...compactJump.map((component) => ({ component, shrink: 1, minSize: 0 })),
				{ component: compactInput, shrink: 1, minSize: 1 },
				{ component: compactMetadata, shrink: 1, minSize: 0 },
				...stats.map((component) => ({
					component: compressMetadata ? oneRow(component) : component,
					shrink: 1,
					minSize: 0,
				})),
				...after.map((component) => ({ component, shrink: 1, minSize: 0 })),
				{ component: compressMetadata ? oneRow(this.footer) : this.footer, shrink: 1, minSize: 0 },
			]);
		const dock = new VStack([
			...pending.map((component) => ({ component, shrink: 1, minSize: 0 })),
			{ component: roomyStatus, shrink: 1, minSize: 1, visible: () => this.statusSlot.children.length > 0 },
			...before.map((component) => ({ component, shrink: 1, minSize: 0 })),
			...jumpToBottom.map((component) => ({ component, basis: 1, shrink: 0, minSize: 1 })),
			{ component: this.editorFrame, shrink: 1, minSize: 3 },
			...stats.map((component) => ({ component, shrink: 1, minSize: 0 })),
			...after.map((component) => ({ component, shrink: 1, minSize: 0 })),
			{ component: this.footer, shrink: 1, minSize: 0 },
		]);
		this.fullscreenRoot = new VStack([
			{ component: this.topBar, basis: 1, grow: 0, shrink: 0, minSize: 1, visible: ({ height }) => height >= 8 },
			{ component: options.transcriptViewport, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 3, visible: roomy },
			{ component: compactDock(true), basis: "auto", grow: 0, shrink: 1, minSize: 2, visible: short },
			{ component: compactDock(false), basis: "auto", grow: 0, shrink: 1, minSize: 2, visible: narrow },
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

	setEditorBorderColor(borderColor: (text: string) => string): void {
		this.editorFrame.setBorderColor(borderColor);
	}

	setLocation(location: GrokLocation): void {
		this.topBar.setLocation(location);
	}

	setContextPercent(percent: number | null): void {
		this.topBar.setContextPercent(percent);
	}

	setSession(session: AgentSession): void {
		this.editorFrame.setSession(session);
		this.statsBar?.setSession(session);
	}

	setStatus(status: GrokStatusState): void {
		this.status.setState(status);
	}

	showTransientStatus(label: string, durationMs = 900): void {
		if (this.transientStatusTimer) clearTimeout(this.transientStatusTimer);
		this.status.setState({ kind: "success", label });
		this.setStatusComponent();
		this.ui?.requestRender();
		this.transientStatusTimer = setTimeout(() => {
			this.transientStatusTimer = undefined;
			this.status.setState({ kind: "idle", label: "" });
			this.ui?.requestRender();
		}, durationMs);
		this.transientStatusTimer.unref?.();
	}

	setStatusComponent(component?: Component): void {
		this.statusSlot.clear();
		this.statusSlot.addChild(component ?? this.status);
	}

	setStatusVisible(visible: boolean): void {
		this.statusSlot.clear();
		if (visible) this.statusSlot.addChild(this.status);
	}

	setFooterVisible(visible: boolean): void {
		this.footer.setVisible(visible);
	}

	dispose(): void {
		if (this.transientStatusTimer) {
			clearTimeout(this.transientStatusTimer);
			this.transientStatusTimer = undefined;
		}
		this.statsBar?.dispose();
	}
}

export function createGrokInteractiveView(options: GrokInteractiveViewOptions): GrokInteractiveView {
	return new GrokInteractiveView(options);
}
