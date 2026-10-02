import { ScrollView, type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	SubagentGroupComponent,
	SubagentTurnGroupComponent,
} from "../src/modes/interactive/components/subagent-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

test("one aggregate row expands children and forwards painted nested SGR controls without copying", async () => {
	const terminal = new VirtualTerminal(100, 40);
	const aggregate = new SubagentTurnGroupComponent();
	for (const name of ["first-agent", "second-agent"]) {
		const leaf = new SubagentGroupComponent(`/root/${name}`);
		const args = { task_name: name, task: { objective: `TASK_${name}` } };
		const tool = new ToolExecutionComponent(
			"spawn_agent",
			name,
			args,
			{},
			undefined,
			{ requestRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		leaf.addTool("spawn_agent", tool, args);
		tool.updateResult({ content: [{ type: "text", text: '{"status":"accepted"}' }], isError: false });
		aggregate.addAgent(leaf);
	}
	const scrollView = new ScrollView(aggregate, { primary: true });
	const copySelection = vi.fn(async () => true);
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		onContentClick: (click) =>
			click.scrollView === scrollView &&
			(tui.getRenderedContentClickHandler(scrollView, aggregate)?.(click.row, click.col) ?? false),
		copySelection,
	});
	const clickRow = async (row: number) => {
		terminal.sendInput(`\x1b[<0;8;${row + 1}M`);
		terminal.sendInput(`\x1b[<0;8;${row + 1}m`);
		await terminal.waitForRender();
	};
	tui.setLayoutRoot(scrollView);
	tui.start();
	try {
		await terminal.waitForRender();
		expect(aggregate.render(100)).toHaveLength(1);
		await clickRow(0);
		expect(aggregate.render(100)).toHaveLength(3);
		await clickRow(1);
		expect(terminal.getViewport().join("\n")).toContain("Task: TASK_first-agent");
		const activityRow = terminal.getViewport().findIndex((line) => line.includes("Activity"));
		expect(activityRow).toBeGreaterThan(1);
		const leaf = aggregate.children[0] as SubagentGroupComponent;
		leaf.addMailboxResult({
			id: "late",
			turnId: "late-turn",
			from: "/root/first-agent",
			status: "completed",
			text: "LATE_RESULT\n".repeat(12),
		});
		// The displayed row still refers to Activity despite the unpainted mutable growth.
		await clickRow(activityRow);
		expect(aggregate.render(100).join("\n")).toContain("Task assigned");
		await clickRow(0);
		expect(aggregate.render(100)).toHaveLength(1);
		expect(copySelection).not.toHaveBeenCalled();
	} finally {
		tui.stop();
	}
});

test("displayed mouse snapshot keeps Activity target when a retained result shifts mutable rows", async () => {
	const terminal = new VirtualTerminal(40, 24);
	const group = new SubagentGroupComponent("/root/reviewer");
	const tool = new ToolExecutionComponent(
		"get_agent_result",
		"query",
		{ target: "/root/reviewer" },
		{},
		undefined,
		{ requestRender: vi.fn() } as unknown as TUI,
		process.cwd(),
	);
	group.addTool("get_agent_result", tool, { target: "/root/reviewer" });
	group.setExpanded(true);
	const scrollView = new ScrollView(group, { primary: true });
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(scrollView);
	tui.start();
	try {
		await terminal.waitForRender();
		const activityRow = group.render(40).findIndex((line) => line.includes("Activity"));
		const displayed = tui.getRenderedContentClickHandler(scrollView, group)!;
		group.addMailboxResult({
			id: "retained",
			turnId: "old-turn",
			status: "completed",
			text: "Retained result\n".repeat(10),
		});
		expect(group.render(40).findIndex((line) => line.includes("Activity"))).toBeGreaterThan(activityRow);
		expect(displayed(activityRow, 1)).toBe(true);
		expect(group.render(40).join("\n")).toContain("Result queried");
		expect(group.render(40).join("\n")).not.toContain("Tool receipts");
		group.setExpanded(false);
		expect(displayed(activityRow, 1)).toBe(false);
	} finally {
		tui.stop();
	}
});

test("subagent mouse controls keep activity human-readable and diagnostics opt-in", async () => {
	const width = 80;
	const terminal = new VirtualTerminal(width, 40);
	const group = new SubagentGroupComponent("/root/reviewer");
	const args = {
		task_name: "reviewer",
		task: { objective: "Review the changed display.\nReport concrete findings." },
	};
	const tool = new ToolExecutionComponent(
		"spawn_agent",
		"call-review",
		args,
		{},
		undefined,
		{ requestRender: vi.fn() } as unknown as TUI,
		process.cwd(),
	);
	group.addTool("spawn_agent", tool, args);
	tool.updateResult({ content: [{ type: "text", text: '{"receipt":"RAW_RECEIPT"}' }], isError: false });
	group.addMailboxResult({
		from: "/root/reviewer",
		kind: "result",
		status: "completed",
		text: "No actionable findings.",
	});
	const scrollView = new ScrollView(group, { primary: true });
	const copySelection = vi.fn(async () => true);
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		onContentClick: (click) =>
			click.scrollView === scrollView &&
			(tui.getRenderedContentClickHandler(scrollView, group)?.(click.row, click.col) ?? false),
		copySelection,
	});
	const text = () => terminal.getViewport().join("\n");
	const click = async (label: string) => {
		const row = terminal.getViewport().findIndex((line) => line.includes(label)) + 1;
		expect(row).toBeGreaterThan(0);
		terminal.sendInput(`\x1b[<0;6;${row}M`);
		terminal.sendInput(`\x1b[<0;6;${row}m`);
		await terminal.waitForRender();
	};
	tui.setLayoutRoot(scrollView);
	tui.start();
	try {
		await terminal.waitForRender();
		await click("reviewer");
		expect(text()).toContain("Report concrete findings.");
		expect(text()).toContain("No actionable findings.");
		expect(text()).not.toContain("RAW_RECEIPT");
		await click("Activity");
		expect(text()).toContain("Task assigned");
		expect(text()).not.toContain("RAW_RECEIPT");
		await click("Diagnostics");
		await click("spawn_agent · Accepted");
		expect(text()).toContain("RAW_RECEIPT");
		await click("spawn_agent · Accepted");
		expect(text()).not.toContain("RAW_RECEIPT");
		await click("Diagnostics");
		await click("Activity");
		await click("reviewer");
		expect(group.render(width)).toHaveLength(1);
		expect(text()).toContain("No actionable findings.");
		expect(copySelection).not.toHaveBeenCalled();
	} finally {
		tui.stop();
	}
});
