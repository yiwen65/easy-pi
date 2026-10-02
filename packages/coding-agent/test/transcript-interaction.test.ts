import { type Component, Container, ScrollView, setKeybindings, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { SubagentGroupComponent } from "../src/modes/interactive/components/subagent-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { TurnTranscriptContainer } from "../src/modes/interactive/components/turn-transcript-container.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokThinkingTurnGroupComponent } from "../src/modes/interactive-grok/components/grok-thinking-turn-group.ts";
import { GrokToolExecutionComponent } from "../src/modes/interactive-grok/components/grok-tool-execution.ts";

beforeAll(() => initTheme("dark"));

interface NavigationHost {
	jumpToUserPrompt(direction: -1 | 1): void;
	scrollToUserPrompt(component: UserMessageComponent): void;
	showPromptJumpSelector(): void;
}
interface ClickHost {
	handleTranscriptContentClick(click: { scrollView: ScrollView; row: number; col: number }): boolean;
}
interface SelectorHost {
	showTranscriptToggleSelector(): void;
	setupKeyHandlers(): void;
	toolOutputExpanded: boolean;
}

function navigationFixture() {
	const prompts = [10, 50, 90].map(() => new UserMessageComponent("prompt", getMarkdownTheme()));
	const scroll = new ScrollView(new Text(""), { follow: "end" });
	scroll.updateLayout(100, 30, () => {});
	const offsets = prompts.map((component, index) => ({ component, start: [10, 50, 90][index], height: 1 }));
	const host = Object.assign(Object.create(InteractiveMode.prototype) as NavigationHost, {
		renderer: { mode: "fullscreen" },
		grokComponentFactory: {},
		transcriptScrollView: scroll,
		transcriptContentWidth: (): number => 80,
		computeChatChildOffsets: () => offsets,
		highlightUserPrompt: vi.fn(),
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
	});
	return { host, scroll, prompts, offsets };
}

test("local and panel actions have configurable defaults without changing Ctrl+O", () => {
	const keys = new KeybindingsManager();
	expect(keys.getKeys("app.transcript.toggle")).toEqual(["alt+o"]);
	expect(keys.matches("\x1bo", "app.transcript.toggle")).toBe(true);
	expect(keys.getKeys("app.tasks.insertPath")).toEqual(["y"]);
	expect(keys.getKeys("app.tasks.latest")).toEqual(["end"]);
	expect(keys.getKeys("app.tools.expand")).toEqual(["ctrl+o"]);
});

test("consecutive prompt jumps cycle component identity despite scroll clamp", () => {
	const { host, scroll, prompts } = navigationFixture();
	host.scrollToUserPrompt(prompts[2]);
	expect(scroll.scrollTop).toBe(70);
	host.jumpToUserPrompt(1);
	expect(scroll.scrollTop).toBe(10);
	host.jumpToUserPrompt(-1);
	expect(scroll.scrollTop).toBe(70);
	host.jumpToUserPrompt(-1);
	expect(scroll.scrollTop).toBe(50);
	expect(scroll.isFollowingEnd).toBe(false);
	scroll.scrollToEnd();
	expect(scroll.isFollowingEnd).toBe(true);
});

test("prompt selector selection establishes the identity used by the next jump", () => {
	const { host, scroll, prompts } = navigationFixture();
	setKeybindings(new KeybindingsManager());
	const selected = Object.assign(host, {
		chatContainer: { children: prompts },
		showSelector: (create: (done: () => void) => { focus: Component }) => create(() => {}).focus.handleInput?.("\r"),
	});
	selected.showPromptJumpSelector();
	expect(scroll.scrollTop).toBe(70);
	selected.jumpToUserPrompt(1);
	expect(scroll.scrollTop).toBe(10);
});

test("manual scroll away/back and geometry/removal invalidate prompt identity", () => {
	const { host, scroll, prompts, offsets } = navigationFixture();
	host.scrollToUserPrompt(prompts[2]);
	scroll.scrollTo(0);
	scroll.scrollTo(70);
	host.jumpToUserPrompt(-1);
	expect(scroll.scrollTop).toBe(50);
	host.scrollToUserPrompt(prompts[2]);
	scroll.scrollTo(90); // Even a clamped same-position manual request resets selection.
	host.jumpToUserPrompt(-1);
	expect(scroll.scrollTop).toBe(50);
	host.scrollToUserPrompt(prompts[2]);
	host.transcriptContentWidth = () => 60;
	host.jumpToUserPrompt(-1);
	expect(scroll.scrollTop).toBe(50);
	host.scrollToUserPrompt(prompts[2]);
	scroll.updateLayout(100, 40, () => {});
	host.jumpToUserPrompt(-1);
	expect(scroll.scrollTop).toBe(50);
	host.scrollToUserPrompt(prompts[2]);
	offsets.pop();
	host.jumpToUserPrompt(1);
	expect(scroll.scrollTop).toBe(10);
});

test("fullscreen hit testing uses displayed offsets without rendering changed children", async () => {
	const terminal = new VirtualTerminal(80, 12);
	const header = new Text("header", 0, 0);
	const chat = new TurnTranscriptContainer();
	const before = new Text("before", 0, 0);
	const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking", 1, false);
	group.updateThinking({}, "reasoning");
	group.completeTurn();
	chat.addChild(before);
	chat.addChild(group);
	const document = new Container();
	document.addChild(header);
	document.addChild(chat);
	const scroll = new ScrollView(document, { primary: true });
	const copySelection = vi.fn(async () => true);
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		onContentClick: (click): boolean => host.handleTranscriptContentClick(click),
		copySelection,
	});
	const host = Object.assign(Object.create(InteractiveMode.prototype) as ClickHost, {
		renderer: tui,
		ui: tui,
		transcriptScrollView: scroll,
		documentContainer: document,
		chatContainer: chat,
	});
	tui.setLayoutRoot(scroll);
	expect(host.handleTranscriptContentClick({ scrollView: scroll, row: 2, col: 5 })).toBe(false);
	tui.start();
	try {
		await terminal.waitForRender();
		before.setText("new\nundisplayed\nrows");
		const render = vi.spyOn(before, "render");
		terminal.sendInput("\x1b[<0;6;3M");
		terminal.sendInput("\x1b[<32;6;3M");
		terminal.sendInput("\x1b[<0;6;3m");
		expect(copySelection).not.toHaveBeenCalled();
		expect(group.render(80).length).toBeGreaterThan(1);
		expect(render).not.toHaveBeenCalled();
		expect(group.render(80).join("\n")).toContain("reasoning");
		chat.removeChild(group);
		const toggle = vi.spyOn(group, "handleOverviewClick");
		expect(host.handleTranscriptContentClick({ scrollView: scroll, row: 2, col: 5 })).toBe(false);
		expect(toggle).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalled();
		chat.addChild(group);
		terminal.resize(60, 12);
		expect(host.handleTranscriptContentClick({ scrollView: scroll, row: 2, col: 5 })).toBe(false);
		expect(toggle).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalled();
	} finally {
		tui.stop();
	}
});

test("painted subagent Activity click survives an unseen multiline result without measuring again", async () => {
	const terminal = new VirtualTerminal(100, 30);
	const chat = new TurnTranscriptContainer();
	const group = new SubagentGroupComponent("/root/worker");
	const copySelection = vi.fn(async () => true);
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		onContentClick: (click): boolean => host.handleTranscriptContentClick(click),
		copySelection,
	});
	const args = { target: "/root/worker", message: "activity receipt" };
	const tool = new ToolExecutionComponent("send_message", "call", args, {}, undefined, tui, "/tmp");
	group.addTool("send_message", tool, args);
	group.setExpanded(true);
	chat.addChild(group);
	const document = new Container();
	document.addChild(chat);
	const scroll = new ScrollView(document, { primary: true });
	const host = Object.assign(Object.create(InteractiveMode.prototype) as ClickHost, {
		renderer: tui,
		ui: tui,
		transcriptScrollView: scroll,
		documentContainer: document,
		chatContainer: chat,
	});
	tui.setLayoutRoot(scroll);
	tui.start();
	try {
		await terminal.waitForRender();
		const row = terminal.getViewport().findIndex((line) => line.includes("Activity")) + 1;
		expect(row).toBeGreaterThan(1);
		group.addMailboxResult({
			id: "result",
			from: "/root/worker",
			to: "/root",
			turnId: "turn",
			kind: "result",
			text: Array.from({ length: 8 }, (_, i) => `unseen result ${i}`).join("\n"),
		});
		const render = vi.spyOn(group, "render");
		terminal.sendInput(`\x1b[<0;5;${row}M`);
		terminal.sendInput(`\x1b[<0;5;${row}m`);
		expect(render).not.toHaveBeenCalled();
		expect(copySelection).not.toHaveBeenCalled();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Message sent");
		expect(terminal.getViewport().join("\n")).toContain("▾ Activity");
		expect(terminal.getViewport().join("\n")).not.toContain("activity receipt");
	} finally {
		tui.stop();
	}
});

test("mouse expansion detaches follow before layout so a long block header stays visible; End restores follow", async () => {
	setKeybindings(new KeybindingsManager());
	const terminal = new VirtualTerminal(80, 10);
	const chat = new TurnTranscriptContainer();
	chat.addChild(new Text(Array.from({ length: 20 }, (_, i) => `history ${i}`).join("\n"), 0, 0));
	const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking", 1, false);
	group.updateThinking({}, Array.from({ length: 100 }, (_, i) => `reasoning ${i}`).join("\n"));
	group.completeTurn();
	chat.addChild(group);
	const document = new Container();
	document.addChild(chat);
	const scroll = new ScrollView(document, { primary: true, follow: "end" });
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		onContentClick: (click): boolean => host.handleTranscriptContentClick(click),
	});
	const host = Object.assign(Object.create(InteractiveMode.prototype) as ClickHost, {
		renderer: tui,
		ui: tui,
		transcriptScrollView: scroll,
		documentContainer: document,
		chatContainer: chat,
	});
	tui.setLayoutRoot(scroll);
	tui.start();
	try {
		await terminal.waitForRender();
		const top = scroll.scrollTop;
		expect(scroll.isFollowingEnd).toBe(true);
		terminal.sendInput("\x1b[<0;5;10M");
		terminal.sendInput("\x1b[<0;5;10m");
		expect(scroll.isFollowingEnd).toBe(false);
		await terminal.waitForRender();
		expect(scroll.scrollTop).toBe(top);
		expect(terminal.getViewport().join("\n")).toContain("✦");
		terminal.sendInput("\x1b[F");
		await terminal.waitForRender();
		expect(scroll.isFollowingEnd).toBe(true);
		expect(scroll.scrollTop).toBeGreaterThan(top);
	} finally {
		tui.stop();
	}
});

test("local keyboard selector restores editor focus and draft without changing global expansion", async () => {
	const terminal = new VirtualTerminal(80, 24);
	const keys = new KeybindingsManager({ "app.transcript.toggle": "alt+z" });
	setKeybindings(keys);
	const tui = new TuiAltScreen(terminal);
	const editor = new CustomEditor(tui, getEditorTheme(), keys);
	const draft = "  中文 draft\n\n";
	editor.setText(draft);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const chat = new TurnTranscriptContainer();
	const first = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking", 1, false);
	const second = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking", 1, false);
	first.updateThinking({}, "first reasoning");
	second.updateThinking({}, "second reasoning");
	first.completeTurn();
	second.completeTurn();
	chat.addChild(first);
	chat.addChild(second);
	const document = new Container();
	document.addChild(chat);
	const scroll = new ScrollView(document, { primary: true });
	const host = Object.assign(Object.create(InteractiveMode.prototype) as SelectorHost, {
		renderer: tui,
		ui: tui,
		keybindings: keys,
		defaultEditor: editor,
		editor,
		editorContainer,
		chatContainer: chat,
		documentContainer: document,
		transcriptScrollView: scroll,
		toolOutputExpanded: false,
		isBashMode: false,
		showStatus: vi.fn(),
	});
	host.setupKeyHandlers();
	tui.addChild(editorContainer);
	tui.setFocus(editor);
	tui.start();
	try {
		await terminal.waitForRender();
		terminal.sendInput("\x1bo");
		await terminal.waitForRender();
		expect(tui.getFocusedComponent()).toBe(editor);
		terminal.sendInput("\x1bz");
		await terminal.waitForRender();
		expect(tui.getFocusedComponent()).not.toBe(editor);
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(tui.getFocusedComponent()).toBe(editor);
		expect(editor.focused).toBe(true);
		expect(editor.getText()).toBe(draft);
		expect(first.render(80).length).toBeGreaterThan(1);
		expect(second.render(80)).toHaveLength(1);
		expect(host.toolOutputExpanded).toBe(false);
		terminal.sendInput("\x1bz");
		await terminal.waitForRender();
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(tui.getFocusedComponent()).toBe(editor);
		expect(editor.getText()).toBe(draft);
		terminal.sendInput("\x1bz");
		await terminal.waitForRender();
		chat.removeChild(first);
		editor.setText("new root draft\n ");
		const toggle = vi.spyOn(first, "handleOverviewClick");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(toggle).not.toHaveBeenCalled();
		expect(tui.getFocusedComponent()).toBe(editor);
		expect(editor.focused).toBe(true);
		expect(editor.getText()).toBe("new root draft\n ");
		expect(editor.actionHandlers.has("app.tasks.insertPath")).toBe(false);
		expect(editor.actionHandlers.has("app.tasks.latest")).toBe(false);
		terminal.sendInput("y");
		expect(editor.getText()).toContain("y");
	} finally {
		tui.stop();
	}
});

test.each(["compaction", "tool"])("selector toggles an individual %s block in both directions", (kind) => {
	const tui = new TuiAltScreen(new VirtualTerminal(80, 24));
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const editor = new CustomEditor(tui, getEditorTheme(), keys);
	editor.setText(" retained draft ");
	const block =
		kind === "compaction"
			? new CompactionSummaryMessageComponent({
					role: "compactionSummary",
					summary: "checkpoint details",
					tokensBefore: 100,
					timestamp: 0,
				})
			: new GrokToolExecutionComponent("unknown", "call", {}, {}, undefined, tui, "/tmp");
	if (block instanceof GrokToolExecutionComponent)
		block.updateResult({ content: [{ type: "text", text: "tool details" }], isError: false });
	const chat = new TurnTranscriptContainer();
	chat.addChild(block);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const host = Object.assign(Object.create(InteractiveMode.prototype) as SelectorHost, {
		renderer: { mode: "fullscreen" },
		ui: tui,
		editor,
		editorContainer,
		chatContainer: chat,
		toolOutputExpanded: false,
		transcriptContentWidth: () => 80,
		computeChatChildOffsets: () => [],
	});
	const collapsedHeight = block.render(80).length;
	host.showTranscriptToggleSelector();
	if (block instanceof GrokToolExecutionComponent) {
		expect(block.isExpanded()).toBe(false);
		expect(editorContainer.render(80).join("\n")).toContain("Tool · collapsed");
	}
	tui.getFocusedComponent()?.handleInput?.("\r");
	expect(block.render(80).length).toBeGreaterThan(collapsedHeight);
	expect(editor.getText()).toBe(" retained draft ");
	host.showTranscriptToggleSelector();
	if (block instanceof GrokToolExecutionComponent) {
		expect(block.isExpanded()).toBe(true);
		expect(editorContainer.render(80).join("\n")).toContain("Tool · expanded");
	}
	tui.getFocusedComponent()?.handleInput?.("\r");
	expect(block.render(80)).toHaveLength(collapsedHeight);
	expect(host.toolOutputExpanded).toBe(false);
});
