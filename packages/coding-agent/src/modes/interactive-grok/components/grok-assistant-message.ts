import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, type MarkdownTheme, truncateToWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { AssistantMessageComponent } from "../../interactive/components/assistant-message.ts";
import { getMarkdownTheme, theme } from "../../interactive/theme/theme.ts";
import { flattenInline } from "./grok-inline-text.ts";

const PREFIX = "✦ ";

/**
 * One-line thinking placeholder used while thinking is collapsed.
 *
 * Shows the newest thinking text flattened into one row, truncated to the
 * available width while the message is in flight; once it settles the row
 * renders the static hidden label, which stays clickable for expansion. The
 * row never scrolls, so already-shown text is not replayed.
 */
class ThinkingLineComponent implements Component {
	private flat = "";
	private readonly label: string;
	private readonly pad: number;
	private readonly live: () => boolean;

	constructor(label: string, pad: number, live: () => boolean) {
		this.label = label;
		this.pad = pad;
		this.live = live;
	}

	setThinking(text: string): void {
		this.flat = flattenInline(text);
	}

	invalidate(): void {
		// Rendering derives directly from the current text; no cache to clear.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const padLeft = " ".repeat(this.pad);
		const contentWidth = Math.max(1, width - this.pad);
		const body = this.live() && this.flat.length > 0 ? this.flat : this.label;
		const line = theme.italic(theme.fg("accent", `${PREFIX}${body}`));
		return [padLeft + truncateToWidth(line, contentWidth, "")];
	}
}

/**
 * Grok transcript treatment for Pi assistant content.
 *
 * Pi's component still owns Markdown transforms, stream-safe incremental
 * updates, stop-reason messages, and OSC zones. The Grok layer removes the
 * ASSISTANT/THINKING headers entirely: assistant text renders as plain
 * Markdown and thinking collapses to a single line by default — the newest
 * thinking text while streaming, a static clickable label afterwards.
 * `setExpanded` (the global tool-output toggle) or a click on the label
 * re-expands the full thinking content.
 */
export class GrokAssistantMessageComponent extends AssistantMessageComponent {
	private grokMessage?: AssistantMessage;
	private grokStreaming = false;
	private userHideThinking: boolean;
	private grokThinkingExpanded = false;
	private grokThinkingLabel: string;
	private thinkingDelegated = false;
	private thinkingLines: ThinkingLineComponent[] = [];

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
		this.userHideThinking = hideThinkingBlock;
		this.grokThinkingLabel = hiddenThinkingLabel;
		if (message) {
			this.updateContent(message);
		}
	}

	private thinkingCollapsed(): boolean {
		return !this.grokThinkingExpanded;
	}

	private syncThinkingVisibility(): void {
		this.setThinkingHiddenSilently(this.thinkingDelegated || this.userHideThinking || this.thinkingCollapsed());
	}

	private rebuild(): void {
		if (this.grokMessage) {
			this.updateContent(this.grokMessage);
		} else {
			this.syncThinkingVisibility();
		}
	}

	override setHideThinkingBlock(hide: boolean): void {
		this.userHideThinking = hide;
		this.rebuild();
	}

	override setHiddenThinkingLabel(label: string): void {
		this.grokThinkingLabel = label;
		super.setHiddenThinkingLabel(label);
	}

	/** Delegate this message's thinking to the turn-level aggregate component. */
	setThinkingDelegated(delegated: boolean): void {
		if (this.thinkingDelegated === delegated) return;
		this.thinkingDelegated = delegated;
		this.rebuild();
	}

	getThinkingText(): string {
		return (
			this.grokMessage?.content
				.map((content) => (content.type === "thinking" ? content.thinking : ""))
				.filter(Boolean)
				.join("\n\n") ?? ""
		);
	}

	protected override createHiddenThinkingComponent(): Component | undefined {
		if (this.thinkingDelegated) return undefined;
		const line = new ThinkingLineComponent(this.grokThinkingLabel, this.outputPad, () => this.thinkingLive());
		this.thinkingLines.push(line);
		return line;
	}

	private thinkingLive(): boolean {
		return this.grokStreaming && !this.thinkingDelegated && !this.userHideThinking && !this.grokThinkingExpanded;
	}

	/**
	 * Expand thinking when a transcript click lands on the collapsed thinking
	 * label line. Returns true when the click expanded the block.
	 */
	handleThinkingLabelClick(localRow: number, width: number): boolean {
		if (this.thinkingDelegated || this.userHideThinking || !this.grokMessage) return false;
		const lines = this.render(width);
		const line = lines[localRow];
		if (line === undefined) return false;
		if (!stripAnsi(line).includes(this.grokThinkingLabel)) return false;
		this.setExpanded(!this.grokThinkingExpanded);
		return true;
	}

	override render(width: number): string[] {
		if (this.thinkingDelegated && this.grokMessage) {
			const hasText = this.grokMessage.content.some((content) => content.type === "text" && content.text.trim());
			const hasStandaloneStatus = ["aborted", "error", "length"].includes(this.grokMessage.stopReason);
			if (!hasText && !hasStandaloneStatus) return [];
		}
		const body = super.render(width);
		if (this.thinkingDelegated || !this.grokThinkingExpanded || !this.getThinkingText().trim() || width <= 0) {
			return body;
		}
		const padLeft = " ".repeat(this.outputPad);
		const contentWidth = Math.max(1, width - this.outputPad);
		const label = theme.italic(theme.fg("accent", `${PREFIX}${this.grokThinkingLabel}`));
		return [padLeft + truncateToWidth(label, contentWidth, ""), ...body];
	}

	/** Expandable hook: the global tool-output toggle also expands thinking. */
	setExpanded(expanded: boolean): void {
		this.grokThinkingExpanded = expanded;
		this.rebuild();
	}

	override updateContent(message: AssistantMessage, isStreaming = this.grokStreaming): void {
		this.grokMessage = message;
		this.grokStreaming = isStreaming;
		this.thinkingLines = [];
		this.syncThinkingVisibility();
		super.updateContent(message, isStreaming);
		const thinkingText = message.content
			.map((content) => (content.type === "thinking" ? content.thinking : ""))
			.join(" ");
		for (const line of this.thinkingLines) {
			line.setThinking(thinkingText);
		}
	}
}
