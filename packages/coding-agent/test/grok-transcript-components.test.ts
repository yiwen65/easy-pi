import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokAssistantMessageComponent } from "../src/modes/interactive-grok/components/grok-assistant-message.ts";
import { GrokToolExecutionComponent } from "../src/modes/interactive-grok/components/grok-tool-execution.ts";
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

	test("renders a timestamped, accented user band with a stable text signature", () => {
		const timestamp = new Date(2026, 7, 22, 9, 5).getTime();
		const component = new GrokUserMessageComponent("你好，Grok 👋", undefined, 1, [], timestamp);
		const rendered = stripAnsi(component.render(40).join("\n"));

		expect(component).toBeInstanceOf(UserMessageComponent);
		expect(rendered).toContain("❯ USER");
		expect(rendered).toContain("09:05");
		expect(rendered).toContain("你好，Grok 👋");
		expectFits(component);
	});

	test("keeps thinking and assistant hierarchy visible while streaming in place", () => {
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
		expect(partial).toContain("◇ THINKING");
		expect(partial).toContain("◆ ASSISTANT · STREAMING");
		expect(partial).toContain("正在分析 🧠");
		expect(partial).toContain("流式回答中…");

		component.updateContent(createAssistantMessage([{ type: "text", text: "完成 ✅" }]), false);
		const complete = stripAnsi(component.render(80).join("\n"));
		expect(complete).not.toContain("STREAMING");
		expect(complete).toContain("◆ ASSISTANT");
		expect(complete).toContain("完成 ✅");
		expectFits(component);
	});

	test("renders tool call identity and pending, success, and error chrome", () => {
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
		expect(stripAnsi(component.render(80).join("\n"))).toContain("TOOL · PENDING · custom_tool · tool-call-你好-1");

		component.markExecutionStarted();
		expect(stripAnsi(component.render(80).join("\n"))).toContain("TOOL · RUNNING");

		component.updateResult({ content: [{ type: "text", text: "成功 🎉" }], isError: false }, false);
		const success = stripAnsi(component.render(80).join("\n"));
		expect(success).toContain("TOOL · SUCCESS");
		expect(success).toContain("成功 🎉");

		component.updateResult({ content: [{ type: "text", text: "失败 💥" }], isError: true }, false);
		const error = stripAnsi(component.render(80).join("\n"));
		expect(error).toContain("TOOL · ERROR");
		expect(error).toContain("失败 💥");
		expectFits(component);
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
		expect(stripAnsi(component.render(120).join("\n"))).toContain("extension call updated");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("collapsed result");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("expanded result");
		expect(expanded).toContain("TOOL · SUCCESS");
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

		component.updateResult({ content: [{ type: "text", text: "ok" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("SELF OWNED FRAME");
		expect(rendered).toContain("SELF OWNED RESULT");
		expect(rendered).not.toContain("TOOL ·");
		expect(rendered).not.toContain("COLLAPSED");
	});
});
