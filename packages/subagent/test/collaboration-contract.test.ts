import { describe, expect, test } from "vitest";
import {
	assertAgentTransition,
	COLLABORATION_LIMITS,
	CollaborationError,
	childAgentPath,
	collaborationWaitMs,
	DELIVER_RESULT_TOOL_NAME,
	formatCollaborationError,
	normalizeDelegation,
	parseCollaborationArguments,
	parseDelegationResult,
	parseForkSelection,
	resolveAgentPath,
	validateAgentPath,
	validateDelegation,
	validateDelegationResult,
} from "../src/collaboration-contract.ts";
import { delegation } from "./delegation-fixture.ts";

describe("collaboration contract", () => {
	test("accepts six tool calls without coercing or retaining the caller's mutable input", () => {
		const spawn = {
			task_name: "inspect",
			task: delegation().task,
			context: { mode: "isolated" as const },
			tools: "inherit" as const,
		};
		const parsed = parseCollaborationArguments("spawn_agent", spawn);
		spawn.task.objective = "changed";
		expect(parsed.task.objective).toBe("Inspect parser");
		expect(parseCollaborationArguments("send_message", { target: "../peer", message: "Finding" })).toEqual({
			target: "../peer",
			message: "Finding",
		});
		const followup = {
			target: "/root/inspect",
			task: delegation().task,
			tools: "inherit" as const,
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

	test("child model and effort are not settable per call anymore", () => {
		expect(() =>
			parseCollaborationArguments("spawn_agent", {
				task_name: "max-effort",
				task: delegation().task,
				context: { mode: "isolated" },
				capabilities: { tools: "inherit" },
				reasoning_effort: "max",
			}),
		).toThrow(/Invalid spawn_agent arguments/);
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
	});

	test("accepts the instructed bare JSON object", () => {
		expect(validateDelegationResult(valid, "completed")).toEqual({
			contract: "valid",
			outcome: "succeeded",
		});
	});

	test("tolerates one markdown fence and prose around the object", () => {
		expect(validateDelegationResult(`\`\`\`json\n${valid}\n\`\`\``, "completed").contract).toBe("valid");
		expect(validateDelegationResult(`\`\`\`\n${valid}\n\`\`\``, "completed").contract).toBe("valid");
		expect(validateDelegationResult(`Result:\n${valid}\n(end of report)`, "completed").contract).toBe("valid");
	});

	test("still rejects non-JSON, oversized and non-completed results", () => {
		expect(validateDelegationResult("no object here", "completed").contract).toBe("invalid");
		expect(validateDelegationResult(valid, "failed").contract).toBe("not_completed");
		expect(validateDelegationResult("x".repeat(COLLABORATION_LIMITS.maxMessageBytes + 1), "completed").contract).toBe(
			"invalid",
		);
	});
});

describe("relaxed delegation result", () => {
	test("accepts the minimal form (summary + outcome only)", () => {
		expect(
			validateDelegationResult(JSON.stringify({ summary: "done", outcome: "succeeded" }), "completed"),
		).toMatchObject({ contract: "valid", outcome: "succeeded" });
	});

	test("the removed array fields are now rejected, not shape-checked", () => {
		const base = { summary: "done", outcome: "succeeded" };
		for (const field of ["artifacts", "evidence", "checks", "risks"]) {
			expect(validateDelegationResult(JSON.stringify({ ...base, [field]: ["x"] }), "completed").contract).toBe(
				"invalid",
			);
		}
		expect(validateDelegationResult(JSON.stringify({ ...base, extra: 1 }), "completed").contract).toBe("invalid");
	});
});

describe("structured delivery and close contract", () => {
	const validResult = {
		summary: "Done",
		outcome: "succeeded" as const,
	};

	test("parseDelegationResult validates fields and detaches the input", () => {
		const input = { ...validResult };
		const parsed = parseDelegationResult(input);
		input.summary = "mutated";
		expect(parsed).toEqual(validResult);
		expect(() => parseDelegationResult({ ...validResult, outcome: "winning" })).toThrow(/Invalid delegation result/);
		expect(() => parseDelegationResult({ ...validResult, extra: 1 })).toThrow(/Invalid delegation result/);
		// removed array sections are rejected, not ignored
		expect(() => parseDelegationResult({ ...validResult, artifacts: ["a"] })).toThrow(/Invalid delegation result/);
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

	test("formats the available tool list only when entries are tool-name shaped", () => {
		const error = new CollaborationError(
			"forbidden",
			"hidden",
			"tools_unavailable",
			["laser_beam"],
			["read", "bash", "../secret"],
		);
		const formatted = formatCollaborationError(error);
		expect(formatted).toContain("Offending values: laser_beam");
		expect(formatted).toContain("Available: read, bash");
		expect(formatted).not.toContain("secret");
	});
});

describe("relaxed delegation input", () => {
	test("normalizes the minimal form with canonical defaults", () => {
		const normalized = normalizeDelegation({ task: { objective: "Audit parser" } });
		// no filler defaults: only relationship/version/capabilities are canonicalized;
		// context derives from the task type (continue forks)
		expect(normalized).toEqual({
			version: 1,
			task: {
				relationship: "continue",
				objective: "Audit parser",
			},
			context: { mode: "fork", turns: "all", prefix: "rebuild" },
			capabilities: { tools: "inherit" },
		});
		expect(validateDelegation({ task: { objective: "Audit parser" } })).toEqual(normalized);
	});

	test("derives context from the relationship when omitted", () => {
		expect(normalizeDelegation({ task: { objective: "x", relationship: "explore" } }).context).toEqual({
			mode: "isolated",
		});
		expect(normalizeDelegation({ task: { objective: "x" } }).context).toEqual({
			mode: "fork",
			turns: "all",
			prefix: "rebuild",
		});
		expect(() => normalizeDelegation({ task: { objective: "x", relationship: "extract" } })).toThrow(
			expect.objectContaining({ reason: "curated_needs_references" }),
		);
		// explicit context wins over derivation
		expect(normalizeDelegation({ task: { objective: "x" }, context: "isolated" }).context).toEqual({
			mode: "isolated",
		});
	});

	test("expands shorthand context forms", () => {
		expect(normalizeDelegation({ task: { objective: "x" }, context: "fork" }).context).toEqual({
			mode: "fork",
			turns: "all",
			prefix: "rebuild",
		});
		expect(
			normalizeDelegation({ task: { objective: "x" }, context: { mode: "fork", preservePrefix: true } }).context,
		).toEqual({ mode: "fork", turns: "all", prefix: "preserve" });
		expect(() => normalizeDelegation({ task: { objective: "x" }, context: "curated" })).toThrow(
			expect.objectContaining({ reason: "curated_needs_references" }),
		);
	});

	test("normalizes namespaced tool names and keeps complete contracts intact", () => {
		const normalized = normalizeDelegation({
			task: { objective: "x" },
			capabilities: { tools: ["functions.read", "bash"] },
		});
		expect(normalized.capabilities).toEqual({ tools: ["read", "bash"] });
		const full = delegation();
		expect(normalizeDelegation(full)).toEqual(full);
	});

	test("semantic conflicts carry self-healing reasons", () => {
		const exploreFork = () =>
			validateDelegation({
				task: { relationship: "explore", objective: "audit" },
				context: "fork",
			});
		expect(exploreFork).toThrow(expect.objectContaining({ reason: "independent_needs_fresh_context" }));
		let formatted = "";
		try {
			exploreFork();
		} catch (error) {
			formatted = formatCollaborationError(error);
		}
		expect(formatted).toContain("isolated or curated");
		expect(formatted).toContain("relationship=continue");

		expect(() =>
			validateDelegation({
				task: { objective: "x" },
				context: { mode: "fork", turns: "3", prefix: "preserve" },
			}),
		).toThrow(expect.objectContaining({ reason: "preserve_needs_all_turns" }));

		expect(() => validateDelegation({ task: {} })).toThrow(expect.objectContaining({ reason: "invalid_delegation" }));
	});
});
