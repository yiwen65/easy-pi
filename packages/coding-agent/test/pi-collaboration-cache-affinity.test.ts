import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSessionCreateOptions } from "@easy-pi/subagent/session-host";
import { afterEach, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createEasyPiHarness } from "../src/extensions/easy-pi.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";
import { getCollaborationPrefix } from "../src/extensions/pi-collaboration-context.ts";
import { registerPiCollaborationTools } from "../src/extensions/pi-collaboration-tools.ts";
import { followupArgs, spawnArgs } from "./collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(api = "openai-codex-responses") {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-cache-affinity-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "affinity-faux", api, tokensPerSecond: 0 });
	runtime.registerNativeProvider(faux.provider);
	const manager = SessionManager.create(cwd, join(cwd, "root"));
	const identity = { rootSessionId: manager.getSessionId(), agentPath: "/root" };
	const store = new CollaborationStore({
		path: join(cwd, "team", "registry.sqlite"),
		cwd,
		rootSessionId: identity.rootSessionId,
	});
	const settings = { compaction: { enabled: false }, retry: { enabled: false }, transport: "auto" as const };
	const getPermissions = () => ({ mode: "full-access" as const, sessionGrants: [], protectedRoots: [] });
	const children = new Map<string, AgentSession>();
	let root: AgentSession;
	let controller: CollaborationController;
	const host = createPiChildSessionHost({
		modelRuntime: runtime,
		settings,
		noExtensions: true,
		getTools: () => root.getActiveToolNames(),
		observeSession: (child, session) => {
			children.set(child.agentPath, session);
			return () => {
				children.delete(child.agentPath);
			};
		},
		registerTools: (child, pi, getSession) =>
			registerPiCollaborationTools({ pi, controller, identity: child, getSession }),
	});
	controller = new CollaborationController({ store, host, agentDir: join(cwd, "agent"), getPermissions });
	const settingsManager = SettingsManager.inMemory(settings);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		extensionFactories: [
			{
				name: "affinity-root",
				factory: createEasyPiHarness({
					nativeSession: {
						getPermissions,
						registerTools: (pi) =>
							registerPiCollaborationTools({ pi, controller, identity, getSession: () => root }),
					},
				}),
			},
		],
	});
	await loader.reload();
	({ session: root } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		model: faux.getModel(),
		thinkingLevel: "off",
		settingsManager,
		resourceLoader: loader,
		sessionManager: manager,
	}));
	await root.bindExtensions({ mode: "rpc" });
	cleanups.push(async () => {
		await controller.shutdown();
		root.dispose();
	});
	const requests: SimpleStreamOptions[] = [];
	faux.setResponses(
		Array.from({ length: 16 }, () => (_context: Context, options: SimpleStreamOptions | undefined) => {
			requests.push({
				sessionId: options?.sessionId,
				cacheAffinityId: options?.cacheAffinityId,
				promptCacheKey: options?.promptCacheKey,
				transport: options?.transport,
			});
			return fauxAssistantMessage(
				JSON.stringify({
					summary: "synthetic",
					outcome: "succeeded",
					artifacts: [],
					evidence: [],
					checks: [],
					risks: [],
				}),
			);
		}),
	);
	async function tool(session: AgentSession, name: string, args: Record<string, unknown>) {
		const result = await session.agent.state.tools
			.find((candidate) => candidate.name === name)!
			.execute("synthetic-call", args);
		expect(result).not.toHaveProperty("isError", true);
		await controller.settled();
		return result;
	}
	async function evictFirstChild() {
		for (let index = 0; index < 3; index++)
			await tool(root, "spawn_agent", spawnArgs(`filler${index}`, "isolate for LRU pressure"));
	}
	return { cwd, root, controller, children, requests, tool, host, faux, identity, getPermissions, evictFirstChild };
}

test("native preserve descendants and cold followups inherit cache lineage, not session identity", async () => {
	const f = await fixture();
	f.root.agent.promptCacheKey = "logical-parent-key";
	await f.root.prompt("parent warm fixture");
	const parentId = f.root.sessionId;
	expect(getCollaborationPrefix(f.root).cacheAffinity).toEqual({ id: parentId, key: "logical-parent-key" });
	await f.tool(
		f.root,
		"spawn_agent",
		spawnArgs("child", "continue", { mode: "fork", turns: "all", prefix: "preserve" }),
	);
	const child = f.children.get("/root/child")!;
	expect(child.sessionId).not.toBe(parentId);
	expect(f.requests.at(-1)).toMatchObject({
		sessionId: child.sessionId,
		cacheAffinityId: parentId,
		promptCacheKey: "logical-parent-key",
		transport: "sse",
	});
	expect(f.root.agent.transport).toBe("auto");
	expect(f.root.agent.cacheAffinityId).toBeUndefined();
	await f.tool(
		child,
		"spawn_agent",
		spawnArgs("grandchild", "nested", { mode: "fork", turns: "all", prefix: "preserve" }),
	);
	const grandchild = f.children.get("/root/child/grandchild")!;
	expect(new Set([parentId, child.sessionId, grandchild.sessionId]).size).toBe(3);
	expect(f.requests.at(-1)).toMatchObject({
		sessionId: grandchild.sessionId,
		cacheAffinityId: parentId,
		promptCacheKey: "logical-parent-key",
		transport: "sse",
	});
	expect(JSON.stringify(grandchild.messages)).not.toContain("logical-parent-key");
	const childId = child.sessionId;
	const file = child.sessionFile!;
	const before = await readFile(file, "utf8");
	expect(before).toContain('"cacheAffinity":{"id":');
	await f.evictFirstChild();
	expect(f.children.has("/root/child")).toBe(false);
	const calls = f.requests.length;
	await f.tool(f.root, "followup_task", followupArgs("/root/child", "explicit followup"));
	expect(f.requests).toHaveLength(calls + 1);
	expect(f.requests.at(-1)).toMatchObject({
		sessionId: childId,
		cacheAffinityId: parentId,
		promptCacheKey: "logical-parent-key",
		transport: "sse",
	});
	expect(JSON.stringify(f.children.get("/root/child")!.messages)).toContain("explicit followup");
});

test("preserve respects an explicit parent affinity and the parent's default logical key", async () => {
	const f = await fixture();
	f.root.agent.cacheAffinityId = "upstream-affinity";
	await f.root.prompt("parent fixture");
	expect(getCollaborationPrefix(f.root).cacheAffinity).toEqual({ id: "upstream-affinity", key: f.root.sessionId });
	await f.tool(
		f.root,
		"spawn_agent",
		spawnArgs("child", "continue", { mode: "fork", turns: "all", prefix: "preserve" }),
	);
	expect(f.requests.at(-1)).toMatchObject({
		cacheAffinityId: "upstream-affinity",
		promptCacheKey: f.root.sessionId,
		transport: "sse",
	});
	expect(JSON.stringify(f.children.get("/root/child")!.messages)).not.toContain("upstream-affinity");
});

test.each(["isolated", "rebuild", "curated"] as const)("%s children do not inherit cache lineage", async (mode) => {
	const f = await fixture();
	f.root.agent.cacheAffinityId = "ancestor-affinity";
	f.root.agent.promptCacheKey = "ancestor-key";
	await f.root.prompt("parent fixture");
	await writeFile(join(f.cwd, "evidence.txt"), "synthetic evidence");
	await f.tool(
		f.root,
		"spawn_agent",
		spawnArgs(
			"child",
			"independent",
			mode === "isolated"
				? { mode }
				: mode === "rebuild"
					? { mode: "fork", turns: "all", prefix: "rebuild" }
					: {
							mode: "curated",
							references: [
								{
									path: "evidence.txt",
									sha256: createHash("sha256").update("synthetic evidence").digest("hex"),
									start_line: 1,
									end_line: 1,
								},
							],
						},
		),
	);
	const child = f.children.get("/root/child")!;
	expect(f.requests.at(-1)).toMatchObject({
		sessionId: child.sessionId,
		cacheAffinityId: undefined,
		promptCacheKey: undefined,
		transport: "auto",
	});
});

test("non-Codex preserve does not inherit Codex affinity options", async () => {
	const f = await fixture("affinity-other-api");
	await f.root.prompt("other provider fixture");
	expect(getCollaborationPrefix(f.root).cacheAffinity).toBeUndefined();
	await f.tool(
		f.root,
		"spawn_agent",
		spawnArgs("child", "continue", { mode: "fork", turns: "all", prefix: "preserve" }),
	);
	expect(f.requests.at(-1)).toMatchObject({
		cacheAffinityId: undefined,
		promptCacheKey: undefined,
		transport: "auto",
	});
});

test("malformed stored cache affinity is rejected before opening or rewriting native history", async () => {
	const f = await fixture();
	await f.root.prompt("parent fixture");
	await f.tool(
		f.root,
		"spawn_agent",
		spawnArgs("child", "continue", { mode: "fork", turns: "all", prefix: "preserve" }),
	);
	const file = f.children.get("/root/child")!.sessionFile!;
	await f.evictFirstChild();
	const records = (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const entry = records.find(
		(record) => record.type === "custom" && record.customType === "epi-collaboration-identity",
	);
	entry.data.cacheAffinity = { id: 5, key: "invalid" };
	const invalid = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
	await writeFile(file, invalid);
	const request: ChildSessionCreateOptions = {
		...f.identity,
		agentPath: "/root/child",
		cwd: f.cwd,
		agentDir: join(f.cwd, "agent"),
		model: { provider: f.faux.provider.id, id: f.faux.getModel().id, thinkingLevel: "off" },
		storage: { kind: "file", directory: join(file, ".."), sessionFile: file },
		getPermissions: f.getPermissions,
	};
	await expect(f.host.create(request)).rejects.toThrow(/cache affinity/i);
	expect(await readFile(file, "utf8")).toBe(invalid);
});
