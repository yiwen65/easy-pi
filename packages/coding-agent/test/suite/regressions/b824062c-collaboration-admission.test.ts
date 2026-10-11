import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolError } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CollaborationError } from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSessionHost } from "@easy-pi/subagent/session-host";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { registerPiCollaborationTools } from "../../../src/extensions/pi-collaboration-tools.ts";
import { followupArgs, spawnArgs } from "../../collaboration-fixture.ts";
import { createHarness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "epi-admission-"));
	const sessionManager = SessionManager.inMemory(cwd);
	const identity = { rootSessionId: sessionManager.getSessionId(), agentPath: "/root" };
	const store = new CollaborationStore({ path: ":memory:", cwd, rootSessionId: identity.rootSessionId });
	const creations: string[] = [];
	const runs: string[] = [];
	const host: ChildSessionHost = {
		async create(options) {
			creations.push(options.agentPath);
			return {
				identity: { rootSessionId: options.rootSessionId, agentPath: options.agentPath },
				sessionId: randomUUID(),
				sessionFile: undefined,
				context: () => [],
				forkContext: () => [],
				run: async (text) => {
					runs.push(text);
					return { status: "completed", text: "completed offline" };
				},
				abort: async () => {},
				dispose: async () => {},
			};
		},
	};
	const controller = new CollaborationController({
		store,
		host,
		agentDir: cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [cwd] }),
	});
	let session: AgentSession;
	const h = await createHarness({
		sessionManager,
		tools: [],
		hfCompaction: { mode: "off" },
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				registerPiCollaborationTools({ pi, controller, identity, getSession: () => session });
			},
		],
	});
	session = h.session;
	await session.bindExtensions({ mode: "print" });
	cleanups.push(async () => {
		await session.shutdown();
		await controller.shutdown();
		h.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	});
	const seedWorker = async () => {
		const model = h.getModel();
		await controller.spawn(identity, "worker", "seed task", {
			provider: model.provider,
			id: model.id,
			thinkingLevel: "off",
		});
		await controller.settled();
		await controller.acknowledge(
			identity,
			controller.pending(identity).map((message) => message.id),
		);
	};
	return { h, session, store, controller, identity, host, creations, runs, seedWorker };
}

const invalidTargets = ["/outside", "../worker"];
for (const name of ["send_message", "interrupt_agent", "close_agent"] as const) {
	test.each(invalidTargets)(`${name} rejects %s without an investigation or team effects`, async (target) => {
		const f = await fixture();
		const before = f.store.read();
		const commit = vi.spyOn(f.store, "commit");
		f.h.setResponses([
			fauxAssistantMessage(fauxToolCall(name, { target, ...(name === "send_message" ? { message: "text" } : {}) }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("correct the target"),
		]);
		await f.session.prompt("try target");
		expect(f.store.read()).toEqual(before);
		expect(f.store.countTurns()).toBe(0);
		expect(commit).not.toHaveBeenCalled();
		expect(f.creations).toEqual([]);
		expect(f.runs).toEqual([]);
		expect(f.h.eventsOfType("agent_start")).toHaveLength(1);
		expect(f.session.taskRecovery?.status).toBe("completed");
		expect(f.session.suspendedTaskRecovery).toEqual([]);
		expect(f.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			toolName: name,
			isError: true,
		});
		// Certainty is carried by the exception, not by the presentation details.
		const tool = f.session.agent.state.tools.find((tool) => tool.name === name)!;
		const error = await tool
			.execute("invalid-target", { target, ...(name === "send_message" ? { message: "text" } : {}) })
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(AgentToolError);
		expect(error).toMatchObject({ executionOutcome: "not_started" });
		expect(f.store.read()).toEqual(before);
	});
}

test.each(["spawn_agent", "followup_task", "send_message"] as const)(
	"%s cancellation after enqueue but before admission is not_started with no receipt or mutation",
	async (name) => {
		const f = await fixture();
		if (name !== "spawn_agent") await f.seedWorker();
		const before = f.store.read();
		const turns = f.store.countTurns();
		const creations = [...f.creations];
		const runs = [...f.runs];
		const commit = vi.spyOn(f.store, "commit");
		const abort = new AbortController();
		// The real call enqueues synchronously; cancellation wins before its promise callback runs.
		if (name === "spawn_agent") {
			const actual = f.controller.spawnTurn.bind(f.controller);
			vi.spyOn(f.controller, "spawnTurn").mockImplementation((...args) => {
				const pending = actual(...args);
				abort.abort();
				return pending;
			});
		} else if (name === "followup_task") {
			const actual = f.controller.followupTurn.bind(f.controller);
			vi.spyOn(f.controller, "followupTurn").mockImplementation((...args) => {
				const pending = actual(...args);
				abort.abort();
				return pending;
			});
		} else {
			const actual = f.controller.send.bind(f.controller);
			vi.spyOn(f.controller, "send").mockImplementation((...args) => {
				const pending = actual(...args);
				abort.abort();
				return pending;
			});
		}
		const args =
			name === "spawn_agent"
				? spawnArgs("cancelled", "must not run")
				: name === "followup_task"
					? followupArgs("worker", "must not run")
					: { target: "worker", message: "must not enqueue" };
		const tool = f.session.agent.state.tools.find((tool) => tool.name === name)!;
		const error = await tool.execute("queue-cancel", args, abort.signal).catch((error: unknown) => error);
		expect(abort.signal.aborted).toBe(true);
		expect(f.store.read()).toEqual(before);
		expect(f.store.countTurns()).toBe(turns);
		expect(commit).not.toHaveBeenCalled();
		expect(f.creations).toEqual(creations);
		expect(f.runs).toEqual(runs);
		expect(error).toBeInstanceOf(AgentToolError);
		expect(error).toMatchObject({ executionOutcome: "not_started" });
	},
);

test.each(["forbidden", "invalid_arguments", "interrupted"] as const)(
	"an actual post-admission host %s failure remains unknown",
	async (code) => {
		const f = await fixture();
		const before = f.store.read().revision;
		vi.spyOn(f.host, "create").mockRejectedValueOnce(new CollaborationError(code, "post-admission failure"));
		f.h.setResponses([
			fauxAssistantMessage(fauxToolCall("spawn_agent", spawnArgs("worker", "task")), { stopReason: "toolUse" }),
			fauxAssistantMessage("inspect retained admission"),
		]);
		await f.session.prompt("spawn");
		expect(f.store.read().revision).toBeGreaterThan(before);
		expect(f.store.read().agents).toMatchObject([{ path: "/root/worker", status: "failed" }]);
		expect(f.store.countTurns()).toBe(1);
		expect(f.runs).toEqual([]);
		expect(f.session.suspendedTaskRecovery).toMatchObject([
			{ state: { status: "needs_reconciliation", tools: [{ dispatched: true, safe: false }] } },
		]);
		expect(f.session.suspendedTaskRecovery[0].state.tools[0].result).toBeUndefined();
	},
);

test("cancellation on the persisted admission notification remains unknown", async () => {
	const f = await fixture();
	const before = f.store.read().revision;
	const abort = new AbortController();
	const unsubscribe = f.controller.subscribe(() => {
		if (f.store.read().agents[0]?.status === "pending") abort.abort();
	});
	const tool = f.session.agent.state.tools.find((tool) => tool.name === "spawn_agent")!;
	const error = await tool
		.execute("admitted-cancel", spawnArgs("worker", "task"), abort.signal)
		.catch((error: unknown) => error);
	unsubscribe();
	expect(error).toBeInstanceOf(AgentToolError);
	expect(error).toMatchObject({ executionOutcome: "unknown" });
	expect(f.store.read().revision).toBeGreaterThan(before);
	expect(f.store.read().agents).toMatchObject([{ status: "interrupted", taskMessage: { kind: "task" } }]);
	expect(f.store.countTurns()).toBe(1);
	expect(f.creations).toEqual([]);
	expect(f.runs).toEqual([]);
});

test("an actual uncertain persistence failure remains unknown without child startup", async () => {
	const f = await fixture();
	vi.spyOn(f.store, "commit").mockImplementationOnce(() => {
		throw new Error("uncertain durable update");
	});
	f.h.setResponses([
		fauxAssistantMessage(fauxToolCall("spawn_agent", spawnArgs("worker", "task")), { stopReason: "toolUse" }),
		fauxAssistantMessage("inspect persistence"),
	]);
	await f.session.prompt("spawn");
	expect(f.creations).toEqual([]);
	expect(f.runs).toEqual([]);
	expect(f.session.suspendedTaskRecovery).toMatchObject([{ state: { status: "needs_reconciliation" } }]);
	expect(f.session.suspendedTaskRecovery[0].state.tools[0].result).toBeUndefined();
	await expect(f.controller.settled()).rejects.toThrow("Failed to persist");
});
