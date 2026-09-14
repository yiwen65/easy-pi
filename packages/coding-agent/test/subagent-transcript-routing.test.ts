import { Container, visibleWidth } from "@earendil-works/pi-tui";
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
	const mode: any = {
		chatContainer,
		documentContainer: { children: [chatContainer] },
		loadedResourcesContainer: { children: [] },
		transcriptScrollView: {},
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
		session: { extensionRunner: { getMessageRenderer: () => undefined } },
		getMarkdownThemeWithSettings: () => ({}),
		outputPad: 1,
		showStatus: vi.fn(),
	};
	for (const name of [
		"createToolExecutionComponent",
		"createRoutedToolComponent",
		"addToolComponentToChat",
		"addMessageToChat",
		"handleTranscriptContentClick",
		"computeChatChildOffsets",
		"setToolsExpanded",
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

describe("subagent transcript routing", () => {
	beforeEach(() => initTheme("dark"));

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
		expect(header).toContain("Done");
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

	it("ctrl+o toggles group expansion like other expandable transcript blocks", () => {
		const mode = fakeMode();
		spawnTool(mode, "spawn_agent", "c1", { task_name: "worker", delegation: { task: { objective: "probe" } } });
		const group = mode.chatContainer.children.find(
			(child: unknown) => child instanceof SubagentGroupComponent,
		) as SubagentGroupComponent;
		const collapsed = group.render(100).length;
		mode.setToolsExpanded(true);
		expect(group.render(100).length).toBeGreaterThan(collapsed);
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
