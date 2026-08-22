import type { GrokChromeTheme } from "../grok-component-factory.ts";

/** Context usage thresholds shared with the legacy footer coloring. */
const WARNING_PERCENT = 70;
const ERROR_PERCENT = 90;

/** Pick the theme color for a context usage percentage (green → yellow → red). */
export function contextColorFor(percent: number | null, theme: GrokChromeTheme): (text: string) => string {
	if (percent === null) return theme.dim;
	if (percent > ERROR_PERCENT) return theme.error;
	if (percent > WARNING_PERCENT) return theme.warning;
	return theme.success;
}

/**
 * Render a compact context usage meter, e.g. `███░░░ 42%`.
 * The filled portion shifts color as the context window fills up.
 */
export function renderContextMeter(percent: number | null, theme: GrokChromeTheme, cells = 6): string {
	if (percent === null || Number.isNaN(percent)) {
		return theme.dim("context ?");
	}
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * cells);
	const bar = "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
	return `${contextColorFor(clamped, theme)(bar)} ${theme.muted(`${clamped.toFixed(0)}%`)}`;
}
