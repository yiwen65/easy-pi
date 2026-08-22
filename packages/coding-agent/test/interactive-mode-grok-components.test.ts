import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { MarkdownTransformer } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokAssistantMessageComponent } from "../src/modes/interactive-grok/components/grok-assistant-message.ts";
import { GrokToolExecutionComponent } from "../src/modes/interactive-grok/components/grok-tool-execution.ts";
import { GrokUserMessageComponent } from "../src/modes/interactive-grok/components/grok-user-message.ts";
import { GrokComponentFactory } from "../src/modes/interactive-grok/grok-component-factory.ts";

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
