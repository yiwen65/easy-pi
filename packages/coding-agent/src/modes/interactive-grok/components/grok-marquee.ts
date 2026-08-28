import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** Collapse all whitespace runs so multi-line content fits a single line. */
export function flattenInline(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

const SCROLL_GAP = "   ";

/**
 * Width-aware cyclic horizontal scroll window over flattened text.
 *
 * Returns the text unchanged when it fits; otherwise a window of `width`
 * columns that advances by `tick` and wraps around seamlessly. The returned
 * string contains no ANSI sequences, so callers can style it afterwards.
 */
export function marqueeWindow(text: string, width: number, tick: number): string {
	if (width <= 0 || text.length === 0) return "";
	if (visibleWidth(text) <= width) return text;
	const track = text + SCROLL_GAP;
	const cycle = visibleWidth(track);
	const start = ((tick % cycle) + cycle) % cycle;
	return sliceByColumn(track + track, start, width);
}
