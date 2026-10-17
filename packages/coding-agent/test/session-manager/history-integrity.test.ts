import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../../src/core/task-recovery.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-history-integrity-")));
	dirs.push(dir);
	return dir;
}

test.each([1, 2])("forkFrom migrates v%s under its original header without rewriting the source", (version) => {
	const dir = directory();
	const file = join(dir, "legacy.jsonl");
	const entries = [
		{ type: "session", version, id: "legacy", timestamp: new Date().toISOString(), cwd: dir },
		{
			type: "message",
			...(version === 2 ? { id: "user", parentId: null } : {}),
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "legacy prompt", timestamp: 1 },
		},
		{
			type: "message",
			...(version === 2 ? { id: "hook", parentId: "user" } : {}),
			timestamp: new Date().toISOString(),
			message: {
				role: "hookMessage",
				customType: "legacy-hook",
				content: "legacy context",
				display: false,
				timestamp: 2,
			},
		},
	];
	const bytes = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	writeFileSync(file, bytes);
	const fork = SessionManager.forkFrom(file, dir, join(dir, "forks"));
	expect(fork.getHeader()?.version).toBe(3);
	const context = fork.buildSessionContext().messages;
	expect(context.map((message) => message.role)).toEqual(["user", "custom"]);
	expect(fork.getBranch()).toHaveLength(2);
	expect(fork.getEntries()[1].parentId).toBe(fork.getEntries()[0].id);
	expect(SessionManager.open(fork.getSessionFile()!).buildSessionContext().messages).toEqual(context);
	expect(readFileSync(file, "utf8")).toBe(bytes);
});

test("forkFrom retains recovery facts but does not inherit pending work", () => {
	const dir = directory();
	const source = SessionManager.create(dir, dir);
	const journal = new TaskRecoveryJournal(source);
	journal.start([{ role: "user", content: "unsubmitted in clone", timestamp: 1 }]);
	journal.queue("followUp", [{ role: "user", content: "queued", timestamp: 2 }]);
	const bytes = readFileSync(source.getSessionFile()!);
	const fork = SessionManager.forkFrom(source.getSessionFile()!, dir, join(dir, "forks"));
	expect(new TaskRecoveryJournal(fork).state).toBeUndefined();
	expect(new TaskRecoveryJournal(SessionManager.open(fork.getSessionFile()!)).state).toBeUndefined();
	expect(fork.getEntries()).toEqual(
		source.getEntries().map((entry) => ({ ...entry, sourceSessionId: source.getSessionId() })),
	);
	expect(readFileSync(source.getSessionFile()!).equals(bytes)).toBe(true);
});

test.each(["self", "pair", "duplicate"] as const)(
	"rejects %s-linked history without hanging, rewriting, or replacing active state",
	(shape) => {
		const dir = directory();
		const file = join(dir, "invalid.jsonl");
		const header = { type: "session", version: 3, id: "invalid", timestamp: new Date().toISOString(), cwd: dir };
		const records = [
			{
				type: "message",
				id: "a",
				parentId: shape === "self" ? "a" : shape === "pair" ? "b" : null,
				timestamp: header.timestamp,
				message: { role: "user", content: "a", timestamp: 1 },
			},
			...(shape === "self"
				? []
				: [
						{
							type: "message",
							id: shape === "duplicate" ? "a" : "b",
							parentId: "a",
							timestamp: header.timestamp,
							message: { role: "user", content: "b", timestamp: 2 },
						},
					]),
		];
		const bytes = `${[header, ...records].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(file, bytes);
		const probe = join(dir, "probe.mjs");
		writeFileSync(
			probe,
			[
				`import { SessionManager, buildSessionContext } from ${JSON.stringify(new URL("../../src/core/session-manager.ts", import.meta.url).href)};`,
				`import { readFileSync } from 'node:fs';`,
				`const records = readFileSync(process.argv[2], 'utf8').trim().split('\\n').map(JSON.parse);`,
				`const manager = SessionManager.inMemory(process.cwd());`,
				`const original = manager.getSessionId();`,
				`try { manager.setSessionFile(process.argv[2]); manager.buildSessionContext(); process.exit(2); } catch (error) { if (!/cycle|duplicate/i.test(error.message)) throw error; if (manager.getSessionId() !== original) process.exit(3); }`,
				`try { buildSessionContext(records.slice(1)); process.exit(4); } catch (error) { if (!/cycle|duplicate/i.test(error.message)) throw error; }`,
				`process.stdout.write('rejected');`,
			].join("\n"),
		);
		const result = spawnSync(process.execPath, [probe, file], { timeout: 5000, encoding: "utf8" });
		expect(result.error?.message).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("rejected");
		expect(readFileSync(file, "utf8")).toBe(bytes);
		const before = readdirSync(dir);
		expect(() => SessionManager.forkFrom(file, dir, dir)).toThrow(/cycle|duplicate/i);
		expect(readdirSync(dir)).toEqual(before);
	},
);

test("session file aliases share canonical task ownership without changing source bytes", () => {
	const dir = directory();
	const manager = SessionManager.create(dir, dir);
	const source = manager.getSessionFile()!;
	const bytes = readFileSync(source);
	const alias = join(dir, "alias.jsonl");
	symlinkSync(source, alias);
	const opened = SessionManager.open(alias, dir);
	expect(opened.getSessionFile()).toBe(source);
	expect(readFileSync(source).equals(bytes)).toBe(true);
	const journal = new TaskRecoveryJournal(opened);
	journal.acquire();
	try {
		expect(existsSync(`${source}.task.lock`)).toBe(true);
		expect(existsSync(`${alias}.task.lock`)).toBe(false);
		expect(() => new TaskRecoveryJournal(manager).acquire()).toThrow(/owns this session/);
	} finally {
		journal.release();
	}
});

test("getBranch refuses cycles introduced through borrowed entries while preserving the file", () => {
	const dir = directory();
	const manager = SessionManager.create(dir, dir);
	const id = manager.appendMessage({ role: "user", content: "safe", timestamp: 1 });
	const file = manager.getSessionFile()!;
	const bytes = readFileSync(file);
	const probe = join(dir, "probe.mjs");
	writeFileSync(
		probe,
		[
			`import { SessionManager } from ${JSON.stringify(new URL("../../src/core/session-manager.ts", import.meta.url).href)};`,
			`const manager = SessionManager.open(process.argv[2]); manager.getEntry(${JSON.stringify(id)}).parentId = ${JSON.stringify(id)};`,
			`try { manager.getBranch(); process.exit(2); } catch (error) { if (!/cycle/i.test(error.message)) throw error; }`,
		].join("\n"),
	);
	const result = spawnSync(process.execPath, [probe, file], { timeout: 5000, encoding: "utf8" });
	expect(result.error?.message).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(readFileSync(file).equals(bytes)).toBe(true);
});
