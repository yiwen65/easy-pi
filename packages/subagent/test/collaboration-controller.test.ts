import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { COLLABORATION_LIMITS } from "../src/collaboration-contract.ts";
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

test("delegated capability ceilings include live ancestors and cannot be widened on followup", async () => {
	const f = fixture();
	let rootTools = ["read", "bash", "spawn_agent"];
	f.controller.bindTools(caller, () => rootTools);
	const admission = { delegation: delegation({ capabilities: { tools: ["read", "spawn_agent"] } }), tools: rootTools };
	await f.controller.spawn(caller, "parent", "inspect", model, [], undefined, admission);
	const parent = { ...caller, agentPath: "/root/parent" };
	expect(f.controller.toolAllowed(parent, "bash")).toBe(false);
	await f.controller.spawn(parent, "leaf", "inspect", model, [], undefined, {
		delegation: delegation(),
		tools: rootTools,
	});
	const leaf = { ...caller, agentPath: "/root/parent/leaf" };
	expect(f.controller.toolAllowed(leaf, "read")).toBe(true);
	expect(f.controller.toolAllowed(leaf, "bash")).toBe(false);
	let parentTools = ["read", "spawn_agent"];
	const unbind = f.controller.bindTools(parent, () => parentTools);
	parentTools = ["spawn_agent"];
	expect(f.controller.toolAllowed(leaf, "read")).toBe(false);
	parentTools = ["read", "spawn_agent"];
	rootTools = ["spawn_agent"];
	expect(f.controller.toolAllowed(leaf, "read")).toBe(false);
	rootTools = ["read", "bash", "spawn_agent"];
	unbind();
	f.finishes.get(parent.agentPath)?.({ status: "completed", text: "done" });
	f.finishes.get(leaf.agentPath)?.({ status: "completed", text: "done" });
	await f.controller.settled();
	await expect(f.controller.followup(caller, "parent", "old plain task")).rejects.toThrow(/explicit task/);
	await f.controller.followup(caller, "parent", "narrow", undefined, {
		delegation: delegation({ capabilities: { tools: ["read"] } }),
		tools: ["read", "bash"],
	});
	expect(f.controller.toolAllowed(parent, "bash")).toBe(false);
	expect(f.controller.toolAllowed(leaf, "spawn_agent")).toBe(false);
});

test("task/result contracts persist and final return targets creation parent rather than later sender", async () => {
	const f = fixture(true);
	const admission = { delegation: delegation(), tools: ["read"] };
	await f.controller.spawn(caller, "a", "initial", model, [], undefined, admission);
	f.finishes.get("/root/a")?.({ status: "completed", text: "unstructured retained answer" });
	await f.controller.settled();
	expect(f.store.read().agents[0].resultValidation).toEqual({ contract: "invalid", acceptance: "not_reviewed" });
	expect(f.controller.pending(caller)[0]).toMatchObject({
		text: "unstructured retained answer",
		resultValidation: { contract: "invalid" },
	});
	await f.controller.spawn(caller, "peer", "peer", model, [], undefined, admission);
	f.finishes.get("/root/peer")?.({ status: "completed", text: "peer done" });
	await f.controller.settled();
	await f.controller.followup({ ...caller, agentPath: "/root/peer" }, "/root/a", "new task", undefined, admission);
	expect(f.store.read().agents[0].taskMessage).toMatchObject({
		from: "/root/peer",
		parent: "/root",
		contextUse: "existing",
		delegation: admission.delegation,
	});
	expect(f.store.read().agents[0].resultValidation).toBeUndefined();
	const answer = JSON.stringify({
		summary: "Verified format only",
		outcome: "partial",
		artifacts: [],
		evidence: [],
		checks: [],
		risks: ["Not independently reviewed"],
	});
	f.finishes.get("/root/a")?.({ status: "completed", text: answer });
	await f.controller.settled();
	expect(f.controller.pending(caller).at(-1)).toMatchObject({
		from: "/root/a",
		to: "/root",
		resultValidation: { contract: "valid", outcome: "partial", acceptance: "not_reviewed" },
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
	for (let index = 0; index < 4; index++) {
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
	expect(f.runs).toHaveLength(4);
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
	const c = f.controller.spawn(caller, "c", "c", model);
	try {
		await expect(f.controller.spawn(caller, "d", "d", model)).rejects.toThrow(/execution limit/);
		expect(f.controller.list(caller).map((agent) => agent.status)).toEqual(["pending", "pending", "pending"]);
		await expect(f.controller.followup(caller, "b", "duplicate")).rejects.toThrow(/follow-up/);
		expect(await f.controller.interrupt(caller, "b")).toBe("pending");
		await expect(f.controller.spawn(caller, "d", "still reserved", model)).rejects.toThrow(/execution limit/);
	} finally {
		release();
		await Promise.all([a, c, rejected]);
	}
	expect(f.loads).toEqual(["/root/a", "/root/c"]);
	expect(f.runs).toEqual(["a", "c"]);
});

test("idle unload may await a control operation without deadlocking admission", async () => {
	const f = fixture(true);
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
	for (let index = 0; index < 4; index++) {
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

test("unloading a narrowed ancestor cannot restore descendant tool authority", async () => {
	const f = fixture(true);
	const admission = { delegation: delegation(), tools: ["read", "bash"] };
	await f.controller.spawn(caller, "parent", "parent", model, [], undefined, admission);
	const parent = { ...caller, agentPath: "/root/parent" };
	await f.controller.spawn(parent, "leaf", "leaf", model, [], undefined, admission);
	const leaf = { ...caller, agentPath: "/root/parent/leaf" };
	let tools = ["read", "bash"];
	const detach = f.controller.bindTools(parent, () => tools);
	tools = ["read"];
	expect(f.controller.toolAllowed(leaf, "bash")).toBe(false);
	detach();
	expect(f.controller.toolAllowed(leaf, "bash")).toBe(false);
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

test("close requires settled leaf descendants and stays idempotent and terminal", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "parent", "parent", model);
	f.finishes.get("/root/parent")?.({ status: "completed", text: "parent done" });
	await f.controller.settled();
	const parent = { ...caller, agentPath: "/root/parent" };
	await f.controller.spawn(parent, "kid", "kid", model);
	await f.controller.spawn(caller, "peer", "peer", model);
	await expect(f.controller.close(parent, ".")).rejects.toThrow(/itself/);
	await expect(f.controller.close(parent, "..")).rejects.toThrow(/Unknown child/);
	await expect(f.controller.close(parent, "/root/peer")).rejects.toThrow(/descendants/);
	await expect(f.controller.close(parent, "kid")).rejects.toThrow(/Interrupt a running child/);
	// A settled parent with an open child is blocked by its subtree, not by its own status.
	await expect(f.controller.close(caller, "parent")).rejects.toThrow(/Close descendants/);
	// `settled()` waits on every active agent, so both running children must be interrupted first.
	await f.controller.interrupt(parent, "kid");
	await f.controller.interrupt(caller, "peer");
	await f.controller.settled();
	expect(await f.controller.close(parent, "kid")).toBe("interrupted");
	await expect(f.controller.send(caller, "parent/kid", "hello")).rejects.toThrow(/Unknown receiving agent/);
	await expect(
		f.controller.followup(caller, "parent/kid", "again", undefined, { delegation: delegation(), tools: ["read"] }),
	).rejects.toThrow(/follow-up/);
	expect(await f.controller.close(caller, "parent")).toBe("completed");
	expect(await f.controller.close(caller, "parent")).toBe("closed");
	await expect(f.controller.spawn(caller, "parent", "task", model)).rejects.toThrow(/already exists/);
	await expect(f.controller.close(caller, "/root/missing")).rejects.toThrow(/Unknown child/);
});
