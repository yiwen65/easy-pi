import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createSkillPromptMessage } from "../src/core/messages.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type SkillMentionHarness = {
	chatContainer: Container;
	pendingSkillMentions: Array<{ name: string; timestamp: number }>;
	pendingSkillMentionsPopulateHistory: boolean;
	currentTurnThinkingGroup: undefined;
	currentTurnToolGroup: undefined;
	completeCurrentTurnThinking(): void;
	createUserMessageComponent(text: string, timestamp?: number, skillNames?: readonly string[]): UserMessageComponent;
	getUserMessageText: (message: AgentMessage) => string;
	renderUserMessage: (text: string, timestamp: number | undefined, options?: { populateHistory?: boolean }) => void;
	flushPendingSkillMentions: () => void;
	editor: { addToHistory(text: string): void };
};

const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
const getUserMessageText = Reflect.get(prototype, "getUserMessageText") as SkillMentionHarness["getUserMessageText"];
const renderUserMessage = Reflect.get(prototype, "renderUserMessage") as SkillMentionHarness["renderUserMessage"];
const flushPendingSkillMentions = Reflect.get(
	prototype,
	"flushPendingSkillMentions",
) as SkillMentionHarness["flushPendingSkillMentions"];
const addMessageToChat = Reflect.get(prototype, "addMessageToChat") as (
	this: SkillMentionHarness,
	message: AgentMessage,
	options?: { populateHistory?: boolean },
) => void;

function createHarness() {
	const addToHistory = vi.fn<(text: string) => void>();
	const harness: SkillMentionHarness = {
		chatContainer: new Container(),
		pendingSkillMentions: [],
		pendingSkillMentionsPopulateHistory: false,
		currentTurnThinkingGroup: undefined,
		currentTurnToolGroup: undefined,
		completeCurrentTurnThinking: vi.fn(),
		createUserMessageComponent: (text, _timestamp, skillNames) =>
			new UserMessageComponent(text, undefined, 1, [], skillNames),
		getUserMessageText,
		renderUserMessage,
		flushPendingSkillMentions,
		editor: { addToHistory },
	};
	return { harness, addToHistory };
}

describe("InteractiveMode skill mention presentation", () => {
	beforeAll(() => initTheme("dark"));

	test("coalesces skill context messages and the request into one user transcript row", () => {
		const { harness, addToHistory } = createHarness();
		const first = createSkillPromptMessage("code-debug", "/tmp/code-debug/SKILL.md", "/tmp/code-debug", "debug");
		const second = createSkillPromptMessage(
			"code-performance",
			"/tmp/code-performance/SKILL.md",
			"/tmp/code-performance",
			"performance",
		);
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "explain the slowdown" }],
			timestamp: Date.now(),
		};

		addMessageToChat.call(harness, first, { populateHistory: true });
		addMessageToChat.call(harness, second, { populateHistory: true });
		addMessageToChat.call(harness, user, { populateHistory: true });

		const userRows = harness.chatContainer.children.filter((child) => child instanceof UserMessageComponent);
		expect(userRows).toHaveLength(1);
		const renderedWithAnsi = harness.chatContainer.render(100).join("\n");
		const rendered = stripAnsi(renderedWithAnsi);
		expect(renderedWithAnsi).toContain("\x1b[38;2;138;190;183mcode-debug");
		expect(renderedWithAnsi).toContain("\x1b[38;2;138;190;183mcode-performance");
		expect(rendered).toContain("code-debug code-performance explain the slowdown");
		expect(rendered).not.toContain("[skill]");
		expect(addToHistory).toHaveBeenCalledWith("/skill:code-debug /skill:code-performance explain the slowdown");
	});

	test("renders a skill-only invocation as one user row", () => {
		const { harness } = createHarness();
		const skill = createSkillPromptMessage("code-debug", "/tmp/code-debug/SKILL.md", "/tmp/code-debug", "debug");

		addMessageToChat.call(harness, skill);
		harness.flushPendingSkillMentions();

		const userRows = harness.chatContainer.children.filter((child) => child instanceof UserMessageComponent);
		expect(userRows).toHaveLength(1);
		expect(userRows[0]?.getText()).toBe("code-debug");
		expect(stripAnsi(harness.chatContainer.render(80).join("\n"))).not.toContain("[skill]");
	});
});
