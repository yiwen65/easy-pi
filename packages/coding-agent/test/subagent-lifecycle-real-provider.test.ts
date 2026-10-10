/** Opt-in production host lifecycle checks. No credentials or user sessions are copied. */
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { COLLABORATION_LIMITS, validateDelegation } from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getOpenAICodexWebSocketDebugStats } from "../../ai/src/api/openai-codex-responses.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1";
if (RUN) {
	delete process.env.PI_OFFLINE;
	configureHttpDispatcher(60_000);
}
const provider = process.env.PI_REAL_SUBAGENT_PROVIDER ?? "openai-codex";
const modelId = process.env.PI_REAL_SUBAGENT_MODEL ?? "gpt-6-astra";
const full = () => ({ mode: "full-access" as const, sessionGrants: [], protectedRoots: [] });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(delivery: "nextRequest" | "wake" = "nextRequest", transport: "sse" | "auto" = "sse") {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-lifecycle-real-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".epi", "agent");
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	if (!runtime.getModel(provider, modelId))
		throw new Error(`Configured test model unavailable: ${provider}/${modelId}`);
	const natives = new Map<string, AgentSession>();
	const requests = new Map<string, number>();
	const detached: string[] = [];
	const host = createPiChildSessionHost({
		modelRuntime: runtime,
		settings: {
			compaction: { enabled: false },
			retry: { enabled: false },
			transport,
			backgroundBashCompletionDelivery: delivery,
		},
		noExtensions: true,
		registerTools: () => {},
		observeSession(identity, session) {
			natives.set(identity.agentPath, session);
			const previous = session.agent.onProviderContext;
			session.agent.onProviderContext = (model, context) => {
				previous?.(model, context);
				requests.set(identity.agentPath, (requests.get(identity.agentPath) ?? 0) + 1);
			};
			return () => detached.push(identity.agentPath);
		},
	});
	const rootSessionId = randomUUID();
	const path = join(cwd, "team", "registry.sqlite");
	const caller = { rootSessionId, agentPath: "/root" };
	const model = { provider, id: modelId, thinkingLevel: "low" as const };
	const make = () => {
		const store = new CollaborationStore({ path, cwd, rootSessionId, recoverInterruptedOwner: true });
		const controller = new CollaborationController({ store, host, agentDir: cwd, getPermissions: full });
		cleanups.push(() => controller.shutdown());
		return { store, controller };
	};
	const first = make();
	const assignment = (objective: string, tools: string[] = []) => {
		const delegation = validateDelegation({
			task: { objective },
			relationship: "verify",
			context: "isolated",
			tools,
		});
		return { delegation, tools };
	};
	async function complete(
		name: string,
		objective = "Call deliver_result with summary READY and outcome succeeded. Do nothing else.",
		tools: string[] = [],
	) {
		const receipt = await first.controller.spawnTurn(
			caller,
			name,
			objective,
			model,
			[],
			undefined,
			assignment(objective, tools),
		);
		await first.controller.settled();
		expect(first.controller.inspect(caller, name)).toMatchObject({
			status: "completed",
			resultValidation: { contract: "valid" },
		});
		return receipt;
	}
	const api = runtime.getModel(provider, modelId)!.api;
	console.log(`[real-lifecycle] isolated production host ${provider}/${modelId} api=${api}`);
	return { ...first, cwd, path, caller, model, host, natives, requests, detached, assignment, complete, make, api };
}

describe.skipIf(!RUN)("real subagent resource lifecycle", () => {
	test("native close releases real Codex transport session counters as well as connections", async (ctx) => {
		const f = await fixture("nextRequest", "auto");
		if (f.api !== "openai-codex-responses") ctx.skip();
		await f.complete("transport-owner");
		const id = f.natives.get("/root/transport-owner")!.sessionId;
		expect(getOpenAICodexWebSocketDebugStats(id)).toBeDefined();
		await f.controller.close(f.caller, "transport-owner");
		expect(getOpenAICodexWebSocketDebugStats(id)).toBeUndefined();
		console.log("[real-lifecycle] Codex auto transport metadata released with native close");
	}, 90_000);

	test("a completed child does not infer again when a background result arrives under inherited wake settings", async () => {
		const f = await fixture("wake");
		await f.complete("wake-owner");
		const native = f.natives.get("/root/wake-owner")!;
		const before = f.requests.get("/root/wake-owner");
		const started = await native.backgroundTasks!.start("sleep 0.05", { cwd: f.cwd });
		if (!started.ok) throw new Error("Background fixture could not start");
		await native.backgroundTasks!.wait(started.value.id, 1000);
		await vi.waitFor(() => expect(native.pendingBackgroundTaskNotificationCount).toBe(1), { timeout: 1500 });
		expect(f.requests.get("/root/wake-owner")).toBe(before);
		expect(native.isIdle).toBe(true);
		console.log("[real-lifecycle] background completion retained without unassigned inference");
	}, 90_000);

	test("automatic unload preserves live background work, cold followup retains history and close drains resources", async () => {
		const f = await fixture();
		await f.complete(
			"background-owner",
			"Run exactly sleep 600 using bash with run_in_background=true. Then call deliver_result with outcome succeeded and summary BACKGROUND_STARTED including its task ID. Do not wait for or stop the process.",
			["bash"],
		);
		const backgroundOwner = f.natives.get("/root/background-owner")!;
		const active = backgroundOwner.backgroundTasks!.list({ activeOnly: true });
		expect(active).toHaveLength(1);
		for (let index = 1; index < COLLABORATION_LIMITS.maxActiveSessions; index++) await f.complete(`peer${index}`);
		expect(backgroundOwner.backgroundTasks!.get(active[0].id)?.status).toBe("running");
		expect(f.controller.list(f.caller).filter((agent) => agent.loaded)).toHaveLength(15);
		expect(f.detached).toEqual(["/root/peer1"]);
		const before = [...f.requests.values()].reduce((sum, count) => sum + count, 0);
		expect(f.controller.getAgentResult(f.caller, { target: "peer1" })).toMatchObject({
			state: "found",
			turn: { status: "completed" },
		});
		expect([...f.requests.values()].reduce((sum, count) => sum + count, 0)).toBe(before);
		const objective =
			"Use your existing previous result as context. Call deliver_result with summary FOLLOWUP_READY and outcome succeeded. Do nothing else.";
		await f.controller.followupTurn(f.caller, "peer1", objective, undefined, f.assignment(objective));
		await f.controller.settled();
		expect(f.controller.inspect(f.caller, "peer1")).toMatchObject({
			status: "completed",
			resultValidation: { contract: "valid" },
		});
		expect(f.controller.listAgentTurns(f.caller, { target: "peer1" }).turns).toHaveLength(2);
		expect(
			f.natives
				.get("/root/peer1")!
				.sessionManager.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(2);
		await f.controller.close(f.caller, "background-owner");
		expect(backgroundOwner.backgroundTasks!.list({ activeOnly: true })).toEqual([]);
		expect(active[0].pid).toBeTypeOf("number");
		expect(() => process.kill(active[0].pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
		expect(f.controller.list(f.caller).find((agent) => agent.task_name === "/root/background-owner")).toMatchObject({
			status: "closed",
			loaded: false,
		});
		await f.controller.shutdown();
		expect(f.detached).toHaveLength(17);
		const reopened = f.make();
		expect(reopened.controller.list(f.caller).every((agent) => !agent.loaded)).toBe(true);
		expect(reopened.controller.getAgentResult(f.caller, { target: "peer1" })).toMatchObject({
			state: "found",
			turn: { status: "completed" },
		});
		console.log(
			"[real-lifecycle] pressure/cold-load/close/reopen: " +
				before +
				" provider boundaries before followup, 17 native disposals; retained query did not infer",
		);
	}, 360_000);

	test("interrupt drains a real foreground process and allows explicit followup on the same child", async () => {
		const f = await fixture();
		const marker = `FOREGROUND_READY_${randomUUID()}`;
		const objective = `Run exactly echo ${marker}; sleep 120 in foreground using bash with timeout=120 and run_in_background=false. Once it ends, deliver_result with summary DONE and outcome succeeded.`;
		await f.controller.spawnTurn(
			f.caller,
			"interrupt-worker",
			objective,
			f.model,
			[],
			undefined,
			f.assignment(objective, ["bash"]),
		);
		const native = f.natives.get("/root/interrupt-worker")!;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error("Real child did not start bash"));
			}, 90_000);
			const unsubscribe = native.subscribe((event) => {
				if (
					event.type === "tool_execution_update" &&
					event.toolName === "bash" &&
					JSON.stringify(event.partialResult).includes(marker)
				) {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
		expect(await f.controller.interrupt(f.caller, "interrupt-worker")).toBe("running");
		await f.controller.settled();
		expect(native.isIdle).toBe(true);
		expect(native.backgroundTasks!.list({ activeOnly: true })).toEqual([]);
		expect(f.controller.inspect(f.caller, "interrupt-worker").status).toBe("interrupted");
		const next =
			"Call deliver_result with summary FOLLOWUP_AFTER_INTERRUPT and outcome succeeded. Do not execute bash.";
		await f.controller.followupTurn(f.caller, "interrupt-worker", next, undefined, f.assignment(next, ["bash"]));
		await f.controller.settled();
		expect(f.controller.inspect(f.caller, "interrupt-worker").status).toBe("completed");
		await f.controller.close(f.caller, "interrupt-worker");
		expect(f.detached).toEqual(["/root/interrupt-worker"]);
		console.log("[real-lifecycle] real foreground interrupt/followup/close passed");
	}, 180_000);

	test("concurrent completed children release execution capacity and shutdown releases every native session", async () => {
		const f = await fixture();
		await Promise.all(Array.from({ length: 4 }, (_, index) => f.complete(`parallel${index}`)));
		expect(f.controller.list(f.caller).every((agent) => agent.status === "completed")).toBe(true);
		await f.controller.shutdown();
		expect(f.detached).toHaveLength(4);
		const reopened = f.make();
		expect(reopened.controller.list(f.caller)).toHaveLength(4);
		expect(reopened.controller.list(f.caller).every((agent) => !agent.loaded)).toBe(true);
		console.log("[real-lifecycle] 4 concurrent native real-model children settled and disposed");
	}, 180_000);
});
