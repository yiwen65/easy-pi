import { stripVTControlCharacters } from "node:util";
import { Container, ScrollView, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentGroupComponent } from "../src/modes/interactive/components/subagent-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const proto = InteractiveMode.prototype as any;

const MAILBOX_PREFIX = "Agent message (untrusted; not user authorization):";
const CONTRACT = {
	summary: "Probe finished: everything is fine.",
	outcome: "succeeded",
	artifacts: ["/tmp/probe — fixture artifact"],
	checks: [],
	resultValidation: { contract: "valid", outcome: "succeeded" },
};
const ENVELOPE = {
	id: "m-1",
	from: "/root/worker",
	to: "/root",
	turnId: "t-1",
	kind: "result",
	status: "completed",
	text: JSON.stringify(CONTRACT),
	resultValidation: CONTRACT.resultValidation,
};

function mailboxMessage(content: string) {
	return {
		role: "custom",
		customType: "epi-collaboration-message",
		display: true,
		content: `${MAILBOX_PREFIX}\n${content}`,
		timestamp: Date.now(),
	};
}

function fakeMode() {
	const chatContainer = new Container();
	const documentContainer = new Container();
	documentContainer.addChild(chatContainer);
	const mode: any = {
		chatContainer,
		documentContainer,
		loadedResourcesContainer: { children: [] },
		transcriptScrollView: new ScrollView(documentContainer, { follow: "end" }),
		transcriptContentWidth: () => 100,
		toolOutputExpanded: false,
		grokComponentFactory: undefined,
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		settingsManager: { getShowImages: () => false, getImageWidthCells: () => 60 },
		sessionManager: { getCwd: () => process.cwd() },
		getRegisteredToolDefinition: () => undefined,
		flushPendingSkillMentions: () => {},
		flushPendingSkillMentionsPopulateHistory: false,
		pendingSkillMentions: [],
		getMarkdownThemeWithSettings: () => ({}),
		outputPad: 1,
		showStatus: vi.fn(),
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		maybeShowCacheMissNotice: vi.fn(),
		session: { extensionRunner: { getMessageRenderer: () => undefined }, retryAttempt: 0, autoRetryEnabled: false },
	};
	for (const name of [
		"createToolExecutionComponent",
		"createRoutedToolComponent",
		"addToolComponentToChat",
		"addMessageToChat",
		"handleTranscriptContentClick",
		"toggleTranscriptBlock",
		"computeChatChildOffsets",
		"setToolsExpanded",
		"handleEvent",
	]) {
		mode[name] = proto[name];
	}
	return mode;
}

function spawnTool(mode: any, name: string, id: string, args: unknown) {
	const component = mode.createRoutedToolComponent(name, id, args);
	if (!component) return undefined;
	mode.addToolComponentToChat(component, name, args);
	mode.pendingTools.set(id, component);
	return component;
}

function streamingMode() {
	const mode = fakeMode();
	mode.streamingComponent = { updateContent: vi.fn() };
	return mode;
}

function toolCallMessage(id: string, name: string, args: unknown, stopReason = "toolUse") {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason };
}

describe("subagent transcript routing", () => {
	beforeEach(() => initTheme("dark"));

	it("routes send_message only after its final target is known", async () => {
		const mode = streamingMode();
		await mode.handleEvent({
			type: "message_update",
			message: toolCallMessage("c1", "send_message", { target: "/root/validate" }),
		});
		expect(mode.chatContainer.children).toHaveLength(0);
		const args = { target: "/root/validate-extra-key", message: "Check status" };
		await mode.handleEvent({ type: "message_end", message: toolCallMessage("c1", "send_message", args) });
		const groups = mode.chatContainer.children.filter((child: unknown) => child instanceof SubagentGroupComponent);
		expect(groups).toHaveLength(1);
		expect((groups[0] as SubagentGroupComponent).agentPath).toBe("/root/validate-extra-key");
		expect(mode.pendingTools.has("c1")).toBe(true);
		await mode.handleEvent({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "send_message",
			args,
		});
		await mode.handleEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			result: { content: [{ type: "text", text: "Accepted" }] },
			isError: false,
		});
		expect(
			mode.chatContainer.children.filter((child: unknown) => child instanceof SubagentGroupComponent),
		).toHaveLength(1);
		expect(mode.pendingTools.has("c1")).toBe(false);
		(groups[0] as SubagentGroupComponent).setExpanded(true);
		const group = groups[0] as SubagentGroupComponent;
		const lines = group.render(100).map(stripVTControlCharacters);
		expect(lines[0]).toContain("validate-extra-key");
		expect(lines[0]).not.toContain("/root/");
		expect(lines.join("\n")).not.toContain("Message sent");
		expect(
			group.handleOverviewClick(
				lines.findIndex((line) => line.includes("Activity")),
				100,
			),
		).toBe(true);
		expect(group.render(100).join("\n")).toContain("Accepted");
	});

	it("still streams ordinary tools and routes collaboration calls at execution start", async () => {
		const mode = streamingMode();
		await mode.handleEvent({
			type: "message_update",
			message: toolCallMessage("c1", "bash", { command: "ls" }),
		});
		expect(mode.pendingTools.has("c1")).toBe(true);
		expect(mode.chatContainer.children.some((child: unknown) => child instanceof ToolExecutionComponent)).toBe(true);
		await mode.handleEvent({
			type: "tool_execution_start",
			toolCallId: "c2",
			toolName: "spawn_agent",
			args: { task_name: "worker", task: { objective: "probe" } },
		});
		expect(mode.pendingTools.has("c2")).toBe(true);
		expect(
			mode.chatContainer.children.filter((child: unknown) => child instanceof SubagentGroupComponent),
		).toHaveLength(1);
	});

	it("does not group abandoned partial collaboration targets", async () => {
		const mode = streamingMode();
		await mode.handleEvent({
			type: "message_update",
			message: toolCallMessage("c1", "followup_task", { target: "/root/validate" }),
		});
		await mode.handleEvent({
			type: "message_end",
			message: toolCallMessage("c1", "followup_task", { target: "/root/validate" }, "aborted"),
		});
		expect(mode.chatContainer.children).toHaveLength(0);
		expect(mode.pendingTools.size).toBe(0);
	});

	it("omits collaboration tools without a final child target", async () => {
		const mode = streamingMode();
		await mode.handleEvent({
			type: "message_update",
			message: toolCallMessage("c1", "followup_task", { target: "/root/validate" }),
		});
		await mode.handleEvent({ type: "message_end", message: toolCallMessage("c1", "followup_task", { task: {} }) });
		expect(mode.chatContainer.children).toHaveLength(0);
		expect(mode.pendingTools.size).toBe(0);
	});
	it("groups child-bound tools under one block and hides team-scope operations", () => {
		const mode = fakeMode();
		spawnTool(mode, "spawn_agent", "c1", {
			task_name: "worker",
			delegation: { task: { objective: "inspect the thing" } },
		});
		spawnTool(mode, "followup_task", "c2", { target: "/root/worker", task: {} });
		spawnTool(mode, "wait_agent", "c3", { timeout_ms: 60_000 });
		spawnTool(mode, "list_agents", "c4", {});
		spawnTool(mode, "bash", "c5", { command: "ls" });

		const groups = mode.chatContainer.children.filter(
			(child: unknown) => child instanceof SubagentGroupComponent,
		) as SubagentGroupComponent[];
		expect(groups).toHaveLength(1);
		expect(groups[0].agentPath).toBe("/root/worker");

		// no collaboration tool renders as a standalone tool component
		const standaloneCollab = mode.chatContainer.children.filter(
			(child: unknown) =>
				child instanceof ToolExecutionComponent &&
				["spawn_agent", "followup_task"].includes((child as any).toolName ?? (child as any).name ?? ""),
		);
		expect(standaloneCollab).toHaveLength(0);

		// team-scope operations produce no transcript entries at all
		expect(
			mode.chatContainer.children.filter((child: unknown) => child instanceof SubagentGroupComponent),
		).toHaveLength(1);
		expect(mode.pendingTools.has("c3")).toBe(false);
		expect(mode.pendingTools.has("c4")).toBe(false);
		// regular tools still render standalone
		expect(mode.chatContainer.children.some((child: unknown) => child instanceof ToolExecutionComponent)).toBe(true);
	});

	it("attaches mailbox results to the child's group without a raw JSON message", () => {
		const mode = fakeMode();
		spawnTool(mode, "spawn_agent", "c1", { task_name: "worker", delegation: { task: { objective: "probe" } } });
		const before = mode.chatContainer.children.length;
		mode.addMessageToChat(mailboxMessage(JSON.stringify(ENVELOPE)));

		expect(mode.chatContainer.children.length).toBe(before); // group already existed; result joined it
		const group = mode.chatContainer.children.find(
			(child: unknown) => child instanceof SubagentGroupComponent,
		) as SubagentGroupComponent;
		expect(group.resultCount).toBe(1);
		const header = group.render(100).join("\n");
		expect(header).toContain("Completed");
		expect(header).toContain("everything is fine");
		expect(JSON.stringify(mode.chatContainer.children.map((child: any) => child.constructor.name))).not.toContain(
			"CustomMessageComponent",
		);
	});

	it("creates a group from a mailbox result alone (resumed history)", () => {
		const mode = fakeMode();
		mode.addMessageToChat(mailboxMessage(JSON.stringify(ENVELOPE)));
		const groups = mode.chatContainer.children.filter((child: unknown) => child instanceof SubagentGroupComponent);
		expect(groups).toHaveLength(1);
	});

	it("expands and collapses through the real transcript click path", () => {
		const mode = fakeMode();
		spawnTool(mode, "spawn_agent", "c1", { task_name: "worker", delegation: { task: { objective: "probe" } } });
		mode.addMessageToChat(mailboxMessage(JSON.stringify(ENVELOPE)));
		const group = mode.chatContainer.children.find(
			(child: unknown) => child instanceof SubagentGroupComponent,
		) as SubagentGroupComponent;
		const collapsedLines = group.render(100).length;

		const expanded = mode.handleTranscriptContentClick({ scrollView: mode.transcriptScrollView, row: 0, col: 1 });
		expect(expanded).toBe(true);
		expect(group.render(100).length).toBeGreaterThan(collapsedLines);
		expect(mode.ui.requestRender).toHaveBeenCalled();

		const collapsed = mode.handleTranscriptContentClick({ scrollView: mode.transcriptScrollView, row: 0, col: 1 });
		expect(collapsed).toBe(true);
		expect(group.render(100).length).toBe(collapsedLines);

		// clicks outside any chat child are ignored
		expect(mode.handleTranscriptContentClick({ scrollView: mode.transcriptScrollView, row: 999, col: 1 })).toBe(
			false,
		);
		expect(mode.handleTranscriptContentClick({ scrollView: {}, row: 0, col: 1 })).toBe(false);
	});

	it("routes Activity and diagnostic clicks after a wrapped task and result", () => {
		const mode = fakeMode();
		mode.transcriptContentWidth = () => 40;
		const tool = spawnTool(mode, "spawn_agent", "c1", {
			task_name: "worker",
			task: { objective: `${"Inspect the long wrapped objective ".repeat(6)}\nTASK_END_SENTINEL` },
		});
		tool.updateResult({ content: [{ type: "text", text: '{"status":"accepted","raw":"DIAG"}' }], isError: false });
		mode.addMessageToChat(mailboxMessage(JSON.stringify(ENVELOPE)));
		const group = mode.chatContainer.children.find(
			(child: unknown) => child instanceof SubagentGroupComponent,
		) as SubagentGroupComponent;
		const render = () => group.render(40).map(stripVTControlCharacters);
		const click = (row: number) =>
			mode.handleTranscriptContentClick({ scrollView: mode.transcriptScrollView, row, col: 1 });
		expect(click(0)).toBe(true);
		const taskRow = render().findIndex((line) => line.includes("TASK_END_SENTINEL"));
		const activityRow = render().findIndex((line) => line.includes("Activity"));
		expect(taskRow).toBeGreaterThan(2);
		expect(activityRow).toBeGreaterThan(taskRow);
		expect(render().join("\n")).not.toContain("DIAG");
		expect(click(activityRow)).toBe(true);
		const activityOperationRow = render().findIndex((line) => line.includes("Task assigned"));
		expect(activityOperationRow).toBeGreaterThan(activityRow);
		expect(click(activityOperationRow)).toBe(false);
		expect(render().join("\n")).not.toContain("DIAG");
		const diagnosticsRow = render().findIndex((line) => line.includes("Diagnostics"));
		expect(click(diagnosticsRow)).toBe(true);
		expect(render().join("\n")).toContain("Tool receipts");
		expect(render().join("\n")).toContain("Result envelopes");
		const operationRow = render().findIndex((line) => line.includes("spawn_agent · Accepted"));
		expect(operationRow).toBeGreaterThan(diagnosticsRow);
		expect(click(operationRow)).toBe(true);
		expect(render().join("\n")).toContain("DIAG");
		expect(render().every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(click(operationRow)).toBe(true);
		expect(render().join("\n")).not.toContain("DIAG");
		expect(click(diagnosticsRow)).toBe(true);
		expect(render().join("\n")).not.toContain("Tool receipts");
		expect(click(activityRow)).toBe(true);
		expect(render().join("\n")).not.toContain("Task assigned");
	});

	it("ctrl+o toggles group expansion like other expandable transcript blocks", () => {
		const mode = fakeMode();
		const tool = spawnTool(mode, "spawn_agent", "c1", {
			task_name: "worker",
			task: { objective: "probe\nReport the full result" },
		});
		tool.updateResult({
			content: [{ type: "text", text: '{"status":"accepted","raw":"CTRL_O_DIAGNOSTIC"}' }],
			isError: false,
		});
		mode.addMessageToChat(mailboxMessage(JSON.stringify(ENVELOPE)));
		const group = mode.chatContainer.children.find(
			(child: unknown) => child instanceof SubagentGroupComponent,
		) as SubagentGroupComponent;
		const collapsed = group.render(100).length;
		mode.setToolsExpanded(true);
		const expandedText = group.render(100).map(stripVTControlCharacters).join("\n");
		expect(group.render(100).length).toBeGreaterThan(collapsed);
		expect(expandedText).toContain("Report the full result");
		expect(expandedText).toContain("everything is fine");
		expect(expandedText).toContain("Activity");
		expect(expandedText).not.toContain("Task assigned");
		expect(expandedText).not.toContain("CTRL_O_DIAGNOSTIC");
		expect(expandedText).not.toContain('"task_name"');
		expect(expandedText).not.toContain('"summary"');
		mode.setToolsExpanded(false);
		expect(group.render(100).length).toBe(collapsed);
	});

	it("keeps renders within width at narrow sizes", () => {
		const mode = fakeMode();
		spawnTool(mode, "spawn_agent", "c1", { task_name: "worker", delegation: { task: { objective: "probe" } } });
		mode.addMessageToChat(mailboxMessage(JSON.stringify(ENVELOPE)));
		const group = mode.chatContainer.children.find(
			(child: unknown) => child instanceof SubagentGroupComponent,
		) as SubagentGroupComponent;
		group.setExpanded(true);
		for (const width of [40, 80, 120]) {
			expect(group.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});

it.each([
	["result.source.session_path", { toString: 42, valueOf: 42 }],
	["result.source.entry_id", {}],
	["result.source.turn_id", []],
	["result.source.coverage", {}],
	["result.source.kind", {}],
	["turn.resultValidation.contract", { toString: 42, valueOf: 42 }],
	["turn.resultValidation.outcome", {}],
	["turn.resultValidation.acceptance", {}],
	["turn.sequence", 0],
	["turn.sequence", -1],
	["turn.sequence", 1.5],
	["turn.usage.input", -1],
	["turn.usage.input", "NONFINITE_NUMBER"],
	["turn.usage.output", {}],
	["turn.usage.cacheRead", []],
	["turn.usage.coverage", {}],
	["turn.delivery.state", {}],
	["turn.delivery.enqueued_at", -1],
	["turn.delivery.acknowledged_at", {}],
	["turn.task_message_id", {}],
	["turn.result_message_id", []],
	["turn.turn_id", {}],
	["turn.started_at", {}],
	["turn.finished_at", -1],
	["turn.task_preview", []],
	["turn.task_truncated", {}],
	["result.truncated", {}],
	["result.artifacts", [{ path: {}, purpose: "unsafe" }]],
	["result.artifacts", [{ path: "bad\0path", purpose: "report" }]],
	["result.artifacts", [{ path: "report.txt", purpose: "bad\0purpose" }]],
] as const)("rejects retained metadata %s before retention and rendering", (path, bad) => {
	initTheme("dark");
	const mode = fakeMode();
	mode.addMessageToChat(mailboxMessage(JSON.stringify({ ...ENVELOPE, text: "CURRENT_RESULT" })));
	const query = {
		state: "found",
		turn: {
			target: "/root/worker",
			turn_id: "old",
			sequence: 1,
			task_message_id: null,
			result_message_id: "old-result",
			status: "completed",
			history_coverage: "complete",
			task_preview: "old",
			task_truncated: false,
			admitted_at: null,
			started_at: null,
			finished_at: null,
			usage: { coverage: "unknown", input: null, output: null, cacheRead: null, cacheWrite: null },
			delivery: { state: "unknown", enqueued_at: null, acknowledged_at: null },
			resultValidation: { contract: "valid", outcome: "blocked", acceptance: "not_reviewed" },
		},
		result: {
			preview: '{"summary":"UNSAFE_RESULT","outcome":"blocked"}',
			truncated: false,
			source: { kind: "unavailable", turn_id: "old", coverage: "unknown" },
		},
	};
	const external = JSON.parse(JSON.stringify(query)) as Record<string, unknown>;
	const parts = path.split(".");
	let parent = external;
	for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
	parent[parts.at(-1)!] = bad;
	const wire = JSON.stringify(external).replace('"NONFINITE_NUMBER"', "1e999");
	const tool = spawnTool(mode, "get_agent_result", "query", { target: "/root/worker" });
	expect(() => tool.updateResult({ content: [{ type: "text", text: wire }], isError: false })).not.toThrow();
	const group = mode.chatContainer.children[0] as SubagentGroupComponent;
	expect(group.resultCount).toBe(1);
	group.setExpanded(true);
	for (const width of [1, 8, 24, 40, 80]) expect(() => group.render(width)).not.toThrow();
	const text = stripVTControlCharacters(group.render(120).join("\n"));
	expect(text).toContain("CURRENT_RESULT");
	expect(text).toContain("Retained query response unavailable");
	expect(text).not.toContain("UNSAFE_RESULT");
});

it("retains a valid native source path beyond the artifact-only 2048-character limit", () => {
	initTheme("dark");
	const mode = fakeMode();
	const sourcePath = `/${"x".repeat(2200)}/session.jsonl`;
	const query = {
		state: "found",
		turn: {
			target: "/root/worker",
			turn_id: "long-source",
			sequence: 1,
			task_message_id: null,
			result_message_id: "long-result",
			status: "completed",
			history_coverage: "complete",
			task_preview: "task",
			task_truncated: false,
			admitted_at: null,
			started_at: null,
			finished_at: null,
			delivery: { state: "unknown", enqueued_at: null, acknowledged_at: null },
			usage: { coverage: "unknown", input: null, output: null, cacheRead: null, cacheWrite: null },
		},
		result: {
			preview: "LONG_SOURCE_RESULT",
			truncated: false,
			source: { kind: "native_history", session_path: sourcePath, turn_id: "long-source", coverage: "turn" },
		},
	};
	const tool = spawnTool(mode, "get_agent_result", "long-query", { target: "/root/worker" });
	tool.updateResult({ content: [{ type: "text", text: JSON.stringify(query) }], isError: false });
	const group = mode.chatContainer.children[0] as SubagentGroupComponent;
	expect(group.resultCount).toBe(1);
	expect(stripVTControlCharacters(group.render(120)[0])).toContain("Read: LONG_SOURCE_RESULT");
	expect(stripVTControlCharacters(group.render(120)[0])).toContain("State unknown");
	group.setExpanded(true);
	const text = stripVTControlCharacters(group.render(4096).join("\n"));
	expect(text).toContain("LONG_SOURCE_RESULT");
	expect(text).toContain(sourcePath);
	expect(text).not.toContain("Retained query response unavailable");
});

it("reads retained results/history/targeted wait without replacing newer lifecycle and deduplicates IDs", () => {
	initTheme("dark");
	const mode = fakeMode();
	const spawn = spawnTool(mode, "spawn_agent", "spawn-new", { task_name: "worker", task: { objective: "NEW_TASK" } });
	spawn.updateResult({ content: [{ type: "text", text: JSON.stringify({ turn_id: "new" }) }], isError: false });
	mode.addMessageToChat(
		mailboxMessage(
			JSON.stringify({
				...ENVELOPE,
				id: "new-result",
				turnId: "new",
				text: JSON.stringify({ summary: "NEW_RESULT", outcome: "blocked" }),
			}),
		),
	);
	const turn = {
		target: "/root/worker",
		turn_id: "old",
		sequence: 1,
		task_message_id: "old-task",
		result_message_id: "old-result",
		status: "completed",
		history_coverage: "complete",
		task_preview: "OLD_TASK_PREVIEW",
		task_truncated: true,
		admitted_at: 10,
		started_at: 20,
		finished_at: 1520,
		delivery: { state: "acknowledged", enqueued_at: 1520, acknowledged_at: 1600 },
		usage: { coverage: "partial", input: 7, output: null, cacheRead: null, cacheWrite: null },
		resultValidation: { contract: "valid", outcome: "blocked" },
	};
	const query = {
		state: "found",
		turn,
		result: {
			preview: JSON.stringify({ summary: "OLD_RESULT", outcome: "blocked" }),
			artifacts: [{ path: "/fixture/report", purpose: "full evidence", sha256: "a".repeat(64) }],
			truncated: false,
			source: {
				kind: "native_history",
				session_path: "/fixture/session.jsonl",
				turn_id: "old",
				entry_id: "entry-old",
				coverage: "entry",
			},
		},
	};
	for (const [name, receipt] of [
		["get_agent_result", query],
		["get_agent_result", query],
		["wait_agent", { reason: "terminal", result: query }],
		[
			"list_agent_turns",
			{ target: "/root/worker", turns: [turn], history_coverage: "complete", next_cursor: "next" },
		],
	] as const) {
		const tool = spawnTool(mode, name, name, { target: "/root/worker", turn_id: "old" });
		tool.updateResult({ content: [{ type: "text", text: JSON.stringify(receipt) }], isError: false });
	}
	const group = mode.chatContainer.children[0] as SubagentGroupComponent;
	expect(group.resultCount).toBe(2);
	expect(stripVTControlCharacters(group.render(120)[0])).toContain("NEW_RESULT");
	expect(stripVTControlCharacters(group.render(120)[0])).not.toContain("OLD_RESULT");
	group.setExpanded(true);
	const text = stripVTControlCharacters(group.render(120).join("\n"));
	expect(text.match(/OLD_RESULT/g)).toHaveLength(1);
	expect(text).toContain("Task: NEW_TASK");
	expect(text).toContain("Task preview (truncated): OLD_TASK_PREVIEW");
	expect(text).toContain("Delivery: acknowledged (not acceptance)");
	expect(text).toContain("Duration: 1.5s");
	expect(text).toContain("output unknown");
	expect(text).toContain("entry entry-old");
	expect(text).toContain("Artifact ref: /fixture/report");
	expect(text).toContain("hash claim:");
	expect(text).toContain("no auto-read or acceptance");
	expect(text).toContain("page only");
	expect(text).not.toContain('"summary"');
	const denied = spawnTool(mode, "get_agent_result", "denied", { target: "/root/worker" });
	denied.updateResult({ content: [{ type: "text", text: "forbidden" }], isError: true });
	expect(stripVTControlCharacters(group.render(120)[0])).toContain("Completed");
	expect(group.resultCount).toBe(2);
	for (const width of [1, 8, 24, 40])
		expect(group.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
});
