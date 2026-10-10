/**
 * Manual real-provider verification that a `/clone` session reuses the parent's cached prefix.
 *
 * What it measures: one fresh root session, a warm parent request that proves the provider caches
 * this prefix, then a real `/clone` whose first request must read that same prefix. The control
 * group keeps the identical prefix, model and settings but clears the inherited cache routing
 * identity before the clone's first request, so a positive delta is attributable to that identity
 * (the same request prefix on a different routing identity must not be assumed to share a cache).
 * The last run observed: fix group clone cached 42496 of ~43.6k input tokens; control 0 of 33095.
 *
 * Never calls a provider unless PI_REAL_MODEL_EVAL=1 is set explicitly. It reads the real
 * credentials through the production AuthStorage path, but every session, cwd, settings manager and
 * resource loader is fresh and ephemeral (temp agent dir, no extensions), so user state, the current
 * session and the user's model store stay untouched. Credentials are never printed; only
 * provider-reported usage counters are recorded.
 *
 * Budget guard: real requests and wall clock are both capped below; exceeding either fails the run.
 *
 * Run explicitly (6 requests, roughly 2-3 minutes):
 *   PI_REAL_MODEL_EVAL=1 npx vitest --run test/real-clone-cache-affinity-eval.test.ts --silent=false
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1";
if (RUN) {
	delete process.env.PI_OFFLINE;
	configureHttpDispatcher();
}

const PROVIDER = process.env.PI_REAL_CLONE_CACHE_PROVIDER ?? "openai-codex";
const MODEL_ID = process.env.PI_REAL_CLONE_CACHE_MODEL ?? "gpt-5.6-luna";
const MAX_REQUESTS = 10;
const MAX_WALL_MS = 10 * 60_000;

interface CapturedRequest {
	sessionId: string | undefined;
	cacheAffinityId: string | undefined;
	promptCacheKey: string | undefined;
	transport: string | undefined;
	messageCount: number;
}

/** Ephemeral runtime that still authenticates through the user's real credentials. */
async function createRealModelRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({ credentials: AuthStorage.create(), allowModelNetwork: false });
}

interface Scenario {
	/** The runtime's current session; replacement forks hand back a new instance. */
	current: () => AgentSession;
	requests: CapturedRequest[];
	usages: Usage[];
	lineages: string[];
	fork: (entryId: string) => Promise<void>;
	dispose: () => Promise<void>;
}

function syntheticBlock(label: string, count: number): string {
	return Array.from(
		{ length: count },
		(_, index) =>
			`${label}-${index}: constraint ${label}.${index} settles component svc-${label}-${index % 23} within ${(index % 9) + 1} minutes.`,
	).join("\n");
}

/** Patch the provider seam so each request's routing identity and prefix size are observable. */
function observeSession(session: AgentSession, requests: CapturedRequest[], usages: Usage[]) {
	const stream = session.agent.streamFunction;
	session.agent.streamFunction = (requestModel, context, streamOptions) => {
		requests.push({
			sessionId: streamOptions?.sessionId,
			cacheAffinityId: streamOptions?.cacheAffinityId,
			promptCacheKey: streamOptions?.promptCacheKey,
			transport: streamOptions?.transport,
			messageCount: context.messages.length,
		});
		return stream(requestModel, context, streamOptions);
	};
	session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") usages.push(event.message.usage);
	});
}

async function createScenario(): Promise<Scenario> {
	const cwd = mkdtempSync(join(tmpdir(), "epi-clone-cache-"));
	// Temp agent dir: the runtime is injected, so no user auth/models file is read or written here.
	const agentDir = mkdtempSync(join(tmpdir(), "epi-clone-cache-agent-"));
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		transport: "auto",
	});
	const modelRuntime = await createRealModelRuntime();
	const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
	if (!model) throw new Error(`Unknown model ${PROVIDER}/${MODEL_ID}`);
	const requests: CapturedRequest[] = [];
	const usages: Usage[] = [];
	const lineages: string[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: targetCwd,
		sessionManager,
		cacheAffinityId,
	}) => {
		lineages.push(cacheAffinityId ?? "<none>");
		const services = await createAgentSessionServices({
			cwd: targetCwd,
			agentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			cacheAffinityId,
			model,
			thinkingLevel: "max",
		});
		observeSession(created.session, requests, usages);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
	});
	await runtime.session.bindExtensions({});
	return {
		current: () => runtime.session,
		requests,
		usages,
		lineages,
		fork: async (entryId) => {
			const result = await runtime.fork(entryId, { position: "at" });
			if (result.cancelled) throw new Error("clone was cancelled");
		},
		dispose: async () => {
			await runtime.dispose();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

function keyOf(messages: readonly AgentMessage[], count: number): string {
	return JSON.stringify(messages.slice(0, count));
}

describe.skipIf(!RUN)("real /clone prompt cache reuse", () => {
	it(
		"clone reads the parent's cached prefix, and the control without routing identity does not",
		async () => {
			const started = Date.now();
			const assertBudget = (requests: number) => {
				if (Date.now() - started > MAX_WALL_MS) throw new Error("Real-request wall-clock budget exceeded");
				if (requests > MAX_REQUESTS) throw new Error("Real-request budget exceeded");
			};
			const results: Array<Record<string, unknown>> = [];
			let totalRequests = 0;

			for (const keepLineage of [true, false]) {
				const scenario = await createScenario();
				const { requests, usages, lineages } = scenario;
				try {
					let session = scenario.current();
					const parentId = session.sessionId;
					assertBudget(totalRequests);
					await session.prompt(`Root context\n${syntheticBlock("ROOT", 80)}`);
					const cold = usages.at(-1)!;
					totalRequests++;
					assertBudget(totalRequests);
					await session.prompt(`Second turn\n${syntheticBlock("SECOND", 60)}`);
					const warm = usages.at(-1)!;
					totalRequests++;
					const parentRequestCount = requests.at(-1)!.messageCount;
					const parentPrefix = keyOf(session.messages, parentRequestCount);

					// Real `/clone`: branch at the current leaf through the same runtime entry point the UI uses.
					assertBudget(totalRequests);
					const leafId = session.sessionManager.getLeafId();
					if (!leafId) throw new Error("No leaf to clone");
					await scenario.fork(leafId);
					session = scenario.current();
					const cloneId = session.sessionId;
					const inherited = session.agent.cacheAffinityId;
					if (!keepLineage) {
						// Control: identical prefix and model, but no cache routing identity.
						session.agent.promptCacheKey = undefined;
						session.agent.cacheAffinityId = undefined;
						session.agent.transport = "auto";
					}
					totalRequests++;
					assertBudget(totalRequests);
					await session.prompt(`Clone turn\n${syntheticBlock("CLONE", 20)}`);
					const cloneUsage = usages.at(-1)!;
					const cloneRequest = requests.at(-1)!;

					// The clone request begins with exactly the parent's warm request prefix.
					expect(keyOf(session.messages, parentRequestCount)).toBe(parentPrefix);
					expect(cloneRequest.sessionId).toBe(cloneId);
					expect(cloneId).not.toBe(parentId);
					// The production fork path threaded the parent lineage into the new runtime.
					expect(inherited).toBe(parentId);
					expect(lineages.at(-1)).toBe(parentId);
					if (keepLineage) {
						expect(cloneRequest.cacheAffinityId).toBe(parentId);
						expect(cloneRequest.promptCacheKey).toBe(parentId);
						expect(cloneRequest.transport).toBe("sse");
						// The clone carries the parent prefix plus its runtime envelope, not the parent tail.
						expect(cloneRequest.messageCount).toBeGreaterThanOrEqual(parentRequestCount);
						expect(cloneRequest.messageCount).toBeLessThanOrEqual(parentRequestCount + 2);
					} else {
						expect(cloneRequest.cacheAffinityId).toBeUndefined();
						expect(cloneRequest.promptCacheKey).toBeUndefined();
					}

					results.push({
						group: keepLineage ? "fix" : "control",
						parentSessionId: parentId,
						cloneSessionId: cloneId,
						parentColdCached: cold.cacheRead,
						parentWarmCached: warm.cacheRead,
						cloneCached: cloneUsage.cacheRead,
						cloneInput: cloneUsage.input,
						cloneAffinity: cloneRequest.cacheAffinityId ?? null,
						cloneTransport: cloneRequest.transport ?? null,
					});
					expect(warm.cacheRead).toBeGreaterThan(0);
					if (keepLineage) expect(cloneUsage.cacheRead).toBeGreaterThan(0);
				} finally {
					await scenario.dispose();
				}
			}
			console.log(JSON.stringify({ totalRequests, results }, null, 1));
		},
		MAX_WALL_MS + 60_000,
	);
});
