import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../../core/extensions/types.ts";
import { ToolExecutionComponent, type ToolExecutionOptions } from "../../interactive/components/tool-execution.ts";
import { theme } from "../../interactive/theme/theme.ts";

type GrokToolState = "pending" | "running" | "success" | "error";

/** Arg keys checked first when summarizing a tool call into one line. */
const SUMMARY_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url"];

function firstLine(text: string): string {
	return text.split("\n", 1)[0]?.trim() ?? "";
}

/**
 * Best-effort single-line summary of tool args. Never throws; falls back to
 * the first non-empty string value, then to a JSON sketch.
 */
function summarizeArgs(args: unknown): string {
	if (args === null || args === undefined) return "";
	if (typeof args === "string") return firstLine(args);
	if (typeof args !== "object") return String(args);
	const record = args as Record<string, unknown>;
	for (const key of SUMMARY_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return firstLine(value);
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim()) return firstLine(value);
	}
	try {
		return JSON.stringify(args) ?? "";
	} catch {
		return "";
	}
}

/**
 * Compact Grok presentation around Pi's tool renderer.
 *
 * The base class continues to own extension renderers, image conversion,
 * partial results, expansion, and render state. This subclass deliberately
 * tracks presentation state only.
 *
 * Collapsed (the default) renders exactly one symbol-led line. Expanded keeps
 * that compact header and reveals the base renderer details beneath it. Errors
 * use the same explicit click-to-expand behavior as successful tools.
 */
export class GrokToolExecutionComponent extends ToolExecutionComponent {
	private readonly grokToolName: string;
	private grokArgs: unknown;
	private grokState: GrokToolState = "pending";
	private grokExpanded = false;
	private turnGrouped = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition | undefined,
		ui: TUI,
		cwd: string,
	) {
		super(toolName, toolCallId, args, options, toolDefinition, ui, cwd);
		this.grokToolName = toolName;
		this.grokArgs = args;
	}

	override updateArgs(args: unknown): void {
		this.grokArgs = args;
		super.updateArgs(args);
	}

	override markExecutionStarted(): void {
		this.grokState = "running";
		super.markExecutionStarted();
	}

	override updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.grokState = result.isError ? "error" : isPartial ? "running" : "success";
		super.updateResult(result, isPartial);
	}

	override setExpanded(expanded: boolean): void {
		this.grokExpanded = expanded;
		super.setExpanded(expanded);
	}

	/** Toggle the collapsed overview. Used by click-to-expand in the transcript. */
	toggleExpanded(): void {
		this.setExpanded(!this.grokExpanded);
	}

	/** Whether this tool can participate in the turn-level compact tool row. */
	canUseTurnGroup(): boolean {
		// Built-in edit owns its diff shell but must still be compact in Grok mode.
		// Other self-shell extensions retain complete ownership of their UI.
		return this.getRenderShell() !== "self" || this.grokToolName === "edit";
	}

	/** Mark that the surrounding turn group owns this tool's collapsed shell. */
	setTurnGrouped(grouped: boolean): void {
		this.turnGrouped = grouped;
	}

	/** Presentation state of this tool call, for turn-level aggregation. */
	getGrokState(): GrokToolState {
		return this.grokState;
	}

	/** Tool name as shown in the compact overview. */
	getGrokToolName(): string {
		return this.grokToolName;
	}

	/** Single-line summary of the current args, for turn-level aggregation. */
	summarizeCurrentArgs(): string {
		return summarizeArgs(this.grokArgs);
	}

	/**
	 * Handle a transcript click at a component-local row. Expands when the
	 * collapsed overview line is clicked; collapses when the expanded compact
	 * header is clicked. Returns true when the click toggled the block.
	 */
	handleOverviewClick(localRow: number): boolean {
		if (this.getRenderShell() === "self" && !this.turnGrouped) return false;
		if (this.grokExpanded) {
			if (localRow !== 0) return false;
			this.setExpanded(false);
			return true;
		}
		if (localRow !== 0) return false;
		this.setExpanded(true);
		return true;
	}

	stateColor(): "error" | "success" | "accent" | "muted" {
		switch (this.grokState) {
			case "error":
				return "error";
			case "success":
				return "success";
			case "running":
				return "accent";
			default:
				return "muted";
		}
	}

	stateSymbol(): "◇" | "◈" | "◆" | "✕" {
		switch (this.grokState) {
			case "running":
				return "◈";
			case "success":
				return "◆";
			case "error":
				return "✕";
			default:
				return "◇";
		}
	}

	/** The compact one-line overview; the component's only collapsed row. */
	overviewLine(width: number): string {
		const summary = summarizeArgs(this.grokArgs);
		const parts = [
			theme.fg(this.stateColor(), `${this.stateSymbol()} `),
			theme.fg("toolTitle", theme.bold(this.grokToolName)),
		];
		if (summary) {
			parts.push(theme.fg("muted", `  ${summary}`));
		}
		return truncateToWidth(parts.join(""), width, "");
	}

	override render(width: number): string[] {
		if (width <= 0) {
			return [];
		}
		if (this.getRenderShell() === "self" && !this.turnGrouped) {
			return super.render(width);
		}

		if (!this.grokExpanded) {
			return [this.overviewLine(width)];
		}

		const body = super.render(width);
		const compactBody = body[0] === "" ? body.slice(1) : body;
		return [this.overviewLine(width), ...compactBody];
	}
}
