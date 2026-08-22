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

	it("runs only the requested manual compaction when the previous turn crossed the threshold", async () => {
		let markSecondResponseStarted = () => {};
		const secondResponseStarted = new Promise<void>((resolve) => {
			markSecondResponseStarted = resolve;
		});
		let releaseSecondResponse = () => {};
		const secondResponseReleased = new Promise<void>((resolve) => {
			releaseSecondResponse = resolve;
		});

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 999, keepRecentTokens: 2 } },
			tools: [createNoopTool()],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						// Custom summaries are deprecated and ignored post-removal.
						compaction: { summary: "extension summary", firstKeptEntryId: "x", tokensBefore: 1 },
					}));
				},
			],
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async () => {
				markSecondResponseStarted();
				await secondResponseReleased;
				return fauxAssistantMessage("second response");
			},
			// Subsystem compactor calls during the manual compaction (distill + extract + narrative).
			fauxAssistantMessage("Distilled goal sentence."),
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			fauxAssistantMessage("manual narrative"),
		]);

		const promptPromise = harness.session.prompt("Run the tool, then continue responding.");
		await secondResponseStarted;

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).resolves.toMatchObject({
			summary: expect.stringContaining("[high-fidelity snapshot"),
		});
		releaseSecondResponse();
		await Promise.all([promptPromise, compactExpectation]);

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["manual"]);
		expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(["manual"]);
		// No legacy compaction entry is written anymore.
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});
});
