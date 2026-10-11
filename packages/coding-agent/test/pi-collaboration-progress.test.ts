import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
	type CollaborationMessage,
	type CollaborationProgress,
	REPORT_PROGRESS_TOOL_NAME,
	ReportProgressSchema,
} from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSessionCreateOptions, ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createEasyPiHarness } from "../src/extensions/easy-pi.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";
import { registerPiCollaborationTools } from "../src/extensions/pi-collaboration-tools.ts";
import { currentCollaborationPath, spawnArgs } from "./collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const settings = { compaction: { enabled: false }, retry: { enabled: false } };
const full = (): ChildSessionPermissions => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] });
const tool = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const delivery = { summary: "Verified the assigned work", outcome: "succeeded" };

function execute(session: AgentSession, name: string, input: Record<string, unknown>, signal?: AbortSignal) {
	const entry = session.agent.state.tools.find((entry) => entry.name === name);
	if (!entry) throw new Error(`Missing test tool: ${name}`);
	return entry.execute(`test-${name}`, input, signal);
}

async function runtimeFixture() {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-progress-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "progress-faux", tokensPerSecond: 0 });
	runtime.registerNativeProvider(faux.provider);
	return { cwd, runtime, faux };
}

async function teamFixture(onChild?: (native: AgentSession) => void) {
	const f = await runtimeFixture();
	const manager = SessionManager.create(f.cwd, join(f.cwd, "root-history"));
	const identity = { rootSessionId: manager.getSessionId(), agentPath: "/root" };
	const path = join(f.cwd, "team", "registry.sqlite");
	const store = new CollaborationStore({ path, cwd: f.cwd, rootSessionId: identity.rootSessionId });
	const children: AgentSession[] = [];
	let session: AgentSession;
	let controller: CollaborationController;
	const host = createPiChildSessionHost({
		modelRuntime: f.runtime,
		settings,
		noExtensions: true,
		getTools: () => session.getDelegatableToolNames(),
		observeSession: (_identity, native) => {
			children.push(native);
			onChild?.(native);
			return () => {};
		},
		registerTools: (child, pi, getSession) =>
			registerPiCollaborationTools({ pi, controller, identity: child, getSession }),
	});
	controller = new CollaborationController({ store, host, agentDir: join(f.cwd, "agent"), getPermissions: full });
	const settingsManager = SettingsManager.inMemory(settings);
	const loader = new DefaultResourceLoader({
		cwd: f.cwd,
		agentDir: join(f.cwd, "agent"),
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			{
				name: "progress-root",
				factory: createEasyPiHarness({
					nativeSession: {
						getPermissions: full,
						registerTools: (pi) =>
							registerPiCollaborationTools({ pi, controller, identity, getSession: () => session }),
					},
				}),
			},
		],
	});
	await loader.reload();
	({ session } = await createAgentSession({
		cwd: f.cwd,
		agentDir: join(f.cwd, "agent"),
		modelRuntime: f.runtime,
		model: f.faux.getModel(),
		thinkingLevel: "off",
		settingsManager,
		resourceLoader: loader,
		sessionManager: manager,
	}));
	await session.bindExtensions({ mode: "rpc" });
	cleanups.push(async () => {
		await controller.shutdown();
		session.dispose();
	});
	f.faux.setResponses([fauxAssistantMessage("root ready")]);
	await session.prompt("establish durable root");
	return { ...f, manager, identity, store, path, controller, session, host, children };
}

async function standaloneFixture(reportProgress?: ChildSessionCreateOptions["reportProgress"]) {
	const f = await runtimeFixture();
	let native!: AgentSession;
	const host = createPiChildSessionHost({
		modelRuntime: f.runtime,
		settings,
		noExtensions: true,
		getTools: () => [],
		observeSession: (_identity, session) => {
			native = session;
			return () => {};
		},
		registerTools: () => {},
	});
	const child = await host.create({
		rootSessionId: "progress-team",
		agentPath: "/root/worker",
		cwd: f.cwd,
		agentDir: join(f.cwd, "agent"),
		model: { provider: f.faux.provider.id, id: f.faux.getModel().id, thinkingLevel: "off" },
		storage: { kind: "memory" },
		getPermissions: full,
		toolAllowed: () => false,
		ancestryToolAllowed: () => false,
		reportProgress,
	});
	cleanups.push(() => child.dispose());
	const task: CollaborationMessage = {
		id: "trusted-task",
		rootSessionId: "progress-team",
		from: "/root",
		to: "/root/worker",
		turnId: "trusted-turn",
		kind: "task",
		text: "assigned work",
	};
	return { ...f, child, native, task };
}

test("progress persists and is ingested without waking root; the child continues ordinary work and delivers once", async () => {
	const f = await teamFixture();
	await writeFile(join(f.cwd, "evidence.txt"), "observed evidence");
	const reachedNextRequest = deferred<void>();
	const continueWork = deferred<AssistantMessage>();
	let childCalls = 0;
	const captures: Context[] = [];
	f.faux.setResponses(
		Array.from({ length: 12 }, () => (context: Context, options) => {
			captures.push({ ...context, messages: structuredClone(context.messages) });
			if (currentCollaborationPath(context) !== "/root/worker")
				return fauxAssistantMessage("root ingested progress");
			switch (childCalls++) {
				case 0:
					expect(context.tools?.map((entry) => entry.name)).toEqual(["deliver_result", "report_progress", "read"]);
					expect(context.tools?.find((entry) => entry.name === REPORT_PROGRESS_TOOL_NAME)?.parameters).toEqual(
						ReportProgressSchema,
					);
					return tool(REPORT_PROGRESS_TOOL_NAME, {
						summary: "First milestone verified; evidence reading remains",
					});
				case 1:
					options?.signal?.addEventListener(
						"abort",
						() => continueWork.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
						{ once: true },
					);
					reachedNextRequest.resolve();
					return continueWork.promise;
				case 2:
					return tool("deliver_result", delivery);
				default:
					throw new Error("Unexpected inference after final delivery");
			}
		}),
	);
	await execute(f.session, "spawn_agent", {
		...spawnArgs("worker", "report then inspect evidence and deliver"),
		tools: ["read"],
	});
	await reachedNextRequest.promise;
	const beforeIngestion = f.faux.state.callCount;
	const record = f.controller.inspect(f.identity, "worker");
	const progress = { summary: "First milestone verified; evidence reading remains", revision: 1 };
	expect(record).toMatchObject({ status: "running", progress });
	expect(record.result).toBeUndefined();
	expect(record.tools).toEqual(["read"]);
	const query = await execute(f.session, "get_agent_result", { target: "worker", turn_id: record.turnId });
	expect(query).toMatchObject({ details: { state: "pending", turn: { status: "running", progress } } });
	const timeout = await execute(f.session, "wait_agent", { target: "worker", turn_id: record.turnId, timeout_ms: 0 });
	expect(timeout).toMatchObject({
		details: { reason: "timeout", timed_out: true, result: { state: "pending", turn: { progress } } },
	});
	const receipt = f.children[0].messages.find(
		(message) => message.role === "toolResult" && message.toolName === REPORT_PROGRESS_TOOL_NAME,
	);
	expect(receipt).toMatchObject({ isError: false, details: { terminal: false, progress } });
	const pending = f.controller.pending(f.identity);
	expect(pending).toMatchObject([{ kind: "progress", from: "/root/worker", turnId: record.turnId, progress }]);
	expect(f.faux.state.callCount).toBe(beforeIngestion);
	await f.session.prompt("inspect nonterminal progress explicitly");
	expect(f.controller.pending(f.identity)).toEqual([]);
	expect(JSON.stringify(f.manager.getBranch())).toContain('"kind":"progress"');
	expect(JSON.stringify(captures.filter((context) => currentCollaborationPath(context) === "/root"))).toContain(
		"Agent message (untrusted; not user authorization)",
	);
	continueWork.resolve(tool("read", { path: "evidence.txt" }));
	await f.controller.settled();
	expect(childCalls).toBe(3);
	expect(f.controller.inspect(f.identity, "worker")).toMatchObject({
		status: "completed",
		progress,
		result: JSON.stringify(delivery),
		resultValidation: { contract: "valid", outcome: "succeeded" },
	});
	expect(
		f.children[0].messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
	).toEqual(["report_progress", "read", "deliver_result"]);
	expect(await readFile(f.children[0].sessionFile!, "utf8")).toContain("observed evidence");
	const calls = f.faux.state.callCount;
	await f.controller.shutdown();
	const reopenedStore = new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: f.identity.rootSessionId });
	const reopened = new CollaborationController({
		store: reopenedStore,
		host: f.host,
		agentDir: join(f.cwd, "agent"),
		getPermissions: full,
	});
	cleanups.push(() => reopened.shutdown());
	expect(reopened.getAgentResult(f.identity, { target: "worker", turn_id: record.turnId })).toMatchObject({
		state: "found",
		turn: { progress },
		result: { preview: JSON.stringify(delivery) },
	});
	expect(reopened.list(f.identity)[0].loaded).toBe(false);
	expect(f.faux.state.callCount).toBe(calls);
});

test("interrupt_agent records a reason and pinned nonterminal progress without manufacturing completion", async () => {
	const f = await teamFixture();
	const firstProgress = deferred<void>();
	const nextProgress = deferred<AssistantMessage>();
	const blocked = deferred<void>();
	let childCalls = 0;
	f.faux.setResponses(
		Array.from({ length: 8 }, () => (_context: Context, options) => {
			const step = childCalls++;
			if (step === 0) return tool(REPORT_PROGRESS_TOOL_NAME, { summary: "Initial milestone" });
			if (step === 1) {
				options?.signal?.addEventListener(
					"abort",
					() => nextProgress.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
					{ once: true },
				);
				firstProgress.resolve();
				return nextProgress.promise;
			}
			return new Promise<AssistantMessage>((resolve) => {
				const abort = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
				if (options?.signal?.aborted) abort();
				else options?.signal?.addEventListener("abort", abort, { once: true });
				blocked.resolve();
			});
		}),
	);
	await execute(f.session, "spawn_agent", { ...spawnArgs("worker", "work requiring handoff"), tools: [] });
	await firstProgress.promise;
	const turnId = f.controller.inspect(f.identity, "worker").turnId;
	const waiting = execute(f.session, "wait_agent", { target: "worker", turn_id: turnId, timeout_ms: 1000 });
	nextProgress.resolve(
		tool(REPORT_PROGRESS_TOOL_NAME, { summary: "Verification passed; remaining changes not finished" }),
	);
	expect(await waiting).toMatchObject({
		details: {
			reason: "progress",
			timed_out: false,
			turn_id: turnId,
			result: { state: "pending", turn: { status: "running", progress: { revision: 2 } } },
		},
	});
	await blocked.promise;
	const result = await execute(f.session, "interrupt_agent", {
		target: "worker",
		reason: "Operator reviewed progress and requested handoff",
	});
	expect(result).toMatchObject({
		details: {
			previous_status: "running",
			turn_id: turnId,
			progress: { revision: 2, summary: "Verification passed; remaining changes not finished" },
			interruption: { reason: "Operator reviewed progress and requested handoff", requested_by: "/root" },
		},
	});
	await f.controller.settled();
	expect(f.controller.getAgentResult(f.identity, { target: "worker", turn_id: turnId })).toMatchObject({
		turn: {
			status: "interrupted",
			progress: { revision: 2 },
			interruption: { requested_by: "/root" },
			resultValidation: { contract: "not_completed" },
		},
	});
	expect(childCalls).toBe(3);
});

test("preserved child prefixes exclude both structural protocol schemas without losing progress availability", async () => {
	const f = await teamFixture();
	f.faux.setResponses([
		tool(REPORT_PROGRESS_TOOL_NAME, { summary: "Preserved prefix verified" }),
		tool("deliver_result", delivery),
	]);
	await execute(
		f.session,
		"spawn_agent",
		spawnArgs("worker", "preserve the root prefix", { mode: "fork", turns: "all", prefix: "preserve" }),
	);
	await f.controller.settled();
	expect(f.controller.inspect(f.identity, "worker")).toMatchObject({
		status: "completed",
		progress: { summary: "Preserved prefix verified" },
		resultValidation: { contract: "valid" },
	});
	expect(f.children[0].getActiveToolNames()).toContain(REPORT_PROGRESS_TOOL_NAME);
	expect(f.faux.state.callCount).toBe(3);
});

test("root cannot report progress or delegate protocol authority; child team tools remain forbidden", async () => {
	const f = await teamFixture();
	expect(f.session.getAllTools().map((entry) => entry.name)).not.toContain(REPORT_PROGRESS_TOOL_NAME);
	await expect(
		execute(f.session, "spawn_agent", {
			...spawnArgs("bad", "cannot add protocol tools"),
			tools: [REPORT_PROGRESS_TOOL_NAME],
		}),
	).rejects.toThrow();
	expect(f.store.read().agents).toEqual([]);
	let childCalls = 0;
	f.faux.setResponses(
		Array.from({ length: 8 }, () => () => {
			switch (childCalls++) {
				case 0:
					return tool("send_message", { target: "/root", message: "forbidden team operation" });
				case 1:
					return tool(REPORT_PROGRESS_TOOL_NAME, { summary: "Team authority remained restricted" });
				default:
					return tool("deliver_result", delivery);
			}
		}),
	);
	await execute(f.session, "spawn_agent", spawnArgs("worker", "protocol is not team authority"));
	await f.controller.settled();
	expect(f.children[0].messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ role: "toolResult", toolName: "send_message", isError: true }),
			expect.objectContaining({ role: "toolResult", toolName: REPORT_PROGRESS_TOOL_NAME, isError: false }),
		]),
	);
	expect(JSON.stringify(f.children[0].messages)).toContain("nested_delegation");
	expect(f.controller.inspect(f.identity, "worker").tools).not.toContain(REPORT_PROGRESS_TOOL_NAME);
});

test("host binds only the current trusted turn and waits for durable reporting before continuing", async () => {
	const entered = deferred<void>();
	const durable = deferred<CollaborationProgress>();
	const report = vi.fn(async (_turnId: string, _summary: string) => {
		entered.resolve();
		return durable.promise;
	});
	const f = await standaloneFixture(report);
	f.faux.setResponses([
		tool(REPORT_PROGRESS_TOOL_NAME, { summary: "Observed milestone" }),
		tool("deliver_result", delivery),
	]);
	const run = f.child.run(f.task.text, f.task);
	await entered.promise;
	expect(report).toHaveBeenCalledExactlyOnceWith(f.task.turnId, "Observed milestone");
	expect(f.faux.state.callCount).toBe(1);
	durable.resolve({ summary: "Observed milestone", revision: 1, reported_at: 1 });
	expect(await run).toMatchObject({ status: "completed", text: JSON.stringify(delivery) });
	expect(f.faux.state.callCount).toBe(2);
	await expect(execute(f.native, REPORT_PROGRESS_TOOL_NAME, { summary: "Late report" })).rejects.toThrow();
	expect(report).toHaveBeenCalledTimes(1);
});

test("no-task and missing-callback progress are rejected while final delivery retains its semantics", async () => {
	const report = vi.fn(async (_turnId: string, summary: string) => ({ summary, revision: 1, reported_at: 1 }));
	const f = await standaloneFixture(report);
	f.faux.setResponses([
		tool(REPORT_PROGRESS_TOOL_NAME, { summary: "No trusted task" }),
		tool("deliver_result", delivery),
	]);
	expect(await f.child.run("unbound text")).toMatchObject({ status: "completed", text: JSON.stringify(delivery) });
	expect(report).not.toHaveBeenCalled();
	expect(f.native.messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ role: "toolResult", toolName: REPORT_PROGRESS_TOOL_NAME, isError: true }),
		]),
	);
	const missing = await standaloneFixture();
	missing.faux.setResponses([
		tool(REPORT_PROGRESS_TOOL_NAME, { summary: "No persistence callback" }),
		tool("deliver_result", delivery),
	]);
	expect(await missing.child.run(missing.task.text, missing.task)).toMatchObject({
		status: "completed",
		text: JSON.stringify(delivery),
	});
	expect(missing.native.messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ role: "toolResult", toolName: REPORT_PROGRESS_TOOL_NAME, isError: true }),
		]),
	);
});

test("aborted, interrupted and closed host reports cannot invoke the callback", async () => {
	const report = vi.fn(async (_turnId: string, summary: string) => ({ summary, revision: 1, reported_at: 1 }));
	const f = await standaloneFixture(report);
	const entered = deferred<void>();
	f.faux.setResponses([
		(_context, options) =>
			new Promise<AssistantMessage>((resolve) => {
				options?.signal?.addEventListener(
					"abort",
					() => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
					{ once: true },
				);
				entered.resolve();
			}),
	]);
	const run = f.child.run(f.task.text, f.task);
	await entered.promise;
	const aborted = new AbortController();
	aborted.abort();
	await expect(
		execute(f.native, REPORT_PROGRESS_TOOL_NAME, { summary: "Cancelled report" }, aborted.signal),
	).rejects.toThrow();
	await f.child.abort();
	expect(await run).toMatchObject({ status: "interrupted" });
	await expect(execute(f.native, REPORT_PROGRESS_TOOL_NAME, { summary: "Interrupted report" })).rejects.toThrow();
	await f.child.dispose();
	await expect(execute(f.native, REPORT_PROGRESS_TOOL_NAME, { summary: "Closed report" })).rejects.toThrow();
	expect(report).not.toHaveBeenCalled();
});

test("a progress metadata budget rejection does not suspend the assigned task or block ordinary work", async () => {
	let reportedOutcome: string | undefined;
	const f = await teamFixture((native) => {
		// Install before run admission: Agent snapshots its callback before the provider request.
		const previous = native.agent.onToolResult;
		native.agent.onToolResult = async (message, context) => {
			if (message.toolName === REPORT_PROGRESS_TOOL_NAME) reportedOutcome = context.executionOutcome;
			await previous?.(message, context);
		};
	});
	await writeFile(join(f.cwd, "budget-evidence.txt"), "Evidence after rejected progress");
	const summary = "x".repeat(2000);
	expect(Buffer.byteLength(JSON.stringify({ summary }))).toBeLessThanOrEqual(2048);
	expect(Buffer.byteLength(JSON.stringify({ summary, reported_at: Date.now(), revision: 1 }))).toBeGreaterThan(2048);
	let originalTaskId: string | undefined;
	f.faux.setResponses([
		() => {
			originalTaskId = f.children[0].taskRecovery?.id;
			return tool(REPORT_PROGRESS_TOOL_NAME, { summary });
		},
		tool("read", { path: "budget-evidence.txt" }),
		tool("deliver_result", delivery),
	]);
	await execute(f.session, "spawn_agent", {
		...spawnArgs("worker", "continue assigned work after rejected progress"),
		tools: ["read"],
	});
	await f.controller.settled();
	const child = f.children[0];
	expect(child.suspendedTaskRecovery.map((task) => task.state.id)).not.toContain(originalTaskId);
	expect(child.taskRecovery).toMatchObject({ id: originalTaskId, status: "completed" });
	expect(f.controller.inspect(f.identity, "worker").progress).toBeUndefined();
	expect(reportedOutcome).toBe("not_started");
	expect(child.messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ role: "toolResult", toolName: REPORT_PROGRESS_TOOL_NAME, isError: true }),
			expect.objectContaining({ role: "toolResult", toolName: "read", isError: false }),
		]),
	);
});

test("malformed, oversized and redirected progress never reaches the callback; uncertain errors are sanitized", async () => {
	const report = vi.fn(async (_turnId: string, _summary: string): Promise<CollaborationProgress> => {
		throw new Error("SYNTHETIC_PRIVATE_PAYLOAD");
	});
	const f = await standaloneFixture(report);
	f.faux.setResponses([
		tool(REPORT_PROGRESS_TOOL_NAME, { summary: "Redirect attempted", turn_id: "untrusted-turn" }),
		tool(REPORT_PROGRESS_TOOL_NAME, { summary: "界".repeat(800) }),
		tool(REPORT_PROGRESS_TOOL_NAME, { summary: "Bad\u001bcontrol" }),
		tool(REPORT_PROGRESS_TOOL_NAME, { summary: "Real durable attempt" }),
		tool("deliver_result", delivery),
	]);
	expect(await f.child.run(f.task.text, f.task)).toMatchObject({
		status: "completed",
		text: JSON.stringify(delivery),
	});
	expect(report).toHaveBeenCalledExactlyOnceWith(f.task.turnId, "Real durable attempt");
	const reports = f.native.messages.filter(
		(message) => message.role === "toolResult" && message.toolName === REPORT_PROGRESS_TOOL_NAME,
	);
	expect(reports).toHaveLength(4);
	expect(reports.every((message) => message.role === "toolResult" && message.isError)).toBe(true);
	expect(JSON.stringify(reports)).not.toContain("SYNTHETIC_PRIVATE_PAYLOAD");
});
