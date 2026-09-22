import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { formatWorkedDuration } from "../../../utils/duration.ts";
import { theme } from "../../interactive/theme/theme.ts";

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
