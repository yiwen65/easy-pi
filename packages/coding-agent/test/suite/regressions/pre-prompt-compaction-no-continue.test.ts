import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("pre-prompt compaction regression", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts length-stop overflow before a new prompt without continuing from an assistant message", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					// Hook fires; custom summaries are deprecated and ignored post-removal.
					pi.on("session_before_compact", async () => undefined);
				},
			],
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous prompt" }],
			timestamp: now - 1000,
		});
		const lengthStopAssistant: AssistantMessage = {
			...fauxAssistantMessage("length-stop assistant response", { stopReason: "length", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		harness.sessionManager.appendMessage(lengthStopAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			fauxAssistantMessage("pre-prompt narrative"),
			fauxAssistantMessage("answered next prompt"),
			// Post-answer compaction (threshold at this tiny window) also runs the compactor.
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			fauxAssistantMessage("post-answer narrative"),
		]);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");

		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();

		expect(continueSpy).not.toHaveBeenCalled();
		// The pre-prompt overflow compaction (willRetry=true); a post-answer
		// threshold compaction may also fire in this tiny-window setup.
		const ends = harness.eventsOfType("compaction_end");
		expect(ends.some((e) => e.reason === "overflow" && e.willRetry === true && !e.aborted)).toBe(true);
		// The new prompt was sent and answered; its text may live in the compacted zone.
		expect(harness.session.getLastAssistantText()).toBe("answered next prompt");
		// extraction + narrative per compaction (pre-prompt and post-answer threshold) + the new prompt
		expect(harness.faux.state.callCount).toBe(5);
	});
});
