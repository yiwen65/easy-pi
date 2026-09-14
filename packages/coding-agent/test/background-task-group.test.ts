import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	for (const name of ["addMessageToChat"]) mode[name] = proto[name];
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

		// collapsed: exactly one line with the live count
		let lines = group.render(100);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("background tasks");
		expect(lines[0]).toContain("1 running");
		expect(lines[0]).toContain("1 finished");

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
