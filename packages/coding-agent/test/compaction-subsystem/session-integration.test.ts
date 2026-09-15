import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { HfCompactionHost } from "../../src/core/compaction/subsystem/session-integration.ts";
import type { CompleteFn } from "../../src/core/compaction/subsystem/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
/** A handoff that satisfies the quality gate in validateCompactionSummary(). */
const compliantHandoff = [
	"## Conversation timeline",
	"User asked to migrate the checkpoint store; the assistant read large.log and confirmed the v2 layout.",
	"",
	"## Current continuation point",
	"Primary objective: finish the checkpoint migration. Next concrete action: run the focused tests.",
].join("\n");
const complete: CompleteFn = async () => ({
	text: compliantHandoff,
	stopReason: "stop",
});

function fixture() {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: `old goal ${"x".repeat(8_000)}`, timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "large.log" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 2_000,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2_010,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "tool payload ".repeat(2_000) }],
		details: undefined,
		isError: false,
		timestamp: 3,
	});
	manager.appendMessage({ role: "user", content: "current goal: migrate checkpoints", timestamp: 4 });
	return manager;
}

function host(toolEvidence?: string) {
	return new HfCompactionHost({
		sessionId: "checkpoint-session",
		getSystemPrompt: () => "CURRENT SYSTEM",
		getToolsTokenEstimate: () => 100,
		...(toolEvidence ? { getToolEvidenceSummary: () => toolEvidence } : {}),
		config: { mode: "full_pipeline", recentUserTokens: 500 },
	});
}

describe("HfCompactionHost checkpoint pipeline", () => {
	it("retains an unanswered latest user message after the compaction item", async () => {
		const manager = fixture();
		const h = host();
		const outcome = await h.attemptCompaction({ complete, branchEntries: manager.getBranch() });

		expect(outcome.activated).toBe(true);
		expect(outcome.checkpoint?.replacementHistory.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
		]);
		expect(outcome.checkpoint?.replacementHistory[0]).toMatchObject({
			role: "compactionSummary",
			estimatedTokensAfter: outcome.tokensAfter,
		});
		expect(JSON.stringify(outcome.checkpoint?.replacementHistory)).toContain("current goal: migrate checkpoints");
		expect(JSON.stringify(outcome.checkpoint?.replacementHistory)).not.toContain("old goal");
		expect(JSON.stringify(outcome.checkpoint?.replacementHistory)).not.toContain("earlier content omitted");
		expect(JSON.stringify(outcome.checkpoint?.replacementHistory)).not.toContain("tool payload");
		expect(outcome.tokensAfter).toBeLessThan(outcome.tokensBefore!);
	});

	it("does not append an answered latest user message after the compaction item", async () => {
		const manager = fixture();
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "checkpoint migration completed" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 2_100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2_110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 5,
		});

		const outcome = await host().attemptCompaction({ complete, branchEntries: manager.getBranch() });

		expect(outcome.activated).toBe(true);
		expect(outcome.checkpoint?.replacementHistory.map((message) => message.role)).toEqual(["compactionSummary"]);
		expect(JSON.stringify(outcome.checkpoint?.replacementHistory)).not.toContain("current goal: migrate checkpoints");
	});

	it("appends only the bounded live tool evidence supplied by the runtime", async () => {
		const manager = fixture();
		const evidence = [
			"### Live v2 tool evidence",
			"Runtime-local handles; revalidate before use.",
			"- loc_live · src/auth.ts · 4-7",
		].join("\n");
		const outcome = await host(evidence).attemptCompaction({ complete, branchEntries: manager.getBranch() });
		const summary = outcome.checkpoint?.replacementHistory[0];
		expect(summary).toMatchObject({ role: "compactionSummary" });
		expect(summary && "summary" in summary ? summary.summary : "").toContain(evidence);
		expect(JSON.stringify(summary).match(/loc_live/g)).toHaveLength(1);
		expect(JSON.stringify(outcome.checkpoint?.replacementHistory)).not.toContain("tool payload");
	});

	it("restores the active checkpoint from the main session branch", async () => {
		const manager = fixture();
		const h = host();
		const outcome = await h.attemptCompaction({ complete, branchEntries: manager.getBranch() });
		const checkpoint = outcome.checkpoint!;
		manager.appendCompactionCheckpoint(checkpoint.replacementHistory, checkpoint.tokensBefore);
		h.syncFromEntries(manager.getBranch());
		const persisted = manager.getBranch().at(-1);
		expect(persisted).toMatchObject({ type: "compaction", replacementHistory: expect.any(Array) });
		expect(persisted).not.toHaveProperty("summary");
		expect(persisted).not.toHaveProperty("firstKeptEntryId");

		expect(h.buildActiveMessages(manager.getBranch())).toEqual(manager.buildSessionContext().messages);
		expect(h.inspectActiveContext()).toMatchObject({
			mode: "full_pipeline",
			replacementMessageCount: 2,
			tailMessageCount: 0,
		});
	});

	it("does not retain a clipped suffix when the latest user message exceeds its budget", async () => {
		const manager = fixture();
		manager.appendMessage({
			role: "user",
			content: `latest oversized goal starts here ${"z".repeat(8_000)} unique-tail-marker`,
			timestamp: 5,
		});
		const outcome = await host().attemptCompaction({ complete, branchEntries: manager.getBranch() });

		expect(outcome.activated).toBe(true);
		expect(outcome.checkpoint?.replacementHistory.map((message) => message.role)).toEqual(["compactionSummary"]);
		expect(JSON.stringify(outcome.checkpoint?.replacementHistory)).not.toContain("unique-tail-marker");
		expect(JSON.stringify(outcome.checkpoint?.replacementHistory)).not.toContain("earlier content omitted");
	});

	it("accepts a handoff larger than the former five-percent budget without setting an output ceiling", async () => {
		const manager = fixture();
		let requestHadMaxTokens = true;
		const detailedHandoff = "Detailed handoff content. ".repeat(200);
		const outcome = await new HfCompactionHost({
			sessionId: "unbounded-handoff-session",
			getSystemPrompt: () => "CURRENT SYSTEM",
			config: { mode: "full_pipeline", recentUserTokens: 64_000 },
		}).attemptCompaction({
			branchEntries: manager.getBranch(),
			modelContextLimit: 10_000,
			complete: async (request) => {
				requestHadMaxTokens = "maxTokens" in request;
				return { text: detailedHandoff, stopReason: "stop" };
			},
		});

		expect(outcome.activated).toBe(true);
		expect(requestHadMaxTokens).toBe(false);
		expect(outcome.checkpoint?.replacementHistory[0]).toMatchObject({
			role: "compactionSummary",
			summary: detailedHandoff.trim(),
		});
		expect(outcome.checkpoint?.replacementHistory.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
		]);
	});

	it("rejects a handoff only when the complete projected context cannot fit the model window", async () => {
		const manager = fixture();
		const outcome = await host().attemptCompaction({
			branchEntries: manager.getBranch(),
			modelContextLimit: 5_000,
			outputReserveTokens: 100,
			complete: async () => ({ text: "oversized ".repeat(2_400), stopReason: "stop" }),
		});

		expect(outcome).toMatchObject({ activated: false });
		expect(outcome.summaryText).toContain("input would exceed the model context limit");
		expect(outcome.checkpoint).toBeUndefined();
	});

	it("rejects a checkpoint that would not reduce the projected context", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "short", timestamp: 1 });
		const outcome = await host().attemptCompaction({
			branchEntries: manager.getBranch(),
			complete: async () => ({ text: "long replacement ".repeat(100), stopReason: "stop" }),
		});

		expect(outcome).toMatchObject({ activated: false });
		expect(outcome.summaryText).toContain("would not reduce context");
		expect(outcome.checkpoint).toBeUndefined();
	});

	it("does not publish a checkpoint when compaction-item generation fails", async () => {
		const manager = fixture();
		const outcome = await host().attemptCompaction({
			complete: async () => ({ text: "", stopReason: "error", errorMessage: "failed" }),
			branchEntries: manager.getBranch(),
		});
		expect(outcome).toMatchObject({ activated: false, summaryText: "failed" });
		expect(manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
