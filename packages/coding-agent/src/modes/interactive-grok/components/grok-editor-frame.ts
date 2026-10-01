import {
	type Component,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { GrokChromeTheme } from "../grok-component-factory.ts";

export interface GrokEditorFrameOptions {
	theme: GrokChromeTheme;
	session?: AgentSession;
}

function isEditorBorder(line: string): boolean {
	return /^─+$/.test(stripTerminalSequences(line).trim());
}

export class GrokEditorFrame implements Component {
	private editorHost: Component;
	private session: AgentSession | undefined;
	private readonly theme: GrokChromeTheme;
	private borderColor: ((text: string) => string) | undefined;

	constructor(editorHost: Component, options: GrokEditorFrameOptions) {
		this.editorHost = editorHost;
		this.theme = options.theme;
		this.session = options.session;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setEditorHost(editorHost: Component): void {
		this.editorHost = editorHost;
	}

	getEditorHost(): Component {
		return this.editorHost;
	}

	setBorderColor(borderColor: (text: string) => string): void {
		this.borderColor = borderColor;
	}

	handleInput(data: string): void {
		this.editorHost.handleInput?.(data);
	}

	invalidate(): void {
		this.editorHost.invalidate();
	}

	/** Border-free input for constrained fullscreen layouts; never replace it with decoration. */
	renderCompactInput(width: number): string[] {
		if (width <= 0) return [];
		const prompt = width >= 4 ? this.theme.accent("❯ ") : "";
		const hostWidth = Math.max(1, width - visibleWidth(prompt));
		const lines = this.editorHost.render(hostWidth).filter((line) => !isEditorBorder(line));
		return (lines.length ? lines : [""]).map(
			(line, index) =>
				(index === 0 ? prompt : " ".repeat(visibleWidth(prompt))) + sliceByColumn(line, 0, hostWidth, true),
		);
	}

	/** Compact model/effort hint; the full label remains available in the regular frame. */
	renderCompactMetadata(width: number): string[] {
		const label = this.renderModelLabel(Math.max(0, width));
		return label ? [truncateToWidth(label, Math.max(0, width), "…")] : [];
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const borderColor = this.borderColor ?? this.theme.border;
		if (safeWidth < 4) return this.renderCompactInput(width);

		const interiorWidth = safeWidth - 2;
		const prompt = "❯ ";
		const promptWidth = visibleWidth(prompt);
		const hostWidth = Math.max(1, interiorWidth - promptWidth);
		const hostLines = this.editorHost.render(hostWidth).filter((line) => !isEditorBorder(line));
		const contentLines = hostLines.length > 0 ? hostLines : [""];
		const top = borderColor(`╭${"─".repeat(interiorWidth)}╮`);
		const body = contentLines.map((line, index) => {
			const prefix = index === 0 ? this.theme.accent(prompt) : " ".repeat(promptWidth);
			const fitted = sliceByColumn(line, 0, hostWidth, true);
			const padding = " ".repeat(Math.max(0, hostWidth - visibleWidth(fitted)));
			return `${borderColor("│")}${prefix}${fitted}${padding}${borderColor("│")}`;
		});
		const label = this.renderModelLabel();
		const labelWidth = visibleWidth(label);
		if (label && labelWidth + 4 <= interiorWidth) {
			const bottom = `${borderColor(`╰${"─".repeat(interiorWidth - labelWidth - 3)}`)} ${label} ${borderColor("─╯")}`;
			return [top, ...body, bottom];
		}
		// Keep the complete label inside the frame if the border notch is too narrow.
		const metadata = label
			? wrapTextWithAnsi(label, Math.max(1, interiorWidth - 2)).map((line) => {
					const padding = interiorWidth - visibleWidth(line);
					return (
						borderColor("│") +
						" ".repeat(Math.max(0, padding - 1)) +
						line +
						" ".repeat(Math.min(1, padding)) +
						borderColor("│")
					);
				})
			: [];
		const bottom = borderColor(`╰${"─".repeat(interiorWidth)}╯`);
		return [top, ...body, ...metadata, bottom];
	}

	private renderModelLabel(width?: number): string {
		if (!this.session) return "";
		const state = this.session.state;
		const level = state.model?.reasoning ? state.thinkingLevel || "off" : "";
		const modelName = state.model?.id || "no-model";
		const fittedModel =
			width === undefined
				? modelName
				: truncateToWidth(modelName, Math.max(0, width - (level ? visibleWidth(` • ${level}`) : 0)), "…");
		if (!level) return this.theme.accent(fittedModel);
		const styledLevel = level === "off" ? this.theme.dim(level) : this.theme.thinkingLevel(level, level);
		return this.theme.accent(fittedModel) + this.theme.muted(" • ") + styledLevel;
	}
}
