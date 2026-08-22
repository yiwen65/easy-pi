import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, type Focusable, isViewportTUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { GrokTuiRuntime, GrokViewportTuiRuntime } from "../src/grok-tui-runtime.ts";
import { TestTerminal } from "./test-terminal.ts";

class TestComponent implements Component, Focusable {
	focused = false;
	invalidateCount = 0;
	readonly inputs: string[] = [];
	lines: string[] = ["content"];

	render(): string[] {
		return this.lines;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {
		this.invalidateCount += 1;
	}
}

describe("GrokTuiRuntime", () => {
	it("coalesces invalidations and keeps only the latest resize", () => {
		const terminal = new TestTerminal(80, 24);
		const runtime = new GrokTuiRuntime(terminal);
		const component = new TestComponent();
		runtime.addChild(component);
		runtime.start();
		runtime.flushActions();
		const initialInvalidations = runtime.uiState.invalidationSequence;

		runtime.invalidate();
		runtime.requestRender();
		runtime.requestRender(true);
		terminal.resize(90, 30);
		terminal.resize(100, 35);
		terminal.resize(120, 40);
		runtime.flushActions();

		assert.equal(runtime.uiState.invalidationSequence, initialInvalidations + 2);
		assert.equal(component.invalidateCount, 1);
		assert.deepEqual(runtime.uiState.dimensions, { columns: 120, rows: 40 });
		assert.equal(runtime.uiState.resizeSequence, 1);
		runtime.stop();
	});

	it("preserves input order, focus, and overlay behavior", () => {
		const terminal = new TestTerminal();
		const runtime = new GrokTuiRuntime(terminal);
		const editor = new TestComponent();
		const overlay = new TestComponent();
		runtime.addChild(editor);
		runtime.setFocus(editor);
		runtime.start();
		const handle = runtime.showOverlay(overlay);

		terminal.sendInput("a");
		terminal.sendInput("b");
		runtime.flushActions();
		assert.equal(handle.isFocused(), true);
		assert.deepEqual(overlay.inputs, ["a", "b"]);
		assert.deepEqual(editor.inputs, []);

		handle.hide();
		terminal.sendInput("c");
		runtime.flushActions();
		assert.equal(editor.focused, true);
		assert.deepEqual(editor.inputs, ["c"]);
		runtime.stop();
	});

	it("stops the terminal and discards queued input", () => {
		const terminal = new TestTerminal();
		const runtime = new GrokTuiRuntime(terminal);
		const component = new TestComponent();
		runtime.addChild(component);
		runtime.setFocus(component);
		runtime.start();

		terminal.sendInput("late");
		runtime.stop();
		runtime.flushActions();

		assert.equal(runtime.uiState.lifecycle, "stopped");
		assert.deepEqual(component.inputs, []);
		assert.equal(terminal.startCount, 1);
		assert.equal(terminal.stopCount, 1);
	});

	it("preserves stop cleanup before the renderer has started", () => {
		const terminal = new TestTerminal();
		const runtime = new GrokTuiRuntime(terminal);

		runtime.stop();

		assert.equal(runtime.uiState.lifecycle, "stopped");
		assert.equal(terminal.startCount, 0);
		assert.equal(terminal.stopCount, 1);
		assert.equal(terminal.writes.includes("[show-cursor]"), true);
	});

	it("does not emit a new synchronized frame when rendered content is unchanged", () => {
		const terminal = new TestTerminal();
		const runtime = new GrokTuiRuntime(terminal);
		runtime.addChild(new TestComponent());
		runtime.start();
		runtime.flushActions();
		runtime.renderNow(true);
		terminal.clearWrites();

		runtime.renderNow();

		const output = terminal.writes.join("");
		assert.equal(output.includes("\x1b[?2026h"), false);
		assert.equal(output.includes("content"), false);
		runtime.stop();
	});

	it("retains concrete main-screen and viewport renderer semantics", () => {
		const main = new GrokTuiRuntime(new TestTerminal());
		const viewport = new GrokViewportTuiRuntime(new TestTerminal());
		const layout = new TestComponent();

		assert.equal(main instanceof TuiMainScreen, true);
		assert.equal(viewport instanceof TuiAltScreen, true);
		assert.equal(isViewportTUI(viewport), true);
		viewport.setLayoutRoot(layout);
		assert.deepEqual(viewport.render(80), ["content"]);
	});
});
