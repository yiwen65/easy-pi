import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { type Component, type OverlayHandle, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { CHILD_HARNESS_CONTEXT_ENV } from "@easy-pi/permissions";
import { afterEach, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBuiltInExtensions } from "../src/extensions/index.ts";
import type { AgentListRow, PiCollaborationMonitor } from "../src/extensions/pi-collaboration-monitor.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { GrokAgentsPanel } from "../src/modes/interactive-grok/components/grok-agents-panel.ts";
import { currentCollaborationPath, followupArgs, spawnArgs } from "./collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const tool = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function fixture() {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-grok-agents-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "grok-agents-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let session: AgentSession;
	let panel: (Component & { dispose?(): void }) | undefined;
	const renders: string[] = [];
	const notices: string[] = [];
	initTheme("dark");
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
		if (panel) renders.push(panel.render(100).join("\n"));
	});
	const open = async (manager: SessionManager) => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			extensionFactories: createBuiltInExtensions(agentDir),
		});
		await loader.reload();
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			thinkingLevel: "off",
			settingsManager,
			sessionManager: manager,
			resourceLoader: loader,
		}));
		const ui: ExtensionUIContext = {
			...session.extensionRunner.getUIContext(),
			notify: (message) => notices.push(message),
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
		await session.bindExtensions({ mode: "tui", uiContext: ui });
	};
	await open(SessionManager.create(cwd, join(cwd, "root")));
	const shutdown = async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	};
	cleanups.push(shutdown);
	return {
		cwd,
		faux,
		renders,
		notices,
		keys,
		terminalKey: (key: string) => terminal.sendInput(key),
		capture: async () => {
			tui.renderNow();
			return (await terminal.flushAndGetViewport()).join("\n");
		},
		get session() {
			return session;
		},
		get panel() {
			return panel!;
		},
		text: () => panel!.render(100).join("\n"),
		key: (key: string) => panel!.handleInput!(key),
		show: async () => {
			const command = session.prompt("/agents");
			await vi.waitFor(() => expect(panel).toBeDefined());
			return { command };
		},
		restart: async (beforeOpen?: () => Promise<void>) => {
			const file = session.sessionFile!;
			await shutdown();
			await beforeOpen?.();
			await open(SessionManager.open(file));
		},
	};
}

function holdChild(f: Awaited<ReturnType<typeof fixture>>) {
	let rootTurns = 0;
	let childTurns = 0;
	let release!: (message: AssistantMessage) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	f.faux.setResponses(
		Array.from({ length: 20 }, () => (context: Context, options) => {
			if (currentCollaborationPath(context) !== "/root/worker") {
				return rootTurns++ === 0
					? tool("spawn_agent", spawnArgs("worker", "inspect"))
					: fauxAssistantMessage("root idle");
			}
			childTurns++;
			return new Promise<AssistantMessage>((resolve) => {
				release = resolve;
				const abort = () => resolve(fauxAssistantMessage("stopped", { stopReason: "aborted" }));
				if (options?.signal?.aborted) abort();
				else options?.signal?.addEventListener("abort", abort, { once: true });
				started();
			});
		}),
	);
	return {
		ready,
		release: (message: AssistantMessage) => release(message),
		get childTurns() {
			return childTurns;
		},
		get rootTurns() {
			return rootTurns;
		},
	};
}

test("long agents list keeps the selection, draft and action notice visible through resize and watch", async () => {
	initTheme("dark");
	const rows: AgentListRow[] = [
		{ task_name: "/root", status: "idle", state: "idle", loaded: true, model: "root" },
		...Array.from({ length: 15 }, (_, index) => ({
			task_name: `/root/worker${index + 1}`,
			status: "idle",
			state: "idle" as const,
			loaded: true,
			model: "faux",
			objective: `unique objective ${index + 1}`,
		})),
	];
	const monitor = {
		isClosed: false,
		list: () => rows,
		subscribe: () => () => {},
		view: (path: string) => ({
			path,
			status: "idle",
			state: "idle" as const,
			loaded: true,
			model: "faux",
			text: "child history",
		}),
		readHistory: async () => {},
		act: async () => {
			throw new Error("simulated rejection");
		},
	} as unknown as PiCollaborationMonitor;
	let height = 24;
	const keys = new KeybindingsManager();
	const panel = new GrokAgentsPanel({
		monitor,
		theme,
		keybindings: keys,
		height: () => height,
		requestRender: () => {},
		done: () => {},
	});
	panel.focused = true;
	const screen = (width = 100) => stripVTControlCharacters(panel.render(width).join("\n"));
	try {
		for (let index = 0; index < 15; index++) panel.handleInput("\x1b[B");
		expect(screen()).toContain("› ○ /root/worker15");
		expect(screen()).toContain("unique objective 15");
		panel.handleInput("\x13");
		panel.handleInput("draft for worker15");
		expect(screen()).toContain("draft for worker15");
		expect(screen()).toContain("Message → /root/worker15");
		panel.handleInput("\r");
		await vi.waitFor(() => expect(screen()).toContain("Action rejected:"));
		expect(screen()).toContain("draft for worker15");
		expect(screen()).toContain("› ○ /root/worker15");
		height = 16;
		expect(screen()).toContain("Action rejected:");
		expect(screen()).toContain("draft for worker15");
		expect(screen()).toContain("› ○ /root/worker15");
		expect(panel.render(40)).toHaveLength(16);
		expect(panel.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(screen(40)).toContain("› ○ /root/worker15");
		expect(screen(40)).toContain("draft for worker15");
		expect(screen(40)).toContain("Action rejected:");
		// Input is single-line even when a long, multiline draft is pasted; it scrolls horizontally.
		panel.handleInput(`\x1b[200~${"x".repeat(140)}\nTAIL-DRAFT\x1b[201~`);
		height = 9;
		expect(screen()).toContain("› ○ /root/worker15");
		expect(screen()).toContain("TAIL-DRAFT");
		expect(screen()).toContain("Action rejected:");
		height = 6;
		expect(screen()).toContain("› ○ /root/worker15");
		expect(screen()).toContain("TAIL-DRAFT");
		expect(screen()).toContain("Action rejected:");
		height = 16;
		panel.handleInput("\x1b"); // cancel composition, then inspect the selected child
		panel.handleInput("\r");
		expect(screen()).toContain("child history");
		panel.handleInput("\x1b");
		expect(screen()).toContain("› ○ /root/worker15");
		for (let index = 0; index < 15; index++) panel.handleInput("\x1b[A");
		expect(screen()).toContain("› ○ /root");
		expect(panel.focused).toBe(true);
	} finally {
		panel.dispose();
	}
});

test("agent durations share readable units for activity and age", () => {
	initTheme("dark");
	const clock = vi.spyOn(Date, "now").mockReturnValue(65_000);
	const row: AgentListRow = {
		task_name: "/root/worker",
		status: "running",
		state: "running",
		loaded: true,
		model: "faux",
		lastActivityAt: 0,
	};
	const monitor = { list: () => [row], subscribe: () => () => {} } as unknown as PiCollaborationMonitor;
	const panel = new GrokAgentsPanel({
		monitor,
		theme,
		keybindings: new KeybindingsManager(),
		height: () => 10,
		requestRender: () => {},
		done: () => {},
	});
	try {
		expect(stripVTControlCharacters(panel.render(100).join("\n"))).toContain("1m 5s active");
		row.state = "failed";
		expect(stripVTControlCharacters(panel.render(100).join("\n"))).toContain("1m 5s ago");
		clock.mockReturnValue(800);
		expect(stripVTControlCharacters(panel.render(100).join("\n"))).toContain("0.8s ago");
	} finally {
		panel.dispose();
		clock.mockRestore();
	}
});

test("completed agent lifecycle does not imply a successful task outcome", () => {
	initTheme("dark");
	const rows: AgentListRow[] = [
		{ task_name: "/root", status: "idle", state: "idle", loaded: true, model: "root" },
		{
			task_name: "/root/worker",
			status: "completed",
			state: "completed",
			loaded: false,
			model: "faux",
			resultSummary: "outcome: failed",
		},
	];
	const monitor = {
		list: () => rows,
		subscribe: () => () => {},
		readHistory: async () => {},
		view: () => ({
			path: "/root/worker",
			status: "completed",
			state: "completed",
			loaded: false,
			model: "faux",
			text: "outcome: failed",
		}),
	} as unknown as PiCollaborationMonitor;
	const panel = new GrokAgentsPanel({
		monitor,
		theme,
		keybindings: new KeybindingsManager(),
		height: () => 24,
		requestRender: () => {},
		done: () => {},
	});
	try {
		for (const inspect of [false, true]) {
			if (inspect) {
				panel.handleInput("\x1b[B");
				panel.handleInput("\r");
			}
			const text = stripVTControlCharacters(panel.render(100).join("\n"));
			expect(text).toContain("Completed");
			expect(text).toContain("outcome: failed");
			expect(text).not.toMatch(/\bDone\b|\bSucceeded\b/);
		}
	} finally {
		panel.dispose();
	}
});

test("default Grok command observes live native child; message/busy/interrupt target only the selection", async () => {
	const f = await fixture();
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;
	const rootMessages = JSON.stringify(f.session.messages);
	const { command } = await f.show();
	expect(f.text()).toContain("/root/worker");
	expect(await f.capture()).toContain("Agents — shared workspace");
	f.terminalKey("\x1b[B");
	f.key("\r");
	expect(f.text()).toContain("Running");
	expect(f.text()).toContain("grok-agents-faux");
	// Passive send does not start a second child turn or put text in root history.
	f.key("\x13");
	f.key("mail-only");
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("Message accepted"));
	expect(child.childTurns).toBe(1);
	// Busy followup is rejected, never silently queued/replayed.
	f.key("\x06");
	f.key("busy-draft");
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("Action rejected: busy"));
	expect(f.text()).toContain("busy-draft");
	f.key("\x1b");
	f.key("\x0b");
	expect(f.text()).toContain("Interrupt /root/worker?"); // consequence text added
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("Interrupt finished"));
	expect(f.text()).toContain("Interrupted");
	expect(JSON.stringify(f.session.messages)).toBe(rootMessages);
	expect(child.rootTurns).toBe(2);
	expect(await f.capture()).toContain("/root/worker");
	for (const width of [1, 12, 40, 80])
		expect(f.panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	f.key("\x1b");
	f.key("\x1b");
	await command;
});

test.each(["git", "non-git"])(
	"viewer streams native updates and preserves shared writes without replay (%s)",
	async (workspace) => {
		const f = await fixture();
		if (workspace === "git") execFileSync("git", ["init", "--quiet"], { cwd: f.cwd });
		const child = holdChild(f);
		await f.session.prompt("delegate");
		await child.ready;
		const { command } = await f.show();
		f.key("\x1b[B");
		f.key("\r");
		// Root and child use the same actual built-in write tool and working directory.
		child.release(tool("write", { path: "shared.txt", content: "shared edit" }));
		await vi.waitFor(() =>
			expect(f.renders.some((text) => text.includes("⚙ write") && text.includes("running"))).toBe(true),
		);
		await vi.waitFor(() => expect(child.childTurns).toBe(2));
		expect(await readFile(join(f.cwd, "shared.txt"), "utf8")).toBe("shared edit");
		child.release(fauxAssistantMessage("live 中文 output\u001b[?1049l safe"));
		await vi.waitFor(() => expect(f.text()).toContain("Completed"));
		expect(f.renders.some((text) => text.includes("live 中文 output"))).toBe(true);
		expect(f.text()).not.toContain("\x1b[?1049l");
		f.key("\x1b");
		f.key("\x1b");
		await command;
		await f.restart();
		const turns = child.childTurns;
		const reopened = await f.show();
		f.key("\x1b[B");
		f.key("\r");
		// loaded state is detail-view metadata: the History line reports it after inspecting.
		// The retained preview loads from disk almost immediately; assert the settled state,
		// not the transient "no preview yet" fallback.
		await vi.waitFor(() => expect(f.text()).toContain("not loaded"));
		await vi.waitFor(() => expect(f.text()).toContain("live 中文 output"));
		expect(child.childTurns).toBe(turns);
		// Explicit followup, not watching, starts inference on the same logical agent.
		f.key("\x06");
		f.key(JSON.stringify(followupArgs("/root/worker", "another task")));
		f.key("\r");
		await vi.waitFor(() => expect(f.text()).toContain("Task accepted"));
		await vi.waitFor(() => expect(child.childTurns).toBe(turns + 1));
		// Closing an active viewer must not abort its selected child.
		f.key("\x1b");
		f.key("\x1b");
		await reopened.command;
		expect(await readFile(join(f.cwd, "shared.txt"), "utf8")).toBe("shared edit");
		const active = await f.show();
		expect(f.text()).toContain("Running");
		f.key("\x1b[B");
		f.key("\r");
		f.key("\x0b");
		f.key("\r");
		await vi.waitFor(() => expect(f.text()).toContain("Interrupt finished"));
		expect(await readFile(join(f.cwd, "shared.txt"), "utf8")).toBe("shared edit");
		if (workspace === "git") {
			expect(await readdir(join(f.cwd, ".git", "refs", "heads"))).toEqual([]);
			expect(existsSync(join(f.cwd, ".git", "worktrees"))).toBe(false);
		}
		f.key("\x1b");
		f.key("\x1b");
		await active.command;
	},
);

test.each(["version", "oversized", "symlink"])(
	"cold viewer rejects unsafe history without rewriting or provider calls (%s)",
	async (damage) => {
		const f = await fixture();
		const child = holdChild(f);
		await f.session.prompt("delegate");
		await child.ready;
		child.release(fauxAssistantMessage("retained answer"));
		const showing = await f.show();
		await vi.waitFor(() => expect(f.text()).toContain("Completed"));
		f.key("\x1b");
		await showing.command;
		const team = join(f.cwd, "agent", "teams", f.session.sessionId);
		const directory = (await readdir(team, { withFileTypes: true })).find((entry) => entry.isDirectory())!;
		const childDirectory = join(team, directory.name);
		const file = join(childDirectory, (await readdir(childDirectory)).find((name) => name.endsWith(".jsonl"))!);
		let damaged = "";
		await f.restart(async () => {
			if (damage === "symlink") {
				await rename(file, `${file}.original`);
				const foreign = join(f.cwd, "foreign-history");
				damaged = "foreign sentinel";
				await writeFile(foreign, damaged);
				await symlink(foreign, file);
			} else {
				damaged =
					damage === "oversized"
						? "x".repeat(4 * 1024 * 1024 + 1)
						: (await readFile(file, "utf8")).replace('"version":3', '"version":99');
				await writeFile(file, damaged);
			}
		});
		const turns = child.childTurns;
		const reopened = await f.show();
		f.key("\x1b[B");
		f.key("\r");
		await vi.waitFor(() => expect(f.text()).toContain("Retained preview unavailable"));
		expect(await readFile(file, "utf8")).toBe(damaged);
		expect(child.childTurns).toBe(turns);
		f.key("\x1b");
		f.key("\x1b");
		await reopened.command;
	},
);

test("list rows show objectives, actions work from the list, and nothing closes the panel implicitly", async () => {
	const f = await fixture();
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;
	const { command } = await f.show();

	// header counts, objective subline, and the explicit root marker
	expect(f.text()).toContain("1 running");
	expect(f.text()).toContain("inspect");
	expect(f.text()).toContain("you are here");

	// Enter on /root must not close the panel (no implicit close)
	f.key("\r");
	await Promise.resolve();
	expect(f.panel).toBeDefined();
	expect(f.text()).toContain("Agents — shared workspace");

	// actions are available from the list on the selected child
	f.key("\x1b[B");
	f.key("\x13");
	expect(f.text()).toContain("won't start an idle agent");
	expect(f.text()).toContain("/root/worker");
	f.key("\x1b");

	// interrupt explains the consequence before confirming
	f.key("\x0b");
	expect(f.text()).toContain("Interrupt /root/worker?");
	expect(f.text()).toContain("history is kept");
	f.key("\x1b");

	// cycling with alt+arrows never closes the panel, even with a single child
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("conversation"));
	f.key("\x1b[1;3C");
	f.key("\x1b[1;3D");
	await Promise.resolve();
	expect(f.panel).toBeDefined();
	expect(f.text()).toContain("/root/worker");

	f.key("\x1b");
	f.key("\x1b");
	await command;
	child.release(fauxAssistantMessage("done"));
});

test("settled rows show the result summary and detail follows the newest activity", async () => {
	const f = await fixture();
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;
	child.release(fauxAssistantMessage(Array.from({ length: 120 }, (_, i) => `worker line ${i}`).join("\n")));
	const { command } = await f.show();
	await vi.waitFor(() => expect(f.text()).toContain("Completed"));
	// settled row carries the result first line
	expect(f.text()).toContain("worker line 0");

	f.key("\x1b[B");
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("[latest]"));
	expect(f.text()).toContain("worker line 119");

	f.key("\x1b[5~"); // page up detaches from follow mode
	await vi.waitFor(() => expect(f.text()).toMatch(/\[\d+%/));
	f.key("\x1b[F"); // End reattaches
	await vi.waitFor(() => expect(f.text()).toContain("[latest]"));

	f.key("\x1b");
	f.key("\x1b");
	await command;
});

test("child terminal toast fires when the panel is closed and stays silent while it is open", async () => {
	const f = await fixture();
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;

	// panel closed: completion raises a toast
	child.release(fauxAssistantMessage("first done"));
	await vi.waitFor(
		() =>
			expect(f.notices.some((notice) => notice.includes("/root/worker") && notice.includes("completed"))).toBe(true),
		{ timeout: 5_000 },
	);

	// panel open: the next settle stays silent
	const opened = await f.show();
	await vi.waitFor(() => expect(f.text()).toContain("Completed"));
	f.key("\x1b[B");
	f.key("\x06");
	f.key(JSON.stringify(followupArgs("/root/worker", "second task")));
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("Task accepted"));
	await vi.waitFor(() => expect(child.childTurns).toBe(2));
	child.release(fauxAssistantMessage("second done"));
	await vi.waitFor(() => expect(f.text()).toContain("Completed"));
	await new Promise((resolve) => setTimeout(resolve, 700));
	expect(f.notices.filter((notice) => notice.includes("/root/worker"))).toHaveLength(1);

	// the followup was composed from the list view, so a single Esc closes the panel
	f.key("\x1b");
	await opened.command;
});

test("/agents with a dead team owner explains the recovery path", async () => {
	const f = await fixture();
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;
	child.release(fauxAssistantMessage("done"));

	// Simulate the previous owner dying without a clean shutdown: owner row left behind.
	await f.restart(async () => {
		const registry = join(f.cwd, "agent", "teams", f.session.sessionId, "registry.sqlite");
		const db = new DatabaseSync(registry);
		db.prepare("UPDATE team SET owner=?, pid=?").run("dead-owner", 999999);
		db.close();
	});
	await f.session.prompt("/agents");
	expect(
		f.notices.some(
			(notice) => notice.includes("Native agents unavailable: interrupted") && notice.includes("/agents recover"),
		),
	).toBe(true);

	// recovery adopts the team and the panel works again
	const recovering = f.session.prompt("/agents recover");
	await vi.waitFor(() => expect(f.panel).toBeDefined());
	f.key("\x1b");
	await recovering;
});

test("a retired legacy child environment cannot silently become an unrestricted native root", async () => {
	let f: Awaited<ReturnType<typeof fixture>>;
	vi.stubEnv(CHILD_HARNESS_CONTEXT_ENV, "/nonexistent/legacy-context-not-read.json");
	try {
		f = await fixture();
	} finally {
		vi.unstubAllEnvs();
	}
	expect(f.session.getActiveToolNames()).not.toContain("spawn_agent");
	f.faux.setResponses([tool("write", { path: "legacy-must-not-write.txt", content: "blocked" })]);
	await f.session.prompt("old child task");
	expect(existsSync(join(f.cwd, "legacy-must-not-write.txt"))).toBe(false);
	expect(JSON.stringify(f.session.messages)).toContain("Legacy DAG child launch is retired");
});

test("default native children do not rediscover extensions disabled in root", async () => {
	const f = await fixture();
	const extensions = join(f.cwd, "agent", "extensions");
	await mkdir(extensions, { recursive: true });
	const marker = join(f.cwd, "unexpected-extension-load");
	await writeFile(
		join(extensions, "late.ts"),
		`import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
	);
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;
	expect(existsSync(marker)).toBe(false);
	child.release(fauxAssistantMessage("done"));
});

test("operator followup diagnostics retain the draft and show a corrective hint without another inference", async () => {
	const f = await fixture();
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;
	child.release(fauxAssistantMessage("done"));
	const { command } = await f.show();
	await vi.waitFor(() => expect(f.text()).toContain("Completed"));
	f.key("\x1b[B");
	f.key("\r");
	const calls = f.faux.state.callCount;
	f.key("\x06");
	f.key("malformed-draft");
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("invalid_followup"));
	expect(f.text()).toContain("JSON: {task, tools?}");
	expect(f.text()).toContain("malformed-draft");
	expect(f.faux.state.callCount).toBe(calls);
	for (const width of [1, 40, 80, 100])
		expect(f.panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	f.key("\x1b");
	f.key("\x1b");
	f.key("\x1b");
	await command;
});

test("root shutdown dismisses the viewer and releases callbacks; configurable panel actions are honored", async () => {
	const f = await fixture();
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;
	const { command } = await f.show();
	f.key("\x1b[B");
	f.key("\r");
	f.keys.setUserBindings({ "app.agents.message": "ctrl+m" });
	f.key("\x13");
	expect(f.text()).not.toContain("won't start an idle agent");
	f.key("\r");
	expect(f.text()).toContain("won't start an idle agent");
	await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
	await command;
	expect(f.panel).toBeUndefined();
	const renders = f.renders.length;
	await Promise.resolve();
	expect(f.renders).toHaveLength(renders);
});

test("default child tools obey live tool removal while the viewer is open", async () => {
	const f = await fixture();
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;
	const { command } = await f.show();
	f.key("\x1b[B");
	f.key("\r");
	f.session.setActiveToolsByName(f.session.getActiveToolNames().filter((name) => name !== "write"));
	child.release(tool("write", { path: "disabled.txt", content: "not allowed" }));
	await vi.waitFor(() => expect(child.childTurns).toBe(2));
	expect(existsSync(join(f.cwd, "disabled.txt"))).toBe(false);
	expect(f.renders.some((text) => text.includes("Tool denied by live delegation ancestry"))).toBe(true);
	// The operator surface does not bypass an explicitly disabled collaboration tool either.
	f.session.setActiveToolsByName(f.session.getActiveToolNames().filter((name) => name !== "send_message"));
	f.key("\x13");
	f.key("denied message");
	f.key("\r");
	await vi.waitFor(() => expect(f.text()).toContain("Action rejected: forbidden"));
	f.key("\x1b");
	f.key("\x1b");
	f.key("\x1b");
	await command;
	child.release(fauxAssistantMessage("done"));
});

test("native turn history viewing never starts provider work or consumes root mail", async () => {
	const f = await fixture();
	const child = holdChild(f);
	await f.session.prompt("delegate");
	await child.ready;
	child.release(fauxAssistantMessage(JSON.stringify({ summary: "RETAINED_NATIVE_RESULT", outcome: "blocked" })));
	const { command } = await f.show();
	await vi.waitFor(() => expect(f.text()).toContain("Completed"));
	const calls = f.faux.state.callCount;
	const messages = JSON.stringify(f.session.messages);
	f.key("\x1b[B");
	f.key("\x14");
	expect(f.text()).toContain("RETAINED_NATIVE_RESULT");
	expect(f.text()).toContain("Turns — /root/worker");
	expect(f.text()).toContain("Delivery: enqueued");
	expect(f.faux.state.callCount).toBe(calls);
	expect(child.childTurns).toBe(1);
	expect(JSON.stringify(f.session.messages)).toBe(messages);
	f.session.setActiveToolsByName(f.session.getActiveToolNames().filter((name) => name !== "get_agent_result"));
	f.key("\x1b[A");
	expect(f.text()).toContain("Retained result unavailable");
	f.key("\x1b");
	f.key("\x1b");
	f.key("\x14");
	f.session.setActiveToolsByName(f.session.getActiveToolNames().filter((name) => name !== "list_agent_turns"));
	f.key("\x1b[6~"); // exhausted membership does not fetch or retry
	expect(f.faux.state.callCount).toBe(calls);
	f.key("\x1b");
	f.key("\x1b");
	f.key("\x1b");
	await command;
});

test("configured history entry pins turn identity while paging and reserves result on short/narrow viewports", async () => {
	initTheme("dark");
	const turn = (index: number) => ({
		target: "/root/worker",
		turn_id: `turn-${index}`,
		sequence: index,
		task_message_id: `task-${index}`,
		result_message_id: `result-${index}`,
		status: "completed",
		history_coverage: "complete",
		task_preview: `task ${index}`,
		task_truncated: true,
		admitted_at: 10,
		started_at: null,
		finished_at: null,
		delivery: { state: "acknowledged", enqueued_at: null, acknowledged_at: null },
		usage: { coverage: "unknown", input: null, output: null, cacheRead: null, cacheWrite: null },
	});
	const turns = vi.fn((_path: string, cursor?: string) => ({
		target: "/root/worker",
		history_coverage: "retained_only",
		turns: cursor ? [turn(11), turn(12)] : Array.from({ length: 10 }, (_, index) => turn(index + 1)),
		next_cursor: cursor ? null : "page-2",
	}));
	const readHistory = vi.fn(async () => {});
	const rows: AgentListRow[] = [
		{ task_name: "/root", status: "idle", state: "idle", loaded: true, model: "faux" },
		{
			task_name: "/root/worker",
			status: "completed",
			state: "completed",
			loaded: false,
			model: "faux",
			resultSummary: "LATEST",
		},
	];
	const monitor = {
		list: () => rows,
		subscribe: () => () => {},
		turns,
		readHistory,
		result: (_path: string, id: string) => ({
			state: "found",
			turn: turn(Number(id.split("-")[1])),
			result: {
				preview: JSON.stringify({
					summary: [
						`SELECTED ${id}`,
						...Array.from({ length: 80 }, (_, index) => `RESULT_LINE_${index}`),
						"TAIL_RESULT",
					].join("\n"),
					outcome: "blocked",
				}),
				truncated: false,
				source: {
					kind: "native_history",
					session_path: "/fixture/long-result.jsonl",
					turn_id: id,
					entry_id: "fixture-entry",
					coverage: "entry",
				},
				artifacts: [{ path: "/fixture/report", purpose: "Full evidence", sha256: "a".repeat(64) }],
			},
		}),
		view: () => ({ path: "/root/worker", state: "completed", loaded: false, model: "faux", text: "LATEST PREVIEW" }),
	} as unknown as PiCollaborationMonitor;
	let height = 20;
	const terminal = new VirtualTerminal(80, 20);
	const tui = new TuiAltScreen(terminal);
	const keys = new KeybindingsManager({ "app.agents.turns": "ctrl+y" });
	const panel = new GrokAgentsPanel({
		monitor,
		theme,
		keybindings: keys,
		height: () => height,
		requestRender: () => tui.requestRender(),
		done: () => {},
	});
	tui.showOverlay(panel, { width: "100%", maxHeight: "100%" });
	tui.start();
	try {
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\x19");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("SELECTED turn-10");
		expect(turns).toHaveBeenCalledTimes(1);
		expect(readHistory).not.toHaveBeenCalled();
		rows[1].state = "running";
		rows[1].objective = "new followup";
		terminal.sendInput("\x1b[6~");
		await terminal.waitForRender();
		expect(turns).toHaveBeenLastCalledWith("/root/worker", "page-2");
		expect(terminal.getViewport().join("\n")).toContain("SELECTED turn-10");
		expect(terminal.getViewport().join("\n")).toContain("loaded pages only");
		terminal.sendInput("\x1b[B");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("SELECTED turn-11");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Turn detail — turn-11");
		const screens = [terminal.getViewport().join("\n")];
		for (let index = 0; index < 12; index++) {
			terminal.sendInput("\x1b[6~");
			await terminal.waitForRender();
			screens.push(terminal.getViewport().join("\n"));
		}
		expect(screens.join("\n")).toContain("/fixture/long-result.jsonl");
		expect(screens.join("\n")).toContain("hash claim:");
		expect(screens.join("\n")).toContain("TAIL_RESULT");
		expect(turns).toHaveBeenCalledTimes(2); // detail PageDown never fetches membership
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("RESULT_LINE_");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("SELECTED turn-11");
		for (const width of [1, 8, 24, 40]) {
			height = 4;
			const lines = panel.render(width);
			expect(lines).toHaveLength(4);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(stripVTControlCharacters(lines.join("\n"))).toContain("S");
		}
		height = 20;
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("LATEST PREVIEW");
		expect(turns).toHaveBeenCalledTimes(2);
	} finally {
		panel.dispose();
		tui.stop();
	}
});
