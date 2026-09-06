import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { captureExternalMutationPostState } from "@easy-pi/permissions/journal";
import { computeTaskArtifactId } from "./artifact-identity.ts";
import { type TrustedSandboxLauncher, wrapChildInvocation } from "./child-runtime-policy.ts";
import { assertValidationCommandId } from "./contracts.ts";
import { windowsTaskkillInvocation } from "./process-runner.ts";
import { createTaskQuality } from "./quality-model.ts";

export { evaluateCandidateQuality, evaluatePartialCandidateQuality } from "./quality-model.ts";

import type {
	ExternalMutationPostState,
	ExternalMutationRecord,
	ExternalWriterHandoff,
	ExternalWriterTaskContract,
	TaskArtifact,
	ValidationCommand,
	ValidationResult,
	WorktreeHandle,
	WriterHandoff,
	WriterTaskContract,
} from "./types.ts";
import { HANDOFF_ARTIFACT_VERSION, TASK_ARTIFACT_VERSION } from "./types.ts";
import {
	assertCleanValidationWorktree,
	commitWorktree,
	createCleanValidationWorktree,
	inspectWorktreeChanges,
} from "./worktree.ts";

const FORCE_KILL_DELAY_MS = 250;

type WriterQualityTerminalReason = "validation_failed" | "path_violation" | "task_rejected" | "task_inconclusive";

export class WriterQualityError extends Error {
	readonly terminalReason: WriterQualityTerminalReason;
	readonly validations: readonly ValidationResult[];
	readonly validationResults: readonly ValidationResult[];

	constructor(
		terminalReason: WriterQualityTerminalReason,
		message: string,
		validations: readonly ValidationResult[] = [],
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WriterQualityError";
		this.terminalReason = terminalReason;
		this.validations = Object.freeze(validations.map((result) => Object.freeze({ ...result })));
		this.validationResults = this.validations;
	}
}

function assertValidationCommand(command: ValidationCommand): void {
	assertValidationCommandId(command.id);
	if (!command.command || command.command.includes("\0") || !isAbsolute(command.command)) {
		throw new Error(`Validation command ${command.id} requires an absolute, controller-resolved executable`);
	}
	if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
		throw new Error(`Validation command ${command.id} has invalid argv`);
	}
	if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1) {
		throw new Error(`Validation command ${command.id} requires a positive integer timeoutMs`);
	}
	if (!Number.isSafeInteger(command.maxOutputBytes) || command.maxOutputBytes < 1) {
		throw new Error(`Validation command ${command.id} requires a positive integer maxOutputBytes`);
	}
	if (command.cwd !== undefined && (!command.cwd || command.cwd.includes("\0"))) {
		throw new Error(`Validation command ${command.id} has an invalid cwd`);
	}
}

/** Trusted, immutable validation definitions. Writers select IDs and can never supply command strings. */
export class ValidationRegistry {
	readonly #commands: ReadonlyMap<string, Readonly<ValidationCommand>>;

	constructor(commands: readonly ValidationCommand[]) {
		const registered = new Map<string, Readonly<ValidationCommand>>();
		for (const command of commands) {
			assertValidationCommand(command);
			if (registered.has(command.id)) throw new Error(`Duplicate validation command id: ${command.id}`);
			registered.set(
				command.id,
				Object.freeze({
					...command,
					args: Object.freeze([...command.args]),
				}),
			);
		}
		this.#commands = registered;
		Object.freeze(this);
	}

	lookup(commandId: string): Readonly<ValidationCommand> {
		const command = this.#commands.get(commandId);
		if (!command) throw new Error(`Unknown validation command: ${commandId}`);
		return command;
	}

	get(commandId: string): Readonly<ValidationCommand> {
		return this.lookup(commandId);
	}
}

function isWithin(parent: string, candidate: string): boolean {
	const path = relative(parent, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function validationCwd(handle: WorktreeHandle, requested: string | undefined): Promise<string> {
	const root = await realpath(handle.path);
	if (root !== resolve(handle.path)) throw new Error("Writer worktree path is not canonical");
	const cwd = requested ?? ".";
	const components = cwd.split("/");
	if (
		isAbsolute(cwd) ||
		cwd.includes("\\") ||
		cwd.includes("\0") ||
		(cwd !== "." && components.some((component) => !component || component === "." || component === "..")) ||
		components.some((component) => component.toLowerCase() === ".git")
	) {
		throw new Error(`Unsafe validation cwd: ${cwd}`);
	}
	const candidate = resolve(root, cwd);
	if (!isWithin(root, candidate)) throw new Error(`Unsafe validation cwd: ${cwd}`);
	const canonical = await realpath(candidate);
	if (!isWithin(root, canonical)) throw new Error(`Validation cwd resolves outside the writer worktree: ${cwd}`);
	if (!(await stat(canonical)).isDirectory()) throw new Error(`Validation cwd is not a directory: ${cwd}`);
	return canonical;
}

interface PrivateValidationRuntime {
	rootDirectory: string;
	homeDirectory: string;
	temporaryDirectory: string;
	environment: NodeJS.ProcessEnv;
	cleanup(): Promise<void>;
}

function validationEnvironment(homeDirectory: string, temporaryDirectory: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: homeDirectory,
		TMPDIR: temporaryDirectory,
		TMP: temporaryDirectory,
		TEMP: temporaryDirectory,
	};
	for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE"] as const) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	if (process.platform === "win32") {
		env.USERPROFILE = homeDirectory;
		for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const) {
			if (process.env[key] !== undefined) env[key] = process.env[key];
		}
	}
	return env;
}

async function createPrivateValidationRuntime(): Promise<PrivateValidationRuntime> {
	const rootDirectory = await mkdtemp(join(tmpdir(), "wj-pi-validation-"));
	try {
		await chmod(rootDirectory, 0o700);
		const homeDirectory = join(rootDirectory, "home");
		const temporaryDirectory = join(rootDirectory, "tmp");
		await mkdir(homeDirectory, { mode: 0o700 });
		await mkdir(temporaryDirectory, { mode: 0o700 });
		await chmod(homeDirectory, 0o700);
		await chmod(temporaryDirectory, 0o700);
		return {
			rootDirectory,
			homeDirectory,
			temporaryDirectory,
			environment: validationEnvironment(homeDirectory, temporaryDirectory),
			async cleanup(): Promise<void> {
				await rm(rootDirectory, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(rootDirectory, { recursive: true, force: true });
		throw error;
	}
}

function terminateWindowsProcessTree(child: ReturnType<typeof spawn>): void {
	if (child.pid === undefined) return;
	const invocation = windowsTaskkillInvocation(child.pid);
	try {
		const taskkill = spawn(invocation.command, invocation.args, invocation.options);
		taskkill.on("error", () => {});
		taskkill.unref();
	} catch {
		// Validation will retain its timeout/cancellation result. Never invoke a shell fallback.
	}
}

function terminatePosixProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall back to terminating the direct child if process-group signaling is unavailable.
		}
	}
	child.kill(signal);
}

function decodedOutput(stdout: Buffer, stderr: Buffer, maxBytes: number): { stdout: string; stderr: string } {
	let stdoutBuffer = stdout;
	let stderrBuffer = stderr;
	let stdoutText = stdoutBuffer.toString("utf8");
	let stderrText = stderrBuffer.toString("utf8");
	while (Buffer.byteLength(stdoutText) + Buffer.byteLength(stderrText) > maxBytes) {
		if (stderrBuffer.length > 0) stderrBuffer = stderrBuffer.subarray(0, stderrBuffer.length - 1);
		else stdoutBuffer = stdoutBuffer.subarray(0, stdoutBuffer.length - 1);
		stdoutText = stdoutBuffer.toString("utf8");
		stderrText = stderrBuffer.toString("utf8");
	}
	return { stdout: stdoutText, stderr: stderrText };
}

async function runValidationCommand(
	handle: WorktreeHandle,
	command: Readonly<ValidationCommand>,
	environment: NodeJS.ProcessEnv,
	sandboxLauncher?: TrustedSandboxLauncher,
	signal?: AbortSignal,
): Promise<ValidationResult> {
	const startedAt = Date.now();
	if (signal?.aborted) {
		return { commandId: command.id, status: "cancelled", stdout: "", stderr: "", durationMs: 0 };
	}
	const cwd = await validationCwd(handle, command.cwd);
	const invocation = wrapChildInvocation({ command: command.command, args: command.args }, sandboxLauncher);
	return await new Promise<ValidationResult>((resolvePromise) => {
		let child: ReturnType<typeof spawn>;
		let forcedStatus: ValidationResult["status"] | undefined;
		let processError: Error | undefined;
		let closed = false;
		let outputBytes = 0;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let terminationStarted = false;

		try {
			child = spawn(invocation.command, invocation.args, {
				cwd,
				env: environment,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			resolvePromise({
				commandId: command.id,
				status: "failed",
				stdout: "",
				stderr: message,
				durationMs: Date.now() - startedAt,
			});
			return;
		}

		const terminate = (): void => {
			if (closed || terminationStarted) return;
			terminationStarted = true;
			if (process.platform === "win32") {
				terminateWindowsProcessTree(child);
				return;
			}
			terminatePosixProcessGroup(child, "SIGTERM");
			forceKillTimer = setTimeout(() => {
				if (!closed) terminatePosixProcessGroup(child, "SIGKILL");
			}, FORCE_KILL_DELAY_MS);
			forceKillTimer.unref();
		};
		const collect = (chunk: Buffer, destination: Buffer[]): void => {
			const remaining = Math.max(0, command.maxOutputBytes - outputBytes);
			if (remaining > 0) destination.push(Buffer.from(chunk.subarray(0, remaining)));
			outputBytes += chunk.byteLength;
			if (outputBytes > command.maxOutputBytes && !forcedStatus) {
				forcedStatus = "failed";
				terminate();
			}
		};
		const onAbort = (): void => {
			forcedStatus ??= "cancelled";
			terminate();
		};

		child.stdout?.on("data", (chunk: Buffer) => collect(chunk, stdoutChunks));
		child.stderr?.on("data", (chunk: Buffer) => collect(chunk, stderrChunks));
		child.on("error", (error) => {
			processError = error;
		});
		child.on("exit", () => {
			// Descendants can retain inherited pipes after the registered parent exits.
			// Terminate the detached group so completion is bounded by the force-kill timer.
			if (!closed) terminate();
		});
		child.on("close", (code) => {
			closed = true;
			if (timeout) clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			signal?.removeEventListener("abort", onAbort);
			const stderr = Buffer.concat([
				...stderrChunks,
				...(processError ? [Buffer.from(`${stderrChunks.length > 0 ? "\n" : ""}${processError.message}`)] : []),
			]);
			const output = decodedOutput(Buffer.concat(stdoutChunks), stderr, command.maxOutputBytes);
			const status = forcedStatus ?? (processError || code !== 0 ? "failed" : "passed");
			resolvePromise({
				commandId: command.id,
				status,
				...(code !== null ? { exitCode: code } : {}),
				stdout: output.stdout,
				stderr: output.stderr,
				durationMs: Date.now() - startedAt,
			});
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		timeout = setTimeout(() => {
			if (!forcedStatus) forcedStatus = "timeout";
			terminate();
		}, command.timeoutMs);
		timeout.unref();
	});
}

export interface RunValidationCommandsOptions {
	handle: WorktreeHandle;
	commandIds: readonly string[];
	registry: ValidationRegistry;
	/** Trusted controller-only wrapper for validation executables. */
	sandboxLauncher?: TrustedSandboxLauncher;
	signal?: AbortSignal;
}

export async function runValidationCommands(options: RunValidationCommandsOptions): Promise<ValidationResult[]> {
	if (options.commandIds.length === 0) return [];
	const runtime = await createPrivateValidationRuntime();
	try {
		const results: ValidationResult[] = [];
		for (const commandId of options.commandIds) {
			const command = options.registry.lookup(commandId);
			const result = await runValidationCommand(
				options.handle,
				command,
				runtime.environment,
				options.sandboxLauncher,
				options.signal,
			);
			results.push(result);
			if (result.status === "cancelled") break;
		}
		return results;
	} finally {
		await runtime.cleanup();
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface CreateExternalWriterArtifactOptions {
	task: ExternalWriterTaskContract;
	handoff: ExternalWriterHandoff;
	externalMutations: readonly ExternalMutationRecord[];
}

function sameConfirmedExternalPostState(
	expected: ExternalMutationPostState | undefined,
	actual: ExternalMutationPostState,
): boolean {
	return (
		expected?.status === "confirmed" &&
		actual.status === "confirmed" &&
		expected.fileType === actual.fileType &&
		expected.size === actual.size &&
		expected.mode === actual.mode &&
		expected.modifiedAtMs === actual.modifiedAtMs &&
		expected.sha256 === actual.sha256
	);
}

export async function createExternalWriterArtifact(
	options: CreateExternalWriterArtifactOptions,
): Promise<TaskArtifact> {
	const { task, handoff, externalMutations } = options;
	if (handoff.taskId !== task.id || handoff.artifactVersion !== HANDOFF_ARTIFACT_VERSION) {
		throw new WriterQualityError("path_violation", "External writer handoff does not match the task contract");
	}
	if (handoff.outcome === "rejected" || handoff.outcome === "inconclusive") {
		throw new WriterQualityError(
			handoff.outcome === "rejected" ? "task_rejected" : "task_inconclusive",
			`External writer reported semantic outcome ${handoff.outcome}`,
		);
	}
	if (externalMutations.length === 0) {
		throw new WriterQualityError("path_violation", "External writer has no Controller-authorized mutation journal");
	}
	for (const mutation of externalMutations) {
		if (mutation.taskId !== task.id || mutation.authorizationStatus !== "authorized") {
			throw new WriterQualityError("path_violation", "External mutation journal identity does not match the task");
		}
		if (mutation.toolResult !== "succeeded" || mutation.postState?.status !== "confirmed") {
			throw new WriterQualityError(
				"path_violation",
				`External mutation lacks a successful confirmed post-state: ${mutation.operation} ${mutation.path}`,
			);
		}
	}
	const authorizedPaths = [...new Set(externalMutations.map((mutation) => mutation.path))].sort();
	const latestMutationByPath = new Map<string, ExternalMutationRecord>();
	for (const mutation of externalMutations) {
		const latest = latestMutationByPath.get(mutation.path);
		if (!latest || mutation.authorizationSequence > latest.authorizationSequence) {
			latestMutationByPath.set(mutation.path, mutation);
		}
	}
	for (const path of authorizedPaths) {
		if (!task.externalOwnedPaths.some((root) => isWithin(root, path))) {
			throw new WriterQualityError(
				"path_violation",
				`External writer changed path is outside its declared roots: ${path}`,
			);
		}
		const latestMutation = latestMutationByPath.get(path);
		const currentPostState = await captureExternalMutationPostState(path);
		if (!latestMutation || !sameConfirmedExternalPostState(latestMutation.postState, currentPostState)) {
			throw new WriterQualityError(
				"path_violation",
				`External writer current post-state does not match the latest Controller observation: ${path}`,
			);
		}
	}
	const auditedHandoff = { ...handoff, externalChangedPaths: [...authorizedPaths] };
	const artifactContent = {
		artifactVersion: TASK_ARTIFACT_VERSION,
		taskId: task.id,
		contractHash: task.contractHash,
		handoff: auditedHandoff,
		changedPaths: [],
		externalChangedPaths: [...authorizedPaths],
		externalMutations: externalMutations.map((mutation) => structuredClone(mutation)),
		validations: [],
		quality: createTaskQuality(auditedHandoff, { role: task.role, pathAuditPassed: true }),
	};
	return {
		...artifactContent,
		artifactId: computeTaskArtifactId(artifactContent),
		createdAt: Date.now(),
	};
}

export type WriterQualityPerformanceStage = "writer_audit" | "validation" | "commit";

export interface ValidateAndCommitWriterTaskOptions {
	handle: WorktreeHandle;
	task: WriterTaskContract;
	handoff: WriterHandoff;
	registry: ValidationRegistry;
	/** Trusted controller-only wrapper for registered validation commands. */
	sandboxLauncher?: TrustedSandboxLauncher;
	signal?: AbortSignal;
	/** Content-free observer. Exceptions are ignored so telemetry cannot change quality decisions. */
	onPerformance?: (stage: WriterQualityPerformanceStage, durationMs: number) => void;
}

async function validateExactWriterCommit(
	options: ValidateAndCommitWriterTaskOptions,
	commit: string,
): Promise<ValidationResult[]> {
	if (options.task.validationCommandIds.length === 0) return [];
	let validationHandle: WorktreeHandle | undefined;
	let validations: ValidationResult[] = [];
	let failure: unknown;
	try {
		try {
			validationHandle = await createCleanValidationWorktree(options.handle, commit, options.signal);
		} catch (error) {
			throw new WriterQualityError(
				"validation_failed",
				`Clean validation worktree could not be created: ${message(error)}`,
				[],
				{ cause: error },
			);
		}
		try {
			validations = await runValidationCommands({
				handle: validationHandle,
				commandIds: options.task.validationCommandIds,
				registry: options.registry,
				sandboxLauncher: options.sandboxLauncher,
				signal: options.signal,
			});
		} catch (error) {
			throw new WriterQualityError("validation_failed", `Writer validation could not run: ${message(error)}`, [], {
				cause: error,
			});
		}
		const failed = validations.find((result) => result.status !== "passed");
		if (failed) {
			throw new WriterQualityError(
				"validation_failed",
				`Validation command ${failed.commandId} did not pass (${failed.status})`,
				validations,
			);
		}
		try {
			await assertCleanValidationWorktree(validationHandle, options.signal);
		} catch (error) {
			throw new WriterQualityError(
				"path_violation",
				`Post-validation exact-commit audit failed: ${message(error)}`,
				validations,
				{ cause: error },
			);
		}
	} catch (error) {
		failure = error;
	}
	if (validationHandle) {
		try {
			await validationHandle.cleanup();
		} catch (error) {
			failure = new WriterQualityError(
				"validation_failed",
				`Clean validation worktree cleanup failed: ${message(error)}`,
				validations,
				{ cause: failure ? new AggregateError([failure, error]) : error },
			);
		}
	}
	if (failure) throw failure;
	return validations;
}

export async function validateAndCommitWriterTask(options: ValidateAndCommitWriterTaskOptions): Promise<TaskArtifact> {
	const { handle, task, handoff, signal } = options;
	const measure = async <T>(stage: WriterQualityPerformanceStage, operation: () => Promise<T>): Promise<T> => {
		const startedAt = performance.now();
		try {
			return await operation();
		} finally {
			try {
				options.onPerformance?.(stage, Math.max(0, performance.now() - startedAt));
			} catch {
				// Performance observers are non-authoritative.
			}
		}
	};
	if (handoff.taskId !== task.id || handoff.artifactVersion !== HANDOFF_ARTIFACT_VERSION) {
		throw new WriterQualityError("path_violation", "Writer handoff does not match the writer task contract");
	}
	if (handoff.outcome === "rejected" || handoff.outcome === "inconclusive") {
		throw new WriterQualityError(
			handoff.outcome === "rejected" ? "task_rejected" : "task_inconclusive",
			`Writer reported semantic outcome ${handoff.outcome}; refusing to commit an unaccepted change`,
		);
	}
	let changedPaths: string[];
	try {
		changedPaths = await measure(
			"writer_audit",
			async () => await inspectWorktreeChanges(handle, task.ownedPaths, signal),
		);
	} catch (error) {
		throw new WriterQualityError("path_violation", `Writer change audit failed: ${message(error)}`, [], {
			cause: error,
		});
	}
	if (changedPaths.length === 0) {
		throw new WriterQualityError("path_violation", "Writer task produced no changes");
	}
	const auditedHandoff = { ...handoff, changedPaths: [...changedPaths] };

	let commit: string;
	try {
		commit = await measure(
			"commit",
			async () => await commitWorktree(handle, `pi subagent writer ${task.id}`, signal),
		);
	} catch (error) {
		throw new WriterQualityError("path_violation", `Writer commit failed: ${message(error)}`, [], {
			cause: error,
		});
	}

	const validations = await measure("validation", async () => await validateExactWriterCommit(options, commit));
	const artifactContent = {
		artifactVersion: TASK_ARTIFACT_VERSION,
		taskId: task.id,
		contractHash: task.contractHash,
		handoff: auditedHandoff,
		changedPaths: [...changedPaths],
		validations: validations.map((result) => ({ ...result })),
		quality: createTaskQuality(auditedHandoff, {
			role: task.role,
			pathAuditPassed: true,
			validations,
		}),
		commit,
	};
	return {
		...artifactContent,
		artifactId: computeTaskArtifactId(artifactContent),
		createdAt: Date.now(),
	};
}
