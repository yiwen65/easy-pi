import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession canonical persistence ordering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("persists message_end before notifying subscribers; a throwing subscriber cannot prevent persistence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		let assistantPersistedAtNotify = false;
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				assistantPersistedAtNotify = harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "message" && entry.message.role === "assistant");
				throw new Error("subscriber boom");
			}
		});

		// The subscriber error still surfaces (the run fails), but the canonical
		// entry was committed before notification and survives intact.
		await expect(harness.session.prompt("hi")).rejects.toThrow("subscriber boom");

		expect(assistantPersistedAtNotify).toBe(true);
		// The canonical user + assistant entries survive; the loop-level failure
		// message may also be persisted afterwards, which is fine.
		const entries = harness.sessionManager.getEntries();
		const texts = entries.filter((entry) => entry.type === "message").map((entry) => JSON.stringify(entry));
		expect(texts.some((text) => text.includes("hi"))).toBe(true);
		expect(texts.some((text) => text.includes("hello"))).toBe(true);
	});
});
