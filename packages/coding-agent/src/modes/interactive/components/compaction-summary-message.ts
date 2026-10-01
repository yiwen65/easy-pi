import {
	Box,
	Markdown,
	type MarkdownTheme,
	recordRenderedContentClickHandler,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	/** Collapse from any expanded row; expand from the collapsed label or token summary. */
	handleContentClick(localRow: number, width: number): boolean {
		const line = this.render(width)[localRow];
		if (line === undefined) return false;
		if (!this.expanded && !line.includes("[compaction]") && !line.includes("Compacted")) return false;
		this.setExpanded(!this.expanded);
		return true;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const expanded = this.expanded;
		const rowCount = lines.length;
		const headers = new Set<number>();
		if (!expanded) {
			for (let row = 0; row < lines.length; row++) {
				if (lines[row]!.includes("[compaction]") || lines[row]!.includes("Compacted")) headers.add(row);
			}
		}
		recordRenderedContentClickHandler(this, lines, (localRow) => {
			if (this.expanded !== expanded || localRow < 0 || localRow >= rowCount) return false;
			if (!expanded && !headers.has(localRow)) return false;
			this.setExpanded(!expanded);
			return true;
		});
		return lines;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const tokensBefore = this.message.tokensBefore.toLocaleString();
		const tokensAfter = this.message.estimatedTokensAfter?.toLocaleString();
		const tokenSummary =
			tokensAfter === undefined
				? `Compacted from ${tokensBefore} tokens`
				: `Compacted from ${tokensBefore} to ${tokensAfter} tokens`;
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			this.addChild(
				new Markdown(`**${tokenSummary}**\n\n${this.message.summary}`, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(new Text(theme.fg("customMessageText", tokenSummary), 0, 0));
		}
	}
}
