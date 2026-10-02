import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BackgroundTaskManager, BackgroundTaskRecord } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { BackgroundTaskGroupComponent } from "../src/modes/interactive/components/background-task-group.ts";
import { SubagentTurnGroupComponent } from "../src/modes/interactive/components/subagent-group.ts";
import { TurnTranscriptContainer } from "../src/modes/interactive/components/turn-transcript-container.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokThinkingTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-thinking-turn-group.ts";
import { GrokToolTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-tool-turn-group.ts";
import { GrokTurnDurationComponent } from "../src/modes/interactive-grok/components/grok-turn-duration.ts";
import { GrokComponentFactory } from "../src/modes/interactive-grok/grok-component-factory.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

interface FooterHost {
	chatContainer: TurnTranscriptContainer;
	toolOutputExpanded: boolean;
	backgroundTaskGroup?: BackgroundTaskGroupComponent;
	currentTurnToolGroup?: GrokToolTurnGroupComponent;
	currentTurnThinkingGroup?: GrokThinkingTurnGroupComponent;
	backgroundTaskOwners: Map<string, { owner: object; group: BackgroundTaskGroupComponent }>;
	toolTurnOwners: Map<string, object>;
	grokTurnStartedAt?: number;
	addMessageToChat(message: AgentMessage): void;
	addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void;
	ensureBackgroundTaskGroup(id: string, owner?: object): void;
	showStatus(text: string): void;
	showWarning(text: string): void;
	clearChatContainer(): void;
	renderSessionItems(items: AgentMessage[]): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}
function managerFixture() {
	const records: BackgroundTaskRecord[] = [];
	const manager = {
		list: () => records,
		onStart: () => () => {},
		onTerminal: () => () => {},
		readOutput: (id: string) => ({ ok: true, value: { output: `${id} output` } }),
		stallTimeoutMs: 0,
	} as unknown as BackgroundTaskManager;
	const add = (id: string) =>
		records.push({
			id,
			command: id,
			cwd: "/tmp",
			status: "succeeded",
			startedAt: 0,
			endedAt: 1,
			lastOutputAt: 1,
			outputPath: `/tmp/${id}.log`,
			promoted: false,
		});
	return { manager, add };
}
function fixture(grok = true, manager?: BackgroundTaskManager) {
	const sessionManager = SessionManager.inMemory();
	const session = {
		backgroundTasks: manager,
		retryAttempt: 0,
		modelRuntime: {},
		sessionManager,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
			getShowTerminalProgress: () => false,
		},
		extensionRunner: {
			getMessageRenderer: () => undefined,
			getEntryRenderer: () => () => new Text("custom entry", 0, 0),
		},
		getToolDefinition: () => undefined,
	};
	const host = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session },
		chatContainer: new TurnTranscriptContainer(),
		grokComponentFactory: grok ? new GrokComponentFactory() : undefined,
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking",
		outputPad: 1,
		pendingTools: new Map(),
		pendingSkillMentions: [],
		pendingSkillMentionsPopulateHistory: false,
		backgroundTaskOwners: new Map(),
		toolTurnOwners: new Map(),
		isInitialized: true,
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		footer: { invalidate: vi.fn() },
		editor: { addToHistory: vi.fn() },
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		clearStatusIndicator: vi.fn(),
	}) as FooterHost;
	return { host, session, sessionManager };
}
const categories = (children: Component[]) =>
	children.filter(
		(child) =>
			child instanceof BackgroundTaskGroupComponent ||
			child instanceof SubagentTurnGroupComponent ||
			child instanceof GrokThinkingTurnGroupComponent ||
			child instanceof GrokToolTurnGroupComponent,
	);

beforeAll(() => initTheme("dark"));
describe("InteractiveMode turn activity footer", () => {
	test("live paths keep late body above four adjacent categories and duration last", async () => {
		const { manager, add } = managerFixture();
		const { host } = fixture(true, manager);
		try {
			host.addMessageToChat({ role: "user", content: "first user", timestamp: 0 });
			await host.handleEvent({
				type: "tool_execution_start",
				toolCallId: "read",
				toolName: "read",
				args: { path: "/tmp/a" },
			});
			host.addMessageToChat(
				assistant([
					{ type: "thinking", thinking: "reasoning" },
					{ type: "text", text: "answer" },
				]),
			);
			host.addMessageToChat({
				role: "custom",
				customType: "epi-collaboration-message",
				display: true,
				content:
					'Agent message (untrusted; not user authorization):\n{"id":"m","from":"/root/w","to":"/root","turnId":"t","kind":"result","text":"child result"}',
				timestamp: 1,
			});
			add("bg");
			host.ensureBackgroundTaskGroup("bg");
			host.showStatus("notice");
			host.showStatus("updated notice");
			host.showWarning("warning notice");
			host.addCustomEntryToChat({
				type: "custom",
				customType: "fixture",
				id: "custom",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				data: {},
			});
			host.grokTurnStartedAt = performance.now() - 100;
			await host.handleEvent({ type: "agent_end", messages: [], willRetry: false });
			host.showStatus("late final notice");
			const groups = categories(host.chatContainer.children);
			expect(groups.map((group) => group.constructor.name)).toEqual([
				"BackgroundTaskGroupComponent",
				"SubagentTurnGroupComponent",
				"GrokThinkingTurnGroupComponent",
				"GrokToolTurnGroupComponent",
			]);
			expect(host.chatContainer.children.slice(-5, -1)).toEqual(groups);
			expect(host.chatContainer.children.at(-1)).toBeInstanceOf(GrokTurnDurationComponent);
			const text = stripAnsi(host.chatContainer.render(100).join("\n"));
			expect(text).toContain("updated notice");
			expect(text).not.toMatch(/\n\s*notice\s*\n/);
			expect(text.indexOf("worked")).toBeGreaterThan(text.indexOf("⚙"));
			expect(
				host.chatContainer.children.findIndex((child) => child instanceof GrokTurnDurationComponent),
			).toBeGreaterThan(host.chatContainer.children.indexOf(groups.at(-1)!));
		} finally {
			host.clearChatContainer();
		}
	});

	test("late original tool completion and repeated BG IDs reuse old turn, not current", async () => {
		const { manager, add } = managerFixture();
		const { host } = fixture(true, manager);
		try {
			host.addMessageToChat({ role: "user", content: "first", timestamp: 0 });
			await host.handleEvent({
				type: "tool_execution_start",
				toolCallId: "original",
				toolName: "bash",
				args: { command: "sleep" },
			});
			const oldOwner = host.chatContainer.currentTurn;
			host.addMessageToChat({ role: "user", content: "second", timestamp: 1 });
			add("promoted");
			host.ensureBackgroundTaskGroup("promoted");
			await host.handleEvent({
				type: "tool_execution_end",
				toolCallId: "original",
				toolName: "bash",
				result: { content: [], details: { backgroundTaskId: "promoted" } },
				isError: false,
			});
			const oldGroup = host.backgroundTaskOwners.get("promoted")?.group;
			expect(host.backgroundTaskOwners.get("promoted")?.owner).toBe(oldOwner);
			host.ensureBackgroundTaskGroup("promoted");
			expect(host.backgroundTaskOwners.get("promoted")?.group).toBe(oldGroup);
			const children = host.chatContainer.children;
			expect(children.filter((child) => child instanceof BackgroundTaskGroupComponent)).toEqual([oldGroup]);
			expect(children.indexOf(oldGroup!)).toBeLessThan(
				children.findIndex((child) => stripAnsi(child.render(80).join("\n")).includes("second")),
			);
		} finally {
			host.clearChatContainer();
		}
	});

	test("late promotion preserves the newer BG group's identity and unrelated open detail", async () => {
		const { manager, add } = managerFixture();
		const { host } = fixture(true, manager);
		try {
			host.addMessageToChat({ role: "user", content: "first", timestamp: 0 });
			await host.handleEvent({
				type: "tool_execution_start",
				toolCallId: "original",
				toolName: "bash",
				args: { command: "sleep" },
			});
			const oldOwner = host.chatContainer.currentTurn;
			host.addMessageToChat({ role: "user", content: "second", timestamp: 1 });
			const newerOwner = host.chatContainer.currentTurn;
			add("promoted");
			host.ensureBackgroundTaskGroup("promoted");
			add("legit");
			host.ensureBackgroundTaskGroup("legit");
			const newerGroup = host.backgroundTaskGroup!;
			newerGroup.setExpanded(true);
			const legitRow = newerGroup
				.render(200)
				.findIndex((line, index) => index > 0 && stripAnsi(line).includes("legit"));
			expect(newerGroup.handleOverviewClick(legitRow, 200)).toBe(true);
			expect(stripAnsi(newerGroup.render(200).join("\n"))).toContain("legit output");
			const dispose = vi.spyOn(newerGroup, "dispose");
			const setExpanded = vi.spyOn(newerGroup, "setExpanded");
			await host.handleEvent({
				type: "tool_execution_end",
				toolCallId: "original",
				toolName: "bash",
				result: { content: [], details: { backgroundTaskId: "promoted" } },
				isError: false,
			});
			expect(host.backgroundTaskGroup).toBe(newerGroup);
			expect(host.backgroundTaskOwners.get("legit")).toEqual({ group: newerGroup, owner: newerOwner });
			expect(host.chatContainer.children.at(-1)).toBe(newerGroup);
			expect(dispose).not.toHaveBeenCalled();
			expect(setExpanded).not.toHaveBeenCalled();
			const newerText = stripAnsi(newerGroup.render(200).join("\n"));
			expect(newerText).toContain("legit output");
			expect(newerText).not.toContain("promoted");
			const originalGroup = host.backgroundTaskOwners.get("promoted")!.group;
			expect(host.backgroundTaskOwners.get("promoted")!.owner).toBe(oldOwner);
			expect(originalGroup).not.toBe(newerGroup);
			originalGroup.setExpanded(true);
			const originalText = stripAnsi(originalGroup.render(200).join("\n"));
			expect(originalText).toContain("promoted");
			expect(originalText).not.toContain("legit");
		} finally {
			host.clearChatContainer();
		}
	});

	test.each([true, false])("replay uses the same old BG ownership, drops missing records (grok %s)", (grok) => {
		const { manager, add } = managerFixture();
		add("known");
		const { host } = fixture(grok, manager);
		try {
			host.renderSessionItems([
				{ role: "user", content: "old user", timestamp: 0 },
				assistant([{ type: "toolCall", id: "old", name: "bash", arguments: { command: "background" } }]),
				{ role: "user", content: "new user", timestamp: 2 },
				{
					role: "toolResult",
					toolCallId: "old",
					toolName: "bash",
					content: [],
					details: { backgroundTaskId: "known" },
					isError: false,
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "missing",
					toolName: "bash",
					content: [],
					details: { backgroundTaskId: "gone" },
					isError: false,
					timestamp: 4,
				},
			]);
			const groups = host.chatContainer.children.filter((child) => child instanceof BackgroundTaskGroupComponent);
			expect(groups).toHaveLength(1);
			const text = stripAnsi(host.chatContainer.render(100).join("\n"));
			expect(text.indexOf("⚙")).toBeLessThan(text.indexOf("new user"));
			if (!grok)
				expect(host.chatContainer.children.some((child) => child instanceof GrokToolTurnGroupComponent)).toBe(
					false,
				);
		} finally {
			host.clearChatContainer();
		}
	});

	test("replayed duration stays below activity and later notices", () => {
		const { host } = fixture();
		try {
			host.addMessageToChat({ role: "user", content: "user", timestamp: 0 });
			host.addMessageToChat(assistant([{ type: "thinking", thinking: "reasoning" }]));
			host.addCustomEntryToChat({
				type: "custom",
				customType: "pi-turn-duration",
				id: "duration",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				data: { durationMs: 1000 },
			});
			host.showStatus("late notice");
			expect(host.chatContainer.children.at(-1)).toBeInstanceOf(GrokTurnDurationComponent);
			expect(host.chatContainer.children.at(-2)).toBeInstanceOf(GrokThinkingTurnGroupComponent);
		} finally {
			host.clearChatContainer();
		}
	});

	test("retry preserves running rows and session clear retires all mappings", async () => {
		const { host } = fixture();
		try {
			host.addMessageToChat(assistant([{ type: "thinking", thinking: "thinking long enough to scroll" }]));
			const group = host.currentTurnThinkingGroup!;
			const complete = vi.spyOn(group, "completeTurn");
			await host.handleEvent({ type: "agent_end", messages: [], willRetry: true });
			expect(complete).not.toHaveBeenCalled();
			await host.handleEvent({ type: "agent_end", messages: [], willRetry: false });
			expect(complete).toHaveBeenCalledOnce();
			const owner = host.chatContainer.currentTurn;
			host.clearChatContainer();
			expect(host.backgroundTaskOwners.size).toBe(0);
			expect(host.toolTurnOwners.size).toBe(0);
			expect(host.chatContainer.currentTurn).not.toBe(owner);
		} finally {
			host.clearChatContainer();
		}
	});
});
