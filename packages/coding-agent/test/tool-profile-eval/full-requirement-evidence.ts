export type EvidenceVariant = "legacy" | "text_v2" | "structured_no_path_prior" | "structured_v2" | "semantic_v2";

export type CoverageStatus = "complete" | "partial" | "overflow";
export type ContextPhase = "search" | "read" | "edit" | "full_chain";
export type SafetyKind =
	| "ambiguity_rejection"
	| "stale_rejection"
	| "truncation_disclosure"
	| "wrong_location_write"
	| "silent_replace_all"
	| "unversioned_write"
	| "syntax_failure_state";

export interface ScenarioContract {
	id: number;
	name: string;
	targetType: string;
	legalTargetCount: number;
	allowedSearchScope: string;
	expectedCoverage: CoverageStatus;
	allowedMutationRange: string;
	expectedErrorCode: string | null;
}

export interface ScenarioOutcome {
	id: number;
	passed: boolean;
}

export interface RetrievalObservation {
	variant: EvidenceVariant;
	queryId: string;
	returnedIds: string[];
	legalTargetIds: string[];
	coverage: CoverageStatus;
	searchCalls: number;
	returnedBytes: number;
	returnedTokens: number;
	latencyMs: number;
	broadQueryRetries: number;
}

export interface ContextObservation {
	phase: ContextPhase;
	outputBytes: number;
	outputTokens: number;
	relevantTokens: number;
	minimalTokens: number;
	repeatedTokens: number;
}

export interface WorkflowObservation {
	callsToLocate: number;
	callsToSafeEdit: number;
	callsToVerify: number;
	returnedBytes: number;
	returnedTokens: number;
	inputTokens: number;
	latencyMs: number;
	costUsd: number;
	broadQueryRetries: number;
	ambiguityRelocations: number;
	toolErrors: number;
	schemaErrors: number;
}

export interface SafetyObservation {
	kind: SafetyKind;
	safe: boolean;
}

export interface FullRequirementEvidenceInput {
	scenarios: ScenarioOutcome[];
	retrieval: RetrievalObservation[];
	context: ContextObservation[];
	workflows: WorkflowObservation[];
	safety: SafetyObservation[];
	activationCounts: Record<string, number>;
}

export interface RetrievalMetrics {
	queries: number;
	precisionAt5: number;
	irrelevantResultRateAt5: number;
	hitAt5: number;
	meanTargetRank: number | null;
	meanReciprocalRank: number;
	completeQueries: number;
	partialQueries: number;
	overflowQueries: number;
	meanSearchCalls: number;
	totalReturnedBytes: number;
	totalReturnedTokens: number;
	p50LatencyMs: number;
	p95LatencyMs: number;
	broadQueryRetries: number;
}

export interface ContextMetrics {
	samples: number;
	pollution: number;
	amplification: number;
	repetition: number;
	outputBytes: number;
	outputTokens: number;
}

export interface FullRequirementEvidenceSummary {
	scenarios: { total: number; passed: number };
	retrieval: Partial<Record<EvidenceVariant, RetrievalMetrics>>;
	context: Record<ContextPhase, ContextMetrics>;
	workflow: {
		runs: number;
		meanCallsToLocate: number;
		meanCallsToSafeEdit: number;
		meanCallsToVerify: number;
		totalReturnedBytes: number;
		totalReturnedTokens: number;
		totalInputTokens: number;
		p50LatencyMs: number;
		p95LatencyMs: number;
		totalCostUsd: number;
		p50CostUsd: number;
		p95CostUsd: number;
		broadQueryRetries: number;
		ambiguityRelocations: number;
		toolErrors: number;
		schemaErrors: number;
	};
	safety: Record<SafetyKind, { activations: number; safe: number; rate: number }>;
	activationCounts: Record<string, number>;
}

const REQUIRED_ACTIVATIONS = [
	"legacy_baseline",
	"text_v2_baseline",
	"structured_search",
	"semantic_candidate",
	"query_template",
	"preferred_path_prior",
	"partial_coverage",
	"overflow",
	"context_search",
	"context_read",
	"context_edit",
	"context_full_chain",
] as const;

const SAFETY_KINDS: SafetyKind[] = [
	"ambiguity_rejection",
	"stale_rejection",
	"truncation_disclosure",
	"wrong_location_write",
	"silent_replace_all",
	"unversioned_write",
	"syntax_failure_state",
];

const CONTEXT_PHASES: ContextPhase[] = ["search", "read", "edit", "full_chain"];

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function ratio(numerator: number, denominator: number, label: string): number {
	if (denominator <= 0) throw new Error(`${label} has no activated denominator`);
	return numerator / denominator;
}

function retrievalMetrics(observations: RetrievalObservation[]): RetrievalMetrics {
	const precision: number[] = [];
	const hits: number[] = [];
	const reciprocalRanks: number[] = [];
	const targetRanks: number[] = [];
	for (const observation of observations) {
		const firstFive = observation.returnedIds.slice(0, 5);
		const legal = new Set(observation.legalTargetIds);
		const relevant = firstFive.filter((id) => legal.has(id)).length;
		precision.push(firstFive.length === 0 ? 0 : relevant / firstFive.length);
		const rank = observation.returnedIds.findIndex((id) => legal.has(id));
		hits.push(rank >= 0 && rank < 5 ? 1 : 0);
		reciprocalRanks.push(rank < 0 ? 0 : 1 / (rank + 1));
		if (rank >= 0) targetRanks.push(rank + 1);
	}
	const precisionAt5 = mean(precision);
	return {
		queries: observations.length,
		precisionAt5,
		irrelevantResultRateAt5: 1 - precisionAt5,
		hitAt5: mean(hits),
		meanTargetRank: targetRanks.length === 0 ? null : mean(targetRanks),
		meanReciprocalRank: mean(reciprocalRanks),
		completeQueries: observations.filter((observation) => observation.coverage === "complete").length,
		partialQueries: observations.filter((observation) => observation.coverage === "partial").length,
		overflowQueries: observations.filter((observation) => observation.coverage === "overflow").length,
		meanSearchCalls: mean(observations.map((observation) => observation.searchCalls)),
		totalReturnedBytes: observations.reduce((sum, observation) => sum + observation.returnedBytes, 0),
		totalReturnedTokens: observations.reduce((sum, observation) => sum + observation.returnedTokens, 0),
		p50LatencyMs: percentile(
			observations.map((observation) => observation.latencyMs),
			0.5,
		),
		p95LatencyMs: percentile(
			observations.map((observation) => observation.latencyMs),
			0.95,
		),
		broadQueryRetries: observations.reduce((sum, observation) => sum + observation.broadQueryRetries, 0),
	};
}

function contextMetrics(observations: ContextObservation[], phase: ContextPhase): ContextMetrics {
	const selected = observations.filter((observation) => observation.phase === phase);
	if (selected.length === 0) throw new Error(`${phase} context metrics have no activated sample`);
	const outputTokens = selected.reduce((sum, observation) => sum + observation.outputTokens, 0);
	const relevantTokens = selected.reduce((sum, observation) => sum + observation.relevantTokens, 0);
	const minimalTokens = selected.reduce((sum, observation) => sum + observation.minimalTokens, 0);
	const repeatedTokens = selected.reduce((sum, observation) => sum + observation.repeatedTokens, 0);
	return {
		samples: selected.length,
		pollution: ratio(outputTokens - relevantTokens, outputTokens, `${phase} pollution`),
		amplification: ratio(outputTokens, minimalTokens, `${phase} amplification`),
		repetition: ratio(repeatedTokens, outputTokens, `${phase} repetition`),
		outputBytes: selected.reduce((sum, observation) => sum + observation.outputBytes, 0),
		outputTokens,
	};
}

function validateInput(input: FullRequirementEvidenceInput): void {
	const scenarioIds = [...input.scenarios.map((scenario) => scenario.id)].sort((left, right) => left - right);
	if (scenarioIds.length !== 16 || scenarioIds.some((id, index) => id !== index + 1)) {
		throw new Error("Evidence must activate each declared scenario ID 1-16 exactly once");
	}
	if (input.scenarios.some((scenario) => !scenario.passed)) throw new Error("At least one declared scenario failed");
	if (input.retrieval.length === 0 || input.workflows.length === 0) throw new Error("Evidence metrics are empty");
	for (const observation of input.retrieval) {
		if (observation.searchCalls <= 0 || observation.returnedBytes < 0 || observation.returnedTokens < 0) {
			throw new Error(`Invalid retrieval observation ${observation.queryId}`);
		}
	}
	for (const observation of input.context) {
		if (
			observation.outputTokens <= 0 ||
			observation.relevantTokens < 0 ||
			observation.relevantTokens > observation.outputTokens ||
			observation.minimalTokens <= 0 ||
			observation.repeatedTokens < 0 ||
			observation.repeatedTokens > observation.outputTokens
		) {
			throw new Error(`Invalid ${observation.phase} context observation`);
		}
	}
	for (const activation of REQUIRED_ACTIVATIONS) {
		if ((input.activationCounts[activation] ?? 0) <= 0) throw new Error(`Activation gate ${activation} is vacuous`);
	}
	for (const kind of SAFETY_KINDS) {
		if (!input.safety.some((observation) => observation.kind === kind)) {
			throw new Error(`Safety gate ${kind} is vacuous`);
		}
	}
}

/** Computes bounded, content-free metrics only after every required scenario and activation gate is non-vacuous. */
export function summarizeFullRequirementEvidence(input: FullRequirementEvidenceInput): FullRequirementEvidenceSummary {
	validateInput(input);
	const variants = [...new Set(input.retrieval.map((observation) => observation.variant))];
	const retrieval = Object.fromEntries(
		variants.map((variant) => [
			variant,
			retrievalMetrics(input.retrieval.filter((observation) => observation.variant === variant)),
		]),
	) as Partial<Record<EvidenceVariant, RetrievalMetrics>>;
	const workflowLatency = input.workflows.map((workflow) => workflow.latencyMs);
	const workflowCost = input.workflows.map((workflow) => workflow.costUsd);
	const safety = Object.fromEntries(
		SAFETY_KINDS.map((kind) => {
			const selected = input.safety.filter((observation) => observation.kind === kind);
			const safe = selected.filter((observation) => observation.safe).length;
			return [kind, { activations: selected.length, safe, rate: ratio(safe, selected.length, kind) }];
		}),
	) as Record<SafetyKind, { activations: number; safe: number; rate: number }>;
	return {
		scenarios: { total: input.scenarios.length, passed: input.scenarios.length },
		retrieval,
		context: Object.fromEntries(
			CONTEXT_PHASES.map((phase) => [phase, contextMetrics(input.context, phase)]),
		) as Record<ContextPhase, ContextMetrics>,
		workflow: {
			runs: input.workflows.length,
			meanCallsToLocate: mean(input.workflows.map((workflow) => workflow.callsToLocate)),
			meanCallsToSafeEdit: mean(input.workflows.map((workflow) => workflow.callsToSafeEdit)),
			meanCallsToVerify: mean(input.workflows.map((workflow) => workflow.callsToVerify)),
			totalReturnedBytes: input.workflows.reduce((sum, workflow) => sum + workflow.returnedBytes, 0),
			totalReturnedTokens: input.workflows.reduce((sum, workflow) => sum + workflow.returnedTokens, 0),
			totalInputTokens: input.workflows.reduce((sum, workflow) => sum + workflow.inputTokens, 0),
			p50LatencyMs: percentile(workflowLatency, 0.5),
			p95LatencyMs: percentile(workflowLatency, 0.95),
			totalCostUsd: input.workflows.reduce((sum, workflow) => sum + workflow.costUsd, 0),
			p50CostUsd: percentile(workflowCost, 0.5),
			p95CostUsd: percentile(workflowCost, 0.95),
			broadQueryRetries: input.workflows.reduce((sum, workflow) => sum + workflow.broadQueryRetries, 0),
			ambiguityRelocations: input.workflows.reduce((sum, workflow) => sum + workflow.ambiguityRelocations, 0),
			toolErrors: input.workflows.reduce((sum, workflow) => sum + workflow.toolErrors, 0),
			schemaErrors: input.workflows.reduce((sum, workflow) => sum + workflow.schemaErrors, 0),
		},
		safety,
		activationCounts: { ...input.activationCounts },
	};
}
