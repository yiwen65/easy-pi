import { stripVTControlCharacters } from "node:util";
import type { BackgroundTaskManager, BackgroundTaskRecord } from "@earendil-works/pi-agent-core/node";
import { Container, ScrollView, type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { BackgroundTaskGroupComponent } from "../src/modes/interactive/components/background-task-group.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { SubagentGroupComponent } from "../src/modes/interactive/components/subagent-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokThinkingTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-thinking-turn-group.ts";
import { GrokToolExecutionComponent } from "../src/modes/interactive-grok/components/grok-tool-execution.ts";
import { GrokToolTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-tool-turn-group.ts";

beforeAll(() => initTheme("dark"));
const ui = { requestRender: () => {} } as unknown as TUI;
const text = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");
function paint(component: Container | CompactionSummaryMessageComponent) {
	const terminal = new VirtualTerminal(80, 40);
	const document = new Container();
	document.addChild(component);
	const scroll = new ScrollView(document);
	const copySelection = vi.fn(async () => true);
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection,
		onContentClick: (click) => tui.getRenderedContentClickHandler(scroll, component)?.(click.row, click.col) ?? false,
	});
	tui.setLayoutRoot(scroll);
	tui.start();
	tui.renderNow();
	return { terminal, tui, scroll, copySelection };
}

test.each(["Activity", "Diagnostics"])(
	"displayed subagent %s survives unseen mailbox growth without rendering",
	async (label) => {
		const group = new SubagentGroupComponent("/root/worker");
		const tool = new ToolExecutionComponent("spawn_agent", "call", {}, {}, undefined, ui, process.cwd());
		group.addTool("spawn_agent", tool, { task: { objective: "inspect" } });
		group.addMailboxResult({ text: "First result" });
		group.setExpanded(true);
		const { terminal, tui, scroll } = paint(group);
		try {
			await terminal.flush();
			const row = terminal.getViewport().findIndex((line) => line.includes(label));
			expect(row).toBeGreaterThan(0);
			group.addMailboxResult({ text: Array.from({ length: 8 }, (_, i) => `Unseen ${i}`).join("\n") });
			expect(group.handleOverviewClick(row, 80)).toBe(false); // Causal baseline: current layout moved the control.
			const render = vi.spyOn(group, "render");
			const handler = tui.getRenderedContentClickHandler(scroll, group);
			expect(handler).toBeDefined();
			expect(handler?.(row, 5)).toBe(true);
			expect(render).not.toHaveBeenCalled();
			expect(text(group.render(80))).toContain(label === "Activity" ? "Task assigned" : "Tool receipts");
		} finally {
			tui.stop({ preserveScreen: true });
		}
	},
);

test("mouse activates the displayed Activity row after unseen results without copying or re-rendering for hit testing", async () => {
	const group = new SubagentGroupComponent("/root/worker");
	const tool = new ToolExecutionComponent("spawn_agent", "call", {}, {}, undefined, ui, process.cwd());
	group.addTool("spawn_agent", tool, { task: { objective: "inspect" } });
	group.addMailboxResult({ text: "First result" });
	group.setExpanded(true);
	const { terminal, tui, copySelection } = paint(group);
	try {
		await terminal.flush();
		const row = terminal.getViewport().findIndex((line) => line.includes("Activity")) + 1;
		expect(row).toBeGreaterThan(1);
		group.addMailboxResult({ text: "unseen result\n".repeat(8) });
		const render = vi.spyOn(group, "render");
		terminal.sendInput(`\x1b[<0;6;${row}M`);
		terminal.sendInput(`\x1b[<32;6;${row}M`);
		terminal.sendInput(`\x1b[<0;6;${row}m`);
		expect(render).not.toHaveBeenCalled();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Task assigned");
		expect(copySelection).not.toHaveBeenCalled();
	} finally {
		tui.stop({ preserveScreen: true });
	}
});

test("displayed task ranges retain task identity after sorting and unseen detail growth", () => {
	const records: BackgroundTaskRecord[] = ["first", "second"].map((id, i) => ({
		id,
		command: id,
		cwd: "/tmp",
		status: "running",
		startedAt: i,
		lastOutputAt: i,
		outputPath: `/tmp/${id}.log`,
		promoted: false,
	}));
	let output = "old output";
	const manager = {
		list: () => records,
		onStart: () => () => {},
		onTerminal: () => () => {},
		stallTimeoutMs: 0,
		readOutput: () => ({ ok: true, value: { output } }),
	} as unknown as BackgroundTaskManager;
	const group = new BackgroundTaskGroupComponent(manager, () => {});
	group.setExpanded(true);
	group.handleOverviewClick(1, 80);
	const { tui, scroll } = paint(group);
	try {
		const displayed = group.render(80);
		const targetRow = displayed.findIndex((line) => line.includes("second Running"));
		expect(targetRow).toBeGreaterThan(1);
		output = Array.from({ length: 8 }, (_, i) => `unseen output ${i}`).join("\n");
		records[0]!.status = "succeeded"; // Changes sorting as well as height before the clicked task.
		const render = vi.spyOn(group, "render");
		expect(tui.getRenderedContentClickHandler(scroll, group)?.(targetRow, 0)).toBe(true);
		expect(render).not.toHaveBeenCalled();
		const lines = group.render(80);
		expect(text(lines)).toContain("/tmp/second.log");
		expect(text(lines)).not.toContain("/tmp/first.log");
		group.dispose();
		expect(tui.getRenderedContentClickHandler(scroll, group)?.(0, 0)).toBe(false);
	} finally {
		group.dispose();
		tui.stop({ preserveScreen: true });
	}
});

test("displayed tool ranges do not re-render or retarget after unseen details grow", () => {
	const group = new GrokToolTurnGroupComponent();
	const tools = ["first", "second"].map(
		(name) => new GrokToolExecutionComponent(name, name, {}, {}, undefined, ui, process.cwd()),
	);
	for (const tool of tools) group.addTool(tool);
	group.setExpanded(true);
	const initialRenders = tools.map((tool) => vi.spyOn(tool, "render"));
	const { tui, scroll } = paint(group);
	for (const render of initialRenders) {
		expect(render).toHaveBeenCalledTimes(1);
		render.mockRestore();
	}
	try {
		const displayed = group.render(80);
		const row = displayed.findIndex(
			(line) =>
				stripVTControlCharacters(line).includes("◆ second") ||
				stripVTControlCharacters(line).startsWith("◇ second"),
		);
		expect(row).toBeGreaterThan(1);
		tools[0]!.updateResult({ content: [{ type: "text", text: "unseen\n".repeat(8) }], isError: false });
		tools[1]!.setExpanded(false); // Unseen setter must not reverse the displayed collapse intent.
		const renders = tools.map((tool) => vi.spyOn(tool, "render"));
		expect(tui.getRenderedContentClickHandler(scroll, group)?.(row, 0)).toBe(true);
		for (const render of renders) expect(render).not.toHaveBeenCalled();
		expect(tools[1]!.render(80)).toHaveLength(1);
		expect(tools[0]!.render(80).length).toBeGreaterThan(1);
		group.removeChild(tools[1]!);
		expect(tui.getRenderedContentClickHandler(scroll, group)?.(row, 0)).toBe(false);
	} finally {
		group.dispose();
		tui.stop({ preserveScreen: true });
	}
});

test.each(["default", "self"] as const)(
	"closes an expanded compact tool whose %s extension renderers produce no rows",
	(renderShell) => {
		const empty = { render: () => [], invalidate: () => {} };
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
		const definition: ToolDefinition = {
			name: "empty_extension",
			label: "empty",
			description: "empty renderer regression",
			parameters: Type.Any(),
			execute,
			renderShell,
			renderCall: () => empty,
			renderResult: () => empty,
		};
		const tool = new GrokToolExecutionComponent("empty_extension", "empty", {}, {}, definition, ui, process.cwd());
		tool.setTurnGrouped(true);
		tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const group = new GrokToolTurnGroupComponent();
		group.addTool(tool);
		group.setExpanded(true);
		const render = vi.spyOn(tool, "render");
		const { tui, scroll } = paint(group);
		try {
			expect(render).toHaveBeenCalledTimes(1);
			expect(render.mock.results[0]?.value).toHaveLength(1); // Expanded state has no body rows.
			expect(tool.isExpanded()).toBe(true);
			const setExpanded = vi.spyOn(tool, "setExpanded");
			expect(tui.getRenderedContentClickHandler(scroll, group)?.(1, 0)).toBe(true);
			expect(setExpanded).toHaveBeenCalledWith(false);
			expect(tool.isExpanded()).toBe(false);
			expect(render).toHaveBeenCalledTimes(1);
			expect(execute).not.toHaveBeenCalled();
		} finally {
			group.dispose();
			tui.stop({ preserveScreen: true });
		}
	},
);

test("displayed thinking bounds survive an external render of shorter unseen content", () => {
	const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking", 1, false);
	const owner = {};
	group.updateThinking(owner, "first\n\nsecond\n\nthird");
	group.setExpanded(true);
	const { tui, scroll } = paint(group);
	try {
		const lastRow = group.render(80).length - 1;
		group.updateThinking(owner, "short");
		group.render(80); // Must not replace the displayed frame callback/bounds.
		const render = vi.spyOn(group, "render");
		expect(tui.getRenderedContentClickHandler(scroll, group)?.(lastRow, 0)).toBe(true);
		expect(render).not.toHaveBeenCalled();
		expect(group.render(80)).toHaveLength(1);
		group.dispose();
		expect(tui.getRenderedContentClickHandler(scroll, group)?.(0, 0)).toBe(false);
	} finally {
		group.dispose();
		tui.stop({ preserveScreen: true });
	}
});

test("compaction captures displayed header and rejects padding without re-rendering", () => {
	const component = new CompactionSummaryMessageComponent({
		role: "compactionSummary",
		summary: "Body",
		tokensBefore: 1000,
		timestamp: 1,
	});
	const { tui, scroll } = paint(component);
	try {
		const render = vi.spyOn(component, "render");
		const handler = tui.getRenderedContentClickHandler(scroll, component);
		expect(handler?.(0, 0)).toBe(false);
		expect(handler?.(1, 0)).toBe(true);
		expect(render).not.toHaveBeenCalled();
		expect(text(component.render(80))).toContain("Body");
	} finally {
		tui.stop({ preserveScreen: true });
	}
});
