/**
 * Default-on tests: the high-fidelity subsystem is pi's default compaction.
 * Legacy summary-only compaction is removed; old CompactionEntry items still
 * render when resuming old sessions (read-side compatibility).
 */

import { afterEach, describe, expect, it } from "vitest";
import { getHfCompactionModeFromEnv } from "../../src/core/compaction/subsystem/session-integration.ts";
import { createHarness, createHarnessWithExtensions, type Harness } from "../test-harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

/** Stub handoff that satisfies the compaction summary quality gate. */
const subsystemHandoff = [
	"## Conversation timeline",
	"Subsystem compacted context for the auto-compaction path.",
	"## Current continuation point",
	"Next concrete action: answer the pending user request.",
].join("\n");

describe("default-on compaction", () => {
	it("rejects removed or misspelled explicit modes instead of enabling the default pipeline", () => {
		expect(getHfCompactionModeFromEnv({})).toBeUndefined();
		expect(getHfCompactionModeFromEnv({ PI_HF_COMPACTION: "" })).toBeUndefined();
		expect(() => getHfCompactionModeFromEnv({ PI_HF_COMPACTION: "offload_only" })).toThrow(
			/expected "off" or "full_pipeline"/,
		);
	});

	it("no configuration: auto compaction persists a replacement checkpoint", async () => {
		const h = await createHarness({
			// Two invariants have to hold for threshold compaction to activate and stay feasible: the
			// provider-reported usage reaches the 95% trigger (57,500 >= 0.95 * 60,000), and the provider
			// projection plus the local trigger prompt and output reserve still fit inside the window
			// (57,500 + ~1.4k trigger + 100 reserve <= 60,000). Near the window edge the handoff request
			// itself no longer fits and provider-projection budgeting fails closed with nothing to trim.
			contextWindow: 60_000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: `first answer ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				{ text: `second answer ${"padding ".repeat(150)}`, usage: { totalTokens: 57_500 } },
				{ text: subsystemHandoff }, // single local compaction-item call
				{ text: "post-compaction answer", usage: { totalTokens: 100 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("start");
		await h.session.prompt("continue");
		await h.session.prompt("send the next real request");
		await h.session.waitForIdle();

		// Host exists by default and committed one checkpoint to the main session log.
		const host = h.session.hfCompactionHost;
		expect(host).toBeDefined();
		expect(host!.audit.byType("checkpoint_validated")).toHaveLength(1);
		const checkpoints = h.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({ replacementHistory: expect.any(Array) });
		expect(JSON.stringify(h.faux.contexts)).not.toContain("Verified user directives");
		expect(h.session.getActiveToolNames()).not.toEqual(expect.arrayContaining(["recall_search", "recall_exact"]));
	});

	it("kill switch: compaction.enabled=false disables compaction entirely", async () => {
		const h = await createHarness({
			contextWindow: 3000,
			settings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: "one", usage: { totalTokens: 500 } },
				{ text: "two", usage: { totalTokens: 990 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("a");
		await h.session.prompt("b");
		await h.session.waitForIdle();
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("kill switch: explicit mode off means no host, no compaction", async () => {
		const h = await createHarness({
			contextWindow: 3000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			hfCompaction: { mode: "off" },
			responses: [
				{ text: "one", usage: { totalTokens: 500 } },
				{ text: "two", usage: { totalTokens: 990 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("a");
		await h.session.prompt("b");
		await h.session.waitForIdle();
		expect(h.session.hfCompactionHost).toBeUndefined();
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("extension cancel hook stops the subsystem compaction", async () => {
		const h = await createHarnessWithExtensions({
			contextWindow: 3000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			extensionFactories: [
				{
					path: "<canceler>",
					factory: (pi) => {
						pi.on("session_before_compact", () => ({ cancel: true }));
					},
				},
			],
			responses: [
				{ text: `one ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				{ text: `two ${"padding ".repeat(150)}`, usage: { totalTokens: 2900 } },
				{ text: "continued after cancellation", usage: { totalTokens: 100 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("a");
		await h.session.prompt("b");
		await h.session.prompt("c");
		await h.session.waitForIdle();
		// Legacy-compatible semantics: start is emitted, then an aborted end.
		const ends = h.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(true);
		expect(h.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(0);
	});

	it("extension-provided custom summary is ignored (deprecated): result comes from the subsystem", async () => {
		const h = await createHarnessWithExtensions({
			contextWindow: 60_000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			extensionFactories: [
				{
					path: "<custom-summary>",
					factory: (pi) => {
						pi.on("session_before_compact", () => ({
							compaction: { summary: "EVIL CUSTOM SUMMARY", firstKeptEntryId: "x", tokensBefore: 1 },
						}));
					},
				},
			],
			responses: [
				{ text: `one ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				{ text: `two ${"padding ".repeat(150)}`, usage: { totalTokens: 57_500 } },
				{ text: subsystemHandoff },
				{ text: "post-compaction answer", usage: { totalTokens: 100 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("a");
		await h.session.prompt("b");
		await h.session.prompt("c");
		await h.session.waitForIdle();
		const branch = h.sessionManager.getBranch();
		expect(branch.filter((e) => e.type === "compaction" && e.summary?.includes("EVIL"))).toHaveLength(0);
		expect(JSON.stringify(h.session.messages.map((m) => ("content" in m ? m.content : "")))).not.toContain(
			"EVIL CUSTOM SUMMARY",
		);
		expect(
			h.sessionManager.getBranch().some((entry) => entry.type === "compaction" && entry.replacementHistory),
		).toBe(true);
	});

	it("fails closed when the compacted request cannot fit the window", async () => {
		const h = await createHarness({
			// The history itself no longer fits a compaction request: system + tools + messages +
			// compaction reserve (4k) + the local trigger prompt exceed the 20k window, and there are no
			// tool results to trim. The checkpoint must be rejected instead of sending a request the
			// provider would truncate. Zero usage keeps the provider-projection correction out of play.
			contextWindow: 20_000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: `first answer ${"padding ".repeat(4000)}`, usage: { totalTokens: 0 } },
				{ text: `second answer ${"padding ".repeat(4000)}`, usage: { totalTokens: 0 } },
				{ text: "uncompacted answer", usage: { totalTokens: 0 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("start");
		await h.session.prompt("continue");
		await h.session.prompt("send the next real request");
		await h.session.waitForIdle();

		expect(h.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		const ends = h.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0].errorMessage).toContain("cannot fit the model context");
	});

	it("overflow recovery: subsystem compaction then retried turn completes", async () => {
		const h = await createHarness({
			contextWindow: 20_000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: `first ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				// Recoverable length stop on the second turn: output truncated → overflow recovery path.
				{ text: `truncated ${"padding ".repeat(100)}`, stopReason: "length", usage: { totalTokens: 990 } },
				{ text: subsystemHandoff },
				{ text: "recovered final answer", usage: { totalTokens: 120 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("start");
		await h.session.waitForIdle();
		await h.session.prompt("second turn");
		await h.session.waitForIdle();
		expect(
			h.sessionManager.getBranch().some((entry) => entry.type === "compaction" && entry.replacementHistory),
		).toBe(true);
		const last = h.session.messages[h.session.messages.length - 1];
		if (last.role !== "assistant") throw new Error("expected assistant");
		expect(JSON.stringify(last.content)).toContain("recovered final answer");
	});
});
