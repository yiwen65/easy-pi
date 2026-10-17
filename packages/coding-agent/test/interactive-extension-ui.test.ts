import {
	type Component,
	Container,
	type OverlayHandle,
	setKeybindings,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent, ExtensionBindings } from "../src/core/agent-session.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionContext, ExtensionRuntime, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

type ModeMethods = {
	createExtensionUIContext(): ExtensionUIContext;
	bindCurrentSessionExtensions(): Promise<void>;
	setupExtensionShortcuts(runner: ExtensionRunner): void;
	resetExtensionUI(): void;
	showTreeSelector(initialSelectedId?: string): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	showSelector(create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void }): void;
};

function fixture() {
	const terminal = new VirtualTerminal(80, 24);
	const ui = new TuiMainScreen(terminal);
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
	editor.setText("draft sentinel");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	ui.setFocus(editor);
	const sessionManager = SessionManager.inMemory("/tmp/interactive-extension-ui");
	// Only UI/context dispatch is exercised; model access and core actions are unused.
	const runner = new ExtensionRunner(
		[],
		{} as ExtensionRuntime,
		sessionManager.getCwd(),
		sessionManager,
		{} as ModelRegistry,
	);
	const session = {
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		extensionRunner: runner,
		isIdle: true,
		agent: {},
		resourceLoader: { getThemes: () => ({ themes: [] }) },
		bindExtensions: async (bindings: ExtensionBindings) => {
			runner.setUIContext(bindings.uiContext, "tui");
			Reflect.set(runner, "shutdownHandler", bindings.shutdownHandler);
		},
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as ModeMethods, {
		runtimeHost: { session },
		ui,
		keybindings,
		editor,
		defaultEditor: editor,
		editorContainer,
		editorGeneration: 0,
		selectorGeneration: 0,
		extensionCustomDisposers: new Set<() => void>(),
		extensionTerminalInputSubscriptions: new Set(),
		footer: { invalidate: vi.fn() },
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		setExtensionFooter: vi.fn(),
		setExtensionHeader: vi.fn(),
		clearExtensionWidgets: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		updateTerminalTitle: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		showLoadedResources: vi.fn(),
		showStartupNoticesIfNeeded: vi.fn(),
		showError: vi.fn(),
		shutdown: vi.fn(async () => {}),
		isInitialized: true,
		pendingTools: new Map(),
		clearStatusIndicator: vi.fn(),
		completeTurnGroups: vi.fn(),
		finishGrokTurnTiming: vi.fn(),
	});
	return { mode, ui, editor, runner, session, extensionUI: mode.createExtensionUIContext() };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

function disposable(label: string) {
	return { render: () => [label], invalidate: vi.fn(), dispose: vi.fn() };
}

beforeEach(() => initTheme("dark"));
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	setKeybindings(new KeybindingsManager());
});

describe("extension shortcut isolation", () => {
	it.each(["synchronous throw", "asynchronous rejection"])(
		"reports one %s and keeps accepting input",
		async (failure) => {
			const { mode, editor, runner } = fixture();
			const handler = vi.fn((_ctx: ExtensionContext) => {
				if (failure === "synchronous throw") throw new Error("shortcut failed");
				return Promise.reject(new Error("shortcut failed"));
			});
			vi.spyOn(runner, "getShortcuts").mockReturnValue(
				new Map([["alt+p", { shortcut: "alt+p", extensionPath: "test-extension", handler }]]),
			);
			mode.setupExtensionShortcuts(runner);

			expect(() => editor.handleInput("\x1bp")).not.toThrow();
			await flushPromises();
			expect(mode.showError).toHaveBeenCalledExactlyOnceWith("Shortcut handler error: shortcut failed");
			editor.handleInput(" continued");
			expect(editor.getText()).toBe("draft sentinel continued");
			expect(handler).toHaveBeenCalledOnce();
		},
	);

	it.each([true, false])("uses bound shutdown when isIdle=%s", async (idle) => {
		const { mode, editor, runner, session } = fixture();
		session.isIdle = idle;
		vi.spyOn(runner, "getShortcuts").mockReturnValue(
			new Map([["alt+p", { shortcut: "alt+p", extensionPath: "test-extension", handler: (ctx) => ctx.shutdown() }]]),
		);
		await mode.bindCurrentSessionExtensions();
		editor.handleInput("\x1bp");
		await flushPromises();
		expect(mode.shutdown).toHaveBeenCalledTimes(idle ? 1 : 0);
		if (!idle) {
			session.isIdle = true;
			await mode.handleEvent({ type: "agent_settled" });
			expect(mode.shutdown).toHaveBeenCalledOnce();
		}
	});
});

type DialogKind = "select" | "input" | "editor";
const dialogKinds: DialogKind[] = ["select", "input", "editor"];
function openDialog(
	ui: ExtensionUIContext,
	kind: DialogKind,
	title: string,
	opts?: { signal?: AbortSignal; timeout?: number },
) {
	if (kind === "select") return ui.select(title, ["choice"], opts);
	if (kind === "input") return ui.input(title, undefined, opts);
	return ui.editor(title, "prefill");
}

describe("extension editor-slot dialog ownership", () => {
	it.each(dialogKinds.flatMap((a) => dialogKinds.map((b) => [a, b] as const)))(
		"settles displaced %s before showing %s; stale callbacks cannot hide it",
		async (first, second) => {
			const { mode, ui, editor, extensionUI } = fixture();
			const a = openDialog(extensionUI, first, "A");
			const aResolved = vi.fn();
			void a.then(aResolved);
			const oldComponent = ui.getFocusedComponent();
			const b = openDialog(extensionUI, second, "B");
			const currentComponent = ui.getFocusedComponent();
			await flushPromises();
			expect(aResolved).toHaveBeenCalledExactlyOnceWith(undefined);
			oldComponent?.handleInput?.("\x1b");
			expect(ui.getFocusedComponent()).toBe(currentComponent);
			expect(mode.editorContainer.children).toEqual([currentComponent]);
			currentComponent?.handleInput?.("\r");
			await expect(b).resolves.toBe(second === "select" ? "choice" : second === "editor" ? "prefill" : "");
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(editor.getText()).toBe("draft sentinel");
			expect(aResolved).toHaveBeenCalledOnce();
		},
	);

	it.each(["select", "input"] as const)(
		"removes displaced %s abort/timeout callbacks without cancelling the next dialog",
		async (kind) => {
			vi.useFakeTimers();
			const { ui, extensionUI } = fixture();
			const controller = new AbortController();
			const removeListener = vi.spyOn(controller.signal, "removeEventListener");
			const aResolved = vi.fn();
			void openDialog(extensionUI, kind, "A", { signal: controller.signal, timeout: 1000 }).then(aResolved);
			const oldComponent = ui.getFocusedComponent();
			const dispose = vi.spyOn(oldComponent as Component & { dispose(): void }, "dispose");
			const b = extensionUI.input("B", undefined, { timeout: 5000 });
			const bComponent = ui.getFocusedComponent();
			controller.abort();
			vi.advanceTimersByTime(1000);
			await flushPromises();
			expect(aResolved).toHaveBeenCalledExactlyOnceWith(undefined);
			expect(removeListener).toHaveBeenCalledOnce();
			expect(dispose).toHaveBeenCalledOnce();
			expect(ui.getFocusedComponent()).toBe(bComponent);
			expect(vi.getTimerCount()).toBe(1);
			bComponent?.handleInput?.("ok");
			bComponent?.handleInput?.("\r");
			await expect(b).resolves.toBe("ok");
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(dialogKinds)("reset settles %s once and releases the editor", async (kind) => {
		vi.useFakeTimers();
		const { mode, ui, editor, extensionUI } = fixture();
		const resolved = vi.fn();
		void openDialog(extensionUI, kind, "pending", { timeout: 1000 }).then(resolved);
		const oldComponent = ui.getFocusedComponent();
		mode.resetExtensionUI();
		oldComponent?.handleInput?.("\r");
		vi.advanceTimersByTime(2000);
		await flushPromises();
		expect(resolved).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(ui.getFocusedComponent()).toBe(editor);
		expect(mode.editorContainer.children).toEqual([editor]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("transfers dialog focus without letting an existing overlay reclaim it", async () => {
		const { mode, ui, extensionUI } = fixture();
		let close!: (value: undefined) => void;
		const overlay = extensionUI.custom<undefined>(
			(_tui, _theme, _keys, done) => {
				close = done;
				return disposable("overlay");
			},
			{ overlay: true },
		);
		await flushPromises();
		const a = extensionUI.input("A");
		const b = extensionUI.select("B", ["choice"]);
		expect(ui.getFocusedComponent() === mode.editorContainer.children[0]).toBe(true);
		ui.getFocusedComponent()?.handleInput?.("\r");
		await expect(a).resolves.toBeUndefined();
		await expect(b).resolves.toBe("choice");
		close(undefined);
		await overlay;
	});

	it("an already-aborted request leaves the current dialog untouched", async () => {
		const { ui, extensionUI } = fixture();
		const a = extensionUI.select("A", ["choice"]);
		const component = ui.getFocusedComponent();
		await expect(extensionUI.input("B", undefined, { signal: AbortSignal.abort() })).resolves.toBeUndefined();
		expect(ui.getFocusedComponent()).toBe(component);
		component?.handleInput?.("\r");
		await expect(a).resolves.toBe("choice");
	});

	it.each(["select", "input"] as const)("timeout and abort settle active %s with cancellation", async (kind) => {
		vi.useFakeTimers();
		const { ui, editor, extensionUI } = fixture();
		const timed = openDialog(extensionUI, kind, "timed", { timeout: 1000 });
		vi.advanceTimersByTime(1000);
		await expect(timed).resolves.toBeUndefined();
		const controller = new AbortController();
		const aborted = openDialog(extensionUI, kind, "aborted", { signal: controller.signal });
		controller.abort();
		await expect(aborted).resolves.toBeUndefined();
		expect(ui.getFocusedComponent()).toBe(editor);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["built-in selector", "custom editor"])("cancels a dialog when replaced by a %s", async (replacement) => {
		const { mode, ui, extensionUI } = fixture();
		const resolved = vi.fn();
		const controller = new AbortController();
		void extensionUI.select("A", ["choice"], { signal: controller.signal }).then(resolved);
		if (replacement === "built-in selector") {
			mode.showSelector(() => {
				const component = new Text("built in");
				return { component, focus: component };
			});
		} else {
			extensionUI.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
		}
		const current = ui.getFocusedComponent();
		controller.abort();
		await flushPromises();
		expect(resolved).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(ui.getFocusedComponent()).toBe(current);
	});
});

async function treeDialogFixture(stage: "summary" | "custom instructions") {
	const fixtureState = fixture();
	const { mode, ui, session } = fixtureState;
	const targetId = session.sessionManager.appendMessage({ role: "user", content: "first request", timestamp: 1 });
	session.sessionManager.appendMessage({ role: "user", content: "later request", timestamp: 2 });
	const treeSession = Object.assign(session, {
		isStreaming: true,
		abort: vi.fn(async () => {}),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
	});
	treeSession.abort.mockImplementation(async () => {
		treeSession.isStreaming = false;
	});
	const treeMode = Object.assign(mode, {
		chatContainer: new Container(),
		showStatus: vi.fn(),
		showStatusIndicator: vi.fn((indicator: { dispose(): void }) => indicator.dispose()),
		restoreQueuedMessagesToEditor: vi.fn(),
		clearChatContainer: vi.fn(),
		renderInitialMessages: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
	});
	mode.showTreeSelector(targetId);
	expect(ui.getFocusedComponent()).toBeInstanceOf(TreeSelectorComponent);
	ui.getFocusedComponent()?.handleInput?.("\r");
	await flushPromises();
	expect(ui.getFocusedComponent()).toBeInstanceOf(ExtensionSelectorComponent);
	if (stage === "custom instructions") {
		ui.getFocusedComponent()?.handleInput?.("\x1b[B");
		ui.getFocusedComponent()?.handleInput?.("\x1b[B");
		ui.getFocusedComponent()?.handleInput?.("\r");
		await flushPromises();
		expect(ui.getFocusedComponent()).toBeInstanceOf(ExtensionEditorComponent);
	}
	return { ...fixtureState, mode: treeMode, session: treeSession, targetId };
}

describe("tree workflow dialog ownership", () => {
	it.each(
		(["summary", "custom instructions"] as const).flatMap((stage) =>
			(["replace", "reset"] as const).flatMap((action) =>
				(["pending", "escape before continuation", "submit before continuation"] as const).map((timing) => ({
					stage,
					action,
					timing,
				})),
			),
		),
	)("abandons $stage after $action ($timing)", async ({ stage, action, timing }) => {
		const { mode, ui, editor, extensionUI, session } = await treeDialogFixture(stage);
		const oldComponent = ui.getFocusedComponent();
		if (timing === "escape before continuation") oldComponent?.handleInput?.("\x1b");
		if (timing === "submit before continuation") oldComponent?.handleInput?.("\r");
		const replacementSettled = vi.fn();
		const replacement = action === "replace" ? extensionUI.input("newer input") : undefined;
		void replacement?.then(replacementSettled);
		if (action === "reset") mode.resetExtensionUI();
		const current = ui.getFocusedComponent();
		await flushPromises();

		expect(ui.getFocusedComponent() === current).toBe(true);
		expect(mode.editorContainer.children[0] === current).toBe(true);
		expect(replacementSettled).not.toHaveBeenCalled();
		expect(session.abort).not.toHaveBeenCalled();
		expect(session.navigateTree).not.toHaveBeenCalled();
		oldComponent?.handleInput?.("\x1b");
		oldComponent?.handleInput?.("\r");
		await flushPromises();
		expect(ui.getFocusedComponent() === current).toBe(true);
		if (action === "replace") {
			current?.handleInput?.("replacement answer");
			current?.handleInput?.("\r");
			await expect(replacement).resolves.toBe("replacement answer");
		}
		expect(ui.getFocusedComponent()).toBe(editor);
		expect(editor.getText()).toBe("draft sentinel");
	});

	it.each(["summary", "custom instructions"] as const)(
		"does not revive %s after its replacement already finished",
		async (stage) => {
			const { ui, editor, extensionUI, session } = await treeDialogFixture(stage);
			const replacement = extensionUI.input("newer input");
			ui.getFocusedComponent()?.handleInput?.("\r");
			await expect(replacement).resolves.toBe("");
			await flushPromises();
			expect(ui.getFocusedComponent() === editor).toBe(true);
			expect(session.navigateTree).not.toHaveBeenCalled();
		},
	);

	it.each(["summary", "custom instructions"] as const)("keeps user Escape navigation from %s", async (stage) => {
		const { ui, editor, session } = await treeDialogFixture(stage);
		ui.getFocusedComponent()?.handleInput?.("\x1b");
		await flushPromises();
		if (stage === "custom instructions") {
			expect(ui.getFocusedComponent()).toBeInstanceOf(ExtensionSelectorComponent);
			ui.getFocusedComponent()?.handleInput?.("\x1b");
			await flushPromises();
		}
		expect(ui.getFocusedComponent()).toBeInstanceOf(TreeSelectorComponent);
		ui.getFocusedComponent()?.handleInput?.("\x1b");
		expect(ui.getFocusedComponent()).toBe(editor);
		expect(session.abort).not.toHaveBeenCalled();
		expect(session.navigateTree).not.toHaveBeenCalled();
	});

	it("still aborts streaming and navigates after an owned no-summary choice", async () => {
		const { mode, ui, session, targetId } = await treeDialogFixture("summary");
		ui.getFocusedComponent()?.handleInput?.("\r");
		await flushPromises();
		expect(mode.restoreQueuedMessagesToEditor).toHaveBeenCalledOnce();
		expect(session.abort).toHaveBeenCalledOnce();
		expect(session.navigateTree).toHaveBeenCalledExactlyOnceWith(targetId, {
			summarize: false,
			customInstructions: undefined,
		});
		expect(mode.showStatus).toHaveBeenCalledWith("Navigated to selected point");
	});
});

describe("custom extension UI ownership", () => {
	it("closes overlays non-LIFO with instance handles and exactly-once disposal", async () => {
		const { ui, editor, extensionUI } = fixture();
		const a = disposable("A");
		const b = disposable("B");
		let closeA!: (value: string) => void;
		let closeB!: (value: string) => void;
		let handleA!: OverlayHandle;
		const aResult = extensionUI.custom<string>(
			(_tui, _theme, _keys, done) => {
				closeA = done;
				return a;
			},
			{
				overlay: true,
				onHandle: (handle) => {
					handleA = handle;
				},
			},
		);
		await flushPromises();
		const bResult = extensionUI.custom<string>(
			(_tui, _theme, _keys, done) => {
				closeB = done;
				return b;
			},
			{ overlay: true },
		);
		await flushPromises();
		closeA("a-result");
		closeA("duplicate");
		await expect(aResult).resolves.toBe("a-result");
		expect(ui.getFocusedComponent()).toBe(b);
		handleA.focus();
		expect(ui.getFocusedComponent()).toBe(b);
		expect(a.dispose).toHaveBeenCalledOnce();
		expect(b.dispose).not.toHaveBeenCalled();
		closeB("b-result");
		await expect(bResult).resolves.toBe("b-result");
		expect(b.dispose).toHaveBeenCalledOnce();
		expect(ui.hasOverlay()).toBe(false);
		expect(ui.getFocusedComponent()).toBe(editor);
	});

	it("reset closes all owned overlays, including hidden ones, but not unrelated overlays", async () => {
		const { mode, ui, extensionUI } = fixture();
		const a = disposable("A");
		const b = disposable("B");
		const aResolved = vi.fn();
		const bResolved = vi.fn();
		void extensionUI.custom(() => a, { overlay: true, onHandle: (handle) => handle.setHidden(true) }).then(aResolved);
		void extensionUI.custom(() => b, { overlay: true }).then(bResolved);
		await flushPromises();
		const foreign = disposable("foreign");
		const foreignHandle = ui.showOverlay(foreign);
		mode.resetExtensionUI();
		await flushPromises();
		expect(aResolved).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(bResolved).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(a.dispose).toHaveBeenCalledOnce();
		expect(b.dispose).toHaveBeenCalledOnce();
		expect(foreign.dispose).not.toHaveBeenCalled();
		foreignHandle.focus();
		expect(ui.getFocusedComponent()).toBe(foreign);
		foreignHandle.hide();
		expect(ui.hasOverlay()).toBe(false);
	});

	it.each(["done", "reset"])(
		"disposes a late factory result after early %s without touching another overlay",
		async (action) => {
			const { mode, ui, extensionUI } = fixture();
			const pending = deferred<ReturnType<typeof disposable>>();
			let close!: (value: string) => void;
			const resolved = vi.fn();
			void extensionUI
				.custom<string>(
					(_tui, _theme, _keys, done) => {
						close = done;
						return pending.promise;
					},
					{ overlay: true },
				)
				.then(resolved);
			await flushPromises();
			const foreign = disposable("foreign");
			const foreignHandle = ui.showOverlay(foreign);
			if (action === "done") close("early");
			else mode.resetExtensionUI();
			await flushPromises();
			expect(resolved).toHaveBeenCalledExactlyOnceWith(action === "done" ? "early" : undefined);
			const late = disposable("late");
			pending.resolve(late);
			await flushPromises();
			close("duplicate");
			expect(late.dispose).toHaveBeenCalledOnce();
			foreignHandle.focus();
			expect(ui.getFocusedComponent()).toBe(foreign);
			foreignHandle.hide();
			expect(ui.hasOverlay()).toBe(false);
		},
	);

	it("does not mount an overlay closed by its options callback", async () => {
		const { ui, extensionUI } = fixture();
		const component = disposable("closed");
		let close!: (value: string) => void;
		const result = extensionUI.custom<string>(
			(_tui, _theme, _keys, done) => {
				close = done;
				return component;
			},
			{
				overlay: true,
				overlayOptions: () => {
					close("closed");
					return {};
				},
			},
		);
		await expect(result).resolves.toBe("closed");
		expect(component.dispose).toHaveBeenCalledOnce();
		expect(ui.hasOverlay()).toBe(false);
	});

	it("disposes a synchronous factory result after done before returning", async () => {
		const { ui, extensionUI } = fixture();
		const foreign = disposable("foreign");
		const handle = ui.showOverlay(foreign);
		const component = disposable("never mounted");
		const result = extensionUI.custom<string>(
			(_tui, _theme, _keys, done) => {
				done("early");
				return component;
			},
			{ overlay: true },
		);
		await expect(result).resolves.toBe("early");
		await flushPromises();
		expect(component.dispose).toHaveBeenCalledOnce();
		expect(ui.getFocusedComponent() === foreign).toBe(true);
		handle.hide();
		expect(ui.hasOverlay()).toBe(false);
	});

	it("cancels a mounted non-overlay custom UI without restoring its draft over its replacement", async () => {
		const { ui, editor, extensionUI } = fixture();
		const component = disposable("A");
		const resolved = vi.fn();
		let close!: (value: string) => void;
		void extensionUI
			.custom<string>((_tui, _theme, _keys, done) => {
				close = done;
				return component;
			})
			.then(resolved);
		await flushPromises();
		extensionUI.setEditorText("newer draft");
		const currentResult = extensionUI.editor("B", "answer");
		const current = ui.getFocusedComponent();
		await flushPromises();
		expect(resolved).toHaveBeenCalledExactlyOnceWith(undefined);
		close("stale");
		expect(ui.getFocusedComponent() === current).toBe(true);
		expect(component.dispose).toHaveBeenCalledOnce();
		current?.handleInput?.("\r");
		await expect(currentResult).resolves.toBe("answer");
		expect(editor.getText()).toBe("newer draft");
	});

	it("cleans up a mounted overlay when onHandle throws", async () => {
		const { ui, extensionUI } = fixture();
		const component = disposable("failed");
		await expect(
			extensionUI.custom(() => component, {
				overlay: true,
				onHandle: () => {
					throw new Error("onHandle failed");
				},
			}),
		).rejects.toThrow("onHandle failed");
		expect(component.dispose).toHaveBeenCalledOnce();
		expect(ui.hasOverlay()).toBe(false);
	});

	it("a late non-overlay factory cannot replace a newer dialog", async () => {
		const { mode, ui, extensionUI } = fixture();
		const pending = deferred<ReturnType<typeof disposable>>();
		const resolved = vi.fn();
		void extensionUI.custom(() => pending.promise).then(resolved);
		const currentResult = extensionUI.input("newer");
		const current = ui.getFocusedComponent();
		pending.resolve(disposable("old"));
		await flushPromises();
		expect(resolved).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(ui.getFocusedComponent()).toBe(current);
		expect(mode.editorContainer.children).toEqual([current]);
		current?.handleInput?.("ok");
		current?.handleInput?.("\r");
		await expect(currentResult).resolves.toBe("ok");
	});

	it.each(["synchronous", "asynchronous"])(
		"a %s factory failure leaves the draft and other overlays intact",
		async (failure) => {
			const { mode, ui, editor, extensionUI } = fixture();
			const foreign = disposable("foreign");
			const handle = ui.showOverlay(foreign);
			const result = extensionUI.custom(() => {
				if (failure === "synchronous") throw new Error("factory failed");
				return Promise.reject(new Error("factory failed"));
			});
			await expect(result).rejects.toThrow("factory failed");
			expect(mode.editorContainer.children).toEqual([editor]);
			expect(editor.getText()).toBe("draft sentinel");
			handle.focus();
			expect(ui.getFocusedComponent()).toBe(foreign);
			handle.hide();
		},
	);
});
