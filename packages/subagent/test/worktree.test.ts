import { execFile } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	commitWorktree,
	createFrozenBaseline,
	createTaskWorktree,
	inspectWorktreeChanges,
	NotAGitRepositoryError,
	pinRunBaseline,
	pinTaskCommit,
	reconcileTaskWorktrees,
	releaseRunBaselinePin,
	releaseTaskCommitPin,
	resolveRepositoryRoot,
	validateWorktreeOwnership,
} from "../src/worktree.ts";

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

async function makeRepository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "subagent-worktree-test-"));
	temporaryPaths.push(root);
	await git(root, "init", "-q", "-b", "user-main");
	await git(root, "config", "user.email", "worktree@example.test");
	await git(root, "config", "user.name", "Worktree Test");
	await mkdir(join(root, "owned"));
	await writeFile(join(root, ".gitignore"), "*.ignored\n");
	await writeFile(join(root, "tracked.txt"), "committed\n");
	await writeFile(join(root, "owned", "existing.txt"), "existing\n");
	await git(root, "add", ".gitignore", "tracked.txt", "owned/existing.txt");
	await git(root, "commit", "-q", "-m", "initial");
	await git(root, "branch", "user-keep");
	return root;
}

async function refs(root: string): Promise<string> {
	return await git(root, "for-each-ref", "--format=%(refname):%(objectname)");
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("retains interrupted edits until explicit disposition permits reconciliation", async () => {
	const root = await makeRepository();
	const handle = await createTaskWorktree({
		repositoryPath: root,
		baselineCommit: await git(root, "rev-parse", "HEAD"),
		runId: "retain-run",
		taskId: "writer",
	});
	temporaryPaths.push(dirname(handle.path));
	await writeFile(join(handle.path, "owned", "unfinished.txt"), "undelivered edits\n");
	expect(handle.retainForDisposition).toBeDefined();
	await handle.retainForDisposition?.();
	await handle.retainForDisposition?.();
	await expect(reconcileTaskWorktrees(root, "retain-run", "writer")).rejects.toThrow(/retained/);
	expect(await readFile(join(handle.path, "owned", "unfinished.txt"), "utf8")).toBe("undelivered edits\n");
	await reconcileTaskWorktrees(root, "retain-run", "writer", undefined, { discardRetained: true });
	await expect(access(handle.path)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("resolveRepositoryRoot", () => {
	it("throws NotAGitRepositoryError outside a Git working tree", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-nongit-test-"));
		temporaryPaths.push(root);
		await expect(resolveRepositoryRoot(root)).rejects.toBeInstanceOf(NotAGitRepositoryError);
	});

	it("resolves the top-level inside a Git working tree", async () => {
		const root = await makeRepository();
		expect(await resolveRepositoryRoot(root)).toBe(await realpath(root));
	});
});

describe("createFrozenBaseline", () => {
	it("freezes dirty tracked and untracked non-ignored content without mutating HEAD, the branch, index, or refs", async () => {
		const root = await makeRepository();
		await writeFile(join(root, "tracked.txt"), "staged content\n");
		await git(root, "add", "tracked.txt");
		await writeFile(join(root, "tracked.txt"), "working content\n");
		await writeFile(join(root, "untracked.txt"), "untracked content\n");
		await writeFile(join(root, "secret.ignored"), "ignored content\n");
		const headBefore = await git(root, "rev-parse", "HEAD");
		const branchBefore = await git(root, "symbolic-ref", "--short", "HEAD");
		const indexBefore = await git(root, "write-tree");
		const refsBefore = await refs(root);

		const baseline = await createFrozenBaseline(root);
		expect(baseline.repositoryRoot).toBe(await realpath(root));
		expect(baseline.headCommit).toBe(headBefore);
		expect(await git(root, "show", `${baseline.baselineCommit}:tracked.txt`)).toBe("working content");
		expect(await git(root, "show", `${baseline.baselineCommit}:untracked.txt`)).toBe("untracked content");
		const ignored = await gitResult(root, "cat-file", "-e", `${baseline.baselineCommit}:secret.ignored`);
		expect(ignored.code).not.toBe(0);
		expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
		expect(await git(root, "symbolic-ref", "--short", "HEAD")).toBe(branchBefore);
		expect(await git(root, "write-tree")).toBe(indexBefore);
		expect(await refs(root)).toBe(refsBefore);

		await baseline.cleanup();
		await baseline.cleanup();
	});

	it("rejects repository-local filters before staging", async () => {
		const root = await makeRepository();
		await git(root, "config", "filter.untrusted.clean", "untrusted-filter-command");
		await expect(createFrozenBaseline(root)).rejects.toThrow("filter.* configuration");
	});

	it("rejects a temporary directory inside the repository without creating it", async () => {
		const root = await makeRepository();
		const requested = join(root, "must-not-exist", "temporary");
		await expect(createFrozenBaseline(root, { temporaryDirectory: requested })).rejects.toThrow(
			"temporaryDirectory must resolve outside",
		);
		await expect(access(join(root, "must-not-exist"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("conservatively rejects repositories containing a Git submodule", async () => {
		const root = await makeRepository();
		const commit = await git(root, "rev-parse", "HEAD");
		await git(root, "update-index", "--add", "--cacheinfo", `160000,${commit},modules/nested`);
		await git(root, "commit", "-q", "-m", "add gitlink");
		await expect(createFrozenBaseline(root)).rejects.toThrow("containing Git submodules");
	});
});

describe("task worktrees", () => {
	it("creates two isolated unique task branches from the same frozen baseline", async () => {
		const root = await makeRepository();
		await writeFile(join(root, "tracked.txt"), "frozen dirty\n");
		const baseline = await createFrozenBaseline(root);
		const first = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "run-1",
			taskId: "one",
		});
		const second = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "run-1",
			taskId: "two",
		});

		expect(first.branch).toMatch(/^pi\/subagent\/task\/run-1\/one-[a-f0-9]{16}$/);
		expect(second.branch).toMatch(/^pi\/subagent\/task\/run-1\/two-[a-f0-9]{16}$/);
		expect(first.branch).not.toBe(second.branch);
		expect(await readFile(join(first.path, "tracked.txt"), "utf8")).toBe("frozen dirty\n");
		expect(await readFile(join(second.path, "tracked.txt"), "utf8")).toBe("frozen dirty\n");
		await writeFile(join(first.path, "owned", "first.txt"), "first\n");
		await expect(access(join(second.path, "owned", "first.txt"))).rejects.toMatchObject({ code: "ENOENT" });

		const commonDirectory = resolve(root, await git(root, "rev-parse", "--git-common-dir"));
		const markerDirectory = join(commonDirectory, "pi-subagent-worktree-markers");
		const markerFiles = await readdir(markerDirectory);
		expect(markerFiles).toHaveLength(2);
		const markers = await Promise.all(
			markerFiles.map(async (file) => JSON.parse(await readFile(join(markerDirectory, file), "utf8"))),
		);
		expect(markers).toContainEqual({
			version: 1,
			kind: "task",
			repositoryRoot: await realpath(root),
			worktreePath: first.path,
			branch: first.branch,
			runId: "run-1",
			taskId: "one",
			baselineCommit: baseline.baselineCommit,
		});
		if (process.platform !== "win32") {
			expect((await stat(markerDirectory)).mode & 0o777).toBe(0o700);
			for (const file of markerFiles) expect((await stat(join(markerDirectory, file))).mode & 0o777).toBe(0o600);
		}

		await first.cleanup();
		await second.cleanup();
		await baseline.cleanup();
	});

	it("fails closed without deleting the worktree when its durable marker changes", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "marker",
			taskId: "cas",
		});
		const markerDirectory = join(
			resolve(root, await git(root, "rev-parse", "--git-common-dir")),
			"pi-subagent-worktree-markers",
		);
		const markerFiles = await readdir(markerDirectory);
		expect(markerFiles).toHaveLength(1);
		const markerPath = join(markerDirectory, markerFiles[0]!);
		const original = await readFile(markerPath);
		await writeFile(markerPath, Buffer.concat([original.subarray(0, -1), Buffer.from(" \n")]));

		await expect(handle.cleanup()).rejects.toThrow("valid infrastructure provenance marker");
		expect(await access(handle.path)).toBeUndefined();
		expect(await git(root, "show-ref", "--verify", `refs/heads/${handle.branch}`)).toContain(handle.branch);

		await writeFile(markerPath, original);
		await handle.cleanup();
		await baseline.cleanup();
	});

	it("returns sorted owned changes and rejects unsafe, out-of-scope, and .git ownership paths", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "audit",
			taskId: "paths",
		});
		await writeFile(join(handle.path, "owned", "z.txt"), "z\n");
		await writeFile(join(handle.path, "owned", "a.txt"), "a\n");
		expect(await inspectWorktreeChanges(handle, ["owned"])).toEqual(["owned/a.txt", "owned/z.txt"]);
		await writeFile(join(handle.path, "outside.txt"), "outside\n");
		await expect(inspectWorktreeChanges(handle, ["owned"])).rejects.toThrow("outside owned paths");
		await unlink(join(handle.path, "outside.txt"));
		await expect(inspectWorktreeChanges(handle, ["../escape"])).rejects.toThrow("Unsafe owned path");
		await expect(inspectWorktreeChanges(handle, [".git"])).rejects.toThrow("Unsafe owned path");

		await handle.cleanup();
		await baseline.cleanup();
	});

	it("rejects ownership that overlaps a Git submodule", async () => {
		const root = await makeRepository();
		const commit = await git(root, "rev-parse", "HEAD");
		await git(root, "update-index", "--add", "--cacheinfo", `160000,${commit},owned/nested-module`);
		await git(root, "commit", "-q", "-m", "add owned gitlink");
		const baselineCommit = await git(root, "rev-parse", "HEAD");
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit,
			runId: "audit",
			taskId: "submodule",
		});
		await expect(validateWorktreeOwnership(handle, ["owned"])).rejects.toThrow("cross Git submodule");
		await handle.cleanup();
	});

	it("keeps ignored runtime output outside the audited change set and exact commit", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "audit",
			taskId: "ignored",
		});
		await writeFile(join(handle.path, "outside.ignored"), "runtime output\n");
		await writeFile(join(handle.path, "owned", "result.txt"), "artifact content\n");
		expect(await inspectWorktreeChanges(handle, ["owned"])).toEqual(["owned/result.txt"]);
		const commit = await commitWorktree(handle, "exclude ignored output");
		expect((await gitResult(handle.path, "cat-file", "-e", `${commit}:outside.ignored`)).code).not.toBe(0);
		expect(await git(handle.path, "show", `${commit}:owned/result.txt`)).toBe("artifact content");
		await handle.cleanup();
		await baseline.cleanup();
	});

	it.skipIf(process.platform === "win32")(
		"excludes ignored dependency trees containing symlink descendants",
		async () => {
			const root = await makeRepository();
			const baseline = await createFrozenBaseline(root);
			const handle = await createTaskWorktree({
				repositoryPath: root,
				baselineCommit: baseline.baselineCommit,
				runId: "audit",
				taskId: "ignored-links",
			});
			await mkdir(join(handle.path, "owned", "dependencies.ignored"));
			await symlink("../existing.txt", join(handle.path, "owned", "dependencies.ignored", "tool"));
			await writeFile(join(handle.path, "owned", "result.txt"), "artifact content\n");
			expect(await inspectWorktreeChanges(handle, ["owned"])).toEqual(["owned/result.txt"]);
			const commit = await commitWorktree(handle, "exclude ignored dependency links");
			expect(
				(await gitResult(handle.path, "cat-file", "-e", `${commit}:owned/dependencies.ignored/tool`)).code,
			).not.toBe(0);
			await handle.cleanup();
			await baseline.cleanup();
		},
	);

	it.each(["core.excludesFile", "info/exclude"])(
		"does not trust Child-mutable shared Git ignore policy from %s",
		async (source) => {
			const root = await makeRepository();
			const baseline = await createFrozenBaseline(root);
			const handle = await createTaskWorktree({
				repositoryPath: root,
				baselineCommit: baseline.baselineCommit,
				runId: "audit",
				taskId: source === "core.excludesFile" ? "core-exclude" : "info-exclude",
			});
			if (source === "core.excludesFile") {
				const excludesRoot = await mkdtemp(join(tmpdir(), "subagent-excludes-test-"));
				temporaryPaths.push(excludesRoot);
				const excludesFile = join(excludesRoot, "excludes");
				await writeFile(excludesFile, "outside-hidden.txt\n");
				await git(handle.path, "config", "--local", "core.excludesFile", excludesFile);
			} else {
				const output = await git(handle.path, "rev-parse", "--git-path", "info/exclude");
				const excludesFile = resolve(handle.path, output);
				await writeFile(excludesFile, `${await readFile(excludesFile, "utf8")}outside-hidden.txt\n`);
			}
			await writeFile(join(handle.path, "outside-hidden.txt"), "must remain visible to audit\n");
			await writeFile(join(handle.path, "owned", "result.txt"), "artifact content\n");
			await expect(inspectWorktreeChanges(handle, ["owned"])).rejects.toThrow(
				"Changed path is outside owned paths: outside-hidden.txt",
			);
			await handle.cleanup();
			await baseline.cleanup();
		},
	);

	it("stages the exact audited path even when shared Git config excludes it", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "audit",
			taskId: "force-exact",
		});
		const excludesRoot = await mkdtemp(join(tmpdir(), "subagent-excludes-test-"));
		temporaryPaths.push(excludesRoot);
		const excludesFile = join(excludesRoot, "excludes");
		await writeFile(excludesFile, "owned/result.txt\n");
		await git(handle.path, "config", "--local", "core.excludesFile", excludesFile);
		await writeFile(join(handle.path, "owned", "result.txt"), "artifact content\n");
		expect(await inspectWorktreeChanges(handle, ["owned"])).toEqual(["owned/result.txt"]);
		const commit = await commitWorktree(handle, "stage exact audited path");
		expect(await git(handle.path, "show", `${commit}:owned/result.txt`)).toBe("artifact content");
		await handle.cleanup();
		await baseline.cleanup();
	});

	it("commits audited filenames with Git pathspec magic literally", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "audit",
			taskId: "literal-pathspec",
		});
		const magicPath = ":(glob)*";
		await writeFile(join(handle.path, magicPath), "literal path\n");
		expect(await inspectWorktreeChanges(handle, [magicPath])).toEqual([magicPath]);
		const commit = await commitWorktree(handle, "commit literal pathspec");
		expect(await git(handle.path, "show", `${commit}:${magicPath}`)).toBe("literal path");
		await handle.cleanup();
		await baseline.cleanup();
	});

	it("rejects a changed managed .git control file and explains the common-directory boundary", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "audit",
			taskId: "control",
		});
		const controlPath = join(handle.path, ".git");
		const original = await readFile(controlPath);
		await writeFile(controlPath, "gitdir: changed\n");
		await expect(validateWorktreeOwnership(handle, ["owned"])).rejects.toThrow(
			"common-directory writes remain outside",
		);
		await writeFile(controlPath, original);
		await handle.cleanup();
		await baseline.cleanup();
	});

	it.skipIf(process.platform === "win32")(
		"rejects an owned path with a symlink inherited from the baseline before execution",
		async () => {
			const root = await makeRepository();
			await symlink("existing.txt", join(root, "owned", "baseline-link"));
			const baseline = await createFrozenBaseline(root);
			const handle = await createTaskWorktree({
				repositoryPath: root,
				baselineCommit: baseline.baselineCommit,
				runId: "audit",
				taskId: "baseline-link",
			});
			await expect(validateWorktreeOwnership(handle, ["owned/baseline-link/child.txt"])).rejects.toThrow(
				"Owned path contains a symbolic link",
			);
			await handle.cleanup();
			await baseline.cleanup();
		},
	);

	it.skipIf(process.platform === "win32")(
		"recursively rejects any baseline symlink below an owned directory before writer execution",
		async () => {
			const root = await makeRepository();
			await mkdir(join(root, "owned", "nested"));
			await symlink("../existing.txt", join(root, "owned", "nested", "baseline-link"));
			const baseline = await createFrozenBaseline(root);
			const handle = await createTaskWorktree({
				repositoryPath: root,
				baselineCommit: baseline.baselineCommit,
				runId: "audit",
				taskId: "descendant-link",
			});
			await expect(validateWorktreeOwnership(handle, ["owned"])).rejects.toThrow("symbolic-link descendant");
			await handle.cleanup();
			await baseline.cleanup();
		},
	);

	it.skipIf(process.platform === "win32")(
		"rejects a changed symlink, including the final path component",
		async () => {
			const root = await makeRepository();
			const baseline = await createFrozenBaseline(root);
			const handle = await createTaskWorktree({
				repositoryPath: root,
				baselineCommit: baseline.baselineCommit,
				runId: "audit",
				taskId: "link",
			});
			await symlink("existing.txt", join(handle.path, "owned", "link.txt"));
			await expect(inspectWorktreeChanges(handle, ["owned"])).rejects.toThrow("symbolic link");
			await handle.cleanup();
			await baseline.cleanup();
		},
	);

	it("rejects a same-path content mutation after the caller audit", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "audit",
			taskId: "digest",
		});
		const changed = join(handle.path, "owned", "digest.txt");
		await writeFile(changed, "audited bytes\n");
		expect(await inspectWorktreeChanges(handle, ["owned"])).toEqual(["owned/digest.txt"]);
		await writeFile(changed, "mutated bytes\n");
		await expect(commitWorktree(handle, "must not commit")).rejects.toThrow("changed after its caller audit");
		await handle.cleanup();
		await baseline.cleanup();
	});

	it("uses a private temporary index and ignores unrelated entries in the worktree index", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "audit",
			taskId: "private-index",
		});
		await writeFile(join(handle.path, "owned", "private.txt"), "audited bytes\n");
		await inspectWorktreeChanges(handle, ["owned"]);
		await git(
			handle.path,
			"update-index",
			"--add",
			"--cacheinfo",
			"100644",
			"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
			"index-only.txt",
		);
		const commit = await commitWorktree(handle, "private index commit");
		expect(await git(handle.path, "show", `${commit}:owned/private.txt`)).toBe("audited bytes");
		expect((await gitResult(handle.path, "cat-file", "-e", `${commit}:index-only.txt`)).code).not.toBe(0);
		await handle.cleanup();
		await baseline.cleanup();
	});

	it("rejects repository-local filters before commit staging", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "config",
			taskId: "filter",
		});
		await writeFile(join(handle.path, "owned", "filtered.txt"), "content\n");
		await inspectWorktreeChanges(handle, ["owned"]);
		await git(root, "config", "filter.untrusted.clean", "untrusted-filter-command");
		await expect(commitWorktree(handle, "must not filter")).rejects.toThrow("filter.* configuration");
		await git(root, "config", "--unset-all", "filter.untrusted.clean");
		await handle.cleanup();
		await baseline.cleanup();
	});

	it.skipIf(process.platform === "win32")("disables repository-local Git hooks on worktree creation", async () => {
		const root = await makeRepository();
		const hooks = join(root, ".test-hooks");
		const marker = join(root, "hook-ran");
		await mkdir(hooks);
		const hook = join(hooks, "post-checkout");
		await writeFile(
			hook,
			`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran\\n");\n`,
		);
		await chmod(hook, 0o755);
		await git(root, "config", "core.hooksPath", ".test-hooks");
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "config",
			taskId: "hooks",
		});
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await handle.cleanup();
		await baseline.cleanup();
	});

	it("commits only after audit and cleanup retries, is idempotent, and preserves user refs and branch", async () => {
		const root = await makeRepository();
		const branchBefore = await git(root, "symbolic-ref", "--short", "HEAD");
		const refsBefore = await refs(root);
		const baseline = await createFrozenBaseline(root);
		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "commit",
			taskId: "writer",
		});
		await writeFile(join(handle.path, "owned", "committed.txt"), "task result\n");
		await expect(commitWorktree(handle, "not audited")).rejects.toThrow("audited before commit");
		expect(await inspectWorktreeChanges(handle, ["owned"])).toEqual(["owned/committed.txt"]);
		const commit = await commitWorktree(handle, "task commit");
		expect(commit).toMatch(/^[a-f0-9]{40,64}$/);
		expect(await git(handle.path, "rev-parse", "HEAD")).toBe(commit);
		expect(await git(handle.path, "show", `${commit}:owned/committed.txt`)).toBe("task result");
		expect(await git(root, "symbolic-ref", "--short", "HEAD")).toBe(branchBefore);

		const commonDirectoryOutput = await git(root, "rev-parse", "--git-common-dir");
		const commonDirectory = resolve(root, commonDirectoryOutput);
		const lockPath = join(commonDirectory, "refs", "heads", `${handle.branch}.lock`);
		await mkdir(dirname(lockPath), { recursive: true });
		await writeFile(lockPath, "locked\n");
		await expect(handle.cleanup()).rejects.toThrow();
		await unlink(lockPath);
		await handle.cleanup();
		await handle.cleanup();
		await expect(access(handle.path)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await gitResult(root, "show-ref", "--verify", `refs/heads/${handle.branch}`)).code).not.toBe(0);
		expect(await git(root, "symbolic-ref", "--short", "HEAD")).toBe(branchBefore);
		expect(await refs(root)).toBe(refsBefore);
		await baseline.cleanup();
	});
});

describe("durable commit pins", () => {
	it("keeps synthetic and task commits resolvable, pins idempotently, and releases only exact values", async () => {
		const root = await makeRepository();
		const head = await git(root, "rev-parse", "HEAD");
		await writeFile(join(root, "tracked.txt"), "frozen dirty\n");
		const baseline = await createFrozenBaseline(root);
		const baselineRef = "refs/pi-subagent/baselines/durable-run";
		const taskRef = "refs/pi-subagent/tasks/durable-run/writer";

		expect(await pinRunBaseline(root, "durable-run", baseline.baselineCommit)).toBe(baselineRef);
		expect(await pinRunBaseline(root, "durable-run", baseline.baselineCommit)).toBe(baselineRef);
		await expect(pinRunBaseline(root, "durable-run", head)).rejects.toThrow("different commit");

		const handle = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "durable-run",
			taskId: "writer",
		});
		await writeFile(join(handle.path, "owned", "result.txt"), "durable result\n");
		await inspectWorktreeChanges(handle, ["owned"]);
		const taskCommit = await commitWorktree(handle, "durable task commit");
		expect(await pinTaskCommit(root, "durable-run", "writer", taskCommit)).toBe(taskRef);
		expect(await pinTaskCommit(root, "durable-run", "writer", taskCommit)).toBe(taskRef);
		await expect(pinTaskCommit(root, "durable-run", "writer", head)).rejects.toThrow("different commit");

		await handle.cleanup();
		await baseline.cleanup();
		expect(await git(root, "rev-parse", `${baselineRef}^{commit}`)).toBe(baseline.baselineCommit);
		expect(await git(root, "rev-parse", `${taskRef}^{commit}`)).toBe(taskCommit);

		// Reopening ledger-like state repeats the persisted pins without replacing them.
		expect(await pinRunBaseline(root, "durable-run", baseline.baselineCommit)).toBe(baselineRef);
		expect(await pinTaskCommit(root, "durable-run", "writer", taskCommit)).toBe(taskRef);

		await expect(releaseRunBaselinePin(root, "durable-run", head)).rejects.toThrow("expectedCommit");
		expect(await git(root, "rev-parse", baselineRef)).toBe(baseline.baselineCommit);
		await expect(releaseTaskCommitPin(root, "durable-run", "writer", head)).rejects.toThrow("expectedCommit");
		expect(await git(root, "rev-parse", taskRef)).toBe(taskCommit);

		await releaseRunBaselinePin(root, "durable-run", baseline.baselineCommit);
		await releaseTaskCommitPin(root, "durable-run", "writer", taskCommit);
		expect((await gitResult(root, "show-ref", "--verify", baselineRef)).code).not.toBe(0);
		expect((await gitResult(root, "show-ref", "--verify", taskRef)).code).not.toBe(0);
	});
});

describe("reconcileTaskWorktrees", () => {
	it("removes one stale task worktree and ref while preserving other task and user state", async () => {
		const root = await makeRepository();
		const baseline = await createFrozenBaseline(root);
		const stale = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "recover-run",
			taskId: "stale",
		});
		const other = await createTaskWorktree({
			repositoryPath: root,
			baselineCommit: baseline.baselineCommit,
			runId: "recover-run",
			taskId: "other",
		});
		const userContainer = await mkdtemp(join(tmpdir(), "subagent-user-worktree-test-"));
		temporaryPaths.push(userContainer);
		const userWorktree = join(userContainer, "worktree");
		await git(root, "worktree", "add", "-q", userWorktree, "user-keep");
		const head = await git(root, "rev-parse", "HEAD");
		await git(root, "update-ref", "refs/user/keep", head);
		const userRefsBefore = await refs(root);

		const markerDirectory = join(
			resolve(root, await git(root, "rev-parse", "--git-common-dir")),
			"pi-subagent-worktree-markers",
		);
		const markerEntries = await Promise.all(
			(await readdir(markerDirectory)).map(async (file) => ({
				file,
				contents: await readFile(join(markerDirectory, file), "utf8"),
			})),
		);
		const markerBefore = markerEntries.find(({ contents }) => contents.includes(`"branch":"${stale.branch}"`))?.file;
		expect(markerBefore).toBeDefined();

		// Simulate recovery in a new manager process: reconciliation has no access
		// to the handle's in-memory state and must rely on the durable exact marker.
		await reconcileTaskWorktrees(root, "recover-run", "stale");

		await expect(access(stale.path)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await gitResult(root, "show-ref", "--verify", `refs/heads/${stale.branch}`)).code).not.toBe(0);
		expect((await readdir(markerDirectory)).some((file) => file === markerBefore)).toBe(false);
		expect(await access(other.path)).toBeUndefined();
		expect(await git(root, "show-ref", "--verify", `refs/heads/${other.branch}`)).toContain(other.branch);
		expect(await access(userWorktree)).toBeUndefined();
		expect(await git(root, "show-ref", "--verify", "refs/heads/user-keep")).toContain("user-keep");
		expect(await git(root, "rev-parse", "refs/user/keep")).toBe(head);
		expect(
			(await refs(root))
				.split("\n")
				.filter((line) => !line.includes(stale.branch))
				.join("\n"),
		).toBe(
			userRefsBefore
				.split("\n")
				.filter((line) => !line.includes(stale.branch))
				.join("\n"),
		);

		await other.cleanup();
		await git(root, "worktree", "remove", "--force", userWorktree);
		await baseline.cleanup();
	});

	it("rejects and preserves an unmanaged linked worktree whose branch only matches the task prefix", async () => {
		const root = await makeRepository();
		const branch = "pi/subagent/task/user-run/user-task-0123456789abcdef";
		await git(root, "branch", branch);
		const userContainer = await mkdtemp(join(tmpdir(), "subagent-unmanaged-worktree-test-"));
		temporaryPaths.push(userContainer);
		const userWorktree = join(userContainer, "worktree");
		await git(root, "worktree", "add", "-q", userWorktree, branch);

		await expect(reconcileTaskWorktrees(root, "user-run", "user-task")).rejects.toThrow(
			"valid infrastructure provenance marker",
		);
		expect(await access(userWorktree)).toBeUndefined();
		expect(await git(userWorktree, "symbolic-ref", "--short", "HEAD")).toBe(branch);
		expect(await git(root, "show-ref", "--verify", `refs/heads/${branch}`)).toContain(branch);

		await git(root, "worktree", "remove", "--force", userWorktree);
	});

	it("rejects and preserves an unmarked orphan branch in the task namespace", async () => {
		const root = await makeRepository();
		const branch = "pi/subagent/task/orphan-run/orphan-task-0123456789abcdef";
		await git(root, "branch", branch);

		await expect(reconcileTaskWorktrees(root, "orphan-run", "orphan-task")).rejects.toThrow(
			"valid infrastructure provenance marker",
		);
		expect(await git(root, "show-ref", "--verify", `refs/heads/${branch}`)).toContain(branch);
	});
});
