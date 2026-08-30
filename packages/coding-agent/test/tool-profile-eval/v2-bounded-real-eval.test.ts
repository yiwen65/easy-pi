import { describe, expect, it } from "vitest";
import {
	assertContentFreeRecord,
	assertProviderContextBoundary,
	classifyToolResultText,
	initialBudgetState,
	loadV2BoundedRealEvalManifest,
	normalizeFrozenSystemPrompt,
	ProviderContextMetricsAccumulator,
	sha256,
	stableHash,
	statusEntriesTouchOnlyTarget,
	toolRequestFingerprint,
	V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256,
	V2BoundedEvalBudgetLedger,
} from "./v2-bounded-real-eval.ts";

const manifest = loadV2BoundedRealEvalManifest();
const developmentCase = manifest.cases.find((entry) => entry.id === "D-01");
if (!developmentCase) throw new Error("sealed D-01 case is missing");

describe("v2 bounded real evaluation contract", () => {
	it("loads the sealed disjoint public-repository matrix", () => {
		expect(V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256).toHaveLength(64);
		expect(manifest.baselineCommit).toBe("51a6534c9");
		expect(manifest.provider.frozenToolContract.toolNames).toEqual(["search", "read", "edit", "run"]);
		expect(manifest.provider.chat).toMatchObject({
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			thinkingLevel: "max",
			compactionMode: "off",
			providerRetries: 0,
		});
		expect(manifest.cases.map((entry) => entry.id)).toEqual(["D-01", "D-02", "H-01", "H-02"]);
		const development = manifest.cases.filter((entry) => entry.stage === "development");
		const heldOut = manifest.cases.filter((entry) => entry.stage === "held_out");
		expect(new Set(development.map((entry) => entry.repository))).toEqual(new Set(["vscode"]));
		expect(new Set(heldOut.map((entry) => entry.repository))).toEqual(new Set(["vitest"]));
		expect(new Set(development.map((entry) => entry.taskFamily))).not.toEqual(
			new Set(heldOut.map((entry) => entry.taskFamily)),
		);
		expect(manifest.budgets.worstCaseAllocatedChatRequests).toBeLessThanOrEqual(manifest.budgets.maxChatRequests);
		expect(manifest.budgets.worstCaseAllocatedEmbeddingRequests).toBeLessThanOrEqual(
			manifest.budgets.maxEmbeddingRequests,
		);
	});

	it("normalizes every public workspace against the frozen development reference", () => {
		const contractRoot = "/tmp/sealed-contract";
		const developmentRoot = `${contractRoot}/vscode`;
		const heldOutRoot = `${contractRoot}/vitest`;
		const developmentPrompt = `cwd: ${developmentRoot}\ndocs: ${contractRoot}/docs`;
		const heldOutPrompt = `cwd: ${heldOutRoot}\ndocs: ${contractRoot}/docs`;
		expect(normalizeFrozenSystemPrompt(developmentPrompt, contractRoot, developmentRoot, developmentRoot)).toBe(
			normalizeFrozenSystemPrompt(heldOutPrompt, contractRoot, heldOutRoot, developmentRoot),
		);
		expect(developmentPrompt.replaceAll(contractRoot, "$CONTRACT_ROOT")).not.toBe(
			heldOutPrompt.replaceAll(contractRoot, "$CONTRACT_ROOT"),
		);
	});

	it("reserves requests, tokens, cost, time, and one-shot attempts before dispatch", () => {
		const writes: unknown[] = [];
		const state = initialBudgetState(1_000);
		const ledger = new V2BoundedEvalBudgetLedger(manifest, state, (next) => writes.push(next));
		ledger.startSession("baseline-D-01", 1_001);
		ledger.reserveChat("chat-1", 1_000, 2_000, 1_002);
		expect(ledger.snapshot()).toMatchObject({ chatRequests: 1, sessionsStarted: 1 });
		expect(() => ledger.reserveEmbedding("embedding-before-reconcile", 10, 1_003)).toThrow(
			"evaluation_usage_reconciliation_pending",
		);
		ledger.commitChat("chat-1", {
			inputTokens: 900,
			outputTokens: 200,
			cacheReadTokens: 100,
			cacheWriteTokens: 0,
			costUsd: 0.001,
		});
		ledger.reserveEmbedding("embedding-1", 400, 1_004);
		ledger.commitEmbedding("embedding-1", 350, 0.000_052_5);
		expect(ledger.snapshot()).toMatchObject({
			chatRequests: 1,
			embeddingRequests: 1,
			inputTokens: 900,
			outputTokens: 200,
			cacheReadTokens: 100,
			embeddingTokens: 350,
		});
		expect(() => ledger.startSession("baseline-D-01", 1_005)).toThrow("evaluation_attempt_already_started");
		expect(() => ledger.assertElapsed(1_000 + manifest.budgets.maxEvaluationElapsedMs)).toThrow(
			"evaluation_time_budget_exhausted",
		);
		expect(writes.length).toBeGreaterThanOrEqual(5);
	});

	it("fails closed after unknown paid usage and before a projected token overrun", () => {
		const unknownLedger = new V2BoundedEvalBudgetLedger(manifest, initialBudgetState(10));
		unknownLedger.startSession("baseline-D-01", 11);
		unknownLedger.reserveChat("unknown", 100, 100, 12);
		unknownLedger.markPendingUsageUnknown("provider_usage_missing");
		expect(() => unknownLedger.startSession("baseline-D-02", 13)).toThrow("evaluation_integrity_failure");

		const nearLimit = initialBudgetState(20);
		nearLimit.inputTokens = manifest.budgets.maxCombinedReportedTokens - 5;
		const tokenLedger = new V2BoundedEvalBudgetLedger(manifest, nearLimit);
		expect(() => tokenLedger.reserveEmbedding("too-large", 6, 21)).toThrow("combined_token_budget_exhausted");
	});

	it("resolves only the proven initial no-dispatch boundary false positive with an audit entry", () => {
		const ledger = new V2BoundedEvalBudgetLedger(manifest, initialBudgetState(100));
		ledger.startSession("baseline-D-01", 101);
		ledger.markIntegrityFailure("chat_usage_reservation_missing");
		ledger.resolveInitialNoDispatchBoundaryFalsePositive(102);
		expect(ledger.snapshot()).toMatchObject({
			integrityFailure: undefined,
			integrityResolutions: [
				{
					category: "chat_usage_reservation_missing",
					resolution: "allowed_static_documentation_lines",
					attemptId: "baseline-D-01",
					resolvedAtMs: 102,
				},
			],
		});
		expect(() => ledger.startSession("baseline-D-02", 103)).not.toThrow();
	});

	it("separates target correctness from wrong-location status", () => {
		expect(statusEntriesTouchOnlyTarget([], developmentCase.targetPath)).toBe(true);
		expect(statusEntriesTouchOnlyTarget([` M ${developmentCase.targetPath}`], developmentCase.targetPath)).toBe(true);
		expect(
			statusEntriesTouchOnlyTarget(
				[` M ${developmentCase.targetPath}`, "?? unrelated.ts"],
				developmentCase.targetPath,
			),
		).toBe(false);
	});

	it("normalizes workspace roots and opaque handles only for semantic duplicate fingerprints", () => {
		const root = "/private/tmp/public-repo";
		const first = { path: `${root}/src/file.ts`, locatorId: "loc_first", startLine: 2 };
		const second = { path: `${root}/src/file.ts`, locatorId: "loc_second", startLine: 2 };
		expect(toolRequestFingerprint("read", first, root, false)).not.toBe(
			toolRequestFingerprint("read", second, root, false),
		);
		expect(toolRequestFingerprint("read", first, root, true)).toBe(
			toolRequestFingerprint("read", second, root, true),
		);
		expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
	});

	it("classifies every model-visible byte and accounts repeated active results as duplicates", () => {
		const text = [
			developmentCase.targetPath,
			developmentCase.oldText,
			"view_id view_example",
			"unrelated candidate",
			"PASS",
		].join("\n");
		const labels = classifyToolResultText(text, developmentCase);
		expect(labels.useful + labels.duplicate + labels.irrelevant + labels.ambiguous).toBe(Buffer.byteLength(text));
		expect(labels.useful).toBeGreaterThan(0);
		expect(labels.ambiguous).toBeGreaterThan(0);
		expect(labels.irrelevant).toBeGreaterThan(0);

		const context = {
			systemPrompt: "public evaluator",
			messages: [{ role: "toolResult", content: [{ type: "text", text }] }],
		};
		const accumulator = new ProviderContextMetricsAccumulator(developmentCase);
		accumulator.observe(context);
		accumulator.observe(context);
		const metrics = accumulator.snapshot();
		expect(metrics.providerRequests).toBe(2);
		expect(metrics.activeToolResultContextBytes).toBe(Buffer.byteLength(text) * 2);
		expect(metrics.duplicate).toBe(Buffer.byteLength(text));
		expect(metrics.peakActiveToolResultBytes).toBe(Buffer.byteLength(text));
	});

	it("allows numeric content-free records and rejects paths, source-like strings, and forbidden payloads", () => {
		expect(() =>
			assertContentFreeRecord({
				caseId: "D-01",
				status: "completed",
				hash: sha256("public"),
				metrics: { calls: 7, success: true },
			}),
		).not.toThrow();
		expect(() => assertContentFreeRecord({ path: "src/file.ts" })).toThrow("Content-bearing record key");
		expect(() => assertContentFreeRecord({ value: "line one\nline two" })).toThrow("content-like string");

		expect(() =>
			assertProviderContextBoundary(
				{ messages: [{ role: "user", content: "/private/tmp/public/repo/src/file.ts" }] },
				{
					publicRoot: "/private/tmp/public/repo",
					forbiddenRoots: ["/Users/example/pi"],
					forbiddenValues: ["secret-value"],
				},
			),
		).not.toThrow();
		expect(() =>
			assertProviderContextBoundary(
				{ messages: [{ role: "toolResult", content: "/Users/example/pi/private.ts" }] },
				{ publicRoot: "/private/tmp/public/repo", forbiddenRoots: ["/Users/example/pi"], forbiddenValues: [] },
			),
		).toThrow("provider_context_forbidden_root");

		const staticDocumentationLine = "- Main documentation: /Users/example/pi/packages/coding-agent/README.md";
		expect(() =>
			assertProviderContextBoundary(
				{ systemPrompt: `public evaluator\n${staticDocumentationLine}\nend` },
				{
					publicRoot: "/private/tmp/public/repo",
					forbiddenRoots: ["/Users/example/pi"],
					forbiddenValues: [],
					allowedForbiddenRootLines: [staticDocumentationLine],
				},
			),
		).not.toThrow();
		expect(() =>
			assertProviderContextBoundary(
				{ systemPrompt: `${staticDocumentationLine}/private.ts` },
				{
					publicRoot: "/private/tmp/public/repo",
					forbiddenRoots: ["/Users/example/pi"],
					forbiddenValues: [],
					allowedForbiddenRootLines: [staticDocumentationLine],
				},
			),
		).toThrow("provider_context_forbidden_root");
		expect(() =>
			assertProviderContextBoundary(
				{ messages: [{ role: "toolResult", content: "secret-value" }] },
				{ publicRoot: "/private/tmp/public/repo", forbiddenRoots: [], forbiddenValues: ["secret-value"] },
			),
		).toThrow("provider_context_secret_value");
	});
});
