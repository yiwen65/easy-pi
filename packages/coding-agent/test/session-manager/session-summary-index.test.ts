import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type * as Fs from "node:fs";
import {
	appendFileSync,
	chmodSync,
	createReadStream,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { RecoveryStorageIndex } from "../../src/core/recovery-storage.ts";
import {
	loadEntriesFromFile,
	type SessionInfo,
	SessionManager,
	writeSessionFile,
} from "../../src/core/session-manager.ts";
import { flushSessionSummaries, forgetSessionSummary } from "../../src/core/session-summary-index.ts";
import { filterAndSortSessions } from "../../src/modes/interactive/components/session-selector-search.ts";

vi.mock("fs", async (original) => {
	const fs = await original<typeof Fs>();
	return {
		...fs,
		readSync: vi.fn(fs.readSync),
		createReadStream: vi.fn(fs.createReadStream),
		fsyncSync: vi.fn(fs.fsyncSync),
		renameSync: vi.fn(fs.renameSync),
	};
});

const originalStream = vi.mocked(createReadStream).getMockImplementation()!;
const originalSync = vi.mocked(fsyncSync).getMockImplementation()!;
const originalRename = vi.mocked(renameSync).getMockImplementation()!;

describe("session summary index", () => {
	let dir: string;
	let sessions: string;
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-summary-index-")));
		sessions = join(dir, "sessions");
		mkdirSync(sessions);
		vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
		vi.stubEnv("EPI_CODING_AGENT_DIR", join(dir, "agent"));
	});
	afterEach(() => {
		flushSessionSummaries();
		vi.mocked(createReadStream).mockReset().mockImplementation(originalStream);
		vi.mocked(fsyncSync).mockReset().mockImplementation(originalSync);
		vi.mocked(renameSync).mockReset().mockImplementation(originalRename);
		vi.clearAllMocks();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});
	function cacheFiles(): string[] {
		const index = join(dir, "agent", "session-index", "v1");
		return existsSync(index)
			? readdirSync(index)
					.filter((file) => file.endsWith(".json"))
					.map((file) => join(index, file))
			: [];
	}
	function freshList(blockSourceReads: boolean, scope = sessions): { rows: SessionInfo[]; reads: number } {
		const script = join(dir, "fresh.mts");
		const source = new URL("../../src/core/session-manager.ts", import.meta.url).href;
		writeFileSync(
			script,
			[
				'import fs from "node:fs";',
				'import { syncBuiltinESMExports } from "node:module";',
				`import { SessionManager } from ${JSON.stringify(source)};`,
				"let reads = 0;",
				"const stream = fs.createReadStream;",
				"const read = fs.readFileSync;",
				"const readFd = fs.readSync;",
				`const sourceIdentities = new Set(fs.readdirSync(${JSON.stringify(sessions)}).filter((name) => name.endsWith(".jsonl")).map((name) => { const info = fs.statSync(${JSON.stringify(sessions)} + "/" + name); return info.dev + ":" + info.ino; }));`,
				`const check = (path) => { if (String(path).endsWith(".jsonl")) { reads++; if (${blockSourceReads}) throw new Error("source read forbidden"); } };`,
				"fs.createReadStream = (path, ...args) => { check(path); return stream(path, ...args); };",
				"fs.readFileSync = (path, ...args) => { check(path); return read(path, ...args); };",
				'fs.readSync = (fd, ...args) => { const info = fs.fstatSync(fd); if (sourceIdentities.has(info.dev + ":" + info.ino)) check("source.jsonl"); return readFd(fd, ...args); };',
				"syncBuiltinESMExports();",
				`const rows = await SessionManager.list(${JSON.stringify(dir)}, ${JSON.stringify(scope)});`,
				"console.log(JSON.stringify({ rows, reads }));",
			].join("\n"),
		);
		const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30000 });
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(result.stdout) as { rows: SessionInfo[]; reads: number };
	}
	function sourceFile(): string {
		const file = join(sessions, "test.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "test", timestamp: "2025-01-01T00:00:00Z", cwd: dir })}\n${JSON.stringify({ type: "message", id: "input", parentId: null, timestamp: "2025-01-02T00:00:00Z", message: { role: "user", content: "first searchable text", timestamp: 42 } })}\n`,
		);
		return file;
	}
	function expectNoSourceReads(): void {
		expect(vi.mocked(createReadStream).mock.calls.filter(([path]) => String(path).endsWith(".jsonl"))).toHaveLength(
			0,
		);
		expect(vi.mocked(readSync)).not.toHaveBeenCalled();
	}
	it("does not reread JSONL on a warm list", async () => {
		sourceFile();
		const cold = await SessionManager.list(dir, sessions);
		expect(cold).toHaveLength(1);
		vi.clearAllMocks();
		expect(await SessionManager.list(dir, sessions)).toEqual(cold);
		expectNoSourceReads();
	});
	it("updates committed appends and name clears without rescanning old bytes", async () => {
		const file = sourceFile();
		const manager = SessionManager.open(file);
		await SessionManager.list(dir, sessions);
		vi.clearAllMocks();
		manager.appendMessage({ role: "user", content: "later phrase \n regex-needle", timestamp: 1234 });
		manager.appendSessionInfo("new name");
		let rows = await SessionManager.list(dir, sessions);
		expect(rows[0].name).toBe("new name");
		manager.appendSessionInfo("");
		rows = await SessionManager.list(dir, sessions);
		expect(freshList(true).rows).toEqual(JSON.parse(JSON.stringify(rows)));
		expect(rows[0].name).toBeUndefined();
		expect(rows[0].allMessagesText).toBe("first searchable text later phrase \n regex-needle");
		expect(rows[0].modified.getTime()).toBe(1234);
		expect(rows[0].messageCount).toBe(2);
		expectNoSourceReads();
	});

	it("reuses a private persistent index in a fresh process", async () => {
		sourceFile();
		const cold = await SessionManager.list(dir, sessions);
		expect(cacheFiles()).toHaveLength(1);
		expect(statSync(cacheFiles()[0]).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "agent", "session-index")).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "agent", "session-index", "v1")).mode & 0o777).toBe(0o700);
		const fresh = freshList(true);
		expect(fresh.reads).toBe(0);
		expect(fresh.rows).toEqual(JSON.parse(JSON.stringify(cold)));
	});

	it("keeps an already-listed source indexed when a fresh writer appends without opening the picker", async () => {
		const file = sourceFile();
		await SessionManager.list(dir, sessions);
		const script = join(dir, "writer.mts");
		const managerSource = new URL("../../src/core/session-manager.ts", import.meta.url).href;
		const indexSource = new URL("../../src/core/session-summary-index.ts", import.meta.url).href;
		writeFileSync(
			script,
			[
				`import { SessionManager } from ${JSON.stringify(managerSource)};`,
				`import { flushSessionSummaries } from ${JSON.stringify(indexSource)};`,
				`const manager = SessionManager.open(${JSON.stringify(file)});`,
				'manager.appendMessage({ role: "user", content: "writer after restart", timestamp: 12345 });',
				"flushSessionSummaries();",
			].join("\n"),
		);
		const writer = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30000 });
		expect(writer.status, writer.stderr).toBe(0);
		const fresh = freshList(true);
		expect(fresh.reads).toBe(0);
		expect(fresh.rows[0].allMessagesText).toBe("first searchable text writer after restart");
		expect(fresh.rows[0].messageCount).toBe(2);
	});

	it("retains complete user/assistant search text but not tool/recovery payloads", async () => {
		const manager = SessionManager.create(dir, join(dir, "writer"));
		manager.appendMessage({ role: "user", content: "preview only", timestamp: 10 });
		manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "later regex-needle exact phrase fuzzy-target" },
				{ type: "thinking", thinking: "secret-thinking" },
			],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 20,
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "private-tool-result" }],
			isError: false,
			timestamp: 30,
		});
		for (let i = 0; i < 100; i++)
			manager.appendCustomEntry("pi-task-recovery", {
				prompt: [{ role: "user", content: "private-recovery-payload".repeat(100), timestamp: 1 }],
				systemPrompt: "private-system".repeat(100),
				tools: [],
			});
		// Raw copy is not in the in-process writer cache: force a real cold physical scan.
		writeFileSync(join(sessions, "physical-copy.jsonl"), readFileSync(manager.getSessionFile()!));
		const decoder = vi.spyOn(RecoveryStorageIndex.prototype, "decode").mockImplementation(() => {
			throw new Error("must not decode");
		});
		try {
			const rows = await SessionManager.list(dir, sessions);
			expect(rows[0].allMessagesText).toBe("preview only later regex-needle exact phrase fuzzy-target");
			for (const query of ["re:regex-needle", '"exact phrase"', "fztrgt"])
				expect(filterAndSortSessions(rows, query, "recent")).toHaveLength(1);
			expect(rows[0].modified.getTime()).toBe(20);
			const cache = readFileSync(cacheFiles()[0], "utf8");
			for (const secret of [
				"private-tool-result",
				"private-recovery-payload",
				"private-system",
				"secret-thinking",
				"recoveryStorage",
			])
				expect(cache).not.toContain(secret);
			vi.clearAllMocks();
			expect(await SessionManager.list(dir, sessions)).toEqual(rows);
			expectNoSourceReads();
			expect(decoder).not.toHaveBeenCalled();
		} finally {
			decoder.mockRestore();
		}
	});

	it.each(["same-size", "replace", "truncate", "external-append"])(
		"rebuilds after an unknown %s edit",
		async (kind) => {
			const file = sourceFile();
			await SessionManager.list(dir, sessions);
			const before = statSync(file);
			const content = readFileSync(file, "utf8");
			if (kind === "same-size") {
				writeFileSync(file, content.replace("first searchable text", "other searchable text"));
				utimesSync(file, before.atime, before.mtime);
				expect(statSync(file).size).toBe(before.size);
			} else if (kind === "replace") {
				const replacement = join(dir, "replacement");
				writeFileSync(replacement, content.replace("first searchable text", "other searchable text"));
				renameSync(replacement, file);
			} else if (kind === "truncate") writeFileSync(file, `${content.split("\n")[0]}\n`);
			else appendFileSync(file, `${JSON.stringify({ type: "session_info", name: "external name" })}\n`);
			vi.clearAllMocks();
			const rows = await SessionManager.list(dir, sessions);
			expect(vi.mocked(createReadStream)).toHaveBeenCalled();
			expect(rows).toHaveLength(1);
			if (kind === "truncate") {
				expect(rows[0].messageCount).toBe(0);
				expect(rows[0].isMetadataOnly).toBe(true);
			} else if (kind === "external-append") expect(rows[0].name).toBe("external name");
			else expect(rows[0].allMessagesText).toBe("other searchable text");
			expect(freshList(true).rows).toEqual(JSON.parse(JSON.stringify(rows)));
		},
	);

	it.each(["syntax", "version", "shape", "fingerprint"])("rebuilds a %s-corrupt disk cache", async (kind) => {
		sourceFile();
		const rows = await SessionManager.list(dir, sessions);
		const file = cacheFiles()[0];
		const record = JSON.parse(readFileSync(file, "utf8"));
		if (kind === "version") record.version = 999;
		else if (kind === "shape") record.projection.allMessagesText = 42;
		else if (kind === "fingerprint") record.fingerprint[4] = "0";
		writeFileSync(file, kind === "syntax" ? "{" : JSON.stringify(record));
		const fresh = freshList(false);
		expect(fresh.reads).toBe(1);
		expect(fresh.rows).toEqual(JSON.parse(JSON.stringify(rows)));
		expect(freshList(true).reads).toBe(0);
	});

	it("never publishes a cache when source bytes change during scanning", async () => {
		const file = sourceFile();
		vi.mocked(createReadStream).mockImplementationOnce((...args) => {
			const stream = originalStream(...args);
			stream.once("data", () =>
				writeFileSync(file, readFileSync(file, "utf8").replace("first searchable text", "other searchable text")),
			);
			return stream;
		});
		expect(await SessionManager.list(dir, sessions)).toEqual([]);
		expect(cacheFiles()).toHaveLength(0);
		expect((await SessionManager.list(dir, sessions))[0].allMessagesText).toBe("other searchable text");
		expect(freshList(true).rows[0].allMessagesText).toBe("other searchable text");
	});

	it("cache write failures cannot fail source commits, even on later background flush", async () => {
		const manager = SessionManager.create(dir, sessions);
		await SessionManager.list(dir, sessions);
		vi.mocked(renameSync).mockImplementation((old, destination) => {
			if (String(destination).endsWith(".json")) throw new Error("cache permission denied");
			return originalRename(old, destination);
		});
		expect(() => manager.appendMessage({ role: "user", content: "durable", timestamp: 500 })).not.toThrow();
		expect(() => flushSessionSummaries()).not.toThrow();
		expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain("durable");
		expect((await SessionManager.list(dir, sessions))[0].allMessagesText).toBe("durable");
	});

	it("a failed or stale writer never advances the projection", async () => {
		const manager = SessionManager.create(dir, sessions);
		manager.appendMessage({ role: "user", content: "committed", timestamp: 100 });
		await SessionManager.list(dir, sessions);
		const file = manager.getSessionFile()!;
		const inode = statSync(file).ino;
		let failed = false;
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			if (!failed && fstatSync(fd).ino === inode) {
				failed = true;
				throw new Error("source fsync failure");
			}
			return originalSync(fd);
		});
		expect(() => manager.appendMessage({ role: "user", content: "uncommitted", timestamp: 200 })).toThrow(
			/source fsync/,
		);
		expect((await SessionManager.list(dir, sessions))[0].allMessagesText).toBe("committed");
		appendFileSync(file, `${JSON.stringify({ type: "session_info", name: "external" })}\n`);
		expect(() => manager.appendSessionInfo("stale")).toThrow(/reopen/);
		expect((await SessionManager.list(dir, sessions))[0].name).toBe("external");
	});

	it("reuses projections from loading/new/rewrite/repair/clone/fork without duplicate messages", async () => {
		const file = sourceFile();
		const manager = SessionManager.open(file);
		vi.clearAllMocks();
		expect((await SessionManager.list(dir, sessions))[0].messageCount).toBe(1);
		expectNoSourceReads();
		appendFileSync(file, '{"torn":');
		const repaired = SessionManager.open(file);
		repaired.appendMessage({ role: "user", content: "after repair", timestamp: 300 });
		vi.clearAllMocks();
		expect((await SessionManager.list(dir, sessions))[0].allMessagesText).toBe("first searchable text after repair");
		expectNoSourceReads();
		writeSessionFile(file, [manager.getHeader()!]);
		vi.clearAllMocks();
		expect((await SessionManager.list(dir, sessions))[0].messageCount).toBe(0);
		expectNoSourceReads();
		const current = SessionManager.create(dir, sessions);
		const leaf = current.appendMessage({ role: "user", content: "clone text", timestamp: 700 });
		current.createBranchedSession(leaf);
		SessionManager.forkFrom(current.getSessionFile()!, dir, sessions);
		vi.clearAllMocks();
		const rows = await SessionManager.list(dir, sessions);
		expect(rows.filter((row) => row.allMessagesText === "clone text")).toHaveLength(3);
		expectNoSourceReads();
	});

	it.each([
		["header", [], true],
		["model", [{ type: "model_change" }, { type: "thinking_level_change" }], true],
		[
			"initializers",
			[
				{ type: "custom", customType: "epi-session-cache-affinity" },
				{ type: "custom", customType: "codex-service-tier" },
			],
			true,
		],
		[
			"cleared name",
			[
				{ type: "session_info", name: "named" },
				{ type: "session_info", name: " " },
			],
			true,
		],
		["named", [{ type: "session_info", name: "important" }], false],
		["empty message", [{ type: "message", message: { role: "user", content: "" } }], false],
		[
			"image only",
			[
				{
					type: "message",
					message: { role: "user", content: [{ type: "image", data: "private", mimeType: "image/png" }] },
				},
			],
			false,
		],
		["custom_message", [{ type: "custom_message" }], false],
		["compaction", [{ type: "compaction" }], false],
		["branch_summary", [{ type: "branch_summary" }], false],
		["label", [{ type: "label" }], false],
		["recovery", [{ type: "custom", customType: "pi-task-recovery" }], false],
		["unknown custom", [{ type: "custom", customType: "future-extension" }], false],
		["unknown type", [{ type: "future-type" }], false],
	])("classifies %s conservatively", async (_label, entries, empty) => {
		const file = sourceFile();
		const header = readFileSync(file, "utf8").split("\n")[0];
		writeFileSync(file, [header, ...entries.map((entry) => JSON.stringify(entry)), ""].join("\n"));
		const rows = await SessionManager.list(dir, sessions);
		expect(rows).toHaveLength(1);
		expect(rows[0].isMetadataOnly).toBe(empty);
		expect(freshList(true).rows[0].isMetadataOnly).toBe(empty);
	});

	it("filters custom-cwd partials before publication and counts invalid files", async () => {
		SessionManager.create(join(dir, "other"), sessions);
		const current = SessionManager.create(dir, sessions);
		current.appendMessage({ role: "user", content: "current", timestamp: 100 });
		writeFileSync(join(sessions, "invalid.jsonl"), "not json\n");
		const calls: Array<{ loaded: number; total: number; partial?: readonly SessionInfo[] }> = [];
		const rows = await SessionManager.list(dir, sessions, (loaded, total, partial) =>
			calls.push({ loaded, total, partial }),
		);
		expect(calls[0]).toEqual({ loaded: 0, total: 3, partial: [] });
		expect(calls.at(-1)).toEqual({ loaded: 3, total: 3, partial: rows });
		for (const call of calls) expect(call.partial?.every((row) => row.cwd === dir) ?? true).toBe(true);
		expect(rows).toHaveLength(1);
		const progress = vi.fn((_loaded: number, _total: number) => {});
		expect(await SessionManager.listAll(sessions, progress)).toHaveLength(2);
		expect(progress).toHaveBeenLastCalledWith(3, 3, expect.any(Array));
	});

	it("publishes the first usable row while a slower source is still loading", async () => {
		const fast = SessionManager.create(dir, sessions);
		const slow = sourceFile();
		let release: (() => void) | undefined;
		vi.mocked(createReadStream).mockImplementation((...args) => {
			const stream = originalStream(...args);
			if (String(args[0]) === slow) {
				const read = stream._read;
				stream._read = (size) => {
					release = () => {
						stream._read = read;
						read.call(stream, size);
					};
				};
			}
			return stream;
		});
		let early: readonly SessionInfo[] | undefined;
		const pending = SessionManager.list(dir, sessions, (loaded, total, rows) => {
			if (rows?.length && loaded < total) early = rows;
		});
		await vi.waitFor(() => {
			expect(early).toHaveLength(1);
			expect(release).toBeDefined();
		});
		expect(early![0].path).toBe(fast.getSessionFile());
		release!();
		expect(await pending).toHaveLength(2);
	});

	it("preserves timestamp fallbacks and metadata append does not change activity", async () => {
		const file = sourceFile();
		const header = { type: "session", version: 3, id: "test", timestamp: "bad timestamp", cwd: dir };
		writeFileSync(file, `${JSON.stringify(header)}\n`);
		let rows = await SessionManager.list(dir, sessions);
		expect(rows[0].modified.getTime()).toBe(statSync(file).mtime.getTime());
		header.timestamp = "2025-01-01T00:00:00Z";
		writeFileSync(
			file,
			JSON.stringify(header) +
				"\n" +
				JSON.stringify({
					type: "message",
					id: "m",
					parentId: null,
					timestamp: "2025-01-03T00:00:00Z",
					message: { role: "user", content: "timestamp fallback" },
				}) +
				"\n",
		);
		rows = await SessionManager.list(dir, sessions);
		expect(rows[0].modified.getTime()).toBe(Date.parse("2025-01-03T00:00:00Z"));
		const manager = SessionManager.open(file);
		manager.appendSessionInfo("rename");
		expect((await SessionManager.list(dir, sessions))[0].modified).toEqual(rows[0].modified);
	});

	it("finds symlinked session directories in listAll", async () => {
		const file = sourceFile();
		const root = join(dir, "agent", "sessions");
		mkdirSync(root, { recursive: true });
		symlinkSync(sessions, join(root, "linked"), "dir");
		const rows = await SessionManager.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("test");
		expect(rows[0].path).toBe(join(root, "linked", file.split("/").at(-1)!));
	});

	it("does not persist never-listed writers and forget removes private memory/disk text", async () => {
		const manager = SessionManager.create(dir, sessions);
		manager.appendMessage({ role: "user", content: "private text", timestamp: 1 });
		flushSessionSummaries();
		expect(cacheFiles()).toHaveLength(0);
		await SessionManager.list(dir, sessions);
		expect(cacheFiles()).toHaveLength(1);
		const file = manager.getSessionFile()!;
		rmSync(file);
		forgetSessionSummary(file);
		flushSessionSummaries();
		expect(cacheFiles()).toHaveLength(0);
	});
	it.each([true, false])(
		"forget removes all symlink aliases including disk-only records (explicit identity: %s)",
		async (explicitIdentity) => {
			const file = sourceFile();
			writeFileSync(file, readFileSync(file, "utf8").replace("first searchable text", "deleted-private-secret"));
			const keep = join(sessions, "keep.jsonl");
			writeFileSync(
				keep,
				readFileSync(file, "utf8")
					.replace('"id":"test"', '"id":"keep"')
					.replace("deleted-private-secret", "unrelated-private-text"),
			);
			const alias = join(dir, "linked-sessions");
			symlinkSync(sessions, alias, "dir");
			// Establish direct-path caches only in a separate process, not the local memory map.
			expect(freshList(false).rows).toHaveLength(2);
			expect(await SessionManager.list(dir, alias)).toHaveLength(2);
			expect(cacheFiles()).toHaveLength(4);
			const identity = statSync(file, { bigint: true });
			rmSync(file);
			if (explicitIdentity) forgetSessionSummary(file, { dev: identity.dev, ino: identity.ino });
			else forgetSessionSummary(file);
			flushSessionSummaries();
			const remaining = cacheFiles();
			expect(remaining).toHaveLength(2);
			for (const cache of remaining) {
				const content = readFileSync(cache, "utf8");
				expect(content).not.toContain("deleted-private-secret");
				expect(content).toContain("unrelated-private-text");
			}
			expect(existsSync(file)).toBe(false);
			expect(existsSync(join(alias, "test.jsonl"))).toBe(false);
			expect(existsSync(keep)).toBe(true);
		},
	);

	it("forget ignores symlinks, malformed cache records and files outside this agentDir", async () => {
		const file = sourceFile();
		await SessionManager.list(dir, sessions);
		const original = cacheFiles()[0];
		const directory = join(dir, "agent", "session-index", "v1");
		const content = readFileSync(original, "utf8");
		const outside = join(dir, "outside-cache.json");
		writeFileSync(outside, content);
		const link = join(directory, `${"f".repeat(64)}.json`);
		symlinkSync(outside, link);
		const unknownVersion = JSON.parse(content);
		unknownVersion.version = 999;
		unknownVersion.source = join(dir, "unknown-source.jsonl");
		const unknown = join(directory, `${createHash("sha256").update(unknownVersion.source).digest("hex")}.json`);
		writeFileSync(unknown, JSON.stringify(unknownVersion));
		const wrongHash = join(directory, `${"0".repeat(64)}.json`);
		writeFileSync(wrongHash, content);
		const identity = statSync(file);
		rmSync(file);
		forgetSessionSummary(file, identity);
		expect(existsSync(original)).toBe(false);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(outside, "utf8")).toBe(content);
		expect(readFileSync(wrongHash, "utf8")).toBe(content);
		expect(JSON.parse(readFileSync(unknown, "utf8")).version).toBe(999);
	});

	it("forget never traverses a symlinked index directory", async () => {
		const file = sourceFile();
		await SessionManager.list(dir, sessions);
		const directory = join(dir, "agent", "session-index", "v1");
		const externalDirectory = join(dir, "external-index");
		renameSync(directory, externalDirectory);
		symlinkSync(externalDirectory, directory, "dir");
		const identity = statSync(file);
		rmSync(file);
		forgetSessionSummary(file, identity);
		expect(readdirSync(externalDirectory)).toHaveLength(1);
		expect(lstatSync(directory).isSymbolicLink()).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	it("publishes first visible content immediately even after an initial metadata-only partial", async () => {
		SessionManager.create(dir, sessions);
		const visible = SessionManager.create(dir, sessions);
		visible.appendMessage({ role: "user", content: "visible", timestamp: 2 });
		const slow = sourceFile();
		let release: (() => void) | undefined;
		vi.mocked(createReadStream).mockImplementation((...args) => {
			const stream = originalStream(...args);
			if (String(args[0]) === slow) {
				const read = stream._read;
				stream._read = (size) => {
					release = () => {
						stream._read = read;
						read.call(stream, size);
					};
				};
			}
			return stream;
		});
		const partials: Array<readonly SessionInfo[]> = [];
		const pending = SessionManager.list(dir, sessions, (loaded, total, rows) => {
			if (rows?.length && loaded < total) partials.push(rows);
		});
		try {
			await vi.waitFor(() => {
				expect(partials.some((rows) => rows.some((row) => row.isMetadataOnly === false))).toBe(true);
				expect(release).toBeDefined();
			});
		} finally {
			release?.();
			await pending;
		}
	});

	it("a late cross-process cache publisher can cause a miss, never a stale hit", async () => {
		const file = sourceFile();
		let changed = false;
		vi.mocked(renameSync).mockImplementation((from, to) => {
			if (!changed && String(to).endsWith(".json")) {
				changed = true;
				writeFileSync(file, readFileSync(file, "utf8").replace("first searchable text", "other searchable text"));
			}
			return originalRename(from, to);
		});
		await SessionManager.list(dir, sessions);
		expect(changed).toBe(true);
		const fresh = freshList(false);
		expect(fresh.reads).toBe(1);
		expect(fresh.rows[0].allMessagesText).toBe("other searchable text");
		expect(freshList(true).rows[0].allMessagesText).toBe("other searchable text");
	});

	it("an inaccessible index location falls back without failing source persistence", async () => {
		writeFileSync(join(dir, "agent"), "not a directory");
		const file = sourceFile();
		expect((await SessionManager.list(dir, sessions))[0].allMessagesText).toBe("first searchable text");
		const manager = SessionManager.open(file);
		expect(() => manager.appendSessionInfo("durable name")).not.toThrow();
		expect((await SessionManager.list(dir, sessions))[0].name).toBe("durable name");
		expect(freshList(false).rows[0].name).toBe("durable name");
	});

	it.skipIf(process.getuid?.() === 0)("a read-only cache directory falls back and stays read-only", async () => {
		const file = sourceFile();
		await SessionManager.list(dir, sessions);
		const directory = join(dir, "agent", "session-index", "v1");
		chmodSync(directory, 0o500);
		try {
			appendFileSync(
				file,
				`${JSON.stringify({ type: "session_info", id: "renamed", parentId: "input", timestamp: "2025-01-03T00:00:00Z", name: "readonly fallback" })}\n`,
			);
			const fresh = freshList(false);
			expect(fresh.reads).toBe(1);
			expect(fresh.rows[0].name).toBe("readonly fallback");
			expect(freshList(false).reads).toBe(1);
			expect(statSync(directory).mode & 0o777).toBe(0o500);
			const manager = SessionManager.open(file);
			expect(() => manager.appendSessionInfo("source still writable")).not.toThrow();
			expect((await SessionManager.list(dir, sessions))[0].name).toBe("source still writable");
		} finally {
			chmodSync(directory, 0o700);
		}
	});

	it("persists before LRU eviction, so a list larger than the memory cache stays warm", async () => {
		for (let index = 0; index < 140; index++) {
			writeFileSync(
				join(sessions, `${index}.jsonl`),
				`${JSON.stringify({ type: "session", version: 3, id: `id-${index}`, timestamp: "2025-01-01T00:00:00Z", cwd: dir })}\n`,
			);
		}
		const cold = await SessionManager.list(dir, sessions);
		expect(cold).toHaveLength(140);
		expect(cacheFiles()).toHaveLength(140);
		vi.clearAllMocks();
		expect(await SessionManager.list(dir, sessions)).toEqual(cold);
		expectNoSourceReads();
		expect(freshList(true).rows).toEqual(JSON.parse(JSON.stringify(cold)));
	});

	it.each([null, "invalid message", 42, false])(
		"malformed message %j disables indexing without changing authoritative loading/writing",
		async (message) => {
			const file = sourceFile();
			const lines = readFileSync(file, "utf8").trimEnd().split("\n");
			const entry = JSON.parse(lines[1]);
			entry.message = message;
			writeFileSync(file, `${lines[0]}\n${JSON.stringify(entry)}\n`);
			const loaded = loadEntriesFromFile(file);
			expect(loaded).toHaveLength(2);
			expect(loaded[1]).toHaveProperty("message", message);
			const destination = join(sessions, "rewritten.jsonl");
			expect(() => writeSessionFile(destination, loaded)).not.toThrow();
			expect(loadEntriesFromFile(destination)).toEqual(loaded);
			expect(await SessionManager.list(dir, sessions)).toEqual([]);
			expect(cacheFiles()).toHaveLength(0);
		},
	);

	it("oversized search projections explicitly miss rather than truncate text", async () => {
		const file = sourceFile();
		const header = readFileSync(file, "utf8").split("\n")[0];
		const text = `${"x".repeat(9 * 1024 * 1024)} end-of-history-search`;
		writeFileSync(
			file,
			`${header}\n${JSON.stringify({ type: "message", message: { role: "user", content: text, timestamp: 3 } })}\n`,
		);
		expect((await SessionManager.list(dir, sessions))[0].allMessagesText).toBe(text);
		expect(cacheFiles()).toHaveLength(0);
		vi.clearAllMocks();
		const rows = await SessionManager.list(dir, sessions);
		expect(rows[0].allMessagesText).toBe(text);
		expect(filterAndSortSessions(rows, "re:end-of-history-search$", "recent")).toHaveLength(0);
		// Search also includes cwd after history; do not anchor to the complete search string.
		expect(filterAndSortSessions(rows, "re:end-of-history-search", "recent")).toHaveLength(1);
		expect(vi.mocked(createReadStream)).toHaveBeenCalledTimes(1);
	});
});
