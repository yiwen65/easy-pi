import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const DECISION = {
	action: "compact" as const,
	reasons: ["test"],
	triggerTokens: 950,
	overflowRecovery: false,
};

type SessionWithCompactionInternals = {
	_runAutoCompaction: (
		reason: "overflow" | "threshold",
		willRetry: boolean,
		decision: typeof DECISION,
	) => Promise<boolean>;
};

interface RecordedCompactionEvent {
	type: "session_before_compact" | "session_compact";
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
}

function recordingExtension(recorded: RecordedCompactionEvent[]): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", async (event) => {
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
			return {
				compaction: {
					summary: "summary from extension",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			};
		});
		pi.on("session_compact", async (event) => {
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
		});
	};
}

async function createCompactionHarness(recorded: RecordedCompactionEvent[]): Promise<Harness> {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
		extensionFactories: [recordingExtension(recorded)],
		// Tiny wiring sessions can never beat the token-gain gate (snapshot zone
		// overhead exceeds savings at this scale); disable it explicitly here.
		hfCompaction: { mode: "full_pipeline" },
	});
	harness.setResponses([
		fauxAssistantMessage("one ".repeat(200)),
		fauxAssistantMessage("two ".repeat(200)),
		// Single-pass compaction item.
		fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
	]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	return harness;
}

describe("issue #5217 compaction reason on extension events", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reports manual reason for compact()", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);

		await harness.session.compact();

		expect(recorded).toEqual([
			{ type: "session_before_compact", reason: "manual", willRetry: false },
			{ type: "session_compact", reason: "manual", willRetry: false },
		]);
	});

	it("reports threshold reason for auto-compaction", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false, DECISION);

		expect(recorded).toEqual([
			{ type: "session_before_compact", reason: "threshold", willRetry: false },
			{ type: "session_compact", reason: "threshold", willRetry: false },
		]);
	});

	it("reports overflow reason and willRetry for overflow recovery", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("overflow", true, DECISION);

		expect(recorded).toEqual([
			{ type: "session_before_compact", reason: "overflow", willRetry: true },
			{ type: "session_compact", reason: "overflow", willRetry: true },
		]);
	});
});
