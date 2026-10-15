import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexServiceTier } from "../../src/core/codex-service-tier.ts";
import { createHarness, type Harness } from "./harness.ts";

type SummaryPath = "manual" | "auto" | "branch";
interface CapturedRequest {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions | undefined;
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	vi.restoreAllMocks();
});

async function summaryHarness(target: "supported" | "unknown" | "other", tier?: CodexServiceTier) {
	const h = await createHarness({
		withConfiguredAuth: false,
		tools: [],
		settings: {
			codexServiceTier: tier,
			compaction: { keepRecentTokens: 1, reserveTokens: 100 },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		},
		hfCompaction: { mode: "full_pipeline" },
	});
	harnesses.push(h);
	// No provider auth resolution or network is needed for the custom test stream.
	vi.spyOn(h.session.modelRuntime, "getAuth").mockResolvedValue(undefined);
	if (target !== "other") {
		h.session.agent.state.model = {
			...h.getModel(),
			id: "summary-codex",
			provider: "openai-codex",
			api: "openai-codex-responses",
			compat: target === "supported" ? { supportsFastMode: true } : {},
		};
	}
	h.session.agent.promptCacheKey = "summary-prefix";
	h.session.agent.cacheAffinityId = "summary-affinity";
	return h;
}

function seedHistory(h: Harness): string {
	const model = h.session.model!;
	const now = Date.now();
	h.sessionManager.appendMessage({ role: "user", content: "x", timestamp: now - 4000 });
	const targetId = h.sessionManager.appendMessage({
		...fauxAssistantMessage("first reply", { timestamp: now - 3000 }),
		provider: model.provider,
		api: model.api,
		model: model.id,
	});
	h.sessionManager.appendMessage({ role: "user", content: "y", timestamp: now - 2000 });
	h.sessionManager.appendMessage({
		...fauxAssistantMessage("abandoned reply", { timestamp: now - 1000 }),
		provider: model.provider,
		api: model.api,
		model: model.id,
	});
	h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
	return targetId;
}

function installSummaryStream(h: Harness, onRequest?: (index: number) => AssistantMessage | undefined) {
	const requests: CapturedRequest[] = [];
	const streamFn: StreamFn = (model, context, options) => {
		requests.push({ model, context, options });
		const scripted = onRequest?.(requests.length);
		const message: AssistantMessage = {
			...(scripted ?? fauxAssistantMessage("preserved task and next action")),
			provider: model.provider,
			api: model.api,
			model: model.id,
		};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else if (message.stopReason !== "pending") {
				stream.push({ type: "done", reason: message.stopReason, message });
			}
		});
		return stream;
	};
	h.session.agent.streamFunction = streamFn;
	return requests;
}

async function runSummary(h: Harness, path: SummaryPath, targetId: string): Promise<void> {
	if (path === "branch") {
		const result = await h.session.navigateTree(targetId, { summarize: true });
		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry?.summary).toContain("preserved task and next action");
	} else if (path === "manual") {
		const result = await h.session.compact();
		expect(result.summary).toContain("preserved task and next action");
	} else {
		// Exercise the actual automatic path with a deterministic threshold decision,
		// as in agent-session-compaction.test.ts, without issuing a normal model turn.
		const session = h.session as unknown as {
			_runAutoCompaction: (
				reason: "threshold",
				willRetry: boolean,
				decision: { action: "compact"; reasons: string[]; triggerTokens: number; overflowRecovery: boolean },
			) => Promise<boolean>;
		};
		await session._runAutoCompaction("threshold", false, {
			action: "compact",
			reasons: ["test"],
			triggerTokens: 190_000,
			overflowRecovery: false,
		});
		expect(h.eventsOfType("compaction_end").at(-1)?.result?.summary).toContain("preserved task and next action");
	}
}

for (const path of ["manual", "auto", "branch"] as const) {
	describe(`${path} summary session service tier`, () => {
		it.each(["fast", "default"] as const)(
			"forwards the current supported Codex %s preference to a custom stream",
			async (tier) => {
				const h = await summaryHarness("supported");
				h.session.setCodexServiceTier(tier);
				const targetId = seedHistory(h);
				const requests = installSummaryStream(h);
				const model = h.session.model;
				const effort = h.session.thinkingLevel;
				await runSummary(h, path, targetId);
				expect(requests).toHaveLength(1);
				expect(requests[0].options?.serviceTier).toBe(tier);
				expect(requests[0].model).toBe(model);
				expect(h.session.model).toBe(model);
				expect(h.session.thinkingLevel).toBe(effort);
				expect(h.session.agent.promptCacheKey).toBe("summary-prefix");
				expect(h.session.agent.cacheAffinityId).toBe("summary-affinity");
				if (path !== "branch") {
					expect(requests[0].options).toMatchObject({
						promptCacheKey: "summary-prefix",
						cacheAffinityId: "summary-affinity",
						sessionId: h.session.sessionId,
					});
					expect(requests[0].context.tools).toEqual(h.session.agent.state.tools);
				}
			},
		);

		it.each(["supported", "unknown", "other"] as const)(
			"omits tier for %s when unset or unavailable",
			async (target) => {
				const h = await summaryHarness(target, target === "supported" ? undefined : "fast");
				const targetId = seedHistory(h);
				const requests = installSummaryStream(h);
				await runSummary(h, path, targetId);
				expect(requests).toHaveLength(1);
				expect(requests[0].options).not.toHaveProperty("serviceTier");
			},
		);

		it("pins the resolved Fast tier through a summary retry while the session switches to Standard", async () => {
			const h = await summaryHarness("supported");
			h.session.setCodexServiceTier("fast");
			const targetId = seedHistory(h);
			const requests = installSummaryStream(h, (index) => {
				if (index !== 1) return undefined;
				h.session.setCodexServiceTier("default");
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
			});
			await runSummary(h, path, targetId);
			expect(requests.map((request) => request.options?.serviceTier)).toEqual(["fast", "fast"]);
			expect(h.eventsOfType("summarization_retry_scheduled")).toHaveLength(1);
			if (path !== "branch") expect(h.session.codexServiceTier).toBe("default");
		});
	});
}
