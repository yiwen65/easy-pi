/**
 * Shadow flag wiring through the AgentSession host: candidates are generated
 * and audited, the live context continues on the legacy path unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { CompleteFn } from "../../src/core/compaction/subsystem/types.ts";
import { createHarness, type Harness } from "../test-harness.ts";

const fauxComplete: CompleteFn = async (req) => ({
	text: req.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "shadow narrative",
	stopReason: "stop",
	usage: { input: 10, output: 10 },
});

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

describe("shadow mode via AgentSession (post-removal)", () => {
	it("shadow generates auditable candidates; live context stays untouched (no legacy path anymore)", async () => {
		const h = await createHarness({
			contextWindow: 1000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: `answer one ${"padding ".repeat(120)}`, usage: { totalTokens: 500 } },
				{ text: `answer two ${"padding ".repeat(120)}`, usage: { totalTokens: 950 } },
				{ text: "## Goal\nlegacy summary" }, // legacy summarizer call
			],
			hfCompaction: { mode: "shadow", complete: fauxComplete, minTokenGainFraction: 0, keepRecentTokens: 40 },
		});
		harnesses.push(h);
		await h.session.prompt("start");
		await h.session.prompt("continue");
		await h.session.waitForIdle();

		const host = h.session.hfCompactionHost!;
		// Shadow candidate was generated, validated, audited.
		expect(host.audit.byType("shadow_candidate").length).toBeGreaterThan(0);
		// Never activated.
		expect(host.snapshotStore.getActive(h.session.sessionId)).toBeUndefined();
		// Legacy path is removed: no compaction entry, context unchanged.
		expect(h.sessionManager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		// Both turns completed normally.
		expect(h.session.messages.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(2);
	});
});
