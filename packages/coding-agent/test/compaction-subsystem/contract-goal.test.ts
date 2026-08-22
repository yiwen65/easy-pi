/**
 * Contract goal derivation: the pinned goal must reflect the CURRENT task at
 * compaction time, not necessarily the session's first user message.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { CompleteFn } from "../../src/core/compaction/subsystem/types.ts";
import { createHarness, type Harness } from "../test-harness.ts";

const fauxComplete: CompleteFn = async (req) => ({
	text: req.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "narrative",
	stopReason: "stop",
	usage: { input: 10, output: 10 },
});

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

describe("contract goal derivation", () => {
	it("multi-task sessions pin the CURRENT task, not the first message", async () => {
		const h = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 40 } },
			hfCompaction: { mode: "structured_compaction", complete: fauxComplete, minTokenGainFraction: -1 },
			responses: [
				{ text: `poem answer ${"padding ".repeat(100)}`, usage: { totalTokens: 300 } },
				{ text: `parser answer ${"padding ".repeat(100)}`, usage: { totalTokens: 500 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("write a poem about autumn leaves");
		await h.session.waitForIdle();
		await h.session.prompt("now fix the tokenizer bug in /src/parser.ts");
		await h.session.waitForIdle();

		await h.session.compact();
		const goal = h.session.getTaskContract()?.goal ?? "";
		expect(goal).toContain("fix the tokenizer bug");
		expect(goal).not.toContain("poem");
	});

	it("slash commands and trivial messages are skipped as goal sources", async () => {
		const h = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 40 } },
			hfCompaction: { mode: "structured_compaction", complete: fauxComplete, minTokenGainFraction: -1 },
			// Root harness cycles responses; content is irrelevant to goal derivation.
			responses: [
				{ text: `r1 ${"padding ".repeat(100)}`, usage: { totalTokens: 500 } },
				{ text: `r2 ${"padding ".repeat(100)}`, usage: { totalTokens: 500 } },
				{ text: `r3 ${"padding ".repeat(100)}`, usage: { totalTokens: 500 } },
			],
		});
		harnesses.push(h);
		// A slash command first, then a trivial ack, then the real task.
		await h.session.prompt("/mode");
		await h.session.waitForIdle();
		await h.session.prompt("ok");
		await h.session.waitForIdle();
		await h.session.prompt("migrate the auth handler to v2 endpoints");
		await h.session.waitForIdle();

		await h.session.compact();
		const goal = h.session.getTaskContract()?.goal ?? "";
		expect(goal).toContain("migrate the auth handler");
		expect(goal).not.toContain("/mode");
	});

	it("falls back to a neutral placeholder when no substantive user message exists", async () => {
		const h = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 40 } },
			hfCompaction: { mode: "structured_compaction", complete: fauxComplete, minTokenGainFraction: -1 },
			responses: [{ text: `ok ${"padding ".repeat(100)}`, usage: { totalTokens: 500 } }],
		});
		harnesses.push(h);
		await h.session.prompt("/mode");
		await h.session.waitForIdle();
		await h.session.compact();
		const goal = h.session.getTaskContract()?.goal ?? "";
		expect(goal).not.toContain("/mode");
		expect(goal.length).toBeGreaterThan(0);
	});

	it("an explicitly set contract goal always wins over auto-derivation", async () => {
		const h = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 40 } },
			hfCompaction: { mode: "structured_compaction", complete: fauxComplete, minTokenGainFraction: -1 },
			responses: [{ text: `ok ${"padding ".repeat(100)}`, usage: { totalTokens: 500 } }],
		});
		harnesses.push(h);
		h.session.setTaskContract({ goal: "explicit user-declared goal", constraints: [] });
		await h.session.prompt("some random question");
		await h.session.waitForIdle();
		await h.session.compact();
		expect(h.session.getTaskContract()?.goal).toBe("explicit user-declared goal");
	});
});
