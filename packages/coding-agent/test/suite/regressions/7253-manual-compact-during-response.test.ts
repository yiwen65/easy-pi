import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createNoopTool(): AgentTool {
	return {
		name: "noop",
		label: "No-op",
		description: "Return immediately",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
	};
}

describe("issue #7253: manual compaction during an active response", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("lets requested manual compaction supersede an automatic provider-boundary attempt", async () => {
		let markSecondResponseStarted = () => {};
		const secondResponseStarted = new Promise<void>((resolve) => {
			markSecondResponseStarted = resolve;
		});
		let releaseSecondResponse = () => {};
		const secondResponseReleased = new Promise<void>((resolve) => {
			releaseSecondResponse = resolve;
		});

		const harness = await createHarness({
			// reserveTokens keeps the auto-compaction threshold at ~1 token so the provider-boundary
			// attempt fires immediately, while the window stays large enough to hold the local
			// compaction request (system + tools + history + ~1.3k-token trigger).
			models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 19_999, keepRecentTokens: 2 } },
			tools: [createNoopTool()],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						// Custom summaries are deprecated and ignored post-removal.
						compaction: { summary: "extension summary", firstKeptEntryId: "x", tokensBefore: 1 },
					}));
				},
			],
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async () => {
				markSecondResponseStarted();
				await secondResponseReleased;
				return fauxAssistantMessage("second response");
			},
			// The subsystem makes one local compaction-item call during manual compaction.
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			fauxAssistantMessage("manual narrative"),
		]);

		const promptPromise = harness.session.prompt("Run the tool, then continue responding.");
		await secondResponseStarted;

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).resolves.toMatchObject({
			summary: expect.stringContaining("[compaction checkpoint created]"),
		});
		releaseSecondResponse();
		await Promise.all([promptPromise, compactExpectation]);

		const starts = harness.eventsOfType("compaction_start");
		const ends = harness.eventsOfType("compaction_end");
		expect(starts.filter((event) => event.reason === "manual")).toHaveLength(1);
		expect(starts.at(-1)?.reason).toBe("manual");
		expect(starts.slice(0, -1).every((event) => event.reason === "threshold")).toBe(true);
		expect(ends.some((event) => event.reason === "threshold" && event.aborted)).toBe(true);
		expect(ends.at(-1)).toMatchObject({ reason: "manual", aborted: false });
		const entries = harness.sessionManager.getEntries();
		const abortedResponseIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted",
		);
		const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
		expect(abortedResponseIndex).toBeGreaterThan(-1);
		expect(compactionIndex).toBeGreaterThan(abortedResponseIndex);
		expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
});
