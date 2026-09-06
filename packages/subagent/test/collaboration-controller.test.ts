import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { CollaborationController } from "../src/collaboration-controller.ts";
import { CollaborationStore } from "../src/collaboration-store.ts";
import type { ChildSessionHost, ChildSessionIdentity, ChildTurnResult } from "../src/session-host.ts";

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
	const outcomes = await Promise.allSettled(
		["a", "a", "b", "c", "d"].map((name) => f.controller.spawn(caller, name, name, model)),
	);
	expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(3);
	expect(f.runs.sort()).toEqual(["a", "b", "c"]);
	expect(f.controller.list(caller)).toHaveLength(3);
	await f.controller.interrupt(caller, "a");
	await f.controller.shutdown();
	expect(f.disposed).toHaveLength(3);
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

test("nested calls share capacity and references cannot cross root identities", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "parent", "parent", model);
	const child = { ...caller, agentPath: "/root/parent" };
	await f.controller.spawn(child, "one", "one", model);
	await f.controller.spawn(child, "two", "two", model);
	await expect(f.controller.spawn(child, "three", "three", model)).rejects.toThrow(/execution limit/);
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
	for (let count = 0; count < 4; count++) {
		await f.controller.spawn(caller, `a${count}`, "task", model);
		f.finishes.get(`/root/a${count}`)?.({ status: "completed", text: "done" });
		await f.controller.settled();
	}
	expect(f.disposed).toEqual(["/root/a0"]);
	expect(f.controller.list(caller).filter((agent) => agent.loaded)).toHaveLength(3);
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
	await expect(f.controller.spawn(caller, "over", "task", model)).rejects.toThrow(/agent limit/);
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
	await expect(f.controller.send(caller, "/root", "overflow")).rejects.toThrow(/full/);
	await expect(f.controller.spawn(caller, "b", "task", model)).rejects.toThrow(/full/);
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
