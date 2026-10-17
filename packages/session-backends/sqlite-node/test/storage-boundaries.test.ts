import { join } from "node:path";
import type { SessionStorage } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import {
	createNodeSqliteFactory,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
	SqliteSessionRepository,
} from "../src/index.ts";
import { appendEntryToBranchCache } from "../src/sqlite/branch-cache.ts";
import { insertEntryRow } from "../src/sqlite/storage/entries.ts";
import { appendFact } from "../src/sqlite/storage/facts.ts";
import { setLaneLeaf } from "../src/sqlite/storage/lanes.ts";
import { getNextSequence, setNextSequence } from "../src/sqlite/storage/session-sequences.ts";
import { incrementMessageCount } from "../src/sqlite/storage/session-stats.ts";
import { renewWriterLease, type WriterLease } from "../src/sqlite/storage/writer-leases.ts";
import { createTempDir, createUserMessage } from "./test-utils.ts";

function fixture(sqlite: SqliteDatabaseFactory = createNodeSqliteFactory()) {
	const root = createTempDir();
	const databasePath = join(root, "sessions.sqlite");
	return {
		root,
		databasePath,
		repository: new SqliteSessionRepository({ env: new NodeExecutionEnv({ cwd: root }), sqlite, databasePath }),
	};
}

describe("SQLite storage boundaries", () => {
	it("captures direct storage input before queue admission", async () => {
		const { root, repository } = fixture();
		await using repo = repository;
		const session = await repo.create({ cwd: root, id: "snapshot" });
		const storage = (session as unknown as { storage: SessionStorage }).storage;
		const data = { nested: { value: 1 } };
		const entry = storage.appendEntry({ id: "entry", type: "custom", customType: "note", data }, "main");
		data.nested.value = Number.NaN;
		const args: { nested: { value: number | undefined } } = { nested: { value: 2 } };
		const record = storage.appendRecord({
			type: "tool_started",
			id: "tool",
			lane: "main",
			runId: "run",
			assistantEntryId: "assistant",
			toolIndex: 0,
			toolCallId: "call",
			toolName: "example",
			effectiveArgs: args,
			resultEntryId: "result",
			replay: "safe",
		});
		args.nested.value = undefined;
		expect(await entry).toMatchObject({ data: { nested: { value: 1 } } });
		expect(await record).toMatchObject({ effectiveArgs: { nested: { value: 2 } } });
		const metadata = await session.getMetadata();
		const log = await session.getLog();
		await session.release();
		expect(await (await repo.open(metadata)).getLog()).toEqual(log);
	});

	const validRecord = { id: "record", type: "operation_finished", lane: "main", runId: "run", outcome: "completed" };
	it.each([
		["null", "null"],
		["array", "[]"],
		["id mismatch", JSON.stringify({ ...validRecord, id: "different" })],
		["type mismatch", JSON.stringify({ ...validRecord, type: "abort_requested" })],
		["lane mismatch", JSON.stringify({ ...validRecord, lane: "other" })],
		["run mismatch", JSON.stringify({ ...validRecord, runId: "other" })],
		["outcome discriminant", JSON.stringify({ ...validRecord, outcome: "unknown" })],
	])("rejects record %s unchanged across read paths", async (_name, payload) => {
		const { root, repository, databasePath } = fixture();
		await using repo = repository;
		const session = await repo.create({ cwd: root, id: "session" });
		await session.appendRecord({ ...validRecord, type: "operation_finished", outcome: "completed" });
		const db = await createNodeSqliteFactory().open(databasePath);
		try {
			db.prepare("UPDATE records SET payload = ? WHERE id = 'record'").run(payload);
			const rows = db.prepare("SELECT * FROM records").all();
			await expect(session.findRecords()).rejects.toMatchObject({ code: "storage" });
			await expect(session.getLog()).rejects.toMatchObject({ code: "storage" });
			expect(db.prepare("SELECT * FROM records").all()).toEqual(rows);
		} finally {
			db.close();
		}
	});

	it("rejects mismatched indexed operation kind and invalid entry discriminants", async () => {
		const { root, repository, databasePath } = fixture();
		await using repo = repository;
		const session = await repo.create({ cwd: root, id: "session" });
		await session.appendRecord({
			type: "operation_started",
			id: "run",
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		});
		const entry = await session.appendMessage(createUserMessage("root"));
		const db = await createNodeSqliteFactory().open(databasePath);
		try {
			db.prepare("UPDATE records SET op_kind = 'navigation' WHERE id = 'run'").run();
			await expect(session.findOpenOperations("main")).rejects.toMatchObject({ code: "storage" });
			for (const payload of [
				"null",
				"[]",
				JSON.stringify({ message: { role: "user", content: null, timestamp: 1 } }),
				JSON.stringify({ message: { role: "assistant", content: [], stopReason: "unknown" } }),
			]) {
				db.prepare("UPDATE entries SET payload = ? WHERE id = ?").run(payload, entry);
				await expect(session.getEntry(entry)).rejects.toMatchObject({ code: "invalid_entry" });
				await expect(session.findEntries()).rejects.toMatchObject({ code: "invalid_entry" });
				await expect(session.findEntriesOnBranch()).rejects.toMatchObject({ code: "invalid_entry" });
				expect(db.prepare("SELECT payload FROM entries WHERE id = ?").get(entry)).toEqual({ payload });
			}
			db.prepare("UPDATE entries SET type = 'unknown' WHERE id = ?").run(entry);
			await expect(session.getEntry(entry)).rejects.toMatchObject({ code: "invalid_entry" });
		} finally {
			db.close();
		}
	});

	it("keeps custom entry data opaque on reopen", async () => {
		const { root, repository } = fixture();
		await using repo = repository;
		const session = await repo.create({ cwd: root, id: "opaque" });
		const data = { type: "compaction", retainedTail: null, nested: [null, { role: "user", content: null }] };
		const id = await session.appendCustomEntry("application", data);
		const metadata = await session.getMetadata();
		await session.release();
		expect(await (await repo.open(metadata)).getEntry(id)).toMatchObject({ data });
	});

	it.each(["metadata", "name"] as const)("rolls back a writer claim when decoding corrupt %s fails", async (field) => {
		const { root, repository, databasePath } = fixture();
		await using repo = repository;
		const session = await repo.create({ cwd: root, id: "session" });
		await session.setName("valid");
		const metadata = await session.getMetadata();
		await session.release();
		const db = await createNodeSqliteFactory().open(databasePath);
		try {
			const update =
				field === "metadata"
					? "UPDATE sessions SET metadata = ? WHERE id = 'session'"
					: "UPDATE facts SET value = ? WHERE kind = 'name'";
			db.prepare(update).run("null");
			await expect(repo.open(metadata)).rejects.toMatchObject({ code: "storage" });
			expect(db.prepare("SELECT * FROM writer_leases").all()).toEqual([]);
			db.prepare(update).run(field === "metadata" ? "{}" : JSON.stringify("repaired"));
			const reopened = await repo.open(metadata);
			await expect(reopened.appendMessage(createUserMessage("after repair"))).resolves.toBeTypeOf("string");
		} finally {
			db.close();
		}
	});

	it("seals admission synchronously and drains a delayed admitted open exactly once", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const base = createNodeSqliteFactory();
		const counts = { opens: 0, closes: 0 };
		const { root, repository, databasePath } = fixture({
			async open(path) {
				entered.resolve();
				await gate.promise;
				const db = await base.open(path);
				counts.opens++;
				return {
					exec: (sql) => db.exec(sql),
					prepare: (sql) => db.prepare(sql),
					transaction: (fn) => db.transaction(fn),
					close() {
						counts.closes++;
						db.close();
					},
				};
			},
		});
		await using repo = repository;
		const admitted = repo.create({ cwd: root, id: "admitted" });
		await entered.promise;
		const firstClose = repo.close();
		const secondClose = repo.close();
		const late = repo.create({ cwd: root, id: "late" }).then(
			() => "accepted",
			() => "rejected",
		);
		gate.resolve();
		const session = await admitted;
		await Promise.all([firstClose, secondClose]);
		expect(await late).toBe("rejected");
		expect(firstClose).toBe(secondClose);
		expect(counts).toEqual({ opens: 1, closes: 1 });
		expect(vi.getTimerCount()).toBe(0);
		await expect(session.appendMessage(createUserMessage("closed"))).rejects.toMatchObject({ code: "storage" });
		const inspection = await base.open(databasePath);
		try {
			expect(inspection.prepare("SELECT * FROM writer_leases").all()).toEqual([]);
			expect(inspection.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "admitted" }]);
		} finally {
			inspection.close();
		}
	});

	it.each([0, 1, 2])("T-113 retries failed lease cleanup without abandoning other storages (%i)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const base = createNodeSqliteFactory();
		const counts = { opens: 0, closes: 0 };
		let database: SqliteDatabase | undefined;
		let failRelease = false;
		const { root, repository: repo } = fixture({
			async open(path) {
				const db = await base.open(path);
				database = db;
				counts.opens++;
				return {
					exec: (sql) => db.exec(sql),
					prepare: (sql) => db.prepare(sql),
					transaction(fn) {
						if (failRelease) {
							failRelease = false;
							throw new Error("database is locked (injected release)");
						}
						return db.transaction(fn);
					},
					close() {
						db.close();
						counts.closes++;
					},
				};
			},
		});
		try {
			const first = await repo.create({ cwd: root, id: "first" });
			const second = await repo.create({ cwd: root, id: "second" });
			const metadata = await first.getMetadata();
			const leases = () => database!.prepare("SELECT session_id FROM writer_leases ORDER BY session_id").all();
			const before = { ...counts, timers: vi.getTimerCount(), leases: leases() };
			failRelease = true;
			const closing = repo.close();
			expect(repo.close()).toBe(closing);
			const failure = await closing.then(
				() => undefined,
				(error: unknown) => error,
			);
			const failed = { ...counts, timers: vi.getTimerCount(), leases: leases() };
			for (const operation of [
				() => repo.create({ cwd: root }),
				() => repo.open(metadata),
				() => repo.list(),
				() => repo.delete(metadata),
				() => repo.fork(metadata, { cwd: root }),
				() => repo.repairBranchCache(metadata),
			])
				await expect(operation()).rejects.toMatchObject({
					code: "storage",
					message: expect.stringContaining("closed"),
				});
			const retried = await repo.close().then(
				() => undefined,
				(error: unknown) => error,
			);
			const after = { ...counts, timers: vi.getTimerCount() };
			expect({ failure, retried, before, failed, after }).toEqual({
				failure: new Error("database is locked (injected release)"),
				retried: undefined,
				before: { opens: 1, closes: 0, timers: 2, leases: [{ session_id: "first" }, { session_id: "second" }] },
				failed: { opens: 1, closes: 0, timers: 0, leases: [{ session_id: "first" }] },
				after: { opens: 1, closes: 1, timers: 0 },
			});
			await expect(first.appendMessage(createUserMessage("closed"))).rejects.toMatchObject({ code: "storage" });
			await expect(second.appendMessage(createUserMessage("closed"))).rejects.toMatchObject({ code: "storage" });
			const inspection = await base.open(metadata.path);
			try {
				expect(inspection.prepare("SELECT * FROM writer_leases").all()).toEqual([]);
			} finally {
				inspection.close();
			}
			await repo.close();
			expect(counts).toEqual({ opens: 1, closes: 1 });
		} finally {
			// Also release test resources when the pre-fix assertions fail.
			if (counts.closes === 0) database?.close();
			vi.clearAllTimers();
		}
	});

	it("rejects every repository operation after closing an unopened repository", async () => {
		const open = vi.fn(createNodeSqliteFactory().open);
		const { root, databasePath, repository } = fixture({ open });
		await using repo = repository;
		await repo.close();
		const metadata = { id: "absent", cwd: root, path: databasePath, createdAt: 1 };
		for (const operation of [
			() => repo.create({ cwd: root }),
			() => repo.open(metadata),
			() => repo.list(),
			() => repo.delete(metadata),
			() => repo.fork(metadata, { cwd: root }),
			() => repo.repairBranchCache(metadata),
		])
			await expect(operation()).rejects.toMatchObject({
				code: "storage",
				message: expect.stringContaining("closed"),
			});
		expect(open).not.toHaveBeenCalled();
	});

	it.each([0, 1, 2])("forks one coherent source snapshot under an independent writer (%i)", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const base = createNodeSqliteFactory();
		const writerDb = await base.open(databasePath);
		await using writer = new SqliteSessionRepository({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: { open: async () => writerDb },
			databasePath,
		});
		const source = await writer.create({ cwd: root, id: "source" });
		const rootId = await source.appendMessage(createUserMessage("root"));
		await source.setLabel(rootId, "before");
		const metadata = await source.getMetadata();
		writerDb.exec("PRAGMA busy_timeout=0");
		const row = writerDb
			.prepare("SELECT owner_id, fence, expires_at_ms FROM writer_leases WHERE session_id = 'source'")
			.get<{ owner_id: string; fence: number; expires_at_ms: number }>()!;
		const lease: WriterLease = { ownerId: row.owner_id, fence: row.fence, expiresAtMs: row.expires_at_ms };
		const appendMoveAndLabel = () =>
			writerDb.transaction(() => {
				const now = Date.now();
				expect(renewWriterLease(writerDb, "source", lease, now, now + 30_000)).toBe(true);
				const seq = getNextSequence(writerDb, "source");
				insertEntryRow(writerDb, "source", {
					seq,
					id: "concurrent",
					parentId: rootId,
					type: "message",
					timestamp: now,
					payload: JSON.stringify({ message: createUserMessage("concurrent") }),
				});
				setLaneLeaf(writerDb, "source", "main", "concurrent");
				appendEntryToBranchCache(writerDb, "source", "concurrent", seq, "message", null, rootId);
				incrementMessageCount(writerDb, "source");
				appendFact(writerDb, "source", seq + 1, "label", "concurrent", JSON.stringify("after"));
				appendFact(writerDb, "source", seq + 2, "label", rootId, JSON.stringify("changed"));
				setNextSequence(writerDb, "source", seq + 3);
			});
		let attempted = false;
		let blocked = false;
		await using reader = new SqliteSessionRepository({
			env: new NodeExecutionEnv({ cwd: root }),
			databasePath,
			sqlite: {
				async open(path) {
					const db = await base.open(path);
					return {
						exec: (sql) => db.exec(sql),
						transaction: (fn) => db.transaction(fn),
						close: () => db.close(),
						prepare(sql) {
							const statement = db.prepare(sql);
							if (!/FROM entries\s+WHERE session_id = \?\s+ORDER BY seq ASC/.test(sql)) return statement;
							return {
								run: (...params) => statement.run(...params),
								get: (...params) => statement.get(...params),
								iterate: (...params) => statement.iterate(...params),
								all<TRow extends object>(...params: unknown[]): TRow[] {
									const rows = statement.all<TRow>(...params);
									if (!attempted && params[0] === "source") {
										attempted = true;
										try {
											appendMoveAndLabel();
										} catch (error) {
											if (!(error instanceof Error) || !error.message.includes("database is locked"))
												throw error;
											blocked = true;
										}
									}
									return rows;
								},
							};
						},
					};
				},
			},
		});
		const fork = await reader.fork(metadata, { cwd: root, id: "fork", scope: "tree" });
		expect(attempted).toBe(true);
		expect(blocked).toBe(true);
		expect((await fork.findEntries()).map((entry) => entry.id)).toEqual([rootId]);
		expect(await fork.getLanes()).toEqual([{ lane: "main", leafId: rootId }]);
		expect(await fork.getLabel(rootId)).toBe("before");
		expect(await fork.getLabel("concurrent")).toBeUndefined();
		appendMoveAndLabel();
		expect(await source.getLeafId()).toBe("concurrent");
		expect(await source.getLabel(rootId)).toBe("changed");
	});
});
