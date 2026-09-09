import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokThinkingTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-thinking-turn-group.ts";

beforeAll(() => initTheme("dark"));

test.each([false, true])("thinking mouse clicks toggle without copying (stationary motion: %s)", async (motion) => {
	const terminal = new VirtualTerminal(80, 10);
	const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking...", 1, false);
	group.updateThinking({}, "first reasoning\n\nsecond reasoning", false);
	group.completeTurn();
	const scrollView = new ScrollView(group, { primary: true });
	const copySelection = vi.fn(async () => true);
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		onContentClick: (click) => click.scrollView === scrollView && group.handleOverviewClick(click.row),
		copySelection,
	});
	tui.setLayoutRoot(scrollView);
	tui.start();
	try {
		await terminal.waitForRender();
		// Fix the clock so repeated clicks reliably fall inside the double-click interval.
		vi.spyOn(Date, "now").mockReturnValue(1000);
		for (let index = 0; index < 4; index++) {
			// Click inside the word, not its first column: selection snaps to the word start.
			terminal.sendInput("\x1b[<0;6;1M");
			if (motion) terminal.sendInput("\x1b[<32;6;1M");
			terminal.sendInput("\x1b[<0;6;1m");
			await terminal.waitForRender();
			expect(copySelection).not.toHaveBeenCalled();
			expect(terminal.getViewport().join("\n").includes("first reasoning")).toBe(index % 2 === 0);
		}

		// Expanded body rows also collapse through the actual mouse dispatch path.
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<0;6;1m");
		await terminal.waitForRender();
		const bodyRow = terminal.getViewport().findIndex((line) => line.includes("second reasoning")) + 1;
		expect(bodyRow).toBeGreaterThan(1);
		terminal.sendInput(`\x1b[<0;6;${bodyRow}M`);
		terminal.sendInput(`\x1b[<0;6;${bodyRow}m`);
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).not.toContain("second reasoning");
		expect(copySelection).not.toHaveBeenCalled();

		// Deliberate drag selection must still copy rather than toggle.
		terminal.sendInput("\x1b[<0;4;1M");
		terminal.sendInput("\x1b[<32;8;1M");
		terminal.sendInput("\x1b[<0;8;1m");
		await terminal.waitForRender();
		expect(copySelection).toHaveBeenCalledOnce();
		expect(group.render(80)).toHaveLength(1);
	} finally {
		vi.restoreAllMocks();
		tui.stop();
		group.dispose();
	}
});
