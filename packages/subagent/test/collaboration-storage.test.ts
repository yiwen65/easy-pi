import { randomUUID } from "node:crypto";
import type * as Fs from "node:fs";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import {
	COLLABORATION_LIMITS,
	CollaborationAdmissionError,
	type CollaborationTurnRecord,
} from "../src/collaboration-contract.ts";
import { CollaborationController } from "../src/collaboration-controller.ts";
import {
	checkCollaborationStorageAdmission,
	deleteCollaborationStorage,
	inspectCollaborationStorage,
	listCollaborationStorage,
	sweepCollaborationStorage,
} from "../src/collaboration-storage.ts";
import { CollaborationStore, type StoredCollaborationAgent } from "../src/collaboration-store.ts";
import type { ChildSessionHost } from "../src/session-host.ts";

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof Fs>();
	return { ...fs, unlinkSync: vi.fn(fs.unlinkSync), renameSync: vi.fn(fs.renameSync) };
});
const cleanup: Array<() => void> = [];
afterEach(() => {
	vi.mocked(unlinkSync).mockRestore();
	vi.mocked(renameSync).mockRestore();
	for (const run of cleanup.splice(0).reverse()) run();
});
function fixture(id = "team") {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "epi-storage-")));
	cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
	const directory = join(cwd, "teams", id);
	const path = join(directory, "registry.sqlite");
	const store = new CollaborationStore({ path, cwd, rootSessionId: id });
	cleanup.push(() => store.close());
	return {
		cwd,
		directory,
		path,
		store,
		options: { agentDir: cwd, rootSessionId: id },
		marker: join(cwd, "teams", `.${id}.deleted.json`),
		quarantine: join(cwd, "teams", `.${id}.deleting`),
	};
}
function edit(path: string, sql: string, ...values: Array<string | number | null>) {
	const db = new DatabaseSync(path);
	try {
		db.prepare(sql).run(...values);
	} finally {
		db.close();
	}
}
function interruptDeletion(f: ReturnType<typeof fixture>) {
	const original = vi.mocked(unlinkSync).getMockImplementation()!;
	vi.mocked(unlinkSync).mockImplementation((path) => {
		if (String(path).startsWith(f.quarantine)) {
			vi.mocked(unlinkSync).mockImplementation(original);
			throw new Error("synthetic deletion interruption");
		}
		original(path);
	});
}
function child(f: ReturnType<typeof fixture>, status: StoredCollaborationAgent["status"] = "completed") {
	const snapshot = f.store.read();
	const agent: StoredCollaborationAgent = {
		id: randomUUID(),
		path: "/root/child",
		parent: "/root",
		model: { provider: "faux", id: "one", thinkingLevel: "off" },
		status,
		turnId: randomUUID(),
		sessionFile: "session.jsonl",
	};
	snapshot.agents.push(agent);
	f.store.commit(snapshot);
	mkdirSync(join(f.directory, agent.id));
	writeFileSync(join(f.directory, agent.id, agent.sessionFile!), "retained history\n");
	return agent;
}

test("legal aggregate turn history above 16MiB remains inspectable and deletable with sufficient scan budget", () => {
	const f = fixture();
	const agent = child(f);
	const template = f.store.getTurn(agent.path, { turn_id: agent.turnId })!;
	const db = new DatabaseSync(f.path);
	try {
		db.exec("BEGIN");
		const insert = db.prepare("INSERT INTO turns VALUES (?, ?, ?, NULL, NULL, ?)");
		const preview = "x".repeat(COLLABORATION_LIMITS.maxResultBytes);
		for (let sequence = 2; sequence <= 257; sequence++) {
			const turnId = `large-history-${sequence}`;
			const turn: CollaborationTurnRecord = {
				...template,
				sequence,
				turn_id: turnId,
				result: {
					preview,
					truncated: false,
					source: { kind: "unavailable", turn_id: turnId, coverage: "unknown" },
				},
			};
			insert.run(sequence, agent.path, turnId, JSON.stringify(turn));
		}
		db.exec("COMMIT");
		expect(
			Number(db.prepare("SELECT sum(length(CAST(record AS BLOB))) AS bytes FROM turns").get()!.bytes),
		).toBeGreaterThan(16 * 1024 * 1024);
	} finally {
		db.close();
	}
	f.store.close();
	const options = { ...f.options, maxEntries: 20_000, maxScanMs: 60_000 };
	expect(inspectCollaborationStorage(options)).toMatchObject({
		state: "present",
		incomplete: false,
		deletable: true,
		gcEligible: true,
	});
	expect(deleteCollaborationStorage({ ...options, dryRun: false }).status).toBe("deleted");
	expect(existsSync(f.directory)).toBe(false);
});

test("sparse valid SQLite files above 512MiB remain measurable and manually deletable", () => {
	const f = fixture();
	f.store.close();
	truncateSync(f.path, 512 * 1024 * 1024 + 4096);
	expect(lstatSync(f.path).size).toBeGreaterThan(512 * 1024 * 1024);
	expect(inspectCollaborationStorage(f.options)).toMatchObject({ incomplete: false, deletable: true });
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
});

test("live owner is protected but measured; dead owner and PID reuse use acquisition semantics", () => {
	const f = fixture();
	expect(inspectCollaborationStorage(f.options)).toMatchObject({
		owner: "live",
		deletable: false,
		incomplete: false,
		agentCount: 0,
	});
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("protected");
	f.store.close();
	edit(f.path, "UPDATE team SET owner='dead',pid=2147483647,owner_started_at=1");
	expect(inspectCollaborationStorage(f.options)).toMatchObject({ owner: "inactive", deletable: true });
	edit(f.path, "UPDATE team SET owner='reused',pid=?,owner_started_at=1", process.pid);
	expect(inspectCollaborationStorage(f.options)).toMatchObject({ owner: "inactive", deletable: true });
	expect(deleteCollaborationStorage(f.options).status).toBe("planned");
	expect(existsSync(f.path)).toBe(true);
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
	expect(JSON.parse(readFileSync(f.marker, "utf8"))).toEqual({
		kind: "pi-team-deletion",
		version: 1,
		rootSessionId: "team",
		directory: f.directory,
		state: "deleted",
		entries: [],
	});
	expect(inspectCollaborationStorage({ ...f.options, maxEntries: 1 })).toMatchObject({
		state: "deleted",
		incomplete: false,
	});
	expect(listCollaborationStorage({ agentDir: f.cwd, maxEntries: 1 }).incomplete).toBe(false);
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("already_deleted");
	expect(inspectCollaborationStorage(f.options)).toMatchObject({ state: "deleted", incomplete: false });
	expect(
		() => new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team", recoverInterruptedOwner: true }),
	).toThrow(expect.objectContaining({ code: "forbidden" }));
	expect(existsSync(f.directory)).toBe(false);
});

test.each(["symlink", "unknown", "identity", "owner", "corrupt", "db-symlink", "ancestor-symlink"])(
	"unsafe %s cannot authorize deletion",
	(kind) => {
		const f = fixture();
		const agent = child(f);
		f.store.close();
		if (kind === "symlink") symlinkSync(f.cwd, join(f.directory, agent.id, "outside.jsonl"));
		if (kind === "unknown") writeFileSync(join(f.directory, agent.id, "notes.jsonl"), "user data");
		if (kind === "identity") {
			const db = new DatabaseSync(f.path);
			const snapshot = JSON.parse(String(db.prepare("SELECT snapshot FROM team").get()!.snapshot));
			snapshot.rootSessionId = "foreign";
			db.prepare("UPDATE team SET snapshot=?").run(JSON.stringify(snapshot));
			db.close();
		}
		if (kind === "owner") edit(f.path, "UPDATE team SET owner='invalid',pid=-1");
		if (kind === "corrupt") edit(f.path, "UPDATE team SET snapshot='{}'");
		if (kind === "db-symlink") {
			renameSync(f.path, join(f.cwd, "external.sqlite"));
			symlinkSync(join(f.cwd, "external.sqlite"), f.path);
		}
		if (kind === "ancestor-symlink") {
			renameSync(join(f.cwd, "teams"), join(f.cwd, "actual-teams"));
			symlinkSync(join(f.cwd, "actual-teams"), join(f.cwd, "teams"));
			expect(() => deleteCollaborationStorage({ ...f.options, dryRun: false })).toThrow(
				expect.objectContaining({ code: "forbidden" }),
			);
			return;
		}
		expect(inspectCollaborationStorage(f.options)).toMatchObject({
			incomplete: true,
			deletable: false,
			gcEligible: false,
		});
		expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("protected");
		expect(existsSync(f.marker)).toBe(false);
	},
);

test("missing workspace does not prevent proven historical team cleanup", () => {
	const f = fixture();
	f.store.close();
	const db = new DatabaseSync(f.path);
	const snapshot = JSON.parse(String(db.prepare("SELECT snapshot FROM team").get()!.snapshot));
	snapshot.cwd = join(f.cwd, "removed-project");
	db.prepare("UPDATE team SET snapshot=?").run(JSON.stringify(snapshot));
	db.close();
	expect(inspectCollaborationStorage(f.options)).toMatchObject({ deletable: true });
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
});

test("interrupted quarantine deletion retains proof, protects budget and retries after partial removal", () => {
	const f = fixture();
	const agent = child(f);
	f.store.close();
	interruptDeletion(f);
	expect(() => deleteCollaborationStorage({ ...f.options, dryRun: false })).toThrow(/synthetic/);
	expect(existsSync(f.marker)).toBe(true);
	expect(existsSync(f.quarantine)).toBe(true);
	const retainedProof = readFileSync(f.marker, "utf8");
	expect(JSON.parse(retainedProof)).toMatchObject({ state: "deleting" });
	expect(JSON.parse(retainedProof).entries.length).toBeGreaterThan(0);
	expect(deleteCollaborationStorage(f.options).status).toBe("planned");
	expect(readFileSync(f.marker, "utf8")).toBe(retainedProof);
	expect(inspectCollaborationStorage(f.options)).toMatchObject({ state: "deleting", incomplete: true });
	expect(() => checkCollaborationStorageAdmission({ ...f.options, maxTotalBytes: Number.MAX_SAFE_INTEGER })).toThrow(
		expect.objectContaining({ code: "storage_error" }),
	);
	// A previous process may already have removed arbitrary manifest members, including the DB.
	unlinkSync(join(f.quarantine, agent.id, agent.sessionFile!));
	unlinkSync(join(f.quarantine, "registry.sqlite"));
	expect(() => new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" })).toThrow(
		expect.objectContaining({ code: "forbidden" }),
	);
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
	expect(existsSync(f.directory)).toBe(false);
	expect(existsSync(f.quarantine)).toBe(false);
	expect(JSON.parse(readFileSync(f.marker, "utf8"))).toMatchObject({ state: "deleted", entries: [] });
});

test("failed compaction retains the complete marker and explicit already-deleted retry atomically compacts it", () => {
	const f = fixture();
	f.store.close();
	const original = vi.mocked(renameSync).getMockImplementation()!;
	vi.mocked(renameSync).mockImplementation((from, to) => {
		if (String(to) === f.marker) {
			expect(existsSync(f.marker)).toBe(true);
			expect(JSON.parse(readFileSync(f.marker, "utf8")).entries.length).toBeGreaterThan(0);
			throw new Error("synthetic compaction interruption");
		}
		original(from, to);
	});
	expect(() => deleteCollaborationStorage({ ...f.options, dryRun: false })).toThrow(/compaction interruption/);
	const retainedProof = readFileSync(f.marker, "utf8");
	expect(JSON.parse(retainedProof)).toMatchObject({ state: "deleting" });
	expect(JSON.parse(retainedProof).entries.length).toBeGreaterThan(0);
	expect(existsSync(f.directory)).toBe(false);
	expect(existsSync(f.quarantine)).toBe(false);
	expect(inspectCollaborationStorage({ ...f.options, maxEntries: 1 })).toMatchObject({ incomplete: true });
	expect(deleteCollaborationStorage(f.options).status).toBe("already_deleted");
	expect(readFileSync(f.marker, "utf8")).toBe(retainedProof);
	vi.mocked(renameSync).mockImplementation((from, to) => {
		expect(existsSync(f.marker)).toBe(true);
		expect(() => new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" })).toThrow(
			expect.objectContaining({ code: "forbidden" }),
		);
		original(from, to);
		expect(existsSync(f.marker)).toBe(true);
		expect(JSON.parse(readFileSync(f.marker, "utf8"))).toMatchObject({ state: "deleted", entries: [] });
	});
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false, maxEntries: 1 })).toMatchObject({
		status: "already_deleted",
		stats: { state: "deleted", incomplete: false },
	});
	expect(inspectCollaborationStorage({ ...f.options, maxEntries: 1 })).toMatchObject({
		state: "deleted",
		incomplete: false,
	});
});

test("pending DB flag alone blocks acquisition and manual retry installs a tombstone", () => {
	const f = fixture();
	f.store.close();
	edit(f.path, "ALTER TABLE team ADD COLUMN deletion_pending TEXT");
	edit(f.path, "UPDATE team SET deletion_pending='team'");
	expect(() => new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" })).toThrow(
		expect.objectContaining({ code: "forbidden" }),
	);
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
});

test("owner acquisition after initial inspection is rechecked under the deletion transaction", () => {
	const f = fixture();
	f.store.close();
	const original = DatabaseSync.prototype.exec;
	let inject = true;
	const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
		if (inject && sql === "BEGIN IMMEDIATE") {
			inject = false;
			edit(
				f.path,
				"UPDATE team SET owner='new-owner',pid=?,owner_started_at=?",
				process.pid,
				Date.now() - Math.floor(process.uptime() * 1000),
			);
		}
		return original.call(this, sql);
	});
	try {
		expect(() => deleteCollaborationStorage({ ...f.options, dryRun: false })).toThrow(
			expect.objectContaining({ code: "busy" }),
		);
	} finally {
		spy.mockRestore();
	}
	expect(existsSync(f.marker)).toBe(false);
	expect(existsSync(f.path)).toBe(true);
});

test("SQLite writer transaction excludes owner acquisition before the tombstone is published", () => {
	const f = fixture();
	f.store.close();
	const original = DatabaseSync.prototype.exec;
	let attempted = false;
	const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
		if (sql === "ALTER TABLE team ADD COLUMN deletion_pending TEXT") {
			attempted = true;
			expect(existsSync(f.marker)).toBe(false);
			expect(() => new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" })).toThrow(/locked/);
		}
		return original.call(this, sql);
	});
	try {
		expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
		expect(attempted).toBe(true);
	} finally {
		spy.mockRestore();
	}
});

test("store acquisition attempted between deletion commit and quarantine cannot reopen the team", () => {
	const f = fixture();
	f.store.close();
	const original = vi.mocked(renameSync).getMockImplementation()!;
	vi.mocked(renameSync).mockImplementationOnce((from, to) => {
		expect(() => new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" })).toThrow(
			expect.objectContaining({ code: "forbidden" }),
		);
		original(from, to);
	});
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
});

test.each(["pending", "interrupted", "mail"])(
	"automatic GC protects %s; explicit manual deletion remains available",
	(kind) => {
		const f = fixture();
		child(f, kind === "mail" ? "completed" : kind === "pending" ? "pending" : "interrupted");
		if (kind === "mail") {
			const snapshot = f.store.read();
			snapshot.messages = [
				{
					id: randomUUID(),
					rootSessionId: "team",
					from: "/root",
					to: "/root/child",
					turnId: randomUUID(),
					kind: "message",
					text: "unread",
				},
			];
			f.store.commit(snapshot);
		}
		f.store.close();
		const options = { ...f.options, now: Date.now() + 10_000, maxAgeMs: 1 };
		expect(inspectCollaborationStorage(options)).toMatchObject({ deletable: true, gcEligible: false });
		expect(sweepCollaborationStorage({ ...options, enabled: true, dryRun: false }).candidates).toEqual([]);
		expect(deleteCollaborationStorage({ ...options, automatic: true, dryRun: false }).status).toBe("protected");
		expect(deleteCollaborationStorage({ ...options, dryRun: false }).status).toBe("deleted");
	},
);

test("GC plans are read-only by default and require enabled+dryRun=false and coldness to apply", () => {
	const f = fixture();
	child(f);
	f.store.close();
	const policy = { agentDir: f.cwd, now: Date.now() + 10_000, maxAgeMs: 1 };
	expect(sweepCollaborationStorage(policy).candidates).toEqual(["team"]);
	expect(sweepCollaborationStorage({ ...policy, dryRun: false }).dryRun).toBe(true);
	expect(existsSync(f.path)).toBe(true);
	expect(deleteCollaborationStorage({ ...f.options, automatic: true, dryRun: false }).status).toBe("protected");
	expect(sweepCollaborationStorage({ ...policy, enabled: true, dryRun: false }).results[0].status).toBe("deleted");
});

test("shared entry/deadline limits make partial inventories unsafe for admission, not zero", () => {
	const f = fixture();
	child(f);
	f.store.close();
	expect(inspectCollaborationStorage({ ...f.options, maxEntries: 1 })).toMatchObject({
		incomplete: true,
		deletable: false,
	});
	expect(listCollaborationStorage({ agentDir: f.cwd, maxEntries: 1 }).incomplete).toBe(true);
	expect(() =>
		checkCollaborationStorageAdmission({ ...f.options, maxEntries: 1, maxTeamBytes: Number.MAX_SAFE_INTEGER }),
	).toThrow(expect.objectContaining({ code: "storage_error" }));
	expect(() => checkCollaborationStorageAdmission({ ...f.options, maxTeamBytes: 1 })).toThrow(
		expect.objectContaining({ code: "limit_reached", reason: "storage_budget_full" }),
	);
	expect(() =>
		checkCollaborationStorageAdmission({ ...f.options, maxTeamBytes: Number.MAX_SAFE_INTEGER }),
	).not.toThrow();
});

test("managed log schema and inactive leases authorize only managed files; live leases protect without breaking measurement", () => {
	const f = fixture();
	const agent = child(f);
	f.store.close();
	const sessionId = randomUUID();
	const logs = join(f.directory, agent.id, `${sessionId}.logs`);
	mkdirSync(logs);
	writeFileSync(
		join(logs, ".pi-tool-logs.json"),
		JSON.stringify({ kind: "pi-tool-output", version: 1, sessionId, directory: logs }),
	);
	const lease = join(logs, `lease-${randomUUID()}.json`);
	writeFileSync(lease, JSON.stringify({ kind: "writer", pid: process.pid, startedAt: new Date().toISOString() }));
	writeFileSync(join(logs, `bash-${randomUUID()}.log`), "synthetic output");
	expect(inspectCollaborationStorage(f.options)).toMatchObject({
		incomplete: false,
		deletable: false,
		protectedReasons: ["live_log_writer"],
	});
	expect(() =>
		checkCollaborationStorageAdmission({ ...f.options, maxTeamBytes: Number.MAX_SAFE_INTEGER }),
	).not.toThrow();
	writeFileSync(lease, JSON.stringify({ kind: "writer", pid: 2147483647, startedAt: new Date().toISOString() }));
	expect(inspectCollaborationStorage(f.options)).toMatchObject({ incomplete: false, deletable: true });
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
});

test("retry rechecks liveness even for an unchanged manifest lease inode", () => {
	const f = fixture();
	const agent = child(f);
	f.store.close();
	const sessionId = randomUUID();
	const logs = join(f.directory, agent.id, `${sessionId}.logs`);
	mkdirSync(logs);
	writeFileSync(
		join(logs, ".pi-tool-logs.json"),
		JSON.stringify({ kind: "pi-tool-output", version: 1, sessionId, directory: logs }),
	);
	const leaseName = `lease-${randomUUID()}.json`;
	const leaseData = (pid: number) => JSON.stringify({ kind: "session", pid, startedAt: new Date().toISOString() });
	writeFileSync(join(logs, leaseName), leaseData(2147483647));
	interruptDeletion(f);
	expect(() => deleteCollaborationStorage({ ...f.options, dryRun: false })).toThrow(/synthetic/);
	const quarantinedLease = join(f.quarantine, agent.id, `${sessionId}.logs`, leaseName);
	writeFileSync(quarantinedLease, leaseData(process.pid));
	expect(() => deleteCollaborationStorage({ ...f.options, dryRun: false })).toThrow(/lease protects/);
	expect(existsSync(join(f.quarantine, agent.id, agent.sessionFile!))).toBe(true);
	writeFileSync(quarantinedLease, leaseData(2147483647));
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
});

test("new unknown quarantine content prevents retry instead of widening deletion authorization", () => {
	const f = fixture();
	f.store.close();
	interruptDeletion(f);
	expect(() => deleteCollaborationStorage({ ...f.options, dryRun: false })).toThrow(/synthetic/);
	writeFileSync(join(f.quarantine, "not-owned.txt"), "keep");
	expect(() => deleteCollaborationStorage({ ...f.options, dryRun: false })).toThrow(/proof/);
	expect(readFileSync(join(f.quarantine, "not-owned.txt"), "utf8")).toBe("keep");
});

test("invalid tombstone identity or escaping manifest cannot authorize a retry", () => {
	const f = fixture();
	f.store.close();
	interruptDeletion(f);
	expect(() => deleteCollaborationStorage({ ...f.options, dryRun: false })).toThrow(/synthetic/);
	const marker = JSON.parse(readFileSync(f.marker, "utf8"));
	marker.entries[0].path = "../external";
	writeFileSync(f.marker, JSON.stringify(marker));
	writeFileSync(join(f.cwd, "external"), "keep");
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("protected");
	expect(readFileSync(join(f.cwd, "external"), "utf8")).toBe("keep");
	expect(() => new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" })).toThrow(
		expect.objectContaining({ code: "forbidden" }),
	);
});

test("controller storage admission gates only spawn/followup before persistence, not queries/ack/close", async () => {
	const f = fixture();
	let denied = true;
	let calls = 0;
	let creates = 0;
	const host: ChildSessionHost = {
		async create(options) {
			creates++;
			return {
				identity: options,
				sessionId: randomUUID(),
				sessionFile: undefined,
				context: () => [],
				forkContext: () => [],
				run: async () => ({ status: "completed", text: "done" }),
				abort: async () => {},
				dispose: async () => {},
			};
		},
	};
	const controller = new CollaborationController({
		store: f.store,
		host,
		agentDir: f.cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
		checkStorageAdmission: () => {
			calls++;
			if (denied) throw new CollaborationAdmissionError("limit_reached", "full", "storage_budget_full");
		},
	});
	const caller = { rootSessionId: "team", agentPath: "/root" };
	const model = { provider: "faux", id: "one", thinkingLevel: "off" as const };
	try {
		await expect(controller.spawn(caller, "worker", "task", model)).rejects.toMatchObject({
			reason: "storage_budget_full",
			executionOutcome: "not_started",
		});
		expect(f.store.read().agents).toEqual([]);
		expect(creates).toBe(0);
		denied = false;
		await controller.spawn(caller, "worker", "task", model);
		await controller.settled();
		denied = true;
		const before = f.store.read();
		await expect(controller.followup(caller, "worker", "next")).rejects.toMatchObject({
			reason: "storage_budget_full",
		});
		expect(f.store.read()).toEqual(before);
		expect(creates).toBe(1);
		expect(calls).toBe(3);
		expect(controller.getAgentResult(caller, { target: "worker" }).state).toBe("found");
		await controller.acknowledge(
			caller,
			controller.pending(caller).map((item) => item.id),
		);
		await controller.close(caller, "worker");
		expect(calls).toBe(3);
	} finally {
		await controller.shutdown();
	}
});

test("inventory shares one entry budget across teams and metadata obeys the deadline", () => {
	const f = fixture();
	f.store.close();
	const other = new CollaborationStore({
		path: join(f.cwd, "teams", "other", "registry.sqlite"),
		rootSessionId: "other",
		cwd: f.cwd,
	});
	other.close();
	const inventory = listCollaborationStorage({ agentDir: f.cwd, maxEntries: 7 });
	expect(inventory.incomplete).toBe(true);
	expect(inventory.teams.some((team) => !team.incomplete)).toBe(true);
	const started = Date.now();
	let calls = 0;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => started + calls++ * 2);
	try {
		expect(inspectCollaborationStorage({ ...f.options, maxScanMs: 1 })).toMatchObject({
			incomplete: true,
			deletable: false,
		});
	} finally {
		clock.mockRestore();
	}
});

test("orphan quarantine is unknown and cannot disappear from capacity accounting", () => {
	const f = fixture();
	f.store.close();
	renameSync(f.directory, f.quarantine);
	expect(inspectCollaborationStorage(f.options)).toMatchObject({ state: "unknown", incomplete: true });
	expect(listCollaborationStorage({ agentDir: f.cwd }).incomplete).toBe(true);
	expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("protected");
});

test("historical interrupted work remains GC-protected after a later completed turn", () => {
	const f = fixture();
	child(f, "interrupted");
	const snapshot = f.store.read();
	snapshot.agents[0].turnId = randomUUID();
	snapshot.agents[0].status = "completed";
	f.store.commit(snapshot);
	f.store.close();
	expect(inspectCollaborationStorage(f.options)).toMatchObject({
		deletable: true,
		interruptedTurns: 1,
		gcEligible: false,
	});
	expect(sweepCollaborationStorage({ agentDir: f.cwd, maxAgeMs: 1, now: Date.now() + 10_000 }).candidates).toEqual([]);
});

test.each(["..", "/absolute", "a/b", ".hidden", ""])(
	"root identity %s is rejected before storage writes",
	(rootSessionId) => {
		const f = fixture();
		expect(() => inspectCollaborationStorage({ ...f.options, rootSessionId })).toThrow(
			expect.objectContaining({ code: "invalid_arguments" }),
		);
		expect(lstatSync(f.directory).isDirectory()).toBe(true);
	},
);
