import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	appendSessionCacheAffinity,
	readSessionCacheAffinityHint,
	recordedCacheAffinityId,
	resolveSessionCacheAffinityId,
	SESSION_CACHE_AFFINITY_ENTRY,
} from "../src/core/session-cache-affinity.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(name: string) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), `epi-cache-hint-${name}-`)));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

/** Materialize the session file the way the first persisted assistant response does. */
async function flushSession(manager: SessionManager) {
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		timestamp: 2,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
}

test("memory-only sessions resolve to their own id and record nothing", async () => {
	const cwd = await tempDir("memory");
	const manager = SessionManager.inMemory(cwd);
	expect(manager.getSessionFile()).toBeUndefined();
	expect(resolveSessionCacheAffinityId(manager)).toBe(manager.getSessionId());
	expect(appendSessionCacheAffinity(manager, "lineage")).toBe(false);
	// Nothing is persisted and no lineage is inherited.
	expect(recordedCacheAffinityId(manager)).toBeUndefined();
});

test("a branch file removed after opening is left unwritten", async () => {
	const cwd = await tempDir("absent");
	const manager = SessionManager.create(cwd, join(cwd, "sessions"));
	const file = manager.getSessionFile()!;
	await rm(file);
	// The record must not recreate a file behind the session's back.
	expect(appendSessionCacheAffinity(manager, "lineage")).toBe(false);
	expect(existsSync(file)).toBe(false);
});

test("a branch without its own record inherits the nearest recorded ancestor", async () => {
	const cwd = await tempDir("ancestor");
	const dir = join(cwd, "sessions");
	const root = SessionManager.create(cwd, dir);
	const rootFile = root.getSessionFile()!;
	appendSessionCacheAffinity(root, "lineage-root");

	// Branch file written before the record existed: header links the recorded ancestor.
	const branchFile = join(dir, "branch.jsonl");
	await writeFile(
		branchFile,
		`${JSON.stringify({ type: "session", version: 1, id: "branch-session", timestamp: "t", cwd, parentSession: rootFile })}\n`,
	);
	const branch = SessionManager.open(branchFile, dir);
	expect(readSessionCacheAffinityHint(branchFile)).toBeUndefined();
	expect(recordedCacheAffinityId(branch)).toBe("lineage-root");
});

test("unknown versions, wrong types and unreadable paths are ignored", async () => {
	const cwd = await tempDir("invalid");
	const manager = SessionManager.create(cwd, join(cwd, "sessions"));
	const file = manager.getSessionFile()!;
	for (const data of [
		{ version: 2, affinityId: "future" },
		{ version: 1, affinityId: 7 },
		{ version: 1 },
		undefined,
	]) {
		await writeFile(
			file,
			`${[
				manager.getEntries()[0],
				{
					type: "custom",
					customType: SESSION_CACHE_AFFINITY_ENTRY,
					data,
					id: "hint",
					parentId: null,
					timestamp: "t",
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		expect(readSessionCacheAffinityHint(file)).toBeUndefined();
	}
	expect(readSessionCacheAffinityHint(join(cwd, "missing.jsonl"))).toBeUndefined();
	expect(resolveSessionCacheAffinityId(manager)).toBe(manager.getSessionId());
});

test("the record is written once and survives reopening", async () => {
	const cwd = await tempDir("persist");
	const manager = SessionManager.create(cwd, join(cwd, "sessions"));
	await flushSession(manager);
	appendSessionCacheAffinity(manager, "lineage-a");
	appendSessionCacheAffinity(manager, "lineage-b");
	const file = manager.getSessionFile()!;
	const hints = (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { customType?: string; data?: { affinityId?: string } })
		.filter((entry) => entry.customType === SESSION_CACHE_AFFINITY_ENTRY);
	expect(hints).toEqual([expect.objectContaining({ data: { version: 1, affinityId: "lineage-a" } })]);
	expect(recordedCacheAffinityId(SessionManager.open(file, join(cwd, "sessions")))).toBe("lineage-a");
});

test("an unreadable parent chain falls back to the session id", async () => {
	const cwd = await tempDir("broken");
	const dir = join(cwd, "sessions");
	await mkdir(dir, { recursive: true });
	const file = join(dir, "broken.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({
			type: "session",
			version: 1,
			id: "broken-session",
			timestamp: "t",
			cwd,
			parentSession: join(dir, "missing-parent.jsonl"),
		})}\n`,
	);
	const manager = SessionManager.open(file, dir);
	expect(resolveSessionCacheAffinityId(manager)).toBe(manager.getSessionId());
});
