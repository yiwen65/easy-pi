import type { Usage } from "@earendil-works/pi-ai";
import type { LedgerDagRunRecord } from "./ledger.ts";
import type { DagTaskDetails, ProviderCircuitOpenState, SubagentDagRunDetails } from "./types.ts";

function cloneUsage(usage: Usage): Usage {
	return structuredClone(usage);
}

function partialHandoffFromCheckpoint(
	checkpoint: unknown,
	task: LedgerDagRunRecord["tasks"][number],
): DagTaskDetails["partialHandoff"] {
	if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return undefined;
	const record = checkpoint as Record<string, unknown>;
	if (record.version !== 1 || record.phase !== "budget_exhausted_partial") return undefined;
	const handoff = record.partialHandoff;
	if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return undefined;
	const candidate = handoff as Record<string, unknown>;
	if (
		candidate.taskId !== task.taskId ||
		candidate.outcome !== "inconclusive" ||
		typeof candidate.summary !== "string" ||
		!Array.isArray(candidate.evidence) ||
		!Array.isArray(candidate.verification) ||
		!Array.isArray(candidate.assumptions) ||
		!Array.isArray(candidate.risks) ||
		!Array.isArray(candidate.nextActions) ||
		(candidate.verificationLevel !== "unverified" && candidate.verificationLevel !== "self_reported")
	) {
		return undefined;
	}
	if (task.role === "writer" && (candidate.artifactVersion !== 2 || !Array.isArray(candidate.changedPaths))) {
		return undefined;
	}
	if (
		task.role === "external-writer" &&
		(candidate.artifactVersion !== 2 || !Array.isArray(candidate.externalChangedPaths))
	) {
		return undefined;
	}
	return structuredClone(handoff) as NonNullable<DagTaskDetails["partialHandoff"]>;
}

function providerCircuitFromCheckpoint(checkpoint: unknown): ProviderCircuitOpenState | undefined {
	if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return undefined;
	const record = checkpoint as Record<string, unknown>;
	const signal = record.providerCircuitOpen;
	if (
		record.version !== 1 ||
		record.phase !== "provider_circuit_open" ||
		!Number.isSafeInteger(record.retryNotBefore) ||
		Number(record.retryNotBefore) < 0 ||
		!signal ||
		typeof signal !== "object" ||
		Array.isArray(signal)
	) {
		return undefined;
	}
	const candidate = signal as Record<string, unknown>;
	if (
		candidate.version !== 1 ||
		candidate.reason !== "unlimited_auto_retry" ||
		!Number.isSafeInteger(candidate.autoRetryAttempt) ||
		Number(candidate.autoRetryAttempt) < 1 ||
		!Number.isSafeInteger(candidate.consecutiveUnlimitedRetries) ||
		Number(candidate.consecutiveUnlimitedRetries) < 1 ||
		!Number.isSafeInteger(candidate.retryDelayMs) ||
		Number(candidate.retryDelayMs) < 0
	) {
		return undefined;
	}
	return {
		version: 1,
		reason: "unlimited_auto_retry",
		autoRetryAttempt: Number(candidate.autoRetryAttempt),
		consecutiveUnlimitedRetries: Number(candidate.consecutiveUnlimitedRetries),
		retryDelayMs: Number(candidate.retryDelayMs),
		retryNotBefore: Number(record.retryNotBefore),
	};
}

export function detailsFromLedgerRun(run: LedgerDagRunRecord): SubagentDagRunDetails {
	return {
		runId: run.runId,
		status: run.status,
		objective: run.objective,
		baseline: structuredClone(run.baseline),
		tasks: run.tasks.map((task) => {
			const latestRuntime = task.attemptRecords.at(-1)?.runtime;
			const externalMutations = task.attemptRecords.flatMap((attempt) => attempt.externalMutations);
			const partialHandoff = partialHandoffFromCheckpoint(task.checkpoint, task);
			const providerCircuitOpen = providerCircuitFromCheckpoint(task.checkpoint);
			return {
				taskId: task.taskId,
				role: task.role,
				status: task.status,
				attempts: task.attempts,
				maxAttempts: task.contract.maxAttempts,
				dependsOn: [...task.contract.dependsOn],
				...(task.terminalReason ? { terminalReason: task.terminalReason } : {}),
				...(task.error ? { error: task.error } : {}),
				...(task.artifact ? { artifact: structuredClone(task.artifact) } : {}),
				...(partialHandoff ? { partialHandoff } : {}),
				...(providerCircuitOpen ? { providerCircuitOpen } : {}),
				...(externalMutations.length > 0 ? { externalMutations: structuredClone(externalMutations) } : {}),
				usage: cloneUsage(task.usage),
				turns: task.turns,
				...(latestRuntime ? { runtime: structuredClone(latestRuntime) } : {}),
				nextAction:
					task.status === "running"
						? (latestRuntime?.nextAction ?? "wait or send task control")
						: task.status === "pending"
							? providerCircuitOpen
								? `explicitly resume after provider retry eligibility ${providerCircuitOpen.retryNotBefore}`
								: "wait for dependencies and scheduler"
							: task.status === "failed"
								? partialHandoff
									? "inspect partial handoff; task is incomplete and dependencies remain blocked"
									: "inspect diagnostics or resume the run when repairable"
								: "none",
			};
		}),
		usage: cloneUsage(run.usage),
		budget: structuredClone(run.request.budget),
		...(run.request.budgetScope ? { budgetScope: run.request.budgetScope } : {}),
		...(run.pausedAt === undefined ? {} : { pausedAt: run.pausedAt }),
		pausedDurationMs: run.pausedDurationMs,
		graphVersion: run.graphVersion,
		graphSealed: run.graphSealed,
		awaitingExpansion: run.awaitingExpansion,
		...(run.lease ? { lease: structuredClone(run.lease) } : {}),
		...(run.integration ? { integration: structuredClone(run.integration) } : {}),
		...(run.integrationFailure ? { integrationFailure: structuredClone(run.integrationFailure) } : {}),
		resources: structuredClone(run.resources),
	};
}
