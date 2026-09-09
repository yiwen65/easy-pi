import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { GrokAssistantMessageComponent } from "../src/modes/interactive-grok/components/grok-assistant-message.ts";
import { GrokThinkingTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-thinking-turn-group.ts";
import { GrokToolExecutionComponent } from "../src/modes/interactive-grok/components/grok-tool-execution.ts";
import { GrokToolTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-tool-turn-group.ts";
import {
	formatWorkedDuration,
	GrokTurnDurationComponent,
} from "../src/modes/interactive-grok/components/grok-turn-duration.ts";
import { GrokUserMessageComponent } from "../src/modes/interactive-grok/components/grok-user-message.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function expectFits(component: { render(width: number): string[] }, widths = [40, 80, 120]): void {
	for (const width of widths) {
		for (const line of component.render(width)) {
			expect(visibleWidth(line), `${width}: ${stripAnsi(line)}`).toBeLessThanOrEqual(width);
		}
	}
}

describe("Grok transcript components", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("formats and renders a compact worked duration", () => {
		expect(formatWorkedDuration(800)).toBe("0.8s");
		expect(formatWorkedDuration(12_500)).toBe("13s");
		expect(formatWorkedDuration(65_000)).toBe("1m 5s");
		expect(formatWorkedDuration(3_661_000)).toBe("1h 1m 1s");
		const component = new GrokTurnDurationComponent(65_000, 1);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("worked 1m 5s");
		expectFits(component, [16, 40, 80]);
	});

	test("renders a timestamped, accented user band with a stable text signature", () => {
		const timestamp = new Date(2026, 7, 22, 9, 5).getTime();
		const component = new GrokUserMessageComponent("你好，Grok 👋", undefined, 1, [], timestamp);
		const rendered = stripAnsi(component.render(40).join("\n"));

		expect(component).toBeInstanceOf(UserMessageComponent);
		expect(rendered).toContain("❯");
		expect(rendered).not.toContain("USER");
		expect(rendered).toContain("09:05");
		expect(rendered).toContain("你好，Grok 👋");
		expectFits(component);
	});

	test("keeps short user messages compact with semantic markers on the prompt header", () => {
		const component = new GrokUserMessageComponent("hello");
		const lines = component.render(40);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^\x1b\]133;A\x07/);
		expect(stripAnsi(lines[0])).toContain("❯");
		expect(stripAnsi(lines[1])).toContain("hello");
		expect(lines[1]).toContain("\x1b]133;B\x07\x1b]133;C\x07");
		expect(lines[1]).not.toContain("\x1b]133;A\x07");
		component.setOutputPad(0);
		component.invalidate();
		expect(component.render(40)).toHaveLength(2);
		expectFits(component, [4, 20, 40, 80]);
	});

	test("preserves user Markdown, skill mentions and paragraph spacing in the compact band", () => {
		const component = new GrokUserMessageComponent(
			"first paragraph\n\nsecond paragraph",
			undefined,
			1,
			[(markdown) => markdown.replace("first", "updated")],
			Date.now(),
			["review"],
		);
		const lines = component.render(40).map(stripAnsi);
		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain("review updated paragraph");
		expect(lines[2].trim()).toBe("");
		expect(lines[3]).toContain("second paragraph");
		expectFits(component, [20, 40, 80]);
	});

	test("renders thinking as a one-line live marquee without role headers", () => {
		const component = new GrokAssistantMessageComponent();
		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "正在分析 🧠" },
				{ type: "text", text: "流式回答中…" },
			]),
			true,
		);

		const partial = stripAnsi(component.render(80).join("\n"));
		expect(component).toBeInstanceOf(AssistantMessageComponent);
		expect(partial).toContain("✦ 正在分析 🧠");
		expect(partial).not.toContain("THINKING");
		expect(partial).not.toContain("ASSISTANT");
		expect(partial).toContain("流式回答中…");

		component.updateContent(createAssistantMessage([{ type: "text", text: "完成 ✅" }]), false);
		const complete = stripAnsi(component.render(80).join("\n"));
		expect(complete).not.toContain("STREAMING");
		expect(complete).not.toContain("ASSISTANT");
		expect(complete).toContain("完成 ✅");
		expectFits(component);
	});

	test("highlights the user band for prompt jump navigation", () => {
		const timestamp = new Date(2026, 7, 22, 9, 5).getTime();
		const component = new GrokUserMessageComponent("jump target", undefined, 1, [], timestamp);
		const plain = component.render(40).join("\n");
		component.setHighlighted(true);
		const highlighted = component.render(40).join("\n");
		expect(highlighted).not.toBe(plain);
		expect(stripAnsi(highlighted)).toContain("❯");
		expect(stripAnsi(highlighted)).not.toContain("USER");
		component.setHighlighted(false);
		expect(component.render(40).join("\n")).toBe(plain);
		expectFits(component);
	});

	test("collapses tool calls and errors to a one-line overview", () => {
		const component = new GrokToolExecutionComponent(
			"custom_tool",
			"tool-call-你好-1",
			{ query: "emoji 🔎" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		expect(component).toBeInstanceOf(ToolExecutionComponent);
		const pending = component.render(80);
		expect(pending).toHaveLength(1);
		expect(stripAnsi(pending[0] ?? "")).toContain("◇ custom_tool  emoji 🔎");

		component.markExecutionStarted();
		expect(stripAnsi(component.render(80).join("\n"))).toContain("◈ custom_tool");

		// Success stays collapsed: no body, no tool call id, exactly one compact line.
		component.updateResult({ content: [{ type: "text", text: "成功 🎉" }], isError: false }, false);
		const collapsed = component.render(80);
		expect(collapsed).toHaveLength(1);
		const collapsedText = stripAnsi(collapsed.join("\n"));
		expect(collapsedText).toContain("◆ custom_tool  emoji 🔎");
		expect(collapsedText).not.toContain("成功 🎉");
		expect(collapsedText).not.toContain("tool-call-你好-1");

		// Manual expansion keeps the compact header and reveals the renderer body.
		component.setExpanded(true);
		const expandedLines = component.render(80);
		const expanded = stripAnsi(expandedLines.join("\n"));
		expect(stripAnsi(expandedLines[0] ?? "")).toContain("◆ custom_tool  emoji 🔎");
		expect(expanded).toContain("成功 🎉");
		expect(expanded).not.toContain("tool-call-你好-1");
		expect(expanded).not.toContain("EXPANDED");

		// Errors stay collapsed until explicitly expanded.
		component.setExpanded(false);
		component.updateResult({ content: [{ type: "text", text: "失败 💥" }], isError: true }, false);
		const errorCollapsed = component.render(80);
		expect(errorCollapsed).toHaveLength(1);
		expect(stripAnsi(errorCollapsed[0] ?? "")).toContain("✕ custom_tool  emoji 🔎");
		expect(stripAnsi(errorCollapsed[0] ?? "")).not.toContain("失败 💥");

		component.setExpanded(true);
		const errorExpanded = stripAnsi(component.render(80).join("\n"));
		expect(errorExpanded).toContain("失败 💥");
		expect(errorExpanded).not.toContain("auto-expanded");
		expectFits(component);
	});

	test("aggregates one turn into a single live tool line with two-level expansion", () => {
		const first = new GrokToolExecutionComponent(
			"read",
			"turn-tool-1",
			{ path: "/tmp/a.ts" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		first.markExecutionStarted();
		first.updateResult({ content: [{ type: "text", text: "first output" }], isError: false }, false);

		const current = new GrokToolExecutionComponent(
			"bash",
			"turn-tool-2",
			{ command: "npm run build" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		current.markExecutionStarted();

		const group = new GrokToolTurnGroupComponent();
		group.addTool(first);
		group.addTool(current);

		// Collapsed turn shows only the current tool, with no count while live.
		const live = stripAnsi(group.render(80).join("\n"));
		expect(group.render(80)).toHaveLength(1);
		expect(live).toContain("◈ bash  npm run build");
		expect(live).not.toContain("2 tools");
		expect(live).not.toContain("read");

		// Settled turn remains one line and adds an aggregate count.
		current.updateResult({ content: [{ type: "text", text: "build output" }], isError: false }, false);
		const settled = stripAnsi(group.render(80).join("\n"));
		expect(group.render(80)).toHaveLength(1);
		expect(settled).toContain("◆ bash  npm run build");
		expect(settled).toContain("2 tools");

		// Level 1: click the summary to reveal one collapsed row per tool.
		expect(group.handleOverviewClick(0, 80)).toBe(true);
		expect(group.render(80)).toHaveLength(3);
		const overview = stripAnsi(group.render(80).join("\n"));
		expect(overview).toContain("read  /tmp/a.ts");
		expect(overview).toContain("bash  npm run build");
		expect(overview).not.toContain("first output");

		// Level 2: click an individual row to reveal that tool's full body.
		expect(group.handleOverviewClick(1, 80)).toBe(true);
		expect(stripAnsi(group.render(80).join("\n"))).toContain("first output");

		// The retained summary row collapses the whole group again.
		expect(group.handleOverviewClick(0, 80)).toBe(true);
		expect(group.render(80)).toHaveLength(1);
		expect(stripAnsi(group.render(80).join("\n"))).not.toContain("first output");
		expectFits(group);
	});

	test("summarizes args with preferred keys and degrades safely", () => {
		const readTool = new GrokToolExecutionComponent(
			"read",
			"call-read-1",
			{ path: "/tmp/some/file.ts", offset: 10 },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(readTool.render(120).join("\n"))).toContain("read  /tmp/some/file.ts");

		const bashTool = new GrokToolExecutionComponent(
			"bash",
			"call-bash-1",
			{ command: "ls -la\nsecond line" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const bashLine = stripAnsi(bashTool.render(120).join("\n"));
		expect(bashLine).toContain("bash  ls -la");
		expect(bashLine).not.toContain("second line");

		const opaqueTool = new GrokToolExecutionComponent(
			"opaque",
			"call-opaque-1",
			{ count: 3, flag: true },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(opaqueTool.render(120).join("\n"))).toContain('{"count":3');

		const emptyTool = new GrokToolExecutionComponent(
			"empty",
			"call-empty-1",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const emptyLine = stripAnsi(emptyTool.render(120).join("\n"));
		expect(emptyLine).toContain("◇ empty");
		expectFits(emptyTool, [20, 40, 80]);
	});

	test("preserves extension renderers and collapsed/expanded updates", () => {
		const toolDefinition: ToolDefinition = {
			name: "extension_tool",
			label: "extension tool",
			description: "test renderer ABI",
			parameters: Type.Any(),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			renderCall: (args) => new Text(`extension call ${(args as { value: string }).value}`, 0, 0),
			renderResult: (_result, { expanded }) => new Text(expanded ? "expanded result" : "collapsed result", 0, 0),
		};
		const component = new GrokToolExecutionComponent(
			"extension_tool",
			"tool-extension-1",
			{ value: "original" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		component.updateArgs({ value: "updated" });
		component.setArgsComplete();
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);

		// Collapsed by default: only the overview line, renderer bodies hidden.
		const collapsed = component.render(120);
		expect(collapsed).toHaveLength(1);
		const collapsedText = stripAnsi(collapsed.join("\n"));
		expect(collapsedText).toContain("◆ extension_tool  updated");
		expect(collapsedText).not.toContain("extension call updated");
		expect(collapsedText).not.toContain("collapsed result");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("extension call updated");
		expect(expanded).toContain("expanded result");
		expect(expanded).toContain("◆ extension_tool  updated");
		expectFits(component);
	});

	test("collapses completed thinking to one line and expands on demand", () => {
		const component = new GrokAssistantMessageComponent();
		const thinkingMessage = createAssistantMessage([
			{ type: "thinking", thinking: "推理过程 🤫" },
			{ type: "text", text: "最终回答" },
		]);

		// Streaming: thinking is a compact live one-line marquee.
		component.updateContent(thinkingMessage, true);
		const streamingFrame = component.render(80).join("\n");
		const streaming = stripAnsi(streamingFrame);
		expect(streamingFrame).toContain(theme.fg("accent", "✦ 推理过程 🤫"));
		expect(streaming).toContain("✦ 推理过程 🤫");
		expect(streaming).not.toContain("THINKING");

		// Completed: thinking collapses to the hidden label.
		component.updateContent(thinkingMessage, false);
		const collapsedFrame = component.render(80).join("\n");
		const collapsed = stripAnsi(collapsedFrame);
		expect(collapsedFrame).toContain(theme.fg("accent", "✦ Thinking..."));
		expect(collapsed).not.toContain("推理过程 🤫");
		expect(collapsed).not.toContain("◇ THINKING");
		expect(collapsed).toContain("Thinking...");
		expect(collapsed).toContain("最终回答");

		// Global expand toggle re-expands completed thinking, and back.
		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("推理过程 🤫");
		expect(expanded).not.toContain("THINKING");
		component.setExpanded(false);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("推理过程 🤫");
		expectFits(component);
	});

	test("respects the user thinking-visibility setting over expansion", () => {
		const component = new GrokAssistantMessageComponent(undefined, true);
		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "hidden thinking" },
				{ type: "text", text: "answer" },
			]),
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).not.toContain("hidden thinking");
		expect(rendered).toContain("Thinking...");

		component.setHideThinkingBlock(false);
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("hidden thinking");
	});

	test("merges a turn's thinking entries into one reversible collapsed block", () => {
		const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking...", 1, false);
		group.updateThinking({ id: 1 }, "first reasoning", false);
		group.updateThinking({ id: 2 }, "second reasoning", false);

		// Internal assistant/tool boundaries keep the latest thinking visible.
		const activeFrame = group.render(80).join("\n");
		const active = stripAnsi(activeFrame);
		expect(activeFrame).toContain(theme.fg("muted", "▸ Thought process · second reasoning"));
		expect(active).toContain("▸ Thought process · second reasoning");
		expect(active).not.toContain("first reasoning");
		expect(active).not.toContain("Thinking...");

		// Only the complete user→answer turn switches to the static label.
		group.completeTurn();
		const collapsedFrame = group.render(80).join("\n");
		const collapsed = stripAnsi(collapsedFrame);
		expect(collapsedFrame).toContain(theme.fg("muted", "▸ Thought process"));
		expect(group.entryCount).toBe(2);
		expect(group.render(80)).toHaveLength(1);
		expect(collapsed).toContain("▸ Thought process");
		expect(collapsed).not.toContain("Thinking");
		expect(collapsed).not.toContain("first reasoning");
		expect(collapsed).not.toContain("second reasoning");

		expect(group.handleOverviewClick(0)).toBe(true);
		const expanded = stripAnsi(group.render(80).join("\n"));
		expect(expanded).toContain("▾ Thought process");
		expect(expanded).toContain("first reasoning");
		expect(expanded).toContain("second reasoning");

		// The retained overview row is also the collapse target.
		expect(group.handleOverviewClick(0)).toBe(true);
		expect(group.render(80)).toHaveLength(1);
		expect(stripAnsi(group.render(80).join("\n"))).not.toContain("first reasoning");
		expectFits(group);
	});

	test("distinguishes live thinking from completed history and stops its animation", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const ui = { requestRender } as unknown as TUI;
		const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking...", 1, false, ui);
		const owner = {};
		try {
			group.updateThinking(owner, "正在分析输入并检查边界条件", true);
			expect(stripAnsi(group.render(80)[0])).toContain("▸ Thinking… · 正在分析");
			vi.advanceTimersByTime(120);
			expect(requestRender).toHaveBeenCalled();
			group.setExpanded(true);
			expect(stripAnsi(group.render(80)[0])).toContain("▾ Thinking…");
			group.completeTurn();
			requestRender.mockClear();
			vi.advanceTimersByTime(240);
			expect(requestRender).not.toHaveBeenCalled();
			expect(stripAnsi(group.render(80)[0])).toContain("▾ Thought process");
			group.setExpanded(false);
			expect(stripAnsi(group.render(80)[0])).toContain("▸ Thought process");
			expectFits(group, [4, 12, 24, 80]);
		} finally {
			group.dispose();
			vi.useRealTimers();
		}
	});

	test("preserves custom thinking labels and keeps hidden thinking private", () => {
		const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Custom reasoning", 1, true);
		group.updateThinking({}, "private content", true);
		expect(stripAnsi(group.render(80)[0])).toContain("▸ Custom reasoning");
		expect(stripAnsi(group.render(80).join("\n"))).not.toContain("private content");
		group.completeTurn();
		expect(stripAnsi(group.render(80)[0])).toContain("▸ Custom reasoning");
	});

	test("toggles turn thinking from every rendered row, including wrapped content", () => {
		for (const width of [20, 80]) {
			const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking...", 1, false);
			group.updateThinking({}, "first reasoning with enough words to wrap across narrow rows", true);
			group.updateThinking({}, "second reasoning\n\nlast paragraph", false);
			expect(group.render(width)).toHaveLength(1);
			expect(group.handleOverviewClick(-1)).toBe(false);
			expect(group.handleOverviewClick(1)).toBe(false);
			expect(group.handleOverviewClick(0)).toBe(true);
			const expandedRows = group.render(width).length;
			expect(expandedRows).toBeGreaterThan(3);
			expect(group.handleOverviewClick(expandedRows)).toBe(false);
			for (let row = 0; row < expandedRows; row++) {
				expect(group.handleOverviewClick(row)).toBe(true);
				expect(group.render(width)).toHaveLength(1);
				expect(group.handleOverviewClick(0)).toBe(true);
				expect(group.render(width)).toHaveLength(expandedRows);
			}
			group.completeTurn();
			expect(group.handleOverviewClick(expandedRows - 1)).toBe(true);
			expect(group.render(width)).toHaveLength(1);
			expect(group.handleOverviewClick(0)).toBe(true);
			expect(group.render(width)).toHaveLength(expandedRows);
			group.render(0);
			expect(group.handleOverviewClick(0)).toBe(false);
		}
	});

	test("does not toggle empty or user-hidden turn thinking", () => {
		for (const hidden of [false, true]) {
			const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking...", 1, hidden);
			expect(group.render(80)).toHaveLength(0);
			expect(group.handleOverviewClick(0)).toBe(false);
			if (hidden) {
				group.updateThinking({}, "hidden reasoning", false);
				expect(group.render(80)).toHaveLength(1);
				expect(group.handleOverviewClick(0)).toBe(false);
			}
		}
	});

	test("uses only one separator before the answer when thinking is delegated to its turn group", () => {
		const component = new GrokAssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "answer" },
			]),
		);
		component.setThinkingDelegated(true);
		const lines = component.render(80).map(stripAnsi);
		expect(lines).toHaveLength(2);
		expect(lines[0].trim()).toBe("");
		expect(lines[1]).toContain("answer");
		component.dispose();
	});

	test("legacy assistant component keeps thinking expanded by default", () => {
		const legacy = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "legacy thinking" },
				{ type: "text", text: "legacy answer" },
			]),
		);
		const rendered = stripAnsi(legacy.render(80).join("\n"));
		expect(rendered).toContain("legacy thinking");
		expect(rendered).toContain("legacy answer");
	});

	test("toggles tool blocks via overview-line clicks", () => {
		const component = new GrokToolExecutionComponent(
			"read",
			"call-click-1",
			{ path: "/tmp/click.ts" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "file body" }], isError: false }, false);

		// The compact overview is the component's only collapsed row.
		expect(component.handleOverviewClick(1)).toBe(false);
		expect(component.handleOverviewClick(0)).toBe(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("file body");

		// Clicking the expanded header collapses again.
		expect(component.handleOverviewClick(0)).toBe(true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("file body");

		// Errors use the same manual click expansion behavior.
		component.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);
		expect(component.handleOverviewClick(0)).toBe(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("boom");
		expect(component.handleOverviewClick(0)).toBe(true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("boom");
	});

	test("expands collapsed thinking via a click on the label line", () => {
		const component = new GrokAssistantMessageComponent();
		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "visible answer" },
			]),
			false,
		);

		const width = 80;
		const lines = component.render(width);
		const labelRow = lines.findIndex((line) => stripAnsi(line).includes("Thinking..."));
		expect(labelRow).toBeGreaterThanOrEqual(0);

		// Clicks away from the label line do not expand.
		const answerRow = lines.findIndex((line) => stripAnsi(line).includes("visible answer"));
		expect(component.handleThinkingLabelClick(answerRow, width)).toBe(false);
		expect(stripAnsi(component.render(width).join("\n"))).not.toContain("private reasoning");

		// Clicking the label line expands thinking.
		expect(component.handleThinkingLabelClick(labelRow, width)).toBe(true);
		expect(stripAnsi(component.render(width).join("\n"))).toContain("private reasoning");

		// Expanded content retains the same summary row, so it can collapse again.
		const expandedLabelRow = component.render(width).findIndex((line) => stripAnsi(line).includes("Thinking..."));
		expect(expandedLabelRow).toBeGreaterThanOrEqual(0);
		expect(component.handleThinkingLabelClick(expandedLabelRow, width)).toBe(true);
		expect(stripAnsi(component.render(width).join("\n"))).not.toContain("private reasoning");
	});

	test("keeps built-in edit self-shell output collapsed until explicitly expanded", () => {
		const editDefinition: ToolDefinition = {
			name: "edit",
			label: "edit",
			description: "fixture edit renderer",
			parameters: Type.Any(),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			renderShell: "self",
			renderCall: () => new Text("FULL EDIT DIFF", 0, 0),
			renderResult: () => new Text("EDIT RESULT", 0, 0),
		};
		const component = new GrokToolExecutionComponent(
			"edit",
			"tool-edit-1",
			{ path: "/tmp/example.ts" },
			{},
			editDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.canUseTurnGroup()).toBe(true);
		component.setTurnGrouped(true);

		const pending = stripAnsi(component.render(80).join("\n"));
		expect(component.render(80)).toHaveLength(1);
		expect(pending).toContain("◇ edit  /tmp/example.ts");
		expect(pending).not.toContain("FULL EDIT DIFF");

		component.updateResult({ content: [{ type: "text", text: "ok" }], details: {}, isError: false }, false);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("FULL EDIT DIFF");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("◆ edit  /tmp/example.ts");
		expect(expanded).toContain("FULL EDIT DIFF");
		expect(expanded).toContain("EDIT RESULT");
		expectFits(component);
	});

	test("leaves renderShell self tools entirely owned by the extension", () => {
		const toolDefinition: ToolDefinition = {
			name: "self_shell_tool",
			label: "self shell tool",
			description: "owns its complete visual shell",
			parameters: Type.Any(),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			renderShell: "self",
			renderCall: () => new Text("SELF OWNED FRAME", 0, 0),
			renderResult: () => new Text("SELF OWNED RESULT", 0, 0),
		};
		const component = new GrokToolExecutionComponent(
			"self_shell_tool",
			"tool-self-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		expect(component.canUseTurnGroup()).toBe(false);
		component.updateResult({ content: [{ type: "text", text: "ok" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("SELF OWNED FRAME");
		expect(rendered).toContain("SELF OWNED RESULT");
		expect(rendered).not.toContain("TOOL ·");
		expect(rendered).not.toContain("COLLAPSED");
	});
});
