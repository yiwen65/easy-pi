import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, assert, describe, expect, it } from "vitest";
import type { CompactionResult } from "../../../src/core/compaction/index.ts";
import type { SessionBeforeCompactEvent, SessionCompactEvent } from "../../../src/core/extensions/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const MODERN_HANDOFF = [
	"## Conversation timeline",
	"The user requested a summary of the completed work, then asked to continue the handoff.",
	"## Current continuation point",
	"The work is complete; report the next action from this model-generated handoff.",
].join("\n");

// These cases replace real-provider tests that expected the deprecated extension result to be adopted.
const EXTENSION_OVERRIDES = [
	{ name: "legacy cut metadata", summary: "Custom summary from extension", tokensBefore: undefined },
	{ name: "modified token count", summary: "Custom summary with modified values", tokensBefore: 999 },
];

describe("compaction extension summary contract", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(EXTENSION_OVERRIDES)("ignores the deprecated extension summary with $name", async (override) => {
		const events: (SessionBeforeCompactEvent | SessionCompactEvent)[] = [];
		const returnedCompactions: CompactionResult[] = [];
		const compactionRequests: Context[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						events.push(event);
						if (!event.preparation) return;
						const compaction: CompactionResult = {
							summary: override.summary,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: override.tokensBefore ?? event.preparation.tokensBefore,
						};
						returnedCompactions.push(compaction);
						return { compaction };
					});
					pi.on("session_compact", (event) => {
						events.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first completed step ".repeat(100)),
			fauxAssistantMessage("second completed step ".repeat(100)),
			(context) => {
				compactionRequests.push(context);
				return fauxAssistantMessage(MODERN_HANDOFF);
			},
		]);
		await harness.session.prompt("Summarize the completed work.");
		await harness.session.prompt("Continue the handoff.");

		const result = await harness.session.compact();

		expect(events.map((event) => event.type)).toEqual(["session_before_compact", "session_compact"]);
		const beforeEvent = events[0];
		assert(beforeEvent.type === "session_before_compact");
		assert(beforeEvent.preparation, "This fixture must actually return the deprecated extension override");
		expect(beforeEvent).toMatchObject({ reason: "manual", willRetry: false });
		expect(returnedCompactions).toEqual([
			{
				summary: override.summary,
				firstKeptEntryId: beforeEvent.preparation.firstKeptEntryId,
				tokensBefore: override.tokensBefore ?? beforeEvent.preparation.tokensBefore,
			},
		]);
		// Returning an override must not bypass the modern compaction model request.
		expect(compactionRequests).toHaveLength(1);
		expect(getMessageText(compactionRequests[0].messages.at(-1))).toContain("<local_compaction_trigger>");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(result.summary).toContain("[compaction checkpoint created]");
		expect(result.summary).toContain(MODERN_HANDOFF);
		expect(result.summary).not.toContain(override.summary);
		expect(result.firstKeptEntryId).toBe("");
		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(result.estimatedTokensAfter).toBeLessThan(result.tokensBefore);
		if (override.tokensBefore !== undefined) expect(result.tokensBefore).not.toBe(override.tokensBefore);

		const checkpoints = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(checkpoints).toHaveLength(1);
		const checkpoint = checkpoints[0];
		expect(checkpoint.summary).toBeUndefined();
		expect(checkpoint.firstKeptEntryId).toBeUndefined();
		expect(checkpoint.tokensBefore).toBe(result.tokensBefore);
		expect(checkpoint.replacementHistory).toEqual([
			expect.objectContaining({
				role: "compactionSummary",
				summary: MODERN_HANDOFF,
				tokensBefore: result.tokensBefore,
				estimatedTokensAfter: result.estimatedTokensAfter,
			}),
		]);
		expect(harness.session.messages).toEqual(checkpoint.replacementHistory);
		expect(events[1]).toEqual({
			type: "session_compact",
			compactionEntry: checkpoint,
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		});
	});
});
