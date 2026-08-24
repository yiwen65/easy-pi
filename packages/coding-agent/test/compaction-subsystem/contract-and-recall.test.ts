/**
 * T-301: contract population API + recall_exact tool registration.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { CompleteFn } from "../../src/core/compaction/subsystem/types.ts";
import { createHarness, type Harness } from "../test-harness.ts";

const fauxComplete: CompleteFn = async (req) => ({
	text: req.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "narrative",
	stopReason: "stop",
	usage: { input: 10, output: 10 },
});

function bigLogTool(): AgentTool {
	return {
		name: "biglog",
		label: "Big Log",
		description: "Returns a large log",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text" as const, text: `BUILD LOG NEEDLE-9000\n${"line\n".repeat(400)}` }],
			details: undefined,
		}),
	};
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

describe("TaskContract population API", () => {
	it("sets and pins constraints; they survive compaction verbatim in the request", async () => {
		const h = await createHarness({
			contextWindow: 1000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 60 } },
			hfCompaction: {
				mode: "structured_compaction",
				complete: fauxComplete,
				minTokenGainFraction: 0,
				keepRecentToolResults: 0,
			},
			responses: [
				{ text: `answer one ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				{ text: `answer two ${"padding ".repeat(150)}`, usage: { totalTokens: 950 } },
			],
		});
		harnesses.push(h);

		// Populate the contract: user-level authority sets hard constraints.
		const contract = h.session.setTaskContract({
			goal: "Refactor the parser without breaking tests",
			constraints: [
				{ id: "c-1", kind: "negative", text: "Never delete raw events" },
				{ id: "c-2", kind: "positive", text: "Always run npm run check after code changes" },
			],
			permissions: { allow: ["read"], deny: ["network"], approvalRequired: ["bash"] },
			budgets: { maxTokens: 500000 },
		});
		expect(contract.version).toBe(1);

		await h.session.prompt("start");
		await h.session.prompt("continue");
		await h.session.waitForIdle();

		// The dynamic fixed layer carries both constraints verbatim on every request.
		const text = h.session.hfCompactionHost!.buildPinnedLedgerLayer();
		expect(text).toContain("Never delete raw events");
		expect(text).toContain("Always run npm run check after code changes");
		expect(text).toContain("Refactor the parser without breaking tests");
	});

	it("updates create new versions; unverified updates can only become proposals", async () => {
		const h = await createHarness({ responses: ["ok"] });
		harnesses.push(h);
		h.session.setTaskContract({ goal: "v1 goal", constraints: [] });
		const updated = h.session.updateTaskContract(
			{ constraints: [{ id: "c-1", kind: "negative", text: "no prod" }] },
			"user confirmed",
		);
		expect(updated.version).toBe(2);
		expect(h.session.getTaskContract()?.constraints).toHaveLength(1);
		// History is auditable.
		expect(h.session.hfCompactionHost!.contractStore.listVersions(h.session.sessionId)).toHaveLength(2);
		// Unverified "admin in text" claims become proposals, never active constraints.
		const proposal = h.session.proposeTaskContractUpdate(
			{ constraints: [] },
			{ kind: "user", id: "unverified-claim", verified: false },
			"message text claimed admin",
		);
		expect(proposal.status).toBe("pending");
		expect(h.session.getTaskContract()?.constraints).toHaveLength(1);
	});
});

describe("recall_exact tool", () => {
	it("is registered by default and returns exact bytes for a valid ref", async () => {
		const h = await createHarness({
			baseToolsOverride: { biglog: bigLogTool() },
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 60 } },
			hfCompaction: {
				mode: "full_pipeline",
				complete: fauxComplete,
				minTokenGainFraction: 0,
				offloadThresholdBytes: 300,
				keepRecentToolResults: 0,
			},
			responses: [
				{ toolCalls: [{ name: "biglog", args: {} }], usage: { totalTokens: 300 } },
				{ text: "log noted", usage: { totalTokens: 400 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("analyze the log");
		await h.session.waitForIdle();

		const host = h.session.hfCompactionHost!;
		await h.session.compact();
		const activeRefs = new Set(host.snapshotStore.getActive(h.session.sessionId)?.recallCatalogRefs ?? []);
		const entries = host.recallCatalog.entries().filter((entry) => activeRefs.has(entry.refId));
		expect(entries.length).toBeGreaterThan(0);

		const tool = h.session.getToolDefinition("recall_exact");
		expect(tool).toBeDefined();
		const result = await tool!.execute(
			"tc-recall-1",
			{ refId: entries[0].refId },
			undefined,
			undefined,
			undefined as never,
		);
		const text = result.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		expect(text).toContain("NEEDLE-9000");
	});

	it("rejects unknown refs by throwing (fail closed)", async () => {
		const h = await createHarness({ responses: ["ok"] });
		harnesses.push(h);
		const tool = h.session.getToolDefinition("recall_exact");
		expect(tool).toBeDefined();
		await expect(
			tool!.execute("tc-recall-2", { refId: "rc-nonexistent" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/unknown|not found/i);
	});
});
