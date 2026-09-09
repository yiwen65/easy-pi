import {
	Container,
	Markdown,
	type MarkdownTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../../interactive/theme/theme.ts";
import { flattenInline, marqueeWindow } from "./grok-marquee.ts";

const TICK_INTERVAL_MS = 120;
const PREFIX = "✦ ";

/** One collapsed/expandable Thinking block shared by every assistant message in a turn. */
export class GrokThinkingTurnGroupComponent extends Container {
	private readonly entries = new Map<object, string>();
	private readonly streamingEntries = new Set<object>();
	private readonly markdownTheme: MarkdownTheme;
	private readonly hiddenLabel: string;
	private readonly outputPad: number;
	private readonly userHidden: boolean;
	private readonly ui?: TUI;
	private expanded = false;
	private turnComplete = false;
	private tick = 0;
	private tickerInterval: ReturnType<typeof setInterval> | undefined;
	private markdown: Markdown | undefined;
	private renderedRowCount = 0;

	constructor(markdownTheme: MarkdownTheme, hiddenLabel: string, outputPad: number, userHidden: boolean, ui?: TUI) {
		super();
		this.markdownTheme = markdownTheme;
		this.hiddenLabel = hiddenLabel;
		this.outputPad = outputPad;
		this.userHidden = userHidden;
		this.ui = ui;
	}

	get entryCount(): number {
		return this.entries.size;
	}

	updateThinking(owner: object, thinking: string, isStreaming: boolean): void {
		const normalized = thinking.trim();
		if (normalized) this.entries.set(owner, normalized);
		else this.entries.delete(owner);
		if (isStreaming && normalized) this.streamingEntries.add(owner);
		else this.streamingEntries.delete(owner);
		this.rebuildMarkdown();
		this.syncTicker();
	}

	completeTurn(): void {
		this.turnComplete = true;
		this.streamingEntries.clear();
		this.syncTicker();
	}

	setExpanded(expanded: boolean): void {
		if (this.userHidden) return;
		this.expanded = expanded;
		this.syncTicker();
	}

	handleOverviewClick(localRow: number): boolean {
		if (this.userHidden || localRow < 0 || localRow >= this.renderedRowCount) return false;
		this.expanded = !this.expanded;
		this.syncTicker();
		return true;
	}

	dispose(): void {
		this.stopTicker();
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

	private tickerActive(): boolean {
		return this.ui !== undefined && !this.expanded && !this.userHidden && this.streamingEntries.size > 0;
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

	private overviewLine(width: number): string {
		const padLeft = " ".repeat(this.outputPad);
		const contentWidth = Math.max(1, width - this.outputPad);
		const liveThinking = this.userHidden || this.expanded || this.turnComplete ? undefined : this.latestThinking();
		const body = liveThinking
			? marqueeWindow(flattenInline(liveThinking), Math.max(1, contentWidth - visibleWidth(PREFIX)), this.tick)
			: this.hiddenLabel;
		const line = theme.italic(theme.fg("accent", `${PREFIX}${body}`));
		return padLeft + truncateToWidth(line, contentWidth, "");
	}

	override render(width: number): string[] {
		this.renderedRowCount = 0;
		if (width <= 0 || this.entries.size === 0) return [];
		this.syncTicker();
		const overview = this.overviewLine(width);
		const lines =
			!this.expanded || this.userHidden || !this.markdown ? [overview] : [overview, ...this.markdown.render(width)];
		this.renderedRowCount = lines.length;
		return lines;
	}
}
