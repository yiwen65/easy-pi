import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import {
	COLLABORATION_HISTORY_LIMITS,
	COLLABORATION_LIMITS,
	CollaborationError,
} from "../src/collaboration-contract.ts";
import { CollaborationController } from "../src/collaboration-controller.ts";
import { CollaborationStore } from "../src/collaboration-store.ts";
import type { ChildSessionHost, ChildSessionIdentity, ChildTurnResult } from "../src/session-host.ts";
import { delegation } from "./delegation-fixture.ts";

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
	const path = mkdtempSync(join(tmpdir(), "epi-controller-"));
	roots.push(path);
	return path;
}
const caller: ChildSessionIdentity = { rootSessionId: "team", agentPath: "/root" };
const model = { provider: "faux", id: "one", thinkingLevel: "off" as const };
function fixture(file = false) {
	const cwd = root();
	const store = new CollaborationStore({
		path: file ? join(cwd, "registry.sqlite") : ":memory:",
		rootSessionId: "team",
		cwd,
	});
	const finishes = new Map<string, (result: ChildTurnResult) => void>();
	const runs: string[] = [];
	const loads: string[] = [];
	const disposed: string[] = [];
	const host: ChildSessionHost = {
		async create(options) {
			loads.push(options.agentPath);
			return {
				identity: { rootSessionId: options.rootSessionId, agentPath: options.agentPath },
				sessionId: randomUUID(),
				sessionFile: options.storage.kind === "file" ? join(options.storage.directory, "session.jsonl") : undefined,
				context: () => [],
				forkContext: () => [],
				run: async (text) => {
					runs.push(text);
					return await new Promise<ChildTurnResult>((resolve) => {
						finishes.set(options.agentPath, resolve);
					});
				},
				abort: async () => {
					finishes.get(options.agentPath)?.({ status: "interrupted", text: "partial" });
				},
				dispose: async () => {
					disposed.push(options.agentPath);
				},
			};
		},
	};
	const controller = new CollaborationController({
		store,
		host,
		agentDir: cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [cwd] }),
	});
	cleanups.push(() => controller.shutdown());
	return { cwd, store, controller, host, runs, loads, finishes, disposed };
}

test("reserves duplicate names and execution slots atomically across concurrent spawns", async () => {
	const f = fixture();
	const capacity = COLLABORATION_LIMITS.maxActiveSessions - 1;
	expect(capacity).toBe(15);
	const names = Array.from({ length: capacity + 1 }, (_, index) => `a${index}`);
	const outcomes = await Promise.allSettled(
		[names[0], names[0], ...names.slice(1)].map((name) => f.controller.spawn(caller, name, name, model)),
	);
	expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(capacity);
	expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "busy" } });
	expect(outcomes.at(-1)).toMatchObject({
		status: "rejected",
		reason: { code: "limit_reached", reason: "execution_slots_full" },
	});
	expect(f.runs.sort()).toEqual(names.slice(0, capacity).sort());
	expect(f.controller.list(caller)).toHaveLength(capacity);
	await f.controller.interrupt(caller, names[0]);
	await f.controller.shutdown();
	expect(f.disposed).toHaveLength(capacity);
});

test("task receipts accept 40,000-character objectives while ordinary messages remain bounded", async () => {
	const f = fixture();
	const objective = "界".repeat(COLLABORATION_LIMITS.maxTaskCharacters);
	const contract = delegation();
	contract.task.objective = objective;
	await f.controller.spawn(caller, "large", objective, model, [], undefined, {
		delegation: contract,
		tools: [],
	});
	expect(f.store.read().agents[0].taskMessage?.text).toBe(objective);
	expect(() => f.controller.send(caller, "/root", objective)).toThrow(/8192/);
	f.finishes.get("/root/large")?.({ status: "completed", text: "done" });
	await f.controller.settled();
	const next = delegation();
	next.task.objective = objective;
	await f.controller.followup(caller, "large", objective, undefined, { delegation: next, tools: [] });
	expect(f.store.read().agents[0].taskMessage?.text).toBe(objective);
});

test("a completed turn can accept explicit followup; opening a controller never reruns work", async () => {
	const f = fixture(true);
	await f.controller.spawn(caller, "a", "first", model);
	f.finishes.get("/root/a")?.({ status: "completed", text: "answer" });
	await f.controller.settled();
	expect(f.store.read().agents[0]).toMatchObject({ status: "completed", result: "answer" });
	await f.controller.followup(caller, "a", "second");
	await expect(f.controller.followup(caller, "a", "third")).rejects.toThrow(/follow-up/);
	await f.controller.shutdown();
	const loaded = new CollaborationStore({ path: join(f.cwd, "registry.sqlite"), rootSessionId: "team", cwd: f.cwd });
	cleanups.push(() => loaded.close());
	expect(loaded.read().agents[0].status).toBe("interrupted");
	expect(f.runs).toEqual(["first", "second"]);
});

test("child callers cannot create or direct agents and identity guards still hold", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "parent", "parent", model);
	const child = { ...caller, agentPath: "/root/parent" };
	await expect(f.controller.spawn(child, "one", "one", model)).rejects.toThrow(/Only \/root may create agents/);
	await expect(f.controller.followup(child, "parent", "nested")).rejects.toThrow(/Only \/root may direct agents/);
	await expect(f.controller.spawn({ ...caller, rootSessionId: "other" }, "x", "x", model)).rejects.toThrow(
		/another root/,
	);
	await expect(f.controller.interrupt(child, ".")).rejects.toThrow(/itself/);
	await expect(f.controller.followup(caller, "/root", "root task")).rejects.toThrow(/Unknown child/);
});

test("failed child creation releases execution admission and preserves inspectable failure", async () => {
	const f = fixture();
	f.host.create = async () => {
		throw new Error("synthetic host failure");
	};
	for (let count = 0; count < 4; count++)
		await expect(f.controller.spawn(caller, `bad${count}`, "task", model)).rejects.toThrow(/host failure/);
	expect(f.controller.list(caller).map((agent) => agent.status)).toEqual(["failed", "failed", "failed", "failed"]);
});

test("idle persisted children are unloaded before more native sessions are loaded", async () => {
	const f = fixture(true);
	const capacity = COLLABORATION_LIMITS.maxActiveSessions - 1;
	for (let count = 0; count <= capacity; count++) {
		await f.controller.spawn(caller, `a${count}`, "task", model);
		f.finishes.get(`/root/a${count}`)?.({ status: "completed", text: "done" });
		await f.controller.settled();
	}
	expect(f.disposed).toEqual(["/root/a0"]);
	expect(f.controller.list(caller).filter((agent) => agent.loaded)).toHaveLength(capacity);
	await f.controller.followup(caller, "a0", "reload explicitly");
	expect(f.loads.filter((path) => path === "/root/a0")).toHaveLength(2);
});

test("interrupt does not hold admission while abort waits for a nested control operation", async () => {
	const f = fixture();
	const create = f.host.create;
	f.host.create = async (options) => {
		const session = await create(options);
		const abort = session.abort;
		session.abort = async () => {
			await expect(f.controller.followup(caller, "a", "nested")).rejects.toThrow();
			await abort();
		};
		return session;
	};
	await f.controller.spawn(caller, "a", "first", model);
	await f.controller.interrupt(caller, "a");
	await f.controller.settled();
	expect(f.store.read().agents[0].status).toBe("interrupted");
});

test("completed agents still count toward the total limit and preserve max effort", async () => {
	const f = fixture();
	for (let index = 0; index < 31; index++) {
		await f.controller.spawn(caller, `a${index}`, "task", { ...model, thinkingLevel: "max" });
		f.finishes.get(`/root/a${index}`)?.({ status: "completed", text: "done" });
		await f.controller.settled();
	}
	await expect(f.controller.spawn(caller, "over", "task", model)).rejects.toMatchObject({
		code: "limit_reached",
		reason: "team_agents_full",
	});
	expect(f.store.read().agents.every((agent) => agent.model.thinkingLevel === "max")).toBe(true);
});

test("store rejects a second live owner even when explicit recovery is requested", () => {
	const cwd = root();
	const path = join(cwd, "registry.sqlite");
	const first = new CollaborationStore({ path, cwd, rootSessionId: "team" });
	cleanups.push(() => first.close());
	expect(() => new CollaborationStore({ path, cwd, rootSessionId: "team", recoverInterruptedOwner: true })).toThrow(
		/live controller/,
	);
	expect(() => new CollaborationStore({ path, cwd, rootSessionId: "other" })).toThrow(/another root/);
});

test("snapshot CAS refuses stale updates and graph validation refuses orphan records", () => {
	const cwd = root();
	const store = new CollaborationStore({ path: ":memory:", cwd, rootSessionId: "team" });
	cleanups.push(() => store.close());
	const snapshot = store.read();
	store.commit(snapshot);
	expect(() => store.commit(snapshot)).toThrow(/Stale/);
	const orphan = store.read();
	orphan.agents.push({
		id: randomUUID(),
		path: "/root/missing/child",
		parent: "/root/missing",
		status: "pending",
		model,
		turnId: randomUUID(),
	});
	expect(() => store.commit(orphan)).toThrow(/Missing parent/);
	expect(store.read().agents).toEqual([]);
});

test("a failed durable update stops other executions instead of retrying or admitting more work", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "first", model);
	vi.spyOn(f.store, "commit").mockImplementationOnce(() => {
		throw new Error("synthetic disk failure");
	});
	await expect(f.controller.spawn(caller, "b", "second", model)).rejects.toThrow(/persistence failed/);
	await expect(f.controller.settled()).rejects.toThrow(/persist/);
	await expect(f.controller.spawn(caller, "c", "third", model)).rejects.toThrow(/operator inspection/);
	expect(f.runs).toEqual(["first"]);
});

test("a recycled pid with a mismatched start time is treated as a dead owner", () => {
	const cwd = root();
	const path = join(cwd, "registry.sqlite");
	const store = new CollaborationStore({ path, cwd, rootSessionId: "team" });
	store.close();
	// PID reuse: the recorded pid now belongs to an unrelated live process whose start time
	// does not match the recorded owner's start time — the dead owner must not look alive.
	const reused = spawn("sleep", ["30"], { stdio: "ignore" });
	cleanups.push(() => {
		try {
			reused.kill("SIGKILL");
		} catch {
			// already gone
		}
	});
	const db = new DatabaseSync(path);
	db.prepare("UPDATE team SET owner='reused', pid=?, owner_started_at=?").run(reused.pid!, Date.now() - 3_600_000);
	db.close();
	expect(() => new CollaborationStore({ path, cwd, rootSessionId: "team" })).toThrow(/Explicit recovery/);
	const recovered = new CollaborationStore({ path, cwd, rootSessionId: "team", recoverInterruptedOwner: true });
	cleanups.push(() => recovered.close());
});

test("a live pid with a matching start time is still a busy owner", () => {
	const cwd = root();
	const path = join(cwd, "registry.sqlite");
	const store = new CollaborationStore({ path, cwd, rootSessionId: "team" });
	store.close();
	const live = spawn("sleep", ["30"], { stdio: "ignore" });
	cleanups.push(() => {
		try {
			live.kill("SIGKILL");
		} catch {
			// already gone
		}
	});
	const db = new DatabaseSync(path);
	db.prepare("UPDATE team SET owner='alive', pid=?, owner_started_at=?").run(live.pid!, Date.now());
	db.close();
	expect(() => new CollaborationStore({ path, cwd, rootSessionId: "team" })).toThrow(/live controller/);
});

test("registries predating the owner_started_at column migrate in place", () => {
	const cwd = root();
	const path = join(cwd, "registry.sqlite");
	// An old-format registry has no owner_started_at column; opening it must add the column.
	const db = new DatabaseSync(path);
	db.exec("CREATE TABLE team (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL, owner TEXT, pid INTEGER)");
	db.prepare("INSERT INTO team VALUES (1, ?, NULL, NULL)").run(
		JSON.stringify({ version: 1, rootSessionId: "team", cwd: realpathSync(cwd), revision: 0, agents: [] }),
	);
	db.close();
	const store = new CollaborationStore({ path, cwd, rootSessionId: "team" });
	// The store holds no open transaction after init; a second connection can verify the schema.
	const verify = new DatabaseSync(path, { readOnly: true });
	const columns = (verify.prepare("PRAGMA table_info(team)").all() as Array<{ name: string }>).map((c) => c.name);
	expect(columns).toContain("owner_started_at");
	const acquired = verify.prepare("SELECT owner, pid, owner_started_at FROM team").get() as {
		owner: string | null;
		pid: number | null;
		owner_started_at: number | null;
	};
	expect(acquired.owner).not.toBeNull();
	expect(acquired.owner_started_at).toEqual(expect.any(Number));
	verify.close();
	store.close();
	const after = new DatabaseSync(path, { readOnly: true });
	const released = after.prepare("SELECT owner, owner_started_at FROM team").get() as {
		owner: string | null;
		owner_started_at: number | null;
	};
	expect(released).toMatchObject({ owner: null, owner_started_at: null });
	after.close();
});

test("a dead owner's running state requires explicit recovery and becomes interrupted", () => {
	const cwd = root();
	const path = join(cwd, "registry.sqlite");
	const store = new CollaborationStore({ path, cwd, rootSessionId: "team" });
	const snapshot = store.read();
	snapshot.agents.push({
		id: randomUUID(),
		path: "/root/a",
		parent: "/root",
		status: "running",
		completionPending: true,
		model,
		turnId: randomUUID(),
	});
	store.commit(snapshot);
	store.close();
	const retiredPid = Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }).trim());
	const db = new DatabaseSync(path);
	db.prepare("UPDATE team SET owner='crashed', pid=?").run(retiredPid);
	db.close();
	expect(() => new CollaborationStore({ path, cwd, rootSessionId: "team" })).toThrow(/Explicit recovery/);
	const recovered = new CollaborationStore({ path, cwd, rootSessionId: "team", recoverInterruptedOwner: true });
	cleanups.push(() => recovered.close());
	expect(recovered.read().agents[0].status).toBe("interrupted");
	expect(recovered.read().messages).toMatchObject([
		{ from: "/root/a", to: "/root", kind: "result", status: "interrupted" },
	]);
});

test("cancellation during host creation preserves the child but never starts its task", async () => {
	const f = fixture(true);
	const original = f.host.create;
	let entered!: () => void;
	let release!: () => void;
	const creating = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.host.create = async (options) => {
		entered();
		await released;
		return original(options);
	};
	const abort = new AbortController();
	const spawn = f.controller.spawn(caller, "cancelled", "must not run", model, undefined, abort.signal);
	await creating;
	abort.abort();
	release();
	await expect(spawn).rejects.toThrow(/cancelled/);
	await expect(f.controller.send(caller, "/root", "cancelled send", abort.signal)).rejects.toThrow(/cancelled/);
	expect(f.controller.pending(caller)).toEqual([]);
	expect(f.runs).toEqual([]);
	expect(f.store.read().agents[0]).toMatchObject({
		status: "interrupted",
		completionPending: false,
		sessionFile: "session.jsonl",
	});
	await f.controller.followup(caller, "cancelled", "explicit retry");
	expect(f.runs).toEqual(["explicit retry"]);
});

test("send is durable but never starts or reloads an idle target; only the receiver can acknowledge", async () => {
	const f = fixture(true);
	await f.controller.spawn(caller, "a", "initial", model);
	f.finishes.get("/root/a")?.({ status: "completed", text: "result" });
	await f.controller.settled();
	const child = { ...caller, agentPath: "/root/a" };
	const id = await f.controller.send(caller, "a", "queued only");
	expect(f.runs).toEqual(["initial"]);
	await f.controller.acknowledge(caller, [id]);
	expect(f.controller.pending(child)).toMatchObject([{ id, text: "queued only", from: "/root" }]);
	await expect(f.controller.send({ ...caller, rootSessionId: "other" }, "a", "escape")).rejects.toThrow(
		/another root/,
	);
	await f.controller.shutdown();
	const restored = new CollaborationStore({ path: join(f.cwd, "registry.sqlite"), cwd: f.cwd, rootSessionId: "team" });
	cleanups.push(() => restored.close());
	expect(restored.read().messages?.some((message) => message.id === id)).toBe(true);
	expect(f.runs).toEqual(["initial"]);
});

test("completion reserves mailbox capacity before admission, so a full inbox cannot lose the result", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "task", model);
	for (let index = 0; index < 63; index++) await f.controller.send(caller, "/root", `message ${index}`);
	await expect(f.controller.send(caller, "/root", "overflow")).rejects.toMatchObject({
		code: "limit_reached",
		reason: "mailbox_full",
	});
	await expect(f.controller.spawn(caller, "b", "task", model)).rejects.toMatchObject({
		code: "limit_reached",
		reason: "mailbox_full",
	});
	f.finishes.get("/root/a")?.({ status: "completed", text: "retained result" });
	await f.controller.settled();
	expect(f.controller.pending(caller)).toHaveLength(64);
	expect(f.controller.pending(caller)[63]).toMatchObject({ from: "/root/a", kind: "result", text: "retained result" });
	await f.controller.acknowledge(
		caller,
		f.controller.pending(caller).map((message) => message.id),
	);
	const receipt = await f.controller.followup(caller, "a", "explicit followup");
	expect(f.store.read().agents[0].taskMessage).toMatchObject({ id: receipt, text: "explicit followup", kind: "task" });
});

test("failed acknowledgement retains pending messages and stops future admission", async () => {
	const f = fixture();
	const id = await f.controller.send(caller, "/root", "retained");
	vi.spyOn(f.store, "commit").mockImplementationOnce(() => {
		throw new Error("disk failure");
	});
	await expect(f.controller.acknowledge(caller, [id])).rejects.toThrow(/persistence failed/);
	expect(f.store.read().messages).toMatchObject([{ id, text: "retained" }]);
	await expect(f.controller.send(caller, "/root", "later")).rejects.toThrow(/operator inspection/);
});

test("unknown snapshots and symlink paths are rejected without overwriting source files", () => {
	const cwd = root();
	const path = join(cwd, "registry.sqlite");
	const store = new CollaborationStore({ path, cwd, rootSessionId: "team" });
	store.close();
	const db = new DatabaseSync(path);
	db.prepare("UPDATE team SET snapshot=?").run(JSON.stringify({ version: 99 }));
	db.close();
	const before = readFileSync(path);
	expect(() => new CollaborationStore({ path, cwd, rootSessionId: "team" })).toThrow(/Invalid team snapshot/);
	expect(readFileSync(path)).toEqual(before);
	const other = join(cwd, "other.sqlite");
	symlinkSync(path, other);
	expect(() => new CollaborationStore({ path: other, cwd, rootSessionId: "team" })).toThrow(/Unsafe/);
	const unrelated = join(cwd, "unrelated");
	writeFileSync(unrelated, "not sqlite");
	expect(() => new CollaborationStore({ path: unrelated, cwd, rootSessionId: "team" })).toThrow();
	expect(readFileSync(unrelated, "utf8")).toBe("not sqlite");
});

test("team tools are never delegated and capability ceilings cannot be widened on followup", async () => {
	const f = fixture();
	const rootTools = ["read", "bash", "spawn_agent"];
	f.controller.bindTools(caller, () => rootTools);
	// Explicitly naming a team tool is rejected even though /root holds it.
	await expect(
		f.controller.spawn(caller, "bad", "inspect", model, [], undefined, {
			delegation: delegation({ capabilities: { tools: ["read", "spawn_agent"] } }),
			tools: rootTools,
		}),
	).rejects.toThrow(/Team tools are usable by \/root only/);
	// "inherit" keeps the child's ceiling within the caller's live set.
	await f.controller.spawn(caller, "sib", "inspect", model, [], undefined, {
		delegation: delegation(),
		tools: rootTools,
	});
	const sib = { ...caller, agentPath: "/root/sib" };
	expect(f.controller.toolAllowed(sib, "bash")).toBe(true);
	f.finishes.get(sib.agentPath)?.({ status: "completed", text: "done" });
	// A ceiling set at spawn cannot be widened by a later followup.
	await f.controller.spawn(caller, "parent", "inspect", model, [], undefined, {
		delegation: delegation({ capabilities: { tools: ["read"] } }),
		tools: rootTools,
	});
	const parent = { ...caller, agentPath: "/root/parent" };
	expect(f.controller.toolAllowed(parent, "read")).toBe(true);
	expect(f.controller.toolAllowed(parent, "bash")).toBe(false);
	f.finishes.get(parent.agentPath)?.({ status: "completed", text: "done" });
	await f.controller.settled();
	await expect(f.controller.followup(caller, "parent", "old plain task")).rejects.toThrow(/explicit task/);
	await f.controller.followup(caller, "parent", "widen attempt", undefined, {
		delegation: delegation({ capabilities: { tools: ["read", "bash"] } }),
		tools: ["read", "bash"],
	});
	expect(f.controller.toolAllowed(parent, "bash")).toBe(false);
});

test("task/result contracts persist and final return targets creation parent rather than later sender", async () => {
	const f = fixture(true);
	const admission = { delegation: delegation(), tools: ["read"] };
	await f.controller.spawn(caller, "a", "initial", model, [], undefined, admission);
	f.finishes.get("/root/a")?.({ status: "completed", text: "unstructured retained answer" });
	await f.controller.settled();
	expect(f.store.read().agents[0].resultValidation).toEqual({ contract: "invalid" });
	expect(f.controller.pending(caller)[0]).toMatchObject({
		text: "unstructured retained answer",
		resultValidation: { contract: "invalid" },
	});
	await f.controller.spawn(caller, "peer", "peer", model, [], undefined, admission);
	f.finishes.get("/root/peer")?.({ status: "completed", text: "peer done" });
	await f.controller.settled();
	await f.controller.followup(caller, "/root/a", "new task", undefined, admission);
	expect(f.store.read().agents[0].taskMessage).toMatchObject({
		from: "/root",
		parent: "/root",
		contextUse: "existing",
		delegation: admission.delegation,
	});
	expect(f.store.read().agents[0].resultValidation).toBeUndefined();
	const answer = JSON.stringify({
		summary: "Verified format only; not independently reviewed",
		outcome: "partial",
	});
	f.finishes.get("/root/a")?.({ status: "completed", text: answer });
	await f.controller.settled();
	expect(f.controller.pending(caller).at(-1)).toMatchObject({
		from: "/root/a",
		to: "/root",
		resultValidation: { contract: "valid", outcome: "partial" },
	});
	const runs = [...f.runs];
	await f.controller.shutdown();
	const restored = new CollaborationStore({ path: join(f.cwd, "registry.sqlite"), rootSessionId: "team", cwd: f.cwd });
	cleanups.push(() => restored.close());
	expect(restored.read().agents[0]).toMatchObject({
		delegation: admission.delegation,
		tools: ["read"],
		result: answer,
	});
	expect(f.runs).toEqual(runs);
});

test("an existing implementation child cannot become an independent reviewer", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "initial", model, [], undefined, { delegation: delegation(), tools: [] });
	f.finishes.get("/root/a")?.({ status: "completed", text: "biased prior answer" });
	await f.controller.settled();
	const review = delegation();
	review.task.relationship = "verify";
	await expect(
		f.controller.followup(caller, "a", "review", undefined, { delegation: review, tools: [] }),
	).rejects.toThrow(/fresh child/);
	expect(f.runs).toEqual(["initial"]);
});

test("failed cold followup retains one coherent failed task rather than mixing old and new turns", async () => {
	const f = fixture(true);
	const capacity = COLLABORATION_LIMITS.maxActiveSessions - 1;
	for (let index = 0; index <= capacity; index++) {
		await f.controller.spawn(caller, `a${index}`, "old task", model, [], undefined, {
			delegation: delegation(),
			tools: ["read"],
		});
		f.finishes.get(`/root/a${index}`)?.({ status: "completed", text: "old result" });
		await f.controller.settled();
	}
	const old = f.store.read().agents[0];
	const next = delegation();
	next.task.objective = "new task";
	f.host.create = async () => {
		throw new Error("synthetic cold load failure");
	};
	await expect(
		f.controller.followup(caller, "a0", "new task", undefined, {
			delegation: next,
			tools: ["read"],
		}),
	).rejects.toThrow(/cold load failure/);
	const record = f.store.read().agents[0];
	expect(record).toMatchObject({
		status: "failed",
		delegation: next,
		completionPending: false,
		taskMessage: { delegation: next, text: "new task", contextUse: "existing" },
		resultValidation: { contract: "not_completed" },
	});
	expect(record.turnId).not.toBe(old.turnId);
	expect(record.taskMessage?.turnId).toBe(record.turnId);
	expect(record.result).not.toBe("old result");
	expect(f.runs).toHaveLength(capacity + 1);
});

test("a stalled child load does not block another child's interrupt, messages or completion", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "first", model);
	const create = f.host.create;
	let entered!: () => void;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.host.create = async (options) => {
		entered();
		await barrier;
		return create(options);
	};
	const spawning = f.controller.spawn(caller, "b", "second", model);
	await ready;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const operations = Promise.all([
		f.controller.send(caller, "/root", "control stays responsive"),
		f.controller.interrupt(caller, "a"),
	]);
	try {
		await Promise.race([
			operations,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("control queue blocked by child load")), 200);
			}),
		]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.controller.pending(caller).some((message) => message.kind === "result")).toBe(true);
		expect(f.store.read().agents[0].status).toBe("interrupted");
	} finally {
		clearTimeout(timer);
		release();
		await spawning;
		await operations;
	}
});

test("pending startup can be interrupted before a non-cooperative host returns, with its slot retained", async () => {
	const f = fixture();
	const create = f.host.create;
	let entered!: () => void;
	let release!: () => void;
	let signal: AbortSignal | undefined;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.host.create = async (options) => {
		signal = options.signal;
		entered();
		await barrier;
		return create(options);
	};
	const spawning = f.controller.spawn(caller, "a", "never run", model);
	const rejected = expect(spawning).rejects.toThrow(/cancelled|interrupted/i);
	await ready;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const interrupt = f.controller.interrupt(caller, "a");
	try {
		expect(
			await Promise.race([
				interrupt,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("pending interrupt blocked")), 200);
				}),
			]),
		).toBe("pending");
		expect(signal?.aborted).toBe(true);
		expect(f.controller.list(caller)[0].status).toBe("interrupted");
		await expect(f.controller.followup(caller, "a", "must not race startup")).rejects.toThrow(/follow-up/);
	} finally {
		clearTimeout(timer);
		release();
		await interrupt;
		await rejected;
	}
	expect(f.runs).toEqual([]);
	expect(f.disposed).toEqual(["/root/a"]);
});

test("startup reservations bound capacity and reject duplicate followups even before execution", async () => {
	const f = fixture();
	const create = f.host.create;
	let entered!: () => void;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.host.create = async (options) => {
		entered();
		await barrier;
		return create(options);
	};
	const a = f.controller.spawn(caller, "a", "a", model);
	await ready;
	const b = f.controller.spawn(caller, "b", "b", model);
	const rejected = expect(b).rejects.toThrow(/cancelled/);
	const capacity = COLLABORATION_LIMITS.maxActiveSessions - 1;
	const remaining = Array.from({ length: capacity - 2 }, (_, index) => `c${index}`);
	const admitted = remaining.map((name) => f.controller.spawn(caller, name, name, model));
	try {
		await expect(f.controller.spawn(caller, "over", "over", model)).rejects.toThrow(/execution limit/);
		expect(f.controller.list(caller).map((agent) => agent.status)).toEqual(Array(capacity).fill("pending"));
		await expect(f.controller.followup(caller, "b", "duplicate")).rejects.toThrow(/follow-up/);
		expect(await f.controller.interrupt(caller, "b")).toBe("pending");
		await expect(f.controller.spawn(caller, "over", "still reserved", model)).rejects.toThrow(/execution limit/);
	} finally {
		release();
		await Promise.all([a, ...admitted, rejected]);
	}
	expect(f.loads).toEqual(["/root/a", ...remaining.map((name) => `/root/${name}`)]);
	expect(f.runs).toEqual(["a", ...remaining]);
});

test("idle unload may await a control operation without deadlocking admission", async () => {
	const f = fixture(true);
	const capacity = COLLABORATION_LIMITS.maxActiveSessions - 1;
	const create = f.host.create;
	f.host.create = async (options) => {
		const session = await create(options);
		const dispose = session.dispose;
		session.dispose = async () => {
			if (options.agentPath === "/root/a0") await f.controller.send(caller, "/root", "unloading a0");
			await dispose();
		};
		return session;
	};
	for (let index = 0; index <= capacity; index++) {
		await f.controller.spawn(caller, `a${index}`, "task", model);
		f.finishes.get(`/root/a${index}`)?.({ status: "completed", text: "done" });
		await f.controller.settled();
	}
	expect(f.controller.pending(caller).some((message) => message.text === "unloading a0")).toBe(true);
	expect(f.disposed).toEqual(["/root/a0"]);
});

test("shutdown cancels startup and aborts existing children before waiting for late host cleanup", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "active", model);
	const create = f.host.create;
	let entered!: () => void;
	let release!: () => void;
	let signal: AbortSignal | undefined;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.host.create = async (options) => {
		signal = options.signal;
		entered();
		await barrier;
		return create(options);
	};
	const pending = f.controller.spawn(caller, "b", "must not run", model);
	const rejected = expect(pending).rejects.toThrow(/cancelled/);
	await ready;
	const shutdown = f.controller.shutdown();
	try {
		expect(signal?.aborted).toBe(true);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.store.read().agents[0].status).toBe("interrupted");
		expect(f.runs).toEqual(["active"]);
	} finally {
		release();
		await rejected;
		await shutdown;
	}
	expect(f.disposed.sort()).toEqual(["/root/a", "/root/b"]);
});

test.each(["pending", "running"])("shutdown during the %s notification cannot start new work", async (status) => {
	const f = fixture(true);
	const create = f.host.create;
	f.host.create = async (options) => {
		const session = await create(options);
		session.run = async (text) => {
			f.runs.push(text);
			return { status: "completed", text: "must not execute" };
		};
		return session;
	};
	let stopping = false;
	let shutdown: Promise<void> | undefined;
	f.controller.subscribe(() => {
		if (!stopping && f.store.read().agents[0]?.status === status) {
			stopping = true;
			shutdown = f.controller.shutdown();
		}
	});
	await Promise.allSettled([f.controller.spawn(caller, "a", "must not run", model)]);
	expect(stopping).toBe(true);
	await shutdown;
	expect(f.loads).toHaveLength(status === "pending" ? 0 : 1);
	expect(f.runs).toEqual([]);
	const restored = new CollaborationStore({ path: join(f.cwd, "registry.sqlite"), rootSessionId: "team", cwd: f.cwd });
	cleanups.push(() => restored.close());
	expect(restored.read().agents[0]).toMatchObject({ status: "interrupted", completionPending: false });
});

test("startup cancellation during the running notification is checked before the first run", async () => {
	const f = fixture();
	const abort = new AbortController();
	f.controller.subscribe(() => {
		if (f.store.read().agents[0]?.status === "running") abort.abort();
	});
	await f.controller.spawn(caller, "a", "must not run", model, undefined, abort.signal);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(f.runs).toEqual([]);
	await f.controller.settled();
	expect(f.store.read().agents[0]).toMatchObject({ status: "interrupted", completionPending: false });
});

test("tool authority queries do not decode the mailbox and still see live revocation", async () => {
	const f = fixture();
	let tools = ["read", "bash"];
	f.controller.bindTools(caller, () => tools);
	await f.controller.spawn(caller, "a", "task", model, [], undefined, {
		delegation: delegation(),
		tools,
	});
	f.finishes.get("/root/a")?.({ status: "completed", text: "done" });
	await f.controller.settled();
	await f.controller.send(caller, "a", "x".repeat(8192));
	const child = { ...caller, agentPath: "/root/a" };
	expect(f.controller.toolAllowed(child, "bash")).toBe(true);
	const read = vi.spyOn(f.store, "read");
	for (let index = 0; index < 10; index++) expect(f.controller.toolAllowed(child, "read")).toBe(true);
	tools = ["read"];
	expect(f.controller.toolAllowed(child, "bash")).toBe(false);
	expect(read).not.toHaveBeenCalled();
	read.mockRestore();
});

test("authority projections are immutable and update only after a successful commit", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "task", model, [], undefined, {
		delegation: delegation(),
		tools: ["read", "bash"],
	});
	const previous = f.store.readAuthority();
	expect(Object.isFrozen(previous)).toBe(true);
	expect(Object.isFrozen(previous[0])).toBe(true);
	expect(Object.isFrozen(previous[0].tools)).toBe(true);
	expect(Reflect.set(previous[0], "status", "closed")).toBe(false);
	const next = f.store.read();
	next.agents[0].tools = ["read"];
	const committed = f.store.commit(next);
	committed.agents[0].tools = ["bash"];
	expect(f.store.readAuthority()[0].tools).toEqual(["read"]);
	expect(previous[0].tools).toEqual(["read", "bash"]);
	expect(() => f.store.commit(next)).toThrow(/Stale/);
	expect(f.store.readAuthority()[0].tools).toEqual(["read"]);
});

test("authority reads detect external database changes and ownership loss without stale grants", async () => {
	const f = fixture(true);
	await f.controller.spawn(caller, "a", "task", model, [], undefined, {
		delegation: delegation(),
		tools: ["read", "bash"],
	});
	const child = { ...caller, agentPath: "/root/a" };
	expect(f.controller.toolAllowed(child, "bash")).toBe(true);
	const changed = f.store.read();
	changed.agents[0].tools = ["read"];
	changed.revision++;
	const database = new DatabaseSync(join(f.cwd, "registry.sqlite"));
	const owner = database.prepare("SELECT owner FROM team WHERE id=1").get()!.owner;
	try {
		database.prepare("UPDATE team SET snapshot=? WHERE id=1").run(JSON.stringify(changed));
		const reads = vi.spyOn(f.store, "read");
		expect(f.controller.toolAllowed(child, "bash")).toBe(false);
		expect(f.controller.toolAllowed(child, "read")).toBe(true);
		expect(reads).toHaveBeenCalledTimes(1);
		reads.mockRestore();
		database.prepare("UPDATE team SET owner='other-controller' WHERE id=1").run();
		expect(() => f.controller.toolAllowed(child, "read")).toThrow(/ownership was lost/);
	} finally {
		database.prepare("UPDATE team SET owner=? WHERE id=1").run(owner);
		database.close();
	}
});

test("unbinding after live narrowing persists the reduced tool authority", async () => {
	const f = fixture(true);
	const admission = { delegation: delegation(), tools: ["read", "bash"] };
	await f.controller.spawn(caller, "parent", "parent", model, [], undefined, admission);
	const parent = { ...caller, agentPath: "/root/parent" };
	expect(f.controller.toolAllowed(parent, "bash")).toBe(true);
	const detach = f.controller.bindTools(parent, () => ["read"]);
	detach();
	expect(f.controller.toolAllowed(parent, "bash")).toBe(false);
	expect(f.store.read().agents[0].tools).toEqual(["read"]);
	await f.controller.shutdown();
	const restored = new CollaborationStore({ path: join(f.cwd, "registry.sqlite"), rootSessionId: "team", cwd: f.cwd });
	cleanups.push(() => restored.close());
	expect(restored.read().agents[0].tools).toEqual(["read"]);
});

test("close retires a settled descendant, releases its slot and session, and never its name", async () => {
	const f = fixture();
	for (let count = 0; count < COLLABORATION_LIMITS.maxAgents - 1; count++) {
		await f.controller.spawn(caller, `a${count}`, `task ${count}`, model);
		f.finishes.get(`/root/a${count}`)?.({ status: "completed", text: `done ${count}` });
		await f.controller.settled();
	}
	expect(f.controller.list(caller)).toHaveLength(COLLABORATION_LIMITS.maxAgents - 1);
	await expect(f.controller.spawn(caller, "extra", "task", model)).rejects.toThrow(/agent limit/);
	expect(await f.controller.close(caller, "a5")).toBe("completed");
	expect(f.store.read().agents.find((agent) => agent.path === "/root/a5")).toMatchObject({
		status: "closed",
		completionPending: false,
		result: "done 5",
	});
	expect(f.disposed).toEqual(["/root/a5"]);
	expect(f.controller.list(caller).find((agent) => agent.task_name === "/root/a5")).toMatchObject({
		status: "closed",
		loaded: false,
	});
	await f.controller.spawn(caller, "extra", "task", model);
	await expect(f.controller.spawn(caller, "a5", "task", model)).rejects.toThrow(/already exists/);
	await expect(f.controller.spawn(caller, "another", "task", model)).rejects.toThrow(/agent limit/);
});

test("retained history exhaustion rejects a new child without poisoning the team", async () => {
	const f = fixture();
	const snapshot = f.store.read();
	for (let index = 0; index < COLLABORATION_LIMITS.maxRetainedAgents - 1; index++) {
		snapshot.agents.push({
			id: randomUUID(),
			path: `/root/retired${index}`,
			parent: "/root",
			status: "closed",
			model,
			turnId: randomUUID(),
		});
	}
	f.store.commit(snapshot);
	await f.controller.spawn(caller, "last", "task", model);
	f.finishes.get("/root/last")?.({ status: "completed", text: "done" });
	await f.controller.settled();
	await f.controller.close(caller, "last");
	await expect(f.controller.spawn(caller, "extra", "task", model)).rejects.toMatchObject({
		code: "limit_reached",
		reason: "team_history_full",
	});
	expect(await f.controller.send(caller, "/root", "team still works")).toEqual(expect.any(String));
	expect(f.store.read().agents).toHaveLength(COLLABORATION_LIMITS.maxRetainedAgents);
});

test("close requires a settled child and stays idempotent and terminal", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "a", model);
	await expect(f.controller.close(caller, "a")).rejects.toThrow(/Interrupt a running child/);
	await f.controller.interrupt(caller, "a");
	await f.controller.settled();
	expect(await f.controller.close(caller, "a")).toBe("interrupted");
	await expect(f.controller.send(caller, "a", "hello")).rejects.toThrow(/Unknown receiving agent/);
	await expect(
		f.controller.followup(caller, "a", "again", undefined, { delegation: delegation(), tools: ["read"] }),
	).rejects.toThrow(/follow-up/);
	expect(await f.controller.close(caller, "a")).toBe("closed");
	await expect(f.controller.spawn(caller, "a", "task", model)).rejects.toThrow(/already exists/);
	await expect(f.controller.close(caller, "/root/missing")).rejects.toThrow(/Unknown child/);
});

test.each([false, true])(
	"four turns retain distinct task/result/usage after ack, close and reopen (%s)",
	async (file) => {
		const f = fixture(file);
		const turns: Array<{ turn: string; task: string; message: string }> = [];
		for (let index = 0; index < 4; index++) {
			if (index === 0) await f.controller.spawn(caller, "a", `task ${index}`, model);
			else await f.controller.followup(caller, "a", `task ${index}`);
			const admitted = f.store.read().agents[0];
			f.finishes.get("/root/a")?.({
				status: "completed",
				text: `answer ${index}`,
				usage: {
					input: index + 1,
					output: 2,
					cacheRead: 3,
					cacheWrite: 4,
					totalTokens: index + 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			await f.controller.settled();
			const message = f.controller.pending(caller)[0].id;
			turns.push({ turn: admitted.turnId, task: admitted.taskMessage!.id, message });
			await f.controller.acknowledge(caller, [message]);
			const ack = f.store.getTurn("/root/a", { message_id: message })!.delivery.acknowledged_at;
			await f.controller.acknowledge(caller, [message]);
			expect(f.store.getTurn("/root/a", { message_id: message })!.delivery.acknowledged_at).toBe(ack);
		}
		await f.controller.close(caller, "a");
		function check(store: CollaborationStore) {
			expect(store.countTurns()).toBe(4);
			for (const [index, ids] of turns.entries())
				expect(store.getTurn("/root/a", { turn_id: ids.turn })).toMatchObject({
					task_message_id: ids.task,
					result_message_id: ids.message,
					task_preview: `task ${index}`,
					status: "completed",
					result: { preview: `answer ${index}`, truncated: false },
					usage: { input: index + 1, coverage: "complete" },
					delivery: { state: "acknowledged" },
				});
		}
		check(f.store);
		expect(f.runs).toHaveLength(4);
		expect(f.loads).toHaveLength(1);
		if (file) {
			await f.controller.shutdown();
			const restored = new CollaborationStore({
				path: join(f.cwd, "registry.sqlite"),
				cwd: f.cwd,
				rootSessionId: "team",
			});
			cleanups.push(() => restored.close());
			check(restored);
			expect(f.runs).toHaveLength(4);
		}
	},
);

test("startup failure has a terminal ledger without notification and interrupted usage is partial", async () => {
	const f = fixture();
	const original = f.host.create;
	f.host.create = async () => {
		throw new Error("failed startup");
	};
	await expect(f.controller.spawn(caller, "bad", "task", model)).rejects.toThrow(/failed startup/);
	const bad = f.store.read().agents[0];
	expect(f.store.getTurn(bad.path, { turn_id: bad.turnId })).toMatchObject({
		status: "failed",
		finished_at: expect.any(Number),
		started_at: null,
		result_message_id: null,
		delivery: { state: "not_enqueued" },
	});
	expect(f.controller.pending(caller)).toEqual([]);
	f.host.create = original;
	await f.controller.spawn(caller, "abort", "task", model);
	await f.controller.interrupt(caller, "abort");
	await f.controller.settled();
	const interrupted = f.store.read().agents[1];
	expect(f.store.getTurn(interrupted.path, { turn_id: interrupted.turnId })).toMatchObject({
		status: "interrupted",
		usage: { coverage: "partial", input: null, output: null },
	});
});

test("turn capacity rejection is before persistence/loading and does not poison the controller", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "one", model);
	f.finishes.get("/root/a")?.({ status: "completed", text: "done" });
	await f.controller.settled();
	const original = f.store.assertTurnCapacity.bind(f.store);
	const capacity = vi.spyOn(f.store, "assertTurnCapacity").mockImplementation(() => {
		throw new CollaborationError("limit_reached", "Turn history full", "turn_history_full");
	});
	const commit = vi.spyOn(f.store, "commit");
	await expect(f.controller.followup(caller, "a", "not admitted")).rejects.toMatchObject({
		reason: "turn_history_full",
	});
	await expect(f.controller.spawn(caller, "b", "not admitted", model)).rejects.toMatchObject({
		reason: "turn_history_full",
	});
	expect(commit).not.toHaveBeenCalled();
	expect(f.loads).toHaveLength(1);
	expect(f.runs).toHaveLength(1);
	capacity.mockImplementation(original);
	await f.controller.acknowledge(
		caller,
		f.controller.pending(caller).map((message) => message.id),
	);
	expect(await f.controller.send(caller, "/root", "still usable")).toEqual(expect.any(String));
});

test("Unicode preview fits byte budget including marker and preserves native turn-only source", async () => {
	const f = fixture(true);
	await f.controller.spawn(caller, "a", "task", model);
	f.finishes.get("/root/a")?.({ status: "completed", text: "🙂界".repeat(COLLABORATION_LIMITS.maxResultBytes) });
	await f.controller.settled();
	const current = f.store.read().agents[0];
	const turn = f.store.getTurn(current.path, { turn_id: current.turnId })!;
	expect(Buffer.byteLength(turn.result!.preview)).toBeLessThanOrEqual(COLLABORATION_LIMITS.maxResultBytes);
	expect(turn.result!.preview).not.toContain("�");
	expect(turn.result!.truncated).toBe(true);
	expect(turn.result!.source).toEqual({
		kind: "native_history",
		session_path: join(realpathSync(f.cwd), current.id, "session.jsonl"),
		turn_id: current.turnId,
		coverage: "turn",
	});
	await f.controller.close(caller, "a");
	expect(f.store.getTurn(current.path, { turn_id: current.turnId })!.result!.truncated).toBe(true);
});

test("interrupt request is not ledger settlement while a noncooperative run is still alive", async () => {
	const f = fixture();
	const original = f.host.create;
	f.host.create = async (options) => {
		const session = await original(options);
		session.abort = async () => {};
		return session;
	};
	await f.controller.spawn(caller, "a", "task", model);
	const current = f.store.read().agents[0];
	await f.controller.interrupt(caller, "a");
	expect(f.store.read().agents[0].status).toBe("interrupted");
	expect(f.store.getTurn(current.path, { turn_id: current.turnId })).toMatchObject({
		status: "running",
		finished_at: null,
	});
	expect(f.controller.pending(caller)).toEqual([]);
	f.finishes.get("/root/a")?.({ status: "interrupted", text: "partial" });
	await f.controller.settled();
	expect(f.store.getTurn(current.path, { turn_id: current.turnId })).toMatchObject({
		status: "interrupted",
		finished_at: expect.any(Number),
		usage: { coverage: "partial", input: null },
	});
});

test("interrupted pending startup becomes terminal only after late host cleanup", async () => {
	const f = fixture();
	const original = f.host.create;
	let entered!: () => void;
	let release!: () => void;
	const creating = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.host.create = async (options) => {
		entered();
		await barrier;
		return original(options);
	};
	const spawning = f.controller.spawn(caller, "a", "task", model);
	const rejected = expect(spawning).rejects.toThrow(/cancelled/);
	await creating;
	const current = f.store.read().agents[0];
	await f.controller.interrupt(caller, "a");
	expect(f.store.getTurn(current.path, { turn_id: current.turnId })).toMatchObject({
		status: "pending",
		finished_at: null,
	});
	release();
	await rejected;
	expect(f.store.getTurn(current.path, { turn_id: current.turnId })).toMatchObject({
		status: "interrupted",
		finished_at: expect.any(Number),
		result_message_id: null,
	});
	expect(f.runs).toEqual([]);
});

test("read-only result lookup survives ack/followup/close/cold reopen without running or consuming", async () => {
	const f = fixture(true);
	const receipt = await f.controller.spawnTurn(caller, "a", "first", model);
	expect(receipt).toMatchObject({ task_name: "/root/a", turn_id: expect.any(String), message_id: expect.any(String) });
	expect(f.controller.getAgentResult(caller, { target: "a" })).toMatchObject({
		state: "pending",
		turn: { turn_id: receipt.turn_id, task_message_id: receipt.message_id },
	});
	f.finishes.get("/root/a")?.({ status: "completed", text: "first result" });
	await f.controller.settled();
	const message = f.controller.pending(caller)[0];
	const before = f.controller.pending(caller);
	expect(f.controller.getAgentResult(caller, { target: "a", message_id: message.id })).toMatchObject({
		state: "found",
		result: { preview: "first result" },
	});
	expect(f.controller.pending(caller)).toEqual(before);
	await f.controller.acknowledge(caller, [message.id]);
	const second = await f.controller.followupTurn(caller, "a", "second");
	expect(second.turn_id).not.toBe(receipt.turn_id);
	expect(f.controller.getAgentResult(caller, { target: "a", turn_id: receipt.turn_id })).toMatchObject({
		state: "found",
		turn: { delivery: { state: "acknowledged" } },
		result: { preview: "first result" },
	});
	expect(f.controller.getAgentResult(caller, { target: "a" })).toMatchObject({
		state: "pending",
		turn: { turn_id: second.turn_id },
	});
	f.finishes.get("/root/a")?.({ status: "completed", text: "second result" });
	await f.controller.settled();
	await f.controller.close(caller, "a");
	expect(f.controller.getAgentResult(caller, { target: "a", message_id: message.id })).toMatchObject({
		state: "found",
		turn: { status: "completed" },
		result: { preview: "first result" },
	});
	await f.controller.shutdown();
	const store = new CollaborationStore({ path: join(f.cwd, "registry.sqlite"), cwd: f.cwd, rootSessionId: "team" });
	const controller = new CollaborationController({
		store,
		host: f.host,
		agentDir: f.cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
	});
	cleanups.push(() => controller.shutdown());
	expect(controller.getAgentResult(caller, { target: "a", turn_id: receipt.turn_id })).toMatchObject({
		state: "found",
		result: { preview: "first result" },
	});
	expect(controller.list(caller)[0]).toMatchObject({
		turn_id: second.turn_id,
		task_message_id: second.message_id,
		result_message_id: expect.any(String),
		history_coverage: "complete",
		turn_usage: { coverage: "unknown", input: null },
		usage_scope: "latest_turn",
	});
	expect(f.runs).toEqual(["first", "second"]);
	expect(f.loads).toEqual(["/root/a"]);
});

test("history cursor binds root/target and stable high-water membership; pages never include bodies", async () => {
	const f = fixture();
	const ids: string[] = [];
	for (let index = 0; index < 3; index++) {
		const receipt =
			index === 0
				? await f.controller.spawnTurn(caller, "a", `task ${index}`, model)
				: await f.controller.followupTurn(caller, "a", `task ${index}`);
		ids.push(receipt.turn_id);
		f.finishes.get("/root/a")?.({ status: "completed", text: `result ${index}` });
		await f.controller.settled();
	}
	const first = f.controller.listAgentTurns(caller, { target: "a", limit: 1 });
	expect(first.turns.map((turn) => turn.turn_id)).toEqual(ids.slice(0, 1));
	expect(first.next_cursor).toEqual(expect.any(String));
	await f.controller.followup(caller, "a", "fourth");
	f.finishes.get("/root/a")?.({ status: "completed", text: "late" });
	await f.controller.settled();
	const second = f.controller.listAgentTurns(caller, { target: "/root/a", cursor: first.next_cursor, limit: 20 });
	expect(second.turns.map((turn) => turn.turn_id)).toEqual(ids.slice(1));
	expect(second.next_cursor).toBeNull();
	expect(second.turns[0]).not.toHaveProperty("result");
	expect(second.turns[0]).not.toHaveProperty("delegation");
	expect(f.controller.listAgentTurns(caller, { target: "a" }).turns).toHaveLength(4);
	await f.controller.spawn(caller, "b", "b", model);
	expect(() => f.controller.listAgentTurns(caller, { target: "b", cursor: first.next_cursor })).toThrow(
		/Foreign|invalid/i,
	);
	const cursor = JSON.parse(Buffer.from(first.next_cursor!, "base64url").toString());
	for (const payload of [
		null,
		[],
		{},
		{ ...cursor, after: 0 },
		{ ...cursor, after: 1.5 },
		{ ...cursor, highWater: 9999 },
		{ ...cursor, extra: true },
		{ ...cursor, scope: "foreign-root" },
	]) {
		const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
		expect(() => f.controller.listAgentTurns(caller, { target: "a", cursor: encoded })).toThrow(CollaborationError);
	}
	for (const malformed of ["x", "%%%%", `${first.next_cursor!}=`, "A".repeat(513)])
		expect(() => f.controller.listAgentTurns(caller, { target: "a", cursor: malformed })).toThrow(CollaborationError);
	expect(() => f.controller.listAgentTurns({ ...caller, rootSessionId: "foreign" }, { target: "a" })).toThrow(
		/another root/,
	);
});

test("result selectors reject wrong target/task/passive IDs, child/foreign callers and revoked live queries", async () => {
	const f = fixture();
	const a = await f.controller.spawnTurn(caller, "a", "a", model);
	f.finishes.get("/root/a")?.({ status: "completed", text: "a" });
	await f.controller.settled();
	await f.controller.spawn(caller, "b", "b", model);
	const result = f.controller.pending(caller)[0].id;
	const passive = await f.controller.send(caller, "a", "mail");
	for (const selector of [
		{ target: "b", turn_id: a.turn_id },
		{ target: "b", message_id: result },
		{ target: "a", message_id: a.message_id },
		{ target: "a", message_id: passive },
		{ target: "a", turn_id: "missing" },
	])
		expect(() => f.controller.getAgentResult(caller, selector)).toThrow(
			expect.objectContaining({ reason: "unknown_turn" }),
		);
	for (const input of [{}, { target: "a", turn_id: a.turn_id, message_id: result }, { target: "a", message_id: " " }])
		expect(() => f.controller.getAgentResult(caller, input)).toThrow(CollaborationError);
	const child = { ...caller, agentPath: "/root/a" };
	expect(() => f.controller.getAgentResult(child, { target: "a" })).toThrow(
		expect.objectContaining({ reason: "nested_delegation" }),
	);
	expect(() => f.controller.listAgentTurns(child, { target: "a" })).toThrow(
		expect.objectContaining({ reason: "nested_delegation" }),
	);
	expect(() => f.controller.getAgentResult({ ...caller, rootSessionId: "foreign" }, { target: "a" })).toThrow(
		/another root/,
	);
	const detach = f.controller.bindTools(caller, () => ["read"]);
	expect(() => f.controller.getAgentResult(caller, { target: "a" })).toThrow(
		expect.objectContaining({ code: "forbidden" }),
	);
	expect(() => f.controller.listAgentTurns(caller, { target: "a" })).toThrow(
		expect.objectContaining({ code: "forbidden" }),
	);
	detach();
});

test("escaped raw result fits complete response budget; failed startup is no_result", async () => {
	const f = fixture();
	const receipt = await f.controller.spawnTurn(caller, "a", "a", model);
	const output = "\u0001".repeat(COLLABORATION_LIMITS.maxResultBytes);
	f.finishes.get("/root/a")?.({ status: "completed", text: output });
	await f.controller.settled();
	const result = f.controller.getAgentResult(caller, { target: "a", turn_id: receipt.turn_id });
	expect(result).toMatchObject({ state: "found", result: { preview: output, truncated: false } });
	expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
		COLLABORATION_HISTORY_LIMITS.maxResultResponseBytes,
	);
	expect(await f.controller.waitForTurn(caller, { target: "a", turn_id: receipt.turn_id })).toMatchObject({
		reason: "terminal",
		result: { state: "found", result: { preview: output, truncated: false } },
	});
	f.host.create = async () => {
		throw new Error("startup failed");
	};
	await expect(f.controller.spawn(caller, "bad", "bad", model)).rejects.toThrow(/startup failed/);
	expect(f.controller.getAgentResult(caller, { target: "bad" })).toMatchObject({
		state: "no_result",
		turn: { status: "failed", result_message_id: null },
	});
});

test("partial legacy history distinguishes unretained IDs from known mismatched selectors", async () => {
	const f = fixture(true);
	const receipt = await f.controller.spawnTurn(caller, "a", "a", model);
	f.finishes.get("/root/a")?.({ status: "completed", text: "retained" });
	await f.controller.settled();
	const message = f.controller.pending(caller)[0].id;
	await f.controller.spawn(caller, "b", "b", model);
	f.finishes.get("/root/b")?.({ status: "completed", text: "b" });
	await f.controller.settled();
	const legacy = f.store.read();
	legacy.agents[1].status = "closed";
	legacy.agents[1].result = undefined;
	legacy.messages = legacy.messages?.filter((message) => message.from !== "/root/b");
	await f.controller.shutdown();
	const database = new DatabaseSync(join(f.cwd, "registry.sqlite"));
	database.exec("DROP TABLE turns; DROP TABLE history");
	database.prepare("UPDATE team SET snapshot=?").run(JSON.stringify(legacy));
	database.close();
	const store = new CollaborationStore({ path: join(f.cwd, "registry.sqlite"), cwd: f.cwd, rootSessionId: "team" });
	const controller = new CollaborationController({
		store,
		host: f.host,
		agentDir: f.cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
	});
	cleanups.push(() => controller.shutdown());
	expect(controller.getAgentResult(caller, { target: "a", turn_id: "unretained" })).toEqual({
		state: "history_unavailable",
		target: "/root/a",
		history_coverage: "retained_only",
	});
	for (const selector of [
		{ target: "b", turn_id: receipt.turn_id },
		{ target: "b", message_id: message },
		{ target: "a", message_id: receipt.message_id },
		{ target: "a", turn_id: receipt.message_id },
		{ target: "a", message_id: receipt.turn_id },
		{ target: "a", turn_id: message },
	])
		expect(() => controller.getAgentResult(caller, selector)).toThrow(
			expect.objectContaining({ reason: "unknown_turn" }),
		);
	expect(controller.getAgentResult(caller, { target: "a" })).toMatchObject({
		state: "found",
		result: { preview: "retained", truncated: null },
	});
	expect(controller.getAgentResult(caller, { target: "b" })).toEqual({
		state: "history_unavailable",
		target: "/root/b",
		history_coverage: "retained_only",
	});
	expect(f.loads).toHaveLength(2);
	expect(f.runs).toHaveLength(2);
});
