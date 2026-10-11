/**
 * Presentation for the codemode tool.
 *
 * The call shows the script; the result lists the nested tool calls with their status as they
 * run, followed by the script output without the "Script completed" header. Nested calls are not
 * separate tool rows because they never reach the model as tool calls.
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput, replaceTabs, str } from "../../core/tools/render-utils.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { CodemodeOutputPreview } from "./output.ts";
import type { CodemodeNestedCall, CodemodeToolDetails, codemodeSchema } from "./tool.ts";

const CODE_PREVIEW_LINES = 10;
const CALL_PREVIEW_COUNT = 8;
const OUTPUT_PREVIEW_LINES = 5;
const COLLAPSED_ARGS_CHARS = 80;
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function expandHint(theme: Theme, hidden: number, noun: string): string {
	return `${theme.fg("muted", `... (${hidden} more ${noun},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusIcon(call: CodemodeNestedCall, theme: Theme): string {
	switch (call.status) {
		case "running":
			return theme.fg("warning", "…");
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
	}
}

function formatCall(call: CodemodeNestedCall, theme: Theme, expanded: boolean): string {
	const args =
		!expanded && call.args.length > COLLAPSED_ARGS_CHARS
			? `${call.args.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
			: call.args;
	const duration = formatDuration(call.durationMs);
	const safe = (text: string) => sanitizeBinaryOutput(stripAnsi(text)).replace(/[\r\n]/g, " ");
	let line = `${statusIcon(call, theme)} ${theme.fg("toolTitle", safe(call.name))}`;
	if (args) line += ` ${theme.fg("muted", safe(args))}`;
	if (duration) line += ` ${theme.fg("dim", duration)}`;
	if (call.executionOutcome === "unknown") line += ` ${theme.fg("warning", "unknown outcome")}`;
	if (expanded && call.error) line += `\n    ${theme.fg("error", safe(call.error))}`;
	return line;
}

export const codemodeRenderers: Pick<
	ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall(args, theme, context) {
		// The code includes the `// @options:` line, so options show as part of the script.
		const code = str((args as { code?: unknown } | undefined)?.code);
		const title = theme.fg("toolTitle", theme.bold("codemode"));
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		if (code === null) {
			component.addChild(new Text(`${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0));
			return component;
		}
		component.addChild(new Text(title, 0, 0));
		if (code) {
			const safeCode = sanitizeBinaryOutput(stripAnsi(code)).replace(/\r/g, "").trimEnd();
			const highlighted = highlightCode(replaceTabs(safeCode), "javascript").join("\n");
			component.addChild(
				context.expanded
					? new Text(highlighted, 0, 0)
					: new CodemodeOutputPreview(highlighted, CODE_PREVIEW_LINES, (hidden) =>
							expandHint(theme, hidden, "lines"),
						),
			);
		}
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		const calls = result.details?.calls ?? [];
		if (calls.length > 0) {
			const shown = options.expanded ? calls : calls.slice(-CALL_PREVIEW_COUNT);
			const lines = shown.map((call) => formatCall(call, theme, options.expanded));
			if (shown.length < calls.length) {
				lines.unshift(
					`${theme.fg("muted", `... (${calls.length - shown.length} earlier calls,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				);
			}
			if (result.details?.omittedCalls) {
				lines.push(theme.fg("muted", `${result.details.omittedCalls} further calls omitted from the display`));
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(lines.join("\n"), 0, 0));
		}

		// Drop the "Script completed\nWall time ...\nOutput:\n" header. Rejected input (invalid options)
		// has no header.
		const content = context.isError && result.details?.output ? result.details.output : result.content;
		const [first, ...rest] = content;
		const hasHeader = first?.type === "text" && SCRIPT_HEADER.test(first.text);
		const output = options.isPartial
			? ""
			: getTextOutput({ ...result, content: hasHeader ? rest : content }, context.showImages).trim();
		if (output) {
			const color = context.isError ? "error" : "toolOutput";
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			component.addChild(new Spacer(1));
			if (options.expanded) {
				component.addChild(new Text(styled, 0, 0));
			} else {
				// Limit wrapped lines, not logical ones: script output is often one long JSON line.
				component.addChild(
					new CodemodeOutputPreview(styled, OUTPUT_PREVIEW_LINES, (hidden) => expandHint(theme, hidden, "lines")),
				);
				// The collapsed preview hides the truncation notice at the end, so name the file here.
				const fullOutputPath = result.details?.fullOutputPath;
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
		}
		return component;
	},
};
