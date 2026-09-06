import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import type { Usage } from "@earendil-works/pi-ai";
import {
	CHILD_HARNESS_CONTEXT_ENV,
	type ChildHarnessContext,
	type ChildHarnessContextProvider,
	canonicalizeProspectivePath,
	validateChildHarnessContext,
} from "@easy-pi/permissions";
import {
	type ExternalMutationJournalEvent,
	type ExternalMutationJournalPolicy,
	ExternalMutationJournalReader,
} from "@easy-pi/permissions/journal";
import { createSubagentPromptCacheKey, SUBAGENT_PROMPT_CACHE_KEY_ENV } from "./cache-affinity.ts";
import type { ChildAgentRuntime, ChildAgentRuntimeEvent, ChildAgentRuntimeState } from "./child-agent-runtime.ts";
import {
	createPrivateChildRuntimeDirectory,
	type TrustedSandboxLauncher,
	wrapChildInvocation,
} from "./child-runtime-policy.ts";
import { projectDependencyArtifacts } from "./dependency-projector.ts";
import { asInconclusivePartialHandoff, decodeHandoffEnvelope } from "./handoff.ts";
import {
	createLiveActivity,
	type LiveActivity,
	LiveActivityUpdateScheduler,
	reduceLiveActivity,
	snapshotLiveActivity,
} from "./live-activity.ts";
import { PiRpcChildRuntime, PiRpcRuntimeError } from "./pi-rpc-runtime.ts";
import type {
	ChildModelSelection,
	ChildRuntimeMetadata,
	ChildTaskResult,
	DagTaskContract,
	ExternalWriterTaskContract,
	ProviderCircuitOpenSignal,
	ReadOnlyTaskContract,
	SubagentBudget,
	TaskArtifact,
	TaskTerminalReason,
	WriterTaskContract,
} from "./types.ts";
import { PROVIDER_CIRCUIT_VERSION, SUBAGENT_INFRA_LIMITS } from "./types.ts";

const FORCE_KILL_DELAY_MS = 250;
/** Consecutive identical tool calls (same tool + same args) that mark a stuck loop. */
const LOOP_DETECTION_STREAK = 3;
const PROVIDER_CIRCUIT_ZERO_PROGRESS_RETRY_LIMIT = 8;
const MAX_MODEL_ERROR_DETAIL_CHARS = 2_000;
const SOFT_BUDGET_WRAP_UP_MESSAGE =
	'Token usage has reached at least 90% of this task\'s hard budget. Stop expanding scope now. Immediately call submit_handoff. Use outcome "accepted" if the task is complete; otherwise use "inconclusive" and summarize progress, checks, risks, and next steps.';

/** Preserve actionable provider diagnostics without allowing terminal controls or unbounded ledger entries. */
function modelErrorDetail(value: unknown): string {
	if (typeof value !== "string") return "";
	const normalized = value
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return "";
	const bounded =
		normalized.length <= MAX_MODEL_ERROR_DETAIL_CHARS
			? normalized
			: `${normalized.slice(0, MAX_MODEL_ERROR_DETAIL_CHARS - 1)}…`;
	return `: ${bounded}`;
}

export function windowsTaskkillInvocation(pid: number): {
	command: "taskkill";
	args: ["/PID", string, "/T", "/F"];
	options: { windowsHide: true; shell: false; stdio: "ignore" };
} {
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("A positive child PID is required");
	return {
		command: "taskkill",
		args: ["/PID", String(pid), "/T", "/F"],
		options: { windowsHide: true, shell: false, stdio: "ignore" },
	};
}

function terminateWindowsProcessTree(child: ReturnType<typeof spawn>): void {
	if (child.pid === undefined) return;
	const invocation = windowsTaskkillInvocation(child.pid);
	try {
		const taskkill = spawn(invocation.command, invocation.args, invocation.options);
		taskkill.on("error", () => {});
		taskkill.unref();
	} catch {
		// The original child error/timeout remains authoritative. Never invoke a shell fallback.
	}
}

function terminatePosixProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall through when process-group signaling is unavailable.
		}
	}
	child.kill(signal);
}

export interface ChildPiInvocation {
	command: string;
	/** Arguments placed before the controller-owned Pi arguments. Intended for packaged entrypoints and test fixtures. */
	args?: readonly string[];
}

export interface ExternalMutationJournalController {
	policy: ExternalMutationJournalPolicy;
	/** Synchronous durable sink owned by the parent Controller. */
	onEvent(event: ExternalMutationJournalEvent): void;
}

export interface RunChildTaskOptions {
	task: ReadOnlyTaskContract | DagTaskContract;
	budget: SubagentBudget;
	/** Attempt-relative usage threshold for one best-effort RPC wrap-up steer; omitted after a prior attempt crossed it. */
	softTokenLimit?: number;
	/** Path of the immutable snapshot or isolated writer worktree. This is the only value used as child cwd. */
	snapshotPath: string;
	/** Canonical source workspace represented by the snapshot/worktree. */
	workspaceRoot: string;
	/** Trusted controller selection. It is passed as argv and cannot be supplied by the child task. */
	childModel?: ChildModelSelection;
	/** Structured artifacts from this DAG task's completed prerequisites. */
	prerequisiteArtifacts?: readonly TaskArtifact[];
	/** Bounded controller-generated diagnosis from a repairable prior attempt. */
	retryFeedback?: string;
	signal?: AbortSignal;
	/** Override only the executable/prefix used to invoke Pi. Transport/session arguments remain controller-owned. */
	invocation?: ChildPiInvocation;
	/** Trusted controller-only environment additions merged over the inherited parent process environment. */
	controllerEnvironment?: Readonly<NodeJS.ProcessEnv>;
	/** Trusted controller-only OS sandbox wrapper. Task/model content cannot set this. */
	sandboxLauncher?: TrustedSandboxLauncher;
	/** WJ-owned issuer for the inherited Child permission snapshot. */
	createChildHarnessContext?: ChildHarnessContextProvider;
	/** Required for external-writer attempts; private and never included in the model prompt. */
	externalMutationJournal?: ExternalMutationJournalController;
	/** Test-only overrides for infrastructure limits. Not part of the model-facing budget. */
	limits?: Partial<typeof SUBAGENT_INFRA_LIMITS>;
	/** Production defaults to persistent process-isolated RPC; JSON is retained only as a deterministic event-stream adapter. */
	transport?: "rpc" | "json";
	/** Prior attempt metadata; session identity reconnects, while identity-free metadata seeds a fresh generation. */
	resumeRuntime?: ChildRuntimeMetadata;
	/** Synchronous controller hook used to register/persist the live runtime before prompting. */
	onRuntimeReady?: (runtime: ChildAgentRuntime, metadata: ChildRuntimeMetadata) => void;
	/** Synchronous event hook; callers must keep it bounded and non-throwing. */
	onRuntimeEvent?: (runtime: ChildAgentRuntime, event: ChildAgentRuntimeEvent, metadata: ChildRuntimeMetadata) => void;
	/** Ephemeral bounded activity hook. The controller must not persist this payload. */
	onLiveActivity?: (runtime: ChildAgentRuntime, activity: LiveActivity) => void;
	onRuntimeClosed?: (runtime: ChildAgentRuntime, metadata: ChildRuntimeMetadata) => void;
}

interface Failure {
	reason: TaskTerminalReason;
	error: string;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function failedResult(
	task: ReadOnlyTaskContract | DagTaskContract,
	reason: TaskTerminalReason,
	error: string,
	usage: Usage = zeroUsage(),
	turns = 0,
	model?: string,
): ChildTaskResult {
	return {
		taskId: task.id,
		role: task.role,
		success: false,
		terminalReason: reason,
		error,
		usage,
		turns,
		...(model ? { model } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseUsage(value: unknown): Usage | undefined {
	if (!isRecord(value) || !isRecord(value.cost)) return undefined;
	const input = readNonNegativeNumber(value, "input");
	const output = readNonNegativeNumber(value, "output");
	const cacheRead = readNonNegativeNumber(value, "cacheRead");
	const cacheWrite = readNonNegativeNumber(value, "cacheWrite");
	const totalTokens = readNonNegativeNumber(value, "totalTokens");
	const costInput = readNonNegativeNumber(value.cost, "input");
	const costOutput = readNonNegativeNumber(value.cost, "output");
	const costCacheRead = readNonNegativeNumber(value.cost, "cacheRead");
	const costCacheWrite = readNonNegativeNumber(value.cost, "cacheWrite");
	const costTotal = readNonNegativeNumber(value.cost, "total");
	if (
		input === undefined ||
		output === undefined ||
		cacheRead === undefined ||
		cacheWrite === undefined ||
		totalTokens === undefined ||
		costInput === undefined ||
		costOutput === undefined ||
		costCacheRead === undefined ||
		costCacheWrite === undefined ||
		costTotal === undefined
	) {
		return undefined;
	}

	const cacheWrite1h = readNonNegativeNumber(value, "cacheWrite1h");
	const reasoning = readNonNegativeNumber(value, "reasoning");
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: {
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			total: costTotal,
		},
		...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
	};
}

function addUsage(total: Usage, next: Usage): void {
	total.input += next.input;
	total.output += next.output;
	total.cacheRead += next.cacheRead;
	total.cacheWrite += next.cacheWrite;
	total.totalTokens += next.totalTokens;
	total.cost.input += next.cost.input;
	total.cost.output += next.cost.output;
	total.cost.cacheRead += next.cost.cacheRead;
	total.cost.cacheWrite += next.cost.cacheWrite;
	total.cost.total += next.cost.total;
	if (next.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + next.cacheWrite1h;
	if (next.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + next.reasoning;
}

function combinedUsage(completed: Usage, current: Usage): Usage {
	const combined = structuredClone(completed);
	addUsage(combined, current);
	return combined;
}

function assistantText(message: Record<string, unknown>): string | undefined {
	if (!Array.isArray(message.content)) return undefined;
	const parts: string[] = [];
	for (const part of message.content) {
		if (!isRecord(part) || typeof part.type !== "string") return undefined;
		if (part.type === "text") {
			if (typeof part.text !== "string") return undefined;
			parts.push(part.text);
		}
	}
	return parts.join("");
}

function isWriterTask(task: ReadOnlyTaskContract | DagTaskContract): task is WriterTaskContract {
	return task.role === "writer";
}

function isExternalWriterTask(task: ReadOnlyTaskContract | DagTaskContract): task is ExternalWriterTaskContract {
	return task.role === "external-writer";
}

function childModelArgs(selection: ChildModelSelection | undefined): string[] {
	if (!selection) return [];
	const values = [
		["provider", selection.provider],
		["model", selection.model],
	] as const;
	for (const [name, value] of values) {
		if (!value || value.length > 300 || value.startsWith("-") || /[\0\r\n]/.test(value)) {
			throw new Error(`Unsafe child ${name} selection`);
		}
	}
	return [
		"--provider",
		selection.provider,
		"--model",
		selection.model,
		...(selection.thinkingLevel ? ["--thinking", selection.thinkingLevel] : []),
	];
}

function childRuntimeEnvironment(
	options: RunChildTaskOptions,
	contextPath: string,
	childContext: ChildHarnessContext,
	controllerValues: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
	const promptCacheKey = createSubagentPromptCacheKey({
		workspaceRoot: options.workspaceRoot,
		role: options.task.role,
		permissionMode: childContext.permissionMode,
		childModel: options.childModel,
	});
	return {
		...process.env,
		...(options.controllerEnvironment ?? {}),
		[CHILD_HARNESS_CONTEXT_ENV]: contextPath,
		...controllerValues,
		[SUBAGENT_PROMPT_CACHE_KEY_ENV]: promptCacheKey,
	};
}

function prerequisiteData(options: RunChildTaskOptions): readonly TaskArtifact[] {
	if (!("dependsOn" in options.task)) return [];
	const prerequisites = new Set(options.task.dependsOn);
	return (options.prerequisiteArtifacts ?? []).filter((artifact) => prerequisites.has(artifact.taskId));
}

function validatedRetryFeedback(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!value || value.length > 1_200 || /[\p{Cc}\p{Cf}]/u.test(value)) {
		throw new Error("Unsafe retry feedback");
	}
	return value;
}

function pathIsWithin(parent: string, candidate: string): boolean {
	const path = relative(parent, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function pathsOverlap(left: string, right: string): boolean {
	return pathIsWithin(left, right) || pathIsWithin(right, left);
}

const CHILD_RUNTIME_OWNER_MARKER = ".wj-pi-runtime-owner.json";

interface ManagedChildRuntimeDirectory extends Awaited<ReturnType<typeof createPrivateChildRuntimeDirectory>> {
	runtimeRootId: string;
}

async function readRuntimeRootId(root: string): Promise<string | undefined> {
	try {
		const value = JSON.parse(await readFile(join(root, CHILD_RUNTIME_OWNER_MARKER), "utf8")) as unknown;
		if (
			typeof value !== "object" ||
			value === null ||
			(value as { version?: unknown }).version !== 1 ||
			typeof (value as { id?: unknown }).id !== "string"
		) {
			throw new Error("Child runtime ownership marker is malformed");
		}
		return (value as { id: string }).id;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function createRuntimeOwnershipMarker(root: string): Promise<string> {
	const id = randomUUID();
	const marker = join(root, CHILD_RUNTIME_OWNER_MARKER);
	await writeFile(marker, `${JSON.stringify({ version: 1, id })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	await chmod(marker, 0o600);
	return id;
}

async function removeManagedRuntimeRoot(root: string, expectedId: string): Promise<void> {
	let canonical: string;
	try {
		canonical = await realpath(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (canonical !== root || !basename(canonical).startsWith("wj-pi-child-")) {
		throw new Error("Child runtime root is not a Controller-owned private directory");
	}
	if ((await readRuntimeRootId(canonical)) !== expectedId) {
		throw new Error("Child runtime ownership marker does not match durable metadata");
	}
	await rm(canonical, { recursive: true, force: true });
}

export async function cleanupChildRuntimeRoot(metadata: ChildRuntimeMetadata): Promise<void> {
	if (!metadata.runtimeRoot) return;
	if (!metadata.runtimeRootId) throw new Error("Child runtime ownership identity is missing");
	if (!isAbsolute(metadata.runtimeRoot)) throw new Error("Child runtime root must be absolute");
	await removeManagedRuntimeRoot(metadata.runtimeRoot, metadata.runtimeRootId);
}

async function childRuntimeDirectory(
	resumeRuntime: ChildRuntimeMetadata | undefined,
): Promise<ManagedChildRuntimeDirectory> {
	if (!resumeRuntime?.sessionFile) {
		const created = await createPrivateChildRuntimeDirectory();
		try {
			const rootDirectory = await realpath(created.rootDirectory);
			const runtimeRootId = await createRuntimeOwnershipMarker(rootDirectory);
			return {
				rootDirectory,
				sessionDirectory: await realpath(created.sessionDirectory),
				runtimeRootId,
				async cleanup(): Promise<void> {
					await removeManagedRuntimeRoot(rootDirectory, runtimeRootId);
				},
			};
		} catch (error) {
			await created.cleanup().catch(() => undefined);
			throw error;
		}
	}
	const sessionFile = await realpath(resumeRuntime.sessionFile);
	const requestedRoot = resumeRuntime.runtimeRoot ?? dirname(dirname(sessionFile));
	if (!isAbsolute(requestedRoot)) throw new Error("Resumable Child runtime root must be absolute");
	const rootDirectory = await realpath(requestedRoot);
	if (rootDirectory !== requestedRoot || !basename(rootDirectory).startsWith("wj-pi-child-")) {
		throw new Error("Resumable Child runtime root is not a Controller-owned private directory");
	}
	if (!pathIsWithin(rootDirectory, sessionFile) || rootDirectory === sessionFile) {
		throw new Error("Resumable Child session file is outside its recorded runtime root");
	}
	const persistedId = await readRuntimeRootId(rootDirectory);
	const runtimeRootId =
		resumeRuntime.runtimeRootId ?? persistedId ?? (await createRuntimeOwnershipMarker(rootDirectory));
	if (persistedId !== undefined && persistedId !== runtimeRootId) {
		throw new Error("Resumable Child runtime ownership marker does not match durable metadata");
	}
	if (resumeRuntime.runtimeRootId !== undefined && persistedId === undefined) {
		throw new Error("Resumable Child runtime ownership marker is missing");
	}
	const sessionDirectory = await realpath(join(rootDirectory, "sessions"));
	return {
		rootDirectory,
		sessionDirectory,
		runtimeRootId,
		async cleanup(): Promise<void> {
			await removeManagedRuntimeRoot(rootDirectory, runtimeRootId);
		},
	};
}

function externalOwnedPathsForChild(options: RunChildTaskOptions): string[] {
	if (!isExternalWriterTask(options.task)) return [];
	const workspaceRoot = canonicalizeProspectivePath(options.workspaceRoot, options.workspaceRoot);
	return options.task.externalOwnedPaths.map((path) => {
		const canonical = canonicalizeProspectivePath(path, workspaceRoot);
		if (pathsOverlap(workspaceRoot, canonical)) {
			throw new Error(`External writer path must not overlap the source workspace: ${path}`);
		}
		return canonical;
	});
}

function taskPrompt(options: RunChildTaskOptions): string {
	const { task } = options;
	const retryFeedback = validatedRetryFeedback(options.retryFeedback);
	const contract = {
		objective: task.objective,
		...(isWriterTask(task) ? { ownedPaths: task.ownedPaths } : {}),
		...(isExternalWriterTask(task) ? { externalOwnedPaths: externalOwnedPathsForChild(options) } : {}),
		dependencyView: projectDependencyArtifacts(prerequisiteData(options)),
		...(retryFeedback ? { retryFeedback } : {}),
	};
	return `Execute this controller-issued task contract:\n\n${JSON.stringify(contract, null, 2)}`;
}

export function resolvePiInvocation(args: readonly string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) {
		return { command: process.execPath, args: [...args] };
	}
	return { command: "pi", args: [...args] };
}

async function runProcess(
	options: RunChildTaskOptions,
	contextPath: string,
	childContext: ChildHarnessContext,
	handoffPath: string,
): Promise<ChildTaskResult> {
	const { task, budget } = options;
	const limits = { ...SUBAGENT_INFRA_LIMITS, ...options.limits };
	const usage = zeroUsage();
	let streamingUsage = zeroUsage();
	let lastToolSignature = "";
	let loopStreak = 0;
	let turns = 0;
	let model: string | undefined;
	let finalDiagnostic = "";
	let failure: Failure | undefined;
	let stderr = "";
	let stderrBytes = 0;
	let outputBytes = 0;
	let closed = false;
	const activeTools = new Map<string, string>();

	const childArgs = [
		...childModelArgs(options.childModel),
		"--mode",
		"json",
		"--json-profile",
		"compact",
		"--no-session",
		"--print",
		taskPrompt(options),
	];
	const rawInvocation = options.invocation
		? { command: options.invocation.command, args: [...(options.invocation.args ?? []), ...childArgs] }
		: resolvePiInvocation(childArgs);
	const invocation = wrapChildInvocation(rawInvocation, options.sandboxLauncher);

	return await new Promise<ChildTaskResult>((resolve) => {
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
		let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
		let terminationStarted = false;
		const decoder = new StringDecoder("utf8");
		let lineBuffer = "";
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.snapshotPath,
			env: childRuntimeEnvironment(options, contextPath, childContext),
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const terminate = () => {
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

		const fail = (reason: TaskTerminalReason, error: string) => {
			if (failure) return;
			failure = { reason, error };
			terminate();
		};

		const resetInactivityTimer = () => {
			if (inactivityTimer) clearTimeout(inactivityTimer);
			inactivityTimer = setTimeout(() => {
				fail("timeout", `Child was inactive for ${limits.wallTimeMs} ms`);
			}, limits.wallTimeMs);
			inactivityTimer.unref();
		};
		resetInactivityTimer();
		absoluteTimer = setTimeout(() => {
			fail("timeout", `Child exceeded absolute attempt limit (${limits.absoluteWallTimeMs} ms)`);
		}, limits.absoluteWallTimeMs);
		absoluteTimer.unref();

		const checkUsageBudget = (candidate: Usage) => {
			if (candidate.totalTokens > budget.maxTokens) {
				fail("budget_exhausted", `Child exceeded token limit (${budget.maxTokens})`);
			}
		};

		const reportedUsage = () => combinedUsage(usage, streamingUsage);

		const processLine = (line: string) => {
			if (failure || line.trim().length === 0) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				fail("protocol_error", `Malformed child JSON: ${message}`);
				return;
			}
			if (!isRecord(event) || typeof event.type !== "string") {
				fail("protocol_error", "Child JSON event must be an object with a string type");
				return;
			}
			resetInactivityTimer();

			if (event.type === "message_update") {
				const nextUsage = parseUsage(event.usage);
				if (!nextUsage) {
					fail("protocol_error", "message_update has invalid usage");
					return;
				}
				streamingUsage = nextUsage;
				checkUsageBudget(reportedUsage());
				return;
			}

			if (event.type === "tool_execution_start") {
				if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") {
					fail("protocol_error", "Malformed tool_execution_start event");
					return;
				}
				if (activeTools.has(event.toolCallId)) {
					fail("protocol_error", `Duplicate tool execution start: ${event.toolCallId}`);
					return;
				}
				activeTools.set(event.toolCallId, event.toolName);
				// Loop guard: compact Pi events carry a stable hash so large write/read
				// arguments never enter the observer stream. Pi's full JSON event shape
				// carries args directly, so hash that representation when present.
				let argsSignature: string;
				if (event.argsHash !== undefined) {
					if (typeof event.argsHash !== "string" || !/^[a-f0-9]{64}$/.test(event.argsHash)) {
						fail("protocol_error", "tool_execution_start has invalid argsHash");
						return;
					}
					argsSignature = event.argsHash;
				} else {
					argsSignature = JSON.stringify(event.args ?? null);
				}
				const signature = `${event.toolName}:${argsSignature}`;
				loopStreak = signature === lastToolSignature ? loopStreak + 1 : 1;
				lastToolSignature = signature;
				if (loopStreak >= LOOP_DETECTION_STREAK) {
					fail(
						"loop_detected",
						`Child repeated the same tool call ${loopStreak} times consecutively: ${event.toolName}`,
					);
				}
				return;
			}

			if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
				if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") {
					fail("protocol_error", `Malformed ${event.type} event`);
					return;
				}
				const activeName = activeTools.get(event.toolCallId);
				if (activeName !== event.toolName) {
					fail("protocol_error", `Unmatched ${event.type} event: ${event.toolCallId}`);
					return;
				}
				if (event.type === "tool_execution_end") {
					if (typeof event.isError !== "boolean") {
						fail("protocol_error", "Malformed tool_execution_end event");
						return;
					}
					activeTools.delete(event.toolCallId);
				}
				return;
			}

			if (event.type !== "message_end") return;
			if (!isRecord(event.message) || typeof event.message.role !== "string") {
				fail("protocol_error", "Malformed message_end event");
				return;
			}
			if (event.message.role === "toolResult") {
				if (typeof event.message.toolName !== "string") {
					fail("protocol_error", "Malformed tool result message_end event");
					return;
				}
				return;
			}
			if (event.message.role !== "assistant") return;

			const nextUsage = parseUsage(event.message.usage);
			const text = assistantText(event.message);
			if (
				!nextUsage ||
				text === undefined ||
				typeof event.message.model !== "string" ||
				typeof event.message.stopReason !== "string"
			) {
				fail("protocol_error", "Assistant message_end has invalid content, model, stop reason, or usage");
				return;
			}
			addUsage(usage, nextUsage);
			streamingUsage = zeroUsage();
			turns++;
			finalDiagnostic = text.slice(0, 2_000);
			model = event.message.model;

			checkUsageBudget(usage);
			if (failure) return;
			if (
				event.message.stopReason === "error" ||
				event.message.stopReason === "aborted" ||
				event.message.stopReason === "length" ||
				event.message.stopReason === "deferred"
			) {
				const detail = modelErrorDetail(event.message.errorMessage);
				fail("model_error", `Child model stopped with ${event.message.stopReason}${detail}`);
			}
		};

		const consumeText = (text: string) => {
			lineBuffer += text;
			let newline = lineBuffer.indexOf("\n");
			while (newline !== -1 && !failure) {
				const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
				lineBuffer = lineBuffer.slice(newline + 1);
				processLine(line);
				newline = lineBuffer.indexOf("\n");
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			if (failure) return;
			outputBytes += chunk.byteLength;
			if (outputBytes > limits.maxOutputBytes) {
				fail("transport_limit", `Child exceeded cumulative stdout limit (${limits.maxOutputBytes} bytes)`);
				return;
			}
			consumeText(decoder.write(chunk));
		});

		child.stderr.on("data", (chunk: Buffer) => {
			if (failure) return;
			stderrBytes += chunk.byteLength;
			if (stderrBytes > limits.maxStderrBytes) {
				fail("transport_limit", `Child exceeded stderr limit (${limits.maxStderrBytes} bytes)`);
				return;
			}
			stderr += chunk.toString("utf8");
		});

		child.on("error", (error) => {
			fail("process_error", `Failed to start child Pi: ${error.message}`);
		});
		child.on("exit", () => {
			// A child may exit while descendants retain its stdout/stderr. Bound that drain.
			if (!closed) terminate();
		});

		const onAbort = () => fail("cancelled", "Child task cancelled by parent");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();

		child.on("close", async (code, signal) => {
			closed = true;
			if (inactivityTimer) clearTimeout(inactivityTimer);
			if (absoluteTimer) clearTimeout(absoluteTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", onAbort);

			if (!failure) {
				consumeText(decoder.end());
				if (!failure && lineBuffer.trim().length > 0) processLine(lineBuffer.replace(/\r$/, ""));
			}
			if (!failure && activeTools.size > 0) {
				failure = { reason: "protocol_error", error: "Child exited with unfinished tool executions" };
			}
			if (!failure && (code !== 0 || signal !== null)) {
				const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
				failure = {
					reason: "process_error",
					error: `Child Pi exited unsuccessfully (code ${code ?? "null"}, signal ${signal ?? "none"})${detail}`,
				};
			}
			if (failure) {
				const partialHandoff =
					failure.reason === "budget_exhausted" ? await recoverBudgetPartialHandoff(handoffPath, task) : undefined;
				resolve({
					...failedResult(task, failure.reason, failure.error, reportedUsage(), turns, model),
					...(partialHandoff ? { partialHandoff } : {}),
				});
				return;
			}

			try {
				const handoff = await readProtocolV2Handoff(handoffPath, task);
				resolve({
					taskId: task.id,
					role: task.role,
					success: true,
					terminalReason: "completed",
					handoff,
					usage,
					turns,
					...(model ? { model } : {}),
				});
			} catch (error) {
				const diagnostic = finalDiagnostic ? `; final assistant diagnostic: ${finalDiagnostic}` : "";
				const message = `${error instanceof Error ? error.message : String(error)}${diagnostic}`;
				resolve(failedResult(task, "invalid_handoff", message, usage, turns, model));
			}
		});
	});
}

function runtimeModel(state: ChildAgentRuntimeState): { provider?: string; model?: string } {
	if (!isRecord(state.model)) return {};
	return {
		...(typeof state.model.provider === "string" ? { provider: state.model.provider } : {}),
		...(typeof state.model.id === "string" ? { model: state.model.id } : {}),
	};
}

function runtimeMetadata(
	runtime: ChildAgentRuntime,
	state: ChildAgentRuntimeState,
	isolationLevel: "tool-bounded" | "sandboxed",
	selection: ChildModelSelection | undefined,
	activity: string,
	nextAction: string,
	runtimeRoot: string,
	runtimeRootId: string,
): ChildRuntimeMetadata {
	const selected = runtimeModel(state);
	return {
		provider: selected.provider ?? selection?.provider,
		model: selected.model ?? selection?.model,
		...(selection?.thinkingLevel
			? { thinkingLevel: selection.thinkingLevel }
			: state.thinkingLevel
				? { thinkingLevel: state.thinkingLevel as ChildModelSelection["thinkingLevel"] }
				: {}),
		isolationLevel,
		...runtime.metadata,
		runtimeRoot,
		runtimeRootId,
		isStreaming: state.isStreaming,
		pendingMessageCount: state.pendingMessageCount,
		activity,
		nextAction,
	};
}

function runtimeEventActivity(payload: Readonly<Record<string, unknown>>): { activity: string; nextAction: string } {
	const type = typeof payload.type === "string" ? payload.type : "activity";
	if (type === "tool_execution_start") {
		return {
			activity: typeof payload.toolName === "string" ? `using ${payload.toolName}` : "using a tool",
			nextAction: "wait",
		};
	}
	if (type === "tool_execution_end") return { activity: "processing tool result", nextAction: "wait" };
	if (type === "message_update" || type === "message_start" || type === "agent_start") {
		return { activity: "thinking", nextAction: "wait" };
	}
	if (type === "message_end") return { activity: "completed a turn", nextAction: "wait" };
	if (type === "agent_end" || type === "agent_settled") return { activity: "finishing", nextAction: "wait" };
	return { activity: type, nextAction: "wait" };
}

async function readProtocolV2Handoff(handoffPath: string, task: ReadOnlyTaskContract | DagTaskContract) {
	let text: string;
	try {
		text = await readFile(handoffPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error("Child did not call submit_handoff");
		throw error;
	}
	return decodeHandoffEnvelope(text, task.id, task.role);
}

async function recoverBudgetPartialHandoff(handoffPath: string, task: ReadOnlyTaskContract | DagTaskContract) {
	try {
		return asInconclusivePartialHandoff(await readProtocolV2Handoff(handoffPath, task));
	} catch {
		// A missing or schema-invalid handoff must not be promoted into partial progress.
		return undefined;
	}
}

function rpcFailure(error: unknown): Failure {
	if (error instanceof PiRpcRuntimeError) {
		const reason: TaskTerminalReason =
			error.code === "timeout"
				? "timeout"
				: error.code === "transport_limit"
					? "transport_limit"
					: error.code === "protocol_error" || error.code === "command_error"
						? "protocol_error"
						: "process_error";
		return { reason, error: error.message };
	}
	return { reason: "process_error", error: error instanceof Error ? error.message : String(error) };
}

async function runRpcProcess(
	options: RunChildTaskOptions,
	contextPath: string,
	childContext: ChildHarnessContext,
	handoffPath: string,
	sessionDirectory: string,
	runtimeRoot: string,
	runtimeRootId: string,
): Promise<ChildTaskResult> {
	const { task, budget } = options;
	const limits = { ...SUBAGENT_INFRA_LIMITS, ...options.limits };
	const usage = zeroUsage();
	let streamingUsage = zeroUsage();
	let turns = 0;
	let model: string | undefined;
	let finalDiagnostic = "";
	let failure: Failure | undefined;
	let lastToolSignature = "";
	let loopStreak = 0;
	let softBudgetSteered = false;
	let consecutiveUnlimitedRetries = 0;
	let providerCircuitOpen: ProviderCircuitOpenSignal | undefined;
	let liveActivity = createLiveActivity();
	const activeTools = new Map<string, string>();
	const timedTools = new Map<string, { startedAt: number; handoff: boolean }>();
	const rpcStartedAt = performance.now();
	let childStartMs = 0;
	let promptStartedAt: number | undefined;
	let firstModelEventMs: number | undefined;
	let modelStartedAt: number | undefined;
	let modelExecutionMs = 0;
	let toolExecutionMs = 0;
	let handoffMs = 0;
	const finishModelTiming = (finishedAt: number): void => {
		if (modelStartedAt === undefined) return;
		modelExecutionMs += Math.max(0, finishedAt - modelStartedAt);
		modelStartedAt = undefined;
	};
	const performanceSnapshot = () => ({
		childStartMs,
		...(firstModelEventMs === undefined ? {} : { firstModelEventMs }),
		modelExecutionMs,
		toolExecutionMs,
		handoffMs,
	});
	const childArgs = [...childModelArgs(options.childModel)];
	const rawInvocation = options.invocation
		? { command: options.invocation.command, args: [...(options.invocation.args ?? [])] }
		: resolvePiInvocation([]);
	const invocation = wrapChildInvocation(rawInvocation, options.sandboxLauncher);
	const environment = childRuntimeEnvironment(options, contextPath, childContext, {
		EASY_PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
	});
	const generation = (options.resumeRuntime?.runtimeGeneration ?? 0) + 1;
	let runtime: PiRpcChildRuntime | undefined;
	let state: ChildAgentRuntimeState | undefined;
	let metadata: ChildRuntimeMetadata | undefined;
	const liveActivityScheduler = new LiveActivityUpdateScheduler(() => {
		if (!runtime) return;
		try {
			options.onLiveActivity?.(runtime, snapshotLiveActivity(liveActivity));
		} catch {
			// Presentation observers cannot be allowed to crash or corrupt the child transport.
		}
	});
	const setFailure = (reason: TaskTerminalReason, error: string): void => {
		if (failure) return;
		failure = { reason, error };
		// Streaming failures can arrive immediately after the prompt response. Abort
		// here so a concurrent waitForSettled cannot deadlock waiting for a Child
		// that expects the Controller to terminate it.
		void runtime?.abort().catch(() => undefined);
	};
	let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
	const absoluteDeadline = new Promise<never>((_resolve, reject) => {
		absoluteTimer = setTimeout(() => {
			const message = `Child exceeded absolute attempt limit (${limits.absoluteWallTimeMs} ms)`;
			setFailure("timeout", message);
			reject(new PiRpcRuntimeError("timeout", message));
		}, limits.absoluteWallTimeMs);
		absoluteTimer.unref();
	});
	void absoluteDeadline.catch(() => undefined);
	const observeUsage = (reported: Usage): void => {
		if (
			options.softTokenLimit !== undefined &&
			!softBudgetSteered &&
			reported.totalTokens >= options.softTokenLimit
		) {
			softBudgetSteered = true;
			void runtime?.steer(SOFT_BUDGET_WRAP_UP_MESSAGE).catch(() => undefined);
		}
		if (reported.totalTokens > budget.maxTokens) {
			setFailure("budget_exhausted", `Child exceeded token limit (${budget.maxTokens})`);
		}
	};
	const processEvent = (event: ChildAgentRuntimeEvent): void => {
		const payload = event.payload;
		const observedAt = performance.now();
		const modelEvent =
			payload.type === "message_start" ||
			payload.type === "message_update" ||
			payload.type === "message_end" ||
			payload.type === "auto_retry_start" ||
			payload.type === "auto_retry_end";
		if (modelEvent && firstModelEventMs === undefined && promptStartedAt !== undefined) {
			firstModelEventMs = Math.max(0, observedAt - promptStartedAt);
		}
		if (payload.type === "message_start" || payload.type === "message_update") {
			modelStartedAt ??= promptStartedAt ?? observedAt;
		} else if (payload.type === "auto_retry_start") {
			finishModelTiming(observedAt);
		} else if (payload.type === "tool_execution_start") {
			finishModelTiming(observedAt);
			if (typeof payload.toolCallId === "string" && typeof payload.toolName === "string") {
				timedTools.set(payload.toolCallId, {
					startedAt: observedAt,
					handoff: payload.toolName === "submit_handoff",
				});
			}
		} else if (payload.type === "tool_execution_end" && typeof payload.toolCallId === "string") {
			const timing = timedTools.get(payload.toolCallId);
			if (timing) {
				const duration = Math.max(0, observedAt - timing.startedAt);
				if (timing.handoff) handoffMs += duration;
				else toolExecutionMs += duration;
				timedTools.delete(payload.toolCallId);
			}
			modelStartedAt = observedAt;
		} else if (payload.type === "message_end" || payload.type === "agent_settled") {
			finishModelTiming(observedAt);
		}
		const nextLiveActivity = reduceLiveActivity(liveActivity, payload);
		if (nextLiveActivity !== liveActivity) {
			liveActivity = nextLiveActivity;
			liveActivityScheduler.schedule();
			const assistantEvent = isRecord(payload.assistantMessageEvent) ? payload.assistantMessageEvent : undefined;
			if (
				payload.type === "message_start" ||
				payload.type === "message_end" ||
				payload.type === "tool_execution_start" ||
				payload.type === "tool_execution_end" ||
				assistantEvent?.type === "toolcall_end"
			) {
				liveActivityScheduler.flush();
			}
		}
		if (payload.type === "auto_retry_start") {
			if (payload.unlimited !== true) {
				consecutiveUnlimitedRetries = 0;
			} else if (
				!Number.isSafeInteger(payload.attempt) ||
				Number(payload.attempt) < 1 ||
				!Number.isSafeInteger(payload.delayMs) ||
				Number(payload.delayMs) < 0
			) {
				setFailure("protocol_error", "Structured unlimited auto-retry event is malformed");
			} else {
				consecutiveUnlimitedRetries++;
				const reportedUsage = combinedUsage(usage, streamingUsage);
				if (
					reportedUsage.totalTokens > 0 ||
					turns > 0 ||
					consecutiveUnlimitedRetries >= PROVIDER_CIRCUIT_ZERO_PROGRESS_RETRY_LIMIT
				) {
					providerCircuitOpen = {
						version: PROVIDER_CIRCUIT_VERSION,
						reason: "unlimited_auto_retry",
						autoRetryAttempt: Number(payload.attempt),
						consecutiveUnlimitedRetries,
						retryDelayMs: Number(payload.delayMs),
					};
					setFailure(
						"provider_circuit_open",
						"Provider circuit opened after structured unlimited auto-retry signals",
					);
				}
			}
		} else if (payload.type === "auto_retry_end" && payload.success === true) {
			consecutiveUnlimitedRetries = 0;
		} else if (payload.type === "message_update") {
			const next = parseUsage(payload.usage);
			if (!next) setFailure("protocol_error", "message_update has invalid usage");
			else {
				streamingUsage = next;
				observeUsage(combinedUsage(usage, streamingUsage));
			}
		} else if (payload.type === "tool_execution_start") {
			if (typeof payload.toolCallId !== "string" || typeof payload.toolName !== "string") {
				setFailure("protocol_error", "Malformed tool_execution_start event");
			} else if (activeTools.has(payload.toolCallId)) {
				setFailure("protocol_error", `Duplicate tool execution start: ${payload.toolCallId}`);
			} else {
				activeTools.set(payload.toolCallId, payload.toolName);
				const argsSignature =
					typeof payload.argsHash === "string" ? payload.argsHash : JSON.stringify(payload.args ?? null);
				const signature = `${payload.toolName}:${argsSignature}`;
				loopStreak = signature === lastToolSignature ? loopStreak + 1 : 1;
				lastToolSignature = signature;
				if (loopStreak >= LOOP_DETECTION_STREAK) {
					setFailure(
						"loop_detected",
						`Child repeated the same tool call ${loopStreak} times: ${payload.toolName}`,
					);
				}
			}
		} else if (payload.type === "tool_execution_end") {
			if (typeof payload.toolCallId !== "string" || typeof payload.toolName !== "string") {
				setFailure("protocol_error", "Malformed tool_execution_end event");
			} else if (activeTools.get(payload.toolCallId) !== payload.toolName) {
				setFailure("protocol_error", `Unmatched tool_execution_end event: ${payload.toolCallId}`);
			} else activeTools.delete(payload.toolCallId);
		} else if (payload.type === "message_end" && isRecord(payload.message) && payload.message.role === "assistant") {
			const next = parseUsage(payload.message.usage);
			const text = assistantText(payload.message);
			if (!next || text === undefined || typeof payload.message.stopReason !== "string") {
				setFailure("protocol_error", "Assistant message_end has invalid content, stop reason, or usage");
			} else {
				addUsage(usage, next);
				streamingUsage = zeroUsage();
				turns++;
				finalDiagnostic = text.slice(0, 2_000);
				if (typeof payload.message.model === "string") model = payload.message.model;
				observeUsage(usage);
				if (payload.message.stopReason === "aborted") {
					setFailure("interrupted", "Child generation was interrupted");
				} else if (["error", "length", "deferred"].includes(payload.message.stopReason)) {
					const detail = modelErrorDetail(payload.message.errorMessage);
					setFailure("model_error", `Child model stopped with ${payload.message.stopReason}${detail}`);
				}
			}
		}
		if (runtime && state) {
			const presentation = runtimeEventActivity(payload);
			metadata = runtimeMetadata(
				runtime,
				state,
				invocation.isolationLevel,
				options.childModel,
				presentation.activity,
				presentation.nextAction,
				runtimeRoot,
				runtimeRootId,
			);
			try {
				options.onRuntimeEvent?.(runtime, event, metadata);
			} catch {
				// Controller observers cannot be allowed to crash or corrupt the child transport.
			}
		}
	};

	try {
		const runtimeOptions = {
			invocation: { command: invocation.command, prefixArgs: invocation.args },
			piArgs: childArgs,
			cwd: options.snapshotPath,
			env: environment,
			runtimeGeneration: generation,
			limits: {
				requestTimeoutMs: Math.min(30_000, limits.wallTimeMs),
				shutdownTimeoutMs: 1_000,
				maxLineBytes: limits.maxOutputBytes,
				maxStdoutBytes: limits.maxOutputBytes,
				maxStderrBytes: limits.maxStderrBytes,
			},
		};
		runtime = options.resumeRuntime?.sessionFile
			? await PiRpcChildRuntime.connect({ ...runtimeOptions, sessionFile: options.resumeRuntime.sessionFile })
			: await PiRpcChildRuntime.spawn({ ...runtimeOptions, sessionDir: sessionDirectory });
		state = await runtime.getState();
		childStartMs = Math.max(0, performance.now() - rpcStartedAt);
		metadata = runtimeMetadata(
			runtime,
			state,
			invocation.isolationLevel,
			options.childModel,
			"ready",
			"prompt",
			runtimeRoot,
			runtimeRootId,
		);
		options.onRuntimeReady?.(runtime, metadata);
		const unsubscribe = runtime.onEvent(processEvent);
		const afterSeq = runtime.metadata.lastEventSeq;
		const settled = runtime.waitForSettled({
			afterSeq,
			timeoutMs: limits.wallTimeMs,
			signal: options.signal,
		});
		// The prompt request can fail before this waiter is awaited (for example, a
		// child crash). Attach a rejection observer immediately so a later waiter
		// timeout/close can never surface as an unhandled rejection in the parent.
		void settled.catch(() => undefined);
		const onAbort = (): void => {
			setFailure("cancelled", "Child task cancelled by parent");
			void runtime?.abort().catch(() => undefined);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		try {
			promptStartedAt = performance.now();
			if (!failure) await Promise.race([runtime.prompt(taskPrompt(options)), absoluteDeadline]);
			if (!failure || failure.reason === "cancelled") await Promise.race([settled, absoluteDeadline]);
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			unsubscribe();
		}
		if (failure) await runtime.abort().catch(() => undefined);
		state = await runtime.getState().catch(() => state!);
		metadata = runtimeMetadata(
			runtime,
			state,
			invocation.isolationLevel,
			options.childModel,
			"settled",
			"consume handoff",
			runtimeRoot,
			runtimeRootId,
		);
		if (failure) {
			const partialHandoff =
				failure.reason === "budget_exhausted" ? await recoverBudgetPartialHandoff(handoffPath, task) : undefined;
			return {
				...failedResult(task, failure.reason, failure.error, combinedUsage(usage, streamingUsage), turns, model),
				...(partialHandoff ? { partialHandoff } : {}),
				...(providerCircuitOpen ? { providerCircuitOpen } : {}),
				runtime: metadata,
				performance: performanceSnapshot(),
			};
		}
		if (activeTools.size > 0) {
			return {
				...failedResult(
					task,
					"protocol_error",
					"Child settled with unfinished tool executions",
					usage,
					turns,
					model,
				),
				runtime: metadata,
				performance: performanceSnapshot(),
			};
		}
		try {
			const handoff = await readProtocolV2Handoff(handoffPath, task);
			return {
				taskId: task.id,
				role: task.role,
				success: true,
				terminalReason: "completed",
				handoff,
				usage,
				turns,
				...(model ? { model } : {}),
				isolationLevel: invocation.isolationLevel,
				runtime: { ...metadata, activity: "completed", nextAction: "none" },
				performance: performanceSnapshot(),
			};
		} catch (error) {
			const diagnostic = finalDiagnostic ? `; final assistant diagnostic: ${finalDiagnostic}` : "";
			return {
				...failedResult(
					task,
					"invalid_handoff",
					`${error instanceof Error ? error.message : String(error)}${diagnostic}`,
					usage,
					turns,
					model,
				),
				runtime: metadata,
				performance: performanceSnapshot(),
			};
		}
	} catch (error) {
		const normalized = failure ?? rpcFailure(error);
		return {
			...failedResult(task, normalized.reason, normalized.error, combinedUsage(usage, streamingUsage), turns, model),
			...(providerCircuitOpen ? { providerCircuitOpen } : {}),
			...(metadata ? { runtime: metadata } : {}),
			performance: performanceSnapshot(),
		};
	} finally {
		if (absoluteTimer) clearTimeout(absoluteTimer);
		liveActivityScheduler.dispose(true);
		if (runtime) {
			await runtime.shutdown().catch(() => undefined);
			if (metadata) options.onRuntimeClosed?.(runtime, metadata);
		}
	}
}

export async function runChildTask(options: RunChildTaskOptions): Promise<ChildTaskResult> {
	if (
		options.softTokenLimit !== undefined &&
		(!Number.isSafeInteger(options.softTokenLimit) ||
			options.softTokenLimit < 1 ||
			options.softTokenLimit > options.budget.maxTokens)
	) {
		return failedResult(options.task, "process_error", "Child soft token limit must be within the attempt budget");
	}
	if (options.signal?.aborted) {
		return failedResult(options.task, "cancelled", "Child task cancelled by parent");
	}
	if (!options.snapshotPath) {
		return failedResult(options.task, "process_error", "A snapshot path is required");
	}

	const externalWriter = isExternalWriterTask(options.task);
	if (externalWriter !== Boolean(options.externalMutationJournal)) {
		return failedResult(
			options.task,
			"process_error",
			externalWriter
				? "External writer requires a Controller mutation journal"
				: "Mutation journals are restricted to external-writer tasks",
		);
	}
	if (options.externalMutationJournal) {
		const identity = options.externalMutationJournal.policy;
		if (identity.taskId !== options.task.id) {
			return failedResult(options.task, "process_error", "External mutation journal task identity mismatch");
		}
	}
	if (!options.createChildHarnessContext) {
		return failedResult(
			options.task,
			"process_error",
			"Subagent Child execution requires a WJ-owned Child Harness context provider",
		);
	}

	let root: string;
	try {
		root = await realpath(options.snapshotPath);
	} catch (error) {
		return failedResult(
			options.task,
			"process_error",
			`Child snapshot resolution failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const transport = options.transport ?? "rpc";
	let runtimeDirectory: ManagedChildRuntimeDirectory | undefined;
	let result: ChildTaskResult;
	let journalFailure: unknown;
	let journalPollTimer: ReturnType<typeof setInterval> | undefined;
	let journalReader: ExternalMutationJournalReader | undefined;
	const drainJournal = (): void => {
		if (!journalReader || journalFailure) return;
		try {
			journalReader.drain(options.externalMutationJournal!.onEvent);
		} catch (error) {
			journalFailure = error;
		}
	};
	try {
		journalReader = options.externalMutationJournal
			? new ExternalMutationJournalReader(options.externalMutationJournal.policy)
			: undefined;
		drainJournal();
		if (journalReader) {
			journalPollTimer = setInterval(drainJournal, 25);
			journalPollTimer.unref();
		}
		runtimeDirectory = await childRuntimeDirectory(options.resumeRuntime);
		const contextPath = join(runtimeDirectory.rootDirectory, "child-harness-context.json");
		const handoffPath = join(runtimeDirectory.rootDirectory, "handoff-v2.json");
		await Promise.all([rm(contextPath, { force: true }), rm(handoffPath, { force: true })]);
		const normalizedOptions = { ...options, transport };
		const externalOwnedPaths = externalOwnedPathsForChild(options);
		const privateControllerPaths = [
			root,
			runtimeDirectory.rootDirectory,
			...(options.externalMutationJournal ? [options.externalMutationJournal.policy.path] : []),
		];
		if (
			externalOwnedPaths.some((externalRoot) =>
				privateControllerPaths.some((privatePath) => pathsOverlap(externalRoot, privatePath)),
			)
		) {
			throw new Error("External writer paths must not overlap private Child/Controller state");
		}
		const workspaceRoot = canonicalizeProspectivePath(options.workspaceRoot, options.workspaceRoot);
		const childContext = validateChildHarnessContext(
			options.createChildHarnessContext({
				cwd: root,
				protectedRoots: [workspaceRoot],
				inheritedWriteRoots: externalOwnedPaths,
				...(options.externalMutationJournal ? { mutationJournal: options.externalMutationJournal.policy } : {}),
			}),
		);
		if (childContext.cwd !== root) throw new Error("WJ Child Harness context cwd does not match the Child runtime");
		if (!childContext.protectedRoots.includes(workspaceRoot)) {
			throw new Error("WJ Child Harness context does not protect the source workspace");
		}
		if (
			JSON.stringify([...childContext.inheritedWriteRoots].sort()) !== JSON.stringify([...externalOwnedPaths].sort())
		) {
			throw new Error("WJ Child Harness context write roots do not match the Parent-approved task roots");
		}
		if (
			JSON.stringify(childContext.mutationJournal ?? null) !==
			JSON.stringify(options.externalMutationJournal?.policy ?? null)
		) {
			throw new Error("WJ Child Harness context mutation journal does not match the Controller journal");
		}
		const policy = {
			...childContext,
			handoff: {
				protocolVersion: 2,
				path: handoffPath,
				taskId: options.task.id,
				role: options.task.role,
			},
		};
		await writeFile(contextPath, JSON.stringify(policy), { encoding: "utf8", mode: 0o600, flag: "wx" });
		await chmod(contextPath, 0o600);
		if (options.signal?.aborted) {
			result = failedResult(options.task, "cancelled", "Child task cancelled by parent");
		} else if (transport === "rpc") {
			result = await runRpcProcess(
				normalizedOptions,
				contextPath,
				childContext,
				handoffPath,
				runtimeDirectory.sessionDirectory,
				runtimeDirectory.rootDirectory,
				runtimeDirectory.runtimeRootId,
			);
		} else {
			result = await runProcess(normalizedOptions, contextPath, childContext, handoffPath);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = failedResult(options.task, "process_error", `Child runner failed: ${message}`);
	} finally {
		if (journalPollTimer) clearInterval(journalPollTimer);
		drainJournal();
	}
	if (journalFailure) {
		const message = journalFailure instanceof Error ? journalFailure.message : String(journalFailure);
		result = failedResult(
			options.task,
			"process_error",
			`External mutation journal could not be durably consumed: ${message}`,
			result.usage,
			result.turns,
			result.model,
		);
	}

	const preserveForResume =
		(result.terminalReason === "cancelled" ||
			result.terminalReason === "interrupted" ||
			result.terminalReason === "provider_circuit_open") &&
		result.runtime?.sessionFile !== undefined;
	if (runtimeDirectory && !preserveForResume) {
		try {
			await runtimeDirectory.cleanup();
		} catch (error) {
			if (result.success) {
				const message = error instanceof Error ? error.message : String(error);
				return failedResult(
					options.task,
					"process_error",
					`Failed to remove child runtime directory: ${message}`,
					result.usage,
					result.turns,
					result.model,
				);
			}
		}
	}
	return {
		...result,
		isolationLevel: options.sandboxLauncher ? "sandboxed" : "tool-bounded",
		...(result.runtime && !preserveForResume
			? { runtime: { ...result.runtime, sessionFile: undefined, runtimeRoot: undefined, runtimeRootId: undefined } }
			: {}),
	};
}
