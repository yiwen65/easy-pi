import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SESSION_CACHE_AFFINITY_ENTRY } from "../src/core/session-cache-affinity.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface CapturedRequest {
	sessionId?: string;
	cacheAffinityId?: string;
	promptCacheKey?: string;
	transport?: string;
	messages: unknown[];
}

async function fixture(api: "openai-codex-responses" | "faux-other" = "openai-codex-responses") {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-session-cache-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir, { recursive: true });
	const sessionDir = join(cwd, "sessions");
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "session-cache-faux", api, tokensPerSecond: 0 });
	runtime.registerNativeProvider(faux.provider);
	const requests: CapturedRequest[] = [];
	faux.setResponses(
		Array.from({ length: 32 }, () => (context: Context, options?: SimpleStreamOptions) => {
			requests.push({
				sessionId: options?.sessionId,
				cacheAffinityId: options?.cacheAffinityId,
				promptCacheKey: options?.promptCacheKey,
				transport: options?.transport,
				messages: structuredClone(context.messages),
			});
			return fauxAssistantMessage("ack");
		}),
	);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: targetCwd,
		sessionManager,
		cacheAffinityId,
	}) => {
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			transport: "auto",
		});
		const services = await createAgentSessionServices({
			cwd: targetCwd,
			agentDir,
			settingsManager,
			modelRuntime: runtime,
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			cacheAffinityId,
			model: faux.getModel(),
			thinkingLevel: "off",
			noTools: "all",
		});
		cleanups.push(() => {
			created.session.dispose();
		});
		return { ...created, services, diagnostics: [] };
	};
	const sessionManager = SessionManager.create(cwd, sessionDir);
	const runtimeHandle = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
	cleanups.push(async () => {
		await runtimeHandle.dispose();
	});
	return { cwd, sessionDir, agentDir, faux, requests, runtime: runtimeHandle };
}

test("clone and fork join the parent cache lineage without sharing session identity", async () => {
	const f = await fixture();
	const parentId = f.runtime.session.sessionId;
	await f.runtime.session.prompt("parent message");
	expect(f.requests).toHaveLength(1);
	expect(f.requests[0]).toMatchObject({ sessionId: parentId, cacheAffinityId: undefined });

	await f.runtime.fork(f.runtime.session.sessionManager.getLeafId()!, { position: "at" });
	const clone = f.runtime.session;
	expect(clone.sessionId).not.toBe(parentId);
	expect(clone.agent.promptCacheKey).toBe(parentId);
	expect(clone.agent.cacheAffinityId).toBe(parentId);
	expect(clone.agent.transport).toBe("sse");

	await clone.prompt("clone message");
	expect(f.requests.at(-1)).toMatchObject({
		sessionId: clone.sessionId,
		cacheAffinityId: parentId,
		promptCacheKey: parentId,
		transport: "sse",
	});
	// The duplicate request still carries the parent's request as a message prefix.
	expect(JSON.stringify(f.requests.at(-1)!.messages.slice(0, 1))).toBe(JSON.stringify(f.requests[0]!.messages));

	// "/fork" cuts before the selected user message and joins the same lineage.
	const forkTarget = clone.sessionManager
		.getBranch()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes("parent message"),
		);
	expect(forkTarget).toBeDefined();
	await f.runtime.fork(forkTarget!.id);
	expect(f.runtime.session.sessionId).not.toBe(clone.sessionId);
	expect(f.runtime.session.agent.cacheAffinityId).toBe(parentId);
});

test("lineage survives reopen and repeated forks and is recorded once per branch", async () => {
	const f = await fixture();
	await f.runtime.session.prompt("root message");
	const parentId = f.runtime.session.sessionId;
	await f.runtime.fork(f.runtime.session.sessionManager.getLeafId()!, { position: "at" });
	const firstCloneFile = f.runtime.session.sessionManager.getSessionFile()!;
	await f.runtime.session.prompt("clone message");

	// Repeated fork inside the clone keeps the root lineage instead of decaying per hop.
	await f.runtime.fork(f.runtime.session.sessionManager.getLeafId()!, { position: "at" });
	const secondCloneFile = f.runtime.session.sessionManager.getSessionFile()!;
	expect(secondCloneFile).not.toBe(firstCloneFile);
	expect(f.runtime.session.agent.cacheAffinityId).toBe(parentId);

	const hintsOf = async (file: string) =>
		(await readFile(file, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { customType?: string; data?: { affinityId?: string } })
			.filter((entry) => entry.customType === SESSION_CACHE_AFFINITY_ENTRY);
	for (const file of [firstCloneFile, secondCloneFile]) {
		const hints = await hintsOf(file);
		expect(hints).toHaveLength(1);
		expect(hints[0]!.data?.affinityId).toBe(parentId);
	}

	// A fresh process reopening the fork restores the same lineage from the session file.
	await f.runtime.switchSession(firstCloneFile);
	expect(f.runtime.session.agent.cacheAffinityId).toBe(parentId);
	expect(f.runtime.session.agent.promptCacheKey).toBe(parentId);
});

test("a corrupted lineage record degrades to the nearest valid ancestor lineage", async () => {
	const f = await fixture();
	await f.runtime.session.prompt("root message");
	await f.runtime.fork(f.runtime.session.sessionManager.getLeafId()!, { position: "at" });
	const file = f.runtime.session.sessionManager.getSessionFile()!;
	const records = (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { customType?: string; data?: unknown });
	const hint = records.find((record) => record.customType === SESSION_CACHE_AFFINITY_ENTRY)!;
	hint.data = { version: 1, affinityId: 5 };
	await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

	await f.runtime.switchSession(file);
	// The corrupted record is ignored instead of failing the open or being trusted.
	expect(f.runtime.session.agent.cacheAffinityId).toBeUndefined();
	expect(f.runtime.session.agent.promptCacheKey).toBeUndefined();
	await f.runtime.session.prompt("after corruption");
	expect(f.requests.at(-1)!.sessionId).toBe(f.runtime.session.sessionId);
});

test("a session without the record keeps its own identity as the cache lineage", async () => {
	const f = await fixture();
	await f.runtime.session.prompt("legacy root");
	const rootFile = f.runtime.session.sessionManager.getSessionFile()!;
	const rootId = f.runtime.session.sessionId;
	await f.runtime.switchSession(rootFile);
	expect(rootFile).toContain(rootId);
	// Nothing recorded yet: the reopened session keeps its own id and its configured transport.
	expect(f.runtime.session.agent.cacheAffinityId).toBeUndefined();
	expect(f.runtime.session.agent.promptCacheKey).toBeUndefined();

	await f.runtime.fork(f.runtime.session.sessionManager.getLeafId()!, { position: "at" });
	expect(f.runtime.session.agent.cacheAffinityId).toBe(rootId);
	expect(f.runtime.session.agent.promptCacheKey).toBe(rootId);
});

test("non-Codex providers keep their configured transport", async () => {
	const f = await fixture("faux-other");
	await f.runtime.session.prompt("root message");
	await f.runtime.fork(f.runtime.session.sessionManager.getLeafId()!, { position: "at" });
	expect(f.runtime.session.agent.cacheAffinityId).toBe(f.runtime.session.agent.promptCacheKey);
	expect(f.runtime.session.agent.transport).toBe("auto");
});
