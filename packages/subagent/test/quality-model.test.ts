import { describe, expect, it } from "vitest";
import { evaluateCandidateQuality, evaluatePartialCandidateQuality } from "../src/quality-model.ts";
import type { DagTaskContract, HandoffEvidence, TaskArtifact } from "../src/types.ts";

const writerContract: DagTaskContract = {
	id: "write",
	role: "writer",
	objective: "write",
	nonGoals: [],
	readPaths: [],
	acceptance: [],
	dependsOn: [],
	maxAttempts: 1,
	contractHash: "writer-contract",
	ownedPaths: ["src/output.ts"],
	validationCommandIds: ["unit"],
};

const reviewerContract: DagTaskContract = {
	id: "review",
	role: "reviewer",
	objective: "review",
	nonGoals: [],
	readPaths: [],
	acceptance: [],
	dependsOn: ["write"],
	maxAttempts: 1,
	contractHash: "reviewer-contract",
};

const writerArtifact: TaskArtifact = {
	artifactVersion: 2,
	artifactId: "writer-artifact",
	taskId: "write",
	contractHash: writerContract.contractHash,
	handoff: {
		artifactVersion: 2,
		taskId: "write",
		summary: "implemented",
		outcome: "accepted",
		evidence: [{ path: "src/output.ts", claim: "Implemented output" }],
		verification: [],
		assumptions: [],
		risks: [],
		nextActions: [],
		verificationLevel: "controller_verified",
		changedPaths: ["src/output.ts"],
	},
	changedPaths: ["src/output.ts"],
	validations: [{ commandId: "unit", status: "passed", exitCode: 0, stdout: "", stderr: "", durationMs: 1 }],
	quality: {
		semanticOutcome: "accepted",
		pathAudit: "passed",
		validation: { status: "passed", passedCommandIds: ["unit"] },
		review: { status: "not_applicable" },
	},
	commit: "a".repeat(40),
	createdAt: 1,
};

function reviewerArtifact(evidence: HandoffEvidence[]): TaskArtifact {
	return {
		artifactVersion: 2,
		artifactId: "reviewer-artifact",
		taskId: "review",
		contractHash: reviewerContract.contractHash,
		handoff: {
			taskId: "review",
			summary: "reviewed",
			outcome: "accepted",
			evidence,
			verification: [],
			assumptions: [],
			risks: [],
			nextActions: [],
			verificationLevel: "self_reported",
		},
		changedPaths: [],
		validations: [],
		quality: {
			semanticOutcome: "accepted",
			pathAudit: "not_applicable",
			validation: { status: "not_applicable", passedCommandIds: [] },
			review: {
				status: "accepted",
				writerCommitClosure: [
					{ taskId: "write", artifactId: writerArtifact.artifactId, commit: writerArtifact.commit! },
				],
			},
		},
		createdAt: 2,
	};
}

describe("evaluateCandidateQuality", () => {
	it("treats unconfigured validation as not applicable instead of blocking a candidate", () => {
		const contract = { ...writerContract, validationCommandIds: [] };
		const artifact = {
			...writerArtifact,
			validations: [],
			quality: {
				...writerArtifact.quality,
				validation: { status: "not_run" as const, passedCommandIds: [] },
			},
		};
		expect(evaluateCandidateQuality([{ contract, artifact }], ["write"])).toMatchObject({
			validationCoverage: "not_applicable",
			gate: "passed",
			gateFailures: [],
		});
	});

	it("keeps a fully validated Partial Candidate explicitly non-accepted", () => {
		const quality = evaluatePartialCandidateQuality(
			[{ contract: writerContract, artifact: writerArtifact }],
			["write"],
		);
		expect(quality).toMatchObject({
			semanticOutcome: "accepted",
			pathAuditCoverage: "full",
			validationCoverage: "full",
			commitPinCoverage: "full",
			gate: "failed",
			gateFailures: ["dag_incomplete"],
		});
	});

	it("requires location-backed Reviewer evidence for full candidate coverage", () => {
		const withoutEvidence = evaluateCandidateQuality(
			[
				{ contract: writerContract, artifact: writerArtifact },
				{ contract: reviewerContract, artifact: reviewerArtifact([]) },
			],
			["write"],
		);
		expect(withoutEvidence).toMatchObject({
			reviewVerdict: "accepted",
			reviewCoverage: "partial",
			gate: "failed",
			gateFailures: ["review_coverage"],
			acceptedReviewerTaskIds: ["review"],
			fullCoverageReviewerTaskIds: [],
			reviewedWriterCommits: [],
		});

		const withEvidence = evaluateCandidateQuality(
			[
				{ contract: writerContract, artifact: writerArtifact },
				{
					contract: reviewerContract,
					artifact: reviewerArtifact([{ path: "src/output.ts", lineRange: "1-10", claim: "Reviewed output" }]),
				},
			],
			["write"],
		);
		expect(withEvidence).toMatchObject({
			reviewCoverage: "full",
			gate: "passed",
			fullCoverageReviewerTaskIds: ["review"],
			reviewedWriterCommits: [{ taskId: "write" }],
		});
	});
});
