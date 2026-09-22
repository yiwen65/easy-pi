/**
 * Auto-compaction feasibility regressions.
 *
 * These pin the failures reproduced against a real provider (gpt-5.6-luna, 272k window):
 * - the 95% trigger can sit beyond the point where a compaction request still fits;
 * - the compaction request must not reserve the main response budget (16,384 tokens);
 * - the summary-proportionality gate rejected legitimate, concise handoffs for bulk histories;
 * - a rejected attempt was paid for twice per provider request (two preflight hooks).
 */

import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	estimateLocalCompactionTriggerTokens,
	generateCompactionItem,
	validateCompactionSummary,
} from "../../src/core/compaction/subsystem/narrative.ts";
import { HfCompactionHost } from "../../src/core/compaction/subsystem/session-integration.ts";
import { evaluateTriggers } from "../../src/core/compaction/subsystem/trigger.ts";
import type { CompleteFn } from "../../src/core/compaction/subsystem/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

const shortHandoff = [
	"## Conversation timeline",
	"User pasted 13 spec documents; the assistant recorded each document's constraint count.",
	"## Current continuation point",
	"Next concrete action: mark step 3 in deploy.md and append `progress: 3`.",
].join("\n");

/** A handoff long enough to stand on its own, yet below the ratio floor for a very large history. */
const substantiveHandoff = [
	"## Conversation timeline",
	`Episode log: ${"the user pasted a specification and asked for the constraint count. ".repeat(13)}`,
	"## Current continuation point",
	"Primary objective: keep maintaining deploy.md; next action: mark step 3.",
].join("\n");

describe("trigger feasibility ceiling", () => {
	it("opens at the ceiling when the ceiling binds", () => {
		const decision = evaluateTriggers({
			predictedNextRequestTokens: 8_600,
			modelContextLimit: 10_000,
			maxFeasibleTokens: 8_000,
		});
		expect(decision.action).toBe("compact");
		expect(decision.triggerTokens).toBe(8_000);
		expect(decision.reasons[0]).toContain("compaction-feasible ceiling");
	});

	it("keeps the fraction threshold when it is the lower bound", () => {
		const decision = evaluateTriggers({
			predictedNextRequestTokens: 9_600,
			modelContextLimit: 10_000,
			maxFeasibleTokens: 9_800,
		});
		expect(decision.action).toBe("compact");
		expect(decision.triggerTokens).toBe(9_500);
		expect(decision.reasons[0]).toContain("95% limit");
	});

	it("stays closed just below the ceiling", () => {
		const decision = evaluateTriggers({
			predictedNextRequestTokens: 7_999,
			modelContextLimit: 10_000,
			maxFeasibleTokens: 8_000,
		});
		expect(decision.action).toBe("none");
	});
});

describe("host feasibility ceiling", () => {
	const host = () =>
		new HfCompactionHost({
			sessionId: "feasibility",
			getSystemPrompt: () => "CURRENT SYSTEM",
			getToolsTokenEstimate: () => 100,
			config: { mode: "full_pipeline" },
		});

	it("opens auto compaction before the 95% point when the window cannot carry it", () => {
		const manager = SessionManager.inMemory();
		const expectedCeiling = 30_000 - 4_096 - estimateLocalCompactionTriggerTokens(undefined) - 1_024;

		const atCeiling = host().evaluateCompactionTrigger({
			branchEntries: manager.getBranch(),
			modelContextLimit: 30_000,
			outputReserveTokens: 16_384,
			recentProviderContextTokens: expectedCeiling,
		});
		expect(atCeiling.decision.action).toBe("compact");
		expect(atCeiling.decision.triggerTokens).toBe(expectedCeiling);
		expect(atCeiling.decision.triggerTokens).toBeLessThan(Math.floor(0.95 * 30_000));

		const belowCeiling = host().evaluateCompactionTrigger({
			branchEntries: manager.getBranch(),
			modelContextLimit: 30_000,
			outputReserveTokens: 16_384,
			recentProviderContextTokens: expectedCeiling - 1,
		});
		expect(belowCeiling.decision.action).toBe("none");
	});
});

describe("summary proportionality gate", () => {
	it("accepts a substantive handoff for a large history when nothing was truncated", () => {
		expect(substantiveHandoff.length).toBeGreaterThanOrEqual(1_000);
		expect(validateCompactionSummary(substantiveHandoff, 250_000)).toBeUndefined();
	});

	it("still rejects that handoff when the compactor input overflowed or was cut short", () => {
		const issue = validateCompactionSummary(substantiveHandoff, 250_000, { truncatedInput: true });
		expect(issue).toContain("implausibly small");
	});

	it("accepts a tiny handoff for a large history when no truncation was reported", () => {
		// Real compactor runs write 64-300 character handoffs for bulk histories that genuinely carry
		// no more state than that; rejecting them left the session uncompactable.
		expect(validateCompactionSummary(shortHandoff, 250_000)).toBeUndefined();
	});

	it("rejects a tiny handoff that also drops the required sections", () => {
		expect(validateCompactionSummary("D1-D56 counted, 120 each.", 250_000)).toContain("lacks every required section");
	});

	it("still rejects a tiny handoff for a truncated history", () => {
		expect(validateCompactionSummary(shortHandoff, 250_000, { truncatedInput: true })).toContain("implausibly small");
	});

	it("always rejects a degenerate handoff", () => {
		expect(validateCompactionSummary("hi", 250_000)).toContain("degenerate");
		expect(validateCompactionSummary("hi", 250_000, { truncatedInput: true })).toContain("degenerate");
	});
});

describe("compaction item truncation signal", () => {
	const messages = [
		{ role: "user" as const, content: "keep going", timestamp: 1 },
		{
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "big.log" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse" as const,
			timestamp: 2,
		},
		{
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text" as const, text: "x".repeat(600_000) }],
			details: undefined,
			isError: false,
			timestamp: 3,
		},
	];

	it("accepts a substantive handoff after a clean compactor response", async () => {
		const result = await generateCompactionItem({
			messages,
			systemPrompt: "SYSTEM",
			complete: async () => ({ text: substantiveHandoff, stopReason: "stop" }),
		});
		expect(result.rejected).toBe(false);
		expect(result.truncatedInput).toBe(false);
	});

	it("rejects that same handoff after a provider-reported overflow", async () => {
		let calls = 0;
		const complete: CompleteFn = async () => {
			calls++;
			return calls === 1
				? { text: "", stopReason: "error", errorMessage: "overflow", contextOverflow: true }
				: { text: substantiveHandoff, stopReason: "stop" };
		};
		const result = await generateCompactionItem({ messages, systemPrompt: "SYSTEM", complete });
		expect(calls).toBe(2);
		expect(result.rejected).toBe(true);
		expect(result.reason).toContain("implausibly small");
		expect(result.truncatedInput).toBe(true);
	});
});

describe("provider calibration", () => {
	const host = () =>
		new HfCompactionHost({
			sessionId: "calibration",
			getSystemPrompt: () => "CURRENT SYSTEM",
			getToolsTokenEstimate: () => 100,
			config: { mode: "full_pipeline" },
		});

	const measuredAssistant = (providerPromptTokens: number) => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: providerPromptTokens,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: providerPromptTokens + 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	});

	/** One 4k-character user message: ~1,000 raw chars/4 tokens but 2,600 provider tokens. */
	const fixture = (providerPromptTokens?: number) => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "x".repeat(4_000), timestamp: 1 });
		if (providerPromptTokens !== undefined) manager.appendMessage(measuredAssistant(providerPromptTokens));
		return manager;
	};

	it("predicts from the provider measurement instead of the raw character estimate", () => {
		const measured = host().evaluateCompactionTrigger({
			branchEntries: fixture(2_600).getBranch(),
			modelContextLimit: 10_000,
			outputReserveTokens: 100,
		});
		expect(measured.predictedNextRequestTokens).toBeGreaterThan(2_500);
		expect(measured.tokenEstimateProvenance).toBe("provider_projection");

		const unmeasured = host().evaluateCompactionTrigger({
			branchEntries: fixture().getBranch(),
			modelContextLimit: 10_000,
			outputReserveTokens: 100,
		});
		expect(unmeasured.predictedNextRequestTokens).toBeLessThan(1_500);
	});

	it("bounds how far a runaway measurement scales unseen growth", () => {
		const manager = fixture(20_000);
		manager.appendMessage({ role: "user", content: "y".repeat(4_000), timestamp: 3 });
		const evaluation = host().evaluateCompactionTrigger({
			branchEntries: manager.getBranch(),
			modelContextLimit: 200_000,
			outputReserveTokens: 100,
		});
		// The 1k-token local growth after the measurement is scaled by at most 4, not by the raw 18x sample.
		expect(evaluation.predictedNextRequestTokens).toBeGreaterThan(23_000);
		expect(evaluation.predictedNextRequestTokens).toBeLessThan(26_000);
	});

	it("reports calibrated sizes in the compaction outcome", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: `bulk history ${"y".repeat(80_000)}`, timestamp: 1 });
		manager.appendMessage(measuredAssistant(50_000));
		const outcome = await host().attemptCompaction({
			branchEntries: manager.getBranch(),
			modelContextLimit: 200_000,
			complete: async () => ({ text: shortHandoff, stopReason: "stop" }),
		});
		expect(outcome.activated).toBe(true);
		// ~20k raw chars/4 tokens are reported at the measured ~2.5x provider scale.
		expect(outcome.tokensBefore ?? 0).toBeGreaterThan(45_000);
	});
});

describe("compaction request reserve", () => {
	const fixture = () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: `bulk history ${"y".repeat(80_000)}`, timestamp: 1 });
		return manager;
	};
	const complete: CompleteFn = async () => ({ text: shortHandoff, stopReason: "stop" });
	const host = () =>
		new HfCompactionHost({
			sessionId: "reserve",
			getSystemPrompt: () => "CURRENT SYSTEM",
			getToolsTokenEstimate: () => 100,
			config: { mode: "full_pipeline" },
		});

	it("fits a near-window history because only the handoff output is reserved", async () => {
		const outcome = await host().attemptCompaction({
			branchEntries: fixture().getBranch(),
			modelContextLimit: 30_000,
			complete,
		});
		expect(outcome.activated).toBe(true);
	});

	it("would reject the same history when the main response reserve is charged to compaction", async () => {
		const outcome = await host().attemptCompaction({
			branchEntries: fixture().getBranch(),
			modelContextLimit: 30_000,
			outputReserveTokens: 16_384,
			complete,
		});
		expect(outcome.activated).toBe(false);
		expect(outcome.summaryText).toContain("cannot fit the model context");
	});
});
