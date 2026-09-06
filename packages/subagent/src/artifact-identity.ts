import { createHash } from "node:crypto";
import type { ExternalWriterHandoff, SubagentHandoff, TaskArtifact, ValidationResult, WriterHandoff } from "./types.ts";
import { TASK_ARTIFACT_VERSION } from "./types.ts";

const ARTIFACT_ID_DOMAIN = "wj-subagent-task-artifact-v2\0";

export type TaskArtifactIdentityInput = Omit<TaskArtifact, "artifactId" | "createdAt" | "execution">;

function canonicalHandoff(handoff: SubagentHandoff | WriterHandoff | ExternalWriterHandoff): Record<string, unknown> {
	const common = {
		taskId: handoff.taskId,
		summary: handoff.summary,
		outcome: handoff.outcome,
		evidence: handoff.evidence.map((item) => ({
			path: item.path,
			...(item.lineRange ? { lineRange: item.lineRange } : {}),
			claim: item.claim,
		})),
		verification: handoff.verification.map((item) => ({
			check: item.check,
			status: item.status,
			...(item.details ? { details: item.details } : {}),
		})),
		assumptions: [...handoff.assumptions],
		risks: [...handoff.risks],
		nextActions: [...handoff.nextActions],
		verificationLevel: handoff.verificationLevel,
	};
	if ("changedPaths" in handoff) {
		return {
			...common,
			artifactVersion: handoff.artifactVersion,
			changedPaths: [...handoff.changedPaths].sort(),
		};
	}
	if ("externalChangedPaths" in handoff) {
		return {
			...common,
			artifactVersion: handoff.artifactVersion,
			externalChangedPaths: [...handoff.externalChangedPaths].sort(),
		};
	}
	return common;
}

function canonicalValidation(result: ValidationResult): Record<string, unknown> {
	return {
		commandId: result.commandId,
		status: result.status,
		...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
	};
}

/**
 * Compute semantic task-artifact identity from task result and durable
 * provenance only. Runtime/session metadata, timestamps, validation duration,
 * stdout, and stderr are deliberately excluded.
 */
export function computeTaskArtifactId(content: TaskArtifactIdentityInput): string {
	if (content.artifactVersion !== TASK_ARTIFACT_VERSION) {
		throw new Error(`Task artifact identity requires artifactVersion ${TASK_ARTIFACT_VERSION}`);
	}
	const canonical = {
		artifactVersion: TASK_ARTIFACT_VERSION,
		taskId: content.taskId,
		contractHash: content.contractHash,
		handoff: canonicalHandoff(content.handoff),
		changedPaths: [...content.changedPaths].sort(),
		externalChangedPaths: [...(content.externalChangedPaths ?? [])].sort(),
		externalMutations: [...(content.externalMutations ?? [])]
			.sort((left, right) => left.authorizationSequence - right.authorizationSequence)
			.map((mutation) => ({
				authorizationSequence: mutation.authorizationSequence,
				operation: mutation.operation,
				path: mutation.path,
				authorizationStatus: mutation.authorizationStatus,
				toolResult: mutation.toolResult ?? null,
				postState:
					mutation.postState?.status === "confirmed"
						? {
								status: "confirmed",
								fileType: mutation.postState.fileType,
								size: mutation.postState.size,
								mode: mutation.postState.mode,
								sha256: mutation.postState.sha256,
							}
						: mutation.postState
							? { status: "unavailable", reason: mutation.postState.reason }
							: null,
			})),
		validations: content.validations
			.map(canonicalValidation)
			.sort((left, right) => String(left.commandId).localeCompare(String(right.commandId))),
		quality: {
			semanticOutcome: content.quality.semanticOutcome,
			pathAudit: content.quality.pathAudit,
			validation: {
				status: content.quality.validation.status,
				passedCommandIds: [...content.quality.validation.passedCommandIds].sort(),
			},
			review:
				content.quality.review.status === "not_applicable"
					? { status: "not_applicable" }
					: {
							status: content.quality.review.status,
							writerCommitClosure: [...content.quality.review.writerCommitClosure]
								.sort((left, right) => {
									const leftKey = `${left.taskId}\0${left.artifactId}\0${left.commit}`;
									const rightKey = `${right.taskId}\0${right.artifactId}\0${right.commit}`;
									return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
								})
								.map((item) => ({ ...item })),
						},
		},
		commit: content.commit ?? null,
	};
	return createHash("sha256").update(ARTIFACT_ID_DOMAIN).update(JSON.stringify(canonical)).digest("hex");
}
