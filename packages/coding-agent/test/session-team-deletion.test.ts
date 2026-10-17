import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import {
	assertSessionTeamDeletionUnchanged,
	deleteAssociatedSessionTeam,
	inspectSessionTeamDeletion,
} from "../src/core/session-team-deletion.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Never invoke the host trash application in deletion fixtures.
vi.mock("node:child_process", () => ({
	spawnSync: () => ({ status: 1, stderr: "trash unavailable in fixture" }),
	execFileSync: () => {
		throw new Error("No process-start probe in fixture");
	},
}));

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
beforeAll(() => {
	initTheme("dark");
});

function fixture(active = false) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-team-delete-")));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const manager = SessionManager.create(cwd, join(cwd, "sessions"));
	const path = manager.getSessionFile()!;
	const teamDirectory = join(agentDir, "teams", manager.getSessionId());
	const store = new CollaborationStore({
		path: join(teamDirectory, "registry.sqlite"),
		rootSessionId: manager.getSessionId(),
		cwd,
	});
	cleanups.push(() => store.close());
	if (!active) store.close();
	const now = new Date();
	const info: SessionInfo = {
		path,
		id: manager.getSessionId(),
		cwd,
		created: now,
		modified: now,
		messageCount: 0,
		firstMessage: "delete fixture",
		allMessagesText: "",
	};
	return { cwd, agentDir, manager, path, teamDirectory, info };
}

async function flush() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}
async function selectorFor(f: ReturnType<typeof fixture>) {
	setKeybindings(new KeybindingsManager());
	const selector = new SessionSelectorComponent(
		async () => (existsSync(f.path) ? [f.info] : []),
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{ agentDir: f.agentDir },
	);
	await flush();
	return selector;
}

test("cascade is explicit and removes only managed team, not root/workspace", () => {
	const f = fixture();
	const selected = inspectSessionTeamDeletion(f.path, f.agentDir);
	expect(selected.team.state).toBe("present");
	expect(existsSync(f.teamDirectory)).toBe(true);
	deleteAssociatedSessionTeam(selected);
	expect(existsSync(f.teamDirectory)).toBe(false);
	expect(existsSync(f.path)).toBe(true);
	expect(existsSync(f.cwd)).toBe(true);
	// Retry is idempotent even though the root still exists after a failed final-file deletion.
	deleteAssociatedSessionTeam(selected);
});

test("live owner, changed root file and symlink roots are refused", () => {
	const live = fixture(true);
	expect(() => deleteAssociatedSessionTeam(inspectSessionTeamDeletion(live.path, live.agentDir))).toThrow(
		/live process/,
	);
	const f = fixture();
	const selected = inspectSessionTeamDeletion(f.path, f.agentDir);
	appendFileSync(f.path, "\n");
	expect(() => assertSessionTeamDeletionUnchanged(selected)).toThrow(/changed/);
	expect(existsSync(f.teamDirectory)).toBe(true);
	const alias = join(f.cwd, `${randomUUID()}.jsonl`);
	symlinkSync(f.path, alias);
	expect(() => inspectSessionTeamDeletion(alias, f.agentDir)).toThrow(/Unsafe/);
});

test("selector cancellation is the default and does not delete either file set", async () => {
	const f = fixture();
	const selector = await selectorFor(f);
	await selector.getSessionList().onDeleteSession?.(f.path);
	expect(selector.render(120).join("\n")).toContain("choose history scope");
	selector.handleInput("\r");
	await flush();
	expect(existsSync(f.path)).toBe(true);
	expect(existsSync(f.teamDirectory)).toBe(true);
});

test("selector explicit cascade deletes root and team", async () => {
	const f = fixture();
	const selector = await selectorFor(f);
	await selector.getSessionList().onDeleteSession?.(f.path);
	selector.handleInput("\x1b[B");
	selector.handleInput("\r");
	await vi.waitFor(() => {
		expect(existsSync(f.path)).toBe(false);
		expect(existsSync(f.teamDirectory)).toBe(false);
		expect(selector.render(120).join("\n")).toContain("Resume Session");
	});
});

test("selector root-only choice clearly retains team history", async () => {
	const f = fixture();
	const selector = await selectorFor(f);
	await selector.getSessionList().onDeleteSession?.(f.path);
	selector.handleInput("\x1b[B");
	selector.handleInput("\x1b[B");
	selector.handleInput("\r");
	await vi.waitFor(() => {
		expect(existsSync(f.path)).toBe(false);
		expect(existsSync(f.teamDirectory)).toBe(true);
		expect(selector.render(120).join("\n")).toContain("Resume Session");
	});
});
