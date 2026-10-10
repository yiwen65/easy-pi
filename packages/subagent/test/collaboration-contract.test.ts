import { Buffer } from "node:buffer";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
	assertAgentTransition,
	COLLABORATION_HISTORY_LIMITS,
	COLLABORATION_LIMITS,
	CollaborationArtifactSchema,
	CollaborationArtifactsSchema,
	CollaborationError,
	CollaborationSchemas,
	childAgentPath,
	collaborationWaitMs,
	DELIVER_RESULT_TOOL_NAME,
	formatCollaborationError,
	normalizeDelegation,
	parseCollaborationArguments,
	parseDelegationResult,
	parseDelegationResultText,
	parseForkSelection,
	parseStagedCollaborationArguments,
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
			task: { objective: delegation().task.objective },
			relationship: "continue" as const,
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
			task: { objective: delegation().task.objective },
			relationship: "continue" as const,
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

	test("limit diagnostics identify resources without exposing exception text", () => {
		const cases = [
			["team_agents_full", "Close settled children"],
			["team_history_full", "new root session"],
			["execution_slots_full", "execution slots"],
			["mailbox_full", "mailbox"],
			["loaded_sessions_full", "idle persisted child"],
		] as const;
		for (const [reason, hint] of cases) {
			const error = new CollaborationError("limit_reached", "SYNTHETIC_PRIVATE_PAYLOAD");
			Reflect.set(error, "reason", reason);
			const formatted = formatCollaborationError(error);
			expect(formatted).toContain(`limit_reached / ${reason}`);
			expect(formatted).toContain(hint);
			expect(formatted).not.toContain("SYNTHETIC_PRIVATE_PAYLOAD");
		}
	});

	test("accepts objective text through 40,000 characters and rejects 40,001", () => {
		const atLimit = "界".repeat(COLLABORATION_LIMITS.maxTaskCharacters);
		expect(
			parseCollaborationArguments("spawn_agent", {
				task_name: "large",
				task: { objective: atLimit },
				context: "isolated",
			}).task.objective,
		).toBe(atLimit);
		expect(() =>
			parseCollaborationArguments("spawn_agent", {
				task_name: "too-large",
				task: { objective: `${atLimit}x` },
				context: "isolated",
			}),
		).toThrow(CollaborationError);
	});

	test("relationship is top-level in both wire tools but remains nested in canonical delegations", () => {
		const spawn = parseCollaborationArguments("spawn_agent", {
			task_name: "worker",
			task: { objective: "Audit parser" },
			relationship: "verify",
		});
		expect(validateDelegation({ task: spawn.task, relationship: spawn.relationship }).context).toEqual({
			mode: "isolated",
		});
		expect(validateDelegation({ task: spawn.task, relationship: spawn.relationship }).task.relationship).toBe(
			"verify",
		);
		expect(() => validateDelegation({ task: spawn.task, relationship: "verify", context: "fork" })).toThrow(
			expect.objectContaining({ reason: "independent_needs_fresh_context" }),
		);
		expect(() =>
			validateDelegation({ task: { objective: "x", relationship: "continue" }, relationship: "verify" }),
		).toThrow(expect.objectContaining({ reason: "invalid_delegation" }));
		expect(
			parseCollaborationArguments("spawn_agent", { task_name: "worker", task: { objective: "x" } }),
		).toMatchObject({
			task: { objective: "x" },
		});
		expect(
			parseCollaborationArguments("followup_task", {
				target: "worker",
				task: { objective: "Review" },
				relationship: "verify",
			}),
		).toMatchObject({ relationship: "verify" });
		for (const name of ["spawn_agent", "followup_task"] as const) {
			const target = name === "spawn_agent" ? { task_name: "worker" } : { target: "worker" };
			expect(() =>
				parseCollaborationArguments(name, {
					...target,
					task: { objective: "x", relationship: "verify" },
				}),
			).toThrow(/Invalid/);
			expect(() =>
				parseCollaborationArguments(name, {
					...target,
					task: { objective: "x", relationship: "verify" },
					relationship: "explore",
				}),
			).toThrow(/Invalid/);
		}
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

describe("staged result reliability contract", () => {
	test("requires a target and never chooses precedence between result selectors", () => {
		for (const selection of [{}, { turn_id: "turn-1" }, { message_id: "message-1" }]) {
			const input = { target: "worker", ...selection };
			expect(parseStagedCollaborationArguments("get_agent_result", input)).toEqual(input);
		}
		for (const input of [
			{},
			{ turn_id: "turn-1" },
			{ target: "worker", turn_id: "turn-1", message_id: "message-1" },
			{ target: "worker", turn_id: "" },
			{ target: "worker", message_id: " " },
			{ target: "worker", turn_id: "x".repeat(129) },
			{ target: "worker", extra: true },
		]) {
			expect(() => parseStagedCollaborationArguments("get_agent_result", input)).toThrow(CollaborationError);
		}
	});

	test("bounds pagination without coercion and detaches staged inputs", () => {
		const input = { target: "worker", limit: COLLABORATION_HISTORY_LIMITS.maxPageSize, cursor: "opaque_cursor" };
		const parsed = parseStagedCollaborationArguments("list_agent_turns", input);
		input.target = "changed";
		expect(parsed.target).toBe("worker");
		expect(parseStagedCollaborationArguments("list_agent_turns", { target: "worker" })).toEqual({ target: "worker" });
		for (const limit of [0, 21, 1.5, "10", Number.NaN]) {
			expect(() => parseStagedCollaborationArguments("list_agent_turns", { target: "worker", limit })).toThrow(
				CollaborationError,
			);
		}
		for (const cursor of ["", "x".repeat(513), "../foreign", 1]) {
			expect(() => parseStagedCollaborationArguments("list_agent_turns", { target: "worker", cursor })).toThrow(
				CollaborationError,
			);
		}
	});

	test("targeted wait requires target for a turn and preserves old timeout bounds", () => {
		for (const input of [
			{},
			{ timeout_ms: 0 },
			{ target: "worker" },
			{ target: "worker", turn_id: "turn-1", timeout_ms: COLLABORATION_LIMITS.maxWaitMs },
		]) {
			expect(parseStagedCollaborationArguments("wait_agent", input)).toEqual(input);
		}
		for (const input of [
			{ turn_id: "turn-1" },
			{ target: "worker", turn_id: "" },
			{ target: "worker", message_id: "message-1" },
			{ target: "worker", timeout_ms: -1 },
			{ target: "worker", timeout_ms: COLLABORATION_LIMITS.maxWaitMs + 1 },
		]) {
			expect(() => parseStagedCollaborationArguments("wait_agent", input)).toThrow(CollaborationError);
		}
	});

	test("result queries, targeted wait and bounded artifact references are live", () => {
		expect(Object.keys(CollaborationSchemas)).toEqual([
			"spawn_agent",
			"send_message",
			"followup_task",
			"wait_agent",
			"interrupt_agent",
			"close_agent",
			"list_agents",
			"get_agent_result",
			"list_agent_turns",
		]);
		expect(parseCollaborationArguments("get_agent_result", { target: "worker" })).toEqual({ target: "worker" });
		expect(parseCollaborationArguments("list_agent_turns", { target: "worker", limit: 20 })).toEqual({
			target: "worker",
			limit: 20,
		});
		expect(parseCollaborationArguments("wait_agent", { target: "worker" })).toEqual({ target: "worker" });
		expect(() => parseCollaborationArguments("wait_agent", { turn_id: "turn-1" })).toThrow(CollaborationError);
		expect(parseDelegationResult({ summary: "Done", outcome: "succeeded", artifacts: [] })).toMatchObject({
			artifacts: [],
		});
	});

	test("reserves a minimal bounded artifact reference, not acceptance or executable evidence", () => {
		expect(Value.Check(CollaborationArtifactSchema, { path: "report.md", purpose: "Full test report" })).toBe(true);
		expect(
			Value.Check(CollaborationArtifactSchema, { path: "report.md", purpose: "Evidence", sha256: "a".repeat(64) }),
		).toBe(true);
		const reference = { path: "report.md", purpose: "Evidence" };
		expect(Value.Check(CollaborationArtifactsSchema, Array(8).fill(reference))).toBe(true);
		expect(Value.Check(CollaborationArtifactsSchema, Array(9).fill(reference))).toBe(false);
		for (const artifact of [
			{ path: "report.md", purpose: " " },
			{ path: "x".repeat(2049), purpose: "Evidence" },
			{ path: "report.md", purpose: "x".repeat(257) },
			{ path: "report.md", purpose: "Evidence", sha256: "A".repeat(64) },
			{ path: "report.md", purpose: "Evidence", accepted: true },
		])
			expect(Value.Check(CollaborationArtifactSchema, artifact)).toBe(false);
	});

	test("bounded fixture favors incremental rows over growing snapshot history rewrites", () => {
		const rows: { turn_id: string; delegation: ReturnType<typeof delegation>; preview: string }[] = [];
		let snapshotBytes = 0;
		let incrementalBytes = 0;
		for (let index = 1; index <= 4; index++) {
			const row = { turn_id: `turn-${index}`, delegation: delegation(), preview: "界".repeat(128) };
			rows.push(row);
			snapshotBytes += Buffer.byteLength(JSON.stringify(rows));
			incrementalBytes += Buffer.byteLength(JSON.stringify(row));
		}
		expect(snapshotBytes).toBeGreaterThan(incrementalBytes * 2);
		expect(COLLABORATION_HISTORY_LIMITS.maxRetainedTurns).toBe(4096);
		expect(COLLABORATION_LIMITS.maxRetainedAgents).toBe(2048);
		const maxTurnBytes =
			COLLABORATION_LIMITS.maxDelegationBytes +
			COLLABORATION_LIMITS.maxResultBytes +
			COLLABORATION_HISTORY_LIMITS.maxTurnMetadataBytes;
		expect(maxTurnBytes * COLLABORATION_HISTORY_LIMITS.maxRetainedTurns).toBe(1312 * 1024 * 1024);
	});

	test("retention and unavailable-history diagnostics are fixed safe hints", () => {
		expect(
			formatCollaborationError(new CollaborationError("limit_reached", "secret", "turn_history_full")),
		).toContain("new root session");
		expect(
			formatCollaborationError(new CollaborationError("context_unavailable", "secret", "history_unavailable")),
		).not.toContain("secret");
		expect(formatCollaborationError(new CollaborationError("invalid_arguments", "secret", "unknown_turn"))).toContain(
			"list_agent_turns",
		);
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
		expect(validateDelegationResult("x".repeat(COLLABORATION_LIMITS.maxResultBytes + 1), "completed").contract).toBe(
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

	test("unsupported sections and malformed artifact arrays are rejected", () => {
		const base = { summary: "done", outcome: "succeeded" };
		for (const field of ["artifacts", "evidence", "checks", "risks"]) {
			expect(validateDelegationResult(JSON.stringify({ ...base, [field]: ["x"] }), "completed").contract).toBe(
				"invalid",
			);
		}
		expect(validateDelegationResult(JSON.stringify({ ...base, extra: 1 }), "completed").contract).toBe("invalid");
	});
});

describe("bounded report references", () => {
	test("minimal result stays valid and optional refs are detached, not read or accepted", () => {
		const ref = { path: "/tmp/nonexistent-report.txt", purpose: "Full verification", sha256: "a".repeat(64) };
		const input = { summary: "Report available", outcome: "partial" as const, artifacts: [ref] };
		const result = parseDelegationResult(input);
		ref.path = "changed";
		expect(result.artifacts?.[0].path).toBe("/tmp/nonexistent-report.txt");
		expect(parseDelegationResultText(`Result:\n${JSON.stringify(result)}\n(end)`)).toEqual(result);
		expect(validateDelegationResult(JSON.stringify(result), "completed")).toEqual({
			contract: "valid",
			outcome: "partial",
		});
		expect(result).not.toHaveProperty("acceptance");
	});

	test("ref count, hash, NUL and complete multi-byte delivery budgets are enforced", () => {
		const base = { summary: "报告", outcome: "succeeded" as const };
		const ref = { path: "report.txt", purpose: "Tests" };
		expect(parseDelegationResult({ ...base, artifacts: Array(8).fill(ref) }).artifacts).toHaveLength(8);
		for (const artifacts of [
			Array(9).fill(ref),
			[{ ...ref, sha256: "A".repeat(64) }],
			[{ ...ref, path: "bad\0path" }],
			[{ ...ref, purpose: "bad\0purpose" }],
		])
			expect(() => parseDelegationResult({ ...base, artifacts })).toThrow(CollaborationError);
		const large = {
			...base,
			summary: "界".repeat(16_384),
			artifacts: Array(8).fill({ path: "界".repeat(2048), purpose: "Full report" }),
		};
		expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(COLLABORATION_LIMITS.maxResultBytes);
		expect(() => parseDelegationResult(large)).toThrow(/65536-byte/);
		expect(validateDelegationResult(JSON.stringify(large), "completed").contract).toBe("invalid");
		const legal = { ...base, artifacts: Array(8).fill({ path: "界".repeat(100), purpose: "Full report" }) };
		expect(parseDelegationResult(legal)).toEqual(legal);
	});
});

describe("structured delivery and close contract", () => {
	const validResult = {
		summary: "Done",
		outcome: "succeeded" as const,
	};

	test("accepts complete Chinese summaries at 16,384 characters and rejects one more", () => {
		const summary = "界".repeat(16_384);
		const result = { ...validResult, summary };
		expect(parseDelegationResult(result)).toEqual(result);
		expect(parseDelegationResultText(JSON.stringify(result))).toEqual(result);
		expect(() => parseDelegationResult({ ...result, summary: `${summary}界` })).toThrow(/Invalid delegation result/);
	});

	test("measures JSON escaping at the exact result byte boundary", () => {
		const overhead = Buffer.byteLength(JSON.stringify({ ...validResult, summary: "" }));
		const remaining = 64 * 1024 - overhead;
		const summary = "\u0001".repeat(Math.floor(remaining / 6)) + "x".repeat(remaining % 6);
		const result = { ...validResult, summary };
		const text = JSON.stringify(result);
		expect(Buffer.byteLength(text)).toBe(64 * 1024);
		expect(parseDelegationResult(result)).toEqual(result);
		expect(parseDelegationResultText(text)).toEqual(result);
		expect(() => parseDelegationResult({ ...result, summary: `${summary}x` })).toThrow(/65536-byte/);
		expect(() => parseDelegationResultText(`${text} `)).toThrow(/65536-byte/);
	});

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
