import { Container, ScrollView, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { beforeAll, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { GrokUserMessageComponent } from "../src/modes/interactive-grok/components/grok-user-message.ts";

beforeAll(() => initTheme("dark"));

test.each(["dark", "light"])("user text is bold purple without a filled background in %s", (name) => {
	const previousLevel = chalk.level;
	chalk.level = 3;
	initTheme(name);
	try {
		const component = new GrokUserMessageComponent("hello 中文消息");
		for (const width of [20, 80]) {
			const lines = component.render(width);
			expect(lines[2]).toContain("\x1b[1m");
			expect(lines[2]).toContain(theme.getFgAnsi("userMessageText"));
			expect(lines.join("\n")).not.toMatch(/\x1b\[(?:48[;:]|4[0-7]m)/);
			expect(lines[0]).toBe("");
			expect(lines.at(-1)).toBe("");
		}
	} finally {
		chalk.level = previousLevel;
		initTheme("dark");
	}
});

test("framed user text stays selectable after terminal resize", async () => {
	const terminal = new VirtualTerminal(80, 12);
	const component = new GrokUserMessageComponent("hello 中文消息");
	const scrollView = new ScrollView(component, { primary: true });
	const copySelection = vi.fn(async () => true);
	const tui = new TuiAltScreen(terminal, undefined, undefined, { copySelection });
	tui.setLayoutRoot(scrollView);
	tui.start();
	try {
		await terminal.waitForRender();
		terminal.resize(20, 12);
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		expect(viewport[0].trim()).toBe("");
		expect(viewport[1]).toMatch(/^╭.*╮$/);
		expect(viewport[2]).toMatch(/^│ hello 中文消息\s+│$/);
		expect(viewport[3]).toMatch(/^╰─+╯$/);
		expect(viewport[4].trim()).toBe("");
		// Select just the text, excluding the frame and inner left padding.
		terminal.sendInput("\x1b[<0;3;3M");
		terminal.sendInput("\x1b[<32;7;3M");
		terminal.sendInput("\x1b[<0;7;3m");
		await terminal.waitForRender();
		expect(copySelection).toHaveBeenCalledWith("hello");
	} finally {
		tui.stop();
	}
});

test("semantic prompt navigation lands on the rounded header rather than its spacer", async () => {
	const terminal = new VirtualTerminal(40, 8);
	const transcript = new Container();
	transcript.addChild(new Text("previous answer", 0, 0));
	transcript.addChild(new GrokUserMessageComponent("next prompt"));
	transcript.addChild(new Text("following answer\n".repeat(10), 0, 0));
	const scrollView = new ScrollView(transcript, { primary: true });
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(scrollView);
	tui.start();
	try {
		await terminal.waitForRender();
		tui.scrollToTop();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		expect(scrollView.scrollTop).toBe(2);
		expect(terminal.getViewport()[0]).toMatch(/^╭─ ❯/);
	} finally {
		tui.stop();
	}
});
