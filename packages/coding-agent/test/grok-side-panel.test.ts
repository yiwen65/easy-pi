import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Input, setKeybindings, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SideConversation, SideConversationSnapshot } from "../src/core/side-conversation-types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { GrokSidePanel } from "../src/modes/interactive-grok/components/grok-side-panel.ts";

afterEach(() => setKeybindings(new KeybindingsManager()));

function fixture() {
	initTheme("dark");
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	let snapshot: SideConversationSnapshot = {
		state: "idle",
		messages: [],
		parentRunning: true,
		usage: { input: 120, cacheRead: 100, cacheWrite: 20 },
	};
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const open = vi.fn(async () => {});
	const prompt = vi.fn(async (_text: string) => {});
	const abort = vi.fn(async () => {});
	const close = vi.fn(async () => {
		snapshot = { ...snapshot, state: "closed" };
		emit();
	});
	const shutdown = vi.fn(async () => {});
	const conversation: SideConversation = {
		get snapshot() {
			return snapshot;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		open,
		prompt,
		abort,
		close,
		shutdown,
	};
	let height = 12;
	const requestRender = vi.fn();
	const done = vi.fn();
	const panel = new GrokSidePanel({
		conversation,
		theme,
		keybindings: keys,
		requestRender,
		done,
		height: () => height,
	});
	return {
		panel,
		conversation,
		keys,
		open,
		prompt,
		abort,
		close,
		shutdown,
		done,
		requestRender,
		listeners,
		emit,
		text: (width = 160) => stripVTControlCharacters(panel.render(width).join("\n")),
		update: (patch: Partial<SideConversationSnapshot>) => {
			snapshot = { ...snapshot, ...patch };
			emit();
		},
		height: (value: number) => {
			height = value;
		},
	};
}

test("side panel owns its input, displays observed usage and tracks parent state", async () => {
	const f = fixture();
	f.panel.focused = true;
	f.update({ messages: [fauxAssistantMessage("live side answer")] });
	expect(f.text()).toContain("Side conversation");
	expect(f.text()).toContain("parent permissions");
	expect(f.text()).toContain("shared workspace");
	expect(f.text()).not.toContain("read-only");
	expect(f.text()).toContain("main running");
	expect(f.text()).toContain("cache read 100 / write 20 (observed)");
	expect(f.text()).toContain("live side answer");
	f.update({ parentRunning: false });
	expect(f.text()).toContain("main idle");
	f.panel.handleInput("!echo plain side text");
	f.panel.handleInput("\r");
	await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledWith("!echo plain side text"));
	await Promise.resolve();
	f.panel.handleInput("/model plain side question");
	f.panel.handleInput("\r");
	await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledWith("/model plain side question"));
	expect(f.open).not.toHaveBeenCalled();
	expect(f.shutdown).not.toHaveBeenCalled();
	f.panel.dispose();
});

test("hiding and disposing only release UI subscriptions, ignoring late updates", () => {
	const f = fixture();
	expect(f.listeners.size).toBe(1);
	f.panel.handleInput("\x1b[1;3D");
	expect(f.done).toHaveBeenCalledTimes(1);
	expect(f.listeners.size).toBe(0);
	expect(f.close).not.toHaveBeenCalled();
	expect(f.abort).not.toHaveBeenCalled();
	expect(f.shutdown).not.toHaveBeenCalled();
	const renders = f.requestRender.mock.calls.length;
	f.update({ messages: [fauxAssistantMessage("late answer")] });
	f.panel.dispose();
	f.panel.handleInput("ignored");
	expect(f.requestRender).toHaveBeenCalledTimes(renders);
	expect(f.done).toHaveBeenCalledTimes(1);
	expect(f.panel.focused).toBe(false);
});

test("explicit close waits for the resource acknowledgement before dismissing", async () => {
	const f = fixture();
	let finish: () => void = () => {};
	f.close.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	f.panel.handleInput("\x04");
	f.panel.handleInput("\x04");
	expect(f.close).toHaveBeenCalledTimes(1);
	expect(f.text()).toContain("Closing side conversation");
	expect(f.done).not.toHaveBeenCalled();
	f.update({ state: "closed" });
	finish();
	await vi.waitFor(() => expect(f.done).toHaveBeenCalledTimes(1));
	expect(f.shutdown).not.toHaveBeenCalled();
});

test("incomplete cleanup and close rejection remain visible", async () => {
	const f = fixture();
	f.close.mockImplementation(async () => {
		f.update({ state: "cleanup-failed", error: "writer remains open" });
	});
	f.panel.handleInput("\x04");
	await vi.waitFor(() => expect(f.text()).toContain("writer remains open"));
	expect(f.done).not.toHaveBeenCalled();
	await Promise.resolve();
	f.close.mockRejectedValue(new Error("shutdown rejected"));
	f.panel.handleInput("\x04");
	await vi.waitFor(() => expect(f.text()).toContain("shutdown rejected"));
	expect(f.done).not.toHaveBeenCalled();
	f.panel.dispose();
});

test("escape cancels only the side without closing the panel", async () => {
	const f = fixture();
	f.update({ state: "running" });
	f.panel.handleInput("\x1b");
	await vi.waitFor(() => expect(f.text()).toContain("Main task was not interrupted"));
	expect(f.abort).toHaveBeenCalledTimes(1);
	expect(f.close).not.toHaveBeenCalled();
	expect(f.shutdown).not.toHaveBeenCalled();
	expect(f.done).not.toHaveBeenCalled();
	f.panel.dispose();
});

test("rejected input restores its draft but never overwrites a newer draft", async () => {
	const f = fixture();
	f.prompt.mockRejectedValueOnce(new Error("prefix changed"));
	f.panel.handleInput("first draft");
	f.panel.handleInput("\r");
	await vi.waitFor(() => expect(f.text()).toContain("prefix changed"));
	expect(f.text()).toContain("first draft");
	let reject: (error: Error) => void = () => {};
	f.prompt.mockImplementation(
		() =>
			new Promise<void>((_resolve, failed) => {
				reject = failed;
			}),
	);
	f.panel.handleInput("\r");
	f.panel.handleInput("new draft");
	reject(new Error("provider rejected"));
	await vi.waitFor(() => expect(f.text()).toContain("provider rejected"));
	expect(f.text()).toContain("new draft");
	expect(f.text()).not.toContain("first draft");
	f.panel.dispose();
});

test("a running answer retains a new draft instead of queuing it into either session", () => {
	const f = fixture();
	f.update({ state: "running" });
	f.panel.handleInput("next side question");
	f.panel.handleInput("\r");
	expect(f.prompt).not.toHaveBeenCalled();
	expect(f.text()).toContain("Draft retained");
	expect(f.text()).toContain("next side question");
	f.panel.dispose();
});

test("panel actions and submit honor injected keybindings", async () => {
	const f = fixture();
	f.keys.setUserBindings({
		"app.side.hide": "ctrl+h",
		"app.side.abort": "ctrl+k",
		"app.side.close": "ctrl+x",
		"tui.input.submit": "ctrl+g",
	});
	f.panel.handleInput("question");
	f.panel.handleInput("\r");
	expect(f.prompt).not.toHaveBeenCalled();
	f.panel.handleInput("\x07");
	await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledWith("question"));
	f.panel.handleInput("\x1b");
	expect(f.abort).not.toHaveBeenCalled();
	f.panel.handleInput("\x0b");
	await vi.waitFor(() => expect(f.abort).toHaveBeenCalledTimes(1));
	expect(f.text()).toContain("ctrl+h return");
	expect(f.text()).toContain("ctrl+x close");
	f.panel.handleInput("\x08");
	expect(f.done).toHaveBeenCalledTimes(1);
});

test("scrollback can detach from and reattach to newest side output", () => {
	const f = fixture();
	f.height(10);
	f.update({ messages: [fauxAssistantMessage(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"))] });
	expect(f.text()).toContain("line 49");
	f.panel.handleInput("\x1b[5~");
	expect(f.text()).not.toContain("line 49");
	f.panel.handleInput("\x1b[F");
	expect(f.text()).toContain("line 49");
	f.panel.dispose();
});

test("a real focused overlay keeps the main draft isolated and restores editor input on hide", async () => {
	const f = fixture();
	const terminal = new VirtualTerminal(80, 12);
	const tui = new TuiAltScreen(terminal);
	const mainInput = new Input();
	mainInput.setValue("MAIN_DRAFT");
	tui.addChild(mainInput);
	tui.setFocus(mainInput);
	f.requestRender.mockImplementation(() => tui.requestRender());
	const overlay = tui.showOverlay(f.panel, { width: "100%", maxHeight: "100%" });
	f.done.mockImplementation(() => overlay.hide());
	tui.start();
	try {
		terminal.sendInput("side draft");
		await terminal.waitForRender();
		expect(f.panel.focused).toBe(true);
		expect(terminal.getViewport().join("\n")).toContain("side draft");
		expect(mainInput.getValue()).toBe("MAIN_DRAFT");
		f.update({ state: "running", messages: [fauxAssistantMessage("STREAMED_SIDE_REPLY")] });
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("STREAMED_SIDE_REPLY");
		terminal.sendInput("\x1b");
		await vi.waitFor(() => expect(f.abort).toHaveBeenCalledTimes(1));
		terminal.sendInput("\x1b[1;3D");
		await terminal.waitForRender();
		expect(f.panel.focused).toBe(false);
		expect(terminal.getViewport().join("\n")).toContain("MAIN_DRAFT");
		terminal.sendInput("X");
		await terminal.waitForRender();
		expect(mainInput.getValue()).toBe("XMAIN_DRAFT");
		expect(f.close).not.toHaveBeenCalled();
		expect(f.shutdown).not.toHaveBeenCalled();
	} finally {
		f.panel.dispose();
		tui.stop();
	}
});

test("untrusted output and errors cannot emit private terminal controls; short views stay bounded", () => {
	const f = fixture();
	f.update({
		messages: [fauxAssistantMessage("safe\x1b[?1049l answer\x1b]0;untrusted\x07")],
		error: "failure\x1b[?25h",
	});
	for (const height of [1, 2, 3, 4, 12]) {
		f.height(height);
		for (const width of [1, 2, 8, 24, 80]) {
			const lines = f.panel.render(width);
			expect(lines).toHaveLength(height);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.join("\n")).not.toMatch(/\x1b\[\?/);
			expect(lines.join("\n")).not.toContain("\x1b]0;");
		}
	}
	f.panel.dispose();
});
