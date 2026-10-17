import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import {
	type Component,
	resetCapabilitiesCache,
	setCapabilities,
	Text,
	type TUI,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { GrokAssistantMessageComponent } from "../src/modes/interactive-grok/components/grok-assistant-message.ts";
import { GrokThinkingTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-thinking-turn-group.ts";
import { GrokToolExecutionComponent } from "../src/modes/interactive-grok/components/grok-tool-execution.ts";
import { GrokToolTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-tool-turn-group.ts";

const fakeTui = { requestRender: () => {} } as unknown as TUI;
const clipboard = "\x1b]52;c;cGF5bG9hZA==\x07";
const attacks = [
	clipboard,
	"\x1b]52;c;cGF5bG9hZA==\x1b\\",
	"\x9d52;c;cGF5bG9hZA==\x9c",
	"\x1b[2J\x1b[1;1H\x9b2J",
	"\x1b[?1049l\x1b[31mspoof\x1b[0m",
	"\x1b_Ga=T,f=100;payload\x1b\\",
	"\0\x07\x08\x0b\x0c\r\x7f\x85",
];

function expectSafe(component: Component): string {
	const rendered = component.render(200).join("\n");
	// Keep the oracle narrower than stripAnsi: allow only host styles and assistant zones.
	const plain = rendered.replace(/\x1b\[[\d;]*m/g, "").replace(/\x1b\]133;[ABC]\x07/g, "");
	expect(plain).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	return plain;
}

function createTool(args: unknown): GrokToolExecutionComponent {
	return new GrokToolExecutionComponent("bash", "test-call", args, {}, undefined, fakeTui, "/workspace");
}

describe("Grok untrusted display boundaries", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => resetCapabilitiesCache());

	test.each([false, true])(
		"sanitizes grouped thinking before live, final and history display (expanded=%s)",
		(expanded) => {
			const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking...", 1, false);
			const owner = new GrokAssistantMessageComponent();
			try {
				group.setExpanded(expanded);
				for (const attack of attacks) {
					for (let end = 1; end <= attack.length; end++) {
						const value = `visible ${attack.slice(0, end)}`;
						const message = fauxAssistantMessage([{ type: "thinking", thinking: value }]);
						owner.updateContent(message, true);
						owner.setThinkingDelegated(true);
						group.updateThinking(owner, owner.getThinkingText());
						expect(expectSafe(group)).toContain("visible");
						expect(message.content[0]).toEqual({ type: "thinking", thinking: value });
					}
				}
				group.completeTurn();
				expect(expectSafe(group)).toContain("visible");
				const restored = new GrokAssistantMessageComponent(
					fauxAssistantMessage([{ type: "thinking", thinking: `history ${clipboard}` }]),
				);
				group.updateThinking(restored, restored.getThinkingText());
				expect(expectSafe(group)).toContain("history");
			} finally {
				group.dispose();
			}
		},
	);

	test.each([false, true])(
		"sanitizes standalone thinking while streaming and when restored (expanded=%s)",
		(expanded) => {
			const component = new GrokAssistantMessageComponent();
			component.setExpanded(expanded);
			for (const attack of attacks) {
				for (let end = 1; end <= attack.length; end++) {
					const value = `visible ${attack.slice(0, end)}`;
					const message = fauxAssistantMessage([{ type: "thinking", thinking: value }]);
					component.updateContent(message, true);
					expect(expectSafe(component)).toContain("visible");
					component.updateContent(message, false);
					expect(expectSafe(component)).toContain(expanded ? "visible" : "Thinking...");
					expect(message.content[0]).toEqual({ type: "thinking", thinking: value });
				}
			}
			const restored = new GrokAssistantMessageComponent(
				fauxAssistantMessage([{ type: "thinking", thinking: `history ${clipboard}` }]),
			);
			restored.setExpanded(expanded);
			expect(expectSafe(restored)).toContain(expanded ? "history" : "Thinking...");
		},
	);

	test.each([false, true])(
		"sanitizes standalone and grouped tool summaries at every argument prefix (expanded=%s)",
		(expanded) => {
			const tool = createTool({});
			const group = new GrokToolTurnGroupComponent();
			tool.setTurnGrouped(true);
			group.addTool(tool);
			group.setExpanded(expanded);
			try {
				for (const attack of attacks) {
					for (let end = 1; end <= attack.length; end++) {
						const args = Object.freeze({ command: `visible ${attack.slice(0, end)}` });
						tool.updateArgs(args);
						expect(expectSafe(tool)).toContain("visible");
						expect(expectSafe(group)).toContain("visible");
						expect(args.command).toBe(`visible ${attack.slice(0, end)}`);
					}
				}
				tool.markExecutionStarted();
				tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
				group.completeTurn();
				expect(expectSafe(group)).toContain("visible");
				const restored = createTool({ command: `history ${clipboard}` });
				restored.setExpanded(expanded);
				expect(expectSafe(restored)).toContain("history");
			} finally {
				group.dispose();
			}
		},
	);

	test("sanitizes string, preferred-key, fallback-key and JSON tool summaries", () => {
		for (const args of [
			`visible ${clipboard}`,
			{ path: `visible ${clipboard}` },
			{ custom: `visible ${clipboard}` },
			{ nested: { text: "visible \x9d52;c;cGF5bG9hZA==\x9c" } },
		]) {
			expect(expectSafe(createTool(args))).toContain("visible");
		}
	});

	test.each(["thinking-group", "assistant", "tool", "tool-group"] as const)(
		"excludes injected OSC 52 from virtual-terminal writes for %s before and after expansion",
		(kind) => {
			const payload = `visible ${clipboard}`;
			const thinking = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking...", 1, false);
			thinking.updateThinking({}, payload);
			const assistant = new GrokAssistantMessageComponent();
			assistant.updateContent(fauxAssistantMessage([{ type: "thinking", thinking: payload }]), true);
			const tool = createTool({ command: payload });
			const tools = new GrokToolTurnGroupComponent();
			tools.addTool(tool);
			const component = { "thinking-group": thinking, assistant, tool, "tool-group": tools }[kind];
			const terminal = new VirtualTerminal(200, 24);
			const writes: string[] = [];
			const write = vi.spyOn(terminal, "write").mockImplementation((data) => {
				writes.push(data);
			});
			const tui = new TuiAltScreen(terminal);
			try {
				tui.addChild(component);
				tui.start();
				for (const expanded of [false, true]) {
					writes.length = 0;
					component.setExpanded(expanded);
					tui.renderNow(true);
					const output = writes.join("");
					expect(output).toContain("visible");
					expect.soft(output).not.toContain("\x1b]52;");
				}
			} finally {
				tui.stop({ preserveScreen: true });
				write.mockRestore();
				thinking.dispose();
				tools.dispose();
			}
		},
	);

	test.each([false, true])(
		"sanitizes model tool-name prefixes before dispatch and in restored errors (expanded=%s)",
		(expanded) => {
			for (const attack of attacks) {
				for (let end = 1; end <= attack.length; end++) {
					const name = `项目_café_🦊_${attack.slice(0, end)}`;
					const call = fauxToolCall(name, { command: "safe arguments" });
					const message = fauxAssistantMessage([call], { stopReason: "toolUse" });
					for (const history of [false, true]) {
						const tool = new GrokToolExecutionComponent(
							call.name,
							call.id,
							call.arguments,
							{},
							undefined,
							fakeTui,
							"/workspace",
						);
						const group = new GrokToolTurnGroupComponent();
						try {
							tool.setTurnGrouped(true);
							group.addTool(tool);
							group.setExpanded(expanded);
							if (history) {
								tool.updateResult({
									content: [{ type: "text", text: `Tool ${name} not found` }],
									isError: true,
								});
								group.completeTurn();
							}
							expect(expectSafe(tool)).toContain("项目_café_🦊_");
							expect(expectSafe(group)).toContain("项目_café_🦊_");
							expect(tool.render(200).join("\n")).toContain(theme.getFgAnsi("toolTitle"));
							expect(message.content[0]).toMatchObject({ name, arguments: { command: "safe arguments" } });
						} finally {
							group.dispose();
						}
					}
				}
			}
		},
	);

	test("uses raw tool identity for Grok routing even when its display name matches a special tool", () => {
		const name = `edit${clipboard}`;
		const definition = {
			name,
			label: name,
			description: "test",
			parameters: Type.Object({}),
			renderShell: "self" as const,
			execute: async () => ({ content: [], details: {} }),
			renderCall: () => new Text("\x1b[1mhost-styled\x1b[22m", 0, 0),
		};
		const tool = new GrokToolExecutionComponent(name, "edit-alias", {}, {}, definition, fakeTui, "/workspace");
		expect(tool.canUseTurnGroup()).toBe(false);
		expect(definition.name).toBe(name);
		expect(tool.render(200).join("\n")).toContain("\x1b[1mhost-styled\x1b[22m");
		const subagentAlias = new GrokToolExecutionComponent(
			`subagent${clipboard}`,
			"subagent-alias",
			{},
			{},
			undefined,
			fakeTui,
			"/workspace",
		);
		expect(subagentAlias.canUseTurnGroup()).toBe(true);
	});

	test.each(["base", "base-fallback", "grok", "group"] as const)(
		"excludes raw tool-name controls from %s virtual writes before dispatch and after restoring errors",
		(kind) => {
			const name = `项目_café_🦊_${clipboard}\x9d52;c;cGF5bG9hZA==\x9c\x1b[999;999H`;
			const call = fauxToolCall(name, {});
			const terminal = new VirtualTerminal(200, 24);
			const writes: string[] = [];
			const write = vi.spyOn(terminal, "write").mockImplementation((data) => {
				writes.push(data);
			});
			const tui = new TuiAltScreen(terminal);
			const tool =
				kind === "base" || kind === "base-fallback"
					? new ToolExecutionComponent(
							call.name,
							call.id,
							call.arguments,
							{},
							kind === "base-fallback"
								? {
										name,
										label: name,
										description: "test",
										parameters: Type.Object({}),
										execute: async () => ({ content: [], details: {} }),
									}
								: undefined,
							fakeTui,
							"/workspace",
						)
					: new GrokToolExecutionComponent(
							call.name,
							call.id,
							call.arguments,
							{},
							undefined,
							fakeTui,
							"/workspace",
						);
			const group = new GrokToolTurnGroupComponent();
			if (tool instanceof GrokToolExecutionComponent) group.addTool(tool);
			const component = kind === "group" ? group : tool;
			try {
				tui.addChild(component);
				tui.start();
				for (const history of [false, true]) {
					if (history) {
						tool.updateResult({ content: [{ type: "text", text: `Tool ${name} not found` }], isError: true });
						group.completeTurn();
					}
					for (const expanded of [false, true]) {
						writes.length = 0;
						component.setExpanded(expanded);
						tui.renderNow(true);
						const output = writes.join("");
						expect.soft(output).not.toContain("\x1b]52;");
						expect.soft(output).not.toMatch(/[\x7f-\x9f]/);
						expect.soft(output).not.toContain("\x1b[999;999H");
						expect(output).toContain("项目_café_🦊_");
						expect(call.name).toBe(name);
					}
				}
			} finally {
				tui.stop({ preserveScreen: true });
				write.mockRestore();
				group.dispose();
			}
		},
	);

	test("preserves host Markdown styles, hyperlinks and custom tool output without mutating raw args", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const thinking = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking...", 1, false);
		try {
			thinking.updateThinking({}, `**项目 café 🦊** [docs](https://example.test/docs) ${clipboard}`);
			thinking.setExpanded(true);
			const output = thinking.render(200).join("\n");
			expect(output).toContain("项目 café 🦊");
			expect(output).toContain("\x1b]8;;https://example.test/docs");
			expect(output).not.toContain("\x1b]52;");
			const args = Object.freeze({ command: `visible ${clipboard}` });
			const styled = "\x1b[1mhost-styled\x1b[22m";
			const renderCall = vi.fn((_args: unknown) => new Text(styled, 0, 0));
			const tool = new GrokToolExecutionComponent(
				"custom",
				"id",
				args,
				{},
				{
					name: "custom",
					label: "Custom",
					description: "test",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {} }),
					renderCall,
				},
				fakeTui,
				"/workspace",
			);
			tool.setExpanded(true);
			expect(tool.render(200).join("\n")).toContain(styled);
			expect(renderCall.mock.calls[0]?.[0]).toBe(args);
			expect(args.command).toBe(`visible ${clipboard}`);
		} finally {
			thinking.dispose();
		}
	});
});
