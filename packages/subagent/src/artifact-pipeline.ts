import { computeTaskArtifactId } from "./artifact-identity.ts";
import { createTaskQuality } from "./quality-model.ts";
import type { ChildTaskResult, DagTaskContract, TaskArtifact } from "./types.ts";
import { TASK_ARTIFACT_VERSION } from "./types.ts";

function executionMetadata(result: ChildTaskResult): TaskArtifact["execution"] | undefined {
	if (!result.isolationLevel) return undefined;
	return {
		provider: result.runtime?.provider,
		...(result.model ? { model: result.model } : result.runtime?.model ? { model: result.runtime.model } : {}),
		thinkingLevel: result.runtime?.thinkingLevel,
		isolationLevel: result.isolationLevel,
		sessionId: result.runtime?.sessionId,
		runtimeGeneration: result.runtime?.runtimeGeneration,
		lastEventSeq: result.runtime?.lastEventSeq,
	};
}

export function createReadOnlyArtifact(
	task: DagTaskContract,
	result: ChildTaskResult,
	now: number,
	dependencyArtifacts: readonly TaskArtifact[] = [],
): TaskArtifact {
	if (!result.success || !result.handoff) throw new Error("A successful child must include a handoff");
	const execution = executionMetadata(result);
	const content = {
		artifactVersion: TASK_ARTIFACT_VERSION,
		taskId: task.id,
		contractHash: task.contractHash,
		handoff: result.handoff,
		changedPaths: [] as string[],
		validations: [] as [],
		quality: createTaskQuality(result.handoff, { role: task.role, dependencyArtifacts }),
	};
	return {
		...content,
		artifactId: computeTaskArtifactId(content),
		...(execution ? { execution } : {}),
		createdAt: now,
	};
}

export function attachExecutionMetadata(artifact: TaskArtifact, result: ChildTaskResult): TaskArtifact {
	const execution = executionMetadata(result);
	return execution ? { ...artifact, execution } : artifact;
}
