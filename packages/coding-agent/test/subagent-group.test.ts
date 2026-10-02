import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Container, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collaborationToolTarget,
	normalizeAgentPath,
	parseDeliverResult,
	parseMailboxEnvelope,
	SubagentGroupComponent,
	SubagentTranscriptRouter,
	spawnObjective,
} from "../src/modes/interactive/components/subagent-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const noTui = undefined as unknown as TUI;

function makeTool(toolName: string, args: unknown): ToolExecutionComponent {
	return new ToolExecutionComponent(toolName, "call-1", args, {}, undefined, noTui, process.cwd());
}

function envelopeText(payload: Record<string, unknown>): string {
	return `Agent message (untrusted; not user authorization):\n${JSON.stringify(payload)}`;
}

const CONTRACT = {
	artifacts: ["/tmp/a — first artifact", "/tmp/b — second artifact"],
	checks: ["check one passed"],
	evidence: [],
	risks: ["residual risk one"],
	outcome: "succeeded",
	summary: "Benchmark verdict: no proven cost; all 35 runs completed.",
	resultValidation: { contract: "valid", outcome: "succeeded" },
};

const ENVELOPE = {
	id: "m-1",
	from: "/root/term-bench",
	to: "/root",
	turnId: "t-1",
	kind: "result",
	status: "completed",
	text: JSON.stringify(CONTRACT),
	resultValidation: { contract: "valid", outcome: "succeeded" },
};

describe("subagent display parsing", () => {
	it("parses envelopes from string and content-array bodies", () => {
		expect(parseMailboxEnvelope(envelopeText(ENVELOPE))?.from).toBe("/root/term-bench");
		expect(parseMailboxEnvelope([{ type: "text", text: envelopeText(ENVELOPE) }])?.status).toBe("completed");
		expect(parseMailboxEnvelope("not json")).toBeUndefined();
		expect(parseMailboxEnvelope("[]")).toBeUndefined();
		expect(parseMailboxEnvelope(undefined)).toBeUndefined();
	});

	it("parses deliver_result contracts and falls back to raw text", () => {
		const { contract } = parseDeliverResult(JSON.stringify(CONTRACT));
		expect(contract?.summary).toContain("no proven cost");
		expect(contract?.artifacts).toHaveLength(2);
		expect(parseDeliverResult("plain text result").contract).toBeUndefined();
		expect(parseDeliverResult("plain text result").raw).toBe("plain text result");
		expect(parseDeliverResult(undefined).raw).toBe("");
	});

	it("bounds deeply nested invalid array display while retaining raw text", () => {
		const raw = `${"[".repeat(4000)}"DEEP_SENTINEL"${"]".repeat(4000)}`;
		const result = parseDeliverResult(raw);
		expect(result.raw).toBe(raw);
		expect(result.warning).toContain("Format warning");
		expect(result.displayText).toContain("(nested data; open Diagnostics)");
	});

	it("does not traverse ignored deep fields in a valid result", () => {
		const deep = `${"[".repeat(4000)}0${"]".repeat(4000)}`;
		const raw = `{"summary":"ok","outcome":"succeeded","ignored":${deep}}`;
		const result = parseDeliverResult(raw);
		expect(result.raw).toBe(raw);
		expect(result.displayText).toBe("ok");
		expect(result.contract?.summary).toBe("ok");
		expect(result.warning).toBeUndefined();
	});

	it("safely falls back when wrongly typed result text cannot be JSON serialized", () => {
		const raw = `${"[".repeat(8000)}0${"]".repeat(8000)}`;
		const text: unknown = JSON.parse(raw);
		const result = parseDeliverResult(text);
		expect(result.warning).toContain("Format warning");
		expect(result.displayText).toContain("(nested data; open Diagnostics)");
		expect(result.raw).toContain("not serializable");
	});

	it("resolves tool targets and spawn objectives", () => {
		expect(normalizeAgentPath("worker")).toBe("/root/worker");
		expect(normalizeAgentPath("/root/worker")).toBe("/root/worker");
		expect(collaborationToolTarget("spawn_agent", { task_name: "worker" })).toBe("/root/worker");
		expect(collaborationToolTarget("interrupt_agent", { target: "/root/worker" })).toBe("/root/worker");
		expect(collaborationToolTarget("wait_agent", { timeout_ms: 1000 })).toBeUndefined();
		expect(collaborationToolTarget("list_agents", {})).toBeUndefined();
		expect(spawnObjective({ task: { objective: "First line\nSecond line" } })).toBe("First line\nSecond line");
		const longObjective = `First line ${"complete objective ".repeat(12)}\nSecond line`;
		expect(spawnObjective({ task: { objective: longObjective } })).toBe(longObjective);
		expect(spawnObjective({ task: { objective: "  " } })).toBeUndefined();
	});
});

describe("SubagentGroupComponent", () => {
	beforeEach(() => initTheme("dark"));

	it.each(
		[
			{ summary: 42, outcome: "succeeded" },
			{ summary: ["invalid"], outcome: "succeeded" },
			["invalid result array"],
			...["artifacts", "checks", "evidence", "risks"].map((field) => ({
				summary: "Malformed list",
				outcome: "succeeded",
				[field]: { invalid: true },
			})),
			{ summary: "Invalid validation", outcome: "succeeded", resultValidation: 42 },
		].map((payload) => ({ payload })),
	)("retains malformed results without throwing: %j", ({ payload }) => {
		const group = new SubagentGroupComponent("/root/worker");
		const text = JSON.stringify(payload);
		expect(() => group.addMailboxResult({ ...ENVELOPE, text })).not.toThrow();
		expect(group.render(160).join("\n")).toContain("!format");
		group.setExpanded(true);
		const lines = group.render(160).map(stripVTControlCharacters);
		expect(lines.join("\n")).toContain("Format warning");
		expect(lines.join("\n")).not.toContain(text);
		if (payload !== null && typeof payload === "object" && "outcome" in payload)
			expect(lines.join("\n")).toContain("Outcome: succeeded");
		group.handleOverviewClick(
			lines.findIndex((line) => line.includes("Diagnostics")),
			160,
		);
		expect(group.render(160).map(stripVTControlCharacters).join("\n")).toContain(JSON.stringify(text).slice(1, -1));
	});

	it.each(["succeeded", "partial", "blocked", "failed"])(
		"separates completed lifecycle from %s outcome",
		(outcome) => {
			const group = new SubagentGroupComponent("/root/worker");
			group.addMailboxResult({
				...ENVELOPE,
				text: JSON.stringify({ summary: "Latest result", outcome }),
				resultValidation: { contract: "valid", outcome },
			});
			const header = group.render(160).map(stripVTControlCharacters).join("\n");
			expect(header).toMatch(/^↳ /);
			expect(header).not.toContain("Subagent");
			expect(header).toContain("Completed");
			if (outcome === "blocked" || outcome === "partial") expect(header).toContain(outcome);
			else expect(header).not.toContain(outcome);
			expect(header).not.toContain("Outcome:");
			expect(header).not.toContain("Accepted");
			group.setExpanded(true);
			expect(group.render(160).map(stripVTControlCharacters).join("\n")).toContain(`Outcome: ${outcome}`);
		},
	);

	it.each(["invalid", "not_completed"])("shows controller validation warning %s", (contract) => {
		const group = new SubagentGroupComponent("/root/worker");
		group.addMailboxResult({
			...ENVELOPE,
			resultValidation: { contract },
			text: JSON.stringify({ summary: "Latest result", outcome: "blocked" }),
		});
		expect(group.render(160).join("\n")).toContain(contract === "invalid" ? "!invalid" : "!incomplete");
		group.setExpanded(true);
		expect(group.render(160).join("\n")).toContain(contract);
	});

	it.each([
		{ name: "very-long-worker-name-".repeat(8), outcome: "blocked", malformed: false },
		{ name: "中文子代理名称".repeat(12), outcome: "succeeded", malformed: false },
		{ name: "中文子代理名称".repeat(12), outcome: "blocked", malformed: true },
		{ name: "very-long-worker-name-".repeat(8), outcome: "succeeded", malformed: true },
	])("reserves narrow header outcome/warning and latest preview: %j", ({ name, outcome, malformed }) => {
		const group = new SubagentGroupComponent(`/root/${name}`);
		group.addMailboxResult({ ...ENVELOPE, text: JSON.stringify({ summary: "OLD_PREVIEW", outcome: "failed" }) });
		group.addMailboxResult({
			...ENVELOPE,
			id: "m-2",
			turnId: "t-2",
			text: JSON.stringify({
				summary: "LATEST最新预览",
				outcome,
				...(malformed ? { artifacts: 42, checks: 42, evidence: 42, risks: 42 } : {}),
			}),
		});
		for (const width of [40, 80]) {
			const lines = group.render(width).map(stripVTControlCharacters);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
			expect(lines[0]).toMatch(/^↳ /);
			expect(lines[0]).not.toContain("Subagent");
			expect(lines[0]).toContain("Completed");
			if (outcome === "blocked") expect(lines[0]).toContain(outcome);
			else expect(lines[0]).not.toContain("succeeded");
			expect(lines[0]).not.toContain("Outcome:");
			if (malformed) expect(lines[0]).toContain("!format");
			if (width === 80) expect(lines[0]).toContain("LATEST");
			expect(lines[0]).not.toContain("OLD_PREVIEW");
			expect(lines[0]).toContain("…");
		}
		group.setExpanded(true);
		const text = group.render(80).map(stripVTControlCharacters).join("\n");
		expect(text).toContain(`Outcome: ${outcome}`);
		if (malformed) expect(text).toContain("Format warning: invalid artifacts, checks, evidence, risks");
	});

	it("collapses to a header line with state, time, and summary by default", () => {
		const group = new SubagentGroupComponent("/root/term-bench");
		group.addMailboxResult(ENVELOPE);
		const lines = group.render(100);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("term-bench");
		expect(lines[0]).not.toContain("/root/");
		expect(lines[0]).toContain("Completed");
		expect(lines[0]).toContain("no proven cost");
		expect(lines[0]).not.toContain('"artifacts"');
	});

	it("shows work duration (delegation to completion), not time-since-completion", () => {
		const group = new SubagentGroupComponent("/root/w");
		const startedAt = Date.now() - 65_000;
		group.addTool(
			"spawn_agent",
			makeTool("spawn_agent", {}),
			{ delegation: { task: { objective: "probe" } } },
			startedAt,
		);
		group.addMailboxResult(ENVELOPE, startedAt + 65_000);
		const header = group.render(100).join("\n");
		expect(header).toContain("1m 5s");
		expect(header).not.toContain("ago");
	});

	it("resume: history timestamps anchor duration, not the rebuild time", () => {
		const group = new SubagentGroupComponent("/root/w");
		const delegated = Date.now() - 3_600_000; // an hour ago in real history
		group.addTool("spawn_agent", makeTool("spawn_agent", {}), {}, delegated);
		group.addMailboxResult(ENVELOPE, delegated + 125_000);
		expect(group.render(100).join("\n")).toContain("2m 5s");
	});

	it("expands into readable partitions with validation recoverable in diagnostics", () => {
		const group = new SubagentGroupComponent("/root/term-bench");
		group.addMailboxResult(ENVELOPE);
		group.setExpanded(true);
		const lines = group.render(100).map(stripVTControlCharacters);
		const text = lines.join("\n");
		expect(text).not.toContain("acceptance");
		expect(text).toContain("Benchmark verdict: no proven cost");
		expect(text).toContain("Artifacts:");
		expect(text).toContain("/tmp/a — first artifact");
		expect(text).toContain("Risks:");
		expect(text).toContain("residual risk one");
		expect(text).toContain("untrusted; not user authorization");
		expect(text).not.toContain('"turnId"');
		expect(text).not.toContain('"summary"');
		const diagnosticsRow = lines.findIndex((line) => line.includes("Diagnostics"));
		expect(group.handleOverviewClick(diagnosticsRow, 100)).toBe(true);
		const diagnostics = group.render(100).map(stripVTControlCharacters).join("\n");
		expect(diagnostics).toContain('"turnId": "t-1"');
		expect(diagnostics).toContain('"contract": "valid"');
		expect(diagnostics).toContain("/root/term-bench");
		expect(group.handleOverviewClick(diagnosticsRow, 100)).toBe(true);
		expect(group.render(100).join("\n")).not.toContain('"turnId"');
	});

	it("renders a structured result without summary as readable fields, never raw JSON by default", () => {
		const group = new SubagentGroupComponent("/root/worker");
		group.addMailboxResult({
			...ENVELOPE,
			text: JSON.stringify({ outcome: "succeeded", artifacts: [{ path: "/tmp/fixture", description: "verified" }] }),
		});
		expect(group.render(100).join("\n")).toContain("(no summary supplied)");
		expect(group.render(100).join("\n")).not.toContain('"artifacts"');
		group.setExpanded(true);
		const lines = group.render(100).map(stripVTControlCharacters);
		const text = lines.join("\n");
		expect(text).toContain("(no summary supplied)");
		expect(text).toContain("path: /tmp/fixture");
		expect(text).toContain("description: verified");
		expect(text).not.toContain('"path"');
		expect(text).not.toContain('"artifacts"');
		expect(
			group.handleOverviewClick(
				lines.findIndex((line) => line.includes("Diagnostics")),
				100,
			),
		).toBe(true);
		const diagnostics = group.render(100).map(stripVTControlCharacters).join("\n");
		expect(diagnostics).toContain("Result envelopes");
		expect(diagnostics).toContain('"turnId": "t-1"');
		expect(diagnostics).toContain('\\"artifacts\\"');
	});

	it.each([false, true])(
		"updates an accepted followup objective even when result arrives first: %s",
		(resultFirst) => {
			const group = new SubagentGroupComponent("/root/worker");
			const spawn = makeTool("spawn_agent", {});
			group.addTool("spawn_agent", spawn, { task: { objective: "Original task" } });
			spawn.updateResult({ content: [{ type: "text", text: "Accepted" }], isError: false });
			group.addMailboxResult(ENVELOPE);
			const followup = makeTool("followup_task", {});
			const objective = "Followup objective\nFULL_FOLLOWUP_END";
			group.addTool("followup_task", followup, { task: { objective } });
			group.setExpanded(true);
			expect(group.render(100).join("\n")).toContain("Original task");
			followup.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
			expect(group.render(100).join("\n")).not.toContain("FULL_FOLLOWUP_END");
			if (resultFirst) group.addMailboxResult({ ...ENVELOPE, id: "m-2", turnId: "t-2", text: "Followup finished" });
			followup.updateResult({ content: [{ type: "text", text: '{"status":"accepted"}' }], isError: false });
			const lines = group.render(100).map(stripVTControlCharacters);
			expect(lines[0]).toContain(resultFirst ? "Completed" : "Running");
			expect(lines.join("\n")).toContain("Task: Followup objective\nFULL_FOLLOWUP_END");
			expect(lines.join("\n")).not.toContain("Original task");
			if (resultFirst) expect(lines.join("\n")).toContain("Followup finished");
		},
	);

	it("keeps unknown JSON raw only in Diagnostics without inventing a contract", () => {
		const group = new SubagentGroupComponent("/root/worker");
		const text = JSON.stringify({ unknown: "UNKNOWN_JSON_SENTINEL" });
		group.addMailboxResult({ ...ENVELOPE, text });
		expect(group.render(160).join("\n")).not.toContain('"unknown"');
		group.setExpanded(true);
		const lines = group.render(160).map(stripVTControlCharacters);
		expect(lines.join("\n")).toContain("unknown: UNKNOWN_JSON_SENTINEL");
		expect(lines.join("\n")).not.toContain('"unknown"');
		expect(parseDeliverResult(text).contract).toBeUndefined();
		expect(parseDeliverResult(text).raw).toBe(text);
		group.handleOverviewClick(
			lines.findIndex((line) => line.includes("Diagnostics")),
			160,
		);
		expect(group.render(160).join("\n")).toContain(JSON.stringify(text).slice(1, -1));
	});

	it.each([
		{ text: "Result remains plain text", outcome: "blocked" },
		{ text: '```json\n{"summary":"Wrapped result","outcome":"blocked"}\n```', outcome: "blocked" },
		{ text: 'Result follows: {"summary":"Prose result","outcome":"failed"} End.', outcome: "failed" },
	])("uses known envelope outcomes for result text wrappers: %j", ({ text, outcome }) => {
		const group = new SubagentGroupComponent("/root/worker");
		group.addMailboxResult({ ...ENVELOPE, text, resultValidation: { contract: "valid", outcome } });
		const header = group.render(160).join("\n");
		if (outcome === "failed") expect(header).not.toContain("failed");
		else expect(header).toContain(outcome);
		group.setExpanded(true);
		expect(group.render(160).join("\n")).toContain(`Outcome: ${outcome}`);
		expect(group.render(160).join("\n")).not.toContain('"summary"');
	});

	it.each([
		{ contract: "accepted", outcome: "blocked" },
		{ contract: "valid", outcome: "accepted" },
		{ contract: "valid", outcome: 42 },
		{ contract: "valid", acceptance: "accepted" },
	])("warns about unknown validation enums without displaying them as outcomes: %j", (resultValidation) => {
		const group = new SubagentGroupComponent("/root/worker");
		group.addMailboxResult({ ...ENVELOPE, text: "Plain result", resultValidation });
		group.setExpanded(true);
		const text = group.render(160).join("\n");
		expect(text).toContain("Format warning");
		expect(text).not.toContain("Outcome: accepted");
		expect(text).not.toContain("Outcome: 42");
	});

	it.each([42, null, {}, ["valid"], "accepted", { toString: 42, valueOf: 42 }].map((contract) => ({ contract })))(
		"renders unknown mailbox contract metadata without invoking primitive conversion: %j",
		({ contract }) => {
			const group = new SubagentGroupComponent("/root/worker");
			group.addMailboxResult({ ...ENVELOPE, text: "Plain result", resultValidation: { contract } });
			group.setExpanded(true);
			for (const width of [1, 8, 40, 120]) expect(() => group.render(width)).not.toThrow();
			const lines = group.render(120).map(stripVTControlCharacters);
			expect(lines.join("\n")).toContain("Format: unknown");
			expect(lines.join("\n")).toContain("Format warning");
			group.handleOverviewClick(
				lines.findIndex((line) => line.includes("Diagnostics")),
				120,
			);
			expect(() => group.render(120)).not.toThrow();
			expect(group.render(120).join("\n")).toContain('"resultValidation"');
		},
	);

	it.each([false, true])(
		"does not settle a new turn from malformed fast mailbox status (identified receipt: %s)",
		(identified) => {
			const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
			try {
				const group = new SubagentGroupComponent("/root/worker");
				const spawn = makeTool("spawn_agent", {});
				group.addTool("spawn_agent", spawn, { task: { objective: "old task" } }, 100);
				spawn.updateResult({
					content: [{ type: "text", text: identified ? '{"turn_id":"t-1"}' : '{"status":"accepted"}' }],
					isError: false,
				});
				group.addMailboxResult(ENVELOPE, 500);
				const followup = makeTool("followup_task", {});
				group.addTool("followup_task", followup, { task: { objective: "NEW_TASK" } }, 1000);
				group.addMailboxResult(
					{
						...ENVELOPE,
						id: "m-2",
						turnId: "t-2",
						status: { toString: 42, valueOf: 42 },
						text: "Unproved completion",
					},
					2000,
				);
				expect(() =>
					followup.updateResult({
						content: [{ type: "text", text: identified ? '{"turn_id":"t-2"}' : '{"status":"accepted"}' }],
						isError: false,
					}),
				).not.toThrow();
				const header = stripVTControlCharacters(group.render(120)[0]);
				expect(header).toContain("Running");
				expect(header).toContain("NEW_TASK");
				expect(header).toContain("9.0s");
				group.setExpanded(true);
				expect(group.render(120).join("\n")).toContain("Format warning: invalid status");
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("normalizes each result independently and keeps the newest outcome in the header", () => {
		const group = new SubagentGroupComponent("/root/worker");
		group.addMailboxResult({
			...ENVELOPE,
			text: "OLD_BLOCKED",
			resultValidation: { contract: "valid", outcome: "blocked" },
		});
		group.addMailboxResult({
			...ENVELOPE,
			id: "m-2",
			turnId: "t-2",
			text: "LATEST_PARTIAL",
			resultValidation: { contract: "valid", outcome: "partial" },
		});
		expect(group.render(160).join("\n")).toContain("partial");
		expect(group.render(160).join("\n")).not.toContain("blocked");
		group.setExpanded(true);
		const text = group.render(160).join("\n");
		expect(text).toContain("Outcome: blocked");
		expect(text.indexOf("LATEST_PARTIAL")).toBeLessThan(text.indexOf("OLD_BLOCKED"));
	});

	it.each([42, null, ["not text"], { text: "not a string" }].map((text) => ({ text })))(
		"safely retains non-string envelope text %j",
		({ text }) => {
			const group = new SubagentGroupComponent("/root/worker");
			group.addMailboxResult({ ...ENVELOPE, text, resultValidation: { contract: "invalid" } });
			group.setExpanded(true);
			const lines = group.render(160).map(stripVTControlCharacters);
			expect(lines.join("\n")).toContain("Format warning");
			group.handleOverviewClick(
				lines.findIndex((line) => line.includes("Diagnostics")),
				160,
			);
			expect(group.render(160).join("\n")).toContain('"turnId": "t-1"');
		},
	);

	it("bounds deeply nested artifact values without changing shallow object output or Diagnostics", () => {
		const deep = `${"[".repeat(4000)}"ARTIFACT_DEEP_SENTINEL"${"]".repeat(4000)}`;
		const raw = `{"summary":"ok","outcome":"succeeded","artifacts":[{"path":"/tmp/shallow","description":"verified"},{"nested":${deep}}]}`;
		const group = new SubagentGroupComponent("/root/worker");
		group.addMailboxResult({ ...ENVELOPE, text: raw });
		group.setExpanded(true);
		const lines = group.render(120).map(stripVTControlCharacters);
		expect(lines.join("\n")).toContain("path: /tmp/shallow · description: verified");
		expect(lines.join("\n")).toContain("(nested data; open Diagnostics)");
		expect(lines.join("\n")).not.toContain("ARTIFACT_DEEP_SENTINEL");
		expect(group.handleOverviewClick(lines.indexOf("▸ Diagnostics"), 120)).toBe(true);
		expect(group.render(120).join("\n")).toContain("ARTIFACT_DEEP_SENTINEL");
		expect(parseDeliverResult(raw).raw).toBe(raw);
	});

	it("recovers the original JSON envelope wire when deep text cannot be serialized in Diagnostics", () => {
		const body = ` {"from":"/root/probe","status":"completed","text":${"[".repeat(8000)}"WIRE_SENTINEL"${"]".repeat(8000)},"opaque":"UNCHANGED_METADATA"} `;
		const envelope = parseMailboxEnvelope(body);
		expect(envelope).toBeDefined();
		if (!envelope) throw new Error("Expected parsed envelope");
		const group = new SubagentGroupComponent("/root/probe");
		group.addMailboxResult(envelope);
		group.setExpanded(true);
		const lines = group.render(120).map(stripVTControlCharacters);
		expect(group.handleOverviewClick(lines.indexOf("▸ Diagnostics"), 120)).toBe(true);
		const diagnostics = group.render(120).map(stripVTControlCharacters);
		const recoveredWire = diagnostics.slice(diagnostics.indexOf("Result envelopes") + 1).join("");
		expect(recoveredWire.trim()).toBe(body.trim());
		expect(recoveredWire).toContain("WIRE_SENTINEL");
		expect(recoveredWire).toContain('"opaque":"UNCHANGED_METADATA"');
		expect(recoveredWire).not.toContain("original JSON unavailable");
	});

	it("shows an explicit diagnostic warning for an unrepresentable direct JS envelope", () => {
		const envelope: Record<string, unknown> = { from: "/root/probe", status: "completed", text: "Plain text" };
		envelope.circular = envelope;
		const group = new SubagentGroupComponent("/root/probe");
		group.addMailboxResult(envelope);
		group.setExpanded(true);
		const lines = group.render(120).map(stripVTControlCharacters);
		expect(group.handleOverviewClick(lines.indexOf("▸ Diagnostics"), 120)).toBe(true);
		expect(group.render(120).join("\n")).toContain("original JSON unavailable");
	});

	it("retains deeply nested invalid raw strings when Diagnostics opens", () => {
		const raw = `${"[".repeat(4000)}"RAW_DEEP_SENTINEL"${"]".repeat(4000)}`;
		const group = new SubagentGroupComponent("/root/worker");
		group.addMailboxResult({ ...ENVELOPE, text: raw, resultValidation: { contract: "invalid" } });
		group.setExpanded(true);
		const lines = group.render(120).map(stripVTControlCharacters);
		expect(lines.join("\n")).toContain("(nested data; open Diagnostics)");
		expect(group.handleOverviewClick(lines.indexOf("▸ Diagnostics"), 120)).toBe(true);
		expect(group.render(120).join("\n")).toContain("RAW_DEEP_SENTINEL");
	});

	it("preserves multiline plain text for non-JSON results", () => {
		const group = new SubagentGroupComponent("/root/x");
		group.addMailboxResult({ ...ENVELOPE, from: "/root/x", text: "plain multi\nline\nresult" });
		group.setExpanded(true);
		const text = group.render(100).join("\n");
		expect(text).toContain("plain multi");
		expect(text).toContain("line");
		expect(text).toContain("result");
		expect(text).not.toContain("summary:");
	});

	it("toggles via header click and forwards member clicks only when expanded", () => {
		const group = new SubagentGroupComponent("/root/x");
		expect(group.render(100)).toHaveLength(1);
		expect(group.handleOverviewClick(0, 100)).toBe(true);
		expect(group.render(100).length).toBeGreaterThanOrEqual(1);
		expect(group.handleOverviewClick(0, 100)).toBe(true); // collapse
		// collapsed: only row 0 is actionable
		expect(group.handleOverviewClick(3, 100)).toBe(false);
	});

	it("shows the flat spawn task objective in the collapsed and expanded transcript", () => {
		const group = new SubagentGroupComponent("/root/w");
		group.addTool("spawn_agent", makeTool("spawn_agent", {}), {
			task: { objective: "Probe the parser\nThen report" },
		});
		expect(group.render(100).join("\n")).toContain("Probe the parser");
		group.setExpanded(true);
		expect(group.render(100).join("\n")).toContain("Task: Probe the parser");
	});

	it.each(["followup_task", "interrupt_agent", "close_agent"])(
		"does not change the displayed state when %s is rejected or only partially updated",
		(toolName) => {
			const group = new SubagentGroupComponent("/root/w");
			group.addMailboxResult({ ...ENVELOPE, status: "completed" });
			const tool = makeTool(toolName, { target: "/root/w" });
			group.addTool(toolName, tool, { target: "/root/w" });
			tool.updateResult({ content: [{ type: "text", text: "pending" }], isError: false }, true);
			expect(group.render(100).join("\n")).toContain("Completed");
			tool.updateResult({ content: [{ type: "text", text: "Collaboration tool failed: busy" }], isError: true });
			const header = group.render(100).join("\n");
			expect(header).toContain("Completed");
			expect(header).not.toContain("Running");
			expect(header).not.toContain("Interrupted");
			expect(header).not.toContain("Closed");
		},
	);

	it("updates followup and close only after successful results", () => {
		const group = new SubagentGroupComponent("/root/w");
		group.addMailboxResult(ENVELOPE);
		const followup = makeTool("followup_task", {});
		group.addTool("followup_task", followup, {});
		expect(group.render(100).join("\n")).toContain("Completed");
		followup.updateResult({ content: [{ type: "text", text: '{"status":"accepted"}' }], isError: false });
		expect(group.render(100).join("\n")).toContain("Running");

		const close = makeTool("close_agent", {});
		group.addTool("close_agent", close, {});
		expect(group.render(100).join("\n")).toContain("Running");
		close.updateResult({ content: [{ type: "text", text: '{"previous_status":"interrupted"}' }], isError: false });
		expect(group.render(100).join("\n")).toContain("Closed");
	});

	it("does not overwrite a fast followup result delivered before its tool receipt", () => {
		const group = new SubagentGroupComponent("/root/w");
		group.addMailboxResult(ENVELOPE);
		const followup = makeTool("followup_task", {});
		group.addTool("followup_task", followup, {});
		group.addMailboxResult({ ...ENVELOPE, id: "m-2", turnId: "t-2", text: "Followup finished" });
		followup.updateResult({ content: [{ type: "text", text: '{"status":"accepted"}' }], isError: false });
		expect(group.render(100).join("\n")).toContain("Completed");
	});

	it("promotes a fast mailbox result only after its matching followup receipt pins the new turn", () => {
		const group = new SubagentGroupComponent("/root/worker");
		const spawn = makeTool("spawn_agent", {});
		group.addTool("spawn_agent", spawn, { task: { objective: "original" } }, 10);
		spawn.updateResult({ content: [{ type: "text", text: '{"turn_id":"t-1"}' }], isError: false });
		group.addMailboxResult(ENVELOPE, 20);
		const followup = makeTool("followup_task", {});
		group.addTool("followup_task", followup, { task: { objective: "new objective" } }, 30);
		group.addMailboxResult({ ...ENVELOPE, id: "m-2", turnId: "t-2", text: "FAST_NEW_RESULT" }, 40);
		followup.updateResult({ content: [{ type: "text", text: '{"turn_id":"t-2"}' }], isError: false });
		expect(group.render(120).join("\n")).toContain("FAST_NEW_RESULT");
		expect(group.render(120).join("\n")).toContain("Completed");
		group.addMailboxResult(ENVELOPE, 50);
		expect(group.resultCount).toBe(2);
		expect(group.render(120).join("\n")).toContain("FAST_NEW_RESULT");
	});

	it("interrupt uses the returned previous status rather than assuming it stopped running work", () => {
		const running = new SubagentGroupComponent("/root/running");
		const interruptedTool = makeTool("interrupt_agent", {});
		running.addTool("interrupt_agent", interruptedTool, {});
		expect(running.render(100).join("\n")).toContain("Running");
		interruptedTool.updateResult({
			content: [{ type: "text", text: '{"previous_status":"running"}' }],
			isError: false,
		});
		expect(running.render(100).join("\n")).toContain("Interrupted");

		const done = new SubagentGroupComponent("/root/done");
		done.addMailboxResult(ENVELOPE);
		const completedTool = makeTool("interrupt_agent", {});
		done.addTool("interrupt_agent", completedTool, {});
		completedTool.updateResult({
			content: [{ type: "text", text: '{"previous_status":"completed"}' }],
			isError: false,
		});
		const header = done.render(100).join("\n");
		expect(header).toContain("Completed");
		expect(header).not.toContain("Interrupted");
	});

	it.each(["running", "completed", "closed"])(
		"a rejected duplicate spawn preserves an established %s child's header",
		(status) => {
			const router = new SubagentTranscriptRouter(new Container(), () => false);
			const original = makeTool("spawn_agent", { task_name: "w" });
			const startedAt = Date.now() - 10_000;
			router.handleTool(
				"spawn_agent",
				{ task_name: "w", task: { objective: "Original task" } },
				original,
				startedAt,
			);
			original.updateResult({ content: [{ type: "text", text: '{"task_name":"w"}' }], isError: false });
			if (status !== "running") {
				router.handleMailboxMessage({
					customType: "epi-collaboration-message",
					content: envelopeText({ ...ENVELOPE, from: "/root/w" }),
					timestamp: startedAt + 5_000,
				});
			}
			if (status === "closed") {
				const close = makeTool("close_agent", { target: "/root/w" });
				router.handleTool("close_agent", { target: "/root/w" }, close, startedAt + 6_000);
				close.updateResult({
					content: [{ type: "text", text: '{"previous_status":"completed"}' }],
					isError: false,
				});
			}
			const group = router.groupFor("/root/w");
			const duplicate = makeTool("spawn_agent", { task_name: "w" });
			router.handleTool(
				"spawn_agent",
				{ task_name: "w", task: { objective: "Unwanted task" } },
				duplicate,
				startedAt + 8_000,
			);
			duplicate.updateResult({
				content: [{ type: "text", text: "Collaboration tool failed: busy" }],
				isError: true,
			});
			const header = group.render(120).join("\n");
			expect(header).toContain(status === "running" ? "Running" : status === "closed" ? "Closed" : "Completed");
			expect(header).toContain(status === "running" ? "Original task" : "no proven cost");
			expect(header).not.toContain("Unwanted task");
			expect(header).not.toContain("Collaboration tool failed");
			if (status !== "running") expect(header).toContain(status === "closed" ? "6.0s" : "5.0s");
		},
	);

	it("a rejected spawn ends without a failure status badge and preserves the reason in details", () => {
		const group = new SubagentGroupComponent("/root/w");
		const tool = makeTool("spawn_agent", { task_name: "w" });
		group.addTool("spawn_agent", tool, { delegation: { task: { objective: "probe" } } });
		expect(group.render(100).join("\n")).toContain("Running");
		tool.updateResult({
			content: [
				{
					type: "text",
					text: "Collaboration tool failed: forbidden / tools_unavailable. Offending values: laser_beam.",
				},
			],
			isError: true,
		});
		const header = group.render(100).join("\n");
		expect(stripVTControlCharacters(header)).toMatch(/^↳ /);
		expect(header).not.toContain("Subagent");
		expect(header).toContain("Ended");
		expect(header).not.toContain("Failed");
		expect(header).not.toContain("Running");
		group.setExpanded(true);
		expect(group.render(100).join("\n")).toContain("Failed:");
		expect(group.render(100).join("\n")).toContain("tools_unavailable");
	});

	it("wraps the full objective without repeating the summary in the expanded header", () => {
		const objective = `${"Inspect every boundary carefully ".repeat(8)}\nSECOND_PARAGRAPH_END`;
		const group = new SubagentGroupComponent("/root/worker");
		group.addTool("spawn_agent", makeTool("spawn_agent", {}), { task: { objective } });
		group.addMailboxResult(ENVELOPE);
		group.setExpanded(true);
		const lines = group.render(40).map(stripVTControlCharacters);
		expect(lines[0]).toContain("worker");
		expect(lines[0]).not.toContain("Benchmark");
		expect(lines[0]).not.toContain("/root/");
		const taskEnd = lines.findIndex((line) => line.includes("SECOND_PARAGRAPH_END"));
		expect(taskEnd).toBeGreaterThan(2);
		const taskText = lines
			.slice(1, taskEnd + 1)
			.join(" ")
			.replace(/\s+/g, " ");
		expect(taskText).toContain(objective.replace(/\s+/g, " "));
		expect(lines.filter((line) => line.includes("Benchmark verdict"))).toHaveLength(1);
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	it.each([false, true])("preserves all result lines beyond line 30 (structured: %s)", (structured) => {
		const summary = Array.from({ length: 45 }, (_, index) => `RESULT_LINE_${index + 1}`).join("\n");
		const group = new SubagentGroupComponent("/root/worker");
		group.addMailboxResult({ ...ENVELOPE, text: structured ? JSON.stringify({ ...CONTRACT, summary }) : summary });
		group.setExpanded(true);
		const text = group.render(40).map(stripVTControlCharacters).join("\n");
		for (let line = 1; line <= 45; line++) expect(text).toContain(`RESULT_LINE_${line}`);
	});

	it("preserves multiline structured sections and items beyond prior display caps", () => {
		const group = new SubagentGroupComponent("/root/worker");
		const artifacts = Array.from({ length: 12 }, (_, index) => `ARTIFACT_${index + 1}\nDETAIL_${index + 1}`);
		const evidence = Array.from({ length: 35 }, (_, index) => `EVIDENCE_LINE_${index + 1}`).join("\n");
		group.addMailboxResult({ ...ENVELOPE, text: JSON.stringify({ ...CONTRACT, artifacts, evidence: [evidence] }) });
		group.setExpanded(true);
		const text = group.render(40).map(stripVTControlCharacters).join("\n");
		for (let item = 1; item <= 12; item++) {
			expect(text).toContain(`ARTIFACT_${item}`);
			expect(text).toContain(`DETAIL_${item}`);
		}
		expect(text).toContain("EVIDENCE_LINE_35");
		expect(text).not.toContain("+4 more");
	});

	it("places newest results and their structured sections before secondary activity", () => {
		const group = new SubagentGroupComponent("/root/worker");
		group.addTool("spawn_agent", makeTool("spawn_agent", {}), { task: { objective: "inspect" } });
		group.addMailboxResult({ ...ENVELOPE, text: "OLD_RESULT_SENTINEL" });
		group.addMailboxResult({
			...ENVELOPE,
			id: "m-2",
			turnId: "t-2",
			text: JSON.stringify({ ...CONTRACT, summary: "NEW_RESULT_SENTINEL" }),
		});
		group.setExpanded(true);
		const text = group.render(100).map(stripVTControlCharacters).join("\n");
		expect(text.indexOf("NEW_RESULT_SENTINEL")).toBeLessThan(text.indexOf("OLD_RESULT_SENTINEL"));
		expect(text.indexOf("OLD_RESULT_SENTINEL")).toBeLessThan(text.indexOf("Activity"));
		expect(text.indexOf("residual risk one")).toBeLessThan(text.indexOf("Activity"));
		expect(text).not.toContain("Task assigned");
		expect(text).not.toContain('"objective"');
	});

	it("reveals human activity receipts and toggles original diagnostics per operation", () => {
		const group = new SubagentGroupComponent("/root/worker");
		const args = { target: "/root/worker", message: "RAW_MESSAGE_SENTINEL" };
		const tool = makeTool("send_message", args);
		group.addTool("send_message", tool, args);
		group.setExpanded(true);
		const render = () => group.render(100).map(stripVTControlCharacters);
		const activityRow = render().findIndex((line) => line.includes("Activity"));
		expect(activityRow).toBeGreaterThan(0);
		expect(render().join("\n")).not.toContain("RAW_MESSAGE_SENTINEL");
		expect(group.handleOverviewClick(activityRow, 100)).toBe(true);
		expect(render().join("\n")).toContain("Message sent");
		expect(render().join("\n")).toContain("Pending");
		tool.updateResult({ content: [{ type: "text", text: "STREAMING_RAW_RECEIPT" }], isError: false }, true);
		expect(render().join("\n")).toContain("Pending");
		expect(render().join("\n")).not.toContain("STREAMING_RAW_RECEIPT");
		tool.updateResult({
			content: [{ type: "text", text: '{"status":"accepted","receipt":"RAW_RECEIPT_SENTINEL"}' }],
			isError: false,
		});
		const activity = render().join("\n");
		expect(activity).toContain("Accepted");
		expect(activity).not.toContain("RAW_RECEIPT_SENTINEL");
		const activityOperationRow = render().findIndex((line) => line.includes("Message sent"));
		expect(group.handleOverviewClick(activityOperationRow, 100)).toBe(false);
		expect(render().join("\n")).not.toContain("RAW_MESSAGE_SENTINEL");
		const diagnosticsRow = render().findIndex((line) => line.includes("Diagnostics"));
		expect(group.handleOverviewClick(diagnosticsRow, 100)).toBe(true);
		expect(render().join("\n")).toContain("Tool receipts");
		const operationRow = render().findIndex((line) => line.includes("send_message · Accepted"));
		expect(operationRow).toBeGreaterThan(diagnosticsRow);
		expect(group.handleOverviewClick(operationRow, 100)).toBe(true);
		expect(render().join("\n")).toContain("RAW_MESSAGE_SENTINEL");
		expect(render().join("\n")).toContain("RAW_RECEIPT_SENTINEL");
		expect(group.handleOverviewClick(operationRow, 100)).toBe(true);
		expect(render().join("\n")).not.toContain("RAW_RECEIPT_SENTINEL");
		expect(group.handleOverviewClick(diagnosticsRow, 100)).toBe(true);
		expect(render().join("\n")).not.toContain("Tool receipts");
		expect(group.handleOverviewClick(activityRow, 100)).toBe(true);
		expect(render().join("\n")).not.toContain("Message sent");
	});

	it.each([
		["spawn_agent", "Task assigned"],
		["followup_task", "Follow-up requested"],
		["interrupt_agent", "Interrupt requested"],
		["close_agent", "Agent closed"],
	])("shows %s failures as human activity without replacing child state", (toolName, label) => {
		const group = new SubagentGroupComponent("/root/worker");
		group.addMailboxResult(ENVELOPE);
		const tool = makeTool(toolName, {});
		group.addTool(toolName, tool, {});
		tool.updateResult({ content: [{ type: "text", text: "Collaboration tool failed: busy" }], isError: true });
		group.setExpanded(true);
		const lines = group.render(100).map(stripVTControlCharacters);
		expect(lines[0]).toContain("Completed");
		expect(
			group.handleOverviewClick(
				lines.findIndex((line) => line.includes("Activity")),
				100,
			),
		).toBe(true);
		const text = group.render(100).map(stripVTControlCharacters).join("\n");
		expect(text).toContain(label);
		expect(text).toContain("Failed");
	});

	it("renders within width at narrow and wide sizes", () => {
		const group = new SubagentGroupComponent("/root/term-bench");
		group.addMailboxResult(ENVELOPE);
		group.setExpanded(true);
		for (const width of [1, 12, 40, 80, 120]) {
			const wide = group.render(width).filter((line) => visibleWidth(line) > width);
			if (wide.length > 0) console.log(`WIDTH ${width} OVERFLOW:`, JSON.stringify(wide[0]).slice(0, 200));
			expect(wide).toEqual([]);
		}
	});
});

describe("SubagentTranscriptRouter", () => {
	let dir: string;
	beforeEach(() => {
		initTheme("dark");
		dir = mkdtempSync(join(tmpdir(), "pi-subagent-router-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("groups child-bound tools per child and mailbox results with them", () => {
		const container = new Container();
		const router = new SubagentTranscriptRouter(container, () => false);

		expect(router.handleTool("spawn_agent", { task_name: "a" }, makeTool("spawn_agent", {}))).toBe(true);
		expect(router.handleTool("followup_task", { target: "/root/a" }, makeTool("followup_task", {}))).toBe(true);
		expect(router.handleTool("spawn_agent", { task_name: "b" }, makeTool("spawn_agent", {}))).toBe(true);
		expect(router.handleTool("wait_agent", { timeout_ms: 1000 }, makeTool("wait_agent", {}))).toBe(false);
		expect(router.handleTool("bash", { command: "ls" }, makeTool("bash", {}))).toBe(false);

		// unknown child paths get a group created from the envelope (covers resumed history)
		expect(
			router.handleMailboxMessage({
				customType: "epi-collaboration-message",
				display: true,
				content: envelopeText(ENVELOPE),
			}),
		).toBe(true);
		const groups = router.currentGroups();
		expect(groups.map((group) => group.agentPath).sort()).toEqual(["/root/a", "/root/b", "/root/term-bench"]);
		expect(container.children).toHaveLength(3);

		// a new member moves the group to the latest position
		router.handleTool("send_message", { target: "/root/a" }, makeTool("send_message", {}));
		expect(container.children.at(-1)).toBe(router.groupFor("/root/a"));
	});

	it.each([42, [], {}, true, null].map((from) => ({ from })))(
		"rejects invalid mailbox sender %j without throwing",
		({ from }) => {
			const router = new SubagentTranscriptRouter(new Container(), () => false);
			expect(
				router.handleMailboxMessage({
					customType: "epi-collaboration-message",
					content: envelopeText({ ...ENVELOPE, from }),
				}),
			).toBe(false);
			expect(router.currentGroups()).toHaveLength(0);
		},
	);

	it("mailbox routing only applies to displayable collaboration messages", () => {
		const router = new SubagentTranscriptRouter(new Container(), () => false);
		expect(router.handleMailboxMessage({ customType: "other", display: true, content: "{}" })).toBe(false);
		expect(
			router.handleMailboxMessage({
				customType: "epi-collaboration-message",
				display: false,
				content: envelopeText(ENVELOPE),
			}),
		).toBe(false);
		expect(
			router.handleMailboxMessage({ customType: "epi-collaboration-message", display: true, content: "garbage" }),
		).toBe(false);
	});

	it("clear() drops group state", () => {
		const container = new Container();
		const router = new SubagentTranscriptRouter(container, () => false);
		router.handleTool("spawn_agent", { task_name: "a" }, makeTool("spawn_agent", {}));
		router.clear();
		expect(router.currentGroups()).toHaveLength(0);
	});
});
