import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertContentFreeRealEvalSummary,
	buildFullRealEvalCases,
	createSyntheticEmbeddingAllowlist,
	createSyntheticEmbeddingFetchGuard,
	FULL_REAL_EVAL_MAX_COST_USD,
	FULL_REAL_EVAL_MAX_HELD_OUT_SESSIONS,
	FULL_REAL_EVAL_MAX_SESSIONS,
	FULL_REAL_EVAL_MAX_TURNS,
	type FullRealEvalExecutionOutput,
	fullRealEvalShouldStopAfterTurn,
	runFullRealEvalStage,
	SystemicEvaluationError,
} from "./full-real-eval.ts";
import { createFullRealEvalFixture } from "./full-real-eval-fixtures.ts";
import type { SanitizedToolTrace } from "./trace.ts";

function emptyTrace(): SanitizedToolTrace {
	return {
		calls: [],
		toolCallCount: 0,
		toolErrorCount: 0,
		firstEditSuccess: null,
		postEditReadCount: 0,
		recoveryCallCount: 0,
		truncationCount: 0,
		toolElapsedMs: 0,
		peakContextTokens: 0,
		schemaErrorCount: 0,
		runMisuseCount: 0,
		targetFirstRead: null,
		firstSearchTargetRank: null,
		approximateSearchCount: 0,
		approximateEditWithoutTargetReadCount: 0,
	};
}

function output(overrides: Partial<FullRealEvalExecutionOutput> = {}): FullRealEvalExecutionOutput {
	return {
		success: true,
		score: 1,
		turns: 6,
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 30,
		cacheWriteTokens: 0,
		chatCostUsd: 0.01,
		embeddingCostUsd: 0.001,
		embeddingRequests: 2,
		embeddingTokens: 40,
		elapsedMs: 50,
		modelElapsedMs: 40,
		promptHash: "a".repeat(64),
		schemaHash: "b".repeat(64),
		trace: emptyTrace(),
		oracles: {
			mutationCorrect: true,
			wrongLocationsUnchanged: true,
			verificationPassed: true,
			externalChangePreserved: true,
		},
		...overrides,
	};
}

describe("full real toolchain evaluation contract", () => {
	let root: string;

	beforeEach(() => {
		root = join(tmpdir(), `pi-full-real-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	it("freezes six calibration and 42 held-out sessions with three variants per task and seed", () => {
		const calibration = buildFullRealEvalCases("calibration");
		const heldOut = buildFullRealEvalCases("held_out");
		expect(calibration).toHaveLength(6);
		expect(heldOut).toHaveLength(FULL_REAL_EVAL_MAX_HELD_OUT_SESSIONS);
		expect(calibration.length + heldOut.length).toBe(FULL_REAL_EVAL_MAX_SESSIONS);
		expect(new Set(heldOut.map((entry) => entry.taskId))).toHaveLength(7);
		expect(new Set(heldOut.map((entry) => entry.seed))).toHaveLength(2);
		for (const taskId of new Set(heldOut.map((entry) => entry.taskId))) {
			for (const seed of new Set(heldOut.map((entry) => entry.seed))) {
				const variants = heldOut
					.filter((entry) => entry.taskId === taskId && entry.seed === seed)
					.map((entry) => entry.variant)
					.sort();
				expect(variants).toEqual(["legacy", "structured_semantic_v2", "text_v2"]);
			}
		}
	});

	it("builds every synthetic fixture with a failing initial oracle and a passing hidden solution", () => {
		const cases = [...buildFullRealEvalCases("calibration"), ...buildFullRealEvalCases("held_out")].filter(
			(entry, index, all) => all.findIndex((candidate) => candidate.taskId === entry.taskId) === index,
		);
		for (const input of cases) {
			const fixture = createFullRealEvalFixture(join(root, input.taskId), input);
			expect(fixture.grade().success).toBe(false);
			fixture.fault?.apply();
			fixture.applyExpectedSolutionForTest();
			expect(fixture.grade()).toMatchObject({
				success: true,
				score: 1,
				oracles: {
					mutationCorrect: true,
					wrongLocationsUnchanged: true,
					verificationPassed: true,
					externalChangePreserved: true,
				},
			});
		}
	});

	it("allows only generated query/document inputs through the embedding fetch boundary", async () => {
		const allowed = createSyntheticEmbeddingAllowlist(
			["synthetic concept"],
			[{ path: "src/feature.js", text: "src/feature.js\nFeature\nFunctionDeclaration\nsynthetic body" }],
		);
		let networkCalls = 0;
		let boundaryViolations = 0;
		const guarded = createSyntheticEmbeddingFetchGuard(
			allowed,
			async () => {
				networkCalls += 1;
				return new Response('{"data":[]}');
			},
			() => {
				boundaryViolations += 1;
			},
		);
		await guarded("https://embedding.invalid", {
			method: "POST",
			body: JSON.stringify({ input: ["synthetic concept"] }),
		});
		await guarded("https://embedding.invalid", {
			method: "POST",
			body: JSON.stringify({ input: ["feature.js\nFeature\nFunctionDeclaration\nsynthetic body"] }),
		});
		await expect(
			guarded("https://embedding.invalid", {
				method: "POST",
				body: JSON.stringify({ input: ["unapproved model query"] }),
			}),
		).rejects.toThrow("non-fixture input");
		expect({ networkCalls, boundaryViolations }).toEqual({ networkCalls: 2, boundaryViolations: 1 });
	});

	it("summarizes content-free calibration and held-out usage without crossing global breakers", async () => {
		const calibration = await runFullRealEvalStage("calibration", async () => output(), {
			sessions: 0,
			costUsd: 0,
		});
		expect(calibration.usage).toMatchObject({ stageSessions: 6, totalSessions: 6, maxTurnsPerSession: 18 });
		expect(calibration.records.every((record) => record.status === "completed")).toBe(true);
		expect(calibration.stop).toBeUndefined();
		for (const variant of Object.values(calibration.variants)) expect(variant.runs).toBe(2);
		const heldOut = await runFullRealEvalStage("held_out", async () => output({ chatCostUsd: 0.001 }), {
			sessions: calibration.usage.totalSessions,
			costUsd: calibration.usage.totalCostUsd,
		});
		expect(heldOut.usage.totalSessions).toBe(FULL_REAL_EVAL_MAX_SESSIONS);
		for (const variant of Object.values(heldOut.variants)) expect(variant.runs).toBe(14);
		expect(() => assertContentFreeRealEvalSummary(heldOut)).not.toThrow();
	});

	it("stops before a provider request beyond the assistant-turn cap", () => {
		expect(fullRealEvalShouldStopAfterTurn(FULL_REAL_EVAL_MAX_TURNS - 1, 1)).toBe(false);
		expect(fullRealEvalShouldStopAfterTurn(FULL_REAL_EVAL_MAX_TURNS, 0)).toBe(false);
		expect(fullRealEvalShouldStopAfterTurn(FULL_REAL_EVAL_MAX_TURNS, 1)).toBe(true);
		expect(fullRealEvalShouldStopAfterTurn(FULL_REAL_EVAL_MAX_TURNS + 1, 1)).toBe(true);
	});

	it("prevents a nineteenth faux provider request in the Agent loop", async () => {
		const faux = registerFauxProvider();
		try {
			faux.setResponses(
				Array.from({ length: FULL_REAL_EVAL_MAX_TURNS + 1 }, (_, index) =>
					fauxAssistantMessage(fauxToolCall("noop", {}, { id: `noop-${index}` }), {
						stopReason: "toolUse",
					}),
				),
			);
			const schema = Type.Object({});
			let assistantTurns = 0;
			let toolExecutions = 0;
			const tool: AgentTool<typeof schema> = {
				name: "noop",
				label: "Noop",
				description: "Return a deterministic tool result",
				parameters: schema,
				async execute() {
					toolExecutions++;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			};
			const agent = new Agent({
				initialState: { model: faux.getModel(), tools: [tool] },
				getApiKey: () => "faux-key",
				streamFn: streamSimple,
				shouldStopAfterTurn: ({ toolResults }) =>
					fullRealEvalShouldStopAfterTurn(assistantTurns, toolResults.length),
			});
			agent.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") assistantTurns++;
			});

			await agent.prompt("continue until stopped");

			expect(faux.state.callCount).toBe(FULL_REAL_EVAL_MAX_TURNS);
			expect(assistantTurns).toBe(FULL_REAL_EVAL_MAX_TURNS);
			expect(toolExecutions).toBe(FULL_REAL_EVAL_MAX_TURNS);
			expect(faux.getPendingResponseCount()).toBe(1);
		} finally {
			faux.unregister();
		}
	});

	it("returns a content-free partial summary with an aborted attempt before stopping", async () => {
		let calls = 0;
		const aborted = output({
			success: false,
			score: 0.75,
			turns: FULL_REAL_EVAL_MAX_TURNS,
			chatCostUsd: 0.02,
		});
		const summary = await runFullRealEvalStage(
			"calibration",
			async () => {
				calls++;
				throw new SystemicEvaluationError("model_turn_budget_exhausted", aborted);
			},
			{ sessions: 0, costUsd: 0 },
		);
		expect(calls).toBe(1);
		expect(summary.records).toHaveLength(1);
		expect(summary.records[0]).toMatchObject({
			status: "aborted",
			stopCategory: "model_turn_budget_exhausted",
			turns: FULL_REAL_EVAL_MAX_TURNS,
			totalCostUsd: 0.021,
		});
		expect(summary.usage).toMatchObject({ stageSessions: 1, stageCostUsd: 0.021 });
		expect(summary.stop).toMatchObject({ category: "model_turn_budget_exhausted", attemptedSessions: 1 });
		expect(() => assertContentFreeRealEvalSummary(summary)).not.toThrow();
	});

	it("stops before a second session on turn, cost, or systemic failure", async () => {
		let calls = 0;
		await expect(
			runFullRealEvalStage(
				"calibration",
				async () => {
					calls += 1;
					return output({ turns: FULL_REAL_EVAL_MAX_TURNS + 1 });
				},
				{ sessions: 0, costUsd: 0 },
			),
		).rejects.toThrow(`observed ${FULL_REAL_EVAL_MAX_TURNS + 1}`);
		expect(calls).toBe(1);

		calls = 0;
		await expect(
			runFullRealEvalStage(
				"calibration",
				async () => {
					calls += 1;
					return output({ chatCostUsd: FULL_REAL_EVAL_MAX_COST_USD });
				},
				{ sessions: 0, costUsd: 0.01 },
			),
		).rejects.toThrow("Global cost budget exceeded");
		expect(calls).toBe(1);

		calls = 0;
		await expect(
			runFullRealEvalStage(
				"calibration",
				async () => {
					calls += 1;
					throw new SystemicEvaluationError("provider_unavailable");
				},
				{ sessions: 0, costUsd: 0 },
			),
		).rejects.toThrow("provider_unavailable");
		expect(calls).toBe(1);
	});

	it("rejects content-bearing summary fields", async () => {
		const summary = await runFullRealEvalStage("calibration", async () => output(), {
			sessions: 0,
			costUsd: 0,
		});
		const unsafe = { ...summary, prompt: "secret" };
		expect(() => assertContentFreeRealEvalSummary(unsafe)).toThrow("prompt");
		const unknownField = { ...summary, note: "short secret" };
		expect(() => assertContentFreeRealEvalSummary(unknownField)).toThrow("note");
	});
});
