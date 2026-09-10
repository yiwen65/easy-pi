import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

function createSummary() {
	return new CompactionSummaryMessageComponent({
		role: "compactionSummary",
		summary: "Detailed handoff content with enough words to wrap.\n\nFinal paragraph.",
		tokensBefore: 1_000,
		estimatedTokensAfter: 250,
		timestamp: 1,
	});
}

test.each([20, 80])("every expanded row collapses compaction at %s columns", (width) => {
	const component = createSummary();
	component.setExpanded(true);
	const count = component.render(width).length;
	expect(component.handleContentClick(-1, width)).toBe(false);
	expect(component.handleContentClick(count, width)).toBe(false);
	for (let row = 0; row < count; row++) {
		component.setExpanded(true);
		expect(component.handleContentClick(row, width), `row ${row}`).toBe(true);
		expect(stripAnsi(component.render(width).join("\n"))).not.toContain("Final paragraph.");
	}
	// Collapsed padding is not a new expansion target.
	expect(component.handleContentClick(0, width)).toBe(false);
});

test("real mouse clicks collapse compaction body and padding without copying, while drags still copy", async () => {
	const component = createSummary();
	const terminal = new VirtualTerminal(80, 20);
	const scrollView = new ScrollView(component, { primary: true });
	const copySelection = vi.fn(async () => true);
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection,
		onContentClick: (click) =>
			click.scrollView === scrollView && component.handleContentClick(click.row, terminal.columns),
	});
	tui.setLayoutRoot(scrollView);
	tui.start();
	try {
		await terminal.waitForRender();
		for (const target of ["body", "left padding", "right padding", "blank row"]) {
			component.setExpanded(true);
			tui.requestRender();
			await terminal.waitForRender();
			const row =
				target === "blank row"
					? 1
					: terminal.getViewport().findIndex((line) => line.includes("Detailed handoff")) + 1;
			const col = target === "right padding" ? 80 : target === "left padding" ? 1 : 6;
			terminal.sendInput(`\x1b[<0;${col};${row}M`);
			terminal.sendInput(`\x1b[<32;${col};${row}M`);
			terminal.sendInput(`\x1b[<0;${col};${row}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).not.toContain("Final paragraph.");
			expect(copySelection).not.toHaveBeenCalled();
		}
		component.setExpanded(true);
		tui.requestRender();
		await terminal.waitForRender();
		const row = terminal.getViewport().findIndex((line) => line.includes("Detailed handoff")) + 1;
		terminal.sendInput(`\x1b[<0;2;${row}M`);
		terminal.sendInput(`\x1b[<32;9;${row}M`);
		terminal.sendInput(`\x1b[<0;9;${row}m`);
		await terminal.waitForRender();
		expect(copySelection).toHaveBeenCalledWith("Detailed");
		expect(terminal.getViewport().join("\n")).toContain("Final paragraph.");
	} finally {
		tui.stop();
	}
});
