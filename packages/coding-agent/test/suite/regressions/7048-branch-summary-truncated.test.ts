import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function seedBranch(harness: Harness): { targetId: string; oldLeafId: string } {
	harness.sessionManager.appendMessage({ role: "user", content: "first request", timestamp: 1 });
	const targetId = harness.sessionManager.appendMessage(fauxAssistantMessage("first reply", { timestamp: 2 }));
	harness.sessionManager.appendMessage({ role: "user", content: "abandoned branch work", timestamp: 3 });
	const oldLeafId = harness.sessionManager.appendMessage(fauxAssistantMessage("abandoned reply", { timestamp: 4 }));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return { targetId, oldLeafId };
}

describe("issue #7048 truncated branch summaries", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("rejects a length-limited summary without persisting it or changing history", async () => {
		harness = await createHarness();
		const { targetId, oldLeafId } = seedBranch(harness);
		const originalEntries = harness.sessionManager.getEntries();
		const originalBranch = harness.sessionManager.getBranch();
		const originalContext = harness.sessionManager.buildSessionContext();
		const originalMessages = [...harness.session.messages];
		harness.setResponses([fauxAssistantMessage("partial summar", { stopReason: "length" })]);

		await expect(harness.session.navigateTree(targetId, { summarize: true })).rejects.toThrow(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "branch_summary")).toHaveLength(0);
		expect(harness.sessionManager.getLeafId()).toBe(oldLeafId);
		expect(harness.sessionManager.getEntries()).toEqual(originalEntries);
		expect(harness.sessionManager.getBranch()).toEqual(originalBranch);
		expect(harness.sessionManager.buildSessionContext()).toEqual(originalContext);
		expect(harness.session.messages).toEqual(originalMessages);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("still persists a completed branch summary at the navigation target", async () => {
		harness = await createHarness();
		const { targetId } = seedBranch(harness);
		harness.setResponses([fauxAssistantMessage("completed branch summary")]);

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry?.type).toBe("branch_summary");
		expect(result.summaryEntry?.summary).toContain("completed branch summary");
		expect(result.summaryEntry?.parentId).toBe(targetId);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "branch_summary")).toHaveLength(1);
		expect(harness.sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("still cancels an aborted summary without changing the branch", async () => {
		harness = await createHarness();
		const { targetId, oldLeafId } = seedBranch(harness);
		const originalEntries = harness.sessionManager.getEntries();
		const originalMessages = [...harness.session.messages];
		harness.setResponses([fauxAssistantMessage("partial summar", { stopReason: "aborted" })]);

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result).toEqual({ cancelled: true, aborted: true });
		expect(harness.sessionManager.getEntries()).toEqual(originalEntries);
		expect(harness.sessionManager.getLeafId()).toBe(oldLeafId);
		expect(harness.session.messages).toEqual(originalMessages);
		expect(harness.session.isCompacting).toBe(false);
	});
});
