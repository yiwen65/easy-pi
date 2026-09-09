import { type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { UserMessageComponent } from "../../interactive/components/user-message.ts";
import { getMarkdownTheme, theme } from "../../interactive/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC]\x07)+/;

function formatClock(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Grok transcript treatment for a Pi user message.
 *
 * The inherited component remains the authoritative Markdown/OSC renderer;
 * this class frames it with a rounded border and external turn separators.
 * The top border carries the prompt marker and clock time.
 */
export class GrokUserMessageComponent extends UserMessageComponent {
	private readonly timestamp: number;
	private highlighted = false;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		timestamp = Date.now(),
		skillNames: readonly string[] = [],
	) {
		super(text, markdownTheme, outputPad, markdownTransformers, skillNames, 0);
		this.timestamp = timestamp;
	}

	/** Flash marker used by prompt jump navigation. */
	setHighlighted(highlighted: boolean): void {
		this.highlighted = highlighted;
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		// Below six columns, prioritize content over borders and inner padding.
		const framed = width >= 6;
		const innerWidth = framed ? width - 2 : width;
		const body = super.render(innerWidth);
		if (body.length === 0) return [];
		if (!framed) return ["", ...body.map((line) => truncateToWidth(line, width, "")), ""];

		const border = (text: string) => theme.fg(this.highlighted ? "searchMatchText" : "userMessageBorder", text);
		const label = truncateToWidth(`─ ❯ ${formatClock(this.timestamp)} `, innerWidth, "");
		const header = border(`╭${label}${"─".repeat(innerWidth - visibleWidth(label))}╮`);
		const lines = body.map((line) => {
			const content = truncateToWidth(line.replace(OSC133_ZONE_PREFIX, ""), innerWidth, "", true);
			return border("│") + content + border("│");
		});
		return [
			"",
			OSC133_ZONE_START + (this.highlighted ? theme.bg("searchMatchBg", header) : header),
			...lines,
			OSC133_ZONE_END + border(`╰${"─".repeat(innerWidth)}╯`),
			"",
		];
	}
}
