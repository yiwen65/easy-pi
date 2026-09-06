import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositorySnapshot } from "../src/snapshot.ts";

const temporaryPaths: string[] = [];

function git(cwd: string, ...args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(String(stderr), { cause: error }));
				return;
			}
			resolve(String(stdout).trim());
		});
	});
}

async function makeRepository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "subagent-snapshot-test-"));
	temporaryPaths.push(root);
	await git(root, "init", "-q");
	await git(root, "config", "user.email", "snapshot@example.test");
	await git(root, "config", "user.name", "Snapshot Test");
	await writeFile(join(root, ".gitignore"), "*.ignored\nignored-dir/\n");
	await writeFile(join(root, "tracked.txt"), "committed\n");
	await git(root, "add", ".gitignore", "tracked.txt");
	await git(root, "commit", "-q", "-m", "baseline");
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("createRepositorySnapshot", () => {
	it("copies dirty tracked and untracked files, excludes ignored files, and is immutable from source changes", async () => {
		const root = await makeRepository();
		await writeFile(join(root, "tracked.txt"), "dirty tracked\n");
		await writeFile(join(root, "untracked.txt"), "untracked\n");
		await writeFile(join(root, "secret.ignored"), "must not copy\n");
		await mkdir(join(root, "ignored-dir"));
		await writeFile(join(root, "ignored-dir", "cache.txt"), "cache\n");

		const snapshot = await createRepositorySnapshot(root, {
			maxSnapshotFiles: 100,
			maxSnapshotBytes: 1024 * 1024,
		});
		expect(snapshot.baseline.repositoryRoot).toBe(await realpath(root));
		expect(snapshot.baseline.headCommit).toBe(await git(root, "rev-parse", "HEAD"));
		expect(snapshot.baseline.snapshotId).toMatch(/^[a-f0-9]{64}$/);
		expect(snapshot.baseline.fileCount).toBe(3);
		expect(await readFile(join(snapshot.path, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
		expect(await readFile(join(snapshot.path, "untracked.txt"), "utf8")).toBe("untracked\n");
		await expect(access(join(snapshot.path, "secret.ignored"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(join(snapshot.path, "ignored-dir", "cache.txt"))).rejects.toMatchObject({ code: "ENOENT" });

		await writeFile(join(root, "tracked.txt"), "changed after snapshot\n");
		await writeFile(join(root, "untracked.txt"), "also changed\n");
		expect(await readFile(join(snapshot.path, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
		expect(await readFile(join(snapshot.path, "untracked.txt"), "utf8")).toBe("untracked\n");

		const snapshotPath = snapshot.path;
		await snapshot.cleanup();
		await snapshot.cleanup();
		await expect(access(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(process.platform === "win32")(
		"materializes safe symlinks but skips symlinks escaping the repository",
		async () => {
			const root = await makeRepository();
			const outside = await mkdtemp(join(tmpdir(), "subagent-snapshot-outside-"));
			temporaryPaths.push(outside);
			await writeFile(join(root, "target.txt"), "inside\n");
			await writeFile(join(root, "ignored-target.ignored"), "ignored\n");
			await writeFile(join(outside, "secret.txt"), "outside\n");
			await symlink("target.txt", join(root, "safe-link"));
			await symlink("ignored-target.ignored", join(root, "ignored-link"));
			await symlink(join(outside, "secret.txt"), join(root, "escape-link"));

			const snapshot = await createRepositorySnapshot(root, {
				maxSnapshotFiles: 100,
				maxSnapshotBytes: 1024 * 1024,
			});
			expect(await readFile(join(snapshot.path, "safe-link"), "utf8")).toBe("inside\n");
			await expect(access(join(snapshot.path, "ignored-link"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(access(join(snapshot.path, "escape-link"))).rejects.toMatchObject({ code: "ENOENT" });
			await snapshot.cleanup();
		},
	);

	it("enforces file and byte limits and removes partial snapshots", async () => {
		const root = await makeRepository();
		const snapshotParent = await mkdtemp(join(tmpdir(), "subagent-snapshot-parent-"));
		temporaryPaths.push(snapshotParent);

		await expect(
			createRepositorySnapshot(root, {
				maxSnapshotFiles: 1,
				maxSnapshotBytes: 1024,
				temporaryDirectory: snapshotParent,
			}),
		).rejects.toThrow("maxSnapshotFiles");
		expect(await readdir(snapshotParent)).toEqual([]);

		await expect(
			createRepositorySnapshot(root, {
				maxSnapshotFiles: 100,
				maxSnapshotBytes: 1,
				temporaryDirectory: snapshotParent,
			}),
		).rejects.toThrow("maxSnapshotBytes");
		expect(await readdir(snapshotParent)).toEqual([]);
	});
});

describe("createRepositorySnapshot (non-Git fallback)", () => {
	it("snapshots a non-Git directory with best-effort ignores and a sentinel baseline", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-nongit-snapshot-"));
		temporaryPaths.push(root);
		await mkdir(join(root, "src"));
		await mkdir(join(root, ".git", "objects"), { recursive: true });
		await writeFile(join(root, ".git", "config"), "stray\n");
		await writeFile(join(root, "src", "index.ts"), "entry\n");
		await writeFile(join(root, "ignored.log"), "log\n");
		await writeFile(join(root, ".gitignore"), "*.log\n");

		const snapshot = await createRepositorySnapshot(root, {
			maxSnapshotFiles: 10,
			maxSnapshotBytes: 1024 * 1024,
		});
		try {
			expect(snapshot.baseline.repositoryRoot).toBe(await realpath(root));
			expect(snapshot.baseline.headCommit).toBe("none");
			expect(snapshot.baseline.snapshotId).toMatch(/^[a-f0-9]{64}$/);
			expect(snapshot.baseline.fileCount).toBe(2);
			expect(await readFile(join(snapshot.path, "src", "index.ts"), "utf8")).toBe("entry\n");
			expect(await readFile(join(snapshot.path, ".gitignore"), "utf8")).toBe("*.log\n");
			await expect(access(join(snapshot.path, "ignored.log"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(access(join(snapshot.path, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await snapshot.cleanup();
		}
	});

	it.skipIf(process.platform === "win32")("skips escaping symlinks in non-Git mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-nongit-snapshot-"));
		temporaryPaths.push(root);
		const outside = await mkdtemp(join(tmpdir(), "subagent-snapshot-outside-"));
		temporaryPaths.push(outside);
		await writeFile(join(root, "target.txt"), "inside\n");
		await writeFile(join(outside, "secret.txt"), "outside\n");
		await symlink("target.txt", join(root, "safe-link"));
		await symlink(join(outside, "secret.txt"), join(root, "escape-link"));

		const snapshot = await createRepositorySnapshot(root, {
			maxSnapshotFiles: 10,
			maxSnapshotBytes: 1024 * 1024,
		});
		try {
			expect(await readFile(join(snapshot.path, "safe-link"), "utf8")).toBe("inside\n");
			await expect(access(join(snapshot.path, "escape-link"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await snapshot.cleanup();
		}
	});

	it("enforces limits fail-closed in non-Git mode and removes partial snapshots", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-nongit-snapshot-"));
		temporaryPaths.push(root);
		const snapshotParent = await mkdtemp(join(tmpdir(), "subagent-snapshot-parent-"));
		temporaryPaths.push(snapshotParent);
		await writeFile(join(root, "a.txt"), "a\n");
		await writeFile(join(root, "b.txt"), "b\n");

		await expect(
			createRepositorySnapshot(root, {
				maxSnapshotFiles: 1,
				maxSnapshotBytes: 1024,
				temporaryDirectory: snapshotParent,
			}),
		).rejects.toThrow(/maxFiles|maxSnapshotFiles/);
		expect(await readdir(snapshotParent)).toEqual([]);

		await expect(
			createRepositorySnapshot(root, {
				maxSnapshotFiles: 100,
				maxSnapshotBytes: 1,
				temporaryDirectory: snapshotParent,
			}),
		).rejects.toThrow("maxSnapshotBytes");
		expect(await readdir(snapshotParent)).toEqual([]);
	});
});
