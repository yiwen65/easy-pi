import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { MarkdownTransformer } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokAssistantMessageComponent } from "../src/modes/interactive-grok/components/grok-assistant-message.ts";
import { GrokThinkingTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-thinking-turn-group.ts";
import { GrokToolExecutionComponent } from "../src/modes/interactive-grok/components/grok-tool-execution.ts";
import { GrokToolTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-tool-turn-group.ts";
import { GrokUserMessageComponent } from "../src/modes/interactive-grok/components/grok-user-message.ts";
import { GrokComponentFactory } from "../src/modes/interactive-grok/grok-component-factory.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

interface ComponentCreationContext {
	grokComponentFactory: GrokComponentFactory | undefined;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	toolOutputExpanded: boolean;
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: { getCwd(): string };
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getMarkdownTransformers(): readonly MarkdownTransformer[];
	getRegisteredToolDefinition(): undefined;
}

type CreateUser = (this: ComponentCreationContext, text: string, timestamp?: number) => UserMessageComponent;
type CreateAssistant = (this: ComponentCreationContext, message?: AssistantMessage) => AssistantMessageComponent;
type CreateTool = (
	this: ComponentCreationContext,
	toolName: string,
	toolCallId: string,
	args: unknown,
) => ToolExecutionComponent;

const createUser = Reflect.get(InteractiveMode.prototype, "createUserMessageComponent") as CreateUser;
const createAssistant = Reflect.get(InteractiveMode.prototype, "createAssistantMessageComponent") as CreateAssistant;
const createTool = Reflect.get(InteractiveMode.prototype, "createToolExecutionComponent") as CreateTool;
const addToolToChat = Reflect.get(InteractiveMode.prototype, "addToolComponentToChat") as (
	this: ComponentCreationContext & {
		chatContainer: Container;
		currentTurnToolGroup?: GrokToolTurnGroupComponent;
	},
	component: ToolExecutionComponent,
) => void;
const updateTurnThinking = Reflect.get(InteractiveMode.prototype, "updateTurnThinking") as (
	this: ComponentCreationContext & {
		chatContainer: Container;
		currentTurnThinkingGroup?: GrokThinkingTurnGroupComponent;
	},
	component: GrokAssistantMessageComponent,
	isStreaming: boolean,
) => void;
const startGrokTurnTiming = Reflect.get(InteractiveMode.prototype, "startGrokTurnTiming") as (
	this: { grokComponentFactory?: GrokComponentFactory; grokTurnStartedAt?: number },
	now: number,
) => void;
const finishGrokTurnTiming = Reflect.get(InteractiveMode.prototype, "finishGrokTurnTiming") as (
	this: { grokComponentFactory?: GrokComponentFactory; grokTurnStartedAt?: number },
	now: number,
) => number | undefined;
const setWorkingVisible = Reflect.get(InteractiveMode.prototype, "setWorkingVisible") as (
	this: {
		workingVisible: boolean;
		activeStatusIndicator?: { kind: "working" | "retry" };
		clearStatusIndicator(kind: "working"): void;
		grokView?: { setStatusVisible(visible: boolean): void };
		ui: { requestRender(): void };
	},
	visible: boolean,
) => void;

function createContext(grok: boolean): ComponentCreationContext {
	return {
		grokComponentFactory: grok ? new GrokComponentFactory() : undefined,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolOutputExpanded: false,
		ui: { requestRender: () => {} } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: { getCwd: () => process.cwd() },
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => undefined,
	};
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("InteractiveMode Grok component routing", () => {
	beforeAll(() => initTheme("dark"));

	test("times a complete Grok turn without resetting across retries", () => {
		const context: { grokComponentFactory?: GrokComponentFactory; grokTurnStartedAt?: number } = {
			grokComponentFactory: new GrokComponentFactory(),
		};
		startGrokTurnTiming.call(context, 1_000);
		startGrokTurnTiming.call(context, 2_000);
		expect(finishGrokTurnTiming.call(context, 4_500)).toBe(3_500);
		expect(context.grokTurnStartedAt).toBeUndefined();

		const legacyContext: { grokComponentFactory?: GrokComponentFactory; grokTurnStartedAt?: number } = {};
		startGrokTurnTiming.call(legacyContext, 1_000);
		expect(finishGrokTurnTiming.call(legacyContext, 4_500)).toBeUndefined();
	});

	test("selects Grok transcript components without changing their Pi base ABI", () => {
		const context = createContext(true);
		const user = createUser.call(context, "hello", 0);
		const assistant = createAssistant.call(context, assistantMessage());
		const tool = createTool.call(context, "unknown_tool", "tool-1", { input: "x" });

		expect(user).toBeInstanceOf(GrokUserMessageComponent);
		expect(user).toBeInstanceOf(UserMessageComponent);
		expect(assistant).toBeInstanceOf(GrokAssistantMessageComponent);
		expect(assistant).toBeInstanceOf(AssistantMessageComponent);
		expect(tool).toBeInstanceOf(GrokToolExecutionComponent);
		expect(tool).toBeInstanceOf(ToolExecutionComponent);
	});

	test("groups one turn's tools into one line and keeps it at the latest position", () => {
		const context = Object.assign(createContext(true), {
			chatContainer: new Container(),
			currentTurnToolGroup: undefined as GrokToolTurnGroupComponent | undefined,
		});
		const first = createTool.call(context, "read", "tool-1", { path: "/tmp/a.ts" });
		addToolToChat.call(context, first);
		expect(context.chatContainer.children).toHaveLength(1);
		const group = context.chatContainer.children[0];
		expect(group).toBeInstanceOf(GrokToolTurnGroupComponent);
		expect((group as GrokToolTurnGroupComponent).toolCount).toBe(1);

		// Simulate assistant content appearing before the next tool call.
		context.chatContainer.addChild(new Container());
		const second = createTool.call(context, "bash", "tool-2", { command: "npm test" });
		addToolToChat.call(context, second);
		expect(context.chatContainer.children.at(-1)).toBe(group);
		expect((group as GrokToolTurnGroupComponent).toolCount).toBe(2);
	});

	test("keeps subagent independent from surrounding tool groups", () => {
		const context = Object.assign(createContext(true), {
			chatContainer: new Container(),
			currentTurnToolGroup: undefined as GrokToolTurnGroupComponent | undefined,
		});
		const first = createTool.call(context, "read", "tool-1", { path: "/tmp/a.ts" });
		addToolToChat.call(context, first);
		const firstGroup = context.chatContainer.children[0];
		expect(firstGroup).toBeInstanceOf(GrokToolTurnGroupComponent);

		const subagent = createTool.call(context, "subagent", "tool-2", { agent: "worker", task: "review" });
		addToolToChat.call(context, subagent);
		expect(context.chatContainer.children).toEqual([firstGroup, subagent]);
		expect(context.currentTurnToolGroup).toBeUndefined();
		expect((firstGroup as GrokToolTurnGroupComponent).toolCount).toBe(1);

		const last = createTool.call(context, "bash", "tool-3", { command: "npm test" });
		addToolToChat.call(context, last);
		const lastGroup = context.chatContainer.children[2];
		expect(lastGroup).toBeInstanceOf(GrokToolTurnGroupComponent);
		expect(lastGroup).not.toBe(firstGroup);
		expect((lastGroup as GrokToolTurnGroupComponent).toolCount).toBe(1);
		expect(context.chatContainer.children).toEqual([firstGroup, subagent, lastGroup]);
	});

	test("merges multiple assistant thinking messages into one turn-level row", () => {
		const context = Object.assign(createContext(true), {
			chatContainer: new Container(),
			currentTurnThinkingGroup: undefined as GrokThinkingTurnGroupComponent | undefined,
		});
		const firstMessage = { ...assistantMessage(), content: [{ type: "thinking" as const, thinking: "first" }] };
		const secondMessage = { ...assistantMessage(), content: [{ type: "thinking" as const, thinking: "second" }] };
		const first = createAssistant.call(context, firstMessage) as GrokAssistantMessageComponent;
		context.chatContainer.addChild(first);
		updateTurnThinking.call(context, first, false);
		const second = createAssistant.call(context, secondMessage) as GrokAssistantMessageComponent;
		context.chatContainer.addChild(second);
		updateTurnThinking.call(context, second, false);

		const groups = context.chatContainer.children.filter(
			(child): child is GrokThinkingTurnGroupComponent => child instanceof GrokThinkingTurnGroupComponent,
		);
		expect(groups).toHaveLength(1);
		const active = stripAnsi(context.chatContainer.render(80).join("\n"));
		expect(active).toContain("✦ second");
		expect(active).not.toContain("✦ first");
		expect(active).not.toContain("Thinking...");

		groups[0]?.completeTurn();
		const collapsed = stripAnsi(context.chatContainer.render(80).join("\n"));
		expect(collapsed.match(/✦ Thinking\.\.\./g)).toHaveLength(1);
		expect(collapsed).not.toContain("first");
		expect(collapsed).not.toContain("second");

		expect(groups[0]?.handleOverviewClick(0)).toBe(true);
		const expanded = stripAnsi(context.chatContainer.render(80).join("\n"));
		expect(expanded).toContain("first");
		expect(expanded).toContain("second");
	});

	test("keeps legacy component selection unchanged", () => {
		const context = createContext(false);
		const user = createUser.call(context, "hello", 0);
		const assistant = createAssistant.call(context, assistantMessage());
		const tool = createTool.call(context, "unknown_tool", "tool-1", {});
		expect(user).toBeInstanceOf(UserMessageComponent);
		expect(user).not.toBeInstanceOf(GrokUserMessageComponent);
		expect(assistant).toBeInstanceOf(AssistantMessageComponent);
		expect(assistant).not.toBeInstanceOf(GrokAssistantMessageComponent);
		expect(tool).toBeInstanceOf(ToolExecutionComponent);
		expect(tool).not.toBeInstanceOf(GrokToolExecutionComponent);
	});

	test("hides only the working slot and never suppresses an active retry status", () => {
		const setStatusVisible = vi.fn();
		const clearStatusIndicator = vi.fn();
		const requestRender = vi.fn();
		const context: {
			workingVisible: boolean;
			activeStatusIndicator: { kind: "working" | "retry" };
			clearStatusIndicator: typeof clearStatusIndicator;
			grokView: { setStatusVisible: typeof setStatusVisible };
			ui: { requestRender: typeof requestRender };
		} = {
			workingVisible: true,
			activeStatusIndicator: { kind: "retry" },
			clearStatusIndicator,
			grokView: { setStatusVisible },
			ui: { requestRender },
		};

		setWorkingVisible.call(context, false);
		expect(clearStatusIndicator).toHaveBeenCalledWith("working");
		expect(setStatusVisible).not.toHaveBeenCalled();

		context.activeStatusIndicator = { kind: "working" };
		setWorkingVisible.call(context, false);
		expect(setStatusVisible).toHaveBeenCalledWith(false);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});
