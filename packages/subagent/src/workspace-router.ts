import { realpath } from "node:fs/promises";
import {
	inspectMergeCandidateDiff,
	inspectMergeCandidateRef,
	type MergeCoordinatorOptions,
	mergeTaskCommits,
	releaseMergeCandidateRef,
} from "./merge-coordinator.ts";
import {
	collectMirrorIfEmpty,
	ensureMirrorRepository,
	importMirrorBaseline,
	type MirrorLimits,
	mirrorHasCommit,
} from "./mirror-repository.ts";
import type { CandidateDiff, IntegrationArtifact, WorktreeHandle } from "./types.ts";
import {
	assertTaskIdentifier,
	type CreateTaskWorktreeOptions,
	createFrozenBaseline,
	createTaskWorktree,
	type FrozenBaselineHandle,
	type FrozenBaselineOptions,
	NotAGitRepositoryError,
	pinRunBaseline,
	pinTaskCommit,
	reconcileTaskWorktrees,
	releaseRunBaselinePin,
	releaseTaskCommitPin,
	resolveRepositoryRoot,
	runGit,
	textOutput,
	validateWorktreeOwnership,
} from "./worktree.ts";

/**
 * Route Subagent workspace operations to the real Git implementation or to the
 * internal mirror repository, depending on whether the target path is inside a
 * Git worktree. Non-Git workspaces are translated to their mirror repository and
 * then handled by the exact same Git code paths, so writer isolation, quality
 * commits, merge candidates, pins, and CAS semantics are identical in both modes.
 * The user's directory is never modified.
 */

export interface WorkspaceRouterOptions {
	mirrorRoot: string;
	mirrorLimits: MirrorLimits;
}

/** Git top-level when inside a worktree, otherwise the canonical directory itself. */
export async function resolveWorkspaceRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		return await resolveRepositoryRoot(cwd, signal);
	} catch (error) {
		if (error instanceof NotAGitRepositoryError) return await realpath(cwd);
		throw error;
	}
}

async function isGitWorkspace(repositoryPath: string, signal?: AbortSignal): Promise<boolean> {
	try {
		await resolveRepositoryRoot(repositoryPath, signal);
		return true;
	} catch (error) {
		if (error instanceof NotAGitRepositoryError) return false;
		throw error;
	}
}

export interface WorkspaceRouter {
	createFrozenBaseline(repositoryPath: string, options?: FrozenBaselineOptions): Promise<FrozenBaselineHandle>;
	pinRunBaseline(repositoryPath: string, runId: string, commit: string, signal?: AbortSignal): Promise<string>;
	releaseRunBaselinePin(
		repositoryPath: string,
		runId: string,
		expectedCommit?: string,
		signal?: AbortSignal,
	): Promise<void>;
	pinTaskCommit(
		repositoryPath: string,
		runId: string,
		taskId: string,
		commit: string,
		signal?: AbortSignal,
	): Promise<string>;
	releaseTaskCommitPin(
		repositoryPath: string,
		runId: string,
		taskId: string,
		expectedCommit?: string,
		signal?: AbortSignal,
	): Promise<void>;
	reconcileTaskWorktrees(repositoryPath: string, runId: string, taskId: string, signal?: AbortSignal): Promise<void>;
	createTaskWorktree(options: CreateTaskWorktreeOptions): Promise<WorktreeHandle>;
	validateWorktreeOwnership: typeof validateWorktreeOwnership;
	mergeTaskCommits(options: MergeCoordinatorOptions): Promise<IntegrationArtifact>;
	releaseMergeCandidateRef(
		repositoryPath: string,
		ref: string,
		expectedCommit: string,
		signal?: AbortSignal,
	): Promise<boolean>;
	inspectMergeCandidateRef(
		repositoryPath: string,
		ref: string,
		expectedCommit: string,
		signal?: AbortSignal,
	): Promise<"exact" | "absent" | "mismatch">;
	inspectMergeCandidateDiff(options: {
		repositoryPath: string;
		runId: string;
		baselineCommit: string;
		ref: string;
		expectedCommit: string;
		maxBytes?: number;
		maxPaths?: number;
		signal?: AbortSignal;
	}): Promise<CandidateDiff>;
}

export function createWorkspaceRouter(options: WorkspaceRouterOptions): WorkspaceRouter {
	const mirrorFor = async (repositoryPath: string, signal?: AbortSignal): Promise<string> =>
		await ensureMirrorRepository(options.mirrorRoot, repositoryPath, signal);

	const requireMirrorCommit = async (repo: string, commit: string, signal?: AbortSignal): Promise<void> => {
		if (!(await mirrorHasCommit(repo, commit, signal))) {
			throw new Error(
				`Mirror repository has no baseline commit ${commit}; the run cannot continue because the recorded baseline is unavailable`,
			);
		}
	};

	/** Translate non-Git workspace paths to the mirror repository; verify pinned commits exist. */
	const translate = async (
		repositoryPath: string,
		commit: string | undefined,
		signal?: AbortSignal,
	): Promise<string | undefined> => {
		if (await isGitWorkspace(repositoryPath, signal)) return undefined;
		const repo = await mirrorFor(repositoryPath, signal);
		if (commit !== undefined) await requireMirrorCommit(repo, commit, signal);
		return repo;
	};

	return {
		async createFrozenBaseline(repositoryPath, frozenOptions = {}) {
			if (await isGitWorkspace(repositoryPath, frozenOptions.signal)) {
				return await createFrozenBaseline(repositoryPath, frozenOptions);
			}
			const baseline = await importMirrorBaseline({
				mirrorRoot: options.mirrorRoot,
				workspaceRoot: repositoryPath,
				limits: options.mirrorLimits,
				pinRunId: frozenOptions.runId,
				temporaryDirectory: frozenOptions.temporaryDirectory,
				signal: frozenOptions.signal,
			});
			return {
				repositoryRoot: baseline.repositoryRoot,
				headCommit: baseline.baselineCommit,
				baselineCommit: baseline.baselineCommit,
				cleanup: async () => {},
			};
		},

		async pinRunBaseline(repositoryPath, runId, commit, signal) {
			const repo = await translate(repositoryPath, commit, signal);
			if (repo === undefined) return await pinRunBaseline(repositoryPath, runId, commit, signal);
			// Baselines imported with pinRunId are already pinned atomically; re-pinning
			// the same commit (start handoff, resume) must be idempotent.
			assertTaskIdentifier(runId, "runId");
			const existing = await runGit(["rev-parse", "--verify", `refs/pi-subagent/baselines/${runId}`], {
				cwd: repo,
				signal,
				allowExitCodes: [0, 128],
			});
			if (existing.exitCode === 0) {
				const pinned = textOutput(existing);
				if (pinned !== commit) {
					throw new Error(`Mirror baseline pin for run ${runId} points to a different commit`);
				}
				return `refs/pi-subagent/baselines/${runId}`;
			}
			return await pinRunBaseline(repo, runId, commit, signal);
		},

		async releaseRunBaselinePin(repositoryPath, runId, expectedCommit, signal) {
			const repo = await translate(repositoryPath, undefined, signal);
			await releaseRunBaselinePin(repo ?? repositoryPath, runId, expectedCommit, signal);
			if (repo !== undefined) await collectMirrorIfEmpty(options.mirrorRoot, repositoryPath, signal);
		},

		async pinTaskCommit(repositoryPath, runId, taskId, commit, signal) {
			const repo = await translate(repositoryPath, commit, signal);
			return await pinTaskCommit(repo ?? repositoryPath, runId, taskId, commit, signal);
		},

		async releaseTaskCommitPin(repositoryPath, runId, taskId, expectedCommit, signal) {
			const repo = await translate(repositoryPath, undefined, signal);
			await releaseTaskCommitPin(repo ?? repositoryPath, runId, taskId, expectedCommit, signal);
			if (repo !== undefined) await collectMirrorIfEmpty(options.mirrorRoot, repositoryPath, signal);
		},

		async reconcileTaskWorktrees(repositoryPath, runId, taskId, signal) {
			const repo = await translate(repositoryPath, undefined, signal);
			await reconcileTaskWorktrees(repo ?? repositoryPath, runId, taskId, signal);
		},

		async createTaskWorktree(worktreeOptions) {
			const repo = await translate(
				worktreeOptions.repositoryPath,
				worktreeOptions.baselineCommit,
				worktreeOptions.signal,
			);
			return await createTaskWorktree(
				repo === undefined ? worktreeOptions : { ...worktreeOptions, repositoryPath: repo },
			);
		},

		validateWorktreeOwnership,

		async mergeTaskCommits(mergeOptions) {
			const repo = await translate(mergeOptions.repositoryPath, mergeOptions.baselineCommit, mergeOptions.signal);
			return await mergeTaskCommits(repo === undefined ? mergeOptions : { ...mergeOptions, repositoryPath: repo });
		},

		async releaseMergeCandidateRef(repositoryPath, ref, expectedCommit, signal) {
			const repo = await translate(repositoryPath, expectedCommit, signal);
			const released = await releaseMergeCandidateRef(repo ?? repositoryPath, ref, expectedCommit, signal);
			if (repo !== undefined && released) await collectMirrorIfEmpty(options.mirrorRoot, repositoryPath, signal);
			return released;
		},

		async inspectMergeCandidateRef(repositoryPath, ref, expectedCommit, signal) {
			const repo = await translate(repositoryPath, expectedCommit, signal);
			return await inspectMergeCandidateRef(repo ?? repositoryPath, ref, expectedCommit, signal);
		},

		async inspectMergeCandidateDiff(diffOptions) {
			const repo = await translate(diffOptions.repositoryPath, diffOptions.baselineCommit, diffOptions.signal);
			return await inspectMergeCandidateDiff(
				repo === undefined ? diffOptions : { ...diffOptions, repositoryPath: repo },
			);
		},
	};
}
