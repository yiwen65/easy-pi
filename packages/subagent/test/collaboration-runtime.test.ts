import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CollaborationError } from "../src/collaboration-contract.ts";
import { CollaborationController } from "../src/collaboration-controller.ts";
import { CollaborationStore } from "../src/collaboration-store.ts";
import type { ChildSessionCreateOptions, ChildSessionHost, ChildTurnResult } from "../src/session-host.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(file = false) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "epi-runtime-query-")));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const caller = { rootSessionId: "runtime-query", agentPath: "/root" };
	const model = { provider: "faux", id: "faux", thinkingLevel: "off" as const };
	const path = file ? join(cwd, "registry.sqlite") : ":memory:";
	const store = new CollaborationStore({ path, cwd, rootSessionId: caller.rootSessionId });
	const options = new Map<string, ChildSessionCreateOptions>();
	const finishes = new Map<string, (result: ChildTurnResult) => void>();
	let runError: unknown;
	const host: ChildSessionHost = {
		async create(request) {
			options.set(request.agentPath, request);
			return {
				identity: { rootSessionId: request.rootSessionId, agentPath: request.agentPath },
				sessionId: request.agentPath,
				sessionFile: undefined,
				context: () => [],
				forkContext: () => [],
				run() {
					if (runError) throw runError;
					return new Promise((resolve) => finishes.set(request.agentPath, resolve));
				},
				async abort() {
					finishes.get(request.agentPath)?.({ status: "interrupted", text: "" });
				},
				async dispose() {},
			};
		},
	};
	const controller = new CollaborationController({
		store,
		host,
		agentDir: cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
	});
	cleanups.push(() => controller.shutdown());
	return {
		cwd,
		path,
		caller,
		model,
		controller,
		store,
		options,
		finishes,
		host,
		setError: (error: unknown) => {
			runError = error;
		},
	};
}

test.each([true, false])("execution rejection retains only safe classification (known=%s)", async (known) => {
	const f = fixture();
	const secret = "SECRET /private/provider/endpoint";
	f.setError(known ? new CollaborationError("forbidden", secret, "tools_unavailable") : new Error(secret));
	await f.controller.spawn(f.caller, "worker", "task", f.model);
	await f.controller.settled();
	const result = f.controller.getAgentResult(f.caller, { target: "worker" });
	expect(result).toMatchObject({ state: "found", turn: { status: "failed" } });
	if (result.state !== "found") throw new Error("Expected retained failure");
	expect(result.result.preview).toContain(known ? "forbidden / tools_unavailable" : "execution_error");
	expect(JSON.stringify(result)).not.toContain(secret);
});

test("tool activity is visible on wait expiry without progress, disk writes or mailbox wakeups", async () => {
	const f = fixture();
	const receipt = await f.controller.spawnTurn(f.caller, "worker", "task", f.model);
	const report = f.options.get("/root/worker")!.reportActivity!;
	expect(report).toBeTypeOf("function");
	const commit = vi.spyOn(f.store, "commit");
	const observer = vi.fn();
	const unsubscribe = f.controller.subscribe(observer);
	const before = f.controller.pending(f.caller);
	for (let index = 0; index < 100; index++) report(receipt.turn_id, { phase: "tool", tool_name: "read" });
	expect(commit).not.toHaveBeenCalled();
	expect(observer).not.toHaveBeenCalled();
	expect(f.controller.pending(f.caller)).toEqual(before);
	const query = f.controller.getAgentResult(f.caller, { target: "worker" });
	expect(query).toMatchObject({
		state: "pending",
		turn: { status: "running" },
		runtime: { activity: { phase: "tool", tool_name: "read" } },
	});
	expect(query).not.toHaveProperty("turn.progress");
	if (query.state !== "history_unavailable" && query.runtime?.activity) query.runtime.activity.phase = "settled";
	expect(f.controller.list(f.caller)[0].runtime?.activity?.phase).toBe("tool");
	vi.useFakeTimers();
	const waited = f.controller.waitForTurn(f.caller, { target: "worker", timeout_ms: 0 });
	await vi.advanceTimersByTimeAsync(10_000);
	expect(await waited).toMatchObject({
		reason: "timeout",
		timed_out: true,
		result: { turn: { status: "running" }, runtime: { activity: { phase: "tool", tool_name: "read" } } },
	});
	expect(f.controller.list(f.caller)[0].status).toBe("running");
	unsubscribe();
});

test("followup and historical selectors never receive another turn's activity", async () => {
	const f = fixture();
	const first = await f.controller.spawnTurn(f.caller, "worker", "first", f.model);
	const report = f.options.get("/root/worker")!.reportActivity!;
	report(first.turn_id, { phase: "tool", tool_name: "read" });
	f.finishes.get("/root/worker")!({ status: "completed", text: "first done" });
	await f.controller.settled();
	const previous = f.controller.getAgentResult(f.caller, { target: "worker", turn_id: first.turn_id });
	expect(previous).toMatchObject({ runtime: { activity: { phase: "settled" } } });
	const next = await f.controller.followupTurn(f.caller, "worker", "second");
	report(first.turn_id, { phase: "tool", tool_name: "STALE" });
	report(next.turn_id, { phase: "tool", tool_name: "read" });
	const old = f.controller.getAgentResult(f.caller, { target: "worker", turn_id: first.turn_id });
	expect(old).not.toHaveProperty("runtime.activity");
	expect(f.controller.getAgentResult(f.caller, { target: "worker" })).toMatchObject({
		runtime: { activity: { tool_name: "read" } },
	});
	f.finishes.get("/root/worker")!({ status: "completed", text: "second done" });
	await f.controller.settled();
	await f.controller.close(f.caller, "worker");
	expect(f.controller.getAgentResult(f.caller, { target: "worker" })).not.toHaveProperty("runtime.activity");
});

test("cold controller recovery retains elapsed time but does not invent live activity", async () => {
	const f = fixture(true);
	const first = await f.controller.spawnTurn(f.caller, "worker", "task", f.model);
	f.options.get("/root/worker")!.reportActivity!(first.turn_id, { phase: "tool", tool_name: "read" });
	f.finishes.get("/root/worker")!({ status: "completed", text: "done" });
	await f.controller.settled();
	const before = f.controller.getAgentResult(f.caller, { target: "worker" });
	await f.controller.shutdown();
	const store = new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: f.caller.rootSessionId });
	const reopened = new CollaborationController({
		store,
		host: f.host,
		agentDir: f.cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
	});
	cleanups.push(() => reopened.shutdown());
	const after = reopened.getAgentResult(f.caller, { target: "worker" });
	expect(after).not.toHaveProperty("runtime.activity");
	if (before.state === "found" && after.state === "found")
		expect(after.runtime?.elapsed_ms).toBe(before.runtime?.elapsed_ms);
	else throw new Error("Expected retained results");
	expect(reopened.list(f.caller)[0].loaded).toBe(false);
});
