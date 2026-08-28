import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, type MarkdownTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { AssistantMessageComponent } from "../../interactive/components/assistant-message.ts";
import { getMarkdownTheme, theme } from "../../interactive/theme/theme.ts";
import { flattenInline, marqueeWindow } from "./grok-marquee.ts";

const TICK_INTERVAL_MS = 120;
const MARQUEE_PREFIX = "✦ ";

class EmptyThinkingComponent implements Component {
	invalidate(): void {}
	render(): string[] {
		return [];
	}
}

/**
 * One-line thinking placeholder used while thinking is collapsed.
 *
 * Streams a live, horizontally scrolling tail of the latest thinking content
 * while the turn is in flight; once the turn completes it renders the static
 * hidden-thinking label, which stays clickable for expansion.
 */
class ThinkingMarqueeComponent implements Component {
	private flat = "";
	private readonly label: string;
	private readonly pad: number;
	private readonly live: () => boolean;
	tick = 0;

	constructor(label: string, pad: number, live: () => boolean) {
		this.label = label;
		this.pad = pad;
		this.live = live;
	}

	setThinking(text: string): void {
		this.flat = flattenInline(text);
	}

	invalidate(): void {
		// Rendering is derived directly from current text/tick; no cache to clear.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const padLeft = " ".repeat(this.pad);
		const contentWidth = Math.max(1, width - this.pad);
		if (!this.live()) {
			const label = theme.italic(theme.fg("accent", `${MARQUEE_PREFIX}${this.label}`));
			return [padLeft + truncateToWidth(label, contentWidth, "")];
		}
		const body =
			this.flat.length > 0
				? marqueeWindow(this.flat, Math.max(1, contentWidth - visibleWidth(MARQUEE_PREFIX)), this.tick)
				: this.label;
		const line = theme.italic(theme.fg("accent", `${MARQUEE_PREFIX}${body}`));
		return [padLeft + truncateToWidth(line, contentWidth, "")];
	}
}

/**
 * Grok transcript treatment for Pi assistant content.
 *
 * Pi's component still owns Markdown transforms, stream-safe incremental
 * updates, stop-reason messages, and OSC zones. The Grok layer removes the
 * ASSISTANT/THINKING headers entirely: assistant text renders as plain
 * Markdown and thinking collapses to a single line by default — a live
 * scrolling marquee while streaming, a static clickable label afterwards.
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
	private marquees: ThinkingMarqueeComponent[] = [];
	private tickerUi?: TUI;
	private tickerInterval: ReturnType<typeof setInterval> | undefined;
	private tickerTick = 0;

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

	/** Provide the TUI handle that drives marquee animation while streaming. */
	setTickerUi(ui: TUI | undefined): void {
		this.tickerUi = ui;
		this.syncTicker();
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

	protected override createHiddenThinkingComponent(): Component {
		if (this.thinkingDelegated) return new EmptyThinkingComponent();
		const marquee = new ThinkingMarqueeComponent(this.grokThinkingLabel, this.outputPad, () => this.marqueeLive());
		this.marquees.push(marquee);
		return marquee;
	}

	private marqueeLive(): boolean {
		return this.grokStreaming && !this.thinkingDelegated && !this.userHideThinking && !this.grokThinkingExpanded;
	}

	private tickerActive(): boolean {
		return this.tickerUi !== undefined && this.marqueeLive() && this.marquees.length > 0;
	}

	private syncTicker(): void {
		if (this.tickerActive() && !this.tickerInterval) {
			this.tickerInterval = setInterval(() => {
				this.tickerTick++;
				for (const marquee of this.marquees) {
					marquee.tick = this.tickerTick;
				}
				this.tickerUi?.requestRender();
			}, TICK_INTERVAL_MS);
			(this.tickerInterval as { unref?: () => void }).unref?.();
		} else if (!this.tickerActive() && this.tickerInterval) {
			clearInterval(this.tickerInterval);
			this.tickerInterval = undefined;
		}
	}

	/** Stop the marquee timer. Called when the component leaves the transcript. */
	dispose(): void {
		if (this.tickerInterval) {
			clearInterval(this.tickerInterval);
			this.tickerInterval = undefined;
		}
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
		const label = theme.italic(theme.fg("accent", `${MARQUEE_PREFIX}${this.grokThinkingLabel}`));
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
		this.marquees = [];
		this.syncThinkingVisibility();
		super.updateContent(message, isStreaming);
		const thinkingText = message.content
			.map((content) => (content.type === "thinking" ? content.thinking : ""))
			.join(" ");
		for (const marquee of this.marquees) {
			marquee.setThinking(thinkingText);
		}
		this.syncTicker();
	}
}
