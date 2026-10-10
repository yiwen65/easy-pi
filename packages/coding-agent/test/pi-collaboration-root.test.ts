import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import { afterEach, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { registerPiCollaborationRoot } from "../src/extensions/pi-collaboration-root.ts";
import { spawnArgs } from "./collaboration-fixture.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-root-recovery-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "root-recovery-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const manager = SessionManager.create(cwd, join(cwd, "sessions"));
	manager.appendMessage({ role: "user", content: "retained root", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("retained root answer"));
	const path = join(agentDir, "teams", manager.getSessionId(), "registry.sqlite");
	const owner = new CollaborationStore({ path, cwd, rootSessionId: manager.getSessionId() });
	cleanups.push(() => owner.close());
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		extensionFactories: [
			{
				name: "collaboration-root",
				factory: (pi) =>
					registerPiCollaborationRoot(pi, agentDir, () => ({
						mode: "full-access",
						sessionGrants: [],
						protectedRoots: [],
					})),
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: manager,
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		settingsManager,
		resourceLoader: loader,
	});
	cleanups.push(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await session.shutdown();
	});
	const notices: string[] = [];
	const bind = () =>
		session.bindExtensions({
			mode: "rpc",
			uiContext: { ...session.extensionRunner.getUIContext(), notify: (message) => notices.push(message) },
		});
	const deadOwner = () => {
		owner.close();
		const db = new DatabaseSync(path);
		try {
			db.prepare("UPDATE team SET owner=?, pid=?, owner_started_at=? WHERE id=1").run(randomUUID(), 2147483647, 1);
		} finally {
			db.close();
		}
	};
	return { cwd, path, session, manager, owner, faux, bind, notices, deadOwner };
}

function tool(session: AgentSession, name: string) {
	const result = session.agent.state.tools.find((tool) => tool.name === name);
	if (!result) throw new Error(`Missing tool ${name}`);
	return result;
}

test("root automatically adopts a dead owner, retains results and interrupts unfinished turns without inference", async () => {
	const f = await fixture();
	const snapshot = f.owner.read();
	const model = { provider: f.faux.provider.id, id: f.faux.getModel().id, thinkingLevel: "off" as const };
	snapshot.agents.push(
		{
			id: randomUUID(),
			path: "/root/done",
			parent: "/root",
			model,
			status: "completed",
			turnId: randomUUID(),
			result: "retained child result",
		},
		{
			id: randomUUID(),
			path: "/root/unfinished",
			parent: "/root",
			model,
			status: "running",
			completionPending: true,
			turnId: randomUUID(),
		},
	);
	f.owner.commit(snapshot);
	f.deadOwner();
	await f.bind();
	expect(f.notices).toEqual([]);
	expect(f.session.getActiveToolNames()).toContain("spawn_agent");
	expect(f.faux.state.callCount).toBe(0);
	const listed = await tool(f.session, "list_agents").execute("list", {});
	expect(listed.details).toMatchObject({
		agents: [
			{ task_name: "/root/done", status: "completed", loaded: false },
			{ task_name: "/root/unfinished", status: "interrupted", loaded: false },
		],
	});
	const result = await tool(f.session, "get_agent_result").execute("result", { target: "done" });
	expect(result.details).toMatchObject({ state: "found", result: { preview: "retained child result" } });
	const interrupted = await tool(f.session, "wait_agent").execute("wait", { target: "unfinished" });
	expect(interrupted.details).toMatchObject({ reason: "terminal", result: { turn: { status: "interrupted" } } });
	expect(f.faux.state.callCount).toBe(0);
	f.faux.setResponses([fauxAssistantMessage("new child result")]);
	const spawned = await tool(f.session, "spawn_agent").execute("spawn", spawnArgs("fresh", "new task"));
	const receipt = spawned.details as { task_name: string; turn_id: string };
	const fresh = await tool(f.session, "wait_agent").execute("wait-fresh", {
		target: receipt.task_name,
		turn_id: receipt.turn_id,
	});
	expect(fresh.details).toMatchObject({ reason: "terminal", result: { turn: { status: "completed" } } });
	expect(f.faux.state.callCount).toBe(1);
});

test.each(["/agents", "/agents recover"])(
	"%s retries acquisition after a live owner releases the team",
	async (command) => {
		const f = await fixture();
		await f.bind();
		expect(f.session.getActiveToolNames()).not.toContain("spawn_agent");
		await f.session.prompt("/agents recover");
		expect(f.session.getActiveToolNames()).not.toContain("spawn_agent");
		expect(f.notices.join("\n")).toContain("busy");
		expect(f.owner.read().agents).toEqual([]);
		f.owner.close();
		await f.session.prompt(command);
		expect(f.session.getActiveToolNames()).toContain("spawn_agent");
		expect(f.faux.state.callCount).toBe(0);
		await f.session.prompt(command);
		expect(f.session.getActiveToolNames().filter((name) => name === "spawn_agent")).toHaveLength(1);
	},
);

test("the next root prompt reacquires a formerly busy team before constructing provider context", async () => {
	const f = await fixture();
	await f.bind();
	f.deadOwner();
	f.faux.setResponses([
		(context) => {
			expect(context.tools?.map((tool) => tool.name)).toContain("spawn_agent");
			expect(JSON.stringify(context.messages).match(/Current runtime role: \/root,/g)).toHaveLength(1);
			return fauxAssistantMessage("root resumed");
		},
	]);
	await f.session.prompt("continue");
	expect(f.session.getActiveToolNames()).toContain("spawn_agent");
	expect(f.faux.state.callCount).toBe(1);
	expect(f.session.isIdle).toBe(true);
});

test("unknown snapshots remain unchanged and ordinary root inference remains usable", async () => {
	const f = await fixture();
	f.owner.close();
	const db = new DatabaseSync(f.path);
	db.prepare("UPDATE team SET snapshot=? WHERE id=1").run(JSON.stringify({ version: 99 }));
	db.close();
	await f.bind();
	await f.session.prompt("/agents recover");
	expect(f.session.getActiveToolNames()).not.toContain("spawn_agent");
	expect(f.notices.join("\n")).toContain("storage_error");
	f.faux.setResponses([fauxAssistantMessage("ordinary root works")]);
	await f.session.prompt("ordinary prompt");
	expect(f.faux.state.callCount).toBe(1);
	const readback = new DatabaseSync(f.path, { readOnly: true });
	try {
		expect(JSON.parse(String(readback.prepare("SELECT snapshot FROM team WHERE id=1").get()!.snapshot))).toEqual({
			version: 99,
		});
	} finally {
		readback.close();
	}
});
