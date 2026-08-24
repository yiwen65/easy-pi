import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { HfCompactionHost } from "../../src/core/compaction/subsystem/session-integration.ts";
import type { CompleteFn } from "../../src/core/compaction/subsystem/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const complete: CompleteFn = async (request) => ({
	text: request.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "narrative",
	stopReason: "stop",
});

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function branch() {
	const manager = SessionManager.inMemory();
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Inspect the compacted build log context" }],
		timestamp: Date.now() - 30,
	});
	manager.appendMessage({
		...assistant(""),
		content: [{ type: "toolCall" as const, id: "tc-1", name: "read", arguments: { path: "build.log" } }],
		timestamp: Date.now() - 20,
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "read",
		content: [{ type: "text", text: `BUILD_LOG ${"x".repeat(40_000)}` }],
		details: undefined,
		isError: false,
		timestamp: Date.now() - 10,
	});
	manager.appendMessage(assistant("Build log inspected"));
	return manager.getBranch();
}

function host() {
	return new HfCompactionHost({
		sessionId: "s-context-inspection",
		getSystemPrompt: () => "PRIVATE SYSTEM PROMPT",
		getToolsTokenEstimate: () => 321,
		config: {
			mode: "full_pipeline",
			minTokenGainFraction: -1,
			offloadThresholdBytes: 1000,
			keepRecentToolResults: 0,
		},
	});
}

describe("HfCompactionHost context inspection", () => {
	it("returns no projection before a snapshot activates", () => {
		const h = host();
		expect(h.inspectActiveContext()).toBeUndefined();
	});

	it("builds a redacted or full read-only projection from the active snapshot", async () => {
		const h = host();
		const branchEntries = branch();
		const outcome = await h.attemptCompaction({
			action: "offload_only",
			complete,
			branchEntries,
		});
		expect(outcome.activated).toBe(true);

		const stateBefore = {
			snapshotVersion: h.snapshotStore.getActive("s-context-inspection")?.snapshotVersion,
			events: h.eventLog.all("s-context-inspection").length,
			recall: h.recallCatalog.entries().length,
		};
		const inspection = h.inspectActiveContext();

		expect(inspection).toMatchObject({
			mode: "full_pipeline",
			snapshotVersion: 1,
			projectionKind: "offload_only",
			baseEventSeq: 0,
			toolsTokenEstimate: 321,
		});
		expect(inspection?.systemPrompt).toBeUndefined();
		expect(inspection?.tokenStats.total).toBeGreaterThan(0);
		expect(inspection?.sections.map((section) => section.zone)).toEqual(
			expect.arrayContaining(["contract", "snapshot", "recallGuide", "recentTail"]),
		);
		expect(inspection?.sections.find((section) => section.zone === "recentTail")?.text).toContain("[offloaded");
		expect(inspection?.recallEntries.length).toBeGreaterThan(0);

		const full = h.inspectActiveContext({ includeSystemPrompt: true });
		expect(full?.systemPrompt).toEqual({ text: "PRIVATE SYSTEM PROMPT", tokens: full?.tokenStats.system });
		expect({
			snapshotVersion: h.snapshotStore.getActive("s-context-inspection")?.snapshotVersion,
			events: h.eventLog.all("s-context-inspection").length,
			recall: h.recallCatalog.entries().length,
		}).toEqual(stateBefore);
	});
});
