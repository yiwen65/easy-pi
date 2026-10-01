import { ScrollView, type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { SubagentGroupComponent } from "../src/modes/interactive/components/subagent-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

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
