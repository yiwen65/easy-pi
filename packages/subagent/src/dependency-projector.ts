import { Buffer } from "node:buffer";
import type {
	HandoffEvidence,
	HandoffVerification,
	QualityCheckStatus,
	TaskArtifact,
	TaskOutcome,
	ValidationResult,
	VerificationLevel,
} from "./types.ts";

/** Hard prompt-facing cap for all dependency context, including truncation metadata. */
export const DEPENDENCY_VIEW_MAX_BYTES = 24 * 1024;

const SUMMARY_MAX_BYTES = 1_024;
const MIN_SUMMARY_BYTES = 4;
const EVIDENCE_PATH_MAX_BYTES = 240;
const EVIDENCE_LINE_RANGE_MAX_BYTES = 80;
const EVIDENCE_CLAIM_MAX_BYTES = 360;
const CHANGED_PATH_MAX_BYTES = 320;
const CHILD_VERIFICATION_CHECK_MAX_BYTES = 240;
const CHILD_VERIFICATION_DETAILS_MAX_BYTES = 480;
const RISK_MAX_BYTES = 480;

export type DependencyOutcome = TaskOutcome;
export type DependencyVerificationLevel = VerificationLevel;

export interface DependencyEvidenceView {
	path: string;
	lineRange?: string;
	claim: string;
}

export interface ControllerValidationView {
	commandId: string;
	status: ValidationResult["status"];
	exitCode?: number;
	trust: "controller_verified";
}

export interface ChildVerificationView {
	check: string;
	status: HandoffVerification["status"];
	details?: string;
	trust: "self_reported";
}

export interface DependencyRiskView {
	text: string;
	trust: "self_reported";
}

export interface DependencyQualityView {
	semanticOutcome: TaskOutcome;
	pathAudit?: QualityCheckStatus;
	validation?: QualityCheckStatus;
	review?: "not_applicable" | TaskOutcome;
}

export interface DependencyOmittedView {
	summaryBytes: number;
	evidence: number;
	evidenceBytes: number;
	changedPaths: number;
	changedPathBytes: number;
	controllerValidations: number;
	childVerifications: number;
	childVerificationBytes: number;
	risks: number;
	riskBytes: number;
}

export interface DependencyArtifactView {
	taskId: string;
	artifactId: string;
	summary: string;
	quality: DependencyQualityView;
	verificationLevel: DependencyVerificationLevel;
	evidence: DependencyEvidenceView[];
	changedPaths: string[];
	commit?: string;
	controllerValidations: ControllerValidationView[];
	childVerifications: ChildVerificationView[];
	risks: DependencyRiskView[];
	omitted: DependencyOmittedView;
}

export interface DependencyView {
	version: 2;
	maxBytes: number;
	dependencies: DependencyArtifactView[];
	omittedTotals: DependencyOmittedView;
	truncated: boolean;
}

interface TruncatedString {
	value: string;
	omittedBytes: number;
}

interface EvidenceCandidate {
	value: DependencyEvidenceView;
	omittedBytes: number;
}

interface ChangedPathCandidate {
	value: string;
	omittedBytes: number;
}

interface ChildVerificationCandidate {
	value: ChildVerificationView;
	omittedBytes: number;
}

interface RiskCandidate {
	value: DependencyRiskView;
	omittedBytes: number;
}

type OptionalAddition =
	| { kind: "evidence"; candidate: EvidenceCandidate }
	| { kind: "changedPath"; candidate: ChangedPathCandidate }
	| { kind: "validation"; candidate: ControllerValidationView }
	| { kind: "childVerification"; candidate: ChildVerificationCandidate }
	| { kind: "risk"; candidate: RiskCandidate };

function truncateUtf8(value: string, maxBytes: number): TruncatedString {
	const totalBytes = Buffer.byteLength(value, "utf8");
	if (totalBytes <= maxBytes) return { value, omittedBytes: 0 };
	const suffix = "…";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	let retained = "";
	let retainedBytes = 0;
	const contentLimit = Math.max(0, maxBytes - suffixBytes);
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (retainedBytes + characterBytes > contentLimit) break;
		retained += character;
		retainedBytes += characterBytes;
	}
	return {
		value: `${retained}${suffix}`,
		omittedBytes: totalBytes - retainedBytes,
	};
}

function projectQuality(artifact: TaskArtifact): DependencyQualityView {
	return {
		semanticOutcome: artifact.quality.semanticOutcome,
		pathAudit: artifact.quality.pathAudit,
		validation: artifact.quality.validation.status,
		review: artifact.quality.review.status,
	};
}

function projectEvidence(evidence: HandoffEvidence): EvidenceCandidate {
	const path = truncateUtf8(evidence.path, EVIDENCE_PATH_MAX_BYTES);
	const lineRange = evidence.lineRange ? truncateUtf8(evidence.lineRange, EVIDENCE_LINE_RANGE_MAX_BYTES) : undefined;
	const claim = truncateUtf8(evidence.claim, EVIDENCE_CLAIM_MAX_BYTES);
	return {
		value: {
			path: path.value,
			...(lineRange ? { lineRange: lineRange.value } : {}),
			claim: claim.value,
		},
		omittedBytes: path.omittedBytes + (lineRange?.omittedBytes ?? 0) + claim.omittedBytes,
	};
}

function projectChangedPath(path: string): ChangedPathCandidate {
	const projected = truncateUtf8(path, CHANGED_PATH_MAX_BYTES);
	return { value: projected.value, omittedBytes: projected.omittedBytes };
}

function projectValidation(validation: ValidationResult): ControllerValidationView {
	return {
		commandId: validation.commandId,
		status: validation.status,
		...(validation.exitCode === undefined ? {} : { exitCode: validation.exitCode }),
		trust: "controller_verified",
	};
}

function projectChildVerification(verification: HandoffVerification): ChildVerificationCandidate {
	const check = truncateUtf8(verification.check, CHILD_VERIFICATION_CHECK_MAX_BYTES);
	const details = verification.details
		? truncateUtf8(verification.details, CHILD_VERIFICATION_DETAILS_MAX_BYTES)
		: undefined;
	return {
		value: {
			check: check.value,
			status: verification.status,
			...(details ? { details: details.value } : {}),
			trust: "self_reported",
		},
		omittedBytes: check.omittedBytes + (details?.omittedBytes ?? 0),
	};
}

function projectRisk(risk: string): RiskCandidate {
	const text = truncateUtf8(risk, RISK_MAX_BYTES);
	return {
		value: { text: text.value, trust: "self_reported" },
		omittedBytes: text.omittedBytes,
	};
}

function omittedTotals(dependencies: readonly DependencyArtifactView[]): DependencyOmittedView {
	return dependencies.reduce<DependencyOmittedView>(
		(total, dependency) => ({
			summaryBytes: total.summaryBytes + dependency.omitted.summaryBytes,
			evidence: total.evidence + dependency.omitted.evidence,
			evidenceBytes: total.evidenceBytes + dependency.omitted.evidenceBytes,
			changedPaths: total.changedPaths + dependency.omitted.changedPaths,
			changedPathBytes: total.changedPathBytes + dependency.omitted.changedPathBytes,
			controllerValidations: total.controllerValidations + dependency.omitted.controllerValidations,
			childVerifications: total.childVerifications + dependency.omitted.childVerifications,
			childVerificationBytes: total.childVerificationBytes + dependency.omitted.childVerificationBytes,
			risks: total.risks + dependency.omitted.risks,
			riskBytes: total.riskBytes + dependency.omitted.riskBytes,
		}),
		{
			summaryBytes: 0,
			evidence: 0,
			evidenceBytes: 0,
			changedPaths: 0,
			changedPathBytes: 0,
			controllerValidations: 0,
			childVerifications: 0,
			childVerificationBytes: 0,
			risks: 0,
			riskBytes: 0,
		},
	);
}

function finalized(dependencies: DependencyArtifactView[]): DependencyView {
	const omitted = omittedTotals(dependencies);
	return {
		version: 2,
		maxBytes: DEPENDENCY_VIEW_MAX_BYTES,
		dependencies,
		omittedTotals: omitted,
		truncated: Object.values(omitted).some((value) => value > 0),
	};
}

function serializedBytes(value: DependencyView): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function changedPaths(artifact: TaskArtifact): string[] {
	return [...artifact.changedPaths, ...(artifact.externalChangedPaths ?? [])];
}

function initialView(artifacts: readonly TaskArtifact[], summaryMaxBytes: number): DependencyView {
	const dependencies = artifacts.map<DependencyArtifactView>((artifact) => {
		const summary = truncateUtf8(artifact.handoff.summary, summaryMaxBytes);
		return {
			taskId: artifact.taskId,
			artifactId: artifact.artifactId,
			summary: summary.value,
			quality: projectQuality(artifact),
			verificationLevel: artifact.handoff.verificationLevel,
			evidence: [],
			changedPaths: [],
			...(artifact.commit === undefined ? {} : { commit: artifact.commit }),
			controllerValidations: [],
			childVerifications: [],
			risks: [],
			omitted: {
				summaryBytes: summary.omittedBytes,
				evidence: artifact.handoff.evidence.length,
				evidenceBytes: 0,
				changedPaths: changedPaths(artifact).length,
				changedPathBytes: 0,
				controllerValidations: artifact.validations.length,
				childVerifications: artifact.handoff.verification.length,
				childVerificationBytes: 0,
				risks: artifact.handoff.risks.length,
				riskBytes: 0,
			},
		};
	});
	return finalized(dependencies);
}

function criticalAdditionsFor(artifact: TaskArtifact): OptionalAddition[] {
	return [
		...artifact.handoff.verification
			.map(projectChildVerification)
			.filter((candidate) => candidate.value.status !== "passed")
			.map((candidate): OptionalAddition => ({ kind: "childVerification", candidate })),
		...artifact.handoff.risks.map(projectRisk).map((candidate): OptionalAddition => ({ kind: "risk", candidate })),
	];
}

function additionsFor(artifact: TaskArtifact): OptionalAddition[] {
	const evidence = artifact.handoff.evidence.map(projectEvidence);
	const paths = changedPaths(artifact).map(projectChangedPath);
	const validations = artifact.validations.map(projectValidation);
	const passedChildVerifications = artifact.handoff.verification
		.map(projectChildVerification)
		.filter((candidate) => candidate.value.status === "passed");
	const additions: OptionalAddition[] = [];
	const rounds = Math.max(evidence.length, paths.length, validations.length, passedChildVerifications.length);
	for (let index = 0; index < rounds; index++) {
		if (evidence[index]) additions.push({ kind: "evidence", candidate: evidence[index] });
		if (paths[index]) additions.push({ kind: "changedPath", candidate: paths[index] });
		if (validations[index]) additions.push({ kind: "validation", candidate: validations[index] });
		if (passedChildVerifications[index]) {
			additions.push({ kind: "childVerification", candidate: passedChildVerifications[index] });
		}
	}
	return additions;
}

function applyAddition(view: DependencyView, dependencyIndex: number, addition: OptionalAddition): void {
	const dependency = view.dependencies[dependencyIndex];
	if (!dependency) return;
	if (addition.kind === "evidence") {
		dependency.evidence.push(addition.candidate.value);
		dependency.omitted.evidence -= 1;
		dependency.omitted.evidenceBytes += addition.candidate.omittedBytes;
	} else if (addition.kind === "changedPath") {
		dependency.changedPaths.push(addition.candidate.value);
		dependency.omitted.changedPaths -= 1;
		dependency.omitted.changedPathBytes += addition.candidate.omittedBytes;
	} else if (addition.kind === "validation") {
		dependency.controllerValidations.push(addition.candidate);
		dependency.omitted.controllerValidations -= 1;
	} else if (addition.kind === "childVerification") {
		dependency.childVerifications.push(addition.candidate.value);
		dependency.omitted.childVerifications -= 1;
		dependency.omitted.childVerificationBytes += addition.candidate.omittedBytes;
	} else {
		dependency.risks.push(addition.candidate.value);
		dependency.omitted.risks -= 1;
		dependency.omitted.riskBytes += addition.candidate.omittedBytes;
	}
	const totals = omittedTotals(view.dependencies);
	view.omittedTotals = totals;
	view.truncated = Object.values(totals).some((value) => value > 0);
}

function admitAdditions(view: DependencyView, queues: readonly OptionalAddition[][]): DependencyView {
	let admitted = view;
	const longestQueue = Math.max(0, ...queues.map((queue) => queue.length));
	for (let additionIndex = 0; additionIndex < longestQueue; additionIndex++) {
		for (let dependencyIndex = 0; dependencyIndex < queues.length; dependencyIndex++) {
			const addition = queues[dependencyIndex]?.[additionIndex];
			if (!addition) continue;
			const candidate = structuredClone(admitted);
			applyAddition(candidate, dependencyIndex, addition);
			if (serializedBytes(candidate) <= DEPENDENCY_VIEW_MAX_BYTES) admitted = candidate;
		}
	}
	return admitted;
}

function pinCriticalDetails(candidate: DependencyView, critical: DependencyView): DependencyView {
	for (let index = 0; index < candidate.dependencies.length; index++) {
		const target = candidate.dependencies[index];
		const source = critical.dependencies[index];
		if (!target || !source) continue;
		target.childVerifications = structuredClone(source.childVerifications);
		target.risks = structuredClone(source.risks);
		target.omitted.childVerifications = source.omitted.childVerifications;
		target.omitted.childVerificationBytes = source.omitted.childVerificationBytes;
		target.omitted.risks = source.omitted.risks;
		target.omitted.riskBytes = source.omitted.riskBytes;
	}
	return finalized(candidate.dependencies);
}

/**
 * Create deterministic, prompt-safe transitive dependency context.
 *
 * Identity and a bounded summary are retained for every artifact. Optional
 * detail is admitted round-robin so a wide fan-in cannot let the first
 * dependency consume the shared byte budget. Failed/not-run child checks and
 * risks are admitted before ordinary detail. Controller validation and
 * self-reported child evidence remain distinct; raw stdout/stderr is omitted.
 */
export function projectDependencyArtifacts(input: readonly TaskArtifact[]): DependencyView {
	const artifacts = [...input].sort((left, right) => {
		if (left.taskId !== right.taskId) return left.taskId < right.taskId ? -1 : 1;
		if (left.artifactId === right.artifactId) return 0;
		return left.artifactId < right.artifactId ? -1 : 1;
	});
	let low = MIN_SUMMARY_BYTES;
	let high = SUMMARY_MAX_BYTES;
	const minimal = initialView(artifacts, low);
	if (serializedBytes(minimal) > DEPENDENCY_VIEW_MAX_BYTES) {
		throw new Error("Dependency identities exceed the fixed dependency-view byte limit");
	}
	// Critical failed/not-run checks and risks claim space before summaries are
	// expanded, so a wide fan-in cannot silently erase every warning.
	const critical = admitAdditions(minimal, artifacts.map(criticalAdditionsFor));
	let view = critical;
	while (low <= high) {
		const candidateLimit = Math.floor((low + high) / 2);
		const candidate = pinCriticalDetails(initialView(artifacts, candidateLimit), critical);
		if (serializedBytes(candidate) <= DEPENDENCY_VIEW_MAX_BYTES) {
			view = candidate;
			low = candidateLimit + 1;
		} else {
			high = candidateLimit - 1;
		}
	}

	return admitAdditions(view, artifacts.map(additionsFor));
}
