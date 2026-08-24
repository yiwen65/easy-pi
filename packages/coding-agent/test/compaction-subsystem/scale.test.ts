import { describe, expect, it } from "vitest";
import { selectCoverageDelta } from "../../src/core/compaction/subsystem/orchestrator.ts";
import { buildPrompt } from "../../src/core/compaction/subsystem/prompt-builder.ts";
import type { EventEnvelope, StructuredSnapshot } from "../../src/core/compaction/subsystem/types.ts";

const systemAuthority = { kind: "system" as const, id: "scale-test", verified: true };

function events(count: number): EventEnvelope[] {
	return Array.from({ length: count }, (_, index) => ({
		eventId: `e-${index + 1}`,
		sessionId: "scale",
		agentId: "scale-test",
		seq: index + 1,
		timestamp: new Date(index + 1).toISOString(),
		eventType: "message" as const,
		payload: { role: "assistant", text: `tail ${index} ${"y".repeat(48)}` },
		authority: systemAuthority,
		causalParentIds: [],
		contentHash: `scale-hash-${index + 1}`,
		schemaVersion: 1 as const,
	}));
}

function snapshot(count: number): StructuredSnapshot {
	return {
		snapshotVersion: 1,
		sessionId: "scale",
		parentVersion: null,
		baseEventSeq: count,
		lineage: [],
		contractRef: { contractId: "scale-contract", version: 1 },
		constraints: [],
		facts: Array.from({ length: count }, (_, index) => ({
			id: `fact-${index}`,
			text: `historical fact ${index} ${"x".repeat(48)}`,
			kind: "fact" as const,
			verified: false,
			provenance: { sourceEventIds: [`e-${index + 1}`], source: "system" as const },
		})),
		decisions: [],
		tasks: [],
		tools: [],
		artifacts: [],
		errors: [],
		nextActions: [],
		recallCatalogRefs: [],
		sourceEventRanges: [{ fromSeq: 1, toSeq: count }],
		narrative: "n".repeat(count),
		compactor: { promptVersion: "scale", schemaVersion: 1 },
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
		schemaVersion: 1,
	};
}

describe("compaction scale invariants", () => {
	it.each([100, 1_000, 10_000])("keeps Hot/Warm projections bounded across %,i historical items", (count) => {
		const budgets = { snapshot: 512, narrative: 128, recentTail: 2_048 };
		const built = buildPrompt({
			systemPrompt: "system",
			snapshot: snapshot(count),
			tailEvents: events(count),
			currentInput: "continue",
			exactRecall: [],
			zoneBudgets: budgets,
			estimateTextTokens: (text) => text.length,
		});

		for (const zone of ["snapshot", "narrative", "recentTail"] as const) {
			const stats = built.projectionStats.find((item) => item.zone === zone);
			expect(stats?.usedTokens).toBeLessThanOrEqual(budgets[zone]);
			expect(built.sections.find((section) => section.zone === zone)?.tokens ?? 0).toBeLessThanOrEqual(
				budgets[zone],
			);
		}
	});

	it.each([100, 1_000, 10_000])("consumes %,i events once across incremental coverage checkpoints", (count) => {
		const allEvents = events(count);
		let previousCoverage = 0;
		let cumulativeDelta = 0;
		const stride = Math.max(1, Math.floor(count / 7));
		for (let target = stride; target < count; target += stride) {
			cumulativeDelta += selectCoverageDelta(allEvents, previousCoverage, target).length;
			previousCoverage = target;
		}
		cumulativeDelta += selectCoverageDelta(allEvents, previousCoverage, count).length;

		expect(cumulativeDelta).toBe(count);
		expect(() => selectCoverageDelta(allEvents, count, count - 1)).toThrow(/backwards/);
	});
});
