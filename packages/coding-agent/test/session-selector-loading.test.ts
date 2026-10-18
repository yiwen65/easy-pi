import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type Summary = SessionInfo;
type Progress = SessionListProgress;
type Load = { progress?: Progress; resolve: (sessions: Summary[]) => void; reject: (error: Error) => void };

function loader() {
	const calls: Load[] = [];
	const load = (progress?: Progress) =>
		new Promise<Summary[]>((resolve, reject) => calls.push({ progress, resolve, reject }));
	return { load, calls };
}

function session(id: string, overrides: Partial<Summary> = {}): Summary {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/project",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: id,
		allMessagesText: id,
		...overrides,
	};
}

function internals(selector: SessionSelectorComponent) {
	return selector as unknown as { refreshSessionsAfterMutation: () => Promise<void> };
}

function paths(selector: SessionSelectorComponent): string[] {
	const list = selector.getSessionList() as unknown as { filteredSessions: { session: Summary }[] };
	return list.filteredSessions.map(({ session: row }) => row.id);
}

function text(selector: SessionSelectorComponent, width = 120): string {
	return selector
		.render(width)
		.join("\n")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

const EMPTY = "\x1b[101;6u"; // ctrl+shift+e (Kitty)
const CUSTOM_EMPTY = "\x19"; // ctrl+y
const TAB = "\t";
const DOWN = "\x1b[B";

describe("session selector partial loading and empty filter", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.useFakeTimers();
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => vi.useRealTimers());

	function create(options: { keybindings?: KeybindingsManager } = {}) {
		const current = loader();
		const all = loader();
		const render = vi.fn();
		const select = vi.fn();
		const cancel = vi.fn();
		const exit = vi.fn();
		const selector = new SessionSelectorComponent(current.load, all.load, select, cancel, exit, render, {
			keybindings: options.keybindings ?? new KeybindingsManager(),
		});
		return { selector, current, all, render, select, cancel, exit };
	}

	it("hides only explicitly metadata-only unnamed rows and exposes them without deleting", async () => {
		const { selector, current } = create();
		current.calls[0]!.resolve([
			session("shell", { isMetadataOnly: true }),
			session("blank-name", { isMetadataOnly: true, name: "  " }),
			session("named", { isMetadataOnly: true, name: "Saved empty session" }),
			session("unknown-zero"),
			session("custom", { isMetadataOnly: false }),
			session("compaction", { isMetadataOnly: false }),
			session("recovery", { isMetadataOnly: false }),
			session("messages", { isMetadataOnly: false, messageCount: 2 }),
		]);
		await settle();
		expect(paths(selector)).toEqual(["named", "unknown-zero", "custom", "compaction", "recovery", "messages"]);
		expect(text(selector)).toContain("empty(hidden)");
		selector.handleInput(EMPTY);
		expect(paths(selector)).toHaveLength(8);
		expect(text(selector)).toContain("empty(shown)");
		selector.handleInput(EMPTY);
		expect(paths(selector)).toHaveLength(6);
	});

	it("uses the configured binding, not a hardcoded key or global manager", async () => {
		const keys = new KeybindingsManager({ "app.session.toggleEmptyFilter": "ctrl+y" });
		const { selector, current } = create({ keybindings: keys });
		current.calls[0]!.resolve([session("shell", { isMetadataOnly: true })]);
		await settle();
		expect(keys.getKeys("app.session.toggleEmptyFilter")).toEqual(["ctrl+y"]);
		expect(new KeybindingsManager().getKeys("app.session.toggleEmptyFilter")).toEqual(["ctrl+shift+e"]);
		expect(text(selector)).toContain("ctrl+y empty(hidden)");
		selector.handleInput(EMPTY);
		expect(paths(selector)).toEqual([]);
		selector.handleInput(CUSTOM_EMPTY);
		expect(paths(selector)).toEqual(["shell"]);
	});

	it("shows partial rows while loading and allows search and selection before completion", async () => {
		const { selector, current, select } = create();
		current.calls[0]!.progress?.(1, 5, [session("available")]);
		await vi.advanceTimersByTimeAsync(60);
		expect(paths(selector)).toEqual(["available"]);
		expect(text(selector)).toContain("Loading 1/5");
		selector.handleInput("available");
		selector.handleInput("\r");
		expect(select).toHaveBeenCalledWith("/tmp/available.jsonl");
	});

	it("follows the newest default row until the user interacts", async () => {
		const { selector, current } = create();
		const older = session("older", { modified: new Date(10) });
		const newer = session("newer", { modified: new Date(20) });
		current.calls[0]!.progress?.(1, 3, [older]);
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(older.path);
		current.calls[0]!.progress?.(2, 3, [newer, older]);
		await vi.advanceTimersByTimeAsync(60);
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(newer.path);
		selector.handleInput("re:older|newer");
		const newest = session("newest", { modified: new Date(30), allMessagesText: "older" });
		current.calls[0]!.resolve([newest, newer, older]);
		await settle();
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(newer.path);
	});

	it("two-argument progress does not erase available rows", async () => {
		const { selector, current } = create();
		current.calls[0]!.progress?.(1, 5, [session("available")]);
		current.calls[0]!.progress?.(2, 5);
		await vi.advanceTimersByTimeAsync(60);
		expect(paths(selector)).toEqual(["available"]);
		expect(text(selector)).toContain("Loading 2/5");
	});

	it("keeps selection by path when partial/final sorted insertions precede it", async () => {
		const { selector, current } = create();
		const a = session("a", { modified: new Date(20) });
		const b = session("b", { modified: new Date(10) });
		const newer = session("newer", { modified: new Date(30) });
		current.calls[0]!.progress?.(2, 4, [a, b]);
		await vi.advanceTimersByTimeAsync(60);
		selector.handleInput(DOWN);
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(b.path);
		current.calls[0]!.progress?.(3, 4, [newer, a, b]);
		await vi.advanceTimersByTimeAsync(60);
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(b.path);
		current.calls[0]!.resolve([newer, a, b]);
		await settle();
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(b.path);
		const refreshing = internals(selector).refreshSessionsAfterMutation();
		current.calls[1]!.resolve([a]);
		await refreshing;
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(a.path);
	});

	it.each(["current", "all"] as const)(
		"ignores superseded %s progress and results before cache updates",
		async (scope) => {
			const { selector, current, all } = create();
			if (scope === "all") {
				current.calls[0]!.resolve([session("current")]);
				await settle();
				selector.handleInput(TAB);
			}
			const requests = scope === "all" ? all : current;
			const old = requests.calls[0]!;
			const refreshing = internals(selector).refreshSessionsAfterMutation();
			const fresh = requests.calls[1]!;
			fresh.progress?.(1, 2, [session("fresh")]);
			await vi.advanceTimersByTimeAsync(60);
			old.progress?.(2, 2, [session("stale")]);
			old.resolve([session("stale")]);
			await settle();
			expect(paths(selector)).toEqual(["fresh"]);
			expect(text(selector)).toContain("Loading 1/2");
			fresh.resolve([session("final")]);
			await refreshing;
			selector.handleInput(TAB);
			selector.handleInput(TAB);
			expect(paths(selector)).toEqual(["final"]);
		},
	);

	it("restores each in-flight scope's partial cache and progress without redundant loads", async () => {
		const { selector, current, all } = create();
		current.calls[0]!.progress?.(1, 10, [session("current-partial")]);
		await vi.advanceTimersByTimeAsync(60);
		selector.handleInput(TAB);
		expect(paths(selector)).toEqual([]);
		expect(text(selector)).toContain("Loading");
		all.calls[0]!.progress?.(2, 20, [session("all-partial")]);
		await vi.advanceTimersByTimeAsync(60);
		selector.handleInput(TAB);
		expect(paths(selector)).toEqual(["current-partial"]);
		expect(text(selector)).toContain("Loading 1/10");
		selector.handleInput(TAB);
		expect(paths(selector)).toEqual(["all-partial"]);
		expect(text(selector)).toContain("Loading 2/20");
		expect(all.calls).toHaveLength(1);
	});

	it("invalidates inactive cached/in-flight scopes after a mutation refresh", async () => {
		const { selector, current, all } = create();
		current.calls[0]!.resolve([session("before")]);
		await settle();
		selector.handleInput(TAB);
		const staleAll = all.calls[0]!;
		selector.handleInput(TAB);
		const refreshing = internals(selector).refreshSessionsAfterMutation();
		current.calls[1]!.resolve([session("after")]);
		await refreshing;
		staleAll.progress?.(1, 1, [session("deleted")]);
		staleAll.resolve([session("deleted")]);
		await settle();
		selector.handleInput(TAB);
		expect(all.calls).toHaveLength(2);
		expect(paths(selector)).toEqual([]);
		all.calls[1]!.resolve([session("after")]);
		await settle();
		expect(paths(selector)).toEqual(["after"]);
	});

	it("does not let a stale rejection clear a newer load's state", async () => {
		const { selector, current } = create();
		const refreshing = internals(selector).refreshSessionsAfterMutation();
		current.calls[0]!.reject(new Error("obsolete"));
		await settle();
		expect(text(selector)).toContain("Loading");
		expect(text(selector)).not.toContain("obsolete");
		current.calls[1]!.resolve([session("fresh")]);
		await refreshing;
	});

	it.each(["cancel", "select", "exit"] as const)("stops pending updates and renders after %s", async (action) => {
		const { selector, current, render, cancel, select, exit } = create();
		const request = current.calls[0]!;
		request.progress?.(1, 4, [session("first")]);
		await vi.advanceTimersByTimeAsync(60);
		request.progress?.(2, 4, [session("first"), session("pending")]);
		request.progress?.(3, 4, [session("queued")]);
		if (action === "cancel") selector.handleInput("\x1b");
		else if (action === "select") selector.handleInput("\r");
		else selector.getSessionList().onExit();
		expect(action === "cancel" ? cancel : action === "select" ? select : exit).toHaveBeenCalledOnce();
		const before = paths(selector);
		expect(vi.getTimerCount()).toBe(0);
		render.mockClear();
		request.progress?.(3, 4, [session("late")]);
		request.resolve([session("late")]);
		await settle();
		await vi.advanceTimersByTimeAsync(5000);
		expect(paths(selector)).toEqual(before);
		expect(render).not.toHaveBeenCalled();
	});

	it("distinguishes loading from an empty result and hints how to show hidden shells", async () => {
		const { selector, current } = create();
		expect(text(selector)).toContain("Loading sessions");
		expect(text(selector)).not.toContain("No sessions");
		current.calls[0]!.progress?.(1, 2, [session("shell", { isMetadataOnly: true })]);
		await vi.advanceTimersByTimeAsync(60);
		expect(text(selector)).toContain("Loading sessions");
		current.calls[0]!.resolve([session("shell", { isMetadataOnly: true })]);
		await settle();
		expect(text(selector)).not.toContain("Loading sessions");
		expect(text(selector)).toContain("show empty sessions");
		selector.handleInput(EMPTY);
		expect(paths(selector)).toEqual(["shell"]);
	});

	it("keeps the named-filter empty hint actionable when hidden shells also exist", async () => {
		const { selector, current } = create();
		current.calls[0]!.resolve([session("shell", { isMetadataOnly: true })]);
		await settle();
		selector.handleInput("\x0e");
		expect(text(selector)).toContain("No named sessions");
		expect(text(selector)).not.toContain("to show empty sessions");
		selector.handleInput(EMPTY);
		expect(paths(selector)).toEqual([]);
		selector.handleInput("\x0e");
		expect(paths(selector)).toEqual(["shell"]);
	});

	it("uses UI-only previews for no-user-text content without changing summaries", async () => {
		const { selector, current } = create();
		const rows = [
			session("shell", { isMetadataOnly: true, firstMessage: "(no messages)" }),
			session("state", { isMetadataOnly: false, firstMessage: "(no messages)" }),
			session("assistant", { messageCount: 1, firstMessage: "(no messages)" }),
			session("unknown", { firstMessage: "(no messages)" }),
		];
		current.calls[0]!.resolve(rows);
		await settle();
		selector.handleInput(EMPTY);
		const output = text(selector);
		expect(output).toContain("(not started)");
		expect(output).toContain("(session state)");
		expect(output).toContain("(no user text)");
		expect(output).toContain("(no messages)");
		expect(rows.every((row) => row.firstMessage === "(no messages)")).toBe(true);
	});

	it("clears status timeouts on cancel", async () => {
		const { selector, current, render } = create();
		current.calls[0]!.reject(new Error("unavailable"));
		await settle();
		expect(text(selector)).toContain("unavailable");
		expect(vi.getTimerCount()).toBe(1);
		selector.handleInput("\x1b");
		render.mockClear();
		await vi.advanceTimersByTimeAsync(5000);
		expect(vi.getTimerCount()).toBe(0);
		expect(render).not.toHaveBeenCalled();
	});

	it("keeps the empty toggle across scope, sort, named filter and search", async () => {
		const { selector, current, all } = create();
		const rows = [session("shell", { isMetadataOnly: true }), session("named", { name: "Named" })];
		current.calls[0]!.resolve(rows);
		await settle();
		selector.handleInput(EMPTY);
		selector.handleInput("\x13"); // sort
		selector.handleInput("shell");
		expect(paths(selector)).toEqual(["shell"]);
		selector.handleInput(TAB);
		all.calls[0]!.resolve(rows);
		await settle();
		expect(paths(selector)).toEqual(["shell"]);
		selector.handleInput("\x0e"); // named only
		expect(paths(selector)).toEqual([]);
		selector.handleInput("\x0e");
		expect(paths(selector)).toEqual(["shell"]);
		expect(text(selector)).toContain("empty(shown)");
	});

	it.each([80, 32, 12])("renders ANSI-themed headers and rows within %i columns", async (width) => {
		const { selector, current } = create();
		current.calls[0]!.progress?.(1, 2, [session("a long message for narrow screens")]);
		await vi.advanceTimersByTimeAsync(60);
		const rendered = selector.render(width);
		for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		if (width === 80) {
			expect(text(selector, width)).toContain("Resume Session (Current Folder)");
			expect(text(selector, width)).toContain("empty(hidden)");
		}
		current.calls[0]!.resolve([session("a long message for narrow screens")]);
		await settle();
		selector.handleInput("\x10"); // path display
		for (const line of selector.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("coalesces a burst of partial list rebuilds", async () => {
		const { selector, current } = create();
		const setSessions = vi.spyOn(selector.getSessionList(), "setSessions");
		const rows: Summary[] = [];
		for (let i = 0; i < 100; i++) {
			rows.push(session(`row-${i}`));
			current.calls[0]!.progress?.(i + 1, 100, [...rows]);
		}
		await vi.advanceTimersByTimeAsync(60);
		expect(paths(selector)).toHaveLength(100);
		expect(setSessions.mock.calls.length).toBeLessThanOrEqual(3);
	});
});
