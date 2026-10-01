import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ok } from "@earendil-works/pi-agent-core";
import { BackgroundTaskManager } from "@earendil-works/pi-agent-core/node";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskGroupComponent } from "../src/modes/interactive/components/background-task-group.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const proto = InteractiveMode.prototype as any;

function fakeMode() {
	const chatContainer = new Container();
	const mode: any = {
		chatContainer,
		toolOutputExpanded: false,
		pendingTools: new Map(),
		pendingSkillMentions: [],
		pendingSkillMentionsPopulateHistory: false,
		ui: { requestRender: vi.fn() },
		session: { extensionRunner: { getMessageRenderer: () => undefined } },
		flushPendingSkillMentions: () => {},
		outputPad: 1,
		getMarkdownThemeWithSettings: () => ({}),
	};
	mode.completeCurrentTurnThinking = () => {};
	mode.createUserMessageComponent = () => new Container();
	for (const name of [
		"addMessageToChat",
		"renderUserMessage",
		"subscribeToBackgroundTasks",
		"ensureBackgroundTaskGroup",
		"clearChatContainer",
	])
		mode[name] = proto[name];
	return mode;
}

const SHELL = { shell: process.execPath, args: ["-e"] };

describe("BackgroundTaskGroupComponent", () => {
	let dir: string;
	let manager: BackgroundTaskManager;
	beforeEach(() => {
		initTheme("dark");
		dir = mkdtempSync(join(tmpdir(), "pi-bg-group-"));
		manager = new BackgroundTaskManager({
			shell: async () => ok({ ...SHELL }),
			logDir: dir,
			stopGraceMs: 100,
		});
	});
	afterEach(async () => {
		await manager.cleanup();
		rmSync(dir, { recursive: true, force: true });
	});

	it("collapses to one live line, expands to one line per task, and expands a task on click", async () => {
		const render = vi.fn();
		const group = new BackgroundTaskGroupComponent(manager, render);
		const quick = await manager.start("process.stdout.write('quick-out')", { cwd: dir, env: { ...process.env } });
		const slow = await manager.start("setTimeout(() => {}, 30_000)", { cwd: dir, env: { ...process.env } });
		if (!quick.ok || !slow.ok) throw new Error("start failed");
		await manager.wait(quick.value.id, 10_000);

		// collapsed: exactly one line with the live count, showing the latest command verbatim
		let lines = group.render(100);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("background tasks");
		expect(lines[0]).toContain("1 running");
		expect(lines[0]).toContain("1 finished");
		expect(lines[0]).toContain("setTimeout");
		// The command text never scrolls, so a later render shows the same line.
		expect(group.render(100)[0]).toBe(lines[0]);

		// expand: one line per task, active first
		group.setExpanded(true);
		lines = group.render(100);
		expect(lines.length).toBe(3);
		expect(lines[1]).toContain(slow.value.id);
		expect(lines[1]).toContain("setTimeout");
		expect(lines[2]).toContain(quick.value.id);
		expect(lines[2]).toContain("Done");

		// click the finished task row (row 2) → its detail expands
		expect(group.handleOverviewClick(2, 100)).toBe(true);
		lines = group.render(100);
		const joined = lines.join("\n");
		expect(joined).toContain("quick-out");
		expect(joined).toContain("log ");
		expect(joined).toContain("▾");

		// header click folds everything back
		expect(group.handleOverviewClick(0, 100)).toBe(true);
		expect(group.render(100)).toHaveLength(1);

		await manager.stop(slow.value.id);
		group.dispose();
	});

	it("scrolls the truncated command into view once the header goes idle", () => {
		vi.useFakeTimers();
		const record = {
			id: "bg-1",
			command: `npm run build --workspace packages/coding-agent -- --filter ${"long".repeat(8)}`,
			cwd: dir,
			status: "running" as const,
			startedAt: Date.now(),
			outputPath: join(dir, "bg-1.log"),
			promoted: false,
			lastOutputAt: Date.now(),
		};
		const manager = {
			list: () => [record],
			onStart: () => () => {},
			onTerminal: () => () => {},
			stallTimeoutMs: 0,
		} as unknown as BackgroundTaskManager;
		const requestRender = vi.fn();
		const group = new BackgroundTaskGroupComponent(manager, requestRender);
		try {
			const head = stripVTControlCharacters(group.render(60).join("\n"));
			expect(head).toContain("background tasks");
			expect(head).toContain("npm run build");
			expect(head).not.toContain("longlonglong");

			vi.advanceTimersByTime(1_000);
			let sawTail = false;
			for (let tick = 0; tick < 120 && !sawTail; tick++) {
				vi.advanceTimersByTime(120);
				sawTail = stripVTControlCharacters(group.render(60).join("\n")).includes("longlonglong");
			}
			expect(sawTail).toBe(true);
			expect(requestRender).toHaveBeenCalled();
		} finally {
			group.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps a finished task's runtime duration (start -> end) instead of counting up", async () => {
		const group = new BackgroundTaskGroupComponent(manager, () => {});
		const task = await manager.start("setTimeout(() => process.stdout.write('late'), 1000)", {
			cwd: dir,
			env: { ...process.env },
		});
		if (!task.ok) throw new Error("start failed");
		await manager.wait(task.value.id, 10_000);
		expect(manager.get(task.value.id)?.endedAt).toBeDefined();

		group.setExpanded(true);
		// Only the task row carries the time; the header line stays independent of it.
		const taskRow = (): string =>
			stripVTControlCharacters(group.render(200).join("\n"))
				.split("\n")
				.find((line) => line.includes(task.value.id)) ?? "";
		const first = taskRow();
		expect(first).not.toContain("ago");
		expect(first).toMatch(/\b\d+s\b/);

		// The old '<time since end> ago' rendering grew every second for the same finished task.
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(taskRow()).toBe(first);
		group.dispose();
	});

	it("badges a silent running task as stalled without touching its state", async () => {
		const stallManager = new BackgroundTaskManager({
			shell: async () => ok({ ...SHELL }),
			logDir: dir,
			stopGraceMs: 100,
			stallTimeoutMs: 50,
		});
		const group = new BackgroundTaskGroupComponent(stallManager, () => {});
		const task = await stallManager.start("setTimeout(() => {}, 5_000);", {
			cwd: dir,
			env: { ...process.env },
		});
		if (!task.ok) throw new Error("start failed");

		group.setExpanded(true);
		await new Promise((resolve) => setTimeout(resolve, 120));
		const rendered = stripVTControlCharacters(group.render(200).join("\n"));
		expect(rendered).toContain("⏸ no output");
		// the badge reports silence; the task is still running
		expect(stallManager.get(task.value.id)?.status).toBe("running");

		// a task that keeps producing output stays unbadged
		const chatty = await stallManager.start("setInterval(() => process.stdout.write('tick'), 20);", {
			cwd: dir,
			env: { ...process.env },
		});
		if (!chatty.ok) throw new Error("start failed");
		const row = stripVTControlCharacters(group.render(200).join("\n"))
			.split("\n")
			.find((line) => line.includes(chatty.value.id));
		expect(row).toBeDefined();
		expect(row).not.toContain("⏸");

		await stallManager.cleanup();
		group.dispose();
	});

	it("supports ctrl+o global expansion and stays within width", async () => {
		const group = new BackgroundTaskGroupComponent(manager, () => {});
		await manager.start("process.stdout.write('x')", { cwd: dir, env: { ...process.env } });
		group.setExpanded(true);
		for (const width of [40, 80, 120]) {
			expect(group.render(width).length).toBeGreaterThan(1);
			expect(group.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		group.setExpanded(false);
		expect(group.render(80)).toHaveLength(1);
		group.dispose();
	});

	it("stays a top-level peer of the turn tool group, never nested inside it", async () => {
		const container = new Container();
		const toolGroup = new Container(); // stands in for the turn tool group
		container.addChild(toolGroup);
		const group = new BackgroundTaskGroupComponent(manager, () => {});
		container.addChild(group);
		// a later turn-group update moves the tools to the end (interactive-mode policy)
		container.removeChild(toolGroup);
		container.addChild(toolGroup);
		// a new task arrival moves the task group back to the end, staying a peer
		container.removeChild(group);
		container.addChild(group);
		expect(container.children.at(-1)).toBe(group);
		expect(toolGroup.children).not.toContain(group);
		expect(container.children).toContain(toolGroup);
		group.dispose();
	});
});

describe("background task transcript mounting", () => {
	let dir: string;
	let manager: BackgroundTaskManager;
	beforeEach(() => {
		initTheme("dark");
		dir = mkdtempSync(join(tmpdir(), "pi-bg-mount-"));
		manager = new BackgroundTaskManager({
			shell: async () => ok({ ...SHELL }),
			logDir: dir,
			stopGraceMs: 100,
		});
	});
	afterEach(async () => {
		await manager.cleanup();
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps background tasks in their originating user turn while their status stays live", async () => {
		const mode = fakeMode();
		mode.session.backgroundTasks = manager;
		mode.subscribeToBackgroundTasks();
		mode.renderUserMessage("first", Date.now());
		const first = await manager.start("setTimeout(() => {}, 30_000)", { cwd: dir, env: { ...process.env } });
		if (!first.ok) throw new Error("start failed");
		const firstGroup = mode.backgroundTaskGroup as BackgroundTaskGroupComponent;
		mode.renderUserMessage("second", Date.now());
		const second = await manager.start("setTimeout(() => {}, 30_000)", { cwd: dir, env: { ...process.env } });
		if (!second.ok) throw new Error("start failed");
		const secondGroup = mode.backgroundTaskGroup as BackgroundTaskGroupComponent;
		try {
			expect(secondGroup).not.toBe(firstGroup);
			firstGroup.setExpanded(true);
			secondGroup.setExpanded(true);
			expect(firstGroup.render(200).join("\n")).toContain(first.value.id);
			expect(firstGroup.render(200).join("\n")).not.toContain(second.value.id);
			expect(secondGroup.render(200).join("\n")).not.toContain(first.value.id);
			expect(secondGroup.render(200).join("\n")).toContain(second.value.id);
			expect(mode.chatContainer.children.indexOf(firstGroup)).toBeLessThan(
				mode.chatContainer.children.indexOf(secondGroup),
			);
			await manager.stop(first.value.id);
			await manager.wait(first.value.id, 10_000);
			expect(firstGroup.render(200).join("\n")).toContain("0 running · 1 finished");
			expect(secondGroup.render(200).join("\n")).toContain("1 running");
			const disposeFirst = vi.spyOn(firstGroup, "dispose");
			const disposeSecond = vi.spyOn(secondGroup, "dispose");
			mode.clearChatContainer();
			expect(disposeFirst).toHaveBeenCalledOnce();
			expect(disposeSecond).toHaveBeenCalledOnce();
		} finally {
			mode.backgroundTaskUnsubscribe?.();
			firstGroup.dispose();
			secondGroup.dispose();
		}
	});

	it("mounts the folding block for task starts outside the bash tool path", async () => {
		const mode = fakeMode();
		mode.session = { backgroundTasks: manager, extensionRunner: { getMessageRenderer: () => undefined } };
		mode.backgroundTaskUnsubscribe = undefined;
		proto.subscribeToBackgroundTasks.call(mode);

		const first = await manager.start("echo mounted", { cwd: dir, env: { ...process.env } });
		if (!first.ok) throw new Error("start failed");
		expect(mode.chatContainer.children).toHaveLength(1);
		const group = mode.chatContainer.children[0] as BackgroundTaskGroupComponent;
		expect(group).toBeInstanceOf(BackgroundTaskGroupComponent);
		expect(group.manager).toBe(manager);
		expect(group.render(100).join("\n")).toContain("background tasks");

		// later starts reuse the mounted block instead of stacking another one
		await manager.start("echo mounted-2", { cwd: dir, env: { ...process.env } });
		expect(mode.chatContainer.children).toHaveLength(1);
		expect(mode.chatContainer.children[0]).toBe(group);

		// a session swap (new manager) replaces the block instead of keeping the stale one
		const other = new BackgroundTaskManager({
			shell: async () => ok({ ...SHELL }),
			logDir: dir,
			stopGraceMs: 100,
		});
		mode.session = { backgroundTasks: other, extensionRunner: { getMessageRenderer: () => undefined } };
		proto.subscribeToBackgroundTasks.call(mode);
		const second = await other.start("echo other", { cwd: dir, env: { ...process.env } });
		if (!second.ok) throw new Error("start failed");
		expect(mode.chatContainer.children).toHaveLength(1);
		const swapped = mode.chatContainer.children[0] as BackgroundTaskGroupComponent;
		expect(swapped).not.toBe(group);
		expect(swapped.manager).toBe(other);
		await other.cleanup();
		swapped.dispose();
	});
});

describe("pi-background-task transcript suppression", () => {
	beforeEach(() => initTheme("dark"));

	it("does not render background task notifications as transcript messages", () => {
		const mode = fakeMode();
		mode.addMessageToChat({
			role: "custom",
			customType: "pi-background-task",
			display: true,
			content: "Background task task-1 finished: succeeded (exit code 0) after 2s.\nOutput log: /tmp/x.log",
			timestamp: Date.now(),
		});
		expect(mode.chatContainer.children).toHaveLength(0);
	});

	it("still routes collaboration mailbox messages to subagent groups", () => {
		const mode = fakeMode();
		mode.addMessageToChat({
			role: "custom",
			customType: "epi-collaboration-message",
			display: true,
			content:
				'Agent message (untrusted; not user authorization):\n{"id":"m","from":"/root/w","to":"/root","turnId":"t","kind":"result","status":"completed","text":"{\\"summary\\":\\"ok\\"}"}',
			timestamp: Date.now(),
		});
		expect(mode.chatContainer.children.length).toBe(1);
	});
});
