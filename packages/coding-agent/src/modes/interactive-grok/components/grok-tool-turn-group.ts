import { Container, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../../interactive/theme/theme.ts";
import { flattenInline, marqueeWindow } from "./grok-marquee.ts";
import { GrokToolExecutionComponent } from "./grok-tool-execution.ts";

const TICK_INTERVAL_MS = 120;

/**
 * Grok turn-level container for tool executions.
 *
 * All tool calls of one turn (user prompt → final answer) live in a single
 * group. Collapsed — the default — the group renders exactly one line: while
 * tools are running it shows the current tool with a live horizontally
 * scrolling arg summary; once the turn settles it shows the last tool plus a
 * count suffix. A click on that line expands the group into one overview row
 * per tool (level 1); clicking a tool row toggles that tool's full details
 * (level 2, handled by GrokToolExecutionComponent itself).
 */
export class GrokToolTurnGroupComponent extends Container {
	private groupExpanded = false;
	private tick = 0;
	private tickerInterval: ReturnType<typeof setInterval> | undefined;
	private readonly ui?: TUI;

	constructor(ui?: TUI) {
		super();
		this.ui = ui;
	}

	addTool(component: GrokToolExecutionComponent): void {
		this.addChild(component);
		this.syncTicker();
	}

	get toolCount(): number {
		return this.tools().length;
	}

	isGroupExpanded(): boolean {
		return this.groupExpanded;
	}

	private tools(): GrokToolExecutionComponent[] {
		return this.children.filter(
			(child): child is GrokToolExecutionComponent => child instanceof GrokToolExecutionComponent,
		);
	}

	/** Latest tool that is still streaming args or executing. */
	private activeTool(): GrokToolExecutionComponent | undefined {
		const tools = this.tools();
		for (let i = tools.length - 1; i >= 0; i--) {
			const state = tools[i]?.getGrokState();
			if (state === "running" || state === "pending") {
				return tools[i];
			}
		}
		return undefined;
	}

	/** Expandable hook: the global toggle expands the group and every tool. */
	setExpanded(expanded: boolean): void {
		this.groupExpanded = expanded;
		for (const tool of this.tools()) {
			tool.setExpanded(expanded);
		}
		this.syncTicker();
	}

	/** Forward image settings to the grouped tool components. */
	setShowImages(show: boolean): void {
		for (const tool of this.tools()) {
			tool.setShowImages(show);
		}
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools()) {
			tool.setImageWidthCells(width);
		}
	}

	/**
	 * Handle a transcript click at a group-local row. Collapsed: row 0 expands
	 * the group. Expanded: the click is forwarded to the tool owning that row.
	 */
	handleOverviewClick(localRow: number, width: number): boolean {
		if (!this.groupExpanded) {
			if (localRow !== 0) return false;
			this.groupExpanded = true;
			this.syncTicker();
			return true;
		}
		if (localRow === 0) {
			this.groupExpanded = false;
			for (const tool of this.tools()) {
				tool.setExpanded(false);
			}
			this.syncTicker();
			return true;
		}
		let cursor = 1;
		for (const tool of this.tools()) {
			const height = tool.render(width).length;
			if (localRow >= cursor && localRow < cursor + height) {
				return tool.handleOverviewClick(localRow - cursor);
			}
			cursor += height;
		}
		return false;
	}

	/** Stop the ticker. Called when the group leaves the transcript. */
	dispose(): void {
		this.stopTicker();
	}

	private tickerActive(): boolean {
		return this.ui !== undefined && !this.groupExpanded && this.activeTool() !== undefined;
	}

	private stopTicker(): void {
		if (this.tickerInterval) {
			clearInterval(this.tickerInterval);
			this.tickerInterval = undefined;
		}
	}

	private syncTicker(): void {
		if (this.tickerActive() && !this.tickerInterval) {
			this.tickerInterval = setInterval(() => {
				this.tick++;
				if (!this.tickerActive()) {
					this.stopTicker();
					return;
				}
				this.ui?.requestRender();
			}, TICK_INTERVAL_MS);
			(this.tickerInterval as { unref?: () => void }).unref?.();
		} else if (!this.tickerActive() && this.tickerInterval) {
			this.stopTicker();
		}
	}

	/** Collapsed line while a tool is active: fixed prefix + scrolling args. */
	private activeLine(tool: GrokToolExecutionComponent, width: number): string {
		const symbol = tool.stateSymbol();
		const name = tool.getGrokToolName();
		const prefix = theme.fg(tool.stateColor(), `${symbol} `) + theme.fg("toolTitle", theme.bold(name));
		const prefixWidth = visibleWidth(`${symbol} ${name}`);
		const summary = flattenInline(tool.summarizeCurrentArgs());
		if (!summary) {
			return truncateToWidth(prefix, width, "");
		}
		const gap = "  ";
		const windowWidth = width - prefixWidth - visibleWidth(gap);
		if (windowWidth <= 0) {
			return truncateToWidth(prefix, width, "");
		}
		const scrolled = marqueeWindow(summary, windowWidth, this.tick);
		return truncateToWidth(prefix + theme.fg("muted", gap + scrolled), width, "");
	}

	/** Collapsed line once the turn settled: last tool + aggregate count. */
	private settledLine(width: number): string {
		const tools = this.tools();
		const last = tools[tools.length - 1];
		if (!last) return "";
		// Never hide a failed call behind a later successful tool in the summary.
		const representative = [...tools].reverse().find((tool) => tool.getGrokState() === "error") ?? last;
		if (tools.length === 1) {
			return representative.overviewLine(width);
		}
		const suffixText = ` · ${tools.length} tools`;
		const suffixWidth = visibleWidth(suffixText);
		const base = representative.overviewLine(Math.max(1, width - suffixWidth));
		return truncateToWidth(base + theme.fg("muted", suffixText), width, "");
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		this.syncTicker();
		const active = this.activeTool();
		const summary = active ? this.activeLine(active, width) : this.settledLine(width);
		if (this.groupExpanded) {
			return [summary, ...super.render(width)];
		}
		if (this.toolCount === 0) return [];
		return [summary];
	}
}
