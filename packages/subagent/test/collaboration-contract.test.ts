import { describe, expect, test } from "vitest";
import {
	assertAgentTransition,
	CollaborationError,
	childAgentPath,
	collaborationWaitMs,
	parseCollaborationArguments,
	parseForkSelection,
	resolveAgentPath,
	validateAgentPath,
} from "../src/collaboration-contract.ts";

describe("collaboration contract", () => {
	test("accepts six tool calls without coercing or retaining the caller's mutable input", () => {
		const spawn = {
			task_name: "inspect",
			message: "Inspect the parser",
			model: "openai/model-a",
			reasoning_effort: "high",
		};
		const parsed = parseCollaborationArguments("spawn_agent", spawn);
		spawn.message = "changed";
		expect(parsed.message).toBe("Inspect the parser");
		expect(parseCollaborationArguments("send_message", { target: "../peer", message: "Finding" })).toEqual({
			target: "../peer",
			message: "Finding",
		});
		expect(parseCollaborationArguments("followup_task", { target: "/root/inspect", message: "Check again" })).toEqual(
			{ target: "/root/inspect", message: "Check again" },
		);
		expect(parseCollaborationArguments("wait_agent", {})).toEqual({});
		expect(parseCollaborationArguments("interrupt_agent", { target: "inspect" })).toEqual({ target: "inspect" });
		expect(parseCollaborationArguments("list_agents", { path_prefix: "/root" })).toEqual({ path_prefix: "/root" });
	});

	test.each([
		{},
		{ task_name: "x", message: "   " },
		{ task_name: "x", message: "\0" },
		{ task_name: "x", message: "界".repeat(3000) },
		{ task_name: "x", message: "x".repeat(8193) },
		{ task_name: "../escape", message: "x" },
		{ task_name: "x", message: "x", model: "unqualified" },
		{ task_name: "x", message: "x", reasoning_effort: "ultra" },
		{ task_name: "x", message: "x", fork_turns: "0" },
		{ task_name: "x", message: "x", fork_turns: 1 },
		{ task_name: "x", message: "x", unexpected: true },
	])("rejects invalid spawn input %#", (input) => {
		expect(() => parseCollaborationArguments("spawn_agent", input)).toThrow(CollaborationError);
	});

	test.each([
		["send_message", { target: "x", message: "\t" }],
		["followup_task", { target: "x", message: "界".repeat(3000) }],
		["wait_agent", { timeout_ms: "10" }],
		["wait_agent", { timeout_ms: -1 }],
		["interrupt_agent", { target: "" }],
		["list_agents", { unknown: true }],
	] as const)("validates %s at its boundary", (tool, input) => {
		expect(() => parseCollaborationArguments(tool, input)).toThrow(CollaborationError);
	});

	test("resolves peer and ancestor addresses without escaping the root tree", () => {
		expect(childAgentPath("/root", "parser")).toBe("/root/parser");
		expect(resolveAgentPath("/root/parser", "../review")).toBe("/root/review");
		expect(resolveAgentPath("/root/parser", ".")).toBe("/root/parser");
		expect(resolveAgentPath("/root/parser", "..")).toBe("/root");
		expect(resolveAgentPath("/root/parser", "/root/review")).toBe("/root/review");
		expect(() => resolveAgentPath("/root/parser", "../../elsewhere")).toThrow(/outside/);
		expect(() => childAgentPath("/root/a/b/c/d", "e")).toThrow(/nesting/);
	});

	test.each(["root/x", "/elsewhere", "/root/", "/root/..", "/root/x//y", "/root/a/b/c/d/e", "/root/a\\b", "/root/\0"])(
		"rejects noncanonical path %s",
		(path) => {
			expect(() => validateAgentPath(path)).toThrow(CollaborationError);
		},
	);

	test("fork selection uses explicit modes and positive turn counts", () => {
		expect(parseForkSelection()).toEqual({ mode: "all" });
		expect(parseForkSelection("none")).toEqual({ mode: "none" });
		expect(parseForkSelection("3")).toEqual({ mode: "last-turns", turns: 3 });
		for (const invalid of ["", "0", "-1", "NaN", "1.5", "9999999"]) {
			expect(() => parseForkSelection(invalid)).toThrow(CollaborationError);
		}
	});

	test("wait clamps only short nonnegative requests and rejects invalid deadlines", () => {
		expect(collaborationWaitMs()).toBe(30_000);
		expect(collaborationWaitMs(0)).toBe(10_000);
		expect(collaborationWaitMs(60_000)).toBe(60_000);
		for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 3_600_001]) {
			expect(() => collaborationWaitMs(invalid)).toThrow(CollaborationError);
		}
	});

	test("completion is reusable but pending/running work cannot be closed", () => {
		assertAgentTransition("pending", "running");
		assertAgentTransition("running", "completed");
		assertAgentTransition("completed", "running");
		assertAgentTransition("running", "interrupted");
		assertAgentTransition("interrupted", "closed");
		expect(() => assertAgentTransition("pending", "closed")).toThrow(/Cannot transition/);
		expect(() => assertAgentTransition("running", "closed")).toThrow(/Cannot transition/);
		expect(() => assertAgentTransition("closed", "running")).toThrow(/Cannot transition/);
	});
});
