import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolError } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import {
	assertFixturePath,
	assertToolBoundary,
	createEvalCases,
	createEvalSession,
	EVAL_LIMITS,
	EVAL_ORDER,
	EvalBudget,
	gradeFixture,
	guardedCommand,
	materialize,
	PROFILE_NAMES,
	safeEnvironment,
	saveContentFree,
	sessionContract,
	verifyFixture,
} from "./unified-tools-real-eval.ts";

const roots: string[] = [];
function temporaryRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-unified-unit-")));
	roots.push(root);
	return root;
}
function usage(tokens = 100, cost = 0.01): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("new unified-tools evaluation contract", () => {
	it("uses new cases with paired counterbalanced order and a bounded worst-case request allocation", () => {
		expect(createEvalCases().map((entry) => entry.id)).toEqual(["U-01", "U-02", "U-03", "U-04"]);
		expect(EVAL_ORDER.map((slot) => slot.profile)).toEqual([
			"legacy",
			"v2",
			"v2",
			"legacy",
			"legacy",
			"v2",
			"v2",
			"legacy",
		]);
		expect(new Set(EVAL_ORDER.map((slot) => slot.attemptId)).size).toBe(8);
		expect(EVAL_ORDER.length * EVAL_LIMITS.sessionRequests).toBe(EVAL_LIMITS.requests);
	});

	for (const entry of createEvalCases()) {
		it(`${entry.id}: initial oracle/check fail, intended repair passes, collateral and extra writes fail`, () => {
			const cwd = temporaryRoot();
			materialize(cwd, entry.initial);
			expect(gradeFixture(cwd, entry)).toBe(false);
			expect(verifyFixture(cwd, entry)).toBe(false);
			materialize(cwd, entry.expected);
			expect(gradeFixture(cwd, entry)).toBe(true);
			expect(verifyFixture(cwd, entry)).toBe(true);
			const untouched = Object.keys(entry.initial).find((path) => !(path in entry.expected))!;
			writeFileSync(join(cwd, untouched), "collateral change\n");
			expect(gradeFixture(cwd, entry)).toBe(false);
			writeFileSync(join(cwd, untouched), entry.initial[untouched]);
			writeFileSync(join(cwd, "unexpected.txt"), "extra\n");
			expect(gradeFixture(cwd, entry)).toBe(false);
		});
	}

	it("grades requested JSON semantically without accepting extra keys", () => {
		const entry = createEvalCases()[3];
		const cwd = temporaryRoot();
		materialize(cwd, { ...entry.initial, ...entry.expected });
		writeFileSync(join(cwd, "service/timeouts.json"), '{"requestMs":24000,"connectMs":6000}');
		expect(gradeFixture(cwd, entry)).toBe(true);
		writeFileSync(join(cwd, "service/timeouts.json"), '{"requestMs":24000,"connectMs":6000,"extra":true}');
		expect(gradeFixture(cwd, entry)).toBe(false);
	});

	it("rejects outside, home, URL, nested operation and symlink escapes", () => {
		const cwd = temporaryRoot();
		expect(() => assertFixturePath(cwd, ".")).not.toThrow();
		for (const path of ["../secret", "~/.pi/auth.json", "https://example.invalid/data", "/etc/passwd"]) {
			expect(() => assertToolBoundary(cwd, { operations: [{ kind: "move", path: "valid", to: path }] })).toThrow(
				"workspace_boundary",
			);
		}
		symlinkSync(tmpdir(), join(cwd, "escape"));
		expect(() => assertFixturePath(cwd, "escape/other")).toThrow("workspace_boundary");
	});

	it("uses an exact command allowlist, enforces cwd, protects verifiers and strips inherited secrets", () => {
		const cwd = temporaryRoot();
		const entry = createEvalCases()[3];
		materialize(cwd, entry.initial);
		for (const command of ["env", "cat ~/.pi/auth.json", "node check.cjs; env", "curl example.invalid"]) {
			expect(() => guardedCommand(cwd, entry, command, join(cwd, "service"))).toThrow("restricted_command");
		}
		expect(() => guardedCommand(cwd, entry, "node check.cjs", cwd)).toThrow("verification_cwd");
		expect(guardedCommand(cwd, entry, "node check.cjs", join(cwd, "service"))).toContain(process.execPath);
		writeFileSync(join(cwd, "service/check.cjs"), "process.exit(0)");
		expect(() => guardedCommand(cwd, entry, "node check.cjs", join(cwd, "service"))).toThrow("protected_verifier");
		expect(Object.keys(safeEnvironment(cwd)).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]);
	});

	it("persists only sanitized records and refuses overwriting immutable attempts", () => {
		const path = join(temporaryRoot(), "attempt.json");
		expect(() => saveContentFree(path, { command: "private command" })).toThrow();
		expect(() => saveContentFree(path, { status: "secret\ncontent" })).toThrow();
		saveContentFree(path, { status: "passed", requests: 1 }, true);
		expect(() => saveContentFree(path, { status: "failed" }, true)).toThrow();
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ status: "passed", requests: 1 });
	});

	it("reserves before dispatch and reconciles reported usage", () => {
		const snapshots: number[] = [];
		const budget = new EvalBudget(Date.now(), (state) => snapshots.push(state.requests));
		budget.startAttempt(EVAL_ORDER[0].attemptId);
		budget.reserve(400_000, 1);
		expect(budget.state.pending).toEqual({ tokens: 400_000, costUsd: 1 });
		expect(() => budget.reserve(400_000, 1)).toThrow("usage_unreconciled");
		budget.commit(usage());
		expect(budget.state.pending).toBeUndefined();
		expect(budget.tokens).toBe(100);
		expect(snapshots).toEqual([0, 1, 1]);
		expect(() => budget.startAttempt(EVAL_ORDER[0].attemptId)).toThrow("attempt_not_permitted");
	});

	it("blocks request, token, cost and wall-time exhaustion before another dispatch", () => {
		const requests = new EvalBudget(Date.now());
		for (let i = 0; i < EVAL_LIMITS.requests; i += 1) {
			requests.reserve(100, 0.1);
			requests.commit(usage());
		}
		expect(() => requests.reserve(1, 0.1)).toThrow("request_budget");
		const tokens = new EvalBudget(Date.now());
		tokens.reserve(500_000, 1);
		tokens.commit(usage(500_000));
		expect(() => tokens.reserve(400_000, 1)).toThrow("token_budget");
		const costs = new EvalBudget(Date.now());
		costs.reserve(100, 14);
		costs.commit(usage(100, 14));
		expect(() => costs.reserve(100, 2)).toThrow("cost_budget");
		const time = new EvalBudget(Date.now() - EVAL_LIMITS.elapsedMs - 1);
		expect(() => time.reserve(1, 0.1)).toThrow("time_budget");
	});

	it("never treats missing usage or an exceeded reservation as free", () => {
		const unknown = new EvalBudget(Date.now());
		unknown.reserve(400_000, 1);
		expect(() => unknown.commit(usage(0, 0))).toThrow("usage_unknown");
		expect(unknown.state.pending?.tokens).toBe(400_000);
		expect(() => unknown.reserve(1, 0.01)).toThrow("usage_unreconciled");
		const exceeded = new EvalBudget(Date.now());
		exceeded.reserve(1, 0.01);
		exceeded.commit(usage(2, 0.02));
		expect(exceeded.state.stop).toBe("reservation_exceeded");
		expect(() => exceeded.reserve(1, 0.01)).toThrow("usage_unreconciled");
	});

	for (const profile of ["legacy", "v2"] as const) {
		it(`${profile}: production SDK schema, safe shell errors, Search and disabled compaction`, async () => {
			const cwd = temporaryRoot();
			const entry = createEvalCases()[2];
			materialize(cwd, entry.initial);
			const previous = process.env.PI_HF_COMPACTION;
			process.env.PI_HF_COMPACTION = "off";
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const host = await createEvalSession({ cwd, agentDir: temporaryRoot(), entry, profile, runtime });
			try {
				expect(host.session.getActiveToolNames().sort()).toEqual([...PROFILE_NAMES[profile]].sort());
				expect(host.session.hfCompactionHost).toBeUndefined();
				const bash = host.session.agent.state.tools.find((tool) => tool.name === "bash")!;
				expect(bash.parameters.properties).toHaveProperty("cwd");
				const failed = await bash
					.execute("failure", { command: entry.verifyCommand }, undefined)
					.catch((error: unknown) => error);
				expect(failed).toBeInstanceOf(AgentToolError);
				expect((failed as AgentToolError).details).toMatchObject({
					exitCode: 1,
					terminationReason: "exit",
					timedOut: false,
				});
				materialize(cwd, entry.expected);
				expect((await bash.execute("success", { command: entry.verifyCommand }, undefined)).details).toMatchObject({
					exitCode: 0,
				});
				await expect(bash.execute("blocked", { command: "env" }, undefined)).rejects.toThrow();
				if (profile === "v2") {
					const search = host.session.agent.state.tools.find((tool) => tool.name === "search")!;
					const result = await search.execute(
						"search",
						{ query: "cap", path: "src", kind: "text", mode: "literal" },
						undefined,
					);
					expect(JSON.stringify(result.content)).toContain("quota.mjs");
				}
				expect(gradeFixture(cwd, entry)).toBe(true);
				expect(sessionContract(host.session, cwd, temporaryRoot()).schemaHash).toMatch(/^[a-f0-9]{64}$/);
			} finally {
				await host.close();
				if (previous === undefined) delete process.env.PI_HF_COMPACTION;
				else process.env.PI_HF_COMPACTION = previous;
			}
		});
	}
});
