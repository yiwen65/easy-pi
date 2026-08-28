import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("dbg2", () => {
	it("trace successful overflow", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			hfCompaction: { mode: "full_pipeline" },
		});
		harness.setResponses([
			fauxAssistantMessage("completed answer"),
			fauxAssistantMessage("Distilled goal sentence."),
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			fauxAssistantMessage("overflow narrative"),
		]);
		await harness.session.prompt("hello");
		console.log("calls:", harness.faux.state.callCount);
		const host = (
			harness.session as unknown as {
				hfCompactionHost?: { audit: { list(): { type: string; details: Record<string, unknown> }[] } };
			}
		).hfCompactionHost;
		for (const a of host?.audit.list() ?? []) console.log(a.type, JSON.stringify(a.details).slice(0, 200));
		harness.cleanup();
		expect(true).toBe(true);
	});
});
