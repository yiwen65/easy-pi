import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HfCompactionHost } from "../../src/core/compaction/subsystem/session-integration.ts";
import type { CompleteFn } from "../../src/core/compaction/subsystem/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../test-harness.ts";

const harnesses: Harness[] = [];
const tempDirs: string[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const complete: CompleteFn = async (request) => ({
	text: request.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "narrative",
	stopReason: "stop",
	usage: { input: 10, output: 10 },
});

function assistant(text: string, totalTokens: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function textBranch(text = "ordinary work") {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() - 10 });
	manager.appendMessage(assistant("done", 100));
	return manager.getBranch();
}

function toolBranch() {
	const manager = SessionManager.inMemory();
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "inspect log" }],
		timestamp: Date.now() - 30,
	});
	manager.appendMessage({
		...assistant("", 100),
		content: [{ type: "toolCall" as const, id: "tc-1", name: "read", arguments: {} }],
		timestamp: Date.now() - 20,
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "readlog",
		content: [{ type: "text", text: `LOG ${"x".repeat(40_000)}` }],
		details: undefined,
		isError: false,
		timestamp: Date.now() - 10,
	});
	manager.appendMessage(assistant("inspected", 200));
	return manager.getBranch();
}

function host() {
	return new HfCompactionHost({
		sessionId: "s-trigger",
		getSystemPrompt: () => "SYSTEM",
		config: {
			mode: "full_pipeline",
			complete,
			minTokenGainFraction: -1,
			offloadThresholdBytes: 1000,
			keepRecentToolResults: 0,
		},
	});
}

function overflowMessage(timestamp = Date.now()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "prompt is too long",
		timestamp,
	};
}

function hugeLogTool(): AgentTool {
	return {
		name: "read",
		label: "Huge log",
		description: "Returns a large log",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text" as const, text: `HUGE_LOG ${"x".repeat(40_000)}` }],
			details: undefined,
		}),
	};
}

describe("production HF trigger evaluation", () => {
	it("uses the 70% soft and 85% hard boundaries", () => {
		const h = host();
		const branchEntries = textBranch("work ".repeat(500));
		const baseline = h.evaluateCompactionTrigger({
			branchEntries,
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});
		const predicted = baseline.predictedNextRequestTokens;
		expect(predicted).toBeGreaterThan(0);

		const soft = h.evaluateCompactionTrigger({
			branchEntries,
			modelContextLimit: Math.floor(predicted / 0.7) - 1,
			outputReserveTokens: 100,
		});
		expect(soft.decision.action).toBe("soft_compact");

		const hard = h.evaluateCompactionTrigger({
			branchEntries,
			modelContextLimit: Math.floor(predicted / 0.85) - 1,
			outputReserveTokens: 100,
		});
		expect(hard.decision.action).toBe("hard_compact");
	});

	it("does not count internal durability events as provider request tokens", () => {
		const h = host();
		const branchEntries = textBranch();
		const baseline = h.evaluateCompactionTrigger({
			branchEntries,
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});
		for (let index = 0; index < 100; index++) {
			h.eventLog.append({
				sessionId: "s-trigger",
				agentId: "internal-test",
				eventType: "state_change",
				payload: { kind: "internal_checkpoint", index },
				authority: { kind: "system", id: "internal-test", verified: true },
			});
		}

		const afterInternalEvents = h.evaluateCompactionTrigger({
			branchEntries,
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});

		expect(afterInternalEvents.predictedNextRequestTokens).toBe(baseline.predictedNextRequestTokens);
	});

	it("calibrates the final provider projection with a trusted recent usage floor", () => {
		const h = host();
		const branchEntries = textBranch("small request");
		const projection = h.evaluateCompactionTrigger({
			branchEntries,
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});
		const calibrated = h.evaluateCompactionTrigger({
			branchEntries,
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
			recentProviderContextTokens: projection.predictedNextRequestTokens + 500,
		});

		expect(projection.tokenEstimateProvenance).toBe("provider_projection");
		expect(calibrated.tokenEstimateProvenance).toBe("provider_projection_with_recent_usage_floor");
		expect(calibrated.predictedNextRequestTokens).toBe(projection.predictedNextRequestTokens + 500);
	});

	it("selects offload-only below the soft limit when tool payload recovery is large enough", () => {
		const evaluation = host().evaluateCompactionTrigger({
			branchEntries: toolBranch(),
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});
		expect(evaluation.predictedNextRequestTokens).toBeLessThan(700_000);
		expect(evaluation.recoverableToolTokens).toBeGreaterThanOrEqual(8192);
		expect(evaluation.decision.action).toBe("offload_only");
	});

	it("suppresses immediate soft/offload retriggers after a successful activation", async () => {
		const h = host();
		const branchEntries = textBranch("work ".repeat(500));
		const activated = await h.attemptCompaction({
			action: "soft_compact",
			complete,
			branchEntries,
			keepRecentTokens: 1,
			outputReserveTokens: 100,
		});
		expect(activated.activated).toBe(true);
		const baseline = h.evaluateCompactionTrigger({
			branchEntries,
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});
		const evaluation = h.evaluateCompactionTrigger({
			branchEntries,
			modelContextLimit: Math.floor(baseline.predictedNextRequestTokens / 0.7) - 1,
			outputReserveTokens: 100,
		});
		expect(evaluation.compactionCooldownRemaining).toBe(1);
		expect(evaluation.decision).toMatchObject({ action: "none", reasons: ["cooldown active (hysteresis)"] });
	});

	it("selects and executes a durable full rebuild after eight active incremental snapshots", async () => {
		const h = host();
		const manager = SessionManager.inMemory();
		for (let round = 0; round < 8; round++) {
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `round ${round} ${"work ".repeat(100)}` }],
				timestamp: Date.now() + round * 2,
			});
			manager.appendMessage(assistant(`done ${round}`, 100));
			const result = await h.attemptCompaction({
				action: "soft_compact",
				complete,
				branchEntries: manager.getBranch(),
				keepRecentTokens: 1,
				outputReserveTokens: 100,
			});
			expect(result.activated).toBe(true);
		}
		manager.appendMessage({
			...assistant("", 100),
			content: [{ type: "toolCall", id: "tc-rebuild", name: "read", arguments: {} }],
			timestamp: Date.now() + 100,
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tc-rebuild",
			toolName: "read",
			content: [{ type: "text", text: `REBUILD_LOG ${"z".repeat(40_000)}` }],
			details: undefined,
			isError: false,
			timestamp: Date.now() + 101,
		});
		manager.appendMessage(assistant("rebuild log read", 100));
		const evaluation = h.evaluateCompactionTrigger({
			branchEntries: manager.getBranch(),
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});
		expect(evaluation.incrementalCompactionsSinceRebuild).toBe(8);
		expect(evaluation.decision.action).toBe("full_rebuild");
		const coverageBeforeRebuild = h.snapshotStore.getActive("s-trigger")!.baseEventSeq;
		const rebuilt = await h.attemptCompaction({
			action: "full_rebuild",
			complete,
			branchEntries: manager.getBranch(),
			keepRecentTokens: 1,
			outputReserveTokens: 100,
		});
		expect(rebuilt.activated).toBe(true);
		expect(rebuilt.result?.status).toBe("rebuilt");
		const active = h.snapshotStore.getActive("s-trigger");
		expect(active?.compactor.kind).toBe("rebuild");
		expect(active?.baseEventSeq).toBeGreaterThan(coverageBeforeRebuild);
		const activeRecallEntries = active?.recallCatalogRefs.map((refId) =>
			h.recallCatalog.entries().find((entry) => entry.refId === refId),
		);
		expect(activeRecallEntries?.every(Boolean)).toBe(true);
		expect(activeRecallEntries?.filter((entry) => entry?.kind === "tool_result")).toHaveLength(1);
		expect(activeRecallEntries?.some((entry) => entry?.kind === "event_range")).toBe(true);
		expect(h.recallSearch({ query: "", kind: "tool_result", limit: 8 })).toHaveLength(1);
	});

	it("recovers the active-lineage incremental count after restart", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "hf-trigger-state-"));
		tempDirs.push(stateDir);
		const manager = SessionManager.inMemory();
		const first = new HfCompactionHost({
			sessionId: "s-restart-trigger",
			getSystemPrompt: () => "SYSTEM",
			config: { mode: "full_pipeline", stateDir, complete, minTokenGainFraction: -1 },
		});
		for (let round = 0; round < 2; round++) {
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `round ${round} ${"work ".repeat(100)}` }],
				timestamp: Date.now() + round * 2,
			});
			manager.appendMessage(assistant(`done ${round}`, 100));
			const result = await first.attemptCompaction({
				action: "soft_compact",
				complete,
				branchEntries: manager.getBranch(),
				keepRecentTokens: 1,
				outputReserveTokens: 100,
			});
			expect(result.activated).toBe(true);
		}
		const restarted = new HfCompactionHost({
			sessionId: "s-restart-trigger",
			getSystemPrompt: () => "SYSTEM",
			config: { mode: "full_pipeline", stateDir, complete, minTokenGainFraction: -1 },
		});
		const evaluation = restarted.evaluateCompactionTrigger({
			branchEntries: manager.getBranch(),
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});
		expect(evaluation.incrementalCompactionsSinceRebuild).toBe(2);
	});

	it("keeps a full rebuild candidate inactive in shadow mode", async () => {
		const h = new HfCompactionHost({
			sessionId: "s-shadow-rebuild",
			getSystemPrompt: () => "SYSTEM",
			config: { mode: "shadow", complete, minTokenGainFraction: -1 },
		});
		const result = await h.attemptCompaction({
			action: "full_rebuild",
			complete,
			branchEntries: textBranch("shadow rebuild"),
			keepRecentTokens: 1,
			outputReserveTokens: 100,
		});
		expect(result.shadow).toBe(true);
		expect(h.snapshotStore.getActive("s-shadow-rebuild")).toBeUndefined();
		expect(h.snapshotStore.listVersions("s-shadow-rebuild")).toHaveLength(1);

		h.snapshotStore.activate("s-shadow-rebuild", { expectedActiveVersion: 0, candidateVersion: 1 });
		h.reconcileActiveSnapshotCommit();
		expect(
			h.eventLog
				.all("s-shadow-rebuild")
				.some(
					(event) =>
						event.eventType === "compaction" &&
						event.payload !== null &&
						typeof event.payload === "object" &&
						"kind" in event.payload &&
						event.payload.kind === "compaction_commit_recovered",
				),
		).toBe(true);
	});

	it("AgentSession uses the 70% policy instead of the legacy contextWindow-reserve threshold", async () => {
		const h = await createHarness({
			contextWindow: 3000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
			responses: [{ text: "completed work", usage: { totalTokens: 750 } }],
			hfCompaction: { mode: "structured_compaction", complete, minTokenGainFraction: -1 },
		});
		harnesses.push(h);
		await h.session.prompt("work ".repeat(305));
		const host = h.session.hfCompactionHost!;
		expect(host.audit.byType("trigger").map((event) => event.details.action)).toEqual(["soft_compact"]);
		expect(host.audit.byType("trigger")[0].details.reasons).toContain("predicted next request");
		const boundary = host.getActiveTriggerBoundary();
		expect(boundary).toBeDefined();
		const staleOverflow = overflowMessage(new Date(boundary!.timestamp).getTime());
		const handled = await (
			h.session as unknown as {
				_checkCompaction: (message: AssistantMessage) => Promise<boolean>;
			}
		)._checkCompaction(staleOverflow);
		expect(handled).toBe(false);
		expect(host.audit.byType("trigger")).toHaveLength(1);

		const runSpy = vi
			.spyOn(
				h.session as unknown as {
					_runAutoCompaction: (
						reason: "threshold",
						willRetry: false,
						decision: { action: string },
					) => Promise<boolean>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue(false);
		await (
			h.session as unknown as {
				_checkCompaction: (
					message: AssistantMessage,
					skipAbortedCheck: boolean,
					currentInput: string,
				) => Promise<boolean>;
			}
		)._checkCompaction(staleOverflow, false, "new input ".repeat(2000));
		expect(runSpy).toHaveBeenCalledWith(
			"threshold",
			false,
			expect.objectContaining({ action: "hard_compact" }),
			"new input ".repeat(2000),
			0,
		);
	});

	it.each([
		{ mode: "structured_compaction" as const, complete: async () => Promise.reject(new Error("extract failed")) },
		{ mode: "shadow" as const, complete },
	])(
		"$mode overflow failure/shadow preserves live context and retry allowance",
		async ({ mode, complete: compactor }) => {
			const h = await createHarness({
				contextWindow: 3000,
				settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
				responses: ["unused"],
				hfCompaction: { mode, complete: compactor, minTokenGainFraction: -1 },
			});
			harnesses.push(h);
			const user = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "large task" }],
				timestamp: Date.now() - 1,
			};
			const overflow = overflowMessage();
			h.sessionManager.appendMessage(user);
			h.sessionManager.appendMessage(overflow);
			h.session.agent.state.messages = [user, overflow];
			const before = h.session.agent.state.messages;
			const handled = await (
				h.session as unknown as {
					_checkCompaction: (message: AssistantMessage) => Promise<boolean>;
				}
			)._checkCompaction(overflow);
			expect(handled).toBe(false);
			expect(h.session.agent.state.messages).toEqual(before);
			expect((h.session as unknown as { _overflowRecoveryAttempted: boolean })._overflowRecoveryAttempted).toBe(
				false,
			);
		},
	);

	it("offload-only evaluates and projects only the live tail after an active snapshot", async () => {
		const h = host();
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "initial work" }], timestamp: Date.now() });
		manager.appendMessage(assistant("initial done", 100));
		const initial = await h.attemptCompaction({
			action: "soft_compact",
			complete,
			branchEntries: manager.getBranch(),
			keepRecentTokens: 1,
			outputReserveTokens: 100,
		});
		expect(initial.activated).toBe(true);
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read the tail log" }],
			timestamp: Date.now() + 1,
		});
		manager.appendMessage({
			...assistant("", 100),
			content: [{ type: "toolCall", id: "tc-tail", name: "read", arguments: {} }],
			timestamp: Date.now() + 1,
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tc-tail",
			toolName: "read",
			content: [{ type: "text", text: `TAIL_LOG ${"y".repeat(40_000)}` }],
			details: undefined,
			isError: false,
			timestamp: Date.now() + 2,
		});
		manager.appendMessage(assistant("tail done", 100));
		const evaluation = h.evaluateCompactionTrigger({
			branchEntries: manager.getBranch(),
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});
		expect(evaluation.decision.action).toBe("offload_only");
		const offloaded = await h.attemptCompaction({
			action: "offload_only",
			complete,
			branchEntries: manager.getBranch(),
			outputReserveTokens: 100,
		});
		expect(offloaded.activated).toBe(true);
		expect(h.snapshotStore.getActive("s-trigger")?.compactor.kind).toBe("offload_only");
		expect(h.recallSearch({ query: "", kind: "tool_result", limit: 8 })).toHaveLength(1);
		expect(JSON.stringify(offloaded.messages)).toContain("recall_exact");
		expect(JSON.stringify(offloaded.messages)).not.toContain("y".repeat(1000));
	});

	it("accepts a beneficial offload-only candidate selected by the absolute recovery threshold", async () => {
		const h = new HfCompactionHost({
			sessionId: "s-offload-small-fraction",
			getSystemPrompt: () => "S".repeat(1_000_000),
			config: {
				mode: "full_pipeline",
				complete,
				offloadThresholdBytes: 1000,
				keepRecentToolResults: 0,
			},
		});
		const branch = toolBranch();
		const evaluation = h.evaluateCompactionTrigger({
			branchEntries: branch,
			modelContextLimit: 1_000_000,
			outputReserveTokens: 100,
		});
		expect(evaluation.decision.action).toBe("offload_only");

		const result = await h.attemptCompaction({
			action: "offload_only",
			complete,
			branchEntries: branch,
			outputReserveTokens: 100,
		});
		expect(result.result?.report?.failures).toEqual([]);
		expect(result.activated).toBe(true);
		expect(h.snapshotStore.getActive("s-offload-small-fraction")?.compactor.kind).toBe("offload_only");
	});

	it.each([
		{ mode: "shadow" as const, minTokenGainFraction: -1 },
		{ mode: "full_pipeline" as const, minTokenGainFraction: 2 },
	])("$mode offload rejection/shadow does not publish recall state", async ({ mode, minTokenGainFraction }) => {
		const h = new HfCompactionHost({
			sessionId: `s-offload-${mode}`,
			getSystemPrompt: () => "SYSTEM",
			config: {
				mode,
				complete,
				minTokenGainFraction,
				offloadThresholdBytes: 1000,
				keepRecentToolResults: 0,
			},
		});
		const result = await h.attemptCompaction({
			action: "offload_only",
			complete,
			branchEntries: toolBranch(),
			outputReserveTokens: 100,
		});
		expect(result.activated).toBe(false);
		if (mode === "full_pipeline") {
			expect(result.summaryText).toContain("token-gain: insufficient token gain");
		}
		expect(h.snapshotStore.getActive(`s-offload-${mode}`)).toBeUndefined();
		expect(h.recallSearch({ query: "", kind: "tool_result", limit: 8 })).toHaveLength(0);
	});

	it("AgentSession independently offloads a large tool result below the soft threshold", async () => {
		const h = await createHarness({
			contextWindow: 1_000_000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			baseToolsOverride: { read: hugeLogTool() },
			responses: [
				{ toolCalls: [{ name: "read", args: {} }], usage: { totalTokens: 200 } },
				{ text: "inspected", usage: { totalTokens: 500 } },
			],
			hfCompaction: {
				mode: "full_pipeline",
				complete,
				minTokenGainFraction: -1,
				offloadThresholdBytes: 1000,
				keepRecentToolResults: 0,
			},
		});
		harnesses.push(h);
		await h.session.prompt("inspect the huge log");
		const host = h.session.hfCompactionHost!;
		expect(host.audit.byType("trigger").some((event) => event.details.action === "offload_only")).toBe(true);
		expect(host.recallSearch({ query: "", kind: "tool_result", limit: 8 })).toHaveLength(1);
		const projected = h.session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(projected?.content)).toContain("recall_exact");
		expect(JSON.stringify(projected?.content)).not.toContain("x".repeat(1000));
	});
});
