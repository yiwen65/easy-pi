import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { enumerateDirectoryFiles } from "./directory-inventory.ts";
import { boundedGitEnvironment, pinRunBaseline, runGit, textOutput } from "./worktree.ts";

/**
 * Internal mirror repositories give non-Git workspaces the full Subagent Phase 2
 * machinery (frozen baselines, isolated writer worktrees, merge candidates, pins)
 * without ever modifying the user's directory. Each non-Git workspace root maps
 * deterministically to one mirror repository under the Subagent state directory;
 * a baseline import enumerates the workspace (best-effort `.gitignore`, `.git`
 * excluded, bounded limits) and commits the content as a root commit inside the
 * mirror. All existing Git implementations are then reused with the mirror path.
 */

export interface MirrorLimits {
	maxFiles: number;
	maxBytes: number;
}

export interface MirrorBaselineOptions {
	mirrorRoot: string;
	workspaceRoot: string;
	limits: MirrorLimits;
	/** When set, the imported baseline commit is pinned under this run ID inside the same lock. */
	pinRunId?: string;
	temporaryDirectory?: string;
	signal?: AbortSignal;
}

export interface MirrorBaseline {
	/** Canonical user workspace root (never the mirror path). */
	repositoryRoot: string;
	baselineCommit: string;
	fileCount: number;
	totalBytes: number;
}

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 100;
const LOCK_STALE_MS = 10 * 60_000;
const MIRROR_ENV: NodeJS.ProcessEnv = {
	GIT_AUTHOR_NAME: "pi-subagent",
	GIT_AUTHOR_EMAIL: "pi-subagent@localhost.invalid",
	GIT_COMMITTER_NAME: "pi-subagent",
	GIT_COMMITTER_EMAIL: "pi-subagent@localhost.invalid",
	GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};

/**
 * Deterministic mirror repository path for a canonical (realpath) workspace root.
 * Callers with an uncanonicalized path must go through `ensureMirrorRepository`.
 */
export function mirrorRepositoryPath(mirrorRoot: string, workspaceRoot: string): string {
	const digest = createHash("sha256").update(`pi-subagent-mirror-v1\0${workspaceRoot}`).digest("hex");
	return join(mirrorRoot, `mirror-${digest.slice(0, 32)}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Mirror repository operation aborted");
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/** Initialize the mirror repository if absent; returns the repository path. */
export async function ensureMirrorRepository(
	mirrorRoot: string,
	workspaceRoot: string,
	signal?: AbortSignal,
): Promise<string> {
	throwIfAborted(signal);
	const canonical = await realpath(workspaceRoot);
	const repo = mirrorRepositoryPath(mirrorRoot, canonical);
	try {
		await stat(join(repo, ".git"));
		return repo;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(repo, { recursive: true });
	await runGit(["init", "-q", "-b", "mirror-main"], { cwd: repo, signal });
	return repo;
}

/** True when `commit` resolves to a commit object inside the mirror repository. */
export async function mirrorHasCommit(repositoryPath: string, commit: string, signal?: AbortSignal): Promise<boolean> {
	throwIfAborted(signal);
	const result = await runGit(["cat-file", "-e", `${commit}^{commit}`], {
		cwd: repositoryPath,
		signal,
		allowExitCodes: [0, 1, 128],
	});
	return result.exitCode === 0;
}

async function processExists(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Serialize mirror mutations across co-located Pi processes. The lock is a
 * directory containing the owner's pid; a dead owner's lock is stolen after
 * LOCK_STALE_MS or immediately once the pid is gone.
 */
async function withMirrorLock<T>(repo: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	const lockPath = `${repo}.lock`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		throwIfAborted(signal);
		try {
			await mkdir(lockPath);
			await writeFile(join(lockPath, "pid"), String(process.pid), { mode: 0o600 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let stale = false;
			try {
				const pidText = await readFile(join(lockPath, "pid"), "utf8");
				const pid = Number.parseInt(pidText, 10);
				const lockStat = await stat(lockPath);
				stale =
					(Number.isSafeInteger(pid) && !(await processExists(pid))) ||
					Date.now() - lockStat.mtimeMs > LOCK_STALE_MS;
			} catch {
				stale = true; // Unreadable lock metadata: treat as abandoned.
			}
			if (stale) {
				await rm(lockPath, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Timed out acquiring mirror repository lock: ${lockPath}`);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_MS));
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lockPath, { recursive: true, force: true });
	}
}

/**
 * Import the current workspace content as a deterministic root commit inside the
 * mirror repository. Concurrent imports are serialized; the user's directory is
 * only ever read. Symlink handling mirrors the analyst snapshot policy.
 */
export async function importMirrorBaseline(options: MirrorBaselineOptions): Promise<MirrorBaseline> {
	throwIfAborted(options.signal);
	if (!Number.isSafeInteger(options.limits.maxFiles) || options.limits.maxFiles < 0) {
		throw new Error("maxFiles must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(options.limits.maxBytes) || options.limits.maxBytes < 0) {
		throw new Error("maxBytes must be a non-negative safe integer");
	}
	const workspaceRoot = await realpath(options.workspaceRoot);
	const repo = await ensureMirrorRepository(options.mirrorRoot, workspaceRoot, options.signal);

	return await withMirrorLock(repo, options.signal, async () => {
		const paths = await enumerateDirectoryFiles(workspaceRoot, {
			maxFiles: options.limits.maxFiles,
			signal: options.signal,
		});
		const listed = new Set(paths);
		const stagingParent = options.temporaryDirectory ?? tmpdir();
		await mkdir(stagingParent, { recursive: true });
		const staging = await mkdtemp(join(stagingParent, "pi-subagent-mirror-import-"));
		// Private index lives outside the staging tree so `add -A` never captures it.
		const indexPath = `${staging}.index`;
		let fileCount = 0;
		let totalBytes = 0;
		try {
			for (const relPath of paths) {
				throwIfAborted(options.signal);
				const sourcePath = join(workspaceRoot, ...relPath.split("/"));
				let sourceStat: Awaited<ReturnType<typeof lstat>>;
				try {
					sourceStat = await lstat(sourcePath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
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
					if (!isWithin(workspaceRoot, target)) continue;
					const targetRel = relative(workspaceRoot, target).split(sep).join("/");
					if (!listed.has(targetRel)) continue;
					const targetStat = await lstat(target);
					if (!targetStat.isFile()) continue;
					readablePath = target;
					sourceStat = targetStat;
				} else if (!sourceStat.isFile()) {
					continue;
				}
				const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
				const source = await open(readablePath, constants.O_RDONLY | noFollow);
				try {
					const openedStat = await source.stat();
					if (!openedStat.isFile()) continue;
					if (openedStat.size > options.limits.maxBytes - totalBytes) {
						throw new Error(`Mirror baseline exceeds maxBytes (${options.limits.maxBytes})`);
					}
					const content = await source.readFile();
					if (content.byteLength > options.limits.maxBytes - totalBytes) {
						throw new Error(`Mirror baseline exceeds maxBytes (${options.limits.maxBytes})`);
					}
					const destination = join(staging, ...relPath.split("/"));
					await mkdir(dirname(destination), { recursive: true });
					await writeFile(destination, content, { flag: "wx", mode: openedStat.mode & 0o111 ? 0o755 : 0o644 });
					await chmod(destination, openedStat.mode & 0o111 ? 0o755 : 0o644);
					fileCount += 1;
					totalBytes += content.byteLength;
				} finally {
					await source.close();
				}
			}

			// Populate a private index from the staging tree, then commit the tree as a
			// root commit with a fixed identity/timestamp so identical content yields
			// an identical baseline commit.
			const env = boundedGitEnvironment({ ...MIRROR_ENV, GIT_INDEX_FILE: indexPath });
			await runGit(["--git-dir", join(repo, ".git"), "--work-tree", staging, "add", "-A", "--", "."], {
				cwd: staging,
				env,
				signal: options.signal,
			});
			const tree = textOutput(
				await runGit(["--git-dir", join(repo, ".git"), "write-tree"], {
					cwd: staging,
					env,
					signal: options.signal,
				}),
			);
			const commit = textOutput(
				await runGit(["--git-dir", join(repo, ".git"), "commit-tree", tree, "-m", "pi subagent mirror baseline"], {
					cwd: staging,
					env,
					signal: options.signal,
				}),
			);
			// Pin inside the import lock so mirror GC can never observe an unpinned baseline.
			if (options.pinRunId !== undefined) {
				await pinRunBaseline(repo, options.pinRunId, commit, options.signal);
			}
			return { repositoryRoot: workspaceRoot, baselineCommit: commit, fileCount, totalBytes };
		} finally {
			await rm(staging, { recursive: true, force: true });
			await rm(indexPath, { force: true });
		}
	});
}

/**
 * Delete a mirror repository once nothing references it: no managed Subagent
 * refs (`refs/pi-subagent/*`, `refs/heads/pi/subagent/*`) and no registered
 * linked worktrees. Runs inside the mirror lock so it is mutually exclusive
 * with baseline imports. Returns true when the repository was removed.
 */
export async function collectMirrorIfEmpty(
	mirrorRoot: string,
	workspaceRoot: string,
	signal?: AbortSignal,
): Promise<boolean> {
	throwIfAborted(signal);
	let canonical: string;
	try {
		canonical = await realpath(workspaceRoot);
	} catch {
		return false;
	}
	const repo = mirrorRepositoryPath(mirrorRoot, canonical);
	try {
		await stat(join(repo, ".git"));
	} catch {
		return false;
	}
	return await withMirrorLock(repo, signal, async () => {
		const refs = textOutput(
			await runGit(["for-each-ref", "--format=%(refname)", "refs/pi-subagent", "refs/heads/pi/subagent"], {
				cwd: repo,
				signal,
			}),
		).trim();
		if (refs) return false;
		const worktreeList = textOutput(await runGit(["worktree", "list", "--porcelain"], { cwd: repo, signal }));
		const repoCanonical = await realpath(repo);
		const linked: string[] = [];
		for (const line of worktreeList.split("\n")) {
			if (!line.startsWith("worktree ")) continue;
			const worktreePath = line.slice("worktree ".length);
			let canonical: string;
			try {
				canonical = await realpath(worktreePath);
			} catch {
				continue; // Stale registration whose directory is already gone.
			}
			if (canonical !== repoCanonical) linked.push(canonical);
		}
		if (linked.length > 0) return false;
		await rm(repo, { recursive: true, force: true });
		return true;
	});
}
