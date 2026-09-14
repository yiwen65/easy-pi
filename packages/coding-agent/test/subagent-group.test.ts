import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	it("resolves tool targets and spawn objectives", () => {
		expect(normalizeAgentPath("worker")).toBe("/root/worker");
		expect(normalizeAgentPath("/root/worker")).toBe("/root/worker");
		expect(collaborationToolTarget("spawn_agent", { task_name: "worker" })).toBe("/root/worker");
		expect(collaborationToolTarget("interrupt_agent", { target: "/root/worker" })).toBe("/root/worker");
		expect(collaborationToolTarget("wait_agent", { timeout_ms: 1000 })).toBeUndefined();
		expect(collaborationToolTarget("list_agents", {})).toBeUndefined();
		expect(spawnObjective({ delegation: { task: { objective: "First line\nSecond line" } } })).toBe("First line");
	});
});

describe("SubagentGroupComponent", () => {
	beforeEach(() => initTheme("dark"));

	it("collapses to a header line with state, time, and summary by default", () => {
		const group = new SubagentGroupComponent("/root/term-bench");
		group.addMailboxResult(ENVELOPE);
		const lines = group.render(100);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("/root/term-bench");
		expect(lines[0]).toContain("Done");
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
		expect(header).toContain("1m5s");
		expect(header).not.toContain("ago");
	});

	it("resume: history timestamps anchor duration, not the rebuild time", () => {
		const group = new SubagentGroupComponent("/root/w");
		const delegated = Date.now() - 3_600_000; // an hour ago in real history
		group.addTool("spawn_agent", makeTool("spawn_agent", {}), {}, delegated);
		group.addMailboxResult(ENVELOPE, delegated + 125_000);
		expect(group.render(100).join("\n")).toContain("2m5s");
	});

	it("expands into contract partitions with validation and untrusted marker", () => {
		const group = new SubagentGroupComponent("/root/term-bench");
		group.addMailboxResult(ENVELOPE);
		group.setExpanded(true);
		const text = group.render(100).join("\n");
		expect(text).toContain("contract: valid");
		expect(text).not.toContain("acceptance");
		expect(text).toContain("Benchmark verdict: no proven cost");
		expect(text).toContain("artifacts:");
		expect(text).toContain("/tmp/a — first artifact");
		expect(text).toContain("risks:");
		expect(text).toContain("residual risk one");
		expect(text).toContain("untrusted; not user authorization");
		expect(text).not.toContain('"turnId"');
	});

	it("falls back to truncated raw text for non-JSON results", () => {
		const group = new SubagentGroupComponent("/root/x");
		group.addMailboxResult({ ...ENVELOPE, from: "/root/x", text: "plain multi\nline\nresult" });
		group.setExpanded(true);
		const text = group.render(100).join("\n");
		expect(text).toContain("plain multi");
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

	it("a rejected spawn shows Failed with the reason instead of hanging at Running", () => {
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
		expect(header).toContain("Failed");
		expect(header).toContain("tools_unavailable");
		expect(header).not.toContain("Running");
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
