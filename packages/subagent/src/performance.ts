import type { Usage } from "@earendil-works/pi-ai";
import type { LedgerDagRunRecord, LedgerEvent } from "./ledger.ts";
import type { RunStatus, SubagentRole, TaskTerminalReason } from "./types.ts";

export const SUBAGENT_PERFORMANCE_VERSION = 1 as const;
export const ATTEMPT_PERFORMANCE_EVENT = "attempt.performance" as const;
export const SCHEDULER_WAIT_EVENT = "scheduler.wait" as const;

export const ATTEMPT_PERFORMANCE_STAGES = [
	"workspace_prepare",
	"worktree_prepare",
	"snapshot_prepare",
	"child_start",
	"first_model_event",
	"model_execution",
	"tool_execution",
	"handoff",
	"writer_audit",
	"validation",
	"commit",
	"attempt_wall",
] as const;

export type AttemptPerformanceStage = (typeof ATTEMPT_PERFORMANCE_STAGES)[number];
export type PerformanceStage = AttemptPerformanceStage | "claim_wait" | "retry_backoff" | "runnable_but_idle";

export interface AttemptPerformanceTelemetry {
	version: typeof SUBAGENT_PERFORMANCE_VERSION;
	attemptId: string;
	attemptNumber: number;
	role: SubagentRole;
	startedAt: number;
	finishedAt: number;
	success: boolean;
	terminalReason: TaskTerminalReason;
	stages: Partial<Record<AttemptPerformanceStage, number>>;
}

export interface SchedulerWaitTelemetry {
	version: typeof SUBAGENT_PERFORMANCE_VERSION;
	startedAt: number;
	finishedAt: number;
	capacity: number;
	reason: "active" | "eligibility" | "lease";
	nextEligibleAt?: number;
	runnableButIdleMs: number;
}

export interface DurationDistribution {
	count: number;
	totalMs: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
}

export interface SubagentPerformanceReport {
	version: typeof SUBAGENT_PERFORMANCE_VERSION;
	runId: string;
	status: RunStatus;
	outcome: RunStatus;
	wallClockMs: number;
	activeWallClockMs: number;
	criticalPathMs: number;
	claimWaitMs: number;
	runnableButIdleMs: number;
	retryCount: number;
	usage: Usage;
	turns: number;
	stages: Partial<Record<PerformanceStage, DurationDistribution>>;
}

export interface SubagentPerformanceSummary {
	version: typeof SUBAGENT_PERFORMANCE_VERSION;
	runCount: number;
	wallClockMs: DurationDistribution;
	activeWallClockMs: DurationDistribution;
	criticalPathMs: DurationDistribution;
	runnableButIdleMs: DurationDistribution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function percentile(sorted: readonly number[], ratio: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
}

export function durationDistribution(values: readonly number[]): DurationDistribution {
	const sorted = values
		.filter(nonNegativeFinite)
		.slice()
		.sort((left, right) => left - right);
	return {
		count: sorted.length,
		totalMs: sorted.reduce((sum, value) => sum + value, 0),
		p50Ms: percentile(sorted, 0.5),
		p95Ms: percentile(sorted, 0.95),
		maxMs: sorted.at(-1) ?? 0,
	};
}

function attemptTelemetry(event: LedgerEvent): AttemptPerformanceTelemetry | undefined {
	if (event.type !== ATTEMPT_PERFORMANCE_EVENT || !event.taskId || !isRecord(event.payload)) return undefined;
	const payload = event.payload;
	if (
		payload.version !== SUBAGENT_PERFORMANCE_VERSION ||
		typeof payload.attemptId !== "string" ||
		!Number.isSafeInteger(payload.attemptNumber) ||
		Number(payload.attemptNumber) < 1 ||
		typeof payload.role !== "string" ||
		!Number.isSafeInteger(payload.startedAt) ||
		!Number.isSafeInteger(payload.finishedAt) ||
		Number(payload.finishedAt) < Number(payload.startedAt) ||
		typeof payload.success !== "boolean" ||
		typeof payload.terminalReason !== "string" ||
		!isRecord(payload.stages)
	) {
		return undefined;
	}
	const stages: Partial<Record<AttemptPerformanceStage, number>> = {};
	for (const stage of ATTEMPT_PERFORMANCE_STAGES) {
		const duration = payload.stages[stage];
		if (nonNegativeFinite(duration)) stages[stage] = duration;
	}
	return {
		version: SUBAGENT_PERFORMANCE_VERSION,
		attemptId: payload.attemptId,
		attemptNumber: Number(payload.attemptNumber),
		role: payload.role as SubagentRole,
		startedAt: Number(payload.startedAt),
		finishedAt: Number(payload.finishedAt),
		success: payload.success,
		terminalReason: payload.terminalReason as TaskTerminalReason,
		stages,
	};
}

function schedulerTelemetry(event: LedgerEvent): SchedulerWaitTelemetry | undefined {
	if (event.type !== SCHEDULER_WAIT_EVENT || !isRecord(event.payload)) return undefined;
	const payload = event.payload;
	if (
		payload.version !== SUBAGENT_PERFORMANCE_VERSION ||
		!Number.isSafeInteger(payload.startedAt) ||
		!Number.isSafeInteger(payload.finishedAt) ||
		Number(payload.finishedAt) < Number(payload.startedAt) ||
		!Number.isSafeInteger(payload.capacity) ||
		Number(payload.capacity) < 0 ||
		!(["active", "eligibility", "lease"] as const).includes(payload.reason as never) ||
		!nonNegativeFinite(payload.runnableButIdleMs)
	) {
		return undefined;
	}
	if (payload.nextEligibleAt !== undefined && !Number.isSafeInteger(payload.nextEligibleAt)) return undefined;
	return {
		version: SUBAGENT_PERFORMANCE_VERSION,
		startedAt: Number(payload.startedAt),
		finishedAt: Number(payload.finishedAt),
		capacity: Number(payload.capacity),
		reason: payload.reason as SchedulerWaitTelemetry["reason"],
		...(payload.nextEligibleAt === undefined ? {} : { nextEligibleAt: Number(payload.nextEligibleAt) }),
		runnableButIdleMs: Number(payload.runnableButIdleMs),
	};
}

function retryBackoff(event: LedgerEvent): number | undefined {
	if (event.type !== "task.requeued" || !isRecord(event.payload)) return undefined;
	if (!Number.isSafeInteger(event.payload.retryNotBefore)) return undefined;
	return Math.max(0, Number(event.payload.retryNotBefore) - event.createdAt);
}

function isRetry(event: LedgerEvent): boolean {
	if (event.type !== "task.requeued" || !isRecord(event.payload)) return false;
	return ["attempt_failed", "availability_failure", "lease_expired"].includes(String(event.payload.reason));
}

function longestTaskPath(run: LedgerDagRunRecord, taskWeights: ReadonlyMap<string, number>): number {
	const longest = new Map<string, number>();
	const remaining = new Set(run.request.tasks.map((task) => task.id));
	while (remaining.size > 0) {
		let progressed = false;
		for (const task of run.request.tasks) {
			if (!remaining.has(task.id) || task.dependsOn.some((dependency) => !longest.has(dependency))) continue;
			const prerequisite = task.dependsOn.reduce(
				(maximum, dependency) => Math.max(maximum, longest.get(dependency) ?? 0),
				0,
			);
			longest.set(task.id, prerequisite + (taskWeights.get(task.id) ?? 0));
			remaining.delete(task.id);
			progressed = true;
		}
		if (!progressed) break;
	}
	return Math.max(0, ...longest.values());
}

export function buildSubagentPerformanceReport(
	run: LedgerDagRunRecord,
	events: readonly LedgerEvent[],
): SubagentPerformanceReport {
	const stageValues = new Map<PerformanceStage, number[]>();
	const addStage = (stage: PerformanceStage, duration: number): void => {
		if (!nonNegativeFinite(duration)) return;
		const values = stageValues.get(stage) ?? [];
		values.push(duration);
		stageValues.set(stage, values);
	};
	const taskWeights = new Map<string, number>();
	let claimWaitMs = 0;
	let runnableButIdleMs = 0;
	let retryCount = 0;

	for (const event of events) {
		const attempt = attemptTelemetry(event);
		if (attempt && event.taskId) {
			for (const [stage, duration] of Object.entries(attempt.stages) as Array<[AttemptPerformanceStage, number]>) {
				addStage(stage, duration);
			}
			taskWeights.set(event.taskId, (taskWeights.get(event.taskId) ?? 0) + (attempt.stages.attempt_wall ?? 0));
		}
		const scheduler = schedulerTelemetry(event);
		if (scheduler) {
			const duration = scheduler.finishedAt - scheduler.startedAt;
			claimWaitMs += duration;
			runnableButIdleMs += scheduler.runnableButIdleMs;
			addStage("claim_wait", duration);
			if (scheduler.runnableButIdleMs > 0) addStage("runnable_but_idle", scheduler.runnableButIdleMs);
		}
		const backoff = retryBackoff(event);
		if (backoff !== undefined) {
			addStage("retry_backoff", backoff);
			if (event.taskId) taskWeights.set(event.taskId, (taskWeights.get(event.taskId) ?? 0) + backoff);
		}
		if (isRetry(event)) retryCount++;
	}

	const stages: Partial<Record<PerformanceStage, DurationDistribution>> = {};
	for (const [stage, values] of stageValues) stages[stage] = durationDistribution(values);
	const wallClockMs = Math.max(0, run.updatedAt - run.createdAt);
	return {
		version: SUBAGENT_PERFORMANCE_VERSION,
		runId: run.runId,
		status: run.status,
		outcome: run.status,
		wallClockMs,
		activeWallClockMs: Math.max(0, wallClockMs - run.pausedDurationMs),
		criticalPathMs: longestTaskPath(run, taskWeights),
		claimWaitMs,
		runnableButIdleMs,
		retryCount,
		usage: structuredClone(run.usage),
		turns: run.turns,
		stages,
	};
}

export function summarizeSubagentPerformance(
	reports: readonly SubagentPerformanceReport[],
): SubagentPerformanceSummary {
	return {
		version: SUBAGENT_PERFORMANCE_VERSION,
		runCount: reports.length,
		wallClockMs: durationDistribution(reports.map((report) => report.wallClockMs)),
		activeWallClockMs: durationDistribution(reports.map((report) => report.activeWallClockMs)),
		criticalPathMs: durationDistribution(reports.map((report) => report.criticalPathMs)),
		runnableButIdleMs: durationDistribution(reports.map((report) => report.runnableButIdleMs)),
	};
}
