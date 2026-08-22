/**
 * CCTX-071: fixtures — a coding trajectory and a tool-heavy trajectory with
 * ground-truth atoms, plus the runner test.
 */

import { describe, expect, it } from "vitest";
import type { CompleteFn } from "../../../src/core/compaction/subsystem/types.ts";
import { codingFixture, toolHeavyFixture } from "./fixtures.ts";
import { runEval } from "./runner.ts";

/** Faithful faux compactor: extracts decisions/facts from events it is shown. */
const faithfulComplete: CompleteFn = async (req) => {
	if (req.responseSchema) {
		const content = req.messages[0].content;
		const lines = [...content.matchAll(/\[seq=(\d+) id=([\w-]+) (message|tool_call|tool_result)[^\]]*\] (.+)/g)];
		const facts = [];
		const decisions = [];
		for (const m of lines) {
			const payload = m[4];
			const id = m[2];
			if (payload.includes("decided")) {
				decisions.push({
					text: payload.match(/decided[^"]*/)?.[0]?.slice(0, 100) ?? payload.slice(0, 80),
					sourceEventIds: [id],
				});
			}
			if (payload.includes("v") && /\d+\.\d+\.\d+/.test(payload)) {
				facts.push({
					text: `version pinned: ${payload.match(/\d+\.\d+\.\d+/)?.[0]}`,
					kind: "fact",
					sourceEventIds: [id],
				});
			}
		}
		return {
			text: JSON.stringify({ facts, decisions, nextActions: [] }),
			stopReason: "stop" as const,
			usage: { input: 10, output: 10 },
		};
	}
	return { text: "Narrative bridge.", stopReason: "stop" as const, usage: { input: 10, output: 10 } };
};

describe("eval runner (faux compactor)", () => {
	it("coding fixture: all atoms retained through 2 compactions", async () => {
		const report = await runEval(codingFixture, faithfulComplete);
		expect(report.oracleConsistent).toBe(true);
		expect(report.retentionByKind.C).toBe(1);
		expect(report.retentionByKind.T).toBe(1);
		expect(report.retentionByKind.S).toBe(1);
		expect(report.retentionByKind.U).toBe(1);
		expect(report.retentionByKind.P).toBe(1);
		const failed = report.atoms.filter((a) => !a.passed);
		expect(failed).toEqual([]);
		// Token gain happened.
		expect(report.tokensAfterLast).toBeLessThan(report.tokensBeforeFirst);
	});

	it("tool-heavy fixture: failure states and needles survive", async () => {
		const report = await runEval(toolHeavyFixture, faithfulComplete);
		expect(report.oracleConsistent).toBe(true);
		expect(report.retentionByKind.T).toBe(1);
		const failed = report.atoms.filter((a) => !a.passed);
		expect(failed).toEqual([]);
	});
});
