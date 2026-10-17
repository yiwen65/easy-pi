import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ToolOutputStorage } from "../src/core/tool-output-storage.ts";
import * as logDiscovery from "../src/core/tool-output-storage-discovery.ts";
import {
	checkNativeTeamStorageAdmission,
	handleNativeStorageCommand,
	runAutomaticNativeStorageGc,
} from "../src/extensions/pi-collaboration-storage.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-storage-operator-")));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const rootSessionId = "current";
	const settings = SettingsManager.inMemory();
	const directory = join(agentDir, "teams", "other");
	const store = new CollaborationStore({ path: join(directory, "registry.sqlite"), rootSessionId: "other", cwd });
	store.close();
	const notices: string[] = [];
	const confirm = vi.fn(async () => false);
	const ctx = {
		hasUI: false,
		ui: {
			notify: (message: string) => {
				notices.push(message);
			},
			confirm,
		},
	};
	return { cwd, agentDir, rootSessionId, settings, directory, notices, ctx };
}

test("operator inventory and dry-run never delete; non-UI delete needs explicit confirmation", async () => {
	const f = fixture();
	expect(await handleNativeStorageCommand("storage", f.ctx, f)).toBe(true);
	expect(f.notices.join("\n")).toContain("other");
	await handleNativeStorageCommand("gc", f.ctx, f);
	await handleNativeStorageCommand("delete other", f.ctx, f);
	expect(existsSync(f.directory)).toBe(true);
	expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
	expect(f.notices.join("\n")).toContain("No data deleted");
	await handleNativeStorageCommand("delete other --confirm", f.ctx, f);
	expect(existsSync(f.directory)).toBe(false);
});

test("UI decline, active root and malformed commands cannot delete", async () => {
	const f = fixture();
	await handleNativeStorageCommand("delete other", { ...f.ctx, hasUI: true }, f);
	expect(f.ctx.ui.confirm).toHaveBeenCalledOnce();
	expect(existsSync(f.directory)).toBe(true);
	await handleNativeStorageCommand("delete current --confirm", f.ctx, f);
	await handleNativeStorageCommand("delete other --wrong", f.ctx, f);
	expect(existsSync(f.directory)).toBe(true);
	expect(f.notices.join("\n")).toContain("Cannot delete the active root");
	expect(f.notices.join("\n")).toContain("Usage:");
	expect(await handleNativeStorageCommand("recover", f.ctx, f)).toBe(false);
});

test("automatic GC is off by default and explicit global policy cleans only cold unowned teams", () => {
	const f = fixture();
	const old = new Date(Date.now() - 3 * 86_400_000);
	utimesSync(join(f.directory, "registry.sqlite"), old, old);
	utimesSync(f.directory, old, old);
	runAutomaticNativeStorageGc(f, f.ctx);
	expect(existsSync(f.directory)).toBe(true);
	const settings = SettingsManager.inMemory({ subagentStorage: { autoGc: true, maxAgeDays: 1 } });
	runAutomaticNativeStorageGc({ ...f, settings }, f.ctx);
	expect(existsSync(f.directory)).toBe(false);
	expect(f.notices.join("\n")).toContain("1 deleted");
});

test("incomplete log discovery disables capacity-based deletion end to end", async () => {
	const f = fixture();
	const parent = join(f.agentDir, "sessions", "--project--");
	mkdirSync(parent, { recursive: true });
	const logs = new ToolOutputStorage({ sessionId: "session", sessionFile: join(parent, "session.jsonl") });
	const file = logs.createLogFile();
	writeFileSync(file.fd, "keep this output");
	closeSync(file.fd);
	file.release();
	logs.close();
	mkdirSync(join(parent, "unknown.logs"));
	const settings = SettingsManager.inMemory({ subagentStorage: { logMaxTotalBytes: 1 } });
	await handleNativeStorageCommand("gc --confirm", f.ctx, { ...f, settings });
	expect(existsSync(file.path)).toBe(true);
	expect(f.notices.join("\n")).toContain("Inventory incomplete");
});

test("operator log inspection does not permanently limit discovery to the first hundred directories", async () => {
	const f = fixture();
	const directories = Array.from({ length: 101 }, (_, index) => join(f.cwd, `missing-${index}.logs`));
	const discovery = vi
		.spyOn(logDiscovery, "discoverToolOutputStorage")
		.mockReturnValue({ directories, incomplete: false });
	try {
		await handleNativeStorageCommand("storage", f.ctx, f);
		expect(JSON.parse(f.notices.at(-1)!).logs.directories).toBe(101);
	} finally {
		discovery.mockRestore();
	}
});

test("byte budgets protect only new admission", () => {
	const f = fixture();
	const settings = SettingsManager.inMemory({ subagentStorage: { maxTeamBytes: 1 } });
	expect(() => checkNativeTeamStorageAdmission({ ...f, rootSessionId: "other", settings })).toThrow(/budget/);
	expect(() => checkNativeTeamStorageAdmission(f)).not.toThrow();
});
