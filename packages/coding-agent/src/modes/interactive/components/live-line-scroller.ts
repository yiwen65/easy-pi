import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** Minimal renderer handle: the scroller only needs to ask for a repaint. */
export interface LiveLineRenderer {
	requestRender(): void;
}

/** Which end of an overflowing row text stays visible while the text keeps changing. */
export type LiveLineAnchor = "head" | "tail";

/** Quiet time before a truncated row scrolls its hidden text into view. */
const IDLE_DELAY_MS = 1_000;
const TICK_MS = 120;
const SCROLL_GAP = "   ";

/**
 * Cyclic horizontal scroll state for one live transcript row.
 *
 * While the row's text keeps changing the row shows one end of that text — the
 * head for commands ("head"), or the tail for streamed prose where the newest
 * text matters ("tail"). Once the text stopped changing for IDLE_DELAY_MS the
 * row scrolls the hidden part into view and keeps cycling; new text resets it to
 * the anchored end. Completing the turn permanently stops automatic scrolling.
 */
export class LiveLineScroller {
	private readonly ui?: LiveLineRenderer;
	private readonly anchor: LiveLineAnchor;
	private text = "";
	private width = 0;
	private offset = 0;
	private turnComplete = false;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;

	constructor(ui?: LiveLineRenderer, anchor: LiveLineAnchor = "head") {
		this.ui = ui;
		this.anchor = anchor;
	}

	/** Latest full row text; new text stops the scroll and shows the anchored end again. */
	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.offset = 0;
		this.stopTicker();
		this.armIdle();
	}

	/** Window of the row text that fits `width` columns; anchored until the row goes idle. */
	window(width: number): string {
		this.width = width;
		if (width <= 0 || this.text.length === 0) return "";
		if (visibleWidth(this.text) <= width) return this.text;
		if (this.ticker) return scrollWindow(this.text, width, this.offset);
		return this.anchor === "tail" ? tailWindow(this.text, width) : headWindow(this.text, width);
	}

	/** Completed turns stay anchored, even if their text or the terminal width changes later. */
	completeTurn(): void {
		this.turnComplete = true;
		this.dispose();
	}

	/** Stop both timers. Called when the row leaves the transcript. */
	dispose(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		this.stopTicker();
	}

	private armIdle(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		if (this.turnComplete || !this.ui || this.text.length === 0) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			this.startTicker();
		}, IDLE_DELAY_MS);
		(this.idleTimer as { unref?: () => void }).unref?.();
	}

	private startTicker(): void {
		if (this.ticker || !this.ui || this.text.length === 0) return;
		// A tail-anchored row keeps the newest text on screen when it goes idle and
		// cycles on from there, so the hidden head scrolls in without a jump.
		if (this.anchor === "tail" && this.width > 0) {
			this.offset = Math.max(0, visibleWidth(this.text) - this.width);
		}
		this.ticker = setInterval(() => {
			// Nothing hidden at the current width: stay armed (no render) so a later
			// narrowing terminal can scroll again without a text change.
			if (visibleWidth(this.text) <= this.width) return;
			this.offset++;
			this.ui?.requestRender();
		}, TICK_MS);
		(this.ticker as { unref?: () => void }).unref?.();
	}

	private stopTicker(): void {
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}
}

/** Cyclic width-aware window over the text, wrapping with a gap. */
function scrollWindow(text: string, width: number, offset: number): string {
	const track = text + SCROLL_GAP;
	const cycle = visibleWidth(track);
	const start = ((offset % cycle) + cycle) % cycle;
	return sliceByColumn(track + track, start, width);
}

function headWindow(text: string, width: number): string {
	return sliceByColumn(text, 0, width);
}

/** Newest text of a streaming row: the last `width` columns. */
function tailWindow(text: string, width: number): string {
	return sliceByColumn(text, Math.max(0, visibleWidth(text) - width), width);
}
