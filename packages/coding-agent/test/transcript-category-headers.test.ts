import type { BackgroundTaskManager, BackgroundTaskRecord } from "@earendil-works/pi-agent-core/node";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { BackgroundTaskGroupComponent } from "../src/modes/interactive/components/background-task-group.ts";
import {
	SubagentGroupComponent,
	SubagentTurnGroupComponent,
} from "../src/modes/interactive/components/subagent-group.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { GrokThinkingTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-thinking-turn-group.ts";
import { GrokToolExecutionComponent } from "../src/modes/interactive-grok/components/grok-tool-execution.ts";
import { GrokToolTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-tool-turn-group.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

test("tool group marker follows the displayed tool's current state", () => {
	initTheme("dark");
	const makeTool = (id: string) =>
		new GrokToolExecutionComponent(
			"read",
			id,
			{ path: `/tmp/${id}` },
			{},
			undefined,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
	const group = new GrokToolTurnGroupComponent();
	const older = makeTool("older");
	older.updateResult({ content: [], isError: true });
	group.addTool(older);
	const current = makeTool("current");
	group.addTool(current);
	const check = (color: "muted" | "accent" | "success" | "error") => {
		const row = group.render(100)[0];
		expect(row.startsWith(theme.fg(color, "◆ "))).toBe(true);
		expect(stripAnsi(row)).toContain("/tmp/current");
	};
	try {
		check("muted");
		current.markExecutionStarted();
		check("accent");
		current.updateResult({ content: [], isError: false });
		check("success");
		current.updateResult({ content: [], isError: true });
		check("error");
	} finally {
		group.dispose();
	}
});

test("category headers have distinct symbols and no failure badges", () => {
	initTheme("dark");
	const thinking = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking...", 1, false);
	thinking.updateThinking({}, "latest reasoning");
	thinking.completeTurn();
	const tool = new GrokToolExecutionComponent(
		"edit",
		"failed-tool",
		{ path: "/tmp/latest.ts" },
		{},
		undefined,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
	tool.updateResult({ content: [{ type: "text", text: "ERROR_DETAIL" }], isError: true }, false);
	const tools = new GrokToolTurnGroupComponent();
	tools.addTool(tool);
	tools.completeTurn();
	const task: BackgroundTaskRecord = {
		id: "task-1",
		command: "latest command",
		cwd: process.cwd(),
		status: "failed",
		startedAt: 1,
		endedAt: 2,
		lastOutputAt: 1,
		outputPath: "/tmp/log",
		promoted: false,
	};
	const manager = {
		list: () => [task],
		onStart: () => () => {},
		onTerminal: () => () => {},
		stallTimeoutMs: 0,
	} as unknown as BackgroundTaskManager;
	const background = new BackgroundTaskGroupComponent(manager, () => {});
	background.completeTurn();
	const childAgent = new SubagentGroupComponent("/root/worker");
	childAgent.addMailboxResult({
		id: "m1",
		from: "/root/worker",
		turnId: "t1",
		status: "failed",
		text: JSON.stringify({ summary: "latest result", outcome: "failed" }),
		resultValidation: { contract: "not_completed" },
	});
	const subagent = new SubagentTurnGroupComponent();
	subagent.addAgent(childAgent);
	const categories = [
		{ component: thinking, label: "✦", color: "accent" },
		{ component: tools, label: "◆", color: "error" },
		{ component: background, label: "⚙", color: "warning" },
		{ component: subagent, label: "↳", color: "success" },
	] as const;
	try {
		expect(new Set(categories.map(({ color }) => theme.getFgAnsi(color))).size).toBe(4);
		for (const { component, label, color } of categories) {
			const lines = component.render(120);
			expect(lines).toHaveLength(1);
			expect(stripAnsi(lines[0])).toBeTruthy();
			expect(stripAnsi(lines[0]).startsWith(label)).toBe(true);
			expect(stripAnsi(lines[0])).not.toMatch(/[▸▾]/);
			expect(stripAnsi(lines[0])).not.toMatch(/Thinking|Tools|Background|Subagent/);
			expect(lines[0]).toContain(theme.getFgAnsi(color));
			expect(stripAnsi(lines[0])).not.toMatch(/\bfailed\b/i);
			for (const width of [1, 2, 8, 24, 40])
				expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		tools.setExpanded(true);
		expect(stripAnsi(tools.render(120)[0])).not.toMatch(/[▸▾]/);
		expect(stripAnsi(tools.render(120).join("\n"))).toContain("ERROR_DETAIL");
		background.setExpanded(true);
		expect(stripAnsi(background.render(120)[0])).not.toMatch(/[▸▾]/);
		expect(stripAnsi(background.render(120).slice(1).join("\n"))).toContain("Failed");
		subagent.setExpanded(true);
		expect(stripAnsi(subagent.render(120)[0])).not.toMatch(/[▸▾]/);
		expect(stripAnsi(subagent.render(120).join("\n"))).toContain("Outcome: failed");
		thinking.setExpanded(true);
		expect(stripAnsi(thinking.render(120)[0])).not.toMatch(/[▸▾]/);
		expect(stripAnsi(thinking.render(120)[0])).toBe("✦");
		for (const component of [thinking, tools, background, subagent]) {
			expect(component.handleOverviewClick(0, 120)).toBe(true);
			expect(component.render(120)).toHaveLength(1);
		}
	} finally {
		thinking.dispose();
		tools.dispose();
		background.dispose();
	}
});
