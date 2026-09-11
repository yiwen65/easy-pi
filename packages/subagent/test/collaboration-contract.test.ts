import { describe, expect, test } from "vitest";
import {
	assertAgentTransition,
	COLLABORATION_LIMITS,
	CollaborationError,
	childAgentPath,
	collaborationWaitMs,
	DELIVER_RESULT_TOOL_NAME,
	formatCollaborationError,
	parseCollaborationArguments,
	parseDelegationResult,
	parseForkSelection,
	resolveAgentPath,
	validateAgentPath,
	validateDelegationResult,
} from "../src/collaboration-contract.ts";
import { delegation } from "./delegation-fixture.ts";

describe("collaboration contract", () => {
	test("accepts six tool calls without coercing or retaining the caller's mutable input", () => {
		const spawn = {
			task_name: "inspect",
			delegation: delegation(),
			model: "openai/model-a",
			reasoning_effort: "high",
		};
		const parsed = parseCollaborationArguments("spawn_agent", spawn);
		spawn.delegation.task.objective = "changed";
		expect(parsed.delegation.task.objective).toBe("Inspect parser");
		expect(parseCollaborationArguments("send_message", { target: "../peer", message: "Finding" })).toEqual({
			target: "../peer",
			message: "Finding",
		});
		const followup = {
			target: "/root/inspect",
			task: delegation().task,
			context: "existing",
			capabilities: { tools: "inherit" },
		};
		expect(parseCollaborationArguments("followup_task", followup)).toEqual(followup);
		expect(parseCollaborationArguments("wait_agent", {})).toEqual({});
		expect(parseCollaborationArguments("interrupt_agent", { target: "inspect" })).toEqual({ target: "inspect" });
		expect(parseCollaborationArguments("list_agents", { path_prefix: "/root" })).toEqual({ path_prefix: "/root" });
	});

	test("diagnostics allow only fixed categories, reasons and hints, not exception payloads", () => {
		const secret = "SYNTHETIC_PRIVATE_PAYLOAD";
		const known = new CollaborationError("context_unavailable", secret, "source_hash_changed");
		expect(formatCollaborationError(known)).toContain("source_hash_changed");
		expect(formatCollaborationError(known)).toContain("SHA256");
		expect(formatCollaborationError(known)).not.toContain(secret);
		for (const unknown of [new Error(secret), { code: secret, message: secret }, null]) {
			expect(formatCollaborationError(unknown)).toContain("storage_error");
			expect(formatCollaborationError(unknown)).not.toContain(secret);
		}
		Reflect.set(known, "reason", secret);
		expect(formatCollaborationError(known)).not.toContain(secret);
		Reflect.set(known, "code", secret);
		expect(formatCollaborationError(known)).toContain("storage_error");
		expect(formatCollaborationError(known)).not.toContain(secret);
		Reflect.set(known, "code", "__proto__");
		Reflect.set(known, "reason", "constructor");
		expect(formatCollaborationError(known)).toContain("storage_error");
	});

	test("accepts Pi max reasoning without silently reducing inherited effort", () => {
		expect(
			parseCollaborationArguments("spawn_agent", {
				task_name: "max-effort",
				delegation: delegation(),
				reasoning_effort: "max",
			}).reasoning_effort,
		).toBe("max");
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

describe("delegation result validation", () => {
	const valid = JSON.stringify({
		summary: "Done",
		outcome: "succeeded",
		artifacts: [],
		evidence: [],
		checks: [],
		risks: [],
	});

	test("accepts the instructed bare JSON object", () => {
		expect(validateDelegationResult(valid, "completed")).toEqual({
			contract: "valid",
			acceptance: "not_reviewed",
			outcome: "succeeded",
		});
	});

	test("tolerates one markdown fence and prose around the object", () => {
		expect(validateDelegationResult("```json\n" + valid + "\n```", "completed").contract).toBe("valid");
		expect(validateDelegationResult("```\n" + valid + "\n```", "completed").contract).toBe("valid");
		expect(validateDelegationResult("Result:\n" + valid + "\n(end of report)", "completed").contract).toBe("valid");
	});

	test("still rejects non-JSON, oversized and non-completed results", () => {
		expect(validateDelegationResult("no object here", "completed").contract).toBe("invalid");
		expect(validateDelegationResult(valid, "failed").contract).toBe("not_completed");
		expect(validateDelegationResult("x".repeat(COLLABORATION_LIMITS.maxMessageBytes + 1), "completed").contract).toBe(
			"invalid",
		);
	});
});

describe("structured delivery and close contract", () => {
	const validResult = {
		summary: "Done",
		outcome: "succeeded" as const,
		artifacts: [],
		evidence: [],
		checks: [],
		risks: [],
	};

	test("parseDelegationResult validates fields and detaches the input", () => {
		const input = { ...validResult, artifacts: ["a"] };
		const parsed = parseDelegationResult(input);
		input.artifacts.push("mutated");
		expect(parsed).toEqual({ ...validResult, artifacts: ["a"] });
		expect(() => parseDelegationResult({ ...validResult, outcome: "winning" })).toThrow(/Invalid delegation result/);
		expect(() => parseDelegationResult({ ...validResult, extra: 1 })).toThrow(/Invalid delegation result/);
	});

	test("close_agent parses a target and rejects extra fields", () => {
		expect(parseCollaborationArguments("close_agent", { target: "/root/worker" })).toEqual({
			target: "/root/worker",
		});
		expect(parseCollaborationArguments("close_agent", { target: "../peer" })).toEqual({ target: "../peer" });
		expect(() => parseCollaborationArguments("close_agent", { target: "/root/a", reason: "x" })).toThrow(
			/Invalid close_agent arguments/,
		);
	});

	test("the protocol tool name is the contracted delivery channel", () => {
		expect(DELIVER_RESULT_TOOL_NAME).toBe("deliver_result");
	});
});

describe("collaboration error detail", () => {
	test("appends offending values from trusted throw sites", () => {
		const error = new CollaborationError("forbidden", "hidden message", "tools_unavailable", ["grep", "find"]);
		const formatted = formatCollaborationError(error);
		expect(formatted).toContain("tools_unavailable");
		expect(formatted).toContain("grep, find");
		expect(formatted).not.toContain("hidden message");
	});

	test("drops detail values outside the tool-name pattern", () => {
		const error = new CollaborationError("forbidden", "hidden", "tools_unavailable", ["ok_name", "../secret path"]);
		const formatted = formatCollaborationError(error);
		expect(formatted).toContain("ok_name");
		expect(formatted).not.toContain("secret");
	});
});
