import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type MarkdownTheme, truncateToWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { AssistantMessageComponent } from "../../interactive/components/assistant-message.ts";
import { getMarkdownTheme, theme } from "../../interactive/theme/theme.ts";

/**
 * Grok transcript treatment for Pi assistant content.
 *
 * Pi's component still owns Markdown transforms, stream-safe incremental
 * updates, stop-reason messages, and OSC zones. The Grok layer contributes
 * only stable, width-safe visual hierarchy labels.
 */
export class GrokAssistantMessageComponent extends AssistantMessageComponent {
	private grokMessage?: AssistantMessage;
	private grokStreaming = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		// Avoid a virtual updateContent call before this subclass is initialized.
		super(undefined, hideThinkingBlock, markdownTheme, hiddenThinkingLabel, outputPad, markdownTransformers);
		if (message) {
			this.updateContent(message);
		}
	}

	override updateContent(message: AssistantMessage, isStreaming = this.grokStreaming): void {
		this.grokMessage = message;
		this.grokStreaming = isStreaming;
		super.updateContent(message, isStreaming);
	}

	override render(width: number): string[] {
		const body = super.render(width);
		if (body.length === 0 || width <= 0) {
			return body;
		}

		const headers: string[] = [];
		const hasThinking = this.grokMessage?.content.some(
			(content) => content.type === "thinking" && content.thinking.trim().length > 0,
		);
		if (hasThinking) {
			headers.push(truncateToWidth(theme.fg("thinkingText", theme.italic("◇ THINKING")), width, ""));
		}

		const streamSuffix = this.grokStreaming ? theme.fg("accent", " · STREAMING") : "";
		headers.push(truncateToWidth(`${theme.fg("accent", theme.bold("◆ ASSISTANT"))}${streamSuffix}`, width, ""));
		return [...headers, ...body];
	}
}
