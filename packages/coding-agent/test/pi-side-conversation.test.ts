import type { Component, TUI } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SideConversation, SideConversationSnapshot } from "../src/core/side-conversation-types.ts";
import { bindNativeSession } from "../src/extensions/native-session-binding.ts";
import { createSideConversationExtension } from "../src/extensions/pi-side-conversation.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import type { GrokSidePanel } from "../src/modes/interactive-grok/components/grok-side-panel.ts";

async function fixture(mode: ExtensionContext["mode"] = "tui") {
	initTheme("dark");
	const manager = SessionManager.inMemory();
	const parent = { sessionManager: manager } as AgentSession;
	bindNativeSession(parent);
	let snapshot: SideConversationSnapshot = {
		state: "idle",
		messages: [],
		parentRunning: true,
		usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const open = vi.fn(async () => {});
	const prompt = vi.fn(async (_text: string) => {});
	const abort = vi.fn(async () => {});
	const close = vi.fn(async () => {
		snapshot = { ...snapshot, state: "closed" };
	});
	const shutdown = vi.fn(async () => {});
	const conversation: SideConversation = {
		get snapshot() {
			return snapshot;
		},
		subscribe: () => () => {},
		open,
		prompt,
		abort,
		close,
		shutdown,
	};
	const createConversation = vi.fn((_session: AgentSession) => conversation);
	const commands = new Map<string, RegisteredCommand>();
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const registerTool = vi.fn();
	const api = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			hooks.set(name, handler);
		},
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		registerTool,
	} as unknown as ExtensionAPI;
	const notify = vi.fn();
	const keys = new KeybindingsManager();
	let panel: (Component & { dispose?(): void }) | undefined;
	const custom = vi.fn(
		(factory: Parameters<ExtensionUIContext["custom"]>[0], _options?: unknown) =>
			new Promise<unknown>((resolve, reject) => {
				let closed = false;
				const done = (result: unknown) => {
					closed = true;
					panel?.dispose?.();
					panel = undefined;
					resolve(result);
				};
				const tui = { requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI;
				Promise.resolve(factory(tui, theme, keys, done)).then((view) => {
					if (closed) view.dispose?.();
					else panel = view;
				}, reject);
			}),
	);
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		sessionManager: manager,
		ui: { notify, custom },
	} as unknown as ExtensionCommandContext;
	await createSideConversationExtension({ createConversation })(api);
	return {
		parent,
		manager,
		open,
		prompt,
		abort,
		close,
		shutdown,
		createConversation,
		commands,
		hooks,
		registerTool,
		notify,
		custom,
		ctx,
		panel: () => panel as GrokSidePanel | undefined,
		start: () => hooks.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
		stop: () => hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }, ctx),
		command: (name: string, text = "") => commands.get(name)!.handler(text, ctx),
	};
}

test("aliases share one owner, mount before answer completion and never submit to the parent", async () => {
	const f = await fixture();
	await f.start();
	expect([...f.commands.keys()]).toEqual(["side", "btw"]);
	expect(f.createConversation).toHaveBeenCalledExactlyOnceWith(f.parent);
	expect(f.registerTool).not.toHaveBeenCalled();
	let answer: () => void = () => {};
	f.prompt.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				answer = resolve;
			}),
	);
	const first = f.command("btw", "  !literal question  ");
	await vi.waitFor(() => expect(f.panel()).toBeDefined());
	expect(f.prompt).toHaveBeenCalledExactlyOnceWith("!literal question");
	expect(f.manager.buildSessionContext().messages).toEqual([]);
	expect(f.custom.mock.calls[0][1]).toMatchObject({ overlay: true });
	f.panel()!.hide();
	await first;
	expect(f.close).not.toHaveBeenCalled();
	expect(f.shutdown).not.toHaveBeenCalled();
	answer();
	const second = f.command("side");
	await vi.waitFor(() => expect(f.panel()).toBeDefined());
	expect(f.createConversation).toHaveBeenCalledTimes(1);
	expect(f.prompt).toHaveBeenCalledTimes(1);
	f.panel()!.hide();
	await second;
	await f.stop();
	expect(f.shutdown).toHaveBeenCalledTimes(1);
});

test.each(["rpc", "print", "json"] as const)("%s rejects before session creation or inference", async (mode) => {
	const f = await fixture(mode);
	await f.start();
	await f.command("btw", "must not execute");
	expect(f.createConversation).not.toHaveBeenCalled();
	expect(f.open).not.toHaveBeenCalled();
	expect(f.prompt).not.toHaveBeenCalled();
	expect(f.custom).not.toHaveBeenCalled();
	expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("only in interactive TUI"), "warning");
});

test("a missing or incompatible parent prefix reports an error without a half-open panel", async () => {
	const f = await fixture();
	await f.start();
	f.open.mockRejectedValueOnce(new Error("No parent request prefix is available"));
	await f.command("side", "question");
	expect(f.notify).toHaveBeenCalledWith("No parent request prefix is available", "error");
	expect(f.custom).not.toHaveBeenCalled();
	expect(f.prompt).not.toHaveBeenCalled();
	const retry = f.command("btw");
	await vi.waitFor(() => expect(f.panel()).toBeDefined());
	f.panel()!.hide();
	await retry;
});

test("concurrent opens cannot submit two side questions or create two panels", async () => {
	const f = await fixture();
	await f.start();
	let ready: () => void = () => {};
	f.open.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				ready = resolve;
			}),
	);
	const first = f.command("side", "first");
	await f.command("btw", "second");
	expect(f.open).toHaveBeenCalledTimes(1);
	expect(f.notify).toHaveBeenCalledWith("A side conversation panel is already open.", "info");
	ready();
	await vi.waitFor(() => expect(f.panel()).toBeDefined());
	expect(f.prompt).toHaveBeenCalledExactlyOnceWith("first");
	f.panel()!.hide();
	await first;
});

test("parent shutdown dismisses an active panel and waits for side shutdown", async () => {
	const f = await fixture();
	await f.start();
	const showing = f.command("side");
	await vi.waitFor(() => expect(f.panel()).toBeDefined());
	let finish: () => void = () => {};
	f.shutdown.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	let finished = false;
	const stopping = Promise.resolve(f.stop()).then(() => {
		finished = true;
	});
	await showing;
	expect(f.panel()).toBeUndefined();
	expect(f.shutdown).toHaveBeenCalledTimes(1);
	expect(finished).toBe(false);
	finish();
	await stopping;
	await f.command("btw", "after shutdown");
	expect(f.prompt).not.toHaveBeenCalled();
	expect(f.custom).toHaveBeenCalledTimes(1);
});

test("shutdown during creation prevents late prompt admission or overlay publication", async () => {
	const f = await fixture();
	await f.start();
	let finish: () => void = () => {};
	f.open.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const creating = f.command("side", "late question");
	await f.stop();
	finish();
	await creating;
	expect(f.prompt).not.toHaveBeenCalled();
	expect(f.custom).not.toHaveBeenCalled();
	expect(f.shutdown).toHaveBeenCalledTimes(1);
});

test("manual child binding cannot create a nested side conversation", async () => {
	const f = await fixture();
	f.manager.appendCustomEntry("epi-collaboration-identity", { rootSessionId: "parent", agentPath: "/root/child" });
	await f.start();
	await f.command("side", "nested");
	expect(f.createConversation).not.toHaveBeenCalled();
	expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("inside a child session"), "error");
});

test("shutdown rejection propagates rather than falsely acknowledging resource cleanup", async () => {
	const f = await fixture();
	await f.start();
	f.shutdown.mockRejectedValue(new Error("resource cleanup incomplete"));
	await expect(f.stop()).rejects.toThrow("resource cleanup incomplete");
});
