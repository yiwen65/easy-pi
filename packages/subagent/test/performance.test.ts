import { describe, expect, it } from "vitest";
import { type LedgerDagRunRecord, type LedgerEvent, RunLedger } from "../src/ledger.ts";
import { buildSubagentPerformanceReport, summarizeSubagentPerformance } from "../src/performance.ts";
import type { DagTaskContract } from "../src/types.ts";

function usage(totalTokens = 10) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
	};
}

function task(id: string, dependsOn: string[] = []): DagTaskContract {
	return {
		id,
		role: "scout",
		objective: id,
		nonGoals: [],
		readPaths: [],
		acceptance: [],
		dependsOn,
		maxAttempts: 3,
		contractHash: `hash-${id}`,
	};
}

function run(): LedgerDagRunRecord {
	const contracts = [task("a"), task("b", ["a"]), task("c")];
	return {
		runId: "performance-run",
		status: "succeeded",
		objective: "not included in telemetry",
		request: {
			version: 2,
			handoffProtocolVersion: 2,
			objective: "not included in telemetry",
			tasks: contracts,
			budget: { maxTokens: 1_000 },
			budgetScope: "task",
			merge: { enabled: false, refPrefix: "pi/subagent/integration" },
			graph: { sealed: true },
		},
		baseline: {
			repositoryRoot: "/repo",
			headCommit: "a".repeat(40),
			snapshotId: "snapshot",
			fileCount: 1,
			totalBytes: 1,
		},
		tasks: contracts.map((contract, index) => ({
			runId: "performance-run",
			taskId: contract.id,
			role: contract.role,
			contract,
			status: "succeeded" as const,
			attempts: 1,
			attemptRecords: [],
			usage: usage(index + 1),
			turns: 1,
			createdAt: 0,
			updatedAt: 300,
		})),
		usage: usage(10),
		turns: 4,
		pausedDurationMs: 20,
		graphVersion: 1,
		graphSealed: true,
		awaitingExpansion: false,
		resources: { candidate: "none", pins: "retained" },
		createdAt: 0,
		updatedAt: 300,
	};
}

function event(sequence: number, type: string, payload: unknown, taskId?: string): LedgerEvent {
	return {
		sequence,
		runId: "performance-run",
		...(taskId ? { taskId } : {}),
		type,
		payload,
		createdAt: sequence * 10,
	};
}

const events: LedgerEvent[] = [
	event(
		1,
		"attempt.performance",
		{
			version: 1,
			attemptId: "attempt-a",
			attemptNumber: 1,
			role: "scout",
			startedAt: 0,
			finishedAt: 100,
			success: false,
			terminalReason: "process_error",
			stages: { attempt_wall: 100, workspace_prepare: 20, model_execution: 60 },
		},
		"a",
	),
	{
		...event(
			2,
			"task.requeued",
			{
				attemptId: "attempt-a",
				attemptNumber: 1,
				reason: "attempt_failed",
				retryNotBefore: 160,
			},
			"a",
		),
		createdAt: 110,
	},
	event(
		3,
		"scheduler.wait",
		{
			version: 1,
			startedAt: 100,
			finishedAt: 160,
			capacity: 1,
			reason: "eligibility",
			nextEligibleAt: 150,
			runnableButIdleMs: 10,
		},
		undefined,
	),
	event(
		4,
		"attempt.performance",
		{
			version: 1,
			attemptId: "attempt-b",
			attemptNumber: 1,
			role: "scout",
			startedAt: 160,
			finishedAt: 240,
			success: true,
			terminalReason: "completed",
			stages: { attempt_wall: 80, workspace_prepare: 10, tool_execution: 20 },
		},
		"b",
	),
	event(
		5,
		"attempt.performance",
		{
			version: 1,
			attemptId: "attempt-c",
			attemptNumber: 1,
			role: "scout",
			startedAt: 0,
			finishedAt: 120,
			success: true,
			terminalReason: "completed",
			stages: { attempt_wall: 120, workspace_prepare: 30, handoff: 5 },
		},
		"c",
	),
];

describe("Subagent performance telemetry", () => {
	it("builds a deterministic run report without retaining task content", () => {
		const report = buildSubagentPerformanceReport(run(), events);

		expect(report).toMatchObject({
			version: 1,
			runId: "performance-run",
			status: "succeeded",
			wallClockMs: 300,
			activeWallClockMs: 280,
			criticalPathMs: 230,
			claimWaitMs: 60,
			runnableButIdleMs: 10,
			retryCount: 1,
			turns: 4,
			usage: { totalTokens: 10 },
			outcome: "succeeded",
		});
		expect(report.stages.attempt_wall).toEqual({ count: 3, totalMs: 300, p50Ms: 100, p95Ms: 120, maxMs: 120 });
		expect(report.stages.retry_backoff).toEqual({ count: 1, totalMs: 50, p50Ms: 50, p95Ms: 50, maxMs: 50 });
		expect(JSON.stringify(report)).not.toContain("not included in telemetry");
	});

	it("computes cross-run wall-clock percentiles from independent reports", () => {
		const base = buildSubagentPerformanceReport(run(), events);
		const reports = [100, 200, 300, 400, 500].map((wallClockMs) => ({
			...base,
			runId: `run-${wallClockMs}`,
			wallClockMs,
			activeWallClockMs: wallClockMs,
		}));
		const summary = summarizeSubagentPerformance(reports);
		expect(summary).toMatchObject({
			version: 1,
			runCount: 5,
			wallClockMs: { count: 5, totalMs: 1_500, p50Ms: 300, p95Ms: 500, maxMs: 500 },
			activeWallClockMs: { p50Ms: 300, p95Ms: 500 },
		});
	});

	it("persists only the fixed numeric attempt schema and reports it on operator inspection", () => {
		const ledger = new RunLedger(":memory:");
		const persisted = run();
		persisted.request.tasks = [task("only")];
		ledger.createDagRun({ runId: "performance-run", request: persisted.request, baseline: persisted.baseline });
		const lease = ledger.acquireDagRunLease("performance-run", "controller", 1_000, 10_000)!;
		ledger.setDagRunStatus("performance-run", "running", 1_001, lease);
		const [claim] = ledger.claimRunnableTasks("performance-run", "controller", 1_002, 10_000, 1, lease);
		ledger.recordDagAttemptPerformance(
			"performance-run",
			"only",
			claim.attemptId,
			claim.ownerId,
			{
				version: 1,
				attemptId: claim.attemptId,
				attemptNumber: 1,
				role: "scout",
				startedAt: 1_002,
				finishedAt: 1_012,
				success: true,
				terminalReason: "completed",
				stages: { attempt_wall: 10, model_execution: 4 },
			},
			1_012,
			lease,
		);
		const inspection = ledger.inspectDagRun("performance-run")!;
		expect(inspection.performance).toMatchObject({
			runId: "performance-run",
			criticalPathMs: 10,
			stages: { model_execution: { count: 1, totalMs: 4 } },
		});
		const serialized = JSON.stringify(inspection.events.find((item) => item.type === "attempt.performance"));
		expect(serialized).not.toContain("objective");
		expect(serialized).not.toContain("errorMessage");

		expect(() =>
			ledger.recordDagAttemptPerformance(
				"performance-run",
				"only",
				claim.attemptId,
				claim.ownerId,
				{
					version: 1,
					attemptId: claim.attemptId,
					attemptNumber: 1,
					role: "scout",
					startedAt: 1_002,
					finishedAt: 1_012,
					success: false,
					terminalReason: "process_error",
					stages: { attempt_wall: 10, prompt: 10 },
					errorMessage: "credential-bearing provider output",
				} as never,
				1_013,
				lease,
			),
		).toThrow("unexpected field");
		ledger.close();
	});
});
