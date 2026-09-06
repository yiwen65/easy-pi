import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mirrorRepositoryPath } from "../src/mirror-repository.ts";
import { createWorkspaceRouter, resolveWorkspaceRoot } from "../src/workspace-router.ts";

const temporaryPaths: string[] = [];

function git(cwd: string, ...args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(String(stderr), { cause: error }));
				return;
			}
			resolvePromise(String(stdout).trim());
		});
	});
}

async function makeGitRepository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "subagent-router-git-"));
	temporaryPaths.push(root);
	await git(root, "init", "-q", "-b", "user-main");
	await git(root, "config", "user.email", "router@example.test");
	await git(root, "config", "user.name", "Router Test");
	await writeFile(join(root, "tracked.txt"), "committed\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-q", "-m", "baseline");
	return root;
}

async function makePlainDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "subagent-router-nongit-"));
	temporaryPaths.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveWorkspaceRoot", () => {
	it("returns the Git top-level inside a worktree and the canonical directory outside Git", async () => {
		const repo = await makeGitRepository();
		const nested = join(repo, "a", "b");
		await mkdir(nested, { recursive: true });
		expect(await resolveWorkspaceRoot(nested)).toBe(await realpath(repo));

		const plain = await makePlainDirectory();
		const plainNested = join(plain, "x");
		await mkdir(plainNested);
		expect(await resolveWorkspaceRoot(plainNested)).toBe(await realpath(plainNested));
		expect(await resolveWorkspaceRoot(plain)).toBe(await realpath(plain));
	});
});

describe("createWorkspaceRouter", () => {
	it("routes non-Git workspaces through the mirror repository for baseline, pins, and worktrees", async () => {
		const workspace = await makePlainDirectory();
		const mirrorRoot = await makePlainDirectory();
		await mkdir(join(workspace, "src"));
		await writeFile(join(workspace, "src", "index.ts"), "entry\n");
		const router = createWorkspaceRouter({
			mirrorRoot,
			mirrorLimits: { maxFiles: 100, maxBytes: 1024 * 1024 },
		});

		const frozen = await router.createFrozenBaseline(workspace);
		expect(frozen.repositoryRoot).toBe(await realpath(workspace));
		expect(frozen.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
		expect(frozen.headCommit).toBe(frozen.baselineCommit);
		await frozen.cleanup();

		const mirror = mirrorRepositoryPath(mirrorRoot, await realpath(workspace));
		await router.pinRunBaseline(workspace, "run-1", frozen.baselineCommit);
		expect(await git(mirror, "rev-parse", "refs/pi-subagent/baselines/run-1")).toBe(frozen.baselineCommit);

		const worktree = await router.createTaskWorktree({
			repositoryPath: workspace,
			baselineCommit: frozen.baselineCommit,
			runId: "run-1",
			taskId: "write",
		});
		temporaryPaths.push(worktree.path);
		expect(await readFileUtf8(join(worktree.path, "src", "index.ts"))).toBe("entry\n");

		// The user workspace is never modified.
		expect(await readFileUtf8(join(workspace, "src", "index.ts"))).toBe("entry\n");
		expect(await git(workspace, "status", "--porcelain").catch(() => "not-a-repo")).toBe("not-a-repo");

		await worktree.cleanup();
		await router.releaseRunBaselinePin(workspace, "run-1", frozen.baselineCommit);
		await expect(git(mirror, "rev-parse", "refs/pi-subagent/baselines/run-1")).rejects.toThrow();
	});

	it("passes Git workspaces through to the real Git implementation", async () => {
		const repo = await makeGitRepository();
		const mirrorRoot = await makePlainDirectory();
		const router = createWorkspaceRouter({
			mirrorRoot,
			mirrorLimits: { maxFiles: 100, maxBytes: 1024 * 1024 },
		});
		const frozen = await router.createFrozenBaseline(repo);
		expect(frozen.repositoryRoot).toBe(await realpath(repo));
		expect(frozen.headCommit).toBe(await git(repo, "rev-parse", "HEAD"));
		expect(frozen.baselineCommit).not.toBe(frozen.headCommit);
		await frozen.cleanup();
		// No mirror repository is created for Git workspaces.
		expect(await readdirSafe(mirrorRoot)).toEqual([]);
	});

	it("fails closed when the mirror lacks the recorded baseline commit", async () => {
		const workspace = await makePlainDirectory();
		const mirrorRoot = await makePlainDirectory();
		await writeFile(join(workspace, "a.txt"), "a\n");
		const router = createWorkspaceRouter({
			mirrorRoot,
			mirrorLimits: { maxFiles: 100, maxBytes: 1024 * 1024 },
		});
		await expect(
			router.createTaskWorktree({
				repositoryPath: workspace,
				baselineCommit: "1".repeat(40),
				runId: "run-1",
				taskId: "write",
			}),
		).rejects.toThrow("no baseline commit");
	});
});

async function readFileUtf8(path: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return await readFile(path, "utf8");
}

async function readdirSafe(path: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}
