import {
	Container,
	Markdown,
	type MarkdownTheme,
	recordRenderedContentClickHandler,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { LiveLineScroller } from "../../interactive/components/live-line-scroller.ts";
import { theme } from "../../interactive/theme/theme.ts";
import { flattenInline } from "./grok-inline-text.ts";

/**
 * One collapsed/expandable Thinking block shared by every assistant message in a turn.
 *
 * Collapsed — the default — the block renders exactly one row: the newest
 * thinking entry, flattened to a single line. Like streaming output, the row
 * keeps the newest text on screen while the entry grows; once the entry stopped
 * changing for a moment the row scrolls the hidden beginning into view and
 * cycles the whole text, so it can be read without expanding. Once the turn
 * completes the row keeps the newest entry visible without scrolling. A click
 * on the row expands the block into the full thinking content of the turn.
 */
export class GrokThinkingTurnGroupComponent extends Container {
	private readonly entries = new Map<object, string>();
	private readonly scroller: LiveLineScroller;
	private readonly markdownTheme: MarkdownTheme;
	private readonly hiddenLabel: string;
	private readonly outputPad: number;
	private readonly userHidden: boolean;
	private expanded = false;
	private markdown: Markdown | undefined;
	private renderedRowCount = 0;
	private disposed = false;

	constructor(markdownTheme: MarkdownTheme, hiddenLabel: string, outputPad: number, userHidden: boolean, ui?: TUI) {
		super();
		this.markdownTheme = markdownTheme;
		this.hiddenLabel = hiddenLabel;
		this.outputPad = outputPad;
		this.userHidden = userHidden;
		this.scroller = new LiveLineScroller(ui, "tail");
	}

	get entryCount(): number {
		return this.entries.size;
	}

	updateThinking(owner: object, thinking: string): void {
		const normalized = thinking.trim();
		if (normalized) this.entries.set(owner, normalized);
		else this.entries.delete(owner);
		this.rebuildMarkdown();
		this.syncScroller();
	}

	completeTurn(): void {
		this.scroller.completeTurn();
		this.syncScroller();
	}

	setExpanded(expanded: boolean): void {
		if (this.userHidden) return;
		this.expanded = expanded;
		this.syncScroller();
	}

	handleOverviewClick(localRow: number): boolean {
		if (this.userHidden || localRow < 0 || localRow >= this.renderedRowCount) return false;
		this.expanded = !this.expanded;
		this.syncScroller();
		return true;
	}

	/** Stop the idle scroll timer. Called when the group leaves the transcript. */
	dispose(): void {
		this.disposed = true;
		this.scroller.dispose();
	}

	/** Only the visible live thinking text participates in the idle scroll. */
	private syncScroller(): void {
		const live = this.userHidden || this.expanded ? undefined : this.latestThinking();
		this.scroller.setText(live ? flattenInline(live) : "");
	}

	private combinedThinking(): string {
		return [...this.entries.values()].join("\n\n");
	}

	private latestThinking(): string | undefined {
		const values = [...this.entries.values()];
		return values[values.length - 1];
	}

	private rebuildMarkdown(): void {
		this.markdown = new Markdown(this.combinedThinking(), this.outputPad, 0, this.markdownTheme, {
			color: (text: string) => theme.fg("thinkingText", text),
			italic: true,
		});
	}

	private overviewLine(width: number): string {
		const pad = Math.min(this.outputPad, Math.max(0, width - 1));
		const padLeft = " ".repeat(pad);
		const contentWidth = width - pad;
		const label = `${this.expanded ? "▾" : "▸"} ✦ Thinking`;
		const liveThinking = this.userHidden || this.expanded ? undefined : this.latestThinking();
		const detail = liveThinking ? flattenInline(liveThinking) : this.hiddenLabel;
		const prefix =
			liveThinking || (detail && detail !== "Thinking..." && detail !== "Thinking") ? `${label} · ` : label;
		const body = liveThinking
			? this.scroller.window(Math.max(0, contentWidth - visibleWidth(prefix)))
			: prefix === label
				? ""
				: detail;
		const line = theme.italic(theme.fg("accent", `${prefix}${body}`));
		return padLeft + truncateToWidth(line, contentWidth, "");
	}

	override render(width: number): string[] {
		this.renderedRowCount = 0;
		if (width <= 0 || this.entries.size === 0) return [];
		const overview = this.overviewLine(width);
		const lines =
			!this.expanded || this.userHidden || !this.markdown ? [overview] : [overview, ...this.markdown.render(width)];
		this.renderedRowCount = lines.length;
		const rowCount = lines.length;
		const expanded = this.expanded;
		recordRenderedContentClickHandler(this, lines, (localRow) => {
			if (this.disposed || this.userHidden || localRow < 0 || localRow >= rowCount || this.expanded !== expanded)
				return false;
			this.setExpanded(!expanded);
			return true;
		});
		return lines;
	}
}
