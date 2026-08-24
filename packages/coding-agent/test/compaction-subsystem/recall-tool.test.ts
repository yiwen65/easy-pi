import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	createRecallExactToolDefinition,
	createRecallSearchToolDefinition,
} from "../../src/core/compaction/subsystem/recall-tool.ts";
import { HfCompactionHost } from "../../src/core/compaction/subsystem/session-integration.ts";
import { COMPACTION_SCHEMA_VERSION, type StructuredSnapshot } from "../../src/core/compaction/subsystem/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

function messageEntry(id: string, parentId: string | null, text: string, imageData: string): SessionEntry {
	const message: AgentMessage = {
		role: "user",
		content: [
			{ type: "text", text },
			{ type: "image", data: imageData, mimeType: "image/png" },
		],
		timestamp: 1,
	};
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-24T00:00:00.000Z",
		message,
	};
}

function snapshot(recallCatalogRefs: string[]): Omit<StructuredSnapshot, "snapshotVersion"> {
	return {
		sessionId: "s-recall",
		parentVersion: null,
		baseEventSeq: 1,
		lineage: [],
		contractRef: { contractId: "c-1", version: 1 },
		taskLedgerRef: { branchId: "root", ledgerVersion: 1 },
		constraints: [],
		facts: [],
		decisions: [],
		tasks: [],
		tools: [],
		artifacts: [],
		errors: [],
		nextActions: [],
		recallCatalogRefs,
		sourceEventRanges: [{ fromSeq: 1, toSeq: 1 }],
		compactor: { promptVersion: "test", schemaVersion: COMPACTION_SCHEMA_VERSION },
		tokenStats: {
			system: 0,
			tools: 0,
			contract: 0,
			snapshot: 0,
			narrative: 0,
			recall: 0,
			recentTail: 0,
			currentInput: 0,
			outputReserve: 0,
			total: 0,
		},
		createdAt: "2026-08-24T00:00:00.000Z",
		schemaVersion: COMPACTION_SCHEMA_VERSION,
	};
}

describe("recall discovery tools", () => {
	it("indexes multimodal cold refs and searches only the active branch before exact recall", async () => {
		const host = new HfCompactionHost({
			sessionId: "s-recall",
			getSystemPrompt: () => "system",
			config: { mode: "structured_compaction" },
		});
		const root = messageEntry("root", null, "root context", "cm9vdA==");
		const branchA = messageEntry("a", "root", "diagram needle branch A", "YnJhbmNoLWE=");
		const branchB = messageEntry("b", "root", "diagram needle branch B secret", "YnJhbmNoLWI=");
		host.syncFromEntries([root, branchA]);
		host.syncFromEntries([root, branchB]);
		host.syncFromEntries([root, branchA]);
		const refA = host.recallCatalog.entries().find((entry) => entry.eventIds.includes("a"));
		const refB = host.recallCatalog.entries().find((entry) => entry.eventIds.includes("b"));
		expect(refA).toBeDefined();
		expect(refB).toBeDefined();
		expect(refA!.kind).toBe("message");

		const candidate = host.snapshotStore.putCandidate(snapshot([refA!.refId, refB!.refId]));
		host.snapshotStore.activate("s-recall", {
			expectedActiveVersion: 0,
			candidateVersion: candidate.snapshotVersion,
		});

		const searchTool = createRecallSearchToolDefinition(host);
		const searchResult = await searchTool.execute(
			"tc-search-a",
			{ query: "diagram", kind: "message", limit: 8 },
			undefined,
			undefined,
			undefined as never,
		);
		const searchText = searchResult.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		const parsed = JSON.parse(searchText) as { results: { refId: string; kind: string; preview: string }[] };
		expect(parsed.results).toEqual([
			expect.objectContaining({ refId: refA!.refId, kind: "message", preview: "diagram needle branch A" }),
		]);
		expect(searchText).not.toContain("branch B secret");
		expect(searchText).not.toContain("YnJhbmNoLWE=");

		const exactTool = createRecallExactToolDefinition(host);
		const exactResult = await exactTool.execute(
			"tc-exact-a",
			{ refId: refA!.refId },
			undefined,
			undefined,
			undefined as never,
		);
		expect(exactResult.content.some((block) => block.type === "text" && block.text.includes("diagram needle"))).toBe(
			true,
		);

		host.syncFromEntries([root, branchB]);
		expect(host.recallSearch({ query: "diagram" })).toEqual([
			expect.objectContaining({ refId: refB!.refId, preview: "diagram needle branch B secret" }),
		]);
		expect(() => host.recallExact(refA!.refId)).toThrow(/not active|current branch/i);
	});

	it("classifies recall_search as a read-only low-risk tool", () => {
		const host = new HfCompactionHost({
			sessionId: "s-risk",
			getSystemPrompt: () => "system",
			config: { mode: "structured_compaction" },
		});
		host.recordToolStarted("tc-search", "recall_search", { query: "needle" });
		expect(host.ledger.list().find((entry) => entry.toolCallId === "tc-search")).toMatchObject({
			sideEffectClass: "none",
			riskLevel: "low",
		});
	});
});
