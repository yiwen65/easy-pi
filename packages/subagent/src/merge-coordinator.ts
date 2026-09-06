import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CandidateDiff, IntegrationArtifact } from "./types.ts";

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const FORCE_KILL_DELAY_MS = 250;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const INTEGRATION_MARKER_VERSION = 1;
const INTEGRATION_MARKER_DIRECTORY = ["pi-subagent", "merge-coordinator", "worktrees"] as const;

export interface MergeTaskCommit {
	taskId: string;
	commit: string;
}

export interface MergeCoordinatorOptions {
	repositoryPath: string;
	baselineCommit: string;
	runId: string;
	refPrefix: string;
	/** Accepted commits in deterministic topological order. */
	taskCommits?: readonly MergeTaskCommit[];
	/** Alias for taskCommits. Exactly one of these properties may be supplied. */
	commits?: readonly MergeTaskCommit[];
	temporaryDirectory?: string;
	/** Keep the candidate ref after success. Internal dependency composition sets this to false. */
	retainRef?: boolean;
	signal?: AbortSignal;
}

export class MergeConflictError extends Error {
	readonly taskId: string;
	readonly diagnostics: string;

	constructor(taskId: string, diagnostics: string, options?: ErrorOptions) {
		super(`Merge conflict while applying task ${taskId}`, options);
		this.name = "MergeConflictError";
		this.taskId = taskId;
		this.diagnostics = boundedText(Buffer.from(diagnostics), MAX_DIAGNOSTIC_BYTES);
	}
}

interface GitResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number;
}

interface RunGitOptions {
	cwd: string;
	signal?: AbortSignal;
	controlledEnvironment?: NodeJS.ProcessEnv;
	allowExitCodes?: readonly number[];
}

interface ListedWorktree {
	path: string;
	branch?: string;
}

interface IntegrationWorktreeMarker {
	version: number;
	kind: "integration";
	repositoryRoot: string;
	worktreePath: string;
	ref: string;
	runId: string;
}

function abortError(): Error {
	const error = new Error("Merge operation cancelled");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function gitEnvironment(controlled?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (key.startsWith("GIT_")) delete environment[key];
	}
	return {
		...environment,
		GIT_ATTR_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: NULL_DEVICE,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: NULL_DEVICE,
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		LC_ALL: "C",
		...controlled,
	};
}

function terminateProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall back to the direct Git process if group signaling is unavailable.
		}
	}
	child.kill(signal);
}

async function runGit(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
	throwIfAborted(options.signal);
	return await new Promise<GitResult>((resolvePromise, rejectPromise) => {
		let child: ReturnType<typeof spawn>;
		let settled = false;
		let processError: Error | undefined;
		let forcedError: Error | undefined;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const terminate = (): void => {
			terminateProcessGroup(child, "SIGTERM");
			if (!forceKillTimer) {
				forceKillTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
				forceKillTimer.unref();
			}
		};
		function onAbort(): void {
			forcedError ??= abortError();
			terminate();
		}
		const collect = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
			const copy = Buffer.from(chunk);
			if (stream === "stdout") {
				const remaining = Math.max(0, MAX_STDOUT_BYTES - stdoutBytes);
				if (remaining > 0) stdoutChunks.push(copy.subarray(0, remaining));
				stdoutBytes += copy.byteLength;
				if (stdoutBytes > MAX_STDOUT_BYTES && !forcedError) {
					forcedError = new Error(`Git stdout exceeded ${MAX_STDOUT_BYTES} bytes`);
					terminate();
				}
				return;
			}
			const remaining = Math.max(0, MAX_STDERR_BYTES - stderrBytes);
			if (remaining > 0) stderrChunks.push(copy.subarray(0, remaining));
			stderrBytes += copy.byteLength;
			if (stderrBytes > MAX_STDERR_BYTES && !forcedError) {
				forcedError = new Error(`Git stderr exceeded ${MAX_STDERR_BYTES} bytes`);
				terminate();
			}
		};

		try {
			child = spawn("git", ["-c", `core.hooksPath=${NULL_DEVICE}`, ...args], {
				cwd: options.cwd,
				env: gitEnvironment(options.controlledEnvironment),
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			rejectPromise(error);
			return;
		}

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
				const result = {
					stdout: Buffer.concat(stdoutChunks),
					stderr: Buffer.concat(stderrChunks),
					exitCode,
				};
				if (!(options.allowExitCodes ?? [0]).includes(exitCode)) {
					const detail = boundedText(result.stderr, MAX_DIAGNOSTIC_BYTES).trim();
					return rejectPromise(
						new Error(
							`Git ${args[0] ?? "command"} failed (${signal ? `signal ${signal}` : `exit ${exitCode}`})${detail ? `: ${detail}` : ""}`,
						),
					);
				}
				resolvePromise(result);
			});
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}

function boundedText(value: Buffer, maxBytes: number): string {
	return value
		.subarray(0, maxBytes)
		.toString("utf8")
		.replace(/\uFFFD$/u, "");
}

function safeText(result: GitResult): string {
	const value = result.stdout.toString("utf8");
	if (value.includes("\uFFFD") || value.includes("\0")) throw new Error("Git returned unsafe text");
	return value.replace(/\r?\n$/, "");
}

function assertIdentifier(value: string, name: string): void {
	if (
		!IDENTIFIER_PATTERN.test(value) ||
		value.includes("..") ||
		value.endsWith(".") ||
		value.toLowerCase().endsWith(".lock")
	) {
		throw new Error(`Unsafe ${name}: ${value}`);
	}
}

function assertCommitId(value: string, name: string): void {
	if (!/^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/.test(value)) {
		throw new Error(`${name} must be a full hexadecimal commit ID`);
	}
}

function assertRefPrefix(value: string): void {
	if (
		!value.startsWith("pi/subagent/") ||
		value === "pi/subagent/" ||
		value.length > 200 ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("\\")
	) {
		throw new Error(`Unsafe refPrefix outside pi/subagent/: ${value}`);
	}
	for (const component of value.split("/")) assertIdentifier(component, "refPrefix");
}

function selectedCommits(options: MergeCoordinatorOptions): readonly MergeTaskCommit[] {
	if (options.taskCommits !== undefined && options.commits !== undefined) {
		throw new Error("Supply only one of taskCommits or commits");
	}
	const commits = options.taskCommits ?? options.commits;
	if (!commits) throw new Error("Merge task commits are required");
	const taskIds = new Set<string>();
	for (const item of commits) {
		assertIdentifier(item.taskId, "taskId");
		assertCommitId(item.commit, `Commit for task ${item.taskId}`);
		if (taskIds.has(item.taskId)) throw new Error(`Duplicate merge task ID: ${item.taskId}`);
		taskIds.add(item.taskId);
	}
	return commits;
}

async function repositoryRoot(repositoryPath: string, signal?: AbortSignal): Promise<string> {
	const topLevel = safeText(await runGit(["rev-parse", "--show-toplevel"], { cwd: repositoryPath, signal }));
	if (!topLevel || topLevel.includes("\n") || topLevel.includes("\r")) throw new Error("Git returned an unsafe root");
	const root = await realpath(topLevel);
	const inside = safeText(await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: root, signal }));
	if (inside !== "true") throw new Error("repositoryPath is not inside a Git worktree");
	return root;
}

async function commonGitDirectory(root: string, signal?: AbortSignal): Promise<string> {
	const output = safeText(await runGit(["rev-parse", "--git-common-dir"], { cwd: root, signal }));
	if (!output || output.includes("\n") || output.includes("\r")) {
		throw new Error("Git returned an unsafe common directory");
	}
	return await realpath(resolve(root, output));
}

function isWithin(parent: string, candidate: string): boolean {
	const path = relative(parent, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function canonicalDestination(path: string): Promise<string> {
	let ancestor = path;
	const missing: string[] = [];
	for (;;) {
		try {
			return resolve(await realpath(ancestor), ...missing.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			missing.push(basename(ancestor));
			ancestor = parent;
		}
	}
}

function integrationMarkerPath(commonDirectory: string, ref: string): string {
	const name = `${createHash("sha256").update(ref, "utf8").digest("hex")}.json`;
	return join(commonDirectory, ...INTEGRATION_MARKER_DIRECTORY, name);
}

function parseIntegrationMarker(value: string): IntegrationWorktreeMarker {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error("Integration worktree provenance marker is malformed", { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Integration worktree provenance marker is malformed");
	}
	const record = parsed as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (
		keys.join("\0") !== ["kind", "ref", "repositoryRoot", "runId", "version", "worktreePath"].sort().join("\0") ||
		record.version !== INTEGRATION_MARKER_VERSION ||
		record.kind !== "integration" ||
		typeof record.repositoryRoot !== "string" ||
		typeof record.worktreePath !== "string" ||
		typeof record.ref !== "string" ||
		typeof record.runId !== "string"
	) {
		throw new Error("Integration worktree provenance marker is malformed");
	}
	return {
		version: record.version,
		kind: record.kind,
		repositoryRoot: record.repositoryRoot,
		worktreePath: record.worktreePath,
		ref: record.ref,
		runId: record.runId,
	};
}

async function readIntegrationMarker(
	commonDirectory: string,
	ref: string,
): Promise<IntegrationWorktreeMarker | undefined> {
	const path = integrationMarkerPath(commonDirectory, ref);
	try {
		const status = await lstat(path);
		if (!status.isFile() || status.isSymbolicLink()) {
			throw new Error("Integration worktree provenance marker is not a regular file");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const expectedDirectory = resolve(commonDirectory, ...INTEGRATION_MARKER_DIRECTORY);
	if ((await realpath(dirname(path))) !== expectedDirectory) {
		throw new Error("Integration worktree provenance marker is outside the common Git directory");
	}
	return parseIntegrationMarker(await readFile(path, "utf8"));
}

function expectedIntegrationMarker(
	root: string,
	worktreePath: string,
	ref: string,
	runId: string,
): IntegrationWorktreeMarker {
	return {
		version: INTEGRATION_MARKER_VERSION,
		kind: "integration",
		repositoryRoot: root,
		worktreePath,
		ref,
		runId,
	};
}

function markerMatches(actual: IntegrationWorktreeMarker, expected: IntegrationWorktreeMarker): boolean {
	return (
		actual.version === expected.version &&
		actual.kind === expected.kind &&
		actual.repositoryRoot === expected.repositoryRoot &&
		actual.worktreePath === expected.worktreePath &&
		actual.ref === expected.ref &&
		actual.runId === expected.runId
	);
}

async function requireIntegrationMarker(commonDirectory: string, expected: IntegrationWorktreeMarker): Promise<void> {
	const actual = await readIntegrationMarker(commonDirectory, expected.ref);
	if (!actual || !markerMatches(actual, expected)) {
		throw new Error("Integration worktree provenance marker is absent or does not match the candidate worktree");
	}
}

async function createIntegrationMarker(commonDirectory: string, marker: IntegrationWorktreeMarker): Promise<void> {
	const directory = resolve(commonDirectory, ...INTEGRATION_MARKER_DIRECTORY);
	await mkdir(directory, { recursive: true });
	if ((await realpath(directory)) !== directory) {
		throw new Error("Integration worktree provenance directory is outside the common Git directory");
	}
	const path = integrationMarkerPath(commonDirectory, marker.ref);
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
		await handle.sync();
		await handle.close();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(path).catch(() => undefined);
		throw error;
	}
}

async function removeIntegrationMarker(commonDirectory: string, marker: IntegrationWorktreeMarker): Promise<void> {
	await requireIntegrationMarker(commonDirectory, marker);
	await unlink(integrationMarkerPath(commonDirectory, marker.ref));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function temporaryParent(requestedPath: string | undefined, root: string): Promise<string> {
	const requested = resolve(requestedPath ?? tmpdir());
	if (isWithin(root, requested) || isWithin(root, await canonicalDestination(requested))) {
		throw new Error("temporaryDirectory must resolve outside the repository");
	}
	await mkdir(requested, { recursive: true });
	const canonical = await realpath(requested);
	if (isWithin(root, canonical)) throw new Error("temporaryDirectory must resolve outside the repository");
	return canonical;
}

async function resolveExactCommit(root: string, commit: string, name: string, signal?: AbortSignal): Promise<string> {
	const resolved = safeText(await runGit(["rev-parse", "--verify", `${commit}^{commit}`], { cwd: root, signal }));
	if (resolved.toLowerCase() !== commit.toLowerCase())
		throw new Error(`${name} did not resolve to the supplied commit ID`);
	return resolved;
}

async function assertSafeLocalConfig(root: string, signal?: AbortSignal): Promise<void> {
	const result = await runGit(["config", "--local", "--includes", "--null", "--name-only", "--list"], {
		cwd: root,
		signal,
	});
	const output = result.stdout.toString("utf8");
	if (output.includes("\uFFFD")) throw new Error("Git returned unsafe local configuration");
	for (const name of output.split("\0")) {
		const normalized = name.toLowerCase();
		if (normalized.startsWith("filter.")) throw new Error("Repository-local filter.* configuration is not allowed");
		if (/^merge\..+\.driver$/.test(normalized)) {
			throw new Error("Repository-local custom merge.*.driver configuration is not allowed");
		}
	}
}

function parseWorktrees(output: Buffer): ListedWorktree[] {
	const text = output.toString("utf8");
	if (text.includes("\uFFFD")) throw new Error("Git returned an unsafe worktree list");
	const entries: ListedWorktree[] = [];
	let current: ListedWorktree | undefined;
	for (const field of text.split("\0")) {
		if (field.startsWith("worktree ")) {
			if (current) entries.push(current);
			const path = field.slice("worktree ".length);
			if (!path || path.includes("\0")) throw new Error("Git returned an unsafe worktree path");
			current = { path };
		} else if (field.startsWith("branch ") && current) {
			current.branch = field.slice("branch ".length);
		}
	}
	if (current) entries.push(current);
	return entries;
}

async function listedWorktrees(root: string, signal?: AbortSignal): Promise<ListedWorktree[]> {
	return parseWorktrees((await runGit(["worktree", "list", "--porcelain", "-z"], { cwd: root, signal })).stdout);
}

async function refValue(root: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await runGit(["show-ref", "--verify", "--quiet", ref], {
		cwd: root,
		signal,
		allowExitCodes: [0, 1],
	});
	if (result.exitCode !== 0) return undefined;
	return safeText(await runGit(["rev-parse", "--verify", ref], { cwd: root, signal }));
}

function assertManagedCandidateRef(ref: string): void {
	if (!ref.startsWith("refs/heads/pi/subagent/") || ref.length <= "refs/heads/pi/subagent/".length) {
		throw new Error(`Ref is outside refs/heads/pi/subagent/*: ${ref}`);
	}
}

async function deleteRefCas(root: string, ref: string, expectedCommit: string, signal?: AbortSignal): Promise<boolean> {
	if ((await refValue(root, ref, signal))?.toLowerCase() !== expectedCommit.toLowerCase()) return false;
	const result = await runGit(["update-ref", "-d", ref, expectedCommit], {
		cwd: root,
		signal,
		allowExitCodes: [0, 128],
	});
	return result.exitCode === 0;
}

export async function inspectMergeCandidateRef(
	repositoryPath: string,
	ref: string,
	expectedCommit: string,
	signal?: AbortSignal,
): Promise<"exact" | "absent" | "mismatch"> {
	assertManagedCandidateRef(ref);
	assertCommitId(expectedCommit, "expectedCommit");
	throwIfAborted(signal);
	const root = await repositoryRoot(repositoryPath, signal);
	await runGit(["check-ref-format", ref], { cwd: root, signal });
	const current = await refValue(root, ref, signal);
	if (!current) return "absent";
	return current.toLowerCase() === expectedCommit.toLowerCase() ? "exact" : "mismatch";
}

export async function releaseMergeCandidateRef(
	repositoryPath: string,
	ref: string,
	expectedCommit: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const state = await inspectMergeCandidateRef(repositoryPath, ref, expectedCommit, signal);
	if (state !== "exact") return false;
	const root = await repositoryRoot(repositoryPath, signal);
	const checkouts = (await listedWorktrees(root, signal)).filter((worktree) => worktree.branch === ref);
	if (checkouts.length > 0) {
		throw new Error(`Refusing to release a candidate ref checked out in ${checkouts.length} worktree(s)`);
	}
	return await deleteRefCas(root, ref, expectedCommit, signal);
}

function candidateChangedPaths(output: Buffer, limit: number): { paths: string[]; truncated: boolean } {
	if (output.length > 0 && output.at(-1) !== 0) throw new Error("Git returned malformed candidate paths");
	const text = output.toString("utf8");
	if (text.includes("\uFFFD")) throw new Error("Git returned a candidate path that is not valid UTF-8");
	const paths = text.length === 0 ? [] : text.slice(0, -1).split("\0");
	for (const path of paths) {
		if (!path || path.includes("\0") || isAbsolute(path) || path === ".." || path.startsWith("../")) {
			throw new Error("Git returned an unsafe candidate path");
		}
	}
	return { paths: paths.slice(0, limit), truncated: paths.length > limit };
}

export async function inspectMergeCandidateDiff(options: {
	repositoryPath: string;
	runId: string;
	baselineCommit: string;
	ref: string;
	expectedCommit: string;
	maxBytes?: number;
	maxPaths?: number;
	signal?: AbortSignal;
}): Promise<CandidateDiff> {
	assertIdentifier(options.runId, "runId");
	assertCommitId(options.baselineCommit, "baselineCommit");
	assertManagedCandidateRef(options.ref);
	assertCommitId(options.expectedCommit, "expectedCommit");
	const maxBytes = options.maxBytes ?? 64 * 1024;
	const maxPaths = options.maxPaths ?? 200;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024) {
		throw new Error("Candidate diff maxBytes must be an integer between 1 and 262144");
	}
	if (!Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > 1_000) {
		throw new Error("Candidate diff maxPaths must be an integer between 1 and 1000");
	}
	const root = await repositoryRoot(options.repositoryPath, options.signal);
	const baseline = await resolveExactCommit(root, options.baselineCommit, "baselineCommit", options.signal);
	const candidate = await resolveExactCommit(root, options.expectedCommit, "expectedCommit", options.signal);
	if ((await inspectMergeCandidateRef(root, options.ref, candidate, options.signal)) !== "exact") {
		throw new Error("Integration candidate ref is absent or does not match the persisted commit");
	}
	const pathResult = await runGit(["diff", "--name-only", "--no-renames", "-z", baseline, candidate, "--"], {
		cwd: root,
		signal: options.signal,
	});
	const changed = candidateChangedPaths(pathResult.stdout, maxPaths);
	const patchResult = await runGit(
		["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", baseline, candidate, "--"],
		{ cwd: root, signal: options.signal },
	);
	if ((await inspectMergeCandidateRef(root, options.ref, candidate, options.signal)) !== "exact") {
		throw new Error("Integration candidate ref changed while its diff was inspected");
	}
	const patchBytes = patchResult.stdout;
	const truncated = changed.truncated || patchBytes.byteLength > maxBytes;
	const patch = patchBytes
		.subarray(0, maxBytes)
		.toString("utf8")
		.replace(/\uFFFD$/u, "");
	return {
		runId: options.runId,
		baselineCommit: baseline,
		candidateRef: options.ref,
		candidateCommit: candidate,
		changedPaths: changed.paths,
		patch,
		truncated,
	};
}

async function reconcileCandidateWorktrees(
	root: string,
	commonDirectory: string,
	ref: string,
	runId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const candidates = (await listedWorktrees(root, signal)).filter((worktree) => worktree.branch === ref);
	for (const worktree of candidates) {
		const canonicalPath = await canonicalDestination(worktree.path);
		if (canonicalPath === root) {
			throw new Error("Candidate ref is checked out in the current user worktree");
		}
	}
	if (candidates.length > 1) {
		throw new Error("Candidate ref is checked out in multiple worktrees");
	}
	const candidate = candidates[0];
	if (candidate) {
		const canonicalPath = await canonicalDestination(candidate.path);
		const marker = expectedIntegrationMarker(root, canonicalPath, ref, runId);
		await requireIntegrationMarker(commonDirectory, marker);
		await runGit(["worktree", "remove", "--force", "--force", candidate.path], { cwd: root, signal });
		await requireIntegrationMarker(commonDirectory, marker);
		await rm(canonicalPath, { recursive: true, force: true });
		await removeIntegrationMarker(commonDirectory, marker);
		return true;
	}

	const orphanedMarker = await readIntegrationMarker(commonDirectory, ref);
	if (!orphanedMarker) return false;
	if (
		orphanedMarker.version !== INTEGRATION_MARKER_VERSION ||
		orphanedMarker.kind !== "integration" ||
		orphanedMarker.repositoryRoot !== root ||
		orphanedMarker.ref !== ref ||
		orphanedMarker.runId !== runId ||
		!isAbsolute(orphanedMarker.worktreePath) ||
		(await canonicalDestination(orphanedMarker.worktreePath)) !== orphanedMarker.worktreePath
	) {
		throw new Error("Integration worktree provenance marker does not match this candidate run");
	}
	if (await pathExists(orphanedMarker.worktreePath)) {
		throw new Error("Marked integration path exists but is not the candidate worktree; preserving it");
	}
	await removeIntegrationMarker(commonDirectory, orphanedMarker);
	return true;
}

function sourceDates(result: GitResult): { authorDate: string; committerDate: string } {
	const fields = safeText(result).split("\n");
	if (fields.length !== 2 || fields.some((field) => !/^[0-9]+$/.test(field))) {
		throw new Error("Git returned malformed source commit dates");
	}
	return { authorDate: `@${fields[0]} +0000`, committerDate: `@${fields[1]} +0000` };
}

function conflictDiagnostics(result: GitResult): string {
	const combined = Buffer.concat([
		result.stdout,
		result.stdout.length > 0 && result.stderr.length > 0 ? Buffer.from("\n") : Buffer.alloc(0),
		result.stderr,
	]);
	return boundedText(combined, MAX_DIAGNOSTIC_BYTES);
}

async function removeManagedWorktree(
	root: string,
	commonDirectory: string,
	marker: IntegrationWorktreeMarker,
): Promise<void> {
	await requireIntegrationMarker(commonDirectory, marker);
	await runGit(["worktree", "remove", "--force", "--force", marker.worktreePath], { cwd: root });
}

async function restoreCandidateRef(
	root: string,
	ref: string,
	priorRef: string | undefined,
	invocationRefValue: string | undefined,
): Promise<void> {
	if (!invocationRefValue) return;
	const current = await refValue(root, ref);
	if (current?.toLowerCase() !== invocationRefValue.toLowerCase()) return;
	if (priorRef === undefined) {
		await deleteRefCas(root, ref, invocationRefValue);
		return;
	}
	await runGit(["update-ref", ref, priorRef, invocationRefValue], {
		cwd: root,
		allowExitCodes: [0, 128],
	});
}

async function cleanupFailedMerge(
	root: string,
	commonDirectory: string,
	ref: string,
	priorRef: string | undefined,
	invocationRefValue: string | undefined,
	worktreePath: string | undefined,
	worktreeReady: boolean,
	containerPath: string | undefined,
	marker: IntegrationWorktreeMarker | undefined,
): Promise<void> {
	const errors: unknown[] = [];
	let provenanceValid = marker === undefined && !worktreeReady;
	if (marker) {
		try {
			await requireIntegrationMarker(commonDirectory, marker);
			provenanceValid = true;
		} catch (error) {
			errors.push(error);
		}
	}
	if (worktreePath && worktreeReady && provenanceValid && marker) {
		try {
			await runGit(["cherry-pick", "--abort"], { cwd: worktreePath, allowExitCodes: [0, 128] });
		} catch (error) {
			errors.push(error);
		}
		try {
			await runGit(["reset", "--hard"], { cwd: worktreePath });
		} catch (error) {
			errors.push(error);
		}
		try {
			await removeManagedWorktree(root, commonDirectory, marker);
			worktreeReady = false;
		} catch (error) {
			errors.push(error);
		}
	} else if (worktreeReady && (!worktreePath || !marker)) {
		provenanceValid = false;
		errors.push(new Error("Integration worktree cleanup has no exact provenance marker"));
	}
	if (provenanceValid) {
		try {
			await restoreCandidateRef(root, ref, priorRef, invocationRefValue);
		} catch (error) {
			errors.push(error);
		}
	}
	let containerRemoved = containerPath === undefined;
	if (containerPath && !worktreeReady && provenanceValid) {
		try {
			if (marker) await requireIntegrationMarker(commonDirectory, marker);
			await rm(containerPath, { recursive: true, force: true });
			containerRemoved = true;
		} catch (error) {
			errors.push(error);
		}
	}
	if (marker && !worktreeReady && containerRemoved && provenanceValid) {
		try {
			await removeIntegrationMarker(commonDirectory, marker);
		} catch (error) {
			errors.push(error);
		}
	}
	let remaining: string | undefined;
	try {
		remaining = await refValue(root, ref);
	} catch (error) {
		errors.push(error);
	}
	const invocationValueWasRestored =
		invocationRefValue !== undefined &&
		priorRef?.toLowerCase() === invocationRefValue.toLowerCase() &&
		remaining?.toLowerCase() === priorRef.toLowerCase();
	if (
		(invocationRefValue !== undefined &&
			remaining?.toLowerCase() === invocationRefValue.toLowerCase() &&
			!invocationValueWasRestored) ||
		errors.length > 0
	) {
		throw new Error("Unable to fully clean the failed integration worktree/ref", {
			cause: new AggregateError(errors),
		});
	}
}

export async function mergeTaskCommits(options: MergeCoordinatorOptions): Promise<IntegrationArtifact> {
	assertIdentifier(options.runId, "runId");
	assertRefPrefix(options.refPrefix);
	assertCommitId(options.baselineCommit, "baselineCommit");
	const commits = selectedCommits(options);
	throwIfAborted(options.signal);

	const root = await repositoryRoot(options.repositoryPath, options.signal);
	const commonDirectory = await commonGitDirectory(root, options.signal);
	const ref = `refs/heads/${options.refPrefix}/${options.runId}`;
	await runGit(["check-ref-format", ref], { cwd: root, signal: options.signal });

	// Complete every read-only validation before reconciling stale worktrees or moving the candidate ref.
	const baseline = await resolveExactCommit(root, options.baselineCommit, "baselineCommit", options.signal);
	const resolvedCommits: Array<MergeTaskCommit & { authorDate: string; committerDate: string }> = [];
	for (const item of commits) {
		const commit = await resolveExactCommit(root, item.commit, `Commit for task ${item.taskId}`, options.signal);
		const ancestry = safeText(
			await runGit(["rev-list", "--parents", "-n", "1", commit], { cwd: root, signal: options.signal }),
		).split(" ");
		if (ancestry.length !== 2 || ancestry[0]?.toLowerCase() !== commit.toLowerCase()) {
			throw new Error(`Task commit must have exactly one parent: ${item.taskId}`);
		}
		resolvedCommits.push({
			taskId: item.taskId,
			commit,
			...sourceDates(
				await runGit(["show", "-s", "--format=%at%n%ct", commit], { cwd: root, signal: options.signal }),
			),
		});
	}
	await assertSafeLocalConfig(root, options.signal);
	const parentDirectory = await temporaryParent(options.temporaryDirectory, root);
	const priorRef = await refValue(root, ref, options.signal);

	let containerPath: string | undefined;
	let worktreePath: string | undefined;
	let worktreeReady = false;
	let invocationMutatedRef = false;
	let invocationRefValue: string | undefined;
	let marker: IntegrationWorktreeMarker | undefined;
	let restorablePriorRef = priorRef;
	try {
		const recoveredStale = await reconcileCandidateWorktrees(
			root,
			commonDirectory,
			ref,
			options.runId,
			options.signal,
		);
		if (recoveredStale) {
			restorablePriorRef = undefined;
			if (priorRef) {
				// Even a baseline-valued stale ref was created by an interrupted invocation and must be deleted on failure.
				invocationMutatedRef = true;
				invocationRefValue = priorRef;
			}
		}
		if (priorRef?.toLowerCase() !== baseline.toLowerCase()) {
			await runGit(["update-ref", ref, baseline, priorRef ?? "0".repeat(baseline.length)], {
				cwd: root,
				signal: options.signal,
			});
			invocationMutatedRef = true;
			invocationRefValue = baseline;
		}

		containerPath = await realpath(await mkdtemp(join(parentDirectory, "pi-subagent-integration-")));
		worktreePath = join(containerPath, "worktree");
		const createdMarker = expectedIntegrationMarker(root, worktreePath, ref, options.runId);
		await createIntegrationMarker(commonDirectory, createdMarker);
		marker = createdMarker;
		await runGit(["worktree", "add", worktreePath, ref.slice("refs/heads/".length)], {
			cwd: root,
			signal: options.signal,
		});
		worktreeReady = true;
		if ((await realpath(worktreePath)) !== worktreePath) throw new Error("Git created an unexpected worktree path");
		await assertSafeLocalConfig(worktreePath, options.signal);

		let parent = baseline;
		for (const item of resolvedCommits) {
			throwIfAborted(options.signal);
			await assertSafeLocalConfig(worktreePath, options.signal);
			const cherryPick = await runGit(["cherry-pick", "--no-commit", item.commit], {
				cwd: worktreePath,
				signal: options.signal,
				allowExitCodes: [0, 1, 128],
			});
			if (cherryPick.exitCode !== 0) {
				const unmerged = safeText(
					await runGit(["diff", "--name-only", "--diff-filter=U", "--"], { cwd: worktreePath }),
				);
				if (unmerged) throw new MergeConflictError(item.taskId, conflictDiagnostics(cherryPick));
				throw new Error(`Unable to apply task commit ${item.taskId}: ${conflictDiagnostics(cherryPick)}`);
			}
			const tree = safeText(await runGit(["write-tree"], { cwd: worktreePath, signal: options.signal }));
			const integratedCommit = safeText(
				await runGit(
					[
						"commit-tree",
						tree,
						"-p",
						parent,
						"-m",
						`pi subagent integrate ${item.taskId}\n\nSource-commit: ${item.commit}`,
					],
					{
						cwd: worktreePath,
						signal: options.signal,
						controlledEnvironment: {
							GIT_AUTHOR_NAME: "Pi Subagent Integration",
							GIT_AUTHOR_EMAIL: "subagent-integration@localhost",
							GIT_AUTHOR_DATE: item.authorDate,
							GIT_COMMITTER_NAME: "Pi Subagent Integration",
							GIT_COMMITTER_EMAIL: "subagent-integration@localhost",
							GIT_COMMITTER_DATE: item.committerDate,
						},
					},
				),
			);
			assertCommitId(integratedCommit, "Integrated commit");
			await runGit(["update-ref", ref, integratedCommit, parent], {
				cwd: worktreePath,
				signal: options.signal,
			});
			invocationMutatedRef = true;
			invocationRefValue = integratedCommit;
			parent = integratedCommit;
		}

		throwIfAborted(options.signal);
		await removeManagedWorktree(root, commonDirectory, marker);
		worktreeReady = false;
		await requireIntegrationMarker(commonDirectory, marker);
		await rm(containerPath, { recursive: true, force: true });
		containerPath = undefined;
		await removeIntegrationMarker(commonDirectory, marker);
		marker = undefined;
		worktreePath = undefined;
		const artifact: IntegrationArtifact = {
			artifactVersion: 1,
			kind: "complete",
			ref,
			commit: parent,
			orderedTaskIds: resolvedCommits.map((item) => item.taskId),
			orderedCommits: resolvedCommits.map((item) => item.commit),
			createdAt: Date.now(),
		};
		if (options.retainRef === false) await deleteRefCas(root, ref, parent, options.signal);
		return artifact;
	} catch (error) {
		try {
			await cleanupFailedMerge(
				root,
				commonDirectory,
				ref,
				restorablePriorRef,
				invocationMutatedRef ? invocationRefValue : undefined,
				worktreePath,
				worktreeReady,
				containerPath,
				marker,
			);
		} catch (cleanupError) {
			throw new Error("Merge failed and cleanup could not be completed", {
				cause: new AggregateError([error, cleanupError]),
			});
		}
		throw error;
	}
}
