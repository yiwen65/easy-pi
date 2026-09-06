import { describe, expect, it } from "vitest";
import { computeTaskArtifactId, type TaskArtifactIdentityInput } from "../src/artifact-identity.ts";
import { attachExecutionMetadata, createReadOnlyArtifact } from "../src/artifact-pipeline.ts";
import type {
	ChildTaskResult,
	DagReadOnlyTaskContract,
	ExternalMutationRecord,
	ExternalWriterHandoff,
	SubagentHandoff,
	WriterHandoff,
} from "../src/types.ts";

const handoff: SubagentHandoff = {
	taskId: "inspect",
	summary: "Inspected the boundary",
	outcome: "accepted",
	evidence: [{ path: "src/index.ts", claim: "Defines the boundary" }],
	verification: [{ check: "static inspection", status: "passed" }],
	assumptions: [],
	risks: [],
	nextActions: [],
	verificationLevel: "self_reported",
};

const task: DagReadOnlyTaskContract = {
	id: "inspect",
	role: "scout",
	objective: "Inspect",
	nonGoals: [],
	readPaths: [],
	acceptance: [],
	dependsOn: [],
	maxAttempts: 1,
	contractHash: "a".repeat(64),
};

function result(runtimeGeneration: number, lastEventSeq: number): ChildTaskResult {
	return {
		taskId: task.id,
		role: task.role,
		success: true,
		terminalReason: "completed",
		handoff,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		turns: 1,
		model: `model-${runtimeGeneration}`,
		isolationLevel: "tool-bounded",
		runtime: {
			provider: "fake",
			model: `model-${runtimeGeneration}`,
			isolationLevel: "tool-bounded",
			sessionId: `session-${runtimeGeneration}`,
			runtimeGeneration,
			lastEventSeq,
		},
	};
}

describe("semantic task artifact identity", () => {
	it("does not change when execution metadata or createdAt changes", () => {
		const artifact = createReadOnlyArtifact(task, result(1, 10), 100);
		const withDifferentExecution = attachExecutionMetadata({ ...artifact, createdAt: 999 }, result(7, 500));

		expect(withDifferentExecution.artifactId).toBe(artifact.artifactId);
		expect(withDifferentExecution.createdAt).toBe(999);
		expect(withDifferentExecution.execution).toMatchObject({
			model: "model-7",
			sessionId: "session-7",
			runtimeGeneration: 7,
			lastEventSeq: 500,
		});
	});

	it("binds external post-state while excluding journal runtime identity and timestamps", () => {
		const externalHandoff: ExternalWriterHandoff = {
			...handoff,
			taskId: "publish",
			artifactVersion: 2,
			externalChangedPaths: ["/external/published.txt"],
		};
		const mutation: ExternalMutationRecord = {
			mutationId: "attempt-a:1",
			runId: "run-a",
			taskId: "publish",
			attemptId: "attempt-a",
			attemptNumber: 1,
			authorizationSequence: 1,
			toolCallId: "call-a",
			operation: "write",
			path: "/external/published.txt",
			authorizationStatus: "authorized",
			authorizedAt: 100,
			toolResult: "succeeded",
			observedAt: 200,
			postState: {
				status: "confirmed",
				fileType: "regular",
				size: 7,
				mode: 0o644,
				modifiedAtMs: 300,
				sha256: "a".repeat(64),
			},
		};
		if (mutation.postState?.status !== "confirmed") throw new Error("Expected a confirmed fixture post-state");
		const confirmedPostState = mutation.postState;
		const content: TaskArtifactIdentityInput = {
			artifactVersion: 2,
			taskId: "publish",
			contractHash: "e".repeat(64),
			handoff: externalHandoff,
			changedPaths: [],
			externalChangedPaths: ["/external/published.txt"],
			externalMutations: [mutation],
			validations: [],
			quality: {
				semanticOutcome: "accepted",
				pathAudit: "passed",
				validation: { status: "not_applicable", passedCommandIds: [] },
				review: { status: "not_applicable" },
			},
		};
		const runtimeOnlyChange: TaskArtifactIdentityInput = {
			...content,
			externalMutations: [
				{
					...mutation,
					mutationId: "attempt-b:1",
					runId: "run-b",
					attemptId: "attempt-b",
					attemptNumber: 2,
					toolCallId: "call-b",
					authorizedAt: 999,
					observedAt: 1_000,
					postState: { ...confirmedPostState, modifiedAtMs: 1_001 },
				},
			],
		};
		const changedPostState: TaskArtifactIdentityInput = {
			...content,
			externalMutations: [
				{
					...mutation,
					postState: { ...confirmedPostState, sha256: "b".repeat(64) },
				},
			],
		};

		expect(computeTaskArtifactId(runtimeOnlyChange)).toBe(computeTaskArtifactId(content));
		expect(computeTaskArtifactId(changedPostState)).not.toBe(computeTaskArtifactId(content));
	});

	it("excludes validation observations but includes semantic validation status and provenance", () => {
		const writerHandoff: WriterHandoff = {
			...handoff,
			taskId: "write",
			artifactVersion: 2,
			changedPaths: ["src/file.ts"],
		};
		const content: TaskArtifactIdentityInput = {
			artifactVersion: 2,
			taskId: "write",
			contractHash: "b".repeat(64),
			handoff: writerHandoff,
			changedPaths: ["src/file.ts"],
			validations: [
				{
					commandId: "unit",
					status: "passed",
					exitCode: 0,
					stdout: "temporary path one",
					stderr: "",
					durationMs: 10,
				},
			],
			quality: {
				semanticOutcome: "accepted",
				pathAudit: "passed",
				validation: { status: "passed", passedCommandIds: ["unit"] },
				review: { status: "not_applicable" },
			},
			commit: "c".repeat(40),
		};
		const changedObservations: TaskArtifactIdentityInput = {
			...content,
			validations: [{ ...content.validations[0]!, stdout: "other output", stderr: "warning", durationMs: 9_999 }],
		};
		const failedValidation: TaskArtifactIdentityInput = {
			...content,
			validations: [{ ...content.validations[0]!, status: "failed", exitCode: 1 }],
		};

		expect(computeTaskArtifactId(changedObservations)).toBe(computeTaskArtifactId(content));
		expect(computeTaskArtifactId(failedValidation)).not.toBe(computeTaskArtifactId(content));
		expect(computeTaskArtifactId({ ...content, commit: "d".repeat(40) })).not.toBe(computeTaskArtifactId(content));
		expect(
			computeTaskArtifactId({
				...content,
				handoff: { ...writerHandoff, summary: "Different semantic result" },
			}),
		).not.toBe(computeTaskArtifactId(content));
	});
});
