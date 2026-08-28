import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const BRAND_NAME = "easy-pi";
const TAGLINE = "The deepest truths are often the simplest";
const COLUMN_GAP = 4;

export interface EasyPiLandingTelemetry {
	skills: number;
	prompts: number;
	extensions: number;
}

export interface EasyPiStartupHeaderOptions {
	getCompactHints: () => readonly string[];
	getExpandedHints: () => readonly string[];
	getTelemetry: () => EasyPiLandingTelemetry;
	expanded?: boolean;
}

/** Static, responsive easy-pi landing page with restrained terminal typography. */
export class EasyPiStartupHeader implements Component {
	private readonly getCompactHints: () => readonly string[];
	private readonly getExpandedHints: () => readonly string[];
	private readonly getTelemetry: () => EasyPiLandingTelemetry;
	private expanded: boolean;

	constructor(options: EasyPiStartupHeaderOptions) {
		this.getCompactHints = options.getCompactHints;
		this.getExpandedHints = options.getExpandedHints;
		this.getTelemetry = options.getTelemetry;
		this.expanded = options.expanded ?? false;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {
		// Theme, telemetry, and keybinding styles are resolved on every render.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth <= 2) return [truncateToWidth(theme.bold(theme.fg("accent", "e")), safeWidth, "")];

		const lines = [this.center(this.renderWordmark(safeWidth), safeWidth)];
		if (safeWidth < 16) return lines;

		if (safeWidth >= visibleWidth(TAGLINE)) lines.push(this.center(theme.fg("dim", TAGLINE), safeWidth));
		if (safeWidth < 24) {
			lines.push("");
			lines.push(...this.renderCommandRail(safeWidth));
			return lines;
		}

		lines.push("");
		lines.push(...this.renderResources(safeWidth));
		lines.push("");

		if (this.expanded) {
			lines.push(this.center(theme.fg("dim", "shortcuts"), safeWidth));
			lines.push(...this.renderExpandedHints(safeWidth));
			lines.push("");
			lines.push(this.center(theme.fg("dim", "resources"), safeWidth));
			return lines;
		}

		lines.push(...this.renderCommandRail(safeWidth));
		return lines;
	}

	private renderWordmark(width: number): string {
		const name = theme.bold(theme.fg("accent", BRAND_NAME));
		if (width < 28) return name;

		const ruleWidth = Math.min(18, Math.floor((width - visibleWidth(name) - 2) / 2));
		if (ruleWidth < 2) return name;
		const rule = theme.fg("borderMuted", "─".repeat(ruleWidth));
		return `${rule} ${name} ${rule}`;
	}

	private renderResources(width: number): string[] {
		const telemetry = this.getTelemetry();
		return this.renderSegments(
			[
				theme.fg("dim", `${telemetry.skills} skills`),
				theme.fg("dim", `${telemetry.extensions} extensions`),
				theme.fg("dim", `${telemetry.prompts} prompts`),
			],
			width,
		);
	}

	private renderCommandRail(width: number): string[] {
		return this.renderSegments(this.getCompactHints(), width);
	}

	private renderSegments(segments: readonly string[], width: number): string[] {
		const separator = theme.fg("borderMuted", "  ·  ");
		const contentWidth = Math.max(1, width - Math.min(8, Math.floor(width / 4)));
		const rows: string[] = [];
		let current = "";

		for (const segment of segments) {
			const candidate = current ? `${current}${separator}${segment}` : segment;
			if (visibleWidth(candidate) <= contentWidth) {
				current = candidate;
				continue;
			}
			if (current) rows.push(current);
			current = truncateToWidth(segment, contentWidth, "…");
		}
		if (current) rows.push(current);
		return rows.map((row) => this.center(row, width));
	}

	private renderExpandedHints(width: number): string[] {
		const hints = [...this.getExpandedHints()];
		const contentWidth = Math.max(1, width - Math.min(8, Math.floor(width / 4)));
		if (contentWidth < 68) {
			return hints.flatMap((hint) =>
				wrapTextWithAnsi(`${theme.fg("dim", "›")} ${hint}`, contentWidth).map((line) => this.center(line, width)),
			);
		}

		const cellWidth = Math.floor((contentWidth - COLUMN_GAP) / 2);
		const lines: string[] = [];
		for (let index = 0; index < hints.length; index += 2) {
			const left = truncateToWidth(`${theme.fg("dim", "›")} ${hints[index]}`, cellWidth, "…");
			const rightHint = hints[index + 1];
			const leftPadding = " ".repeat(Math.max(0, cellWidth - visibleWidth(left)));
			const right = rightHint ? truncateToWidth(`${theme.fg("dim", "›")} ${rightHint}`, cellWidth, "…") : "";
			lines.push(this.center(`${left}${leftPadding}${" ".repeat(COLUMN_GAP)}${right}`, width));
		}
		return lines;
	}

	private center(text: string, width: number): string {
		const fitted = truncateToWidth(text, width, "");
		const padding = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2)));
		return `${padding}${fitted}`;
	}
}
