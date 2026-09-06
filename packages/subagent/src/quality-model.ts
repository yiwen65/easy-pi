import type {
	CandidateCoverageStatus,
	CandidateGateFailure,
	CandidateQuality,
	DagTaskContract,
	SubagentHandoff,
	SubagentRole,
	TaskArtifact,
	TaskOutcome,
	TaskQuality,
	ValidationResult,
	WriterCommitProvenance,
} from "./types.ts";

function provenanceKey(value: WriterCommitProvenance): string {
	return `${value.taskId}\0${value.artifactId}\0${value.commit.toLowerCase()}`;
}

function compareText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

function compareProvenance(left: WriterCommitProvenance, right: WriterCommitProvenance): number {
	return compareText(provenanceKey(left), provenanceKey(right));
}

function writerCommitClosure(artifacts: readonly TaskArtifact[]): WriterCommitProvenance[] {
	const unique = new Map<string, WriterCommitProvenance>();
	for (const artifact of artifacts) {
		if (!artifact.commit) continue;
		const item = { taskId: artifact.taskId, artifactId: artifact.artifactId, commit: artifact.commit };
		unique.set(provenanceKey(item), item);
	}
	return [...unique.values()].sort(compareProvenance);
}

export interface CreateTaskQualityOptions {
	role: SubagentRole;
	pathAuditPassed?: boolean;
	validations?: readonly ValidationResult[];
	dependencyArtifacts?: readonly TaskArtifact[];
}

/** Build independent task-quality dimensions from controller-observed facts. */
export function createTaskQuality(handoff: SubagentHandoff, options: CreateTaskQualityOptions): TaskQuality {
	const mutating = options.role === "writer" || options.role === "external-writer";
	const validations = options.validations ?? [];
	const passedCommandIds = [
		...new Set(validations.filter((result) => result.status === "passed").map((result) => result.commandId)),
	].sort();
	return {
		semanticOutcome: handoff.outcome,
		pathAudit: mutating ? (options.pathAuditPassed ? "passed" : "not_run") : "not_applicable",
		validation:
			options.role !== "writer"
				? { status: "not_applicable", passedCommandIds: [] }
				: validations.length === 0
					? { status: "not_run", passedCommandIds }
					: {
							status: validations.every((result) => result.status === "passed") ? "passed" : "failed",
							passedCommandIds,
						},
		review:
			options.role === "reviewer"
				? {
						status: handoff.outcome,
						writerCommitClosure: writerCommitClosure(options.dependencyArtifacts ?? []),
					}
				: { status: "not_applicable" },
	};
}

export interface CandidateQualityTaskInput {
	contract: DagTaskContract;
	artifact: TaskArtifact;
}

function coverage(required: readonly string[], covered: ReadonlySet<string>): CandidateCoverageStatus {
	if (required.length === 0) return "not_applicable";
	const count = required.filter((taskId) => covered.has(taskId)).length;
	if (count === 0) return "none";
	return count === required.length ? "full" : "partial";
}

function aggregateOutcome(outcomes: readonly (TaskOutcome | undefined)[]): TaskOutcome {
	if (outcomes.some((outcome) => outcome === "rejected")) return "rejected";
	if (outcomes.some((outcome) => outcome !== "accepted")) return "inconclusive";
	return "accepted";
}

/**
 * Evaluate the final candidate against the exact persisted artifacts. Review
 * coverage is full only when one accepted Reviewer saw every final Writer
 * artifact/commit pair; a union of partial reviews is deliberately insufficient.
 */
export function evaluateCandidateQuality(
	tasks: readonly CandidateQualityTaskInput[],
	pinnedWriterTaskIds: readonly string[],
): CandidateQuality {
	const ordered = [...tasks].sort((left, right) => compareText(left.contract.id, right.contract.id));
	const writers = ordered.filter((item) => item.contract.role === "writer");
	const reviewers = ordered.filter((item) => item.contract.role === "reviewer");
	const writerTaskIds = writers.map((item) => item.contract.id);
	const validationRequiredWriters = writers.filter(
		(item) => item.contract.role === "writer" && item.contract.validationCommandIds.length > 0,
	);
	const validationRequiredWriterTaskIds = validationRequiredWriters.map((item) => item.contract.id);
	const pathAuditedWriterTaskIds = writers
		.filter((item) => item.artifact.quality.pathAudit === "passed")
		.map((item) => item.contract.id);
	const validatedWriterTaskIds = validationRequiredWriters
		.filter((item) => {
			if (item.artifact.quality.validation.status !== "passed") return false;
			const registered = new Set(item.contract.role === "writer" ? item.contract.validationCommandIds : []);
			return item.artifact.validations.some(
				(result) => result.status === "passed" && registered.has(result.commandId),
			);
		})
		.map((item) => item.contract.id);
	const pinned = new Set(pinnedWriterTaskIds);
	const pinnedWriterTaskIdsSorted = writerTaskIds.filter((taskId) => pinned.has(taskId));
	const requiredWriterCommits = writerCommitClosure(writers.map((item) => item.artifact));
	const requiredKeys = new Set(requiredWriterCommits.map(provenanceKey));

	const reviewerTaskIds = reviewers.map((item) => item.contract.id);
	const acceptedReviewers = reviewers.filter(
		(item) =>
			item.artifact.quality.semanticOutcome === "accepted" && item.artifact.quality.review.status === "accepted",
	);
	const acceptedReviewerTaskIds = acceptedReviewers.map((item) => item.contract.id);
	// An accepted self-report without any location-backed evidence is not a
	// machine-verifiable review and must not satisfy the candidate coverage gate.
	const evidenceBackedAcceptedReviewers = acceptedReviewers.filter(
		(item) => item.artifact.handoff.evidence.length > 0,
	);
	const fullCoverageReviewerTaskIds = evidenceBackedAcceptedReviewers
		.filter((item) => {
			const review = item.artifact.quality.review;
			if (review.status === "not_applicable") return false;
			const covered = new Set(review.writerCommitClosure.map(provenanceKey));
			return requiredWriterCommits.every((writer) => covered.has(provenanceKey(writer)));
		})
		.map((item) => item.contract.id);
	const reviewed = new Map<string, WriterCommitProvenance>();
	for (const item of evidenceBackedAcceptedReviewers) {
		const review = item.artifact.quality.review;
		if (review.status === "not_applicable") continue;
		for (const writer of review.writerCommitClosure) {
			const key = provenanceKey(writer);
			if (requiredKeys.has(key)) reviewed.set(key, writer);
		}
	}
	const reviewedWriterCommits = [...reviewed.values()].sort(compareProvenance);

	const semanticOutcome = aggregateOutcome(ordered.map((item) => item.artifact.quality.semanticOutcome));
	const reviewVerdict =
		reviewers.length === 0
			? "none"
			: aggregateOutcome(
					reviewers.map((item) => {
						const review = item.artifact.quality.review;
						return review.status === "not_applicable" ? undefined : review.status;
					}),
				);
	const pathAuditCoverage = coverage(writerTaskIds, new Set(pathAuditedWriterTaskIds));
	const validationCoverage = coverage(validationRequiredWriterTaskIds, new Set(validatedWriterTaskIds));
	const commitPinCoverage = coverage(writerTaskIds, new Set(pinnedWriterTaskIdsSorted));
	const reviewCoverage = reviewers.length === 0 ? "none" : fullCoverageReviewerTaskIds.length > 0 ? "full" : "partial";
	const gateFailures: CandidateGateFailure[] = [];
	if (semanticOutcome !== "accepted") gateFailures.push("semantic_outcome");
	if (writers.length > 0 && pathAuditCoverage !== "full") gateFailures.push("path_audit");
	if (validationRequiredWriters.length > 0 && validationCoverage !== "full") gateFailures.push("validation_coverage");
	if (writers.length > 0 && commitPinCoverage !== "full") gateFailures.push("commit_pin");
	if (reviewers.length > 0 && reviewVerdict !== "accepted") gateFailures.push("review_verdict");
	if (reviewers.length > 0 && reviewCoverage !== "full") gateFailures.push("review_coverage");

	return {
		semanticOutcome,
		pathAuditCoverage,
		validationCoverage,
		commitPinCoverage,
		reviewCoverage,
		reviewVerdict,
		gate: gateFailures.length === 0 ? "passed" : "failed",
		gateFailures,
		writerTaskIds,
		pathAuditedWriterTaskIds,
		validatedWriterTaskIds,
		pinnedWriterTaskIds: pinnedWriterTaskIdsSorted,
		reviewerTaskIds,
		acceptedReviewerTaskIds,
		fullCoverageReviewerTaskIds,
		requiredWriterCommits,
		reviewedWriterCommits,
	};
}

/**
 * Preserve all independently observed quality dimensions while making the
 * failed-DAG boundary impossible to confuse with a complete accepted Candidate.
 */
export function evaluatePartialCandidateQuality(
	tasks: readonly CandidateQualityTaskInput[],
	pinnedWriterTaskIds: readonly string[],
): CandidateQuality {
	const quality = evaluateCandidateQuality(tasks, pinnedWriterTaskIds);
	return {
		...quality,
		gate: "failed",
		gateFailures: [
			...quality.gateFailures,
			...(quality.gateFailures.includes("dag_incomplete") ? [] : ["dag_incomplete" as const]),
		],
	};
}
