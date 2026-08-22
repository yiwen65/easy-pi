/**
 * Default-on tests: the high-fidelity subsystem is pi's default compaction.
 * Legacy summary-only compaction is removed; old CompactionEntry items still
 * render when resuming old sessions (read-side compatibility).
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createHarnessWithExtensions, type Harness } from "../test-harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

const EXTRACT_JSON = JSON.stringify({
	facts: [{ text: "user asked about the parser", kind: "fact", sourceEventIds: [] }],
	decisions: [],
	nextActions: [],
});

describe("default-on compaction", () => {
	it("no configuration: auto compaction runs the subsystem and appends no legacy entry", async () => {
		const h = await createHarness({
			contextWindow: 1000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: `first answer ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				{ text: `second answer ${"padding ".repeat(150)}`, usage: { totalTokens: 950 } },
				{ text: EXTRACT_JSON }, // subsystem extractor call (through the same faux stream)
				{ text: "Subsystem narrative." }, // subsystem narrative call
			],
		});
		harnesses.push(h);
		await h.session.prompt("start");
		await h.session.prompt("continue");
		await h.session.waitForIdle();

		// Host exists by default and activated a snapshot.
		const host = h.session.hfCompactionHost;
		expect(host).toBeDefined();
		expect(host!.snapshotStore.getActive(h.session.sessionId)).toBeDefined();
		expect(host!.audit.byType("compact_committed")).toHaveLength(1);
		// No legacy summary entry was written.
		expect(h.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(0);
		// Context rebuilt with pinned contract zone.
		const first = h.session.messages[0];
		if (first.role !== "user") throw new Error("expected pinned user message");
		expect(JSON.stringify(first.content)).toContain("Task Contract");
	});

	it("kill switch: compaction.enabled=false disables compaction entirely", async () => {
		const h = await createHarness({
			contextWindow: 1000,
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
		expect(h.session.hfCompactionHost?.snapshotStore.getActive(h.session.sessionId)).toBeUndefined();
	});

	it("kill switch: explicit mode off means no host, no compaction", async () => {
		const h = await createHarness({
			contextWindow: 1000,
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
			contextWindow: 1000,
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
				{ text: `two ${"padding ".repeat(150)}`, usage: { totalTokens: 950 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("a");
		await h.session.prompt("b");
		await h.session.waitForIdle();
		// Legacy-compatible semantics: start is emitted, then an aborted end.
		const ends = h.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(true);
		expect(h.session.hfCompactionHost?.snapshotStore.getActive(h.session.sessionId)).toBeUndefined();
		expect(h.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(0);
	});

	it("extension-provided custom summary is ignored (deprecated): result comes from the subsystem", async () => {
		const h = await createHarnessWithExtensions({
			contextWindow: 1000,
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
				{ text: `two ${"padding ".repeat(150)}`, usage: { totalTokens: 950 } },
				{ text: EXTRACT_JSON },
				{ text: "Subsystem narrative." },
			],
		});
		harnesses.push(h);
		await h.session.prompt("a");
		await h.session.prompt("b");
		await h.session.waitForIdle();
		const branch = h.sessionManager.getBranch();
		expect(branch.filter((e) => e.type === "compaction" && e.summary.includes("EVIL"))).toHaveLength(0);
		expect(JSON.stringify(h.session.messages.map((m) => ("content" in m ? m.content : "")))).not.toContain(
			"EVIL CUSTOM SUMMARY",
		);
		expect(h.session.hfCompactionHost!.snapshotStore.getActive(h.session.sessionId)).toBeDefined();
	});

	it("overflow recovery: subsystem compaction then retried turn completes", async () => {
		const h = await createHarness({
			contextWindow: 1000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: `first ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				// Recoverable length stop on the second turn: output truncated → overflow recovery path.
				{ text: `truncated ${"padding ".repeat(100)}`, stopReason: "length", usage: { totalTokens: 990 } },
				{ text: EXTRACT_JSON },
				{ text: "Narrative after overflow." },
				{ text: "recovered final answer", usage: { totalTokens: 120 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("start");
		await h.session.waitForIdle();
		await h.session.prompt("second turn");
		await h.session.waitForIdle();
		const host = h.session.hfCompactionHost!;
		expect(host.snapshotStore.getActive(h.session.sessionId)).toBeDefined();
		const last = h.session.messages[h.session.messages.length - 1];
		if (last.role !== "assistant") throw new Error("expected assistant");
		expect(JSON.stringify(last.content)).toContain("recovered final answer");
	});
});
