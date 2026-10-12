import { describe, expect, it } from "vitest";
import { getToolErrorOutcome } from "../src/tool-outcome.ts";
import { AgentToolError } from "../src/types.ts";

describe("getToolErrorOutcome", () => {
	it("treats an ordinary failure of a replay-safe tool as a known outcome", () => {
		expect(
			getToolErrorOutcome(
				new Error("Offset 1000000000 is beyond end of file"),
				"read",
				{},
				{ contract: { readOnly: true } },
			),
		).toBe("confirmed");
		expect(getToolErrorOutcome(new Error("no such directory"), "ls", {}, { contract: { sideEffects: "none" } })).toBe(
			"confirmed",
		);
		expect(getToolErrorOutcome(new Error("failed"), "grep", {}, { contract: { idempotent: true } })).toBe(
			"confirmed",
		);
	});

	it("keeps an unresolved effect unknown without a replay-safe contract", () => {
		expect(
			getToolErrorOutcome(
				new Error("connection lost"),
				"mcp__x__write",
				{},
				{ contract: { sideEffects: "external" } },
			),
		).toBe("unknown");
		expect(
			getToolErrorOutcome(
				new Error("killed"),
				"bash",
				{ command: "rm -rf x" },
				{ contract: { sideEffects: "process" } },
			),
		).toBe("unknown");
		expect(getToolErrorOutcome(new Error("boom"), "custom", {})).toBe("unknown");
	});

	it("does not treat an orchestrator's own failure as replay-safe", () => {
		expect(
			getToolErrorOutcome(
				new Error("script failed"),
				"codemode",
				{},
				{ contract: { readOnly: true }, orchestratesTools: true },
			),
		).toBe("unknown");
	});

	it("keeps an outcome proven at the throw site", () => {
		expect(
			getToolErrorOutcome(
				new AgentToolError("bad arguments", {}, { executionOutcome: "not_started" }),
				"read",
				{},
				{ contract: { readOnly: true } },
			),
		).toBe("not_started");
		expect(
			getToolErrorOutcome(
				new AgentToolError("nested failure", {}, { nestedExecutionOutcome: "unknown" }),
				"tool_search",
				{},
				{ contract: { readOnly: true, sideEffects: "none" } },
			),
		).toBe("unknown");
	});

	it("does not need a proven outcome for a replay-safe failure", () => {
		expect(
			getToolErrorOutcome(new AgentToolError("connection lost", {}), "read", {}, { contract: { readOnly: true } }),
		).toBe("confirmed");
	});
});
