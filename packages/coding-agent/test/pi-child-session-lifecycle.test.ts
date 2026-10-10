import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { COLLABORATION_LIMITS } from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const full = () => ({ mode: "full-access" as const, sessionGrants: [], protectedRoots: [] });

async function fixture(settings: Partial<Settings> = {}) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-child-lifecycle-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "lifecycle-faux", tokensPerSecond: 0 });
	runtime.registerNativeProvider(faux.provider);
	const natives = new Map<string, AgentSession>();
	const detached: string[] = [];
	const host = createPiChildSessionHost({
		modelRuntime: runtime,
		settings: { compaction: { enabled: false }, retry: { enabled: false }, ...settings },
		noExtensions: true,
		registerTools: () => {},
		observeSession(identity, session) {
			natives.set(identity.agentPath, session);
			return () => detached.push(identity.agentPath);
		},
	});
	const rootSessionId = randomUUID();
	const path = join(cwd, "team", "registry.sqlite");
	const store = new CollaborationStore({ path, cwd, rootSessionId });
	const controller = new CollaborationController({ store, host, agentDir: cwd, getPermissions: full });
	cleanups.push(async () => {
		try {
			await controller.shutdown();
		} finally {
			store.close();
		}
	});
	const caller = { rootSessionId, agentPath: "/root" };
	const model = { provider: faux.provider.id, id: faux.getModel().id, thinkingLevel: "off" as const };
	async function complete(name: string) {
		faux.setResponses([fauxAssistantMessage("done")]);
		await controller.spawn(caller, name, name, model);
		await controller.settled();
		return natives.get(`/root/${name}`)!;
	}
	return { cwd, path, rootSessionId, caller, store, controller, host, faux, natives, detached, model, complete };
}

test("automatic unloading preserves an idle child's active background process and unloads a quiescent peer", async () => {
	const f = await fixture();
	const first = await f.complete("background-owner");
	const started = await first.backgroundTasks!.start("sleep 120", { cwd: f.cwd });
	if (!started.ok) throw new Error("Fixture background task failed to start");
	for (let index = 1; index < COLLABORATION_LIMITS.maxActiveSessions; index++) await f.complete(`peer${index}`);
	expect(first.backgroundTasks!.get(started.value.id)?.status).toBe("running");
	expect(f.controller.list(f.caller).find((agent) => agent.task_name === "/root/background-owner")?.loaded).toBe(true);
	expect(f.controller.list(f.caller).find((agent) => agent.task_name === "/root/peer1")?.loaded).toBe(false);
	expect(f.detached).toEqual(["/root/peer1"]);
	await f.controller.close(f.caller, "background-owner");
	expect(first.backgroundTasks!.list({ activeOnly: true })).toEqual([]);
	expect(f.controller.getAgentResult(f.caller, { target: "background-owner" })).toMatchObject({
		state: "found",
		result: { preview: "done" },
	});
});

test("background wake settings cannot start an unassigned child inference turn", async () => {
	const f = await fixture({ backgroundBashCompletionDelivery: "wake" });
	const native = await f.complete("wake-probe");
	const calls = f.faux.state.callCount;
	f.faux.setResponses([fauxAssistantMessage("unassigned inference")]);
	const started = await native.backgroundTasks!.start("sleep 0.05", { cwd: f.cwd });
	if (!started.ok) throw new Error("Fixture background task failed to start");
	await native.backgroundTasks!.wait(started.value.id, 1000);
	await vi.waitFor(() => expect(native.isIdle).toBe(true));
	expect(f.faux.state.callCount).toBe(calls);
	expect(native.pendingBackgroundTaskNotificationCount).toBe(1);
});

test("resource-busy loaded capacity rejects new loading without stopping tasks or poisoning the team", async () => {
	const f = await fixture();
	const tasks: Array<{ session: AgentSession; id: string }> = [];
	for (let index = 0; index < COLLABORATION_LIMITS.maxActiveSessions - 1; index++) {
		const session = await f.complete(`busy${index}`);
		const started = await session.backgroundTasks!.start("sleep 120", { cwd: f.cwd });
		if (!started.ok) throw new Error("Fixture background task failed to start");
		tasks.push({ session, id: started.value.id });
	}
	await expect(f.complete("over-capacity")).rejects.toMatchObject({ reason: "loaded_sessions_full" });
	expect(tasks.every(({ session, id }) => session.backgroundTasks!.get(id)?.status === "running")).toBe(true);
	expect(f.detached).toEqual([]);
	await f.controller.send(f.caller, "/root", "team remains usable");
	await tasks[0].session.backgroundTasks!.stop(tasks[0].id);
	const stopped = await tasks[0].session.backgroundTasks!.wait(tasks[0].id, 5000);
	expect(stopped.ok && !stopped.value.timedOut).toBe(true);
	await f.complete("after-task-settled");
	expect(f.detached).toEqual(["/root/busy0"]);
});

test("native child disposal reports an incomplete resource drain instead of declaring success", async () => {
	const f = await fixture();
	const child = await f.host.create({
		...f.caller,
		agentPath: "/root/drain-probe",
		cwd: f.cwd,
		agentDir: f.cwd,
		model: f.model,
		storage: { kind: "memory" },
		getPermissions: full,
	});
	const native = f.natives.get("/root/drain-probe")!;
	const shutdown = vi.spyOn(native, "shutdown").mockResolvedValueOnce({
		complete: false,
		failedResources: [],
		timedOutResources: ["synthetic-task"],
		remainingResources: ["synthetic-task"],
	});
	try {
		await expect(child.dispose()).rejects.toMatchObject({ code: "interrupted" });
	} finally {
		shutdown.mockRestore();
		await native.shutdown();
	}
	expect(f.detached).toContain("/root/drain-probe");
});
