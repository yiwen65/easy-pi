import { spawnSync } from "node:child_process";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendFileSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CustomEntry,
	type FileEntry,
	getTaskRecoveryResultReceipts,
	loadEntriesFromFile,
	parseSessionEntries,
	rewriteSessionRecoveryFile,
	SessionManager,
	writeSessionFile,
} from "../../src/core/session-manager.ts";
import { TaskRecoveryJournal, type TaskRecoveryState } from "../../src/core/task-recovery.ts";

vi.mock("fs", async (original) => {
	const fs = await original<typeof Fs>();
	return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), readSync: vi.fn(fs.readSync) };
});

type Field = "prompt" | "systemPrompt" | "suspendedTasks";
type PhysicalEntry = CustomEntry<Record<string, unknown>> & {
	recoveryStorage?: { version: number; refs: Partial<Record<Field, { entryId: string; sha256: string }>> };
};

function physicalEntries(file: string): PhysicalEntry[] {
	return readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as PhysicalEntry);
}

function data(manager: SessionManager, id: string): TaskRecoveryState {
	return (manager.getEntry(id) as CustomEntry<TaskRecoveryState>).data!;
}

function snapshot(): TaskRecoveryState {
	return {
		version: 2,
		id: "task",
		status: "running",
		sourceLeafId: null,
		prompt: [{ role: "user", content: "prompt-unique".repeat(4000), timestamp: 1 }],
		promptEntryIds: ["input"],
		queued: [],
		systemPrompt: "system-unique".repeat(4000),
		retryAttempt: 0,
		tools: [],
		suspendedTasks: [
			{
				leafId: "anchor",
				state: {
					version: 2,
					id: "suspended",
					status: "needs_reconciliation",
					sourceLeafId: null,
					prompt: [{ role: "user", content: "suspended-unique".repeat(4000), timestamp: 1 }],
					promptEntryIds: ["suspended-input"],
					queued: [],
					retryAttempt: 0,
					tools: [],
				},
			},
		],
	};
}

describe("task recovery field storage", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-recovery-storage-"));
	});
	afterEach(() => {
		vi.mocked(fsyncSync).mockRestore();
		vi.mocked(readSync).mockRestore();
		rmSync(dir, { recursive: true, force: true });
	});

	it("stores repeated large fields once while retaining every snapshot", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "anchor", timestamp: 1 }, "anchor");
		const state = snapshot();
		manager.appendCustomEntry("pi-task-recovery", state);
		const file = manager.getSessionFile()!;
		const firstSize = statSync(file).size;
		for (let index = 1; index < 16; index++) {
			manager.appendCustomEntry("pi-task-recovery", { ...state, retryAttempt: index });
		}
		expect(statSync(file).size).toBeLessThan(firstSize * 1.2);
		expect(readFileSync(file, "utf8").match(/prompt-unique/g)).toHaveLength(4000);
		const reopened = SessionManager.open(file);
		expect(reopened.getEntries()).toHaveLength(17);
		expect(reopened.getLeafEntry()).toMatchObject({ data: { ...state, retryAttempt: 15 } });
		const beforeAppend = statSync(file).size;
		reopened.appendCustomEntry("pi-task-recovery", { ...state, retryAttempt: 16 });
		expect(statSync(file).size - beforeAppend).toBeLessThan(2000);
		expect(new TaskRecoveryJournal(reopened).state?.retryAttempt).toBe(16);
	});

	it.each<Field>(["prompt", "systemPrompt", "suspendedTasks"])(
		"stores only a changed %s field inline and references direct sources",
		(field) => {
			const manager = SessionManager.create(dir, dir);
			const original = snapshot();
			const first = manager.appendCustomEntry("pi-task-recovery", original);
			const changed = snapshot();
			if (field === "prompt") changed.prompt = [{ role: "user", content: "new-prompt".repeat(1000), timestamp: 2 }];
			else if (field === "systemPrompt") changed.systemPrompt = "new-system".repeat(1000);
			else changed.suspendedTasks![0].state.status = "cancelled";
			const second = manager.appendCustomEntry("pi-task-recovery", changed);
			const third = manager.appendCustomEntry("pi-task-recovery", changed);
			const fourth = manager.appendCustomEntry("pi-task-recovery", original);
			const physical = physicalEntries(manager.getSessionFile()!);
			expect(physical[2].data?.[field]).toEqual(changed[field]);
			expect(physical[2].recoveryStorage?.refs[field]).toBeUndefined();
			expect(physical[3].recoveryStorage?.refs[field]?.entryId).toBe(second);
			expect(physical[4].recoveryStorage?.refs[field]?.entryId).toBe(first);
			for (const other of ["prompt", "systemPrompt", "suspendedTasks"] as const) {
				if (other !== field) expect(physical[2].recoveryStorage?.refs[other]?.entryId).toBe(first);
			}
			for (const selected of [manager, SessionManager.open(manager.getSessionFile()!)]) {
				expect(data(selected, second)).toEqual(changed);
				expect(data(selected, third)).toEqual(changed);
				expect(data(selected, fourth)).toEqual(original);
			}
		},
	);

	it("keeps arbitrary recovery data, unrelated custom data and small fields inline", () => {
		const manager = SessionManager.create(dir, dir);
		const values = [
			undefined,
			null,
			42,
			"ordinary",
			[1, 2],
			{ status: "running" },
			{ prompt: {}, systemPrompt: 3, suspendedTasks: null },
			{ prompt: [], systemPrompt: "short", suspendedTasks: [] },
		];
		const ids = values.map((value) => manager.appendCustomEntry("pi-task-recovery", value));
		for (const value of values) manager.appendCustomEntry("pi-task-recovery", value);
		const unrelated = manager.appendCustomEntry("other-extension", snapshot());
		const physical = physicalEntries(manager.getSessionFile()!);
		expect(physical.every((entry) => entry.recoveryStorage === undefined)).toBe(true);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		ids.forEach((id, index) => {
			expect((reopened.getEntry(id) as CustomEntry).data).toEqual(values[index]);
		});
		expect(reopened.getEntry(unrelated)).toMatchObject({ customType: "other-extension", data: snapshot() });
	});

	it("isolates every decoded snapshot and strips physical metadata at all read boundaries", () => {
		for (const manager of [SessionManager.create(dir, dir), SessionManager.inMemory(dir)]) {
			const state = snapshot();
			const first = manager.appendCustomEntry("pi-task-recovery", state);
			const second = manager.appendCustomEntry("pi-task-recovery", state);
			state.prompt.length = 0;
			state.suspendedTasks![0].state.id = "caller mutation";
			const decoded = data(manager, second);
			decoded.prompt.length = 0;
			decoded.suspendedTasks![0].state.id = "reader mutation";
			expect(data(manager, first)).toEqual(snapshot());
			expect(data(manager, second)).toEqual(snapshot());
			if (!manager.isPersisted()) {
				manager.createBranchedSession(second);
				expect(data(manager, second)).toEqual(snapshot());
				continue;
			}
			const file = manager.getSessionFile()!;
			for (const entries of [loadEntriesFromFile(file), parseSessionEntries(readFileSync(file, "utf8"))]) {
				const entry = entries.find((entry) => entry.id === second) as CustomEntry<TaskRecoveryState>;
				expect(entry).not.toHaveProperty("recoveryStorage");
				entry.data!.suspendedTasks!.length = 0;
				expect(entry.data).toEqual(snapshot());
				expect(JSON.parse(JSON.stringify(entry))).toMatchObject({ data: snapshot() });
			}
		}
	});

	it("does not commit an un-synced source to the dictionary or advance the leaf", () => {
		const manager = SessionManager.create(dir, dir);
		const first = manager.appendCustomEntry("pi-task-recovery", snapshot());
		const file = manager.getSessionFile()!;
		const before = readFileSync(file, "utf8");
		const identity = statSync(file);
		const originalSync = vi.mocked(fsyncSync).getMockImplementation()!;
		let failed = false;
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			const target = fstatSync(fd);
			if (!failed && target.ino === identity.ino && target.dev === identity.dev) {
				failed = true;
				throw new Error("injected record fsync failure");
			}
			originalSync(fd);
		});
		const changed = { ...snapshot(), systemPrompt: "uncommitted-system".repeat(4000) };
		expect(() => manager.appendCustomEntry("pi-task-recovery", changed)).toThrow(/injected/);
		expect(failed).toBe(true);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(manager.getLeafId()).toBe(first);
		expect(manager.getEntries()).toHaveLength(1);
		const committed = manager.appendCustomEntry("pi-task-recovery", changed);
		manager.appendCustomEntry("pi-task-recovery", changed);
		const physical = physicalEntries(file);
		expect(physical[2].data?.systemPrompt).toBe(changed.systemPrompt);
		expect(physical[3].recoveryStorage?.refs.systemPrompt?.entryId).toBe(committed);
		expect(SessionManager.open(file).getLeafEntry()).toMatchObject({ data: changed });
	});

	it.each(["replace", "overwrite"])("rejects same-size %s of dictionary backing bytes", (kind) => {
		const manager = SessionManager.create(dir, dir);
		manager.appendCustomEntry("pi-task-recovery", snapshot());
		const file = manager.getSessionFile()!;
		const before = statSync(file);
		const changed = readFileSync(file, "utf8").replace("prompt-unique", "prompt-broken");
		if (kind === "replace") {
			const replacement = join(dir, "replacement.jsonl");
			writeFileSync(replacement, changed);
			renameSync(replacement, file);
		} else writeFileSync(file, changed);
		utimesSync(file, before.atime, before.mtime);
		expect(statSync(file).size).toBe(before.size);
		expect(() => manager.appendCustomEntry("pi-task-recovery", snapshot())).toThrow(/reopen/);
		expect(manager.getEntries()).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe(changed);
	});

	it.each([
		"missing",
		"future",
		"cycle",
		"indirect",
		"wrong-field",
		"bad-hash",
		"bad-type",
		"inline-and-ref",
		"unknown-field",
		"version",
		"non-recovery",
	])("rejects %s references without silently dropping the record", (kind) => {
		const manager = SessionManager.create(dir, dir);
		manager.appendCustomEntry("pi-task-recovery", snapshot());
		manager.appendCustomEntry("pi-task-recovery", snapshot());
		manager.appendCustomEntry("pi-task-recovery", snapshot());
		const file = manager.getSessionFile()!;
		const entries = physicalEntries(file);
		const target = entries[2];
		const reference = target.recoveryStorage!.refs.prompt!;
		if (kind === "missing") reference.entryId = "absent";
		else if (kind === "future") reference.entryId = entries[3].id;
		else if (kind === "cycle") reference.entryId = target.id;
		else if (kind === "indirect") entries[3].recoveryStorage!.refs.prompt!.entryId = target.id;
		else if (kind === "wrong-field") reference.sha256 = target.recoveryStorage!.refs.suspendedTasks!.sha256;
		else if (kind === "bad-hash") reference.sha256 = "0".repeat(64);
		else if (kind === "bad-type") entries[1].data!.prompt = "not-an-array";
		else if (kind === "inline-and-ref") target.data!.prompt = snapshot().prompt;
		else if (kind === "unknown-field") Object.assign(target.recoveryStorage!.refs, { tools: reference });
		else if (kind === "version") target.recoveryStorage!.version = 2;
		else if (kind === "non-recovery") target.customType = "another-extension";
		const corrupted = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(file, corrupted);
		expect(() => parseSessionEntries(corrupted)).toThrow(/recovery storage/i);
		expect(() => loadEntriesFromFile(file)).toThrow(/recovery storage/i);
		expect(() => SessionManager.open(file)).toThrow(/recovery storage/i);
		expect(readFileSync(file, "utf8")).toBe(corrupted);
	});

	it("validates source bytes again on lazy decoding", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendCustomEntry("pi-task-recovery", snapshot());
		const second = manager.appendCustomEntry("pi-task-recovery", snapshot());
		const file = manager.getSessionFile()!;
		const opened = SessionManager.open(file);
		writeFileSync(file, readFileSync(file, "utf8").replace("prompt-unique", "prompt-broken"));
		expect(() => data(opened, second)).toThrow(/corrupt.*source/i);
	});

	it("shares bytes across branches without changing selected state, provenance or clone independence", () => {
		const manager = SessionManager.create(dir, dir);
		const root = manager.appendMessage({ role: "user", content: "anchor", timestamp: 1 }, "anchor");
		const sourceSessionId = manager.getSessionId();
		const state = snapshot();
		const abandoned = manager.appendCustomEntry("pi-task-recovery", { ...state, status: "completed" });
		manager.branch(root);
		const active = manager.appendCustomEntry("pi-task-recovery", { ...state, status: "cancelled" });
		const file = manager.getSessionFile()!;
		expect(physicalEntries(file).at(-1)?.recoveryStorage?.refs.prompt?.entryId).toBe(abandoned);
		expect(new TaskRecoveryJournal(manager).state?.status).toBe("cancelled");
		manager.branch(abandoned);
		expect(new TaskRecoveryJournal(manager).state?.status).toBe("completed");
		const clone = manager.createBranchedSession(active)!;
		expect(physicalEntries(clone).at(-1)?.recoveryStorage).toBeUndefined();
		const fork = SessionManager.forkFrom(file, dir, dir);
		const expected = loadEntriesFromFile(fork.getSessionFile()!).map(
			(entry) => JSON.parse(JSON.stringify(entry)) as FileEntry,
		);
		rmSync(file);
		for (const copy of [manager, SessionManager.open(clone), fork, SessionManager.open(fork.getSessionFile()!)]) {
			expect(new TaskRecoveryJournal(copy).state).toBeUndefined();
			expect(copy.getEntry(active)).toMatchObject({
				parentId: root,
				sourceSessionId,
				data: { ...state, status: "cancelled" },
			});
		}
		rmSync(clone);
		expect(loadEntriesFromFile(fork.getSessionFile()!)).toEqual(expected);
	});

	it("rebinds repaired offsets and keeps previous inode-backed entries readable", () => {
		const manager = SessionManager.create(dir, dir);
		const first = manager.appendCustomEntry("pi-task-recovery", snapshot());
		const second = manager.appendCustomEntry("pi-task-recovery", snapshot());
		const file = manager.getSessionFile()!;
		appendFileSync(file, '{"torn":');
		const reopened = SessionManager.open(file);
		const historical = reopened.getEntry(second) as CustomEntry;
		const third = reopened.appendCustomEntry("pi-task-recovery", {
			...snapshot(),
			systemPrompt: "changed".repeat(1000),
		});
		const before = statSync(file).size;
		const fourth = reopened.appendCustomEntry("pi-task-recovery", snapshot());
		expect(statSync(file).size - before).toBeLessThan(2000);
		expect(physicalEntries(file).at(-1)?.recoveryStorage?.refs.prompt?.entryId).toBe(first);
		expect(data(reopened, third).systemPrompt).toBe("changed".repeat(1000));
		expect(data(SessionManager.open(file), fourth)).toEqual(snapshot());
		rmSync(file);
		expect(historical.data).toEqual(snapshot());
		expect(data(reopened, third).systemPrompt).toBe("changed".repeat(1000));
	});

	it("retains only small receipt projections for referenced suspended tasks", () => {
		const manager = SessionManager.create(dir, dir);
		const state = snapshot();
		state.suspendedTasks![0].state.step = { sourceLeafId: null, assistantEntryId: "assistant", items: [] };
		state.suspendedTasks![0].state.tools = [
			{
				call: { type: "toolCall", id: "call", name: "read", arguments: {} },
				safe: true,
				dispatched: true,
				resultEntryId: "result",
			},
		];
		for (let index = 0; index < 20; index++) manager.appendCustomEntry("pi-task-recovery", state);
		vi.mocked(readSync).mockClear();
		const reopened = SessionManager.open(manager.getSessionFile()!);
		// One header read plus the sequential scan; references don't reread large source records on open.
		expect(vi.mocked(readSync).mock.calls.length).toBeLessThan(6);
		vi.mocked(readSync).mockClear();
		for (const entry of reopened.getEntries()) {
			if (entry.type !== "custom") continue;
			Object.defineProperty(entry, "data", {
				get: () => {
					throw new Error("payload decoded");
				},
			});
			expect(getTaskRecoveryResultReceipts(entry)).toEqual([
				{ assistantEntryId: "assistant", resultEntryId: "result", callId: "call", toolName: "read" },
			]);
		}
		expect(vi.mocked(readSync)).not.toHaveBeenCalled();
	});

	it("rewrites same-identity independent copies, preserving all logical metadata", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "anchor", timestamp: 1 }, "anchor");
		const first = manager.appendCustomEntry("pi-task-recovery", snapshot());
		manager.appendLabelChange(first, "label");
		manager.appendCustomEntry("pi-task-recovery", { ...snapshot(), status: "interrupted" });
		manager.appendSessionInfo("session name");
		const file = manager.getSessionFile()!;
		const expected = loadEntriesFromFile(file).map((entry) => JSON.parse(JSON.stringify(entry)) as FileEntry);
		// Simulate legacy fully-inline records. A migration must not change identities or mark them audit-only.
		writeFileSync(file, `${expected.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const before = readFileSync(file);
		const destination = join(dir, "rewritten.jsonl");
		rewriteSessionRecoveryFile(file, destination);
		expect(readFileSync(file)).toEqual(before);
		expect(loadEntriesFromFile(destination)).toEqual(expected);
		expect(physicalEntries(destination).some((entry) => entry.recoveryStorage)).toBe(true);
		expect(() => rewriteSessionRecoveryFile(file, file)).toThrow(/destination/);
		expect(() => rewriteSessionRecoveryFile(file, destination)).toThrow(/destination/);
		rmSync(file);
		const copy = SessionManager.open(destination);
		expect(copy.getSessionId()).toBe(manager.getSessionId());
		expect(new TaskRecoveryJournal(copy).state?.status).toBe("interrupted");
	});

	it("rejects damaged migration sources and cleans an unpublished write on validation failure", () => {
		const manager = SessionManager.create(dir, dir);
		const file = manager.getSessionFile()!;
		appendFileSync(file, '{"torn":');
		const destination = join(dir, "not-published.jsonl");
		expect(() => rewriteSessionRecoveryFile(file, destination)).toThrow(/damaged/);
		expect(existsSync(destination)).toBe(false);
		expect(() =>
			writeSessionFile(destination, [manager.getHeader()!], true, () => {
				throw new Error("validation failed");
			}),
		).toThrow(/validation/);
		expect(existsSync(destination)).toBe(false);
		expect(readdirSync(dir)).toEqual([file.split("/").at(-1)]);
	});

	it("refuses to publish a migration if the source changes during the rewrite", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendCustomEntry("pi-task-recovery", snapshot());
		const file = manager.getSessionFile()!;
		const sourceIdentity = statSync(file);
		const originalSync = vi.mocked(fsyncSync).getMockImplementation()!;
		let changed = false;
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			originalSync(fd);
			if (!changed && fstatSync(fd).isFile() && fstatSync(fd).ino !== sourceIdentity.ino) {
				changed = true;
				appendFileSync(file, "\n");
			}
		});
		const destination = join(dir, "not-published.jsonl");
		expect(() => rewriteSessionRecoveryFile(file, destination)).toThrow(/source changed/);
		expect(changed).toBe(true);
		expect(existsSync(destination)).toBe(false);
		expect(readdirSync(dir)).toEqual([file.split("/").at(-1)]);
	});

	it("traverses many compact snapshots under a bounded heap without caching decoded fields", () => {
		const manager = SessionManager.create(dir, dir);
		const state = { prompt: [{ role: "user", content: "x".repeat(1024 * 1024), timestamp: 1 }], tools: [] };
		for (let index = 0; index < 180; index++) manager.appendCustomEntry("pi-task-recovery", { ...state, index });
		const source = new URL("../../src/core/session-manager.ts", import.meta.url).href;
		const script = join(dir, "bounded.mts");
		writeFileSync(
			script,
			[
				`import { SessionManager } from ${JSON.stringify(source)};`,
				`const manager = SessionManager.open(${JSON.stringify(manager.getSessionFile())});`,
				`const entries = manager.getEntries();`,
				`if (entries.length !== 180) throw new Error("history lost");`,
				`for (const entry of entries) if (entry.data.prompt[0].content.length !== 1048576) throw new Error("payload lost");`,
				`console.log("bounded decoding passed");`,
			].join("\n"),
		);
		const result = spawnSync(process.execPath, ["--max-old-space-size=96", script], {
			encoding: "utf8",
			timeout: 60000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("bounded decoding passed");
	}, 90000);
});
