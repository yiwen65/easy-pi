import { ScrollView, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokJumpToBottom } from "../src/modes/interactive-grok/components/grok-jump-to-bottom.ts";
import { GrokComponentFactory } from "../src/modes/interactive-grok/grok-component-factory.ts";

beforeAll(() => initTheme("dark"));

function setup(count = 60) {
	const terminal = new VirtualTerminal(40, 16);
	const content = new Text(Array.from({ length: count }, (_, i) => `line ${i}`).join("\n"), 0, 0);
	const scroll = new ScrollView(content, { follow: "end", primary: true });
	const editor = { render: () => ["draft"], invalidate: () => {}, handleInput: vi.fn() };
	const copySelection = vi.fn(async () => true);
	const ui = new TuiAltScreen(terminal, undefined, undefined, { copySelection });
	const view = new GrokComponentFactory().createInteractiveView({
		document: content,
		transcriptViewport: scroll,
		editorHost: editor,
		location: { path: "/tmp" },
		contextPercent: 10,
		ui,
	});
	ui.setLayoutRoot(view.fullscreenRoot);
	ui.setFocus(editor);
	ui.start();
	const settle = async () => {
		await terminal.waitForRender();
		await terminal.waitForRender();
	};
	const target = () => {
		const rows = terminal.getViewport();
		const y = rows.findIndex((line) => line.includes("⬇"));
		expect(y).toBeGreaterThan(0);
		expect(rows[y + 1]).toContain("╭");
		const x = rows[y].indexOf("⬇");
		expect(x).toBe(Math.floor((terminal.columns - 4) / 2) + 1);
		return { x: x + 1, y: y + 1 };
	};
	const click = (x: number, y: number) => {
		terminal.sendInput(`\x1b[<0;${x};${y}M`);
		terminal.sendInput(`\x1b[<32;${x};${y}M`);
		terminal.sendInput(`\x1b[<0;${x};${y}m`);
	};
	return {
		terminal,
		content,
		scroll,
		editor,
		copySelection,
		ui,
		view,
		settle,
		target,
		click,
		stop: () => {
			ui.stop();
			view.dispose();
		},
	};
}

test("shows after wheel scrolling, jumps without copying or taking focus, and resumes following output", async () => {
	const f = setup();
	try {
		await f.settle();
		expect(f.terminal.getViewport().join("\n")).not.toContain("⬇");
		for (let i = 0; i < 3; i++) {
			f.terminal.sendInput("\x1b[<64;10;5M");
			await f.settle();
			expect(f.scroll.isFollowingEnd).toBe(false);
			const { x, y } = f.target();
			f.click(x, y);
			await f.settle();
			expect(f.scroll.isAtEnd).toBe(true);
			expect(f.scroll.isFollowingEnd).toBe(true);
			expect(f.terminal.getViewport().join("\n")).not.toContain("⬇");
			expect(f.copySelection).not.toHaveBeenCalled();
			expect(f.ui.getFocusedComponent()).toBe(f.editor);
		}
		f.content.setText(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"));
		f.ui.requestRender();
		await f.settle();
		expect(f.terminal.getViewport().join("\n")).toContain("line 79");
		f.terminal.sendInput("hello");
		expect(f.editor.handleInput).toHaveBeenCalledWith("hello");
	} finally {
		f.stop();
	}
});

test("ignores adjacent clicks, drag selections and clicks through overlays", async () => {
	const f = setup();
	try {
		await f.settle();
		f.ui.scrollToTop();
		await f.settle();
		const { x, y } = f.target();
		f.click(1, y);
		await f.settle();
		expect(f.scroll.isAtEnd).toBe(false);
		f.terminal.sendInput(`\x1b[<0;${x};${y}M`);
		f.terminal.sendInput(`\x1b[<32;${x + 3};${y}M`);
		f.terminal.sendInput(`\x1b[<0;${x + 3};${y}m`);
		await f.settle();
		expect(f.scroll.isAtEnd).toBe(false);
		expect(f.copySelection).toHaveBeenCalledOnce();
		const overlay = f.ui.showOverlay(new Text("dialog", 0, 0), { width: 20 });
		await f.settle();
		f.click(x, y);
		await f.settle();
		expect(f.scroll.isAtEnd).toBe(false);
		overlay.hide();
	} finally {
		f.stop();
	}
});

test("updates after resize and content shrink, stays hidden for short content and regular rendering", async () => {
	const f = setup();
	try {
		await f.settle();
		f.ui.scrollToTop();
		await f.settle();
		f.terminal.resize(20, 16);
		await f.settle();
		const { x, y } = f.target();
		f.click(x, y);
		await f.settle();
		expect(f.scroll.isAtEnd).toBe(true);
		f.ui.scrollToTop();
		await f.settle();
		f.terminal.resize(40, 90);
		await f.settle();
		expect(f.terminal.getViewport().join("\n")).not.toContain("⬇");
		f.terminal.resize(40, 16);
		await f.settle();
		f.ui.scrollToTop();
		await f.settle();
		f.content.setText("short");
		f.ui.requestRender();
		await f.settle();
		expect(f.scroll.isAtEnd).toBe(true);
		expect(f.terminal.getViewport().join("\n")).not.toContain("⬇");
		expect(f.view.regularComponents.flatMap((c) => c.render(40)).join("\n")).not.toContain("⬇");
	} finally {
		f.stop();
	}
});

test("button is highlighted, width-safe and only its rendered cells are clickable", () => {
	const scroll = new ScrollView(new Text("body"), { follow: "end" });
	scroll.updateLayout(100, 10, () => {});
	scroll.scrollToStart();
	const button = new GrokJumpToBottom(scroll, new GrokComponentFactory().theme);
	for (const width of [1, 2, 3, 4, 20, 80]) {
		const lines = button.render(width);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
		expect(lines[0]).toContain("\x1b[1;7m");
		expect(button.handleClick(1, 0)).toBe(false);
		expect(button.handleClick(0, width)).toBe(false);
	}
});
