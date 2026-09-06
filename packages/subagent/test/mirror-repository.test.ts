import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectMirrorIfEmpty,
	ensureMirrorRepository,
	importMirrorBaseline,
	mirrorHasCommit,
	mirrorRepositoryPath,
} from "../src/mirror-repository.ts";

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

async function makeWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "subagent-mirror-workspace-"));
	temporaryPaths.push(root);
	return root;
}

async function makeMirrorRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "subagent-mirror-root-"));
	temporaryPaths.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("mirror-repository", () => {
	it("derives deterministic per-workspace paths", async () => {
		const root = await makeMirrorRoot();
		expect(mirrorRepositoryPath(root, "/a")).toBe(mirrorRepositoryPath(root, "/a"));
		expect(mirrorRepositoryPath(root, "/a")).not.toBe(mirrorRepositoryPath(root, "/b"));
	});

	it("imports workspace content as a deterministic root commit with modes and ignores", async () => {
		const workspace = await makeWorkspace();
		const mirrorRoot = await makeMirrorRoot();
		await mkdir(join(workspace, "src"));
		await mkdir(join(workspace, ".git", "objects"), { recursive: true });
		await writeFile(join(workspace, ".git", "config"), "stray\n");
		await writeFile(join(workspace, "src", "index.ts"), "entry\n");
		await writeFile(join(workspace, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
		await writeFile(join(workspace, "noise.log"), "noise\n");
		await writeFile(join(workspace, ".gitignore"), "*.log\n");

		const limits = { maxFiles: 100, maxBytes: 1024 * 1024 };
		const baseline = await importMirrorBaseline({ mirrorRoot, workspaceRoot: workspace, limits });
		expect(baseline.repositoryRoot).toBe(await realpath(workspace));
		expect(baseline.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
		expect(baseline.fileCount).toBe(3);

		const repo = await ensureMirrorRepository(mirrorRoot, workspace);
		expect(await git(repo, "cat-file", "-p", `${baseline.baselineCommit}^{tree}`)).toContain(".gitignore");
		const listing = await git(repo, "ls-tree", "-r", baseline.baselineCommit);
		expect(listing).toContain("src/index.ts");
		expect(listing).toContain("100755");
		expect(listing).toContain("run.sh");
		expect(listing).not.toContain("noise.log");
		expect(listing).not.toContain(".git/config");
		expect(await git(repo, "show", `${baseline.baselineCommit}:src/index.ts`)).toBe("entry");
		expect(await git(repo, "rev-list", "--count", baseline.baselineCommit)).toBe("1");

		// Identical content imports to the identical commit; changed content differs.
		const again = await importMirrorBaseline({ mirrorRoot, workspaceRoot: workspace, limits });
		expect(again.baselineCommit).toBe(baseline.baselineCommit);
		await writeFile(join(workspace, "src", "index.ts"), "entry v2\n");
		const changed = await importMirrorBaseline({ mirrorRoot, workspaceRoot: workspace, limits });
		expect(changed.baselineCommit).not.toBe(baseline.baselineCommit);
	});

	it("checks commit existence and survives concurrent imports", async () => {
		const workspace = await makeWorkspace();
		const mirrorRoot = await makeMirrorRoot();
		await writeFile(join(workspace, "a.txt"), "a\n");
		const limits = { maxFiles: 100, maxBytes: 1024 * 1024 };
		const baseline = await importMirrorBaseline({ mirrorRoot, workspaceRoot: workspace, limits });
		const repo = await ensureMirrorRepository(mirrorRoot, workspace);
		expect(await mirrorHasCommit(repo, baseline.baselineCommit)).toBe(true);
		expect(await mirrorHasCommit(repo, "0".repeat(40))).toBe(false);

		const results = await Promise.all([
			importMirrorBaseline({ mirrorRoot, workspaceRoot: workspace, limits }),
			importMirrorBaseline({ mirrorRoot, workspaceRoot: workspace, limits }),
		]);
		expect(results[0]?.baselineCommit).toBe(baseline.baselineCommit);
		expect(results[1]?.baselineCommit).toBe(baseline.baselineCommit);
	});

	it("enforces byte limits fail-closed", async () => {
		const workspace = await makeWorkspace();
		const mirrorRoot = await makeMirrorRoot();
		await writeFile(join(workspace, "big.txt"), "x".repeat(64));
		await expect(
			importMirrorBaseline({ mirrorRoot, workspaceRoot: workspace, limits: { maxFiles: 100, maxBytes: 8 } }),
		).rejects.toThrow("maxBytes");
	});

	it("reclaims an abandoned lock left by a dead process", async () => {
		const workspace = await makeWorkspace();
		const mirrorRoot = await makeMirrorRoot();
		await writeFile(join(workspace, "a.txt"), "a\n");
		const repo = await ensureMirrorRepository(mirrorRoot, workspace);
		const lockPath = `${repo}.lock`;
		await mkdir(lockPath);
		await writeFile(join(lockPath, "pid"), "99999999");
		const baseline = await importMirrorBaseline({
			mirrorRoot,
			workspaceRoot: workspace,
			limits: { maxFiles: 100, maxBytes: 1024 },
		});
		expect(baseline.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("pins the imported baseline atomically when pinRunId is given", async () => {
		const workspace = await makeWorkspace();
		const mirrorRoot = await makeMirrorRoot();
		await writeFile(join(workspace, "a.txt"), "a\n");
		const baseline = await importMirrorBaseline({
			mirrorRoot,
			workspaceRoot: workspace,
			limits: { maxFiles: 100, maxBytes: 1024 },
			pinRunId: "run-1",
		});
		const repo = await ensureMirrorRepository(mirrorRoot, workspace);
		expect(await git(repo, "rev-parse", "refs/pi-subagent/baselines/run-1")).toBe(baseline.baselineCommit);
	});

	it("collectMirrorIfEmpty deletes unreferenced mirrors and keeps pinned ones", async () => {
		const workspace = await makeWorkspace();
		const mirrorRoot = await makeMirrorRoot();
		await writeFile(join(workspace, "a.txt"), "a\n");
		const repo = await ensureMirrorRepository(mirrorRoot, workspace);

		// Unreferenced mirror (objects but no managed refs) is collected.
		await importMirrorBaseline({ mirrorRoot, workspaceRoot: workspace, limits: { maxFiles: 100, maxBytes: 1024 } });
		expect(await collectMirrorIfEmpty(mirrorRoot, workspace)).toBe(true);
		await expect(stat(repo)).rejects.toMatchObject({ code: "ENOENT" });
		// Idempotent when nothing exists.
		expect(await collectMirrorIfEmpty(mirrorRoot, workspace)).toBe(false);

		// A pinned baseline keeps the mirror alive until the pin is released.
		const baseline = await importMirrorBaseline({
			mirrorRoot,
			workspaceRoot: workspace,
			limits: { maxFiles: 100, maxBytes: 1024 },
			pinRunId: "run-1",
		});
		expect(await collectMirrorIfEmpty(mirrorRoot, workspace)).toBe(false);
		expect(await git(repo, "rev-parse", "refs/pi-subagent/baselines/run-1")).toBe(baseline.baselineCommit);
		await git(repo, "update-ref", "-d", "refs/pi-subagent/baselines/run-1");
		expect(await collectMirrorIfEmpty(mirrorRoot, workspace)).toBe(true);
		await expect(stat(repo)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
