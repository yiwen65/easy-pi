import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { compileSubagentDagRequest, DEFAULT_SUBAGENT_POLICY } from "../src/contracts.ts";
import { SubagentDagOrchestrator } from "../src/dag-orchestrator.ts";
import { RunLedger } from "../src/ledger.ts";
import { mirrorRepositoryPath } from "../src/mirror-repository.ts";
import { ValidationRegistry } from "../src/quality.ts";
import type {
	ChildTaskResult,
	DagTaskContract,
	ReadOnlyTaskContract,
	SubagentHandoff,
	SubagentPolicy,
	WriterHandoff,
} from "../src/types.ts";
import { createWorkspaceRouter } from "../src/workspace-router.ts";

const temporaryPaths: string[] = [];

function git(cwd: string, ...args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "utf8", shell: false }, (error, stdout, stderr) => {
			if (error) return reject(new Error(String(stderr).trim() || error.message));
			resolve(String(stdout).trim());
		});
	});
}

function usage(): Usage {
	return {
		input: 2,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
	};
}

function success(task: DagTaskContract | ReadOnlyTaskContract, changedPaths: string[] = []): ChildTaskResult {
	const common = {
		taskId: task.id,
		summary: `completed ${task.id}`,
		outcome: "accepted" as const,
		evidence: [],
		verification: [],
		assumptions: [],
		risks: [],
		nextActions: [],
		verificationLevel: "unverified" as const,
	};
	const handoff: SubagentHandoff | WriterHandoff =
		task.role === "writer" ? { ...common, artifactVersion: 2, changedPaths } : common;
	return {
		taskId: task.id,
		role: task.role,
		success: true,
		terminalReason: "completed",
		handoff,
		usage: usage(),
		turns: 1,
		model: "fake/model",
	};
}

const VALIDATION_ID = "candidate-check";

function policy(): SubagentPolicy {
	return {
		...DEFAULT_SUBAGENT_POLICY,
		maxConcurrency: 1,
		leaseDurationMs: 100,
		allowedValidationCommandIds: [VALIDATION_ID],
	};
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("non-Git DAG through the mirror repository", () => {
	it("runs a read-to-writer DAG with candidate diff, release, and GC without touching the workspace", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "subagent-nongit-dag-"));
		temporaryPaths.push(workspace);
		await writeFile(join(workspace, "brief.txt"), "Create result.txt containing exactly: provider-eval-ok\n");
		const mirrorRoot = await mkdtemp(join(tmpdir(), "subagent-nongit-mirror-"));
		temporaryPaths.push(mirrorRoot);
		const selectedPolicy = policy();
		const router = createWorkspaceRouter({
			mirrorRoot,
			mirrorLimits: { maxFiles: selectedPolicy.maxSnapshotFiles, maxBytes: selectedPolicy.maxSnapshotBytes },
		});
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry: new ValidationRegistry([
				{
					id: VALIDATION_ID,
					command: process.execPath,
					args: ["-e", "process.exit(0)"],
					timeoutMs: 2_000,
					maxOutputBytes: 4_096,
				},
			]),
			createRunId: () => "nongit-dag",
			workspace: {
				createFrozenBaseline: router.createFrozenBaseline,
				pinRunBaseline: router.pinRunBaseline,
				releaseRunBaselinePin: router.releaseRunBaselinePin,
				pinTaskCommit: router.pinTaskCommit,
				releaseTaskCommitPin: router.releaseTaskCommitPin,
				reconcileTaskWorktrees: router.reconcileTaskWorktrees,
				createTaskWorktree: router.createTaskWorktree,
				validateWorktreeOwnership: router.validateWorktreeOwnership,
			},
			mergeTaskCommits: router.mergeTaskCommits,
			releaseMergeCandidateRef: router.releaseMergeCandidateRef,
			inspectMergeCandidateRef: router.inspectMergeCandidateRef,
			inspectMergeCandidateDiff: router.inspectMergeCandidateDiff,
			runTask: async (options) => {
				if (options.task.role === "writer") {
					expect(await readFile(join(options.snapshotPath, "brief.txt"), "utf8")).toContain("provider-eval-ok");
					await writeFile(join(options.snapshotPath, "result.txt"), "provider-eval-ok\n");
					return success(options.task, ["result.txt"]);
				}
				return success(options.task);
			},
		});

		const request = compileSubagentDagRequest(
			{
				operation: "start",
				objective: "Inspect brief.txt, then create the requested result",
				tasks: [
					{
						id: "inspect",
						role: "analyst",
						objective: "Read brief.txt",
						focusPaths: ["brief.txt"],
						maxAttempts: 1,
					},
					{
						id: "implement",
						role: "writer",
						objective: "Create result.txt",
						dependsOn: ["inspect"],
						ownedPaths: ["result.txt"],
						validationCommandIds: [VALIDATION_ID],
						maxAttempts: 1,
					},
				],
				createCandidate: true,
			},
			selectedPolicy,
		);

		const details = await orchestrator.start({ request, repositoryPath: workspace });
		expect(details.status).toBe("succeeded");
		expect(details.tasks.map((task) => task.status)).toEqual(["succeeded", "succeeded"]);
		expect(details.integration?.ref).toBe("refs/heads/pi/subagent/integration/nongit-dag");

		// The candidate lives in the mirror repository; the workspace has no Git and no changes.
		const mirror = mirrorRepositoryPath(mirrorRoot, await realpath(workspace));
		expect(await git(mirror, "show", `${details.integration?.commit}:result.txt`)).toBe("provider-eval-ok");
		expect(await readdir(workspace)).toEqual(["brief.txt"]);
		expect(await readFile(join(workspace, "brief.txt"), "utf8")).toBe(
			"Create result.txt containing exactly: provider-eval-ok\n",
		);

		const diff = await orchestrator.diffCandidate({ runId: "nongit-dag", maxBytes: 16_384 });
		expect(diff.changedPaths).toEqual(["result.txt"]);
		expect(diff.patch).toContain("provider-eval-ok");

		const released = await orchestrator.releaseCandidate({ runId: "nongit-dag" });
		expect(released.resources.candidate).toBe("released");
		await expect(git(mirror, "rev-parse", "--verify", details.integration!.ref)).rejects.toThrow();

		const collected = await orchestrator.gc({ runId: "nongit-dag" });
		expect(collected.resources.pins).toBe("released");
		// The last managed ref release collects the mirror repository itself.
		await expect(stat(mirror)).rejects.toMatchObject({ code: "ENOENT" });
		await orchestrator.shutdown();
		ledger.close();
	}, 10_000);
});
