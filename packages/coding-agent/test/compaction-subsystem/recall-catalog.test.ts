import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "../../src/core/compaction/subsystem/artifact-store.ts";
import { RecallCatalog } from "../../src/core/compaction/subsystem/recall-catalog.ts";

function setup(tenant = "t-1") {
	const store = new InMemoryArtifactStore();
	const catalog = new RecallCatalog({ store, tenant });
	return { store, catalog };
}

describe("RecallCatalog", () => {
	it("recallExact returns the exact original content for a known ID", () => {
		const { catalog } = setup();
		const entry = catalog.add({
			kind: "tool_result",
			preview: "big build log",
			content: `NEEDLE-42 ${"log ".repeat(1000)}`,
			eventIds: ["e-1"],
			tenant: "t-1",
		});
		const recalled = catalog.recallExact(entry.refId);
		expect(new TextDecoder().decode(recalled.data)).toContain("NEEDLE-42");
		expect(recalled.entry.refId).toBe(entry.refId);
	});

	it("rejects unknown and cross-tenant IDs", () => {
		const { catalog } = setup();
		const entry = catalog.add({
			kind: "tool_result",
			preview: "p",
			content: "data",
			eventIds: ["e-1"],
			tenant: "t-1",
		});
		expect(() => catalog.recallExact("rc-nonexistent")).toThrow(/unknown|not found/i);
		const otherTenant = new RecallCatalog({ store: new InMemoryArtifactStore(), tenant: "t-2" });
		expect(() => otherTenant.recallExact(entry.refId)).toThrow(/tenant|unknown|not found/i);
	});

	it("fails closed when stored bytes no longer match the catalog hash", () => {
		const { store, catalog } = setup();
		const entry = catalog.add({
			kind: "tool_result",
			preview: "p",
			content: "integrity matters",
			eventIds: ["e-1"],
			tenant: "t-1",
		});
		store.corruptForTest(entry.artifactRef!, "tampered bytes");
		expect(() => catalog.recallExact(entry.refId)).toThrow(/hash|integrity|mismatch/i);
		const metrics = catalog.metrics();
		expect(metrics.recallFailures).toBe(1);
	});

	it("delayed needle query: content compacted out of context is recoverable by stable ID", () => {
		const { catalog } = setup();
		// Simulate: compaction moved this content out of the active context.
		const needle = "UNIQUE-NEEDLE-7f3a9b decision: use CAS for snapshot activation";
		const entry = catalog.add({
			kind: "message",
			preview: needle.slice(0, 50),
			content: needle,
			eventIds: ["e-needle"],
			tenant: "t-1",
		});
		// ... many turns later, agent recalls by the stable ref.
		const recalled = catalog.recallExact(entry.refId);
		expect(new TextDecoder().decode(recalled.data)).toBe(needle);
	});

	it("keyword search returns stable refs, not raw content", () => {
		const { catalog } = setup();
		catalog.add({
			kind: "tool_result",
			preview: "npm publish output",
			content: "published pkg",
			eventIds: ["e-1"],
			tenant: "t-1",
		});
		catalog.add({
			kind: "message",
			preview: "user asked about testing",
			content: "test plan",
			eventIds: ["e-2"],
			tenant: "t-1",
		});
		const hits = catalog.search("publish");
		expect(hits).toHaveLength(1);
		expect(hits[0].refId).toMatch(/^rc-/);
		expect(hits[0].preview).toContain("publish");
	});

	it("records recall metrics (attempts, hits, failures)", () => {
		const { catalog } = setup();
		const entry = catalog.add({ kind: "artifact", preview: "p", content: "c", eventIds: [], tenant: "t-1" });
		catalog.recallExact(entry.refId);
		expect(catalog.metrics()).toEqual({ recallAttempts: 1, recallHits: 1, recallFailures: 0 });
	});
});

describe("recall catalog durability (T-005)", () => {
	it("persists entries so a restarted catalog resolves the same deterministic ref", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "recall-persist-"));
		try {
			const { FileSystemArtifactStore } = await import("../../src/core/compaction/subsystem/artifact-store.ts");
			const { JsonlRecallPersister, RecallCatalog } = await import(
				"../../src/core/compaction/subsystem/recall-catalog.ts"
			);
			const store = new FileSystemArtifactStore(join(dir, "artifacts"));
			const persister = new JsonlRecallPersister(join(dir, "recall.jsonl"));
			const first = new RecallCatalog({ store, tenant: "t", persister });
			const entry = first.add({
				kind: "tool_result",
				preview: "big log preview",
				content: "x".repeat(5000),
				eventIds: ["e-1"],
				tenant: "t",
			});
			const sameContent = first.add({
				kind: "tool_result",
				preview: "same bytes, different event",
				content: "x".repeat(5000),
				eventIds: ["e-2"],
				tenant: "t",
			});
			expect(sameContent.refId).toBe(entry.refId);
			expect(sameContent.eventIds).toEqual(["e-1", "e-2"]);

			// Restart: new catalog over the same persister and artifact store.
			const second = new RecallCatalog({ store, tenant: "t", persister });
			const recalled = second.recallExact(entry.refId);
			expect(new TextDecoder().decode(recalled.data)).toBe("x".repeat(5000));
			expect(recalled.entry.eventIds).toEqual(["e-1", "e-2"]);
			// Same content in a fresh catalog derives the identical ref id.
			const third = new RecallCatalog({ store, tenant: "t" });
			const again = third.add({
				kind: "tool_result",
				preview: "big log preview",
				content: "x".repeat(5000),
				eventIds: ["e-9"],
				tenant: "t",
			});
			expect(again.refId).toBe(entry.refId);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
