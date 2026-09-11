import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorktreeHandle } from "./types.ts";

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const FORCE_KILL_DELAY_MS = 250;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_MARKER_VERSION = 1;
const TASK_MARKER_DIRECTORY = "pi-subagent-worktree-markers";
const MAX_TASK_MARKER_BYTES = 16 * 1024;

export interface FrozenBaselineOptions {
	temporaryDirectory?: string;
	/** Optional run identifier; mirror-backed baselines pin atomically under this ID. Ignored for real Git worktrees. */
	runId?: string;
	signal?: AbortSignal;
}

export interface FrozenBaselineHandle {
	repositoryRoot: string;
	headCommit: string;
	baselineCommit: string;
	cleanup(): Promise<void>;
}

export interface CreateTaskWorktreeOptions {
	repositoryPath: string;
	baselineCommit: string;
	runId: string;
	taskId: string;
	temporaryDirectory?: string;
	signal?: AbortSignal;
}

interface GitResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number;
}

interface RunGitOptions {
	cwd: string;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	allowExitCodes?: readonly number[];
}

interface AuditedPath {
	path: string;
	mode: "100644" | "100755" | "deleted";
	bytes?: Buffer;
	digest?: string;
}

interface AuditRecord {
	ownedPaths: string[];
	changedPaths: string[];
	digest: string;
	paths: AuditedPath[];
	parentCommit: string;
}

interface FileSeal {
	mode: number;
	digest: string;
}

interface TaskWorktreeMarker {
	version: typeof TASK_MARKER_VERSION;
	kind: "task";
	repositoryRoot: string;
	worktreePath: string;
	branch: string;
	runId: string;
	taskId: string;
	baselineCommit: string;
}

interface ValidatedTaskMarker {
	marker: TaskWorktreeMarker;
	path: string;
	seal: FileSeal;
}

interface TaskWorktreeState {
	handle: WorktreeHandle;
	repositoryRoot: string;
	worktreePath: string;
	containerPath: string;
	branch: string;
	gitControlSeal: FileSeal;
	marker: TaskWorktreeMarker;
	markerPath: string;
	markerSeal: FileSeal;
	worktreeRemoved: boolean;
	branchRemoved: boolean;
	containerRemoved: boolean;
	markerRemoved: boolean;
	cleanupComplete: boolean;
	audit?: AuditRecord;
}

const taskWorktrees = new WeakMap<WorktreeHandle, TaskWorktreeState>();

function abortError(): Error {
	const error = new Error("Git operation cancelled");
	error.name = "AbortError";
	return error;
}

const COMMON_DIRECTORY_BOUNDARY_NOTICE =
	"Git common-directory writes remain outside this no-OS-sandbox ownership boundary";
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export function boundedGitEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	Object.assign(env, overrides);
	return {
		...env,
		GIT_ATTR_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: NULL_DEVICE,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: NULL_DEVICE,
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		LC_ALL: "C",
	};
}

export async function runGit(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
	if (options.signal?.aborted) throw abortError();
	return await new Promise<GitResult>((resolvePromise, rejectPromise) => {
		let settled = false;
		let processError: Error | undefined;
		let forcedError: Error | undefined;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let child: ReturnType<typeof spawn>;

		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", onAbort);
			callback();
		};

		try {
			child = spawn("git", ["-c", `core.hooksPath=${NULL_DEVICE}`, ...args], {
				cwd: options.cwd,
				env: boundedGitEnvironment(options.env),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			rejectPromise(error);
			return;
		}

		const terminate = (): void => {
			child.kill("SIGTERM");
			if (!forceKillTimer) {
				forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
				forceKillTimer.unref();
			}
		};
		function onAbort(): void {
			forcedError ??= abortError();
			terminate();
		}
		const collect = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
			const next = Buffer.from(chunk);
			if (stream === "stdout") {
				stdoutBytes += next.length;
				if (stdoutBytes <= MAX_STDOUT_BYTES) stdoutChunks.push(next);
				if (stdoutBytes > MAX_STDOUT_BYTES && !forcedError) {
					forcedError = new Error(`Git stdout exceeded ${MAX_STDOUT_BYTES} bytes`);
					terminate();
				}
				return;
			}
			stderrBytes += next.length;
			if (stderrBytes <= MAX_STDERR_BYTES) stderrChunks.push(next);
			if (stderrBytes > MAX_STDERR_BYTES && !forcedError) {
				forcedError = new Error(`Git stderr exceeded ${MAX_STDERR_BYTES} bytes`);
				terminate();
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
		child.on("error", (error) => {
			processError = error;
		});
		child.on("close", (code, signal) => {
			finish(() => {
				if (forcedError) return rejectPromise(forcedError);
				if (processError) return rejectPromise(new Error("Unable to start Git", { cause: processError }));
				const exitCode = code ?? -1;
				const stdout = Buffer.concat(stdoutChunks);
				const stderr = Buffer.concat(stderrChunks);
				if (!(options.allowExitCodes ?? [0]).includes(exitCode)) {
					const detail = stderr.toString("utf8").trim();
					return rejectPromise(
						new Error(
							`Git ${args[0] ?? "command"} failed (${signal ? `signal ${signal}` : `exit ${exitCode}`})${detail ? `: ${detail}` : ""}`,
						),
					);
				}
				resolvePromise({ stdout, stderr, exitCode });
			});
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}

export function textOutput(result: GitResult): string {
	const value = result.stdout.toString("utf8");
	if (value.includes("\uFFFD") || value.includes("\0")) throw new Error("Git returned an unsafe path or ref value");
	return value.replace(/\r?\n$/, "");
}

/** Thrown when the given path is not inside any Git working tree. */
export class NotAGitRepositoryError extends Error {
	readonly repositoryPath: string;

	constructor(repositoryPath: string, options?: ErrorOptions) {
		super(`Path is not inside a Git repository: ${repositoryPath}`, options);
		this.name = "NotAGitRepositoryError";
		this.repositoryPath = repositoryPath;
	}
}

async function repositoryRoot(repositoryPath: string, signal?: AbortSignal): Promise<string> {
	let topLevelResult: GitResult;
	try {
		topLevelResult = await runGit(["rev-parse", "--show-toplevel"], { cwd: repositoryPath, signal });
	} catch (error) {
		// runGit pins LC_ALL=C, so this stderr marker is stable across locales.
		if (error instanceof Error && error.message.includes("not a git repository")) {
			throw new NotAGitRepositoryError(repositoryPath, { cause: error });
		}
		throw error;
	}
	const topLevel = textOutput(topLevelResult);
	if (!topLevel || topLevel.includes("\n") || topLevel.includes("\r"))
		throw new Error("Git returned an unsafe repository root");
	const root = await realpath(topLevel);
	const inside = textOutput(await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: root, signal }));
	if (inside !== "true") throw new Error("repositoryPath is not inside a Git working tree");
	return root;
}

/** Resolve the effective Git worktree root with the same hardened environment used by workspace operations. */
export async function resolveRepositoryRoot(repositoryPath: string, signal?: AbortSignal): Promise<string> {
	return await repositoryRoot(repositoryPath, signal);
}

function isWithin(parent: string, candidate: string): boolean {
	const path = relative(parent, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function canonicalDestination(path: string): Promise<string> {
	let ancestor = path;
	const missingComponents: string[] = [];
	for (;;) {
		try {
			return resolve(await realpath(ancestor), ...missingComponents.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			missingComponents.push(basename(ancestor));
			ancestor = parent;
		}
	}
}

async function prepareTemporaryParent(path: string | undefined, repository: string): Promise<string> {
	const requested = resolve(path ?? tmpdir());
	if (isWithin(repository, requested)) throw new Error("temporaryDirectory must be outside the repository");
	const prospectiveCanonical = await canonicalDestination(requested);
	if (isWithin(repository, prospectiveCanonical)) {
		throw new Error("temporaryDirectory must resolve outside the repository");
	}
	await mkdir(requested, { recursive: true });
	const canonical = await realpath(requested);
	if (isWithin(repository, canonical)) throw new Error("temporaryDirectory must resolve outside the repository");
	return canonical;
}

export function assertTaskIdentifier(value: string, name: string): void {
	if (
		!TASK_ID_PATTERN.test(value) ||
		value.includes("..") ||
		value.endsWith(".") ||
		value.toLowerCase().endsWith(".lock")
	) {
		throw new Error(`Unsafe ${name}: ${value}`);
	}
}

function assertCommitId(value: string, name = "baselineCommit"): void {
	if (!/^[a-fA-F0-9]{40,64}$/.test(value)) throw new Error(`${name} must be a full hexadecimal commit ID`);
}

function taskMarkerBytes(marker: TaskWorktreeMarker): Buffer {
	return Buffer.from(`${JSON.stringify(marker)}\n`, "utf8");
}

function taskMarkerFileName(branch: string): string {
	return `${createHash("sha256").update(branch).digest("hex")}.json`;
}

async function commonGitDirectory(root: string, signal?: AbortSignal): Promise<string> {
	const output = textOutput(await runGit(["rev-parse", "--git-common-dir"], { cwd: root, signal }));
	if (!output || output.includes("\n") || output.includes("\r")) {
		throw new Error("Git returned an unsafe common directory");
	}
	const commonDirectory = await realpath(resolve(root, output));
	const metadata = await lstat(commonDirectory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Git common directory is not a regular directory");
	}
	return commonDirectory;
}

function hasPrivateMode(mode: number, expected: number): boolean {
	return process.platform === "win32" || (mode & 0o777) === expected;
}

async function markerDirectory(root: string, create: boolean, signal?: AbortSignal): Promise<string> {
	const directory = join(await commonGitDirectory(root, signal), TASK_MARKER_DIRECTORY);
	let created = false;
	if (create) {
		try {
			await mkdir(directory, { mode: 0o700 });
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (created) await chmod(directory, 0o700);
	}
	const metadata = await lstat(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || !hasPrivateMode(metadata.mode, 0o700)) {
		throw new Error("Task provenance marker directory is not a private regular directory");
	}
	return directory;
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch (error) {
		if (process.platform !== "win32") throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function createTaskMarker(
	root: string,
	marker: TaskWorktreeMarker,
	signal?: AbortSignal,
): Promise<{ path: string; seal: FileSeal }> {
	const directory = await markerDirectory(root, true, signal);
	const path = join(directory, taskMarkerFileName(marker.branch));
	const bytes = taskMarkerBytes(marker);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let created = false;
	try {
		handle = await open(path, "wx", 0o600);
		created = true;
		await handle.writeFile(bytes);
		await handle.chmod(0o600);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await syncDirectory(directory);
		return { path, seal: await regularFileSeal(path, "Task provenance marker") };
	} catch (error) {
		await handle?.close().catch(() => {});
		if (created) await rm(path, { force: true }).catch(() => {});
		throw error;
	}
}

function parseTaskMarker(bytes: Buffer): TaskWorktreeMarker {
	if (bytes.length === 0 || bytes.length > MAX_TASK_MARKER_BYTES || bytes.includes(0)) {
		throw new Error("Task provenance marker has invalid bytes");
	}
	const text = bytes.toString("utf8");
	if (text.includes("\uFFFD")) throw new Error("Task provenance marker is not valid UTF-8");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error("Task provenance marker is not valid JSON", { cause: error });
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Task provenance marker is not an object");
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const expectedKeys = [
		"baselineCommit",
		"branch",
		"kind",
		"repositoryRoot",
		"runId",
		"taskId",
		"version",
		"worktreePath",
	].sort();
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
		throw new Error("Task provenance marker has unexpected fields");
	}
	if (
		record.version !== TASK_MARKER_VERSION ||
		record.kind !== "task" ||
		typeof record.repositoryRoot !== "string" ||
		typeof record.worktreePath !== "string" ||
		typeof record.branch !== "string" ||
		typeof record.runId !== "string" ||
		typeof record.taskId !== "string" ||
		typeof record.baselineCommit !== "string"
	) {
		throw new Error("Task provenance marker has invalid fields");
	}
	const marker = record as unknown as TaskWorktreeMarker;
	assertTaskIdentifier(marker.runId, "marker runId");
	assertTaskIdentifier(marker.taskId, "marker taskId");
	assertCommitId(marker.baselineCommit, "marker baselineCommit");
	if (!marker.branch || marker.branch.includes("\0") || marker.branch.includes("\n") || marker.branch.includes("\r")) {
		throw new Error("Task provenance marker has an unsafe branch");
	}
	return marker;
}

async function validateTaskMarker(
	root: string,
	runId: string,
	taskId: string,
	branch: string,
	expectedWorktreePath?: string,
	expectedPath?: string,
	expectedSeal?: FileSeal,
	signal?: AbortSignal,
): Promise<ValidatedTaskMarker> {
	let path = expectedPath;
	try {
		const exactPath = join(await markerDirectory(root, false, signal), taskMarkerFileName(branch));
		if (path !== undefined && path !== exactPath) throw new Error("marker path is not the package-owned exact path");
		path = exactPath;
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink() || !hasPrivateMode(metadata.mode, 0o600)) {
			throw new Error("marker is not a private regular file");
		}
		const bytes = await readFile(path);
		const marker = parseTaskMarker(bytes);
		const seal = {
			mode: metadata.mode & 0o7777,
			digest: createHash("sha256").update(bytes).digest("hex"),
		};
		if (expectedSeal && (seal.mode !== expectedSeal.mode || seal.digest !== expectedSeal.digest)) {
			throw new Error("marker changed after creation or validation");
		}
		if (
			marker.repositoryRoot !== root ||
			marker.branch !== branch ||
			marker.runId !== runId ||
			marker.taskId !== taskId
		) {
			throw new Error("marker does not match the exact task worktree");
		}
		if (
			resolve(marker.repositoryRoot) !== marker.repositoryRoot ||
			resolve(marker.worktreePath) !== marker.worktreePath
		) {
			throw new Error("marker paths are not canonical absolute paths");
		}
		if (
			(await canonicalDestination(marker.worktreePath)) !== marker.worktreePath ||
			isWithin(root, marker.worktreePath)
		) {
			throw new Error("marker worktree path is not a canonical external path");
		}
		if (expectedWorktreePath !== undefined) {
			const canonicalExpected = await canonicalDestination(resolve(expectedWorktreePath));
			if (marker.worktreePath !== canonicalExpected) throw new Error("marker worktree path does not match Git");
		}
		return { marker, path, seal };
	} catch (error) {
		throw new Error(`Matching task branch lacks a valid infrastructure provenance marker: ${branch}`, {
			cause: error,
		});
	}
}

async function removeValidatedTaskMarker(validated: ValidatedTaskMarker, signal?: AbortSignal): Promise<void> {
	await validateTaskMarker(
		validated.marker.repositoryRoot,
		validated.marker.runId,
		validated.marker.taskId,
		validated.marker.branch,
		validated.marker.worktreePath,
		validated.path,
		validated.seal,
		signal,
	);
	await rm(`${validated.path}.retained`, { force: true });
	await unlink(validated.path);
	await syncDirectory(dirname(validated.path));
}

async function refValue(root: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await runGit(["show-ref", "--verify", "--quiet", ref], {
		cwd: root,
		signal,
		allowExitCodes: [0, 1],
	});
	if (result.exitCode !== 0) return undefined;
	return textOutput(await runGit(["rev-parse", "--verify", ref], { cwd: root, signal }));
}

async function deleteExactRef(root: string, ref: string, signal?: AbortSignal): Promise<void> {
	const value = await refValue(root, ref, signal);
	if (value) await runGit(["update-ref", "-d", ref, value], { cwd: root, signal });
}

async function resolveExactCommit(root: string, commit: string, signal?: AbortSignal): Promise<string> {
	const resolved = textOutput(await runGit(["rev-parse", "--verify", `${commit}^{commit}`], { cwd: root, signal }));
	if (resolved.toLowerCase() !== commit.toLowerCase()) {
		throw new Error("commit did not resolve to the supplied full commit ID");
	}
	return resolved;
}

async function pinExactCommit(root: string, ref: string, commit: string, signal?: AbortSignal): Promise<string> {
	const resolved = await resolveExactCommit(root, commit, signal);
	const existing = await refValue(root, ref, signal);
	if (existing) {
		if (existing.toLowerCase() === resolved.toLowerCase()) return ref;
		throw new Error(`${ref} is already pinned to a different commit`);
	}
	try {
		// An empty old value is update-ref's compare-and-swap assertion that the ref is absent.
		await runGit(["update-ref", ref, resolved, ""], { cwd: root, signal });
	} catch (error) {
		// A concurrent writer of the same value is still an idempotent success.
		const concurrent = await refValue(root, ref, signal);
		if (concurrent?.toLowerCase() === resolved.toLowerCase()) return ref;
		if (concurrent) throw new Error(`${ref} is already pinned to a different commit`, { cause: error });
		throw error;
	}
	return ref;
}

async function releaseExactPin(
	root: string,
	ref: string,
	expectedCommit?: string,
	signal?: AbortSignal,
): Promise<void> {
	if (expectedCommit !== undefined) assertCommitId(expectedCommit, "expectedCommit");
	const existing = await refValue(root, ref, signal);
	if (!existing) return;
	if (expectedCommit !== undefined && existing.toLowerCase() !== expectedCommit.toLowerCase()) {
		throw new Error(`${ref} does not match expectedCommit`);
	}
	// Use the caller's expected value as the CAS guard when supplied. An
	// unconditional release is still guarded by the exact value observed above.
	await runGit(["update-ref", "-d", ref, expectedCommit ?? existing], { cwd: root, signal });
}

export async function pinRunBaseline(
	repositoryPath: string,
	runId: string,
	commit: string,
	signal?: AbortSignal,
): Promise<string> {
	assertTaskIdentifier(runId, "runId");
	assertCommitId(commit, "commit");
	const root = await repositoryRoot(repositoryPath, signal);
	return await pinExactCommit(root, `refs/pi-subagent/baselines/${runId}`, commit, signal);
}

export async function pinTaskCommit(
	repositoryPath: string,
	runId: string,
	taskId: string,
	commit: string,
	signal?: AbortSignal,
): Promise<string> {
	assertTaskIdentifier(runId, "runId");
	assertTaskIdentifier(taskId, "taskId");
	assertCommitId(commit, "commit");
	const root = await repositoryRoot(repositoryPath, signal);
	return await pinExactCommit(root, `refs/pi-subagent/tasks/${runId}/${taskId}`, commit, signal);
}

export async function releaseRunBaselinePin(
	repositoryPath: string,
	runId: string,
	expectedCommit?: string,
	signal?: AbortSignal,
): Promise<void> {
	assertTaskIdentifier(runId, "runId");
	if (expectedCommit !== undefined) assertCommitId(expectedCommit, "expectedCommit");
	const root = await repositoryRoot(repositoryPath, signal);
	await releaseExactPin(root, `refs/pi-subagent/baselines/${runId}`, expectedCommit, signal);
}

export async function releaseTaskCommitPin(
	repositoryPath: string,
	runId: string,
	taskId: string,
	expectedCommit?: string,
	signal?: AbortSignal,
): Promise<void> {
	assertTaskIdentifier(runId, "runId");
	assertTaskIdentifier(taskId, "taskId");
	if (expectedCommit !== undefined) assertCommitId(expectedCommit, "expectedCommit");
	const root = await repositoryRoot(repositoryPath, signal);
	await releaseExactPin(root, `refs/pi-subagent/tasks/${runId}/${taskId}`, expectedCommit, signal);
}

interface RegisteredWorktree {
	path: string;
	branch?: string;
}

function registeredWorktrees(output: Buffer): RegisteredWorktree[] {
	if (output.length === 0) return [];
	if (output.at(-1) !== 0) throw new Error("Git returned a malformed worktree list");
	const text = output.toString("utf8");
	if (text.includes("\uFFFD")) throw new Error("Git returned a worktree path that is not valid UTF-8");
	const worktrees: RegisteredWorktree[] = [];
	let current: RegisteredWorktree | undefined;
	for (const field of text.slice(0, -1).split("\0")) {
		if (field === "") {
			if (current) worktrees.push(current);
			current = undefined;
			continue;
		}
		if (field.startsWith("worktree ")) {
			if (current) throw new Error("Git returned a malformed worktree list");
			const path = field.slice("worktree ".length);
			if (!path) throw new Error("Git returned an empty worktree path");
			current = { path };
			continue;
		}
		if (!current) throw new Error("Git returned a malformed worktree list");
		if (field.startsWith("branch ")) current.branch = field.slice("branch ".length);
	}
	if (current) worktrees.push(current);
	return worktrees;
}

async function matchingTaskRefs(
	root: string,
	runId: string,
	taskId: string,
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	const prefix = `refs/heads/pi/subagent/task/${runId}/${taskId}-`;
	const output = textOutput(
		await runGit(["for-each-ref", "--format=%(refname) %(objectname)", `${prefix}*`], { cwd: root, signal }),
	);
	const matches = new Map<string, string>();
	if (!output) return matches;
	for (const line of output.split("\n")) {
		const separator = line.indexOf(" ");
		if (separator < 0) throw new Error("Git returned malformed task ref metadata");
		const ref = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (!ref.startsWith(prefix)) throw new Error("Git returned a task ref outside the requested namespace");
		assertCommitId(value, "task ref value");
		matches.set(ref, value);
	}
	return matches;
}

async function isCurrentWorktree(path: string, root: string): Promise<boolean> {
	if (resolve(path) === root) return true;
	try {
		return (await realpath(path)) === root;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Reconciles worktrees for one recovered task. The caller must already hold
 * that task's recovered durable-ledger claim; this function does not acquire
 * or verify the claim and must not be used for an active, unclaimed task.
 */
export async function reconcileTaskWorktrees(
	repositoryPath: string,
	runId: string,
	taskId: string,
	signal?: AbortSignal,
	options: { discardRetained?: boolean } = {},
): Promise<void> {
	assertTaskIdentifier(runId, "runId");
	assertTaskIdentifier(taskId, "taskId");
	const root = await repositoryRoot(repositoryPath, signal);
	const taskBranchPrefix = `refs/heads/pi/subagent/task/${runId}/${taskId}-`;
	const taskRefs = await matchingTaskRefs(root, runId, taskId, signal);
	const listed = registeredWorktrees(
		(await runGit(["worktree", "list", "--porcelain", "-z"], { cwd: root, signal })).stdout,
	);
	const matchingWorktrees = listed.filter((worktree) => worktree.branch?.startsWith(taskBranchPrefix));
	const worktreeByBranch = new Map<string, RegisteredWorktree>();
	for (const worktree of matchingWorktrees) {
		const ref = worktree.branch;
		if (!ref) continue;
		if (worktreeByBranch.has(ref)) throw new Error(`Task branch is checked out more than once: ${ref}`);
		worktreeByBranch.set(ref, worktree);
	}

	// Validate durable provenance for every candidate before changing any of
	// them. A user-created branch that merely resembles our namespace is never
	// sufficient authority to delete its worktree or ref.
	const candidates = new Set<string>([
		...taskRefs.keys(),
		...matchingWorktrees.flatMap((worktree) => (worktree.branch ? [worktree.branch] : [])),
	]);
	const validated = new Map<string, ValidatedTaskMarker>();
	const observedRefs = new Map<string, string>();
	for (const ref of candidates) {
		const branch = ref.slice("refs/heads/".length);
		const worktree = worktreeByBranch.get(ref);
		const marker = await validateTaskMarker(
			root,
			runId,
			taskId,
			branch,
			worktree?.path,
			undefined,
			undefined,
			signal,
		);
		if (!options.discardRetained) {
			try {
				await lstat(`${marker.path}.retained`);
				throw new Error(
					"Interrupted worktree is retained; explicitly acknowledge delivery or discard before cleanup",
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (worktree && (await isCurrentWorktree(worktree.path, root))) {
			throw new Error("Refusing to reconcile the current user worktree");
		}
		const current = await refValue(root, ref, signal);
		const listedValue = taskRefs.get(ref);
		if (current && listedValue && current.toLowerCase() !== listedValue.toLowerCase()) {
			throw new Error(`Task ref changed during reconciliation: ${ref}`);
		}
		if (current) observedRefs.set(ref, current);
		validated.set(ref, marker);
	}

	for (const [ref, marker] of validated) {
		const worktree = worktreeByBranch.get(ref);
		if (worktree) {
			const currentHead = textOutput(
				await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: worktree.path, signal }),
			);
			if (currentHead !== ref) throw new Error(`Task worktree changed branch during reconciliation: ${ref}`);
			await runGit(["worktree", "remove", "--force", "--force", worktree.path], { cwd: root, signal });
		}
		const expectedRef = observedRefs.get(ref);
		const current = await refValue(root, ref, signal);
		if (current) {
			if (!expectedRef || current.toLowerCase() !== expectedRef.toLowerCase()) {
				throw new Error(`Task ref changed during reconciliation: ${ref}`);
			}
			await runGit(["update-ref", "-d", ref, expectedRef], { cwd: root, signal });
		}
		await removeValidatedTaskMarker(marker, signal);
		try {
			await rmdir(dirname(marker.marker.worktreePath));
		} catch (error) {
			if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
}

async function hasExactWorktree(root: string, worktreePath: string): Promise<boolean> {
	const output = (await runGit(["worktree", "list", "--porcelain", "-z"], { cwd: root })).stdout;
	return output.includes(Buffer.from(`worktree ${worktreePath}\0`));
}

function commitIdentityEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		GIT_AUTHOR_NAME: "Pi Subagent",
		GIT_AUTHOR_EMAIL: "subagent@localhost",
		GIT_COMMITTER_NAME: "Pi Subagent",
		GIT_COMMITTER_EMAIL: "subagent@localhost",
		...overrides,
	};
}

function gitlinkPaths(output: Buffer): string[] {
	const records = parseNulPaths(output);
	const paths: string[] = [];
	for (const record of records) {
		const tab = record.indexOf("\t");
		if (tab < 0) throw new Error("Git returned malformed tree metadata");
		const metadata = record.slice(0, tab);
		if (metadata.split(" ", 1)[0] !== "160000") continue;
		const path = record.slice(tab + 1);
		assertSafeRelativePath(path, "submodule path");
		paths.push(path);
	}
	return paths;
}

async function indexedGitlinks(cwd: string, signal?: AbortSignal): Promise<string[]> {
	return gitlinkPaths((await runGit(["ls-files", "--stage", "-z", "--"], { cwd, signal })).stdout);
}

async function assertRepositoryHasNoSubmodules(root: string, signal?: AbortSignal): Promise<void> {
	const [headTree, index] = await Promise.all([
		runGit(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd: root, signal }),
		runGit(["ls-files", "--stage", "-z", "--"], { cwd: root, signal }),
	]);
	if (gitlinkPaths(headTree.stdout).length > 0 || gitlinkPaths(index.stdout).length > 0) {
		throw new Error("Repositories containing Git submodules cannot be frozen safely");
	}
}

async function assertNoLocalFilters(root: string, signal?: AbortSignal): Promise<void> {
	const configured = await runGit(["config", "--local", "--includes", "--name-only", "--get-regexp", "^filter\\."], {
		cwd: root,
		signal,
		allowExitCodes: [0, 1],
	});
	if (configured.exitCode === 0) {
		throw new Error("Repository-local filter.* configuration is not allowed before Git staging");
	}
}

export async function createFrozenBaseline(
	repositoryPath: string,
	options: FrozenBaselineOptions = {},
): Promise<FrozenBaselineHandle> {
	const root = await repositoryRoot(repositoryPath, options.signal);
	const headCommit = textOutput(
		await runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: root, signal: options.signal }),
	);
	assertCommitId(headCommit);
	await assertRepositoryHasNoSubmodules(root, options.signal);
	await assertNoLocalFilters(root, options.signal);
	const temporaryParent = await prepareTemporaryParent(options.temporaryDirectory, root);
	const containerPath = await mkdtemp(join(temporaryParent, "pi-subagent-baseline-"));
	const indexEnvironment = commitIdentityEnvironment({ GIT_INDEX_FILE: join(containerPath, "index") });
	try {
		await runGit(["read-tree", headCommit], { cwd: root, signal: options.signal, env: indexEnvironment });
		await assertNoLocalFilters(root, options.signal);
		await runGit(["add", "--all", "--", "."], { cwd: root, signal: options.signal, env: indexEnvironment });
		const tree = textOutput(
			await runGit(["write-tree"], { cwd: root, signal: options.signal, env: indexEnvironment }),
		);
		const baselineCommit = textOutput(
			await runGit(["commit-tree", tree, "-p", headCommit, "-m", "pi subagent frozen baseline"], {
				cwd: root,
				signal: options.signal,
				env: indexEnvironment,
			}),
		);
		assertCommitId(baselineCommit);
		let cleaned = false;
		return {
			repositoryRoot: root,
			headCommit,
			baselineCommit,
			async cleanup(): Promise<void> {
				if (cleaned) return;
				await rm(containerPath, { recursive: true, force: true });
				cleaned = true;
			},
		};
	} catch (error) {
		await rm(containerPath, { recursive: true, force: true });
		throw error;
	}
}

async function regularFileSeal(path: string, description: string): Promise<FileSeal> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${description} is not a regular file`);
	return {
		mode: metadata.mode & 0o7777,
		digest: createHash("sha256")
			.update(await readFile(path))
			.digest("hex"),
	};
}

function requireTaskState(handle: WorktreeHandle): TaskWorktreeState {
	const state = taskWorktrees.get(handle);
	if (!state) throw new Error("Worktree handle was not created by this manager");
	if (
		handle.repositoryRoot !== state.repositoryRoot ||
		handle.path !== state.worktreePath ||
		handle.branch !== state.branch
	) {
		throw new Error("Worktree handle was modified");
	}
	if (state.cleanupComplete || state.worktreeRemoved) throw new Error("Worktree has been cleaned up");
	return state;
}

async function verifyTaskWorktree(state: TaskWorktreeState, signal?: AbortSignal): Promise<void> {
	let currentControl: FileSeal;
	try {
		currentControl = await regularFileSeal(join(state.worktreePath, ".git"), "Managed worktree .git control file");
	} catch (error) {
		throw new Error(`Managed worktree .git control file is unavailable; ${COMMON_DIRECTORY_BOUNDARY_NOTICE}`, {
			cause: error,
		});
	}
	if (currentControl.mode !== state.gitControlSeal.mode || currentControl.digest !== state.gitControlSeal.digest) {
		throw new Error(`Managed worktree .git control file changed; ${COMMON_DIRECTORY_BOUNDARY_NOTICE}`);
	}
	const root = await repositoryRoot(state.worktreePath, signal);
	if (root !== state.worktreePath) throw new Error("Worktree path no longer identifies the managed worktree");
	const headRef = textOutput(await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: state.worktreePath, signal }));
	if (headRef !== `refs/heads/${state.branch}`) throw new Error("Managed worktree is on an unexpected branch");
}

async function cleanupTaskWorktree(state: TaskWorktreeState): Promise<void> {
	if (state.cleanupComplete) return;
	const validatedMarker = await validateTaskMarker(
		state.repositoryRoot,
		state.marker.runId,
		state.marker.taskId,
		state.branch,
		state.worktreePath,
		state.markerPath,
		state.markerSeal,
	);
	if (!state.worktreeRemoved) {
		await runGit(["worktree", "remove", "--force", "--force", state.worktreePath], { cwd: state.repositoryRoot });
		state.worktreeRemoved = true;
	}
	if (!state.branchRemoved) {
		await deleteExactRef(state.repositoryRoot, `refs/heads/${state.branch}`);
		state.branchRemoved = true;
	}
	if (!state.containerRemoved) {
		await rm(state.containerPath, { recursive: true, force: true });
		state.containerRemoved = true;
	}
	if (!state.markerRemoved) {
		await removeValidatedTaskMarker(validatedMarker);
		state.markerRemoved = true;
	}
	state.cleanupComplete = true;
}

export async function createTaskWorktree(options: CreateTaskWorktreeOptions): Promise<WorktreeHandle> {
	assertTaskIdentifier(options.runId, "runId");
	assertTaskIdentifier(options.taskId, "taskId");
	assertCommitId(options.baselineCommit);
	const root = await repositoryRoot(options.repositoryPath, options.signal);
	const resolvedBaseline = textOutput(
		await runGit(["rev-parse", "--verify", `${options.baselineCommit}^{commit}`], {
			cwd: root,
			signal: options.signal,
		}),
	);
	if (resolvedBaseline.toLowerCase() !== options.baselineCommit.toLowerCase()) {
		throw new Error("baselineCommit did not resolve to the supplied full commit ID");
	}
	await assertNoLocalFilters(root, options.signal);
	const temporaryParent = await prepareTemporaryParent(options.temporaryDirectory, root);
	const containerPath = await mkdtemp(join(temporaryParent, "pi-subagent-worktree-"));
	const worktreePath = join(containerPath, "worktree");
	const branch = `pi/subagent/task/${options.runId}/${options.taskId}-${randomBytes(8).toString("hex")}`;
	const ref = `refs/heads/${branch}`;
	let worktreeAddAttempted = false;
	try {
		await runGit(["check-ref-format", "--branch", branch], { cwd: root, signal: options.signal });
		if (await refValue(root, ref, options.signal)) throw new Error("Generated task branch already exists");
		worktreeAddAttempted = true;
		await runGit(["worktree", "add", "-b", branch, worktreePath, resolvedBaseline], {
			cwd: root,
			signal: options.signal,
		});
		if ((await realpath(worktreePath)) !== worktreePath)
			throw new Error("Git created the worktree at an unexpected path");
		const marker: TaskWorktreeMarker = {
			version: TASK_MARKER_VERSION,
			kind: "task",
			repositoryRoot: root,
			worktreePath,
			branch,
			runId: options.runId,
			taskId: options.taskId,
			baselineCommit: resolvedBaseline,
		};
		const gitControlSeal = await regularFileSeal(join(worktreePath, ".git"), "Managed worktree .git control file");
		const createdMarker = await createTaskMarker(root, marker, options.signal);
		const state = {
			repositoryRoot: root,
			worktreePath,
			containerPath,
			branch,
			gitControlSeal,
			marker,
			markerPath: createdMarker.path,
			markerSeal: createdMarker.seal,
			worktreeRemoved: false,
			branchRemoved: false,
			containerRemoved: false,
			markerRemoved: false,
			cleanupComplete: false,
		} as TaskWorktreeState;
		const handle: WorktreeHandle = {
			repositoryRoot: root,
			path: worktreePath,
			branch,
			baselineCommit: resolvedBaseline,
			retainForDisposition: async () => {
				await verifyTaskWorktree(state);
				try {
					const retained = await open(`${state.markerPath}.retained`, "wx", 0o600);
					try {
						await retained.sync();
					} finally {
						await retained.close();
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const metadata = await lstat(`${state.markerPath}.retained`);
					if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Unsafe retained-worktree marker");
				}
				await syncDirectory(dirname(state.markerPath));
			},
			cleanup: async () => cleanupTaskWorktree(state),
		};
		state.handle = handle;
		taskWorktrees.set(handle, state);
		return handle;
	} catch (error) {
		const reconciliationErrors: unknown[] = [];
		let worktreeStillRegistered = false;
		if (worktreeAddAttempted) {
			try {
				await runGit(["worktree", "remove", "--force", "--force", worktreePath], { cwd: root });
			} catch (cleanupError) {
				// The add may have failed before registration; verify the exact generated path below.
				reconciliationErrors.push(cleanupError);
			}
			try {
				worktreeStillRegistered = await hasExactWorktree(root, worktreePath);
				if (worktreeStillRegistered) {
					await runGit(["worktree", "remove", "--force", "--force", worktreePath], { cwd: root });
					worktreeStillRegistered = await hasExactWorktree(root, worktreePath);
				}
			} catch (cleanupError) {
				worktreeStillRegistered = true;
				reconciliationErrors.push(cleanupError);
			}
			try {
				await deleteExactRef(root, ref);
			} catch (cleanupError) {
				reconciliationErrors.push(cleanupError);
			}
		}
		await rm(containerPath, { recursive: true, force: true });
		const refStillExists = worktreeAddAttempted ? await refValue(root, ref).catch(() => "unknown") : undefined;
		if (worktreeStillRegistered || refStillExists) {
			throw new Error(
				`Unable to reconcile the generated worktree/ref after Git worktree add failed; ${COMMON_DIRECTORY_BOUNDARY_NOTICE}`,
				{ cause: new AggregateError([error, ...reconciliationErrors]) },
			);
		}
		throw error;
	}
}

/** Create a second managed worktree from the exact commit sealed by a Writer audit. */
export async function createCleanValidationWorktree(
	sourceHandle: WorktreeHandle,
	commit: string,
	signal?: AbortSignal,
): Promise<WorktreeHandle> {
	assertCommitId(commit, "commit");
	const state = requireTaskState(sourceHandle);
	await verifyTaskWorktree(state, signal);
	const sourceHead = textOutput(
		await runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: state.worktreePath, signal }),
	);
	if (sourceHead.toLowerCase() !== commit.toLowerCase()) {
		throw new Error("Validation input commit is not the exact source worktree HEAD");
	}
	return await createTaskWorktree({
		repositoryPath: state.repositoryRoot,
		baselineCommit: commit,
		runId: state.marker.runId,
		taskId: state.marker.taskId,
		temporaryDirectory: dirname(state.containerPath),
		signal,
	});
}

function assertSafeRelativePath(path: string, kind: string): void {
	const components = path.split("/");
	if (components.some((component) => component.toLowerCase() === ".git")) {
		throw new Error(`Unsafe ${kind}: ${path}; ${COMMON_DIRECTORY_BOUNDARY_NOTICE}`);
	}
	if (
		!path ||
		path === "." ||
		path.startsWith("/") ||
		path.endsWith("/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.includes("\uFFFD") ||
		/[\u0000-\u001f\u007f]/.test(path) ||
		components.some((component) => !component || component === "." || component === "..")
	) {
		throw new Error(`Unsafe ${kind}: ${path}`);
	}
}

function normalizeOwnedPath(value: string): string {
	const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
	assertSafeRelativePath(normalized, "owned path");
	return normalized;
}

function parseNulPaths(output: Buffer): string[] {
	if (output.length === 0) return [];
	if (output.at(-1) !== 0) throw new Error("Git returned a malformed path list");
	const text = output.toString("utf8");
	if (text.includes("\uFFFD")) throw new Error("Git returned a path that is not valid UTF-8");
	return text.slice(0, -1).split("\0");
}

async function assertNoSymlinkComponents(root: string, path: string, kind: string): Promise<void> {
	let current = root;
	for (const component of path.split("/")) {
		current = join(current, component);
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				throw new Error(`${kind} contains a symbolic link: ${path}; no OS sandbox is present`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

async function assertNoSymlinkDescendants(root: string, path: string, kind: string): Promise<void> {
	const absolute = join(root, path);
	let metadata: Awaited<ReturnType<typeof lstat>>;
	try {
		metadata = await lstat(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!metadata.isDirectory()) return;
	for (const entry of await readdir(absolute, { withFileTypes: true })) {
		const childPath = `${path}/${entry.name}`;
		const childMetadata = await lstat(join(root, childPath));
		if (entry.isSymbolicLink() || childMetadata.isSymbolicLink()) {
			throw new Error(`${kind} contains a symbolic-link descendant: ${childPath}; no OS sandbox is present`);
		}
		if (childMetadata.isDirectory()) await assertNoSymlinkDescendants(root, childPath, kind);
	}
}

async function validateWorktreeOwnershipInternal(
	handle: WorktreeHandle,
	ownedPaths: readonly string[],
	scanOwnedDescendants: boolean,
	signal?: AbortSignal,
): Promise<string[]> {
	const state = requireTaskState(handle);
	await verifyTaskWorktree(state, signal);
	await assertNoLocalFilters(state.worktreePath, signal);
	const canonicalOwnedPaths = [...new Set(ownedPaths.map(normalizeOwnedPath))].sort();
	if (canonicalOwnedPaths.length === 0) throw new Error("At least one owned path is required");
	for (const ownedPath of canonicalOwnedPaths) {
		await assertNoSymlinkComponents(state.worktreePath, ownedPath, "Owned path");
		if (scanOwnedDescendants) {
			await assertNoSymlinkDescendants(state.worktreePath, ownedPath, "Owned path");
		}
	}
	const submodules = await indexedGitlinks(state.worktreePath, signal);
	for (const submodule of submodules) {
		if (
			canonicalOwnedPaths.some(
				(owned) => owned === submodule || owned.startsWith(`${submodule}/`) || submodule.startsWith(`${owned}/`),
			)
		) {
			throw new Error(`Owned paths cross Git submodule ${submodule}; ${COMMON_DIRECTORY_BOUNDARY_NOTICE}`);
		}
	}
	return canonicalOwnedPaths;
}

export async function validateWorktreeOwnership(
	handle: WorktreeHandle,
	ownedPaths: readonly string[],
	signal?: AbortSignal,
): Promise<string[]> {
	return await validateWorktreeOwnershipInternal(handle, ownedPaths, true, signal);
}

function updateDigestFrame(hash: ReturnType<typeof createHash>, value: Buffer | string): void {
	const bytes = typeof value === "string" ? Buffer.from(value) : value;
	const length = Buffer.allocUnsafe(4);
	length.writeUInt32BE(bytes.length);
	hash.update(length);
	hash.update(bytes);
}

async function changedContentAudit(
	root: string,
	changedPaths: readonly string[],
): Promise<{ digest: string; paths: AuditedPath[] }> {
	const hash = createHash("sha256");
	const paths: AuditedPath[] = [];
	for (const path of changedPaths) {
		updateDigestFrame(hash, path);
		const absolutePath = join(root, path);
		let metadata: Awaited<ReturnType<typeof lstat>>;
		try {
			metadata = await lstat(absolutePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				updateDigestFrame(hash, "deleted");
				paths.push({ path, mode: "deleted" });
				continue;
			}
			throw error;
		}
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error(`Changed path is not a regular file: ${path}`);
		}
		const mode = metadata.mode & 0o111 ? "100755" : "100644";
		const bytes = await readFile(absolutePath);
		const digest = createHash("sha256").update(bytes).digest("hex");
		updateDigestFrame(hash, mode);
		updateDigestFrame(hash, bytes);
		paths.push({ path, mode, bytes, digest });
	}
	return { digest: hash.digest("hex"), paths };
}

export async function inspectWorktreeChanges(
	handle: WorktreeHandle,
	ownedPaths: readonly string[],
	signal?: AbortSignal,
): Promise<string[]> {
	// Baseline ownership is checked before the Child starts. At artifact time,
	// inspect only tracked and non-ignored changes so ignored build trees cannot
	// become artifact input or trigger recursive symlink rejection.
	const canonicalOwnedPaths = await validateWorktreeOwnershipInternal(handle, ownedPaths, false, signal);
	const state = requireTaskState(handle);
	await assertNoLocalFilters(state.worktreePath, signal);
	const [tracked, untracked] = await Promise.all([
		runGit(["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"], { cwd: state.worktreePath, signal }),
		// Only repository-versioned .gitignore files define artifact exclusions.
		// Shared info/global excludes are outside the worktree and Child-mutable.
		runGit(["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z", "--"], {
			cwd: state.worktreePath,
			signal,
		}),
	]);
	const changedPaths = [...new Set([...parseNulPaths(tracked.stdout), ...parseNulPaths(untracked.stdout)])].sort();
	for (const path of changedPaths) {
		assertSafeRelativePath(path, "changed path");
		if (!canonicalOwnedPaths.some((owned) => path === owned || path.startsWith(`${owned}/`))) {
			throw new Error(`Changed path is outside owned paths: ${path}`);
		}
		await assertNoSymlinkComponents(state.worktreePath, path, "Changed path");
	}
	const contentAudit = await changedContentAudit(state.worktreePath, changedPaths);
	const parentCommit = textOutput(
		await runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: state.worktreePath, signal }),
	);
	state.audit = {
		ownedPaths: canonicalOwnedPaths,
		changedPaths: [...changedPaths],
		digest: contentAudit.digest,
		paths: contentAudit.paths,
		parentCommit,
	};
	return changedPaths;
}

/**
 * Require a validation worktree to remain at its exact input commit with no
 * tracked or non-ignored untracked mutation. Ignored build output is excluded.
 */
export async function assertCleanValidationWorktree(handle: WorktreeHandle, signal?: AbortSignal): Promise<void> {
	const state = requireTaskState(handle);
	await verifyTaskWorktree(state, signal);
	await assertNoLocalFilters(state.worktreePath, signal);
	const head = textOutput(
		await runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: state.worktreePath, signal }),
	);
	if (head.toLowerCase() !== handle.baselineCommit.toLowerCase()) {
		throw new Error("Validation worktree moved away from its exact input commit");
	}
	const [tracked, untracked] = await Promise.all([
		runGit(["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"], { cwd: state.worktreePath, signal }),
		runGit(["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z", "--"], {
			cwd: state.worktreePath,
			signal,
		}),
	]);
	const changedPaths = [...new Set([...parseNulPaths(tracked.stdout), ...parseNulPaths(untracked.stdout)])].sort();
	for (const path of changedPaths) assertSafeRelativePath(path, "validation change");
	if (changedPaths.length > 0) {
		throw new Error(`Validation modified non-ignored path: ${changedPaths[0]}`);
	}
}

async function verifyPrivateIndex(
	state: TaskWorktreeState,
	audit: AuditRecord,
	indexEnvironment: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<void> {
	const stagedPaths = parseNulPaths(
		(
			await runGit(["diff", "--cached", "--name-only", "-z", "--no-renames", audit.parentCommit, "--"], {
				cwd: state.worktreePath,
				signal,
				env: indexEnvironment,
			})
		).stdout,
	).sort();
	if (
		stagedPaths.length !== audit.changedPaths.length ||
		stagedPaths.some((path, index) => path !== audit.changedPaths[index])
	) {
		throw new Error("Private staged changed path set does not exactly match the final audit");
	}

	const stagedDigest = createHash("sha256");
	for (const expected of audit.paths) {
		updateDigestFrame(stagedDigest, expected.path);
		const records = parseNulPaths(
			(
				await runGit(["ls-files", "--stage", "-z", "--", expected.path], {
					cwd: state.worktreePath,
					signal,
					env: indexEnvironment,
				})
			).stdout,
		);
		if (expected.mode === "deleted") {
			if (records.length !== 0) throw new Error(`Private index retained audited deletion: ${expected.path}`);
			updateDigestFrame(stagedDigest, "deleted");
			continue;
		}
		if (records.length !== 1) throw new Error(`Private index has ambiguous metadata for: ${expected.path}`);
		const match = /^(100644|100755) ([a-fA-F0-9]{40,64}) 0\t(.+)$/.exec(records[0]);
		if (!match || match[3] !== expected.path)
			throw new Error(`Private index has unsafe metadata for: ${expected.path}`);
		if (match[1] !== expected.mode) throw new Error(`Private staged mode differs from final audit: ${expected.path}`);
		const bytes = (
			await runGit(["cat-file", "blob", match[2]], {
				cwd: state.worktreePath,
				signal,
				env: indexEnvironment,
			})
		).stdout;
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== expected.digest || !expected.bytes?.equals(bytes)) {
			throw new Error(`Private staged blob bytes differ from final audit: ${expected.path}`);
		}
		updateDigestFrame(stagedDigest, expected.mode);
		updateDigestFrame(stagedDigest, bytes);
	}
	if (stagedDigest.digest("hex") !== audit.digest) {
		throw new Error("Private staged digest does not exactly match the final audit");
	}
}

export async function commitWorktree(handle: WorktreeHandle, message: string, signal?: AbortSignal): Promise<string> {
	const state = requireTaskState(handle);
	if (!message.trim() || message.includes("\0") || Buffer.byteLength(message) > 64 * 1024) {
		throw new Error("Commit message must be non-empty, NUL-free, and at most 65536 bytes");
	}
	const priorAudit = state.audit;
	if (!priorAudit) throw new Error("Worktree changes must be audited before commit");
	const currentPaths = await inspectWorktreeChanges(handle, priorAudit.ownedPaths, signal);
	const currentAudit = state.audit;
	if (currentPaths.length === 0) {
		state.audit = undefined;
		throw new Error("Worktree has no changes to commit");
	}
	if (
		!currentAudit ||
		currentAudit.digest !== priorAudit.digest ||
		currentPaths.length !== priorAudit.changedPaths.length ||
		currentPaths.some((path, index) => path !== priorAudit.changedPaths[index])
	) {
		state.audit = undefined;
		throw new Error("Worktree changed after its caller audit; audit it again before commit");
	}
	await assertNoLocalFilters(state.worktreePath, signal);
	const parent = textOutput(
		await runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: state.worktreePath, signal }),
	);
	if (parent !== currentAudit.parentCommit) {
		state.audit = undefined;
		throw new Error("Worktree parent changed after the final audit");
	}
	state.audit = undefined;
	const indexDirectory = await mkdtemp(join(state.containerPath, "commit-index-"));
	const indexEnvironment = {
		GIT_INDEX_FILE: join(indexDirectory, "index"),
		GIT_LITERAL_PATHSPECS: "1",
	};
	try {
		await runGit(["read-tree", parent], { cwd: state.worktreePath, signal, env: indexEnvironment });
		// Stage only the exact audited set. --force makes shared Git ignore policy
		// irrelevant without admitting any unclaimed ignored path.
		await runGit(["add", "--all", "--force", "--", ...currentAudit.changedPaths], {
			cwd: state.worktreePath,
			signal,
			env: indexEnvironment,
		});
		await verifyPrivateIndex(state, currentAudit, indexEnvironment, signal);
		const tree = textOutput(await runGit(["write-tree"], { cwd: state.worktreePath, signal, env: indexEnvironment }));
		const commit = textOutput(
			await runGit(["commit-tree", tree, "-p", parent, "-m", message], {
				cwd: state.worktreePath,
				signal,
				env: commitIdentityEnvironment(indexEnvironment),
			}),
		);
		assertCommitId(commit);
		await runGit(["update-ref", `refs/heads/${state.branch}`, commit, parent], {
			cwd: state.worktreePath,
			signal,
		});
		return commit;
	} finally {
		await rm(indexDirectory, { recursive: true, force: true });
	}
}
