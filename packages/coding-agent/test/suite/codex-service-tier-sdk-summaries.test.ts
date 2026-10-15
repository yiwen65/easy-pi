import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { CodexServiceTier } from "../../src/core/codex-service-tier.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	vi.restoreAllMocks();
});

type SummaryPath = "manual" | "auto" | "branch";

async function createSdkSession(initialTier?: CodexServiceTier) {
	const h = await createHarness({ tools: [], hfCompaction: { mode: "off" } });
	cleanups.push(h.cleanup);
	h.settingsManager.applyOverrides({
		compaction: { keepRecentTokens: 1, reserveTokens: 100 },
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
	});
	vi.spyOn(h.session.modelRuntime, "getAuth").mockResolvedValue(undefined);
	const model = {
		...h.getModel(),
		id: "sdk-summary-codex",
		provider: "openai-codex",
		api: "openai-codex-responses" as const,
		compat: { supportsFastMode: true },
		reasoning: true,
	};
	const { session } = await createAgentSession({
		cwd: h.tempDir,
		agentDir: h.tempDir,
		model,
		thinkingLevel: "high",
		modelRuntime: h.session.modelRuntime,
		settingsManager: h.settingsManager,
		resourceLoader: h.session.resourceLoader,
		sessionManager: SessionManager.inMemory(h.tempDir),
		noTools: "all",
		cacheAffinityId: "summary-cache-lineage",
		codexServiceTier: initialTier,
	});
	cleanups.push(() => session.shutdown().then(() => undefined));
	return session;
}

function seedHistory(session: AgentSession): string {
	let targetId = "";
	for (let index = 0; index < 2; index++) {
		session.sessionManager.appendMessage({ role: "user", content: "x", timestamp: Date.now() - 4000 + index });
		const entryId = session.sessionManager.appendMessage({
			...fauxAssistantMessage("historical response", { timestamp: Date.now() - 3000 + index }),
			provider: session.model!.provider,
			api: session.model!.api,
			model: session.model!.id,
		});
		if (index === 0) targetId = entryId;
	}
	session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
	return targetId;
}

async function runSummary(session: AgentSession, path: SummaryPath, targetId: string) {
	if (path === "manual") {
		expect((await session.compact()).summary).toContain("retry succeeded");
	} else if (path === "branch") {
		expect((await session.navigateTree(targetId, { summarize: true })).summaryEntry?.summary).toContain(
			"retry succeeded",
		);
	} else {
		const automatic = session as unknown as {
			_runAutoCompaction: (
				reason: "threshold",
				willRetry: boolean,
				decision: {
					action: "compact";
					reasons: string[];
					triggerTokens: number;
					overflowRecovery: boolean;
				},
			) => Promise<boolean>;
		};
		await automatic._runAutoCompaction("threshold", false, {
			action: "compact",
			reasons: ["test"],
			triggerTokens: 190_000,
			overflowRecovery: false,
		});
		expect(session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
	}
}

for (const path of ["manual", "auto", "branch"] as const) {
	describe(`${path} summary retries through the actual SDK seam`, () => {
		it.each([undefined, "default", "fast"] as const)(
			"pins the initial %s tier while the global preference changes",
			async (initialTier) => {
				const session = await createSdkSession(initialTier);
				const targetId = seedHistory(session);
				const captured: Array<SimpleStreamOptions | undefined> = [];
				const changedTier = initialTier === "fast" ? "default" : "fast";
				const model = session.model!;
				const effort = session.thinkingLevel;
				// Keep the SDK-created streamFunction intact. Only the runtime adapter is mocked.
				vi.spyOn(session.modelRuntime, "streamSimple").mockImplementation((requestModel, _context, options) => {
					captured.push(options);
					expect(Object.getOwnPropertySymbols(options ?? {})).toEqual([]);
					if (captured.length === 1) {
						session.setCodexServiceTier(changedTier);
					}
					const response: AssistantMessage = {
						...fauxAssistantMessage(captured.length === 1 ? "" : "retry succeeded", {
							stopReason: captured.length === 1 ? "error" : "stop",
							errorMessage: captured.length === 1 ? "terminated" : undefined,
						}),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					};
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						if (response.stopReason === "error") stream.push({ type: "error", reason: "error", error: response });
						else stream.push({ type: "done", reason: "stop", message: response });
					});
					return stream;
				});

				await runSummary(session, path, targetId);
				expect(captured.map((options) => options?.serviceTier)).toEqual([initialTier, initialTier]);
				if (initialTier === undefined)
					for (const options of captured) expect(options).not.toHaveProperty("serviceTier");
				expect(session.model).toBe(model);
				expect(session.thinkingLevel).toBe(effort);
				expect(session.agent.cacheAffinityId).toBe("summary-cache-lineage");
				expect(session.agent.promptCacheKey).toBe("summary-cache-lineage");
				if (path !== "branch") {
					for (const options of captured)
						expect(options).toMatchObject({
							cacheAffinityId: "summary-cache-lineage",
							promptCacheKey: "summary-cache-lineage",
							reasoning: "high",
						});
				}
				// Even branch-summary navigation cannot restore an older preference.
				expect(session.codexServiceTier).toBe(changedTier);
				expect(session.settingsManager.getCodexServiceTier()).toBe(changedTier);
				const normal = await session.agent.streamFunction(model, { messages: [] }, { serviceTier: undefined });
				await normal.result();
				expect(captured.at(-1)?.serviceTier).toBe(changedTier);
			},
		);
	});
}
