import { type MarkdownTheme, truncateToWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { UserMessageComponent } from "../../interactive/components/user-message.ts";
import { getMarkdownTheme, theme } from "../../interactive/theme/theme.ts";

function formatClock(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Grok transcript treatment for a Pi user message.
 *
 * The inherited component remains the authoritative Markdown/OSC renderer;
 * this class only adds the elevated prompt band used to scan turn boundaries.
 */
export class GrokUserMessageComponent extends UserMessageComponent {
	private readonly timestamp: number;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		timestamp = Date.now(),
	) {
		super(text, markdownTheme, outputPad, markdownTransformers);
		this.timestamp = timestamp;
	}

	override render(width: number): string[] {
		const body = super.render(width);
		if (body.length === 0 || width <= 0) {
			return body;
		}

		const signature = `${theme.fg("accent", theme.bold("❯ USER"))}  ${theme.fg("muted", formatClock(this.timestamp))}`;
		const band = theme.bg("userMessageBg", truncateToWidth(` ${signature}`, width, "", true));
		return [band, ...body];
	}
}
