import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { enumerateDirectoryFiles } from "./directory-inventory.ts";
import type { SnapshotHandle, SubagentPolicy } from "./types.ts";

export interface SnapshotLimits {
	maxSnapshotFiles: number;
	maxSnapshotBytes: number;
}

export interface SnapshotOptions extends SnapshotLimits {
	temporaryDirectory?: string;
	signal?: AbortSignal;
}

interface ManifestEntry {
	path: string;
	bytes: number;
	hash: string;
	executable: boolean;
}

const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			args,
			// LC_ALL=C pins the English stderr marker used by non-Git detection.
			{ cwd, encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT, signal, env: { ...process.env, LC_ALL: "C" } },
			(error, stdout, stderr) => {
				if (error) {
					const details = String(stderr).trim();
					reject(new Error(`git ${args.join(" ")} failed${details ? `: ${details}` : ""}`, { cause: error }));
					return;
				}
				resolvePromise(String(stdout));
			},
		);
	});
}

/** Sentinel recorded as the baseline commit for snapshots of non-Git directories. */
export const NON_GIT_BASELINE_COMMIT = "none";

function isNotAGitRepositoryFailure(error: unknown): boolean {
	return error instanceof Error && error.message.includes("not a git repository");
}

function isSafeGitPath(path: string): boolean {
	if (!path || path.includes("\0") || isAbsolute(path)) return false;
	const segments = path.replaceAll("\\", "/").split("/");
	return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function manifestHash(entries: ManifestEntry[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) {
		hash.update(JSON.stringify([entry.path, entry.bytes, entry.hash, entry.executable]));
		hash.update("\n");
	}
	return hash.digest("hex");
}

function validateLimits(limits: SnapshotLimits): void {
	if (!Number.isSafeInteger(limits.maxSnapshotFiles) || limits.maxSnapshotFiles < 0) {
		throw new Error("maxSnapshotFiles must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(limits.maxSnapshotBytes) || limits.maxSnapshotBytes < 0) {
		throw new Error("maxSnapshotBytes must be a non-negative safe integer");
	}
}

/**
 * Materialize the current worktree content into a private, content-addressed
 * temporary directory.
 *
 * Inside a Git worktree this uses tracked plus untracked, non-ignored files and
 * pins `HEAD` as the baseline commit. Outside Git it falls back to a bounded
 * directory enumeration with best-effort `.gitignore` rules (`.git` is never
 * included) and records `NON_GIT_BASELINE_COMMIT` as the baseline commit.
 *
 * Symlinks are never reproduced in the snapshot. A symlink whose final target is a
 * regular file inside the repository is materialized as a regular file; broken,
 * directory, and repository-escaping symlinks are skipped.
 */
export async function createRepositorySnapshot(
	repositoryPath: string,
	options: SnapshotOptions | Pick<SubagentPolicy, "maxSnapshotFiles" | "maxSnapshotBytes">,
	signal?: AbortSignal,
): Promise<SnapshotHandle> {
	validateLimits(options);
	const abortSignal = "signal" in options ? (options.signal ?? signal) : signal;
	abortSignal?.throwIfAborted();
	const requestedRoot = resolve(repositoryPath);
	let repositoryRoot: string;
	let headCommit: string;
	let listedPaths: Set<string>;
	try {
		repositoryRoot = await realpath((await git(requestedRoot, ["rev-parse", "--show-toplevel"], abortSignal)).trim());
		headCommit = (await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"], abortSignal)).trim();
		const listed = await git(
			repositoryRoot,
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			abortSignal,
		);
		listedPaths = new Set(listed.split("\0").filter(Boolean));
	} catch (error) {
		if (!isNotAGitRepositoryFailure(error)) throw error;
		// Non-Git fallback: enumerate the directory with best-effort .gitignore
		// rules; `.git` is never included and limits fail closed.
		repositoryRoot = await realpath(requestedRoot);
		headCommit = NON_GIT_BASELINE_COMMIT;
		listedPaths = new Set(
			await enumerateDirectoryFiles(repositoryRoot, { maxFiles: options.maxSnapshotFiles, signal: abortSignal }),
		);
	}
	const paths = [...listedPaths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	const temporaryDirectory = "temporaryDirectory" in options ? options.temporaryDirectory : undefined;
	if (temporaryDirectory) await mkdir(temporaryDirectory, { recursive: true });
	const snapshotPath = await mkdtemp(join(temporaryDirectory ?? tmpdir(), "pi-subagent-snapshot-"));
	const entries: ManifestEntry[] = [];
	let totalBytes = 0;
	let cleanupPromise: Promise<void> | undefined;

	try {
		for (const gitPath of paths) {
			abortSignal?.throwIfAborted();
			if (!isSafeGitPath(gitPath))
				throw new Error(`Git returned an unsafe repository path: ${JSON.stringify(gitPath)}`);

			const sourcePath = join(repositoryRoot, ...gitPath.split("/"));
			let sourceStat: Awaited<ReturnType<typeof lstat>>;
			try {
				sourceStat = await lstat(sourcePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // A tracked file deleted in the worktree.
				throw error;
			}

			let readablePath = sourcePath;
			if (sourceStat.isSymbolicLink()) {
				let target: string;
				try {
					target = await realpath(sourcePath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				if (!isWithin(repositoryRoot, target)) continue;
				const targetGitPath = relative(repositoryRoot, target).split(sep).join("/");
				// Do not let a listed symlink smuggle ignored or .git content into the snapshot.
				if (!listedPaths.has(targetGitPath)) continue;
				const targetStat = await lstat(target);
				if (!targetStat.isFile()) continue;
				readablePath = target;
				sourceStat = targetStat;
			} else if (!sourceStat.isFile()) {
				// Submodules and other non-regular index entries are not copied.
				continue;
			} else {
				const resolvedSource = await realpath(sourcePath);
				if (!isWithin(repositoryRoot, resolvedSource)) continue;
				readablePath = resolvedSource;
			}

			if (entries.length + 1 > options.maxSnapshotFiles) {
				throw new Error(`Snapshot exceeds maxSnapshotFiles (${options.maxSnapshotFiles})`);
			}

			const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
			const source = await open(readablePath, constants.O_RDONLY | noFollow);
			try {
				const openedStat = await source.stat();
				if (!openedStat.isFile()) continue;
				if (openedStat.size > options.maxSnapshotBytes - totalBytes) {
					throw new Error(`Snapshot exceeds maxSnapshotBytes (${options.maxSnapshotBytes})`);
				}
				const content = await source.readFile();
				abortSignal?.throwIfAborted();
				if (content.byteLength > options.maxSnapshotBytes - totalBytes) {
					throw new Error(`Snapshot exceeds maxSnapshotBytes (${options.maxSnapshotBytes})`);
				}

				const destinationPath = join(snapshotPath, ...gitPath.split("/"));
				await mkdir(dirname(destinationPath), { recursive: true });
				await writeFile(destinationPath, content, { flag: "wx", mode: openedStat.mode & 0o111 ? 0o555 : 0o444 });
				// Explicit chmod also applies the read-only mode on platforms that honor an existing umask.
				await chmod(destinationPath, openedStat.mode & 0o111 ? 0o555 : 0o444);

				entries.push({
					path: gitPath,
					bytes: content.byteLength,
					hash: createHash("sha256").update(content).digest("hex"),
					executable: (openedStat.mode & 0o111) !== 0,
				});
				totalBytes += content.byteLength;
			} finally {
				await source.close();
			}
		}

		const baseline = {
			repositoryRoot,
			headCommit,
			snapshotId: manifestHash(entries),
			fileCount: entries.length,
			totalBytes,
		};

		return {
			baseline,
			path: snapshotPath,
			async cleanup(): Promise<void> {
				cleanupPromise ??= rm(snapshotPath, { recursive: true, force: true });
				try {
					await cleanupPromise;
				} catch (error) {
					cleanupPromise = undefined;
					throw error;
				}
			},
		};
	} catch (error) {
		await rm(snapshotPath, { recursive: true, force: true });
		throw error;
	}
}

export const createSnapshot = createRepositorySnapshot;
