import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CollaborationController } from "../src/collaboration-controller.ts";
import { CollaborationStore } from "../src/collaboration-store.ts";
import type { ChildSessionHost, ChildTurnResult } from "../src/session-host.ts";

const caller = { rootSessionId: "team", agentPath: "/root" };
const model = { provider: "faux", id: "one", thinkingLevel: "off" as const };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.useRealTimers();
});
function fixture(failCreate = false, holdAbort = false) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "epi-targeted-wait-")));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const store = new CollaborationStore({ path: ":memory:", cwd, rootSessionId: caller.rootSessionId });
	const finishes = new Map<string, (result: ChildTurnResult) => void>();
	let runs = 0;
	let loads = 0;
	const host: ChildSessionHost = {
		async create(options) {
			loads++;
			if (failCreate) throw new Error("synthetic startup failure");
			return {
				identity: { rootSessionId: options.rootSessionId, agentPath: options.agentPath },
				sessionId: randomUUID(),
				sessionFile: undefined,
				context: () => [],
				forkContext: () => [],
				run: () => {
					runs++;
					return new Promise<ChildTurnResult>((resolve) => finishes.set(options.agentPath, resolve));
				},
				abort: async () => {
					if (!holdAbort) finishes.get(options.agentPath)?.({ status: "interrupted", text: "partial" });
				},
				dispose: async () => {},
			};
		},
	};
	const controller = new CollaborationController({
		store,
		host,
		agentDir: cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
	});
	cleanups.push(async () => {
		for (const finish of finishes.values()) finish({ status: "interrupted", text: "cleanup" });
		await controller.shutdown();
	});
	return { controller, store, finishes, counts: () => ({ runs, loads }) };
}
const completed: ChildTurnResult = { status: "completed", text: "retained answer" };

test("already acknowledged and closed turns return immediately without loading or running", async () => {
	const f = fixture();
	const receipt = await f.controller.spawnTurn(caller, "a", "first", model);
	f.finishes.get(receipt.task_name)!(completed);
	await f.controller.settled();
	await f.controller.acknowledge(
		caller,
		f.controller.pending(caller).map((m) => m.id),
	);
	await f.controller.close(caller, "a");
	const before = f.counts();
	const waited = await f.controller.waitForTurn(caller, { target: "a", turn_id: receipt.turn_id });
	expect(waited).toMatchObject({
		reason: "terminal",
		target: "/root/a",
		turn_id: receipt.turn_id,
		result: {
			state: "found",
			turn: { status: "completed", delivery: { state: "acknowledged" } },
			result: { preview: "retained answer" },
		},
	});
	expect(f.counts()).toEqual(before);
	expect(f.controller.pending(caller)).toEqual([]);
});

test("default selector pins the entry turn even when a followup is admitted before the waiter checks", async () => {
	const f = fixture();
	const first = await f.controller.spawnTurn(caller, "a", "first", model);
	f.finishes.get(first.task_name)!(completed);
	await f.controller.settled();
	const waited = f.controller.waitForTurn(caller, { target: "a" });
	const next = await f.controller.followupTurn(caller, "a", "second");
	expect(next.turn_id).not.toBe(first.turn_id);
	expect(await waited).toMatchObject({ reason: "terminal", turn_id: first.turn_id });
	expect(f.store.getTurn("/root/a", { turn_id: next.turn_id })?.status).toBe("running");
});

test("completion in the registration window is observed and unrelated changes do not resolve the wait", async () => {
	const f = fixture();
	const first = await f.controller.spawnTurn(caller, "a", "first", model);
	const waited = f.controller.waitForTurn(caller, { target: "a" });
	let resolved = false;
	void waited.then(() => {
		resolved = true;
	});
	await f.controller.send(caller, "a", "unrelated passive message");
	await Promise.resolve();
	expect(resolved).toBe(false);
	f.finishes.get(first.task_name)!(completed);
	await f.controller.settled();
	expect(await waited).toMatchObject({ reason: "terminal", turn_id: first.turn_id });
	expect(f.controller.pending(caller)).toHaveLength(1);
});

test("simultaneous user input wins terminal state without consuming mail", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "first", model);
	f.finishes.get("/root/a")!(completed);
	await f.controller.settled();
	f.controller.notifyUserInput(caller);
	expect(await f.controller.waitForTurn(caller, { target: "a" })).toMatchObject({
		reason: "user_input",
		timed_out: false,
	});
	f.controller.consumeUserInput(caller);
	expect(await f.controller.waitForTurn(caller, { target: "a" })).toMatchObject({ reason: "terminal" });
});

test("startup failure is terminal without a completion notification", async () => {
	const f = fixture(true);
	await expect(f.controller.spawn(caller, "a", "first", model)).rejects.toThrow("synthetic startup failure");
	expect(await f.controller.waitForTurn(caller, { target: "a" })).toMatchObject({
		reason: "terminal",
		result: { state: "no_result", turn: { status: "failed" } },
	});
	expect(f.controller.pending(caller)).toEqual([]);
	expect(f.counts().runs).toBe(0);
});

test("interrupt request is not turn settlement; cancelled wait leaves the child running", async () => {
	const f = fixture(false, true);
	await f.controller.spawn(caller, "a", "first", model);
	const signal = new AbortController();
	const waited = f.controller.waitForTurn(caller, { target: "a" }, signal.signal);
	const cancelled = expect(waited).rejects.toMatchObject({ code: "interrupted" });
	signal.abort();
	await cancelled;
	expect(f.store.getTurn("/root/a", { turn_id: f.controller.inspect(caller, "a").turnId })?.status).toBe("running");
	const nextWait = f.controller.waitForTurn(caller, { target: "a" });
	let resolved = false;
	void nextWait.then(() => {
		resolved = true;
	});
	await f.controller.interrupt(caller, "a");
	await Promise.resolve();
	expect(resolved).toBe(false);
	f.finishes.get("/root/a")!({ status: "interrupted", text: "finally settled" });
	await f.controller.settled();
	expect(await nextWait).toMatchObject({ reason: "terminal", result: { turn: { status: "interrupted" } } });
});

test("timeout releases subscriptions, never cancels the child, and enforces one waiter", async () => {
	vi.useFakeTimers();
	const f = fixture();
	await f.controller.spawn(caller, "a", "first", model);
	const observers = Reflect.get(f.controller, "observers") as Set<() => void>;
	const before = observers.size;
	const waited = f.controller.waitForTurn(caller, { target: "a", timeout_ms: 0 });
	await expect(f.controller.waitForTurn(caller, { target: "a" })).rejects.toMatchObject({ code: "busy" });
	await vi.advanceTimersByTimeAsync(10_000);
	expect(await waited).toMatchObject({ reason: "timeout", timed_out: true });
	expect(observers.size).toBe(before);
	expect(vi.getTimerCount()).toBe(0);
	expect(f.controller.inspect(caller, "a").status).toBe("running");
});

test("targeted wait uses its own live tool permission, not the result-query permission", async () => {
	const f = fixture();
	const unbind = f.controller.bindTools(caller, () => ["wait_agent"]);
	cleanups.push(unbind);
	await f.controller.spawn(caller, "a", "first", model);
	f.finishes.get("/root/a")!(completed);
	await f.controller.settled();
	expect(() => f.controller.getAgentResult(caller, { target: "a" })).toThrow(
		expect.objectContaining({ code: "forbidden" }),
	);
	expect(await f.controller.waitForTurn(caller, { target: "a" })).toMatchObject({ reason: "terminal" });
	expect(() => f.controller.waitForTurn({ ...caller, agentPath: "/root/a" }, { target: "a" })).toThrow(
		expect.objectContaining({ code: "forbidden" }),
	);
});

test("cold recovery turns are immediately waitable without loading or replay", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "epi-target-recovery-")));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const path = join(cwd, "registry.sqlite");
	const original = new CollaborationStore({ path, cwd, rootSessionId: "team" });
	const turnId = randomUUID();
	const snapshot = original.read();
	snapshot.agents.push({
		id: randomUUID(),
		path: "/root/a",
		parent: "/root",
		model,
		status: "running",
		completionPending: true,
		turnId,
		taskMessage: {
			id: randomUUID(),
			rootSessionId: "team",
			from: "/root",
			to: "/root/a",
			turnId,
			kind: "task",
			text: "interrupted work",
		},
	});
	original.commit(snapshot);
	original.close();
	const store = new CollaborationStore({ path, cwd, rootSessionId: "team" });
	const create = vi.fn<ChildSessionHost["create"]>().mockRejectedValue(new Error("must not load"));
	const controller = new CollaborationController({
		store,
		host: { create },
		agentDir: cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
	});
	cleanups.push(() => controller.shutdown());
	expect(await controller.waitForTurn(caller, { target: "a", turn_id: turnId })).toMatchObject({
		reason: "terminal",
		result: { turn: { status: "interrupted" } },
	});
	expect(create).not.toHaveBeenCalled();
	expect(controller.list(caller)[0].loaded).toBe(false);
});

test("revocation during a pending wait rejects instead of exposing a result", async () => {
	const f = fixture();
	let tools = ["wait_agent"];
	const unbind = f.controller.bindTools(caller, () => tools);
	cleanups.push(unbind);
	await f.controller.spawn(caller, "a", "first", model);
	const waited = f.controller.waitForTurn(caller, { target: "a" });
	const denied = expect(waited).rejects.toMatchObject({ code: "forbidden" });
	tools = [];
	f.finishes.get("/root/a")!(completed);
	await f.controller.settled();
	await denied;
});

test("shutdown releases a targeted waiter without inventing timeout", async () => {
	const f = fixture();
	await f.controller.spawn(caller, "a", "first", model);
	const waited = f.controller.waitForTurn(caller, { target: "a" });
	const interrupted = expect(waited).rejects.toMatchObject({ code: "interrupted" });
	await f.controller.shutdown();
	await interrupted;
});
