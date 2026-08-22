import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../../core/extensions/types.ts";
import { ToolExecutionComponent, type ToolExecutionOptions } from "../../interactive/components/tool-execution.ts";
import { theme } from "../../interactive/theme/theme.ts";

type GrokToolState = "pending" | "running" | "success" | "error";

/**
 * Grok card chrome around Pi's tool renderer.
 *
 * The base class continues to own extension renderers, image conversion,
 * partial results, expansion, and render state. This subclass deliberately
 * tracks presentation state only.
 */
export class GrokToolExecutionComponent extends ToolExecutionComponent {
	private readonly grokToolName: string;
	private readonly grokToolCallId: string;
	private grokState: GrokToolState = "pending";
	private grokExpanded = false;

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
		this.grokToolCallId = toolCallId;
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

	override render(width: number): string[] {
		const body = super.render(width);
		if (body.length === 0 || width <= 0) {
			return body;
		}
		if (this.getRenderShell() === "self") {
			return body;
		}

		const stateLabel = this.grokState.toUpperCase();
		const stateColor =
			this.grokState === "error"
				? "error"
				: this.grokState === "success"
					? "success"
					: this.grokState === "running"
						? "accent"
						: "muted";
		const header = [
			theme.fg("borderMuted", "╭─"),
			theme.fg("toolTitle", theme.bold(" TOOL")),
			theme.fg(stateColor, ` · ${stateLabel}`),
			theme.fg("toolTitle", ` · ${this.grokToolName}`),
			theme.fg("muted", ` · ${this.grokToolCallId}`),
		].join("");
		const mode = this.grokExpanded ? "EXPANDED" : "COLLAPSED";
		const footer = `${theme.fg("borderMuted", "╰─")} ${theme.fg("muted", mode)}`;

		return [truncateToWidth(header, width, ""), ...body, truncateToWidth(footer, width, "")];
	}
}
