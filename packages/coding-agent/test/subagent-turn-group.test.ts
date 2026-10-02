import { Container, getRenderedContentClickHandlers, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, expect, test } from "vitest";
import {
	SubagentGroupComponent,
	SubagentTranscriptRouter,
	SubagentTurnGroupComponent,
} from "../src/modes/interactive/components/subagent-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeEach(() => initTheme("dark"));
function tool(name: string, args: unknown) {
	return new ToolExecutionComponent(
		name,
		"call",
		args,
		{},
		undefined,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
}
function result(component: ToolExecutionComponent, value: unknown, isError = false) {
	component.updateResult({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
}
function mailbox(path: string, turnId: string, text: string) {
	return {
		customType: "epi-collaboration-message",
		timestamp: 40,
		content: JSON.stringify({
			id: `result-${turnId}`,
			from: path,
			to: "/root",
			kind: "result",
			status: "completed",
			turnId,
			text,
		}),
	};
}

test("several children collapse to one newest preview, and expand in two levels", () => {
	const container = new Container();
	const router = new SubagentTranscriptRouter(container, () => false);
	for (const path of ["a", "b", "c"]) {
		const args = { task_name: path, task: { objective: `TASK_${path}` } };
		const component = tool("spawn_agent", args);
		expect(router.handleTool("spawn_agent", args, component)).toBe(true);
		result(component, { turn_id: path, task_name: `/root/${path}` });
	}
	expect(container.children).toHaveLength(1);
	const aggregate = router.turnGroups()[0];
	expect(aggregate).toBeInstanceOf(SubagentTurnGroupComponent);
	expect(aggregate.agentCount).toBe(3);
	expect(aggregate.render(120)).toHaveLength(1);
	expect(stripAnsi(aggregate.render(120)[0])).toContain("TASK_c");
	expect(stripAnsi(aggregate.render(120)[0])).toContain(" · 3");
	expect(stripAnsi(aggregate.render(120)[0])).not.toMatch(/Subagent|[▸▾]/);
	expect(aggregate.handleOverviewClick(0, 120)).toBe(true);
	expect(aggregate.render(120)).toHaveLength(4);
	expect(aggregate.handleOverviewClick(2, 120)).toBe(true);
	expect(stripAnsi(aggregate.render(120).join("\n"))).toContain("Task: TASK_b");
	expect(aggregate.handleOverviewClick(0, 120)).toBe(true);
	expect(aggregate.render(120)).toHaveLength(1);
});

test("aggregate preview never changes a child's expansion or diagnostics", () => {
	const leaf = new SubagentGroupComponent("/root/a");
	leaf.addMailboxResult({ from: "/root/a", id: "m", turnId: "t", status: "completed", text: "LATEST_RESULT" });
	leaf.setExpanded(true);
	const expanded = leaf.render(80).map(stripAnsi);
	leaf.handleOverviewClick(
		expanded.findIndex((line) => line.includes("Diagnostics")),
		80,
	);
	const before = leaf.render(80).map(stripAnsi).join("\n");
	const aggregate = new SubagentTurnGroupComponent();
	aggregate.setExpanded(true);
	aggregate.addAgent(leaf);
	const open = leaf.render(80).map(stripAnsi).join("\n");
	expect(open).toBe(before);
	const preview = leaf.overviewLine(80);
	expect(stripAnsi(preview)).toContain("LATEST_RESULT");
	expect(leaf.render(80).map(stripAnsi).join("\n")).toBe(open);
});

test("late receipts remain on the submitting turn and same-agent followup creates a new leaf", () => {
	const container = new Container();
	const first = {},
		second = {};
	let current = first;
	const mounts: Array<{ component: SubagentTurnGroupComponent; owner: object }> = [];
	const router = new SubagentTranscriptRouter(container, () => false, {
		getTurn: () => current,
		mount: (component, owner) => {
			mounts.push({ component, owner });
			container.addChild(component);
		},
	});
	const spawn = tool("spawn_agent", {});
	router.handleTool("spawn_agent", { task_name: "a", task: { objective: "FIRST" } }, spawn, 10);
	result(spawn, { turn_id: "child-first" });
	current = second;
	router.handleMailboxMessage(mailbox("/root/a", "child-first", "OLD_RESULT"));
	expect(mounts).toHaveLength(1);
	expect(mounts[0].owner).toBe(first);
	expect(router.turnGroups()[0].render(100)).toHaveLength(1);
	expect(stripAnsi(router.turnGroups()[0].render(100)[0])).toContain("OLD_RESULT");
	const followup = tool("followup_task", {});
	router.handleTool("followup_task", { target: "/root/a", task: { objective: "SECOND" } }, followup, 30);
	result(followup, { turn_id: "child-second" });
	expect(mounts[1].owner).toBe(second);
	expect(router.currentGroups()).toHaveLength(2);
	router.handleMailboxMessage(mailbox("/root/a", "child-first", "OLD_RESULT"));
	expect(stripAnsi(router.turnGroups()[1].render(100)[0])).toContain("SECOND");
	router.handleMailboxMessage(mailbox("/root/a", "child-second", "NEW_RESULT"));
	expect(stripAnsi(router.turnGroups()[1].render(100)[0])).toContain("NEW_RESULT");
});

test("fast completion before receipt after a user boundary uses pending assignment owner", () => {
	const first = {},
		second = {};
	let current = first;
	const mounts: object[] = [];
	const router = new SubagentTranscriptRouter(new Container(), () => false, {
		getTurn: () => current,
		mount: (_group, owner) => mounts.push(owner),
	});
	const spawn = tool("spawn_agent", {});
	router.handleTool("spawn_agent", { task_name: "a", task: { objective: "FIRST" } }, spawn);
	current = second;
	router.handleMailboxMessage(mailbox("/root/a", "fast", "FAST_RESULT"));
	result(spawn, { turn_id: "fast" });
	expect(mounts).toEqual([first]);
	expect(stripAnsi(router.turnGroups()[0].render(120)[0])).toContain("FAST_RESULT");
});

test("querying an old child turn is current-turn activity, not permission to move its original group", () => {
	let current: object = {};
	const container = new Container();
	const router = new SubagentTranscriptRouter(container, () => false, {
		getTurn: () => current,
		mount: (group) => container.addChild(group),
	});
	const spawn = tool("spawn_agent", {});
	router.handleTool("spawn_agent", { task_name: "a" }, spawn);
	result(spawn, { turn_id: "old" });
	const original = router.turnGroups()[0];
	current = {};
	const query = tool("get_agent_result", {});
	router.handleTool("get_agent_result", { target: "a", turn_id: "old" }, query);
	result(query, { state: "history_unavailable", target: "/root/a", history_coverage: "retained_only" });
	expect(container.children).toEqual([original, router.turnGroups()[1]]);
	router.handleMailboxMessage(mailbox("/root/a", "old", "RETAINED"));
	expect(container.children).toEqual([original, router.turnGroups()[1]]);
});

test("painted nested controls remain tied to returned lines after late content changes", () => {
	const leaf = new SubagentGroupComponent("/root/a");
	const args = { task: { objective: "short" } };
	leaf.addTool("spawn_agent", tool("spawn_agent", args), args);
	const aggregate = new SubagentTurnGroupComponent();
	aggregate.addAgent(leaf);
	aggregate.setExpanded(true);
	const painted = aggregate.render(80);
	const activity = painted.map(stripAnsi).findIndex((line) => line.includes("Activity"));
	const handler = getRenderedContentClickHandlers(painted)?.get(aggregate);
	expect(handler).toBeDefined();
	leaf.addMailboxResult({ from: "/root/a", turnId: "t", id: "m", status: "completed", text: "added\n".repeat(30) });
	expect(handler!(activity, 1)).toBe(true);
	expect(stripAnsi(aggregate.render(80).join("\n"))).toContain("Task assigned");
	const header = getRenderedContentClickHandlers(aggregate.render(80))?.get(aggregate);
	expect(header!(0, 1)).toBe(true);
	expect(handler!(activity, 1)).toBe(false);
	expect(aggregate.render(80)).toHaveLength(1);
});

test("empty/zero-width, clear, disposed controls and narrow headers are bounded", () => {
	const container = new Container();
	const router = new SubagentTranscriptRouter(container, () => false);
	expect(new SubagentTurnGroupComponent().render(80)).toEqual([]);
	router.handleMailboxMessage(mailbox("/root/a", "t", "结果🙂"));
	const aggregate = router.turnGroups()[0];
	for (const width of [0, 1, 2, 8, 24, 80])
		expect(aggregate.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	const painted = aggregate.render(80);
	const handler = getRenderedContentClickHandlers(painted)?.get(aggregate);
	router.clear();
	expect(container.children).toEqual([]);
	expect(router.currentGroups()).toEqual([]);
	expect(handler!(0, 0)).toBe(false);
});
