import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../../interactive/theme/theme.ts";

export function formatWorkedDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, durationMs) / 1000;
	if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
	if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
	const totalRoundedSeconds = Math.round(totalSeconds);
	const hours = Math.floor(totalRoundedSeconds / 3600);
	const minutes = Math.floor((totalRoundedSeconds % 3600) / 60);
	const seconds = totalRoundedSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

/** Compact elapsed-time marker appended after one complete user→answer turn. */
export class GrokTurnDurationComponent implements Component {
	private readonly durationMs: number;
	private readonly outputPad: number;

	constructor(durationMs: number, outputPad = 1) {
		this.durationMs = durationMs;
		this.outputPad = outputPad;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const padLeft = " ".repeat(this.outputPad);
		const contentWidth = Math.max(1, width - this.outputPad);
		const label = theme.italic(theme.fg("muted", `worked ${formatWorkedDuration(this.durationMs)}`));
		return [padLeft + truncateToWidth(label, contentWidth, "")];
	}
}
