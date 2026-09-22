import {
	Container,
	Markdown,
	type MarkdownTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { LiveLineScroller } from "../../interactive/components/live-line-scroller.ts";
import { theme } from "../../interactive/theme/theme.ts";
import { flattenInline } from "./grok-inline-text.ts";

const PREFIX = "✦ ";

/**
 * One collapsed/expandable Thinking block shared by every assistant message in a turn.
 *
 * Collapsed — the default — the block renders exactly one row: the newest
 * thinking entry, flattened to a single line. Like streaming output, the row
 * keeps the newest text on screen while the entry grows; once the entry stopped
 * changing for a moment the row scrolls the hidden beginning into view and
 * cycles the whole text, so it can be read without expanding. Once the turn
 * completes the row falls back to the static hidden label. A click on the row
 * expands the block into the full thinking content of the turn.
 */
export class GrokThinkingTurnGroupComponent extends Container {
	private readonly entries = new Map<object, string>();
	private readonly scroller: LiveLineScroller;
	private readonly markdownTheme: MarkdownTheme;
	private readonly hiddenLabel: string;
	private readonly outputPad: number;
	private readonly userHidden: boolean;
	private expanded = false;
	private turnComplete = false;
	private markdown: Markdown | undefined;
	private renderedRowCount = 0;

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
		this.turnComplete = true;
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
		this.scroller.dispose();
	}

	/** Only the visible live thinking text participates in the idle scroll. */
	private syncScroller(): void {
		const live = this.userHidden || this.expanded || this.turnComplete ? undefined : this.latestThinking();
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
		const padLeft = " ".repeat(this.outputPad);
		const contentWidth = Math.max(1, width - this.outputPad);
		const liveThinking = this.userHidden || this.expanded || this.turnComplete ? undefined : this.latestThinking();
		const body = liveThinking
			? this.scroller.window(Math.max(1, contentWidth - visibleWidth(PREFIX)))
			: this.hiddenLabel;
		const line = theme.italic(theme.fg("accent", `${PREFIX}${body}`));
		return padLeft + truncateToWidth(line, contentWidth, "");
	}

	override render(width: number): string[] {
		this.renderedRowCount = 0;
		if (width <= 0 || this.entries.size === 0) return [];
		const overview = this.overviewLine(width);
		const lines =
			!this.expanded || this.userHidden || !this.markdown ? [overview] : [overview, ...this.markdown.render(width)];
		this.renderedRowCount = lines.length;
		return lines;
	}
}
