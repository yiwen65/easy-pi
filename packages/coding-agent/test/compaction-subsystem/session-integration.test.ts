/**
 * CCTX-080 integration tests: AgentSession wiring for the high-fidelity
 * compaction subsystem behind feature flags. Faux providers only.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { CompleteFn } from "../../src/core/compaction/subsystem/types.ts";
import { createHarness, type Harness } from "../test-harness.ts";

const GOOD_EXTRACTION = JSON.stringify({ facts: [], decisions: [], nextActions: [] });

/** Faux compactor LLM: valid extraction JSON for schema requests, prose otherwise. */
const fauxCompactorComplete: CompleteFn = async (req) => ({
	text: req.responseSchema ? GOOD_EXTRACTION : "Progress narrative.",
	stopReason: "stop",
	usage: { input: 10, output: 10 },
});

const failingCompactorComplete: CompleteFn = async () => {
	throw new Error("compactor model unavailable");
};

function bigLogTool(): AgentTool {
	return {
		name: "biglog",
		label: "Big Log",
		description: "Returns a large log",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text" as const, text: `BUILD LOG ${"line of output\n".repeat(400)}` }],
			details: undefined,
		}),
	};
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

async function makeHarness(options: Parameters<typeof createHarness>[0]): Promise<Harness> {
	const h = await createHarness(options);
	harnesses.push(h);
	return h;
}

describe("HfCompaction integration (explicit off)", () => {
	it("mode off: no host, no compaction, legacy behavior absent too (removed)", async () => {
		const h = await makeHarness({
			hfCompaction: { mode: "off" },
			contextWindow: 1000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: `first answer ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				{ text: `second answer ${"padding ".repeat(150)}`, usage: { totalTokens: 990 } },
			],
		});
		await h.session.prompt("hello");
		await h.session.prompt("again");
		await h.session.waitForIdle();
		expect(h.session.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
		expect(h.session.hfCompactionHost).toBeUndefined();
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(0);
	});
});

describe("HfCompaction integration (structured_compaction)", () => {
	it("threshold auto-compaction goes through the subsystem: pinned contract + snapshot, raw JSONL untouched by legacy summaries", async () => {
		const h = await makeHarness({
			contextWindow: 1000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			baseToolsOverride: { biglog: bigLogTool() },
			responses: [
				{ toolCalls: [{ name: "biglog", args: {} }], usage: { totalTokens: 400 } },
				{ toolCalls: [{ name: "biglog", args: {} }], usage: { totalTokens: 700 } },
				{ text: "both logs analyzed", usage: { totalTokens: 950 } }, // crosses 1000-100 threshold
				{ text: "next answer", usage: { totalTokens: 200 } },
			],
			hfCompaction: {
				mode: "structured_compaction",
				complete: fauxCompactorComplete,
				keepRecentTokens: 100,
				minTokenGainFraction: 0,
				offloadThresholdBytes: 500,
				keepRecentToolResults: 0,
			},
		});
		await h.session.prompt("analyze the build log");
		await h.session.waitForIdle();

		const host = h.session.hfCompactionHost;
		expect(host).toBeDefined();
		// Subsystem compaction activated a snapshot.
		expect(host!.snapshotStore.getActive(h.session.sessionId)).toBeDefined();
		expect(host!.audit.byType("compact_committed").length).toBe(1);
		// Legacy summary-only compaction entry was NOT written; raw messages all persist.
		const entries = h.sessionManager.getBranch();
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
		expect(entries.filter((e) => e.type === "message").length).toBeGreaterThanOrEqual(3);
		// The rebuilt context starts with the pinned contract zone containing the goal.
		const first = h.session.messages[0];
		if (first.role !== "user") throw new Error("expected pinned user message");
		const text = typeof first.content === "string" ? first.content : "";
		expect(text).toContain("Task Contract");
		expect(text).toContain("analyze the build log");
		// Session continues to work after subsystem compaction.
		await h.session.prompt("continue");
		await h.session.waitForIdle();
		expect(h.session.messages[h.session.messages.length - 1].role).toBe("assistant");
	});

	it("subsystem failure fails closed: no snapshot, no legacy entry, session intact", async () => {
		const h = await makeHarness({
			contextWindow: 1000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: `first answer ${"padding ".repeat(120)}`, usage: { totalTokens: 500 } },
				{ text: `second answer ${"padding ".repeat(120)} pushing us over`, usage: { totalTokens: 950 } },
			],
			hfCompaction: {
				mode: "structured_compaction",
				complete: failingCompactorComplete,
				minTokenGainFraction: 0,
			},
		});
		await h.session.prompt("start");
		await h.session.prompt("continue");
		await h.session.waitForIdle();
		// Fail closed: no subsystem snapshot, and no legacy entry either (path removed).
		expect(h.session.hfCompactionHost?.snapshotStore.getActive(h.session.sessionId)).toBeUndefined();
		expect(h.sessionManager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		// The session itself is intact: both turns completed, messages present.
		expect(h.session.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
		// The rejection is observable as a failed compaction event.
		expect(h.eventsOfType("compaction_end").some((e) => e.errorMessage?.includes("Compaction rejected"))).toBe(true);
	});

	it("manual compact() uses the subsystem and keeps exact recall available for offloaded content", async () => {
		const h = await makeHarness({
			contextWindow: 128000,
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 60 } },
			baseToolsOverride: { biglog: bigLogTool() },
			responses: [
				{ toolCalls: [{ name: "biglog", args: {} }], usage: { totalTokens: 300 } },
				{ toolCalls: [{ name: "biglog", args: {} }], usage: { totalTokens: 320 } },
				{ text: "done analyzing", usage: { totalTokens: 350 } },
			],
			hfCompaction: {
				mode: "full_pipeline",
				complete: fauxCompactorComplete,
				minTokenGainFraction: 0,
				offloadThresholdBytes: 500,
				keepRecentToolResults: 0,
			},
		});
		await h.session.prompt("check the log");
		await h.session.waitForIdle();

		const result = await h.session.compact();
		expect(result.summary).toContain("snapshot");
		const host = h.session.hfCompactionHost!;
		const active = host.snapshotStore.getActive(h.session.sessionId);
		expect(active).toBeDefined();
		expect(active!.narrative).toBe("Progress narrative.");

		// The big tool result was offloaded and is exactly recallable by stable ID.
		const entries = host.recallCatalog.entries();
		expect(entries.length).toBeGreaterThan(0);
		const recalled = host.recallExact(entries[0].refId);
		expect(recalled).toContain("BUILD LOG");
	});
});

describe("HfCompaction integration (offload_only)", () => {
	it("offloads big tool results without any LLM call and without dropping events", async () => {
		let llmCalls = 0;
		const countingComplete: CompleteFn = async (req) => {
			llmCalls += 1;
			return fauxCompactorComplete(req);
		};
		const h = await makeHarness({
			contextWindow: 1000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			baseToolsOverride: { biglog: bigLogTool() },
			responses: [
				{ toolCalls: [{ name: "biglog", args: {} }], usage: { totalTokens: 500 } },
				{ toolCalls: [{ name: "biglog", args: {} }], usage: { totalTokens: 700 } },
				{ text: "analysis", usage: { totalTokens: 950 } },
			],
			hfCompaction: {
				mode: "offload_only",
				complete: countingComplete,
				minTokenGainFraction: 0,
				offloadThresholdBytes: 500,
				keepRecentToolResults: 0,
			},
		});
		await h.session.prompt("run the log tool");
		await h.session.waitForIdle();
		const host = h.session.hfCompactionHost!;
		// Offload happened; no extraction/narrative LLM call was made.
		expect(host.recallCatalog.entries().length).toBeGreaterThan(0);
		expect(llmCalls).toBe(0);
		// Raw events are all still in the event log.
		expect(host.eventLog.all(h.session.sessionId).length).toBeGreaterThanOrEqual(4);
	});
});
