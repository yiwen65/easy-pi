import { Container, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { LiveLineScroller } from "../../interactive/components/live-line-scroller.ts";
import { theme } from "../../interactive/theme/theme.ts";
import { flattenInline } from "./grok-inline-text.ts";
import { GrokToolExecutionComponent } from "./grok-tool-execution.ts";

/**
 * Grok turn-level container for tool executions.
 *
 * All tool calls of one turn (user prompt → final answer) live in a single
 * group. Collapsed — the default — the group renders exactly one row: the tool
 * most recently added to the group (with a count suffix once all tools settle).
 * While its args keep streaming the row shows their head; once nothing changed
 * for a moment the row scrolls the truncated args into view and cycles
 * them, so the full command can be read without expanding. A click on that row
 * expands the group into one overview row per tool (level 1); clicking a tool
 * row toggles that tool's full details (level 2, handled by
 * GrokToolExecutionComponent itself).
 */
export class GrokToolTurnGroupComponent extends Container {
	private readonly scroller: LiveLineScroller;
	private groupExpanded = false;

	constructor(ui?: TUI) {
		super();
		this.scroller = new LiveLineScroller(ui);
	}

	addTool(component: GrokToolExecutionComponent): void {
		this.addChild(component);
	}

	/** Stop automatic scrolling without changing expansion or tool state. */
	completeTurn(): void {
		this.scroller.completeTurn();
	}

	/** Stop the idle scroll timer. Called when the group leaves the transcript. */
	dispose(): void {
		this.scroller.dispose();
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
			return true;
		}
		if (localRow === 0) {
			this.groupExpanded = false;
			for (const tool of this.tools()) {
				tool.setExpanded(false);
			}
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

	/**
	 * Collapsed row: tool symbol, name and args summary; plus the aggregate count
	 * once the turn settled. The summary scrolls its hidden part into view while
	 * the row sits idle.
	 */
	private collapsedLine(width: number): string {
		const tools = this.tools();
		const tool = tools.at(-1);
		if (!tool) return "";
		this.scroller.setText(flattenInline(tool.summarizeCurrentArgs()));

		const settled = this.activeTool() === undefined && tools.length > 1;
		const suffix = settled ? ` · ${tools.length} tools` : "";
		const gap = "  ";
		const head =
			theme.fg(tool.stateColor(), `${tool.stateSymbol()} `) +
			theme.fg("toolTitle", theme.bold(tool.getGrokToolName()));
		const available = Math.max(1, width - visibleWidth(suffix));
		const summaryWidth = Math.max(
			0,
			available - visibleWidth(`${tool.stateSymbol()} ${tool.getGrokToolName()}${gap}`),
		);
		const summary = this.scroller.window(summaryWidth);
		const body = summary ? head + theme.fg("muted", gap + summary) : head;
		return truncateToWidth(body + theme.fg("muted", suffix), width, "");
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const summary = this.collapsedLine(width);
		if (this.groupExpanded) {
			return [summary, ...super.render(width)];
		}
		if (this.toolCount === 0) return [];
		return [summary];
	}
}
