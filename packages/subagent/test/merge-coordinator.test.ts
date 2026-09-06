import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MergeConflictError, mergeTaskCommits, releaseMergeCandidateRef } from "../src/merge-coordinator.ts";

const temporaryPaths: string[] = [];

function gitResult(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolvePromise, rejectPromise) => {
		execFile("git", args, { cwd, encoding: "utf8", shell: false }, (error, stdout, stderr) => {
			const code = typeof error?.code === "number" ? error.code : error ? -1 : 0;
			if (error && code === -1) return rejectPromise(error);
			resolvePromise({ stdout: String(stdout).trim(), stderr: String(stderr).trim(), code });
		});
	});
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await gitResult(cwd, ...args);
	if (result.code !== 0) throw new Error(result.stderr || `git ${args[0]} exited ${result.code}`);
	return result.stdout;
}

interface RepositoryFixture {
	root: string;
	baseline: string;
}

async function makeRepository(): Promise<RepositoryFixture> {
	const root = await mkdtemp(join(tmpdir(), "subagent-merge-test-"));
	temporaryPaths.push(root);
	await git(root, "init", "-q", "-b", "user-main");
	await git(root, "config", "user.name", "Merge Test");
	await git(root, "config", "user.email", "merge@example.test");
	await writeFile(join(root, "shared.txt"), "base\n");
	await git(root, "add", "shared.txt");
	await git(root, "commit", "-q", "-m", "baseline");
	return { root, baseline: await git(root, "rev-parse", "HEAD") };
}

async function writerCommit(
	fixture: RepositoryFixture,
	branch: string,
	path: string,
	contents: string,
	date: string,
): Promise<string> {
	await git(fixture.root, "checkout", "-q", "-B", branch, fixture.baseline);
	await writeFile(join(fixture.root, path), contents);
	await git(fixture.root, "add", path);
	await new Promise<void>((resolvePromise, rejectPromise) => {
		execFile(
			"git",
			["commit", "-q", "-m", branch],
			{
				cwd: fixture.root,
				shell: false,
				env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
			},
			(error) => (error ? rejectPromise(error) : resolvePromise()),
		);
	});
	const commit = await git(fixture.root, "rev-parse", "HEAD");
	await git(fixture.root, "checkout", "-q", "user-main");
	return commit;
}

function options(fixture: RepositoryFixture, commits: readonly { taskId: string; commit: string }[]) {
	return {
		repositoryPath: fixture.root,
		baselineCommit: fixture.baseline,
		runId: "run-1",
		refPrefix: "pi/subagent/integration",
		taskCommits: commits,
	};
}

async function exactRef(root: string, ref: string): Promise<string | undefined> {
	const result = await gitResult(root, "show-ref", "--verify", "--hash", ref);
	return result.code === 0 ? result.stdout : undefined;
}

async function integrationMarkerPath(root: string, ref: string): Promise<string> {
	const commonOutput = await git(root, "rev-parse", "--git-common-dir");
	const commonDirectory = await realpath(resolve(root, commonOutput));
	return join(
		commonDirectory,
		"pi-subagent",
		"merge-coordinator",
		"worktrees",
		`${createHash("sha256").update(ref, "utf8").digest("hex")}.json`,
	);
}

async function markIntegrationWorktree(
	root: string,
	worktreePath: string,
	ref: string,
	runId: string,
): Promise<string> {
	const path = await integrationMarkerPath(root, ref);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify({
			version: 1,
			kind: "integration",
			repositoryRoot: await realpath(root),
			worktreePath: await realpath(worktreePath),
			ref,
			runId,
		})}\n`,
		{ flag: "wx" },
	);
	return path;
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("mergeTaskCommits", () => {
	it("applies independent writer commits in supplied order deterministically without touching user state", async () => {
		const fixture = await makeRepository();
		const first = await writerCommit(fixture, "writer-one", "one.txt", "one\n", "2024-01-02T03:04:05Z");
		const second = await writerCommit(fixture, "writer-two", "two.txt", "two\n", "2024-02-03T04:05:06Z");
		await writeFile(join(fixture.root, "shared.txt"), "staged\n");
		await git(fixture.root, "add", "shared.txt");
		await writeFile(join(fixture.root, "shared.txt"), "working\n");
		await writeFile(join(fixture.root, "untracked.txt"), "untracked\n");
		const before = {
			branch: await git(fixture.root, "symbolic-ref", "HEAD"),
			head: await git(fixture.root, "rev-parse", "HEAD"),
			index: await git(fixture.root, "write-tree"),
			status: await git(fixture.root, "status", "--porcelain=v1"),
		};

		const mergeOptions = options(fixture, [
			{ taskId: "one", commit: first },
			{ taskId: "two", commit: second },
		]);
		const initial = await mergeTaskCommits(mergeOptions);
		expect(initial.ref).toBe("refs/heads/pi/subagent/integration/run-1");
		expect(initial.orderedTaskIds).toEqual(["one", "two"]);
		expect(initial.orderedCommits).toEqual([first, second]);
		expect(await git(fixture.root, "show", `${initial.commit}:one.txt`)).toBe("one");
		expect(await git(fixture.root, "show", `${initial.commit}:two.txt`)).toBe("two");
		const retry = await mergeTaskCommits(mergeOptions);
		expect(retry.commit).toBe(initial.commit);
		expect(await exactRef(fixture.root, initial.ref)).toBe(initial.commit);
		expect(await git(fixture.root, "symbolic-ref", "HEAD")).toBe(before.branch);
		expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(before.head);
		expect(await git(fixture.root, "write-tree")).toBe(before.index);
		expect(await git(fixture.root, "status", "--porcelain=v1")).toBe(before.status);
		expect(await readFile(join(fixture.root, "shared.txt"), "utf8")).toBe("working\n");
	});

	it("fails closed on a conflict with bounded task diagnostics and no candidate ref", async () => {
		const fixture = await makeRepository();
		const first = await writerCommit(fixture, "writer-left", "shared.txt", "left\n", "2024-01-01T00:00:00Z");
		const second = await writerCommit(fixture, "writer-right", "shared.txt", "right\n", "2024-01-02T00:00:00Z");
		const ref = "refs/heads/pi/subagent/integration/run-1";

		const failure = await mergeTaskCommits(
			options(fixture, [
				{ taskId: "left", commit: first },
				{ taskId: "right", commit: second },
			]),
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(MergeConflictError);
		expect(failure).toMatchObject({ taskId: "right" });
		expect((failure as MergeConflictError).diagnostics.length).toBeLessThanOrEqual(32 * 1024);
		expect(await exactRef(fixture.root, ref)).toBeUndefined();
		await expect(access(await integrationMarkerPath(fixture.root, ref))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preserves an unmanaged linked worktree on the candidate ref and rejects the retry", async () => {
		const fixture = await makeRepository();
		const commit = await writerCommit(fixture, "writer", "one.txt", "one\n", "2024-01-01T00:00:00Z");
		const mergeOptions = options(fixture, [{ taskId: "writer", commit }]);
		const first = await mergeTaskCommits(mergeOptions);
		const unmanaged = await mkdtemp(join(tmpdir(), "user-candidate-worktree-"));
		temporaryPaths.push(unmanaged);
		await git(fixture.root, "worktree", "add", "-q", unmanaged, first.ref.slice("refs/heads/".length));
		await writeFile(join(unmanaged, "user-content.txt"), "preserve me\n");

		await expect(mergeTaskCommits(mergeOptions)).rejects.toThrow("provenance marker is absent");
		expect(await readFile(join(unmanaged, "user-content.txt"), "utf8")).toBe("preserve me\n");
		expect(await git(unmanaged, "symbolic-ref", "HEAD")).toBe(first.ref);
		expect(await exactRef(fixture.root, first.ref)).toBe(first.commit);
	});

	it("reconciles a validly marked stale subsystem worktree without removing user worktrees", async () => {
		const fixture = await makeRepository();
		const commit = await writerCommit(fixture, "writer", "one.txt", "one\n", "2024-01-01T00:00:00Z");
		const mergeOptions = options(fixture, [{ taskId: "writer", commit }]);
		const first = await mergeTaskCommits(mergeOptions);
		const userWorktree = await mkdtemp(join(tmpdir(), "user-branch-worktree-"));
		const stale = await mkdtemp(join(tmpdir(), "subagent-stale-merge-"));
		temporaryPaths.push(userWorktree, stale);
		await git(fixture.root, "worktree", "add", "-q", userWorktree, "writer");
		await writeFile(join(userWorktree, "user-content.txt"), "preserve me\n");
		await git(fixture.root, "worktree", "add", "-q", stale, first.ref.slice("refs/heads/".length));
		const markerPath = await markIntegrationWorktree(fixture.root, stale, first.ref, "run-1");

		const retry = await mergeTaskCommits(mergeOptions);
		expect(retry.commit).toBe(first.commit);
		await expect(access(stale)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(userWorktree, "user-content.txt"), "utf8")).toBe("preserve me\n");
		expect(await git(userWorktree, "symbolic-ref", "--short", "HEAD")).toBe("writer");
		expect(await git(fixture.root, "symbolic-ref", "--short", "HEAD")).toBe("user-main");
		expect(await exactRef(fixture.root, first.ref)).toBe(first.commit);
	});

	it("never removes the current worktree when it checks out the candidate ref", async () => {
		const fixture = await makeRepository();
		const commit = await writerCommit(fixture, "writer", "one.txt", "one\n", "2024-01-01T00:00:00Z");
		const mergeOptions = options(fixture, [{ taskId: "writer", commit }]);
		const first = await mergeTaskCommits(mergeOptions);
		await git(fixture.root, "checkout", "-q", first.ref.slice("refs/heads/".length));
		await writeFile(join(fixture.root, "user-content.txt"), "preserve me\n");

		await expect(mergeTaskCommits(mergeOptions)).rejects.toThrow("current user worktree");
		expect(await readFile(join(fixture.root, "user-content.txt"), "utf8")).toBe("preserve me\n");
		expect(await git(fixture.root, "symbolic-ref", "HEAD")).toBe(first.ref);
		expect(await exactRef(fixture.root, first.ref)).toBe(first.commit);
	});

	it("rejects cancellation, unsafe refs, duplicate tasks, and unknown full commits", async () => {
		const fixture = await makeRepository();
		const commit = await writerCommit(fixture, "writer", "one.txt", "one\n", "2024-01-01T00:00:00Z");
		const controller = new AbortController();
		controller.abort();
		await expect(
			mergeTaskCommits({ ...options(fixture, [{ taskId: "writer", commit }]), signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		await expect(
			mergeTaskCommits({ ...options(fixture, [{ taskId: "writer", commit }]), refPrefix: "unsafe/../ref" }),
		).rejects.toThrow("Unsafe refPrefix");
		await expect(
			mergeTaskCommits(
				options(fixture, [
					{ taskId: "writer", commit },
					{ taskId: "writer", commit },
				]),
			),
		).rejects.toThrow("Duplicate merge task ID");
		await expect(
			mergeTaskCommits(options(fixture, [{ taskId: "missing", commit: "f".repeat(40) }])),
		).rejects.toThrow();
		expect(await exactRef(fixture.root, "refs/heads/pi/subagent/integration/run-1")).toBeUndefined();
	});

	it("preserves a prior successful candidate when a retry is malformed or conflicts", async () => {
		const fixture = await makeRepository();
		const successful = await writerCommit(
			fixture,
			"writer-success",
			"success.txt",
			"success\n",
			"2024-01-01T00:00:00Z",
		);
		const initial = await mergeTaskCommits(options(fixture, [{ taskId: "success", commit: successful }]));

		await expect(
			mergeTaskCommits(options(fixture, [{ taskId: "missing", commit: "f".repeat(40) }])),
		).rejects.toThrow();
		expect(await exactRef(fixture.root, initial.ref)).toBe(initial.commit);

		const left = await writerCommit(fixture, "writer-left-retry", "shared.txt", "left\n", "2024-02-01T00:00:00Z");
		const right = await writerCommit(fixture, "writer-right-retry", "shared.txt", "right\n", "2024-02-02T00:00:00Z");
		await expect(
			mergeTaskCommits(
				options(fixture, [
					{ taskId: "left", commit: left },
					{ taskId: "right", commit: right },
				]),
			),
		).rejects.toBeInstanceOf(MergeConflictError);
		expect(await exactRef(fixture.root, initial.ref)).toBe(initial.commit);
	});

	it("ignores Git replacement refs while resolving and applying task commits", async () => {
		const fixture = await makeRepository();
		const original = await writerCommit(fixture, "writer-original", "one.txt", "original\n", "2024-01-01T00:00:00Z");
		const replacement = await writerCommit(
			fixture,
			"writer-replacement",
			"one.txt",
			"replacement\n",
			"2024-01-02T00:00:00Z",
		);
		await git(fixture.root, "replace", original, replacement);

		const integrated = await mergeTaskCommits(options(fixture, [{ taskId: "writer", commit: original }]));
		expect(await git(fixture.root, "--no-replace-objects", "show", `${integrated.commit}:one.txt`)).toBe("original");
	});

	it("releases only an exact managed candidate ref value with compare-and-swap", async () => {
		const fixture = await makeRepository();
		const commit = await writerCommit(fixture, "writer-release", "one.txt", "one\n", "2024-01-01T00:00:00Z");
		const integrated = await mergeTaskCommits(options(fixture, [{ taskId: "writer", commit }]));
		expect(await releaseMergeCandidateRef(fixture.root, integrated.ref, fixture.baseline)).toBe(false);
		expect(await exactRef(fixture.root, integrated.ref)).toBe(integrated.commit);
		await expect(releaseMergeCandidateRef(fixture.root, "refs/heads/user-main", integrated.commit)).rejects.toThrow(
			"outside refs/heads/pi/subagent",
		);
		expect(await releaseMergeCandidateRef(fixture.root, integrated.ref, integrated.commit)).toBe(true);
		expect(await exactRef(fixture.root, integrated.ref)).toBeUndefined();
	});

	it("rejects candidate prefixes outside the managed namespace without moving user refs", async () => {
		const fixture = await makeRepository();
		const commit = await writerCommit(fixture, "writer-prefix", "one.txt", "one\n", "2024-01-01T00:00:00Z");
		await git(fixture.root, "branch", "release/run-1", fixture.baseline);
		await expect(
			mergeTaskCommits({ ...options(fixture, [{ taskId: "writer", commit }]), refPrefix: "release" }),
		).rejects.toThrow("outside pi/subagent");
		expect(await exactRef(fixture.root, "refs/heads/release/run-1")).toBe(fixture.baseline);
	});

	it("does not restore a marked partial candidate after recovered integration conflicts", async () => {
		const fixture = await makeRepository();
		const left = await writerCommit(fixture, "writer-partial-left", "shared.txt", "left\n", "2024-01-01T00:00:00Z");
		const right = await writerCommit(
			fixture,
			"writer-partial-right",
			"shared.txt",
			"right\n",
			"2024-01-02T00:00:00Z",
		);
		const partial = await mergeTaskCommits(options(fixture, [{ taskId: "left", commit: left }]));
		const stale = await mkdtemp(join(tmpdir(), "subagent-partial-merge-"));
		temporaryPaths.push(stale);
		await git(fixture.root, "worktree", "add", "-q", stale, partial.ref.slice("refs/heads/".length));
		await markIntegrationWorktree(fixture.root, stale, partial.ref, "run-1");

		await expect(
			mergeTaskCommits(
				options(fixture, [
					{ taskId: "left", commit: left },
					{ taskId: "right", commit: right },
				]),
			),
		).rejects.toBeInstanceOf(MergeConflictError);
		expect(await exactRef(fixture.root, partial.ref)).toBeUndefined();
	});

	it("deletes a recovered baseline-valued stale candidate when the first commit conflicts", async () => {
		const fixture = await makeRepository();
		await git(fixture.root, "checkout", "-q", "-B", "foreign-parent", fixture.baseline);
		await writeFile(join(fixture.root, "shared.txt"), "foreign base\n");
		await git(fixture.root, "add", "shared.txt");
		await git(fixture.root, "commit", "-q", "-m", "foreign parent");
		await writeFile(join(fixture.root, "shared.txt"), "foreign result\n");
		await git(fixture.root, "add", "shared.txt");
		await git(fixture.root, "commit", "-q", "-m", "conflicting task");
		const conflicting = await git(fixture.root, "rev-parse", "HEAD");
		await git(fixture.root, "checkout", "-q", "user-main");

		const ref = "refs/heads/pi/subagent/integration/run-1";
		await git(fixture.root, "branch", ref.slice("refs/heads/".length), fixture.baseline);
		const stale = await mkdtemp(join(tmpdir(), "subagent-baseline-stale-"));
		temporaryPaths.push(stale);
		await git(fixture.root, "worktree", "add", "-q", stale, ref.slice("refs/heads/".length));
		await markIntegrationWorktree(fixture.root, stale, ref, "run-1");

		await expect(
			mergeTaskCommits(options(fixture, [{ taskId: "conflict", commit: conflicting }])),
		).rejects.toBeInstanceOf(MergeConflictError);
		expect(await exactRef(fixture.root, ref)).toBeUndefined();
	});

	it("preserves a worktree-add error and removes pre-add managed resources", async () => {
		const fixture = await makeRepository();
		const commit = await writerCommit(fixture, "writer-add-failure", "one.txt", "one\n", "2024-01-01T00:00:00Z");
		const shimDirectory = await mkdtemp(join(tmpdir(), "subagent-git-shim-"));
		const integrationDirectory = await mkdtemp(join(tmpdir(), "subagent-integration-parent-"));
		temporaryPaths.push(shimDirectory, integrationDirectory);
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const shim = join(shimDirectory, "git");
		await writeFile(
			shim,
			`#!/bin/sh\ncase " $* " in\n  *" worktree add "*) echo WORKTREE_ADD_SENTINEL >&2; exit 77 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
		);
		await chmod(shim, 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = `${shimDirectory}:${originalPath ?? ""}`;
		try {
			await expect(
				mergeTaskCommits({
					...options(fixture, [{ taskId: "writer", commit }]),
					temporaryDirectory: integrationDirectory,
				}),
			).rejects.toThrow(/WORKTREE_ADD_SENTINEL/);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
		const ref = "refs/heads/pi/subagent/integration/run-1";
		expect(await exactRef(fixture.root, ref)).toBeUndefined();
		await expect(access(await integrationMarkerPath(fixture.root, ref))).rejects.toThrow();
		expect(await readdir(integrationDirectory)).toEqual([]);
	});

	it("rejects branch-conditional custom merge drivers after creating the candidate worktree", async () => {
		const fixture = await makeRepository();
		const commit = await writerCommit(fixture, "writer-conditional", "one.txt", "one\n", "2024-01-01T00:00:00Z");
		const conditionalPath = join(fixture.root, ".git", "conditional-merge.config");
		await writeFile(conditionalPath, '[merge "conditional"]\n\tdriver = arbitrary-command %A %B\n');
		await git(
			fixture.root,
			"config",
			"--local",
			"includeIf.onbranch:pi/subagent/integration/**.path",
			conditionalPath,
		);
		await expect(mergeTaskCommits(options(fixture, [{ taskId: "writer", commit }]))).rejects.toThrow(
			"merge.*.driver",
		);
		expect(await exactRef(fixture.root, "refs/heads/pi/subagent/integration/run-1")).toBeUndefined();
	});

	it("rejects repository-local filters and custom merge drivers", async () => {
		const fixture = await makeRepository();
		await git(fixture.root, "config", "filter.untrusted.clean", "arbitrary-command");
		await expect(mergeTaskCommits(options(fixture, []))).rejects.toThrow("filter.* configuration");
		await git(fixture.root, "config", "--unset", "filter.untrusted.clean");
		await git(fixture.root, "config", "merge.untrusted.driver", "arbitrary-command %A %B");
		await expect(mergeTaskCommits(options(fixture, []))).rejects.toThrow("merge.*.driver");
	});
});
