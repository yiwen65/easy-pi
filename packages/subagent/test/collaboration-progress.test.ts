import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import {
	COLLABORATION_LIMITS,
	COLLABORATION_TEAM_TOOL_NAMES,
	CollaborationAdmissionError,
	CollaborationError,
	parseCollaborationArguments,
	parseReportProgress,
	REPORT_PROGRESS_TOOL_NAME,
	validateCollaborationInterruption,
	validateCollaborationProgress,
} from "../src/collaboration-contract.ts";
import { CollaborationController } from "../src/collaboration-controller.ts";
import { CollaborationStore } from "../src/collaboration-store.ts";
import type { ChildSessionCreateOptions, ChildSessionHost, ChildTurnResult } from "../src/session-host.ts";
import { delegation } from "./delegation-fixture.ts";

const caller = { rootSessionId: "team", agentPath: "/root" };
const model = { provider: "faux", id: "one", thinkingLevel: "off" as const };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.useRealTimers();
});
function fixture(file = false, expectedShutdownError?: "storage_error") {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "epi-progress-")));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const path = file ? join(cwd, "registry.sqlite") : ":memory:";
	const store = new CollaborationStore({ path, cwd, rootSessionId: caller.rootSessionId });
	const finishes = new Map<string, (result: ChildTurnResult) => void>();
	const requests = new Map<string, ChildSessionCreateOptions>();
	const runs: string[] = [];
	const host: ChildSessionHost = {
		async create(options) {
			requests.set(options.agentPath, options);
			return {
				identity: { rootSessionId: options.rootSessionId, agentPath: options.agentPath },
				sessionId: randomUUID(),
				sessionFile: undefined,
				context: () => [],
				forkContext: () => [],
				run: (text) => {
					runs.push(text);
					return new Promise<ChildTurnResult>((resolve) => finishes.set(options.agentPath, resolve));
				},
				abort: async () => finishes.get(options.agentPath)?.({ status: "interrupted", text: "partial" }),
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
		if (expectedShutdownError)
			await expect(controller.shutdown()).rejects.toMatchObject({ code: expectedShutdownError });
		else await controller.shutdown();
	});
	return { cwd, path, store, controller, host, finishes, requests, runs };
}

test.each([false, true])("progress is nonterminal, latest-only and separate from final delivery (%s)", async (file) => {
	const f = fixture(file);
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model, [], undefined, {
		delegation: delegation(),
		tools: [],
	});
	const child = { ...caller, agentPath: receipt.task_name };
	const first = await f.controller.reportProgress(child, receipt.turn_id, "Regression tests passed; reviewing diff");
	expect(first).toMatchObject({
		summary: "Regression tests passed; reviewing diff",
		revision: 1,
		reported_at: expect.any(Number),
	});
	expect(f.controller.inspect(caller, "a")).toMatchObject({
		status: "running",
		completionPending: true,
		progress: first,
	});
	expect(f.controller.inspect(caller, "a").result).toBeUndefined();
	expect(f.controller.inspect(caller, "a").resultValidation).toBeUndefined();
	const notice = f.controller.pending(caller)[0];
	expect(notice).toMatchObject({
		kind: "progress",
		from: child.agentPath,
		to: "/root",
		turnId: receipt.turn_id,
		progress: first,
	});
	const second = await f.requests.get(child.agentPath)!.reportProgress!(
		receipt.turn_id,
		"Diff reviewed; preparing delivery",
	);
	expect(second.revision).toBe(2);
	expect(f.controller.pending(caller)).toHaveLength(1);
	expect(f.controller.pending(caller)[0].id).not.toBe(notice.id);
	await f.controller.acknowledge(caller, [notice.id]);
	expect(f.controller.pending(caller)).toHaveLength(1);
	expect(f.store.countTurns()).toBe(1);
	expect(f.controller.getAgentResult(caller, { target: "a" })).toMatchObject({
		state: "pending",
		turn: { progress: second, result_message_id: null },
	});
	f.finishes.get(child.agentPath)!({
		status: "completed",
		text: JSON.stringify({ summary: "Done", outcome: "succeeded" }),
	});
	await f.controller.settled();
	expect(f.controller.pending(caller).at(-1)).toMatchObject({
		kind: "result",
		status: "completed",
		progress: second,
		resultValidation: { contract: "valid", outcome: "succeeded" },
	});
	expect(f.controller.getAgentResult(caller, { target: "a" })).toMatchObject({
		state: "found",
		turn: { status: "completed", progress: second },
	});
	expect(f.runs).toEqual(["task"]);
});

test.each([false, true])("followup clears latest handoff while closed/cold history retains it (%s)", async (file) => {
	const f = fixture(file);
	const first = await f.controller.spawnTurn(caller, "a", "first", model);
	const progress = await f.controller.reportProgress(
		{ ...caller, agentPath: "/root/a" },
		first.turn_id,
		"Tests passed; not yet delivered",
	);
	const interrupted = await f.controller.interruptWithHandoff(caller, "a", "Coordinator requested a bounded handoff");
	await f.controller.settled();
	expect(interrupted).toMatchObject({
		previous_status: "running",
		turn_id: first.turn_id,
		progress,
		interruption: {
			reason: "Coordinator requested a bounded handoff",
			requested_by: "/root",
			requested_at: expect.any(Number),
		},
	});
	expect(f.controller.pending(caller).at(-1)).toMatchObject({
		kind: "result",
		status: "interrupted",
		progress,
		interruption: interrupted.interruption,
	});
	await f.controller.acknowledge(
		caller,
		f.controller.pending(caller).map((message) => message.id),
	);
	const second = await f.controller.followupTurn(caller, "a", "second");
	expect(f.controller.inspect(caller, "a").progress).toBeUndefined();
	expect(f.controller.inspect(caller, "a").interruption).toBeUndefined();
	expect(f.controller.getAgentResult(caller, { target: "a", turn_id: first.turn_id })).toMatchObject({
		turn: { progress, interruption: interrupted.interruption, status: "interrupted" },
	});
	const nextProgress = await f.controller.reportProgress(
		{ ...caller, agentPath: "/root/a" },
		second.turn_id,
		"Second turn started",
	);
	expect(nextProgress.revision).toBe(1);
	f.finishes.get("/root/a")!({ status: "completed", text: "second result" });
	await f.controller.settled();
	await f.controller.close(caller, "a");
	expect(f.controller.list(caller)[0]).toMatchObject({ status: "closed", progress: nextProgress });
	const page = f.controller.listAgentTurns(caller, { target: "a" });
	expect(page.turns).toHaveLength(2);
	expect(page.turns[0]).toMatchObject({ progress, interruption: interrupted.interruption });
	expect(page.turns[1].interruption).toBeUndefined();
	if (file) {
		await f.controller.shutdown();
		const reopened = new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" });
		cleanups.push(() => reopened.close());
		expect(reopened.pageTurns("/root/a")).toEqual(page.turns);
		expect(reopened.read().agents[0]).toMatchObject({ status: "closed", progress: nextProgress });
		expect(f.runs).toEqual(["first", "second"]);
	}
});

test("progress gates root, foreign identity, wrong child/turn and all terminal states without mutating state", async () => {
	const f = fixture();
	const a = await f.controller.spawnTurn(caller, "a", "task", model);
	const b = await f.controller.spawnTurn(caller, "b", "task", model);
	const before = f.store.read();
	for (const [identity, turn] of [
		[caller, a.turn_id],
		[{ ...caller, rootSessionId: "foreign", agentPath: "/root/a" }, a.turn_id],
		[{ ...caller, agentPath: "/root/missing" }, a.turn_id],
		[{ ...caller, agentPath: "/root/a" }, b.turn_id],
		[{ ...caller, agentPath: "/root/b" }, a.turn_id],
		[{ ...caller, agentPath: "/root/a" }, "stale-turn"],
	] as const)
		await expect(f.controller.reportProgress(identity, turn, "Not authorized")).rejects.toMatchObject({
			code: expect.stringMatching(/forbidden|unknown_agent|busy/),
		});
	expect(f.store.read()).toEqual(before);
	f.finishes.get("/root/a")!({ status: "completed", text: "done" });
	f.finishes.get("/root/b")!({ status: "failed", text: "failure" });
	await f.controller.settled();
	for (const receipt of [a, b])
		await expect(
			f.controller.reportProgress({ ...caller, agentPath: receipt.task_name }, receipt.turn_id, "Too late"),
		).rejects.toMatchObject({ code: "busy" });
	await f.controller.followup(caller, "a", "next");
	await expect(
		f.controller.reportProgress({ ...caller, agentPath: "/root/a" }, a.turn_id, "Stale"),
	).rejects.toMatchObject({ code: "busy" });
	await f.controller.interruptWithHandoff(caller, "a");
	await f.controller.settled();
	const current = f.controller.inspect(caller, "a");
	await expect(
		f.controller.reportProgress({ ...caller, agentPath: "/root/a" }, current.turnId, "After interrupt"),
	).rejects.toMatchObject({ code: "busy" });
	await f.controller.close(caller, "a");
	await expect(
		f.controller.reportProgress({ ...caller, agentPath: "/root/a" }, current.turnId, "After close"),
	).rejects.toMatchObject({ code: "unknown_agent" });
});

test("progress is structural, not delegated authority; concurrent reports are serialized and acknowledgement stays passive", async () => {
	const f = fixture();
	const tools = ["read"];
	f.controller.bindTools(caller, () => [...tools, "get_agent_result"]);
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model, [], undefined, {
		delegation: delegation(),
		tools,
	});
	const child = { ...caller, agentPath: "/root/a" };
	expect(REPORT_PROGRESS_TOOL_NAME).toBe("report_progress");
	expect(COLLABORATION_TEAM_TOOL_NAMES.has(REPORT_PROGRESS_TOOL_NAME)).toBe(false);
	expect(f.controller.toolAllowed(child, REPORT_PROGRESS_TOOL_NAME)).toBe(false);
	const reports = await Promise.all(
		Array.from({ length: 20 }, (_, index) =>
			f.requests.get("/root/a")!.reportProgress!(receipt.turn_id, `Progress ${index}`),
		),
	);
	expect(reports.map((report) => report.revision)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
	expect(f.controller.pending(caller)).toHaveLength(1);
	const latest = reports.at(-1)!;
	latest.summary = "Caller mutated receipt";
	expect(f.controller.inspect(caller, "a").progress?.summary).toBe("Progress 19");
	await f.controller.acknowledge(
		caller,
		f.controller.pending(caller).map((message) => message.id),
	);
	expect(f.controller.getAgentResult(caller, { target: "a" })).toMatchObject({
		state: "pending",
		turn: { delivery: { state: "not_enqueued", acknowledged_at: null }, progress: { revision: 20 } },
	});
	expect(f.controller.toolAllowed(child, "read")).toBe(true);
	expect(f.controller.toolAllowed(child, "bash")).toBe(false);
	expect(f.runs).toEqual(["task"]);
});

test("full mailbox rejects new progress before persistence but coalescing preserves the completion reservation", async () => {
	const f = fixture();
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
	const child = { ...caller, agentPath: "/root/a" };
	for (let index = 0; index < 63; index++) await f.controller.send(caller, "/root", `Message ${index}`);
	const before = f.store.read();
	await expect(f.controller.reportProgress(child, receipt.turn_id, "No capacity")).rejects.toMatchObject({
		code: "limit_reached",
		reason: "mailbox_full",
	});
	expect(f.store.read()).toEqual(before);
	await f.controller.acknowledge(caller, [f.controller.pending(caller)[0].id]);
	await f.controller.reportProgress(child, receipt.turn_id, "Initial report");
	for (let index = 0; index < 80; index++)
		await f.controller.reportProgress(child, receipt.turn_id, `Latest ${index}`);
	expect(f.controller.pending(caller)).toHaveLength(63);
	expect(f.controller.pending(caller).filter((message) => message.kind === "progress")).toHaveLength(1);
	expect(f.controller.inspect(caller, "a")).toMatchObject({ completionPending: true, progress: { revision: 81 } });
	await expect(f.controller.send(caller, "/root", "Overflow")).rejects.toMatchObject({ reason: "mailbox_full" });
	f.finishes.get("/root/a")!({ status: "completed", text: "Final result survives" });
	await f.controller.settled();
	expect(f.controller.pending(caller)).toHaveLength(COLLABORATION_LIMITS.maxPendingMessages);
	expect(f.controller.pending(caller).at(-1)).toMatchObject({
		kind: "result",
		text: "Final result survives",
		progress: { revision: 81 },
	});
});

test("progress and reason parsers reject malformed text, controls, unknown fields and UTF-8/JSON overflow", () => {
	expect(parseReportProgress({ summary: "界🙂 verified" })).toEqual({ summary: "界🙂 verified" });
	const progress = { summary: "", reported_at: 1, revision: 1 };
	const overhead = Buffer.byteLength(JSON.stringify(progress));
	const budget = COLLABORATION_LIMITS.maxProgressBytes - overhead;
	progress.summary = "界".repeat(Math.floor(budget / 3)) + "x".repeat(budget % 3);
	expect(Buffer.byteLength(JSON.stringify(progress))).toBe(2048);
	expect(validateCollaborationProgress(progress)).toEqual(progress);
	const escaped = { ...progress, summary: '"'.repeat(Math.floor(budget / 2)) + "x".repeat(budget % 2) };
	expect(Buffer.byteLength(JSON.stringify(escaped))).toBe(2048);
	expect(validateCollaborationProgress(escaped)).toEqual(escaped);
	for (const summary of [
		"",
		" ",
		"bad\0text",
		"bad\u001btext",
		"bad\u007ftext",
		"bad\u0085text",
		"bad\ud800text",
		"界".repeat(700),
	]) {
		expect(() => parseReportProgress({ summary })).toThrow(expect.objectContaining({ code: "invalid_arguments" }));
		expect(() => parseCollaborationArguments("interrupt_agent", { target: "a", reason: summary })).toThrow(
			expect.objectContaining({ code: "invalid_arguments" }),
		);
	}
	for (const value of [
		{},
		{ summary: 1 },
		{ summary: "Done", outcome: "succeeded" },
		{ summary: "Done", turn_id: "injected" },
	])
		expect(() => parseReportProgress(value)).toThrow(expect.objectContaining({ code: "invalid_arguments" }));
	for (const value of [
		{ ...progress, summary: `${progress.summary}x` },
		{ ...escaped, summary: `${escaped.summary}x` },
		{ ...progress, revision: 0 },
		{ ...progress, revision: Number.MAX_SAFE_INTEGER + 1 },
		{ ...progress, reported_at: Number.NaN },
		{ ...progress, unknown: true },
	])
		expect(() => validateCollaborationProgress(value)).toThrow(
			expect.objectContaining({ code: "invalid_arguments" }),
		);
	const reason = `${"界".repeat(341)}x`;
	expect(Buffer.byteLength(reason)).toBe(1024);
	expect(parseCollaborationArguments("interrupt_agent", { target: "a", reason })).toEqual({ target: "a", reason });
	expect(() => parseCollaborationArguments("interrupt_agent", { target: "a", reason: `${reason}x` })).toThrow(
		expect.objectContaining({ code: "invalid_arguments" }),
	);
	expect(() =>
		validateCollaborationInterruption({ reason: "Stop", requested_at: 1, requested_by: "/elsewhere" }),
	).toThrow(expect.objectContaining({ code: "invalid_arguments" }));
});

test("invalid progress and interruption budgets do not poison a running controller", async () => {
	const f = fixture();
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
	const child = { ...caller, agentPath: "/root/a" };
	const before = f.store.read();
	for (const summary of [" ", "界".repeat(700), "bad\0text", "bad\ud800text"])
		await expect(f.controller.reportProgress(child, receipt.turn_id, summary)).rejects.toMatchObject({
			code: "invalid_arguments",
		});
	await expect(f.controller.interruptWithHandoff(caller, "a", "界".repeat(342))).rejects.toMatchObject({
		code: "invalid_arguments",
	});
	expect(f.store.read()).toEqual(before);
	await expect(f.controller.reportProgress(child, receipt.turn_id, "Still running")).resolves.toMatchObject({
		revision: 1,
	});
	expect(await f.controller.interrupt(caller, "a")).toBe("running");
	await f.controller.settled();
	expect(f.controller.inspect(caller, "a").interruption?.reason).toBe("Explicit coordinator request.");
	expect(f.controller.inspect(caller, "a").interruption?.reason).not.toMatch(/timeout/i);
});

test.each([false, true])(
	"progress and interruption snapshot, ledger and notification roll back atomically (%s)",
	async (file) => {
		const f = fixture(file);
		const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
		const before = f.store.read();
		const beforeTurn = f.store.getTurn("/root/a", { turn_id: receipt.turn_id });
		const next = structuredClone(before);
		const progress = { summary: "Transactional progress", reported_at: Date.now(), revision: 1 };
		next.agents[0].progress = progress;
		next.agents[0].interruption = { reason: "Operator handoff", requested_at: Date.now(), requested_by: "/root" };
		next.agents[0].status = "interrupted";
		next.messages = [
			{
				id: randomUUID(),
				rootSessionId: "team",
				from: "/root/a",
				to: "/root",
				turnId: receipt.turn_id,
				kind: "progress",
				text: progress.summary,
				progress,
			},
		];
		const db = Reflect.get(f.store, "database") as DatabaseSync;
		db.exec(
			"CREATE TRIGGER reject_progress BEFORE UPDATE ON team BEGIN SELECT RAISE(ABORT, 'progress disk failure'); END",
		);
		expect(() => f.store.commit(next)).toThrow(/progress disk failure/);
		expect(f.store.read()).toEqual(before);
		expect(f.store.getTurn("/root/a", { turn_id: receipt.turn_id })).toEqual(beforeTurn);
		db.exec("DROP TRIGGER reject_progress");
		f.store.commit(next);
		expect(f.store.getTurn("/root/a", { turn_id: receipt.turn_id })).toMatchObject({
			status: "running",
			finished_at: null,
			progress,
			interruption: next.agents[0].interruption,
			result_message_id: null,
		});
		expect(f.store.read().messages).toEqual(next.messages);
	},
);

test("targeted wait ignores old progress, returns new revisions and timeout carries the pinned handoff without cancellation", async () => {
	vi.useFakeTimers();
	const f = fixture();
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
	const child = { ...caller, agentPath: "/root/a" };
	const first = await f.controller.reportProgress(child, receipt.turn_id, "Already observed");
	const observers = Reflect.get(f.controller, "observers") as Set<() => void>;
	const initialObservers = observers.size;
	const read = vi.spyOn(f.store, "getTurn");
	const waited = f.controller.waitForTurn(caller, { target: "a", timeout_ms: 0 });
	let resolved = false;
	void waited.then(() => {
		resolved = true;
	});
	await f.controller.send(caller, "a", "Unrelated activity");
	await Promise.resolve();
	expect(resolved).toBe(false);
	expect(read.mock.calls.length).toBeLessThanOrEqual(4);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(await waited).toMatchObject({
		reason: "timeout",
		timed_out: true,
		turn_id: receipt.turn_id,
		result: { state: "pending", turn: { status: "running", progress: first } },
	});
	expect(observers.size).toBe(initialObservers);
	expect(vi.getTimerCount()).toBe(0);
	expect(f.controller.inspect(caller, "a").status).toBe("running");
	const nextWait = f.controller.waitForTurn(caller, { target: "a" });
	const second = await f.controller.reportProgress(child, receipt.turn_id, "New evidence");
	expect(await nextWait).toMatchObject({
		reason: "progress",
		timed_out: false,
		target: "/root/a",
		turn_id: receipt.turn_id,
		result: { state: "pending", turn: { progress: second, result_message_id: null } },
	});
	expect(f.controller.pending(caller)).toHaveLength(1);
	f.finishes.get("/root/a")!({ status: "completed", text: "Done" });
	await f.controller.settled();
	expect(await f.controller.waitForTurn(caller, { target: "a" })).toMatchObject({
		reason: "terminal",
		result: { turn: { progress: second, status: "completed" } },
	});
	expect(f.runs).toEqual(["task"]);
});

test("user input wins new progress; untargeted mailbox waits observe progress without new inference", async () => {
	const f = fixture();
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
	const waited = f.controller.waitForTurn(caller, { target: "a" });
	const reported = f.controller.reportProgress(
		{ ...caller, agentPath: "/root/a" },
		receipt.turn_id,
		"Nonterminal evidence",
	);
	f.controller.notifyUserInput(caller);
	await reported;
	expect(await waited).toMatchObject({ reason: "user_input", timed_out: false });
	f.controller.consumeUserInput(caller);
	expect(await f.controller.wait(caller)).toEqual({ reason: "mailbox", timed_out: false });
	expect(f.controller.pending(caller)[0].kind).toBe("progress");
	expect(f.runs).toEqual(["task"]);
});

test("interruption receipt pins its turn before delayed abort admits a followup", async () => {
	const f = fixture();
	const create = f.host.create;
	let once = false;
	f.host.create = async (options) => {
		const session = await create(options);
		const abort = session.abort;
		session.abort = async () => {
			await abort();
			if (once) return;
			once = true;
			await f.controller.settled();
			await f.controller.acknowledge(
				caller,
				f.controller.pending(caller).map((message) => message.id),
			);
			const next = await f.controller.followupTurn(caller, "a", "Followup while abort waits");
			await options.reportProgress!(next.turn_id, "New turn progress");
		};
		return session;
	};
	const first = await f.controller.spawnTurn(caller, "a", "first", model);
	const progress = await f.controller.reportProgress(
		{ ...caller, agentPath: "/root/a" },
		first.turn_id,
		"Prior verified work",
	);
	const receipt = await f.controller.interruptWithHandoff(caller, "a", "Explicit handoff before continuing");
	const latest = f.controller.inspect(caller, "a");
	expect(latest.turnId).not.toBe(first.turn_id);
	expect(latest.progress?.summary).toBe("New turn progress");
	expect(latest.interruption).toBeUndefined();
	expect(receipt).toMatchObject({
		previous_status: "running",
		turn_id: first.turn_id,
		progress,
		interruption: { reason: "Explicit handoff before continuing" },
	});
	expect(f.store.getTurn("/root/a", { turn_id: first.turn_id })).toMatchObject({
		status: "interrupted",
		progress,
		interruption: receipt.interruption,
	});
});

test("pending startup rejects progress and interruption preserves its explicit reason until cleanup settles", async () => {
	const f = fixture();
	const create = f.host.create;
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
		return create(options);
	};
	const spawning = f.controller.spawnTurn(caller, "a", "task", model);
	const rejected = expect(spawning).rejects.toMatchObject({ code: "interrupted" });
	await creating;
	const record = f.controller.inspect(caller, "a");
	try {
		await expect(
			f.controller.reportProgress({ ...caller, agentPath: "/root/a" }, record.turnId, "Too early"),
		).rejects.toMatchObject({ code: "busy" });
		const receipt = await f.controller.interruptWithHandoff(caller, "a", "Coordinator cancelled startup");
		expect(receipt).toMatchObject({
			previous_status: "pending",
			turn_id: record.turnId,
			interruption: { reason: "Coordinator cancelled startup" },
		});
		expect(receipt.progress).toBeUndefined();
		expect(f.store.getTurn("/root/a", { turn_id: record.turnId })).toMatchObject({
			status: "pending",
			finished_at: null,
			interruption: receipt.interruption,
		});
	} finally {
		release();
		await rejected;
	}
	expect(f.store.getTurn("/root/a", { turn_id: record.turnId })).toMatchObject({
		status: "interrupted",
		interruption: { reason: "Coordinator cancelled startup" },
	});
	expect(f.runs).toEqual([]);
});

test.each([false, true])(
	"dead-owner recovery retains progress and honest interruption without replay (%s)",
	(priorRequest) => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "epi-progress-recovery-")));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const path = join(cwd, "registry.sqlite");
		const original = new CollaborationStore({ path, cwd, rootSessionId: "team" });
		const turnId = randomUUID();
		const progress = { summary: "Tests verified before owner exited", reported_at: Date.now(), revision: 3 };
		const interruption = {
			reason: "Prior explicit coordinator request",
			requested_at: Date.now(),
			requested_by: "/root",
		};
		const snapshot = original.read();
		snapshot.agents.push({
			id: randomUUID(),
			path: "/root/a",
			parent: "/root",
			model,
			turnId,
			status: priorRequest ? "interrupted" : "running",
			completionPending: true,
			delegation: delegation(),
			progress,
			...(priorRequest ? { interruption } : {}),
		});
		original.commit(snapshot);
		original.close();
		const retiredPid = Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }).trim());
		const db = new DatabaseSync(path);
		db.prepare("UPDATE team SET owner='dead-controller', pid=?").run(retiredPid);
		db.close();
		expect(() => new CollaborationStore({ path, cwd, rootSessionId: "team" })).toThrow(/Explicit recovery/);
		const recovered = new CollaborationStore({ path, cwd, rootSessionId: "team", recoverInterruptedOwner: true });
		cleanups.push(() => recovered.close());
		const record = recovered.read().agents[0];
		expect(record).toMatchObject({
			status: "interrupted",
			progress,
			resultValidation: { contract: "not_completed" },
		});
		if (priorRequest) expect(record.interruption).toEqual(interruption);
		else expect(record.interruption?.reason).toContain("owner is no longer alive");
		expect(record.interruption?.reason).not.toMatch(/timeout/i);
		expect(recovered.getTurn("/root/a", { turn_id: turnId })).toMatchObject({
			status: "interrupted",
			progress,
			interruption: record.interruption,
			resultValidation: { contract: "not_completed" },
		});
		expect(recovered.read().messages).toMatchObject([
			{ kind: "result", status: "interrupted", progress, interruption: record.interruption },
		]);
		expect(recovered.countTurns()).toBe(1);
	},
);

test("lost live ownership rejects progress without writing or using a stale grant", async () => {
	const f = fixture(true);
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
	const db = new DatabaseSync(f.path);
	const owner = db.prepare("SELECT owner FROM team").get()!.owner;
	try {
		db.prepare("UPDATE team SET owner='different-controller'").run();
		await expect(f.requests.get("/root/a")!.reportProgress!(receipt.turn_id, "Stale owner")).rejects.toMatchObject({
			code: "forbidden",
		});
	} finally {
		db.prepare("UPDATE team SET owner=?").run(owner);
		db.close();
	}
	expect(f.controller.inspect(caller, "a").progress).toBeUndefined();
	await expect(
		f.controller.reportProgress({ ...caller, agentPath: "/root/a" }, receipt.turn_id, "Owner restored"),
	).resolves.toMatchObject({ revision: 1 });
});

test("store rejects corrupt handoff metadata and progress notification identities; turn metadata remains bounded", async () => {
	const f = fixture();
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
	await f.controller.reportProgress({ ...caller, agentPath: "/root/a" }, receipt.turn_id, "Valid progress");
	const before = f.store.read();
	for (const mutate of [
		(snapshot: typeof before) => {
			snapshot.agents[0].progress!.summary = "bad\0text";
		},
		(snapshot: typeof before) => {
			snapshot.agents[0].progress!.summary = "界".repeat(700);
		},
		(snapshot: typeof before) => {
			snapshot.messages![0].id = "x".repeat(129);
		},
		(snapshot: typeof before) => {
			snapshot.messages![0].from = "/root";
		},
		(snapshot: typeof before) => {
			snapshot.messages![0].to = "/root/a";
		},
		(snapshot: typeof before) => {
			snapshot.messages![0].text = "Different report";
		},
		(snapshot: typeof before) => {
			snapshot.messages![0].status = "completed";
		},
	]) {
		const invalid = structuredClone(before);
		mutate(invalid);
		expect(() => f.store.commit(invalid)).toThrow(expect.objectContaining({ code: "storage_error" }));
		expect(f.store.read()).toEqual(before);
	}
	const turn = f.store.getTurn("/root/a", { turn_id: receipt.turn_id })!;
	const db = Reflect.get(f.store, "database") as DatabaseSync;
	const oversized = {
		...turn,
		result: {
			preview: "",
			truncated: false,
			source: { kind: "unavailable", turn_id: receipt.turn_id, coverage: "unknown" },
			artifacts: Array(8).fill({ path: "x".repeat(2048), purpose: "Evidence" }),
		},
	};
	db.prepare("UPDATE turns SET record=?").run(JSON.stringify(oversized));
	expect(() => f.store.getTurn("/root/a", { turn_id: receipt.turn_id })).toThrow(
		expect.objectContaining({ code: "storage_error" }),
	);
	db.prepare("UPDATE turns SET record=?").run(
		JSON.stringify({ ...turn, progress: { ...turn.progress, summary: "bad\ud800text" } }),
	);
	expect(() => f.store.pageTurns("/root/a")).toThrow(expect.objectContaining({ code: "storage_error" }));
	db.prepare("UPDATE turns SET record=?").run(JSON.stringify(turn));
});

test.each(["allowed", "root_revoke", "local_revoke", "getter_failure"] as const)(
	"clean shutdown retains the last live ceiling, progress and real revocations across cold followup (%s)",
	async (scenario) => {
		const f = fixture(true);
		let controller = f.controller;
		let rootTools = ["read", "bash"];
		let localTools = ["read", "bash"];
		let getterFailed = false;
		let disposing = false;
		const observations: Array<{ phase: string; code?: string; tools?: string[] }> = [];
		const commit = f.store.commit.bind(f.store);
		vi.spyOn(f.store, "commit").mockImplementation((snapshot, patches) => {
			if (disposing) observations.push({ phase: "dispose_write", tools: snapshot.agents[0].tools });
			return commit(snapshot, patches);
		});
		controller.bindTools(caller, () => rootTools);
		const create = f.host.create;
		f.host.create = async (options) => {
			const session = await create(options);
			const identity = { rootSessionId: options.rootSessionId, agentPath: options.agentPath };
			const unbind = controller.bindTools(identity, () => {
				if (getterFailed) throw new Error("Genuine native authority uncertainty");
				try {
					return localTools.filter((name) => options.ancestryToolAllowed!(name));
				} catch (error) {
					observations.push({
						phase: disposing ? "dispose_getter" : "live_getter",
						code: (error as { code?: string }).code,
					});
					throw error;
				}
			});
			const dispose = session.dispose;
			session.dispose = async () => {
				disposing = true;
				unbind();
				await dispose();
			};
			return session;
		};
		const first = await controller.spawnTurn(caller, "a", "first", model, [], undefined, {
			delegation: delegation(),
			tools: ["read", "bash"],
		});
		const progress = await controller.reportProgress(
			{ ...caller, agentPath: "/root/a" },
			first.turn_id,
			"Verified before shutdown",
		);
		f.finishes.get("/root/a")!({ status: "completed", text: "Retained result" });
		await controller.settled();
		expect(f.store.read().agents[0].tools).toEqual(["read", "bash"]);
		if (scenario === "root_revoke") rootTools = ["read"];
		if (scenario === "local_revoke") localTools = ["read"];
		if (scenario === "getter_failure") getterFailed = true;
		const expected = scenario === "allowed" ? ["read", "bash"] : scenario === "getter_failure" ? [] : ["read"];
		if (!getterFailed)
			expect(controller.toolAllowed({ ...caller, agentPath: "/root/a" }, "bash")).toBe(scenario === "allowed");
		const shutdown = controller.shutdown();
		expect(() => controller.toolAllowed({ ...caller, agentPath: "/root/a" }, "read")).toThrow(
			expect.objectContaining({ code: "interrupted" }),
		);
		await shutdown;
		const reopened = new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" });
		cleanups.push(() => reopened.close());
		// Capture the first bad permission write, not just the eventual cold symptom.
		expect({
			shutdownGetterFailures: observations.filter((observation) => observation.code),
			retained: reopened.read().agents[0].tools,
		}).toEqual({ shutdownGetterFailures: [], retained: expected });
		for (const write of observations.filter((observation) => observation.phase === "dispose_write"))
			expect(write.tools).toEqual(expected);
		expect(reopened.getTurn("/root/a", { turn_id: first.turn_id })?.progress).toEqual(progress);
		getterFailed = false;
		disposing = false;
		rootTools = ["read", "bash"];
		localTools = ["read", "bash"];
		controller = new CollaborationController({
			store: reopened,
			host: f.host,
			agentDir: f.cwd,
			getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
		});
		cleanups.push(async () => {
			for (const finish of f.finishes.values()) finish({ status: "interrupted", text: "cleanup" });
			await controller.shutdown();
		});
		controller.bindTools(caller, () => rootTools);
		const next = await controller.followupTurn(caller, "a", "explicit cold followup", undefined, {
			delegation: delegation(),
			tools: ["read", "bash"],
		});
		expect(controller.inspect(caller, "a").tools).toEqual(expected);
		await expect(
			f.requests.get("/root/a")!.reportProgress!(next.turn_id, "Progress remains structural"),
		).resolves.toMatchObject({ revision: 1 });
		f.finishes.get("/root/a")!({ status: "completed", text: "Followup result" });
		await controller.settled();
	},
);

test.each(["metadata_budget", "controls", "status", "turn", "root", "foreign", "capacity"] as const)(
	"progress precommit rejection is verified not_started with unchanged snapshot and turn (%s)",
	async (scenario) => {
		const f = fixture();
		const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
		let identity = { ...caller, agentPath: "/root/a" };
		let turn = receipt.turn_id;
		let summary = "No progress effect";
		let code = "busy";
		if (scenario === "metadata_budget") {
			summary = "x".repeat(2000);
			expect(parseReportProgress({ summary })).toEqual({ summary });
			expect(Buffer.byteLength(JSON.stringify({ summary, reported_at: Date.now(), revision: 1 }))).toBeGreaterThan(
				2048,
			);
			code = "invalid_arguments";
		} else if (scenario === "controls") {
			summary = "bad\0text";
			code = "invalid_arguments";
		} else if (scenario === "status") {
			f.finishes.get("/root/a")!({ status: "completed", text: "Already completed" });
			await f.controller.settled();
		} else if (scenario === "turn") turn = "wrong-turn";
		else if (scenario === "root") {
			identity = caller;
			code = "forbidden";
		} else if (scenario === "foreign") {
			identity = { ...identity, rootSessionId: "foreign" };
			code = "forbidden";
		} else if (scenario === "capacity") {
			for (let index = 0; index < 63; index++) await f.controller.send(caller, "/root", `Message ${index}`);
			code = "limit_reached";
		}
		const before = f.store.read();
		const beforeTurn = f.store.getTurn("/root/a", { turn_id: receipt.turn_id });
		const commit = vi.spyOn(f.store, "commit");
		const error = await f.controller.reportProgress(identity, turn, summary).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(CollaborationAdmissionError);
		expect(error).toMatchObject({
			code,
			executionOutcome: "not_started",
			...(scenario === "capacity" ? { reason: "mailbox_full" } : {}),
		});
		expect(commit).not.toHaveBeenCalled();
		expect(f.store.read()).toEqual(before);
		expect(f.store.getTurn("/root/a", { turn_id: receipt.turn_id })).toEqual(beforeTurn);
	},
);

test("unexpected precommit progress failure is not guessed to be admission rejection", async () => {
	const f = fixture();
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
	const before = f.store.read();
	const failure = new Error("Unexpected native read failure");
	vi.spyOn(f.store, "read").mockImplementationOnce(() => {
		throw failure;
	});
	const error = await f.controller
		.reportProgress({ ...caller, agentPath: "/root/a" }, receipt.turn_id, "Not persisted")
		.catch((error: unknown) => error);
	expect(error).toBe(failure);
	expect(error).not.toBeInstanceOf(CollaborationAdmissionError);
	expect(error).not.toHaveProperty("executionOutcome");
	expect(f.store.read()).toEqual(before);
});

test.each([false, true])(
	"SQL progress commit failure remains unknown, not an admission rejection (%s)",
	async (file) => {
		const f = fixture(file, "storage_error");
		const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
		const before = f.store.read();
		const beforeTurn = f.store.getTurn("/root/a", { turn_id: receipt.turn_id });
		const db = Reflect.get(f.store, "database") as DatabaseSync;
		db.exec(
			"CREATE TRIGGER reject_progress_admission BEFORE UPDATE ON team BEGIN SELECT RAISE(ABORT, 'synthetic uncertain progress write'); END",
		);
		try {
			const error = await f.controller
				.reportProgress({ ...caller, agentPath: "/root/a" }, receipt.turn_id, "Commit attempted")
				.catch((error: unknown) => error);
			expect(error).toMatchObject({ code: "storage_error" });
			expect(error).not.toBeInstanceOf(CollaborationAdmissionError);
			expect(error).not.toHaveProperty("executionOutcome");
			await expect(f.controller.settled()).rejects.toMatchObject({ code: "storage_error" });
			expect(f.store.read()).toEqual(before);
			expect(f.store.getTurn("/root/a", { turn_id: receipt.turn_id })).toEqual(beforeTurn);
		} finally {
			db.exec("DROP TRIGGER reject_progress_admission");
		}
	},
);

test("postcommit progress observer failure is not mislabeled not_started", async () => {
	const f = fixture();
	const receipt = await f.controller.spawnTurn(caller, "a", "task", model);
	const failure = new CollaborationError("busy", "Trusted observer failed after commit");
	const unsubscribe = f.requests.get("/root/a")!.subscribeAuthority!(() => {
		throw failure;
	});
	try {
		const error = await f.controller
			.reportProgress({ ...caller, agentPath: "/root/a" }, receipt.turn_id, "Durably persisted")
			.catch((error: unknown) => error);
		expect(error).toBe(failure);
		expect(error).not.toBeInstanceOf(CollaborationAdmissionError);
		expect(error).not.toHaveProperty("executionOutcome");
		expect(f.store.read().agents[0].progress).toMatchObject({ summary: "Durably persisted", revision: 1 });
		expect(f.store.getTurn("/root/a", { turn_id: receipt.turn_id })?.progress).toMatchObject({ revision: 1 });
		expect(f.store.read().messages).toMatchObject([{ kind: "progress", progress: { revision: 1 } }]);
	} finally {
		unsubscribe();
	}
});
