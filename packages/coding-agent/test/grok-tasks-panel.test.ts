import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type Component, type OverlayHandle, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBuiltInExtensions } from "../src/extensions/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { type GrokChromeTheme, GrokComponentFactory } from "../src/modes/interactive-grok/grok-component-factory.ts";

const identity = (text: string) => text;
const chromeTheme: GrokChromeTheme = {
	text: identity,
	accent: identity,
	muted: identity,
	dim: identity,
	border: identity,
	success: identity,
	warning: identity,
	error: identity,
	thinkingLevel: (_level, text) => text,
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(mode: "tui" | "rpc" = "tui") {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-grok-tasks-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "grok-tasks-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: createBuiltInExtensions(agentDir),
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		settingsManager,
		sessionManager: SessionManager.create(cwd, join(cwd, "root")),
		resourceLoader: loader,
	});
	let panel: (Component & { dispose?(): void }) | undefined;
	const notices: Array<{ message: string; type?: string }> = [];
	const statusCalls: Array<[string, string | undefined]> = [];
	let editorText = "";
	initTheme("dark");
	const footerData = new FooterDataProvider(cwd);
	cleanups.push(async () => footerData.dispose());
	const footer = new GrokComponentFactory(chromeTheme).createFooter(footerData);
	const terminal = new VirtualTerminal(100, 24);
	const tui = new TuiAltScreen(terminal);
	tui.addChild(new Text("root editor draft", 0, 0));
	let overlay: OverlayHandle | undefined;
	cleanups.push(async () => {
		tui.stop({ preserveScreen: true });
	});
	tui.start();
	const keys = new KeybindingsManager();
	vi.spyOn(tui, "requestRender").mockImplementation(() => {
		if (panel) panel.render(100);
	});
	const ui: ExtensionUIContext = {
		...session.extensionRunner.getUIContext(),
		notify: (message, type) => notices.push({ message, type }),
		setStatus: (key, text) => {
			statusCalls.push([key, text]);
			footerData.setExtensionStatus(key, text);
		},
		getEditorText: () => editorText,
		setEditorText: (text) => {
			editorText = text;
		},
		custom: async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
			new Promise<T>((resolve, reject) => {
				Promise.resolve(
					factory(tui, theme, keys, (value) => {
						panel?.dispose?.();
						panel = undefined;
						overlay?.hide();
						overlay = undefined;
						resolve(value as T);
					}),
				).then((value) => {
					panel = value;
					overlay = tui.showOverlay(value, { width: "100%", maxHeight: "100%" });
				}, reject);
			}),
	};
	await session.bindExtensions({ mode, uiContext: ui });
	const shutdown = async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	};
	cleanups.push(shutdown);
	return {
		cwd,
		notices,
		statusCalls,
		footer,
		terminal,
		get session() {
			return session;
		},
		get panel() {
			return panel!;
		},
		editorText: () => editorText,
		text: () => panel!.render(100).join("\n"),
		key: (key: string) => panel!.handleInput!(key),
		capture: async () => {
			tui.renderNow();
			return (await terminal.flushAndGetViewport()).join("\n");
		},
		show: async () => {
			const command = session.prompt("/tasks");
			await vi.waitFor(() => expect(panel).toBeDefined());
			return { command };
		},
	};
}

test("status bar shows the active background task count and hides at zero", async () => {
	const f = await fixture();
	// session_start cleared the indicator: no statuses -> the Grok footer renders nothing.
	expect(f.footer.render(80)).toEqual([]);
	const manager = f.session.backgroundTasks!;
	expect(manager).toBeDefined();

	const first = await manager.start("sleep 30", { cwd: f.cwd });
	expect(first.ok).toBe(true);
	const second = await manager.start("sleep 30", { cwd: f.cwd });
	expect(second.ok).toBe(true);
	await vi.waitFor(() => expect(f.footer.render(80).join("\n")).toContain("2 bg tasks"));
	expect(f.statusCalls.at(-1)).toEqual(["bg-tasks", "⚙ 2 bg tasks"]);

	await manager.stop(first.ok ? first.value.id : "");
	const firstId = first.ok ? first.value.id : "";
	await manager.wait(firstId, 10_000);
	await vi.waitFor(() => expect(f.footer.render(80).join("\n")).toContain("1 bg task"));

	const secondId = second.ok ? second.value.id : "";
	await manager.stop(secondId);
	await manager.wait(secondId, 10_000);
	await vi.waitFor(() => expect(f.footer.render(80)).toEqual([]));
	expect(f.statusCalls.at(-1)).toEqual(["bg-tasks", undefined]);
});

test("/tasks opens a read-only panel with live list, detail watch and clean close", async () => {
	const f = await fixture();
	const manager = f.session.backgroundTasks!;

	// Empty state opens the panel instead of mutating anything.
	const empty = await f.show();
	expect(f.text()).toContain("Background tasks");
	expect(f.text()).toContain("No background tasks yet");
	expect(await f.capture()).toContain("Read-only");
	f.key("\x1b");
	await empty.command;

	const running = await manager.start("sleep 30", { cwd: f.cwd });
	const runningId = running.ok ? running.value.id : "";
	const quick = await manager.start("echo t005-quick-output", { cwd: f.cwd });
	const quickId = quick.ok ? quick.value.id : "";

	const open = await f.show();
	await vi.waitFor(() => expect(f.text()).toContain("Done"));
	const list = f.text();
	expect(list).toContain(runningId);
	expect(list).toContain("Running");
	// Active tasks sort above finished ones even though the quick task started later.
	expect(list.indexOf(runningId)).toBeLessThan(list.indexOf(quickId));
	// Finished rows show the task's runtime (start -> end), not how long ago it ended.
	expect(list).not.toContain("ago");
	expect(list).toMatch(new RegExp(`${quickId}\\s+Done\\s+\\d+s`));

	// Detail view: watch the running task; panel keys never change manager state.
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("$ sleep 30"));
	expect(f.text()).toContain("Running");
	expect(f.text()).toContain("pid");
	expect(f.text()).toContain("log ");
	f.key("s");
	f.key("x");
	f.key("\x0b");
	expect(manager.get(runningId)).toMatchObject({ status: "running" });
	f.key("\x1b");
	expect(f.text()).not.toContain("$ sleep 30");

	// A task stopped outside the panel becomes visible as terminal with its outcome.
	// Terminal tasks sort newest-finished first, so the just-stopped task stays selected at row 0.
	await manager.stop(runningId);
	await manager.wait(runningId, 10_000);
	await vi.waitFor(() => expect(f.text()).toContain("Stopped"));
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("signal"));
	expect(f.text()).toContain("Stopped");

	for (const width of [1, 12, 40, 80, 100])
		expect(f.panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	f.key("\x1b");
	f.key("\x1b");
	await open.command;
});

test("terminal failures raise no transcript toast, only the unread badge; opening /tasks clears it", async () => {
	const f = await fixture();
	const manager = f.session.backgroundTasks!;

	const failed = await manager.start("exit 3", { cwd: f.cwd });
	const failedId = failed.ok ? failed.value.id : "";
	await manager.wait(failedId, 10_000);
	// terminal events never produce transcript toasts; the folding task block is the single surface
	await new Promise((resolve) => setTimeout(resolve, 700));
	expect(f.notices.filter((notice) => notice.message.includes(failedId))).toEqual([]);
	// no active tasks left, so the badge carries the unread failure on its own
	await vi.waitFor(() => expect(f.statusCalls.at(-1)).toEqual(["bg-tasks", "✗ 1 failed"]));

	const open = await f.show();
	await vi.waitFor(() => expect(f.statusCalls.at(-1)).toEqual(["bg-tasks", undefined]));
	f.key("\x1b");
	await open.command;
});

test("terminal results consumed via wait_for stay silent", async () => {
	const f = await fixture();
	const manager = f.session.backgroundTasks!;
	const started = await manager.start("exit 5", { cwd: f.cwd });
	const id = started.ok ? started.value.id : "";

	// mark the result as consumed via wait_for (the model path); getAllTools() exposes only
	// metadata, so the test marks through the session-internal notifications queue
	(
		f.session as unknown as {
			_backgroundTaskNotifications: { markConsumedByWaitFor(taskId: string): void };
		}
	)._backgroundTaskNotifications.markConsumedByWaitFor(id);
	await manager.wait(id, 10_000);

	await new Promise((resolve) => setTimeout(resolve, 700));
	expect(f.notices.filter((notice) => notice.message.includes(id))).toEqual([]);
	expect(f.statusCalls.at(-1)?.[1] ?? "").not.toContain("✗");
});

test("detail view follows newest output, detaches on page up, and y copies the log path", async () => {
	const f = await fixture();
	const manager = f.session.backgroundTasks!;
	const started = await manager.start("i=1; while [ $i -le 200 ]; do echo line-$i; i=$((i+1)); done", { cwd: f.cwd });
	const id = started.ok ? started.value.id : "";
	await manager.wait(id, 10_000);

	const open = await f.show();
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("[latest]"));

	f.key("\x1b[5~"); // page up: detach from follow mode, show a position marker
	await vi.waitFor(() => expect(f.text()).toMatch(/\[\d+%/));

	f.key("\x1b[F"); // End: back to the newest output
	await vi.waitFor(() => expect(f.text()).toContain("[latest]"));

	f.key("y"); // copy path: panel closes and the log path lands in the editor
	await open.command;
	expect(f.editorText()).toContain(manager.get(id)!.outputPath);
});

test("/tasks outside interactive mode reports JSON without opening UI", async () => {
	const f = await fixture("rpc");
	const manager = f.session.backgroundTasks!;
	const started = await manager.start("echo t005-rpc", { cwd: f.cwd });
	const id = started.ok ? started.value.id : "";
	await manager.wait(id, 10_000);
	await f.session.prompt("/tasks");
	const payload = f.notices.find((notice) => notice.message.includes(id));
	expect(payload).toBeDefined();
	const tasks = JSON.parse(payload!.message) as Array<{ id: string; status: string }>;
	expect(tasks).toEqual([expect.objectContaining({ id, status: "succeeded" })]);
});
