import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	captureExternalMutationPostState,
	createExternalMutationJournal,
	ExternalMutationJournalWriter,
} from "@easy-pi/permissions/journal";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildAgentRuntime } from "../src/child-agent-runtime.ts";
import { compileSubagentDagRequest, DEFAULT_SUBAGENT_POLICY } from "../src/contracts.ts";
import {
	type DagOrchestratorDependencies,
	DagRunInterruptedError,
	SubagentDagOrchestrator,
	SubagentDagRunError,
} from "../src/dag-orchestrator.ts";
import { cleanupConfirmedRun } from "../src/delivery-cleanup.ts";
import { RunLedger } from "../src/ledger.ts";
import { MergeConflictError } from "../src/merge-coordinator.ts";
import { ValidationRegistry, validateAndCommitWriterTask } from "../src/quality.ts";
import type {
	ChildTaskResult,
	DagTaskContract,
	ExternalWriterHandoff,
	HandoffEvidence,
	ReadOnlyTaskContract,
	SubagentHandoff,
	SubagentPolicy,
	WriterHandoff,
} from "../src/types.ts";
import { SUBAGENT_INFRA_LIMITS } from "../src/types.ts";
import { pinRunBaseline, pinTaskCommit, reconcileTaskWorktrees } from "../src/worktree.ts";

const temporaryPaths: string[] = [];

function git(cwd: string, ...args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "utf8", shell: false }, (error, stdout, stderr) => {
			if (error) return reject(new Error(String(stderr).trim() || error.message));
			resolve(String(stdout).trim());
		});
	});
}

async function repository(): Promise<{ root: string; head: string; branch: string }> {
	const root = await mkdtemp(join(tmpdir(), "subagent-dag-orchestrator-"));
	temporaryPaths.push(root);
	await git(root, "init", "-q", "-b", "user-main");
	await git(root, "config", "user.name", "DAG Test");
	await git(root, "config", "user.email", "dag@example.test");
	await writeFile(join(root, "base.txt"), "base\n");
	await git(root, "add", "base.txt");
	await git(root, "commit", "-q", "-m", "base");
	return { root, head: await git(root, "rev-parse", "HEAD"), branch: await git(root, "symbolic-ref", "HEAD") };
}

function usage(tokens = 2, cost = 0.02): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function success(
	task: DagTaskContract | ReadOnlyTaskContract,
	changedPaths: string[] = [],
	evidence: HandoffEvidence[] = [],
): ChildTaskResult {
	const common = {
		taskId: task.id,
		summary: `completed ${task.id}`,
		outcome: "accepted" as const,
		evidence,
		verification: [],
		assumptions: [],
		risks: [],
		nextActions: [],
		verificationLevel: "unverified" as const,
	};
	const handoff: SubagentHandoff | WriterHandoff | ExternalWriterHandoff =
		task.role === "writer"
			? { ...common, artifactVersion: 2, changedPaths }
			: task.role === "external-writer"
				? { ...common, artifactVersion: 2, externalChangedPaths: changedPaths }
				: common;
	return {
		taskId: task.id,
		role: task.role,
		success: true,
		terminalReason: "completed",
		handoff,
		usage: usage(),
		turns: 1,
		model: "fake/model",
	};
}

function policy(overrides: Partial<SubagentPolicy> = {}): SubagentPolicy {
	return { ...DEFAULT_SUBAGENT_POLICY, maxConcurrency: 1, leaseDurationMs: 30_000, ...overrides };
}

function request(
	tasks: Array<
		| { id: string; role: "analyst" | "reviewer"; objective: string; dependsOn?: string[]; maxAttempts?: number }
		| {
				id: string;
				role: "writer";
				objective: string;
				dependsOn?: string[];
				maxAttempts?: number;
				ownedPaths: string[];
				validationCommandIds?: string[];
		  }
		| {
				id: string;
				role: "external-writer";
				objective: string;
				dependsOn?: string[];
				maxAttempts?: 1;
				externalOwnedPaths: string[];
		  }
	>,
	merge = false,
	selectedPolicy = policy(),
) {
	return compileSubagentDagRequest(
		{
			operation: "start",
			objective: "run a durable DAG",
			tasks,
			createCandidate: merge,
		},
		selectedPolicy,
	);
}

const CANDIDATE_VALIDATION_ID = "candidate-check";

function candidatePolicy(): SubagentPolicy {
	return policy({ allowedValidationCommandIds: [CANDIDATE_VALIDATION_ID] });
}

function candidateValidationRegistry(): ValidationRegistry {
	return new ValidationRegistry([
		{
			id: CANDIDATE_VALIDATION_ID,
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
			timeoutMs: 2_000,
			maxOutputBytes: 4_096,
		},
	]);
}

function ledgerFile(root: string): string {
	return join(root, "..", `${basename(root)}-ledger.sqlite`);
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function flushUntil(predicate: () => boolean, description: string): Promise<void> {
	for (let turn = 0; turn < 1_000; turn++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function fastReaderWorkspace(fixture: {
	root: string;
	head: string;
	branch: string;
}): Pick<
	DagOrchestratorDependencies,
	"releaseTaskCommitPin" | "reconcileTaskWorktrees" | "createTaskWorktree" | "createSnapshot"
> {
	return {
		releaseTaskCommitPin: async () => {},
		reconcileTaskWorktrees: async () => {},
		createTaskWorktree: async (options) => ({
			repositoryRoot: fixture.root,
			path: fixture.root,
			branch: fixture.branch,
			baselineCommit: options.baselineCommit,
			async cleanup() {},
		}),
		createSnapshot: async (repositoryPath) => ({
			path: repositoryPath,
			baseline: {
				repositoryRoot: fixture.root,
				headCommit: fixture.head,
				snapshotId: "scheduler-test-snapshot",
				fileCount: 1,
				totalBytes: 5,
			},
			async cleanup() {},
		}),
	};
}

describe("SubagentDagOrchestrator", () => {
	it("persists one content-free aggregate performance sample for each child execution", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "performance-sample-dag",
			runTask: async (options) => ({
				...success(options.task),
				performance: {
					childStartMs: 4,
					firstModelEventMs: 7,
					modelExecutionMs: 11,
					toolExecutionMs: 13,
					handoffMs: 2,
				},
			}),
		});

		await orchestrator.start({
			repositoryPath: fixture.root,
			request: request([{ id: "inspect", role: "analyst", objective: "sensitive objective" }]),
		});
		const inspection = ledger.inspectDagRun("performance-sample-dag")!;
		const samples = inspection.events.filter((event) => event.type === "attempt.performance");
		expect(samples).toHaveLength(1);
		expect(samples[0]?.payload).toMatchObject({
			version: 1,
			role: "scout",
			success: true,
			terminalReason: "completed",
			stages: {
				attempt_wall: expect.any(Number),
				workspace_prepare: expect.any(Number),
				worktree_prepare: expect.any(Number),
				snapshot_prepare: expect.any(Number),
				child_start: 4,
				first_model_event: 7,
				model_execution: 11,
				tool_execution: 13,
				handoff: 2,
			},
		});
		expect(inspection.performance.criticalPathMs).toBeGreaterThanOrEqual(0);
		const waits = inspection.events.filter((event) => event.type === "scheduler.wait");
		expect(waits).toHaveLength(1);
		expect(waits[0]?.payload).toMatchObject({
			version: 1,
			capacity: 0,
			reason: "active",
			runnableButIdleMs: 0,
		});
		expect(JSON.stringify([...samples, ...waits])).not.toContain("sensitive objective");
		ledger.close();
	});

	it("reclaims an eligible retry while a slow sibling remains active", async () => {
		const fixture = await repository();
		const initialNow = Date.now();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(initialNow);
		const selectedPolicy = policy({ maxConcurrency: 2, leaseDurationMs: 1_000_000_000 });
		const ledger = new RunLedger(":memory:");
		let releaseSlow!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let slowStarted = false;
		let retryCalls = 0;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createOwnerId: () => "owner-current",
			...fastReaderWorkspace(fixture),
			runTask: async (options) => {
				if (options.task.id === "slow") {
					slowStarted = true;
					await slowGate;
					return success(options.task);
				}
				retryCalls++;
				if (retryCalls === 1) {
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason: "process_error",
						error: "transient",
						usage: usage(),
						turns: 1,
					};
				}
				return success(options.task);
			},
		});
		const compiled = request(
			[
				{ id: "slow", role: "analyst", objective: "slow sibling" },
				{ id: "retry", role: "analyst", objective: "retry independently", maxAttempts: 2 },
			],
			false,
			selectedPolicy,
		);
		ledger.createDagRun({
			runId: "retry-wakeup-dag",
			request: compiled,
			baseline: {
				repositoryRoot: fixture.root,
				headCommit: fixture.head,
				snapshotId: "retry-wakeup-baseline",
				fileCount: 1,
				totalBytes: 5,
			},
		});
		const running = orchestrator.resume({ runId: "retry-wakeup-dag" });
		await flushUntil(
			() => slowStarted && ledger.nextDagRetryAt("retry-wakeup-dag") !== undefined,
			"slow sibling plus persisted retry",
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const retryAt = ledger.nextDagRetryAt("retry-wakeup-dag")!;
		await vi.advanceTimersByTimeAsync(Math.max(0, retryAt - Date.now()));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const retryClaimsBeforeSiblingFinished = ledger
			.listDagEvents("retry-wakeup-dag")
			.filter((event) => event.type === "task.claimed" && event.taskId === "retry").length;

		vi.useRealTimers();
		releaseSlow();
		const details = await running;
		const eligibilityWaits = ledger
			.listDagEvents("retry-wakeup-dag")
			.filter(
				(event) =>
					event.type === "scheduler.wait" && (event.payload as { reason?: string }).reason === "eligibility",
			);
		expect(details.status).toBe("succeeded");
		expect(retryClaimsBeforeSiblingFinished).toBe(2);
		expect(retryCalls).toBe(2);
		expect(eligibilityWaits).toHaveLength(1);
		expect(eligibilityWaits[0]?.payload).toMatchObject({
			capacity: 1,
			nextEligibleAt: retryAt,
			runnableButIdleMs: 0,
		});
		ledger.close();
	}, 20_000);

	it("recovers a foreign task lease while a local sibling remains active", async () => {
		const fixture = await repository();
		const initialNow = Date.now();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(initialNow);
		const selectedPolicy = policy({ maxConcurrency: 2, leaseDurationMs: 1_000_000_000 });
		const compiled = request(
			[
				{ id: "foreign", role: "analyst", objective: "recover expired work", maxAttempts: 2 },
				{ id: "slow", role: "analyst", objective: "slow local sibling" },
			],
			false,
			selectedPolicy,
		);
		const ledger = new RunLedger(":memory:");
		ledger.createDagRun({
			runId: "foreign-lease-wakeup-dag",
			request: compiled,
			baseline: {
				repositoryRoot: fixture.root,
				headCommit: fixture.head,
				snapshotId: "foreign-lease-baseline",
				fileCount: 1,
				totalBytes: 5,
			},
		});
		ledger.setDagRunStatus("foreign-lease-wakeup-dag", "running", initialNow);
		const [foreignClaim] = ledger.claimRunnableTasks(
			"foreign-lease-wakeup-dag",
			"owner-foreign",
			initialNow,
			1_000,
			1,
		);
		expect(foreignClaim.taskId).toBe("foreign");
		let releaseSlow!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let slowStarted = false;
		let foreignRunnerCalls = 0;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createOwnerId: () => "owner-current",
			...fastReaderWorkspace(fixture),
			runTask: async (options) => {
				if (options.task.id === "slow") {
					slowStarted = true;
					await slowGate;
					return success(options.task);
				}
				foreignRunnerCalls++;
				return success(options.task);
			},
		});
		const running = orchestrator.resume({ runId: "foreign-lease-wakeup-dag" });
		await flushUntil(() => slowStarted, "local sibling to start");
		await new Promise<void>((resolve) => setImmediate(resolve));
		await vi.advanceTimersByTimeAsync(Math.max(0, foreignClaim.leaseExpiresAt - Date.now()));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const leaseRequeueBeforeSiblingFinished = ledger
			.listDagEvents("foreign-lease-wakeup-dag")
			.find(
				(event) =>
					event.type === "task.requeued" &&
					event.taskId === "foreign" &&
					(event.payload as { reason?: string }).reason === "lease_expired",
			);

		vi.useRealTimers();
		releaseSlow();
		const details = await running;
		const leaseWaits = ledger
			.listDagEvents("foreign-lease-wakeup-dag")
			.filter(
				(event) => event.type === "scheduler.wait" && (event.payload as { reason?: string }).reason === "lease",
			);
		expect(details.status).toBe("succeeded");
		expect(leaseRequeueBeforeSiblingFinished?.payload).toMatchObject({
			retryNotBefore: expect.any(Number),
		});
		expect(foreignRunnerCalls).toBe(1);
		expect(details.tasks.find((task) => task.taskId === "foreign")?.attempts).toBe(2);
		expect(leaseWaits).toHaveLength(1);
		expect(leaseWaits[0]?.payload).toMatchObject({
			capacity: 0,
			nextEligibleAt: foreignClaim.leaseExpiresAt,
			runnableButIdleMs: 0,
		});
		ledger.close();
	}, 20_000);

	it("uses one scheduler wait sample for a retry when no child is active", async () => {
		const fixture = await repository();
		const initialNow = Date.now();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(initialNow);
		const selectedPolicy = policy({ leaseDurationMs: 1_000_000_000 });
		const compiled = request(
			[{ id: "retry", role: "analyst", objective: "retry after backoff", maxAttempts: 2 }],
			false,
			selectedPolicy,
		);
		const ledger = new RunLedger(":memory:");
		ledger.createDagRun({
			runId: "idle-retry-wakeup-dag",
			request: compiled,
			baseline: {
				repositoryRoot: fixture.root,
				headCommit: fixture.head,
				snapshotId: "idle-retry-baseline",
				fileCount: 1,
				totalBytes: 5,
			},
		});
		let calls = 0;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createOwnerId: () => "owner-current",
			...fastReaderWorkspace(fixture),
			runTask: async (options) => {
				calls++;
				if (calls === 1) {
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason: "process_error",
						error: "transient",
						usage: usage(),
						turns: 1,
					};
				}
				return success(options.task);
			},
		});
		const running = orchestrator.resume({ runId: "idle-retry-wakeup-dag" });
		await flushUntil(
			() => ledger.nextDagRetryAt("idle-retry-wakeup-dag") !== undefined,
			"persisted standalone retry",
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const retryAt = ledger.nextDagRetryAt("idle-retry-wakeup-dag")!;
		await vi.advanceTimersByTimeAsync(Math.max(0, retryAt - Date.now()) + 1);
		await flushUntil(() => calls === 2, "standalone retry claim");
		const details = await running;
		const eligibilityWaits = ledger
			.listDagEvents("idle-retry-wakeup-dag")
			.filter(
				(event) =>
					event.type === "scheduler.wait" && (event.payload as { reason?: string }).reason === "eligibility",
			);
		expect(details.status).toBe("succeeded");
		expect(eligibilityWaits).toHaveLength(1);
		ledger.close();
	}, 20_000);

	it("publishes child runtime activity before the task finishes", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let activityRecorded!: () => void;
		const activityVisible = new Promise<void>((resolve) => {
			activityRecorded = resolve;
		});
		const metadata = {
			provider: "fake",
			model: "fake/model",
			thinkingLevel: "medium" as const,
			isolationLevel: "tool-bounded" as const,
			sessionId: "live-progress-session",
			runtimeGeneration: 1,
			lastEventSeq: 0,
			activity: "starting",
		};
		const childRuntime: ChildAgentRuntime = {
			metadata,
			closed: false,
			async prompt() {},
			async steer() {},
			async followUp() {},
			async abort() {},
			async getState() {
				return {
					...metadata,
					model: { provider: "fake", id: "fake/model" },
					thinkingLevel: "medium",
					isStreaming: true,
					isCompacting: false,
					pendingMessageCount: 0,
				};
			},
			onEvent() {
				return () => {};
			},
			async waitForSettled() {
				return { seq: 1, runtimeGeneration: 1, payload: { type: "agent_settled" } };
			},
			async shutdown() {},
		};
		const observed: string[] = [];
		const observedThinking: string[] = [];
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "live-progress-dag",
			runTask: async (options) => {
				expect(options.workspaceRoot).toBe(await realpath(fixture.root));
				options.onRuntimeReady?.(childRuntime, metadata);
				options.onRuntimeEvent?.(
					childRuntime,
					{ seq: 1, runtimeGeneration: 1, payload: { type: "tool_execution_start", toolName: "read" } },
					{ ...metadata, lastEventSeq: 1, activity: "using read" },
				);
				options.onLiveActivity?.(childRuntime, {
					thinking: "checking the repository",
					text: "",
					tools: [
						{
							toolCallId: "call-1",
							toolName: "read",
							args: '{"path":"README.md"}',
							output: "",
							status: "running",
						},
					],
				});
				activityRecorded();
				await gate;
				return success(options.task);
			},
		});

		const running = orchestrator.start({
			repositoryPath: fixture.root,
			request: request([{ id: "live", role: "analyst", objective: "report progress" }]),
			onProgress: (progress) => {
				const task = progress.details.tasks[0];
				const activity = task?.runtime?.activity;
				if (activity) observed.push(activity);
				if (task?.liveActivity?.thinking) observedThinking.push(task.liveActivity.thinking);
			},
		});
		await activityVisible;
		await new Promise((resolve) => setImmediate(resolve));
		expect(observed).toContain("using read");
		expect(observedThinking).toContain("checking the repository");
		release();
		await running;
		ledger.close();
	});

	it("treats throwing progress observers as non-authoritative", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let observerCalls = 0;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "throwing-progress-dag",
			runTask: async (options) => success(options.task),
		});
		const details = await orchestrator.start({
			repositoryPath: fixture.root,
			request: request([{ id: "inspect", role: "analyst", objective: "inspect" }]),
			onProgress: () => {
				observerCalls++;
				throw new Error("observer failed");
			},
		});
		expect(details.status).toBe("succeeded");
		expect(observerCalls).toBeGreaterThan(0);
		expect(ledger.getDagRun("throwing-progress-dag")?.lease).toBeUndefined();
		ledger.close();
	});

	it("bounds durable runtime events and flushes the final child sequence", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const baseMetadata = {
			provider: "fake",
			model: "fake/model",
			isolationLevel: "tool-bounded" as const,
			sessionId: "runtime-burst",
			runtimeGeneration: 1,
			lastEventSeq: 0,
			activity: "ready",
		};
		const childRuntime: ChildAgentRuntime = {
			metadata: baseMetadata,
			closed: false,
			async prompt() {},
			async steer() {},
			async followUp() {},
			async abort() {},
			async getState() {
				return {
					...baseMetadata,
					model: { provider: "fake", id: "fake/model" },
					thinkingLevel: "medium",
					isStreaming: false,
					isCompacting: false,
					pendingMessageCount: 0,
				};
			},
			onEvent() {
				return () => {};
			},
			async waitForSettled() {
				return { seq: 500, runtimeGeneration: 1, payload: { type: "agent_settled" } };
			},
			async shutdown() {},
		};
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "runtime-burst-dag",
			runTask: async (options) => {
				options.onRuntimeReady?.(childRuntime, baseMetadata);
				for (let sequence = 1; sequence <= 500; sequence++) {
					options.onRuntimeEvent?.(
						childRuntime,
						{ seq: sequence, runtimeGeneration: 1, payload: { type: "message_update" } },
						{ ...baseMetadata, lastEventSeq: sequence, activity: `event-${sequence}` },
					);
				}
				options.onRuntimeClosed?.(childRuntime, {
					...baseMetadata,
					lastEventSeq: 500,
					activity: "closed",
				});
				return success(options.task);
			},
		});

		const details = await orchestrator.start({
			repositoryPath: fixture.root,
			request: request([{ id: "inspect", role: "analyst", objective: "inspect" }]),
		});
		expect(details.tasks[0]?.runtime).toMatchObject({ lastEventSeq: 500, activity: "closed" });
		const runtimeEvents = ledger
			.listDagEvents("runtime-burst-dag")
			.filter((event) => event.type === "attempt.runtime");
		expect(runtimeEvents.length).toBeGreaterThan(1);
		expect(runtimeEvents.length).toBeLessThanOrEqual(10);
		ledger.close();
	});

	it("records an external-writer live side effect without a commit or candidate", async () => {
		const fixture = await repository();
		const externalRoot = await mkdtemp(join(tmpdir(), "subagent-external-output-"));
		temporaryPaths.push(externalRoot);
		const canonicalExternalRoot = await realpath(externalRoot);
		const changedPath = join(canonicalExternalRoot, "published.txt");
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "external-writer-dag",
			runTask: async (options) => {
				const journal = options.externalMutationJournal;
				expect(journal?.policy).toMatchObject({
					runId: "external-writer-dag",
					taskId: "publish",
					attemptNumber: 1,
				});
				const mutation = {
					mutationId: `${journal!.policy.attemptId}:1`,
					runId: journal!.policy.runId,
					taskId: journal!.policy.taskId,
					attemptId: journal!.policy.attemptId,
					attemptNumber: journal!.policy.attemptNumber,
					authorizationSequence: 1,
					toolCallId: "write-1",
					operation: "write" as const,
					path: changedPath,
					authorizationStatus: "authorized" as const,
					authorizedAt: Date.now(),
				};
				journal!.onEvent({ journalVersion: 1, journalSequence: 1, type: "authorized", mutation });
				await writeFile(changedPath, "published\n");
				journal!.onEvent({
					journalVersion: 1,
					journalSequence: 2,
					type: "observed",
					mutationId: mutation.mutationId,
					toolResult: "succeeded",
					observedAt: Date.now(),
					postState: await captureExternalMutationPostState(changedPath),
				});
				return success(options.task, [changedPath]);
			},
		});
		const details = await orchestrator.start({
			repositoryPath: fixture.root,
			request: request([
				{
					id: "publish",
					role: "external-writer",
					objective: "Publish",
					externalOwnedPaths: [externalRoot],
				},
			]),
		});
		expect(details.status).toBe("succeeded");
		expect(details.tasks[0]?.attempts).toBe(1);
		expect(details.tasks[0]?.artifact).toMatchObject({
			changedPaths: [],
			externalChangedPaths: [changedPath],
			externalMutations: [
				{
					operation: "write",
					path: changedPath,
					toolResult: "succeeded",
					postState: { status: "confirmed" },
				},
			],
		});
		expect(details.tasks[0]?.externalMutations).toHaveLength(1);
		expect(details.tasks[0]?.artifact?.commit).toBeUndefined();
		expect(details.integration).toBeUndefined();
		ledger.close();
	});

	it("retains external mutation risk when the child handoff is invalid", async () => {
		const fixture = await repository();
		const externalRoot = await mkdtemp(join(tmpdir(), "subagent-external-invalid-"));
		temporaryPaths.push(externalRoot);
		const changedPath = join(await realpath(externalRoot), "published.txt");
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "external-invalid-handoff-dag",
			runTask: async (options) => {
				const journal = options.externalMutationJournal!;
				const mutation = {
					mutationId: `${journal.policy.attemptId}:1`,
					runId: journal.policy.runId,
					taskId: journal.policy.taskId,
					attemptId: journal.policy.attemptId,
					attemptNumber: journal.policy.attemptNumber,
					authorizationSequence: 1,
					toolCallId: "write-1",
					operation: "write" as const,
					path: changedPath,
					authorizationStatus: "authorized" as const,
					authorizedAt: Date.now(),
				};
				journal.onEvent({ journalVersion: 1, journalSequence: 1, type: "authorized", mutation });
				await writeFile(changedPath, "published despite missing handoff\n");
				journal.onEvent({
					journalVersion: 1,
					journalSequence: 2,
					type: "observed",
					mutationId: mutation.mutationId,
					toolResult: "succeeded",
					observedAt: Date.now(),
					postState: await captureExternalMutationPostState(changedPath),
				});
				return {
					taskId: options.task.id,
					role: options.task.role,
					success: false,
					terminalReason: "invalid_handoff",
					error: "Child did not call submit_handoff",
					usage: usage(),
					turns: 1,
				};
			},
		});
		await expect(
			orchestrator.start({
				repositoryPath: fixture.root,
				request: request([
					{
						id: "publish",
						role: "external-writer",
						objective: "Publish",
						externalOwnedPaths: [externalRoot],
					},
				]),
			}),
		).rejects.toBeInstanceOf(SubagentDagRunError);
		const details = orchestrator.inspect("external-invalid-handoff-dag");
		expect(details.tasks[0]).toMatchObject({
			status: "failed",
			terminalReason: "invalid_handoff",
			externalMutations: [
				{
					path: changedPath,
					authorizationStatus: "authorized",
					toolResult: "succeeded",
					postState: { status: "confirmed" },
				},
			],
		});
		expect(details.tasks[0]?.artifact).toBeUndefined();
		ledger.close();
	});

	it("ingests an unconsumed external authorization journal during crash recovery", async () => {
		const fixture = await repository();
		const externalRoot = await mkdtemp(join(tmpdir(), "subagent-external-crash-recovery-"));
		temporaryPaths.push(externalRoot);
		const ledger = new RunLedger(":memory:");
		const compiled = request([
			{
				id: "publish",
				role: "external-writer",
				objective: "Publish",
				externalOwnedPaths: [externalRoot],
			},
		]);
		ledger.createDagRun({
			runId: "external-crash-recovery-dag",
			request: compiled,
			baseline: {
				repositoryRoot: await realpath(fixture.root),
				headCommit: fixture.head,
				snapshotId: "crash-recovery-snapshot",
				fileCount: 1,
				totalBytes: 5,
			},
		});
		const expiredAt = Date.now() - 1_000;
		ledger.setDagRunStatus("external-crash-recovery-dag", "running", expiredAt);
		const [claim] = ledger.claimRunnableTasks(
			"external-crash-recovery-dag",
			"crashed-controller",
			expiredAt + 1,
			10,
			1,
		);
		const journal = await createExternalMutationJournal({
			runId: claim.runId,
			taskId: claim.taskId,
			attemptId: claim.attemptId,
			attemptNumber: claim.attemptNumber,
		});
		try {
			ledger.registerDagExternalMutationJournal(journal.policy, claim.ownerId, expiredAt + 2);
			new ExternalMutationJournalWriter(journal.policy).authorize(
				"write-before-crash",
				"write",
				join(await realpath(externalRoot), "possibly-written.txt"),
				expiredAt + 3,
			);
			const orchestrator = new SubagentDagOrchestrator({
				ledger,
				policy: policy(),
				runTask: async () => {
					throw new Error("exhausted crashed attempt must not invoke a new child");
				},
			});
			await expect(orchestrator.resume({ runId: "external-crash-recovery-dag" })).rejects.toBeInstanceOf(
				SubagentDagRunError,
			);
			const details = orchestrator.inspect("external-crash-recovery-dag");
			expect(details.tasks[0]?.externalMutations).toMatchObject([
				{
					toolCallId: "write-before-crash",
					authorizationStatus: "authorized",
				},
			]);
			expect(details.tasks[0]?.externalMutations?.[0]?.toolResult).toBeUndefined();
			expect(ledger.listOpenDagExternalMutationJournals("external-crash-recovery-dag")).toEqual([]);
		} finally {
			await journal.cleanup();
			ledger.close();
		}
	});

	it("routes authorized controls to exactly one live task runtime and persists them", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const controls: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let ready!: () => void;
		const live = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const metadata = {
			provider: "fake",
			model: "fake/model",
			thinkingLevel: "medium" as const,
			isolationLevel: "tool-bounded" as const,
			sessionId: "control-session",
			runtimeGeneration: 1,
			lastEventSeq: 0,
		};
		const childRuntime: ChildAgentRuntime = {
			metadata,
			closed: false,
			async prompt(message, behavior) {
				controls.push(`message:${behavior}:${message}`);
			},
			async steer(message) {
				controls.push(`steer:${message}`);
			},
			async followUp(message) {
				controls.push(`follow_up:${message}`);
			},
			async abort() {
				controls.push("interrupt");
			},
			async getState() {
				return {
					...metadata,
					model: { provider: "fake", id: "fake/model" },
					thinkingLevel: "medium",
					isStreaming: true,
					isCompacting: false,
					pendingMessageCount: 0,
				};
			},
			onEvent() {
				return () => {};
			},
			async waitForSettled() {
				return { seq: 1, runtimeGeneration: 1, payload: { type: "agent_settled" } };
			},
			async shutdown() {},
		};
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "control-dag",
			runTask: async (options) => {
				options.onRuntimeReady?.(childRuntime, metadata);
				ready();
				await gate;
				options.onRuntimeClosed?.(childRuntime, metadata);
				return success(options.task);
			},
		});
		const running = orchestrator.start({
			repositoryPath: fixture.root,
			request: request([{ id: "live", role: "analyst", objective: "stay live" }]),
		});
		await live;
		await orchestrator.controlTask({ runId: "control-dag", taskId: "live", operation: "message", message: "focus" });
		await orchestrator.controlTask({
			runId: "control-dag",
			taskId: "live",
			operation: "follow_up",
			message: "then verify",
		});
		await orchestrator.controlTask({ runId: "control-dag", taskId: "live", operation: "interrupt" });
		expect(controls).toEqual(["message:steer:focus", "follow_up:then verify", "interrupt"]);
		expect(ledger.listDagEvents("control-dag").filter((event) => event.type === "task.control")).toHaveLength(3);
		release();
		await running;
		await expect(
			orchestrator.controlTask({ runId: "control-dag", taskId: "live", operation: "message", message: "late" }),
		).rejects.toThrow("not running");
		ledger.close();
	});

	it("keeps retention disabled by default and safely collects only aged terminal runs without candidates", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let clock = 10_000;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "retention-dag",
			now: () => clock,
			runTask: async (options) => success(options.task),
		});
		await orchestrator.start({
			repositoryPath: fixture.root,
			request: request([{ id: "inspect", role: "analyst", objective: "inspect" }]),
		});
		expect(await orchestrator.sweepRetention()).toEqual({
			eligibleRunIds: [],
			collectedRunIds: [],
			failures: [],
			dryRun: false,
		});
		clock += 101;
		const dryRun = await orchestrator.sweepRetention({
			enabled: true,
			minAgeMs: 100,
			maxRunsPerSweep: 5,
			dryRun: true,
		});
		expect(dryRun).toMatchObject({ eligibleRunIds: ["retention-dag"], collectedRunIds: [], dryRun: true });
		const collected = await orchestrator.sweepRetention({ enabled: true, minAgeMs: 100, maxRunsPerSweep: 5 });
		expect(collected).toMatchObject({ eligibleRunIds: ["retention-dag"], collectedRunIds: ["retention-dag"] });
		expect(orchestrator.inspect("retention-dag").resources.pins).toBe("released");
		await expect(
			git(fixture.root, "rev-parse", "--verify", "refs/pi-subagent/baselines/retention-dag"),
		).rejects.toThrow();
		ledger.close();
	});

	it("waits at an open frontier, expands with graph CAS, then resumes to a sealed success", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const calls: string[] = [];
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "expandable-dag",
			runTask: async (options) => {
				calls.push(options.task.id);
				if (options.task.id === "review") {
					expect(options.prerequisiteArtifacts?.map((artifact) => artifact.taskId)).toEqual(["scout"]);
				}
				return success(options.task);
			},
		});
		const open = compileSubagentDagRequest(
			{
				operation: "start",
				objective: "discover then review",
				tasks: [{ id: "scout", role: "analyst", objective: "discover" }],
				openGraph: true,
			},
			policy(),
		);
		const frontier = await orchestrator.start({ repositoryPath: fixture.root, request: open });
		expect(frontier).toMatchObject({
			status: "running",
			graphVersion: 1,
			graphSealed: false,
			awaitingExpansion: true,
			pausedAt: expect.any(Number),
		});
		await expect(
			orchestrator.expand({
				operation: "expand",
				runId: "expandable-dag",
				expectedGraphVersion: 2,
				tasks: [],
				sealGraph: true,
			}),
		).rejects.toThrow("Stale DAG graph version");
		const expanded = await orchestrator.expand({
			operation: "expand",
			runId: "expandable-dag",
			expectedGraphVersion: 1,
			tasks: [{ id: "review", role: "reviewer", objective: "review", dependsOn: ["scout"] }],
			sealGraph: true,
		});
		expect(expanded).toMatchObject({ graphVersion: 2, graphSealed: true, awaitingExpansion: false });
		const completed = await orchestrator.resume({ runId: "expandable-dag" });
		expect(completed.status).toBe("succeeded");
		expect(completed.tasks.map((task) => task.taskId)).toEqual(["scout", "review"]);
		expect(calls).toEqual(["scout", "review"]);
		expect(ledger.listDagEvents("expandable-dag").map((event) => event.type)).toContain("run.graph_expanded");
		ledger.close();
	});

	it("resumes remaining work after active run age exceeds one child inactivity interval", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let clock = Date.now();
		const calls: string[] = [];
		const selectedPolicy = policy({ leaseDurationMs: SUBAGENT_INFRA_LIMITS.wallTimeMs * 2 });
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "old-active-run-dag",
			now: () => clock,
			runTask: async (options) => {
				calls.push(options.task.id);
				if (options.task.id === "first") clock += SUBAGENT_INFRA_LIMITS.wallTimeMs + 1;
				return success(options.task);
			},
		});
		const open = compileSubagentDagRequest(
			{
				operation: "start",
				objective: "finish work across an old persisted run",
				tasks: [{ id: "first", role: "analyst", objective: "first" }],
				openGraph: true,
			},
			selectedPolicy,
		);
		const frontier = await orchestrator.start({ repositoryPath: fixture.root, request: open });
		expect(frontier).toMatchObject({ status: "running", awaitingExpansion: true });
		await orchestrator.expand({
			operation: "expand",
			runId: "old-active-run-dag",
			expectedGraphVersion: 1,
			tasks: [{ id: "remaining", role: "analyst", objective: "remaining", dependsOn: ["first"] }],
			sealGraph: true,
		});

		const completed = await orchestrator.resume({ runId: "old-active-run-dag" });
		expect(completed.status).toBe("succeeded");
		expect(calls).toEqual(["first", "remaining"]);
		ledger.close();
	});

	it("refills a free concurrency slot without waiting for a slow sibling wave", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const selectedPolicy = policy({ maxConcurrency: 2 });
		let releaseSlow!: () => void;
		const slowReleased = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let markDownstreamStarted!: () => void;
		const downstreamStarted = new Promise<void>((resolve) => {
			markDownstreamStarted = resolve;
		});
		let activeCount = 0;
		let peakActive = 0;
		const calls: string[] = [];
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "work-conserving-dag",
			runTask: async (options) => {
				calls.push(options.task.id);
				activeCount++;
				peakActive = Math.max(peakActive, activeCount);
				try {
					if (options.task.id === "slow") await slowReleased;
					if (options.task.id === "downstream") markDownstreamStarted();
					return success(options.task);
				} finally {
					activeCount--;
				}
			},
		});
		const running = orchestrator.start({
			repositoryPath: fixture.root,
			request: request(
				[
					{ id: "slow", role: "analyst", objective: "slow" },
					{ id: "fast", role: "analyst", objective: "fast" },
					{ id: "downstream", role: "analyst", objective: "after fast", dependsOn: ["fast"] },
				],
				false,
				selectedPolicy,
			),
		});
		const refilledBeforeSlow = await Promise.race([
			downstreamStarted.then(() => true),
			// The assertion is about ordering before the blocked sibling, not a 1s Git startup SLA.
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
		]);
		releaseSlow();
		expect(refilledBeforeSlow).toBe(true);
		expect((await running).status).toBe("succeeded");
		expect(calls.indexOf("downstream")).toBeGreaterThan(calls.indexOf("fast"));
		expect(peakActive).toBeLessThanOrEqual(2);
		ledger.close();
	});

	it("continues active and pending independent branches after a task fails", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const selectedPolicy = policy({ maxConcurrency: 2 });
		let releaseSlow!: () => void;
		const slowReleased = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let slowAborted = false;
		let independentStarted!: () => void;
		const independent = new Promise<void>((resolve) => {
			independentStarted = resolve;
		});
		const calls: string[] = [];
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "failed-sibling-dag",
			...fastReaderWorkspace(fixture),
			runTask: async (options) => {
				calls.push(options.task.id);
				if (options.task.id === "fail") {
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason: "task_rejected",
						error: "known failure",
						usage: usage(2),
						turns: 1,
					};
				}
				if (options.task.id === "independent") independentStarted();
				if (options.task.id !== "slow") return success(options.task);
				return await new Promise<ChildTaskResult>((resolve) => {
					const finish = (): void => resolve(success(options.task));
					slowReleased.then(finish);
					options.signal?.addEventListener(
						"abort",
						() => {
							slowAborted = true;
							resolve({
								taskId: options.task.id,
								role: options.task.role,
								success: false,
								terminalReason: "cancelled",
								error: "run aborted",
								usage: usage(7),
								turns: 1,
							});
						},
						{ once: true },
					);
				});
			},
		});
		const running = orchestrator.start({
			repositoryPath: fixture.root,
			request: request(
				[
					{ id: "fail", role: "analyst", objective: "fail", maxAttempts: 1 },
					{ id: "slow", role: "analyst", objective: "slow", maxAttempts: 1 },
					{ id: "blocked", role: "analyst", objective: "blocked", dependsOn: ["fail"] },
					{ id: "independent", role: "analyst", objective: "independent" },
				],
				false,
				selectedPolicy,
			),
		});
		const continued = await Promise.race([
			independent.then(() => true),
			running.then(
				() => false,
				() => false,
			),
		]);
		releaseSlow();
		const failure = await running.catch((error: unknown) => error);
		expect(continued).toBe(true);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		expect(slowAborted).toBe(false);
		expect(calls).toEqual(["fail", "slow", "independent"]);
		expect((failure as SubagentDagRunError).details).toMatchObject({
			status: "failed",
			usage: { totalTokens: 6 },
			tasks: [
				{ taskId: "fail", status: "failed" },
				{ taskId: "slow", status: "succeeded" },
				{ taskId: "blocked", status: "blocked", terminalReason: "dependency_failed" },
				{ taskId: "independent", status: "succeeded" },
			],
		});
		ledger.close();
	});

	it("grants each concurrent Subagent task its full cumulative token budget", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const budgets: number[] = [];
		const softLimits: Array<number | undefined> = [];
		const snapshotPaths: string[] = [];
		let snapshotMaterializations = 0;
		let snapshotCleanups = 0;
		let releaseRunners!: () => void;
		const allRunnersStarted = new Promise<void>((resolve) => {
			releaseRunners = resolve;
		});
		const selectedPolicy = policy({ maxConcurrency: 4 });
		const compiled = request(
			Array.from({ length: 4 }, (_, index) => ({
				id: `task-${index}`,
				role: "analyst" as const,
				objective: `task ${index}`,
			})),
			false,
			selectedPolicy,
		);
		compiled.budget = { maxTokens: 100 };
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "concurrent-budget-dag",
			createSnapshot: async (repositoryPath) => {
				snapshotMaterializations++;
				return {
					path: join(repositoryPath, `reader-snapshot-${snapshotMaterializations}`),
					baseline: {
						repositoryRoot: repositoryPath,
						headCommit: fixture.head,
						snapshotId: "shared-snapshot",
						fileCount: 1,
						totalBytes: 1,
					},
					cleanup: async () => {
						snapshotCleanups++;
					},
				};
			},
			runTask: async (options) => {
				budgets.push(options.budget.maxTokens);
				softLimits.push(options.softTokenLimit);
				snapshotPaths.push(options.snapshotPath);
				if (budgets.length === 4) releaseRunners();
				await allRunnersStarted;
				return { ...success(options.task), usage: usage(60) };
			},
		});

		const details = await orchestrator.start({ repositoryPath: fixture.root, request: compiled });
		expect(details.status).toBe("succeeded");
		expect(budgets.sort((left, right) => left - right)).toEqual([100, 100, 100, 100]);
		expect(softLimits).toEqual([90, 90, 90, 90]);
		expect(details.usage.totalTokens).toBe(240);
		expect(new Set(snapshotPaths).size).toBe(4);
		expect(snapshotMaterializations).toBe(4);
		expect(snapshotCleanups).toBe(4);
		ledger.close();
	});

	it("preserves aggregate run-budget partitioning for persisted legacy requests", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const budgets: number[] = [];
		const softLimits: Array<number | undefined> = [];
		const selectedPolicy = policy({ maxConcurrency: 4 });
		const compiled = request(
			Array.from({ length: 4 }, (_, index) => ({
				id: `legacy-${index}`,
				role: "analyst" as const,
				objective: `legacy task ${index}`,
			})),
			false,
			selectedPolicy,
		);
		compiled.budget = { maxTokens: 100 };
		delete compiled.budgetScope;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "legacy-concurrent-budget-dag",
			runTask: async (options) => {
				budgets.push(options.budget.maxTokens);
				softLimits.push(options.softTokenLimit);
				return { ...success(options.task), usage: usage(1) };
			},
		});

		const details = await orchestrator.start({ repositoryPath: fixture.root, request: compiled });
		expect(details.status).toBe("succeeded");
		expect(budgets.sort((left, right) => left - right)).toEqual([25, 25, 25, 25]);
		expect(softLimits).toEqual([undefined, undefined, undefined, undefined]);
		ledger.close();
	});

	it("persists a budget partial handoff without quality, artifact, dependency release, or candidate creation", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(ledgerFile(fixture.root));
		temporaryPaths.push(ledgerFile(fixture.root));
		const selectedPolicy = candidatePolicy();
		let qualityCalls = 0;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry: candidateValidationRegistry(),
			createRunId: () => "partial-budget-dag",
			runTask: async (options) => ({
				taskId: options.task.id,
				role: options.task.role,
				success: false,
				terminalReason: "budget_exhausted",
				error: "hard limit reached",
				partialHandoff: {
					taskId: options.task.id,
					summary: "Implemented most of the writer task before the limit",
					outcome: "inconclusive",
					evidence: [{ path: "owned.txt", claim: "Draft change exists only in the isolated worktree" }],
					verification: [{ check: "static inspection", status: "passed" }],
					assumptions: [],
					risks: ["The parent quality gate did not run"],
					nextActions: ["Rerun the task with more budget"],
					verificationLevel: "self_reported",
					artifactVersion: 2,
					changedPaths: ["owned.txt"],
				},
				usage: usage(11, 0.11),
				turns: 1,
			}),
			validateAndCommitWriterTask: async () => {
				qualityCalls++;
				throw new Error("quality must not run for a partial handoff");
			},
		});
		const compiled = request(
			[
				{
					id: "write",
					role: "writer",
					objective: "write",
					ownedPaths: ["owned.txt"],
					validationCommandIds: [CANDIDATE_VALIDATION_ID],
				},
				{ id: "review", role: "reviewer", objective: "review", dependsOn: ["write"] },
			],
			true,
			selectedPolicy,
		);
		compiled.budget = { maxTokens: 10 };

		const failure = await orchestrator
			.start({ repositoryPath: fixture.root, request: compiled })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		const details = orchestrator.inspect("partial-budget-dag");
		expect(details).toMatchObject({
			status: "failed",
			resources: { candidate: "none" },
			tasks: [
				{
					taskId: "write",
					status: "failed",
					terminalReason: "budget_exhausted",
					partialHandoff: { outcome: "inconclusive", summary: expect.stringContaining("Implemented most") },
				},
				{ taskId: "review", status: "blocked", terminalReason: "dependency_failed" },
			],
		});
		expect(details.tasks[0]?.artifact).toBeUndefined();
		expect(details.integration).toBeUndefined();
		expect(qualityCalls).toBe(0);
		expect(ledger.getDagRun("partial-budget-dag")?.tasks[0]?.checkpoint).toMatchObject({
			version: 1,
			phase: "budget_exhausted_partial",
			partialHandoff: { outcome: "inconclusive" },
		});
		ledger.close();

		const reopened = new RunLedger(ledgerFile(fixture.root));
		expect(reopened.getDagRun("partial-budget-dag")?.tasks[0]?.checkpoint).toMatchObject({
			phase: "budget_exhausted_partial",
			partialHandoff: { taskId: "write", outcome: "inconclusive" },
		});
		const restarted = new SubagentDagOrchestrator({ ledger: reopened, policy: selectedPolicy });
		expect(restarted.inspect("partial-budget-dag").tasks[0]?.partialHandoff).toMatchObject({
			taskId: "write",
			outcome: "inconclusive",
			summary: expect.stringContaining("Implemented most"),
		});
		reopened.close();
	});

	it("orders dependencies, validates and commits a writer, and integrates without changing the user worktree", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const selectedPolicy = candidatePolicy();
		const calls: string[] = [];
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry: candidateValidationRegistry(),
			createRunId: () => "writer-dag",
			runTask: async (options) => {
				calls.push(options.task.id);
				expect(options.childModel).toEqual({
					provider: "openai-codex",
					model: "gpt-5.4-mini",
					thinkingLevel: "low",
				});
				if (options.task.role === "writer") {
					expect(options.prerequisiteArtifacts?.map((artifact) => artifact.taskId)).toEqual(["inspect"]);
					await writeFile(join(options.snapshotPath, "written.txt"), "writer output\n");
					return success(options.task, ["written.txt"]);
				}
				return success(options.task);
			},
		});

		const details = await orchestrator.start({
			repositoryPath: fixture.root,
			request: {
				...request(
					[
						{ id: "inspect", role: "analyst", objective: "inspect" },
						{
							id: "write",
							role: "writer",
							objective: "write",
							dependsOn: ["inspect"],
							ownedPaths: ["written.txt"],
							validationCommandIds: [CANDIDATE_VALIDATION_ID],
						},
					],
					true,
					selectedPolicy,
				),
				childModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
			},
		});

		expect(calls).toEqual(["inspect", "write"]);
		expect(details.status).toBe("succeeded");
		expect(details.tasks[1]?.artifact?.commit).toMatch(/^[a-f0-9]{40,64}$/);
		expect(details.integration).toMatchObject({ kind: "complete", orderedTaskIds: ["write"] });
		expect(details.integration?.quality).toMatchObject({
			semanticOutcome: "accepted",
			pathAuditCoverage: "full",
			validationCoverage: "full",
			commitPinCoverage: "full",
			reviewCoverage: "none",
			reviewVerdict: "none",
			gate: "passed",
			validatedWriterTaskIds: ["write"],
		});
		expect(await git(fixture.root, "show", `${details.integration?.commit}:written.txt`)).toBe("writer output");
		expect(await git(fixture.root, "symbolic-ref", "HEAD")).toBe(fixture.branch);
		expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.head);
		expect(await git(fixture.root, "status", "--porcelain=v1")).toBe("");
		expect(await git(fixture.root, "rev-parse", "--verify", `refs/pi-subagent/baselines/writer-dag`)).toBe(
			details.baseline.headCommit,
		);
		expect(await git(fixture.root, "rev-parse", "--verify", `refs/pi-subagent/tasks/writer-dag/write`)).toBe(
			details.tasks[1]?.artifact?.commit,
		);

		const candidateDiff = await orchestrator.diffCandidate({ runId: "writer-dag", maxBytes: 16_384 });
		expect(candidateDiff).toMatchObject({
			runId: "writer-dag",
			candidateRef: details.integration?.ref,
			candidateCommit: details.integration?.commit,
			changedPaths: ["written.txt"],
			truncated: false,
		});
		expect(candidateDiff.patch).toContain("writer output");
		const checkedOutCandidate = await mkdtemp(join(tmpdir(), "subagent-candidate-checkout-"));
		temporaryPaths.push(checkedOutCandidate);
		await git(
			fixture.root,
			"worktree",
			"add",
			"-q",
			checkedOutCandidate,
			details.integration!.ref.slice("refs/heads/".length),
		);
		await expect(orchestrator.releaseCandidate({ runId: "writer-dag" })).rejects.toThrow("candidate ref checked out");
		expect(ledger.getDagRun("writer-dag")?.resources.candidate).toBe("release_pending");
		await git(fixture.root, "worktree", "remove", "--force", checkedOutCandidate);
		const released = await orchestrator.releaseCandidate({ runId: "writer-dag" });
		expect(released.resources.candidate).toBe("released");
		await expect(git(fixture.root, "rev-parse", "--verify", details.integration!.ref)).rejects.toThrow();
		expect((await orchestrator.releaseCandidate({ runId: "writer-dag" })).resources.candidate).toBe("released");
		const collected = await orchestrator.gc({ runId: "writer-dag" });
		expect(collected.resources.pins).toBe("released");
		await expect(
			git(fixture.root, "rev-parse", "--verify", `refs/pi-subagent/baselines/writer-dag`),
		).rejects.toThrow();
		await expect(
			git(fixture.root, "rev-parse", "--verify", `refs/pi-subagent/tasks/writer-dag/write`),
		).rejects.toThrow();
		expect((await orchestrator.gc({ runId: "writer-dag" })).resources.pins).toBe("released");
		expect(await git(fixture.root, "symbolic-ref", "HEAD")).toBe(fixture.branch);
		expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.head);
		expect(await git(fixture.root, "status", "--porcelain=v1")).toBe("");
		ledger.close();
	});

	it("retains a restart-safe non-accepted Partial Candidate from validated independent Writers in a failed DAG", async () => {
		const fixture = await repository();
		const databasePath = ledgerFile(fixture.root);
		temporaryPaths.push(databasePath);
		let ledger = new RunLedger(databasePath);
		const selectedPolicy = candidatePolicy();
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry: candidateValidationRegistry(),
			createRunId: () => "partial-candidate-dag",
			runTask: async (options) => {
				if (options.task.id === "write") {
					await writeFile(join(options.snapshotPath, "partial.txt"), "retained partial output\n");
					return success(options.task, ["partial.txt"]);
				}
				return {
					taskId: options.task.id,
					role: options.task.role,
					success: false,
					terminalReason: "model_error",
					error: "independent branch failed",
					usage: usage(),
					turns: 1,
				};
			},
		});
		const failure = await orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request(
					[
						{
							id: "write",
							role: "writer",
							objective: "write retained output",
							ownedPaths: ["partial.txt"],
							validationCommandIds: [CANDIDATE_VALIDATION_ID],
						},
						{
							id: "fail",
							role: "writer",
							objective: "fail independently",
							ownedPaths: ["failed.txt"],
							validationCommandIds: [CANDIDATE_VALIDATION_ID],
							maxAttempts: 1,
						},
					],
					true,
					selectedPolicy,
				),
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		const details = (failure as SubagentDagRunError).details;
		expect(details).toMatchObject({
			status: "failed",
			resources: { candidate: "retained", pins: "retained" },
			integration: {
				kind: "partial",
				orderedTaskIds: ["write"],
				partial: {
					reason: "task_failure",
					completeGateFailures: [],
					trust: "controller_validated",
					includedWriterTaskIds: ["write"],
					omittedWriterTasks: [{ taskId: "fail", reason: "task_not_succeeded" }],
					negativeTasks: [{ taskId: "fail", status: "failed", terminalReason: "model_error" }],
				},
				quality: {
					semanticOutcome: "accepted",
					pathAuditCoverage: "full",
					validationCoverage: "full",
					commitPinCoverage: "full",
					reviewCoverage: "none",
					gate: "failed",
					gateFailures: ["dag_incomplete"],
				},
			},
		});
		expect(await git(fixture.root, "show", `${details.integration?.commit}:partial.txt`)).toBe(
			"retained partial output",
		);
		expect(await git(fixture.root, "symbolic-ref", "HEAD")).toBe(fixture.branch);
		expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.head);
		expect(await git(fixture.root, "status", "--porcelain=v1")).toBe("");
		expect(
			await git(fixture.root, "rev-parse", "--verify", "refs/pi-subagent/tasks/partial-candidate-dag/write"),
		).toBe(details.tasks[0]?.artifact?.commit);
		const diff = await orchestrator.diffCandidate({ runId: "partial-candidate-dag" });
		expect(diff.changedPaths).toEqual(["partial.txt"]);
		expect(diff.patch).toContain("retained partial output");
		ledger.close();

		ledger = new RunLedger(databasePath);
		const restarted = new SubagentDagOrchestrator({ ledger, policy: selectedPolicy });
		expect(restarted.inspect("partial-candidate-dag").integration).toMatchObject({
			kind: "partial",
			partial: { includedWriterTaskIds: ["write"] },
			quality: { gate: "failed", gateFailures: ["dag_incomplete"] },
		});
		await expect(restarted.gc({ runId: "partial-candidate-dag" })).rejects.toThrow(
			"Release the integration candidate",
		);
		expect(
			(await restarted.sweepRetention({ enabled: true, minAgeMs: 0, maxRunsPerSweep: 10, dryRun: true }))
				.eligibleRunIds,
		).toEqual([]);
		expect((await restarted.releaseCandidate({ runId: "partial-candidate-dag" })).resources.candidate).toBe(
			"released",
		);
		expect(
			(await restarted.sweepRetention({ enabled: true, minAgeMs: 0, maxRunsPerSweep: 10, dryRun: true }))
				.eligibleRunIds,
		).toEqual(["partial-candidate-dag"]);
		expect((await restarted.gc({ runId: "partial-candidate-dag" })).resources.pins).toBe("released");
		await expect(
			git(fixture.root, "rev-parse", "--verify", "refs/pi-subagent/tasks/partial-candidate-dag/write"),
		).rejects.toThrow();
		ledger.close();
	});

	it("keeps external Writer effects live and outside Partial Candidate composition", async () => {
		const fixture = await repository();
		const externalRoot = await mkdtemp(join(tmpdir(), "subagent-partial-external-"));
		temporaryPaths.push(externalRoot);
		const changedPath = join(await realpath(externalRoot), "published.txt");
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "partial-external-dag",
			runTask: async (options) => {
				if (options.task.id === "publish") {
					const journal = options.externalMutationJournal!;
					const mutation = {
						mutationId: `${journal.policy.attemptId}:1`,
						runId: journal.policy.runId,
						taskId: journal.policy.taskId,
						attemptId: journal.policy.attemptId,
						attemptNumber: journal.policy.attemptNumber,
						authorizationSequence: 1,
						toolCallId: "write-1",
						operation: "write" as const,
						path: changedPath,
						authorizationStatus: "authorized" as const,
						authorizedAt: Date.now(),
					};
					journal.onEvent({ journalVersion: 1, journalSequence: 1, type: "authorized", mutation });
					await writeFile(changedPath, "external output\n");
					journal.onEvent({
						journalVersion: 1,
						journalSequence: 2,
						type: "observed",
						mutationId: mutation.mutationId,
						toolResult: "succeeded",
						observedAt: Date.now(),
						postState: await captureExternalMutationPostState(changedPath),
					});
					return success(options.task, [changedPath]);
				}
				return {
					taskId: options.task.id,
					role: options.task.role,
					success: false,
					terminalReason: "task_rejected",
					error: "independent failure",
					usage: usage(),
					turns: 1,
				};
			},
		});
		const failure = await orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request([
					{
						id: "publish",
						role: "external-writer",
						objective: "publish externally",
						externalOwnedPaths: [externalRoot],
					},
					{ id: "fail", role: "analyst", objective: "fail", maxAttempts: 1 },
				]),
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		const details = (failure as SubagentDagRunError).details;
		expect(details.integration).toBeUndefined();
		expect(details.resources.candidate).toBe("none");
		const externalArtifact = details.tasks.find((task) => task.taskId === "publish")?.artifact;
		expect(externalArtifact).toMatchObject({ externalChangedPaths: [changedPath] });
		expect(externalArtifact?.commit).toBeUndefined();
		expect(await readFile(changedPath, "utf8")).toBe("external output\n");
		ledger.close();
	});

	it("keeps Writer task pins and no candidate when Partial Candidate composition conflicts", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const selectedPolicy = candidatePolicy();
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry: candidateValidationRegistry(),
			createRunId: () => "partial-conflict-dag",
			runTask: async (options) => {
				if (options.task.id === "write") {
					await writeFile(join(options.snapshotPath, "conflict.txt"), "retained task commit\n");
					return success(options.task, ["conflict.txt"]);
				}
				return {
					taskId: options.task.id,
					role: options.task.role,
					success: false,
					terminalReason: "task_rejected",
					error: "failure forcing partial composition",
					usage: usage(),
					turns: 1,
				};
			},
			mergeTaskCommits: async () => {
				throw new MergeConflictError("write", "partial conflict diagnostics");
			},
		});
		const failure = await orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request(
					[
						{
							id: "write",
							role: "writer",
							objective: "write",
							ownedPaths: ["conflict.txt"],
							validationCommandIds: [CANDIDATE_VALIDATION_ID],
						},
						{ id: "fail", role: "analyst", objective: "fail", maxAttempts: 1 },
					],
					true,
					selectedPolicy,
				),
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		expect((failure as SubagentDagRunError).details).toMatchObject({
			status: "failed",
			resources: { candidate: "none", pins: "retained" },
			integrationFailure: {
				reason: "merge_conflict",
				taskId: "write",
				diagnostics: "partial conflict diagnostics",
			},
		});
		expect((failure as SubagentDagRunError).details.integration).toBeUndefined();
		const writerCommit = (failure as SubagentDagRunError).details.tasks[0]?.artifact?.commit;
		expect(
			await git(fixture.root, "rev-parse", "--verify", "refs/pi-subagent/tasks/partial-conflict-dag/write"),
		).toBe(writerCommit);
		ledger.close();
	});

	it("GC releases an orphan task pin even when a crash preceded artifact persistence", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const compiled = request([{ id: "write", role: "writer", objective: "write", ownedPaths: ["orphan.txt"] }]);
		ledger.createDagRun({
			runId: "orphan-pin-dag",
			request: compiled,
			baseline: {
				repositoryRoot: fixture.root,
				headCommit: fixture.head,
				snapshotId: "orphan-baseline",
				fileCount: 1,
				totalBytes: 1,
			},
		});
		await pinRunBaseline(fixture.root, "orphan-pin-dag", fixture.head);
		await pinTaskCommit(fixture.root, "orphan-pin-dag", "write", fixture.head);
		ledger.setDagRunStatus("orphan-pin-dag", "running", Date.now());
		const lease = ledger.acquireDagRunLease("orphan-pin-dag", "controller", Date.now(), 1_000);
		expect(lease).toBeDefined();
		ledger.setDagRunStatus("orphan-pin-dag", "failed", Date.now(), lease);
		const orchestrator = new SubagentDagOrchestrator({ ledger, policy: policy() });
		const collected = await orchestrator.gc({ runId: "orphan-pin-dag" });
		expect(collected.resources.pins).toBe("released");
		await expect(
			git(fixture.root, "rev-parse", "--verify", "refs/pi-subagent/tasks/orphan-pin-dag/write"),
		).rejects.toThrow();
		await expect(
			git(fixture.root, "rev-parse", "--verify", "refs/pi-subagent/baselines/orphan-pin-dag"),
		).rejects.toThrow();
		ledger.close();
	});

	it("materializes transitive writer commits before a dependent writer runs", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const selectedPolicy = candidatePolicy();
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry: candidateValidationRegistry(),
			createRunId: () => "writer-chain",
			runTask: async (options) => {
				if (options.task.id === "write-a") {
					await writeFile(join(options.snapshotPath, "a.txt"), "a\n");
					return success(options.task, ["a.txt"]);
				}
				expect(await git(options.snapshotPath, "show", "HEAD:a.txt")).toBe("a");
				await writeFile(join(options.snapshotPath, "b.txt"), "b\n");
				return success(options.task, ["b.txt"]);
			},
		});
		const details = await orchestrator.start({
			repositoryPath: fixture.root,
			request: request(
				[
					{
						id: "write-a",
						role: "writer",
						objective: "write a",
						ownedPaths: ["a.txt"],
						validationCommandIds: [CANDIDATE_VALIDATION_ID],
					},
					{
						id: "write-b",
						role: "writer",
						objective: "write b",
						dependsOn: ["write-a"],
						ownedPaths: ["b.txt"],
						validationCommandIds: [CANDIDATE_VALIDATION_ID],
					},
				],
				true,
				selectedPolicy,
			),
		});
		expect(await git(fixture.root, "show", `${details.integration?.commit}:a.txt`)).toBe("a");
		expect(await git(fixture.root, "show", `${details.integration?.commit}:b.txt`)).toBe("b");
		ledger.close();
	});

	it("creates an isolated candidate when no validation command is configured", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "unvalidated-candidate-dag",
			runTask: async (options) => {
				await writeFile(join(options.snapshotPath, "unvalidated.txt"), "unvalidated\n");
				return success(options.task, ["unvalidated.txt"]);
			},
		});
		const unvalidatedRequest = request([
			{
				id: "write",
				role: "writer",
				objective: "write without validation",
				ownedPaths: ["unvalidated.txt"],
			},
		]);
		unvalidatedRequest.merge.enabled = true;
		const details = await orchestrator.start({ repositoryPath: fixture.root, request: unvalidatedRequest });
		expect(details).toMatchObject({ status: "succeeded" });
		expect(details.integration?.quality).toMatchObject({
			validationCoverage: "not_applicable",
			reviewCoverage: "none",
			gate: "passed",
			gateFailures: [],
		});
		expect(await git(fixture.root, "show", `${details.integration?.commit}:unvalidated.txt`)).toBe("unvalidated");
		ledger.close();
	});

	it("does not promote an unvalidated Writer into a failed-run Partial Candidate", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "unvalidated-failed-dag",
			runTask: async (options) => {
				if (options.task.id === "write") {
					await writeFile(join(options.snapshotPath, "unvalidated-partial.txt"), "unvalidated\n");
					return success(options.task, ["unvalidated-partial.txt"]);
				}
				return {
					taskId: options.task.id,
					role: options.task.role,
					success: false,
					terminalReason: "task_rejected",
					error: "independent failure",
					usage: usage(),
					turns: 1,
				};
			},
		});
		const compiled = request([
			{
				id: "write",
				role: "writer",
				objective: "write without validation",
				ownedPaths: ["unvalidated-partial.txt"],
			},
			{ id: "fail", role: "analyst", objective: "fail", maxAttempts: 1 },
		]);
		compiled.merge.enabled = true;
		const failure = await orchestrator
			.start({ repositoryPath: fixture.root, request: compiled })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		const details = (failure as SubagentDagRunError).details;
		expect(details.tasks[0]?.artifact).toMatchObject({
			commit: expect.stringMatching(/^[a-f0-9]{40,64}$/),
			quality: { pathAudit: "passed", validation: { status: "not_run" } },
		});
		expect(details.integration).toBeUndefined();
		expect(details.resources).toMatchObject({ candidate: "none", pins: "retained" });
		ledger.close();
	});

	it("records partial review coverage on a non-accepted Partial Candidate when one Writer was not reviewed", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const selectedPolicy = candidatePolicy();
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry: candidateValidationRegistry(),
			createRunId: () => "partial-review-dag",
			runTask: async (options) => {
				if (options.task.role === "writer") {
					const path = `${options.task.id}.txt`;
					await writeFile(join(options.snapshotPath, path), `${options.task.id}\n`);
					return success(options.task, [path]);
				}
				expect(options.task.id).toBe("review");
				expect(options.prerequisiteArtifacts?.map((artifact) => artifact.taskId)).toEqual(["write-a"]);
				return success(options.task, [], [{ path: "write-a.txt", lineRange: "1", claim: "Reviewed write-a" }]);
			},
		});
		const failure = await orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request(
					[
						{
							id: "write-a",
							role: "writer",
							objective: "write a",
							ownedPaths: ["write-a.txt"],
							validationCommandIds: [CANDIDATE_VALIDATION_ID],
						},
						{
							id: "write-b",
							role: "writer",
							objective: "write b",
							ownedPaths: ["write-b.txt"],
							validationCommandIds: [CANDIDATE_VALIDATION_ID],
						},
						{ id: "review", role: "reviewer", objective: "review a only", dependsOn: ["write-a"] },
					],
					true,
					selectedPolicy,
				),
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		const details = (failure as SubagentDagRunError).details;
		expect(details.tasks.find((task) => task.taskId === "review")?.artifact?.quality?.review).toMatchObject({
			status: "accepted",
			writerCommitClosure: [{ taskId: "write-a" }],
		});
		expect(details.integrationFailure).toBeUndefined();
		expect(details.integration).toMatchObject({
			kind: "partial",
			orderedTaskIds: ["write-a", "write-b"],
			partial: {
				reason: "candidate_quality_failure",
				completeGateFailures: ["review_coverage"],
				trust: "controller_validated",
				includedWriterTaskIds: ["write-a", "write-b"],
				omittedWriterTasks: [],
				negativeTasks: [],
			},
			quality: {
				reviewVerdict: "accepted",
				reviewCoverage: "partial",
				gate: "failed",
				gateFailures: ["review_coverage", "dag_incomplete"],
				fullCoverageReviewerTaskIds: [],
				requiredWriterCommits: [{ taskId: "write-a" }, { taskId: "write-b" }],
				reviewedWriterCommits: [{ taskId: "write-a" }],
			},
		});
		ledger.close();
	});

	it("retains validated Writer commits in a Partial Candidate when their Reviewer rejects", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const selectedPolicy = candidatePolicy();
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry: candidateValidationRegistry(),
			createRunId: () => "rejected-review-partial-dag",
			runTask: async (options) => {
				if (options.task.role === "writer") {
					await writeFile(join(options.snapshotPath, "reviewed.txt"), "writer output\n");
					return success(options.task, ["reviewed.txt"]);
				}
				const result = success(
					options.task,
					[],
					[{ path: "reviewed.txt", lineRange: "1", claim: "Found a blocking issue" }],
				);
				return { ...result, handoff: { ...result.handoff!, outcome: "rejected" } };
			},
		});
		const failure = await orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request(
					[
						{
							id: "write",
							role: "writer",
							objective: "write",
							ownedPaths: ["reviewed.txt"],
							validationCommandIds: [CANDIDATE_VALIDATION_ID],
						},
						{ id: "review", role: "reviewer", objective: "review", dependsOn: ["write"] },
					],
					true,
					selectedPolicy,
				),
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		expect((failure as SubagentDagRunError).details.integration).toMatchObject({
			kind: "partial",
			orderedTaskIds: ["write"],
			partial: {
				reason: "task_failure",
				completeGateFailures: [],
				includedWriterTaskIds: ["write"],
				negativeTasks: [{ taskId: "review", status: "succeeded", semanticOutcome: "rejected" }],
			},
			quality: {
				semanticOutcome: "rejected",
				reviewVerdict: "rejected",
				reviewCoverage: "partial",
				gate: "failed",
				gateFailures: ["semantic_outcome", "review_verdict", "review_coverage", "dag_incomplete"],
			},
		});
		ledger.close();
	});

	it("creates a candidate only when an accepted Reviewer covers the complete final Writer closure", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const selectedPolicy = candidatePolicy();
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry: candidateValidationRegistry(),
			createRunId: () => "full-review-dag",
			runTask: async (options) => {
				if (options.task.role === "writer") {
					const path = `${options.task.id}.txt`;
					await writeFile(join(options.snapshotPath, path), `${options.task.id}\n`);
					return success(options.task, [path]);
				}
				expect(options.prerequisiteArtifacts?.map((artifact) => artifact.taskId)).toEqual(["write-a", "write-b"]);
				return success(
					options.task,
					[],
					[{ path: "src/review.ts", lineRange: "1-4", claim: "Reviewed the complete Writer closure" }],
				);
			},
		});
		const details = await orchestrator.start({
			repositoryPath: fixture.root,
			request: request(
				[
					{
						id: "write-a",
						role: "writer",
						objective: "write a",
						ownedPaths: ["write-a.txt"],
						validationCommandIds: [CANDIDATE_VALIDATION_ID],
					},
					{
						id: "write-b",
						role: "writer",
						objective: "write b",
						ownedPaths: ["write-b.txt"],
						validationCommandIds: [CANDIDATE_VALIDATION_ID],
					},
					{
						id: "review",
						role: "reviewer",
						objective: "review all writers",
						dependsOn: ["write-a", "write-b"],
					},
				],
				true,
				selectedPolicy,
			),
		});
		expect(details.status).toBe("succeeded");
		expect(details.integration?.quality).toMatchObject({
			reviewVerdict: "accepted",
			reviewCoverage: "full",
			gate: "passed",
			fullCoverageReviewerTaskIds: ["review"],
			requiredWriterCommits: [{ taskId: "write-a" }, { taskId: "write-b" }],
			reviewedWriterCommits: [{ taskId: "write-a" }, { taskId: "write-b" }],
		});
		ledger.close();
	});

	it("retries non-cancelled failure, then passes transitive artifacts and aggregates every attempt's usage", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const calls: string[] = [];
		const budgets: Array<{ taskId: string; maxTokens: number; softTokenLimit?: number }> = [];
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "retry-dag",
			runTask: async (options) => {
				calls.push(options.task.id);
				budgets.push({
					taskId: options.task.id,
					maxTokens: options.budget.maxTokens,
					...(options.softTokenLimit === undefined ? {} : { softTokenLimit: options.softTokenLimit }),
				});
				if (options.task.id === "root" && calls.filter((id) => id === "root").length === 1) {
					return {
						taskId: "root",
						role: "scout",
						success: false,
						terminalReason: "process_error",
						error: "transient",
						usage: usage(),
						turns: 1,
					};
				}
				if (options.task.id === "leaf") {
					expect(options.prerequisiteArtifacts?.map((artifact) => artifact.taskId)).toEqual(["root", "middle"]);
				}
				return success(options.task);
			},
		});
		const compiled = request([
			{ id: "root", role: "analyst", objective: "root", maxAttempts: 2 },
			{ id: "middle", role: "analyst", objective: "middle", dependsOn: ["root"] },
			{ id: "leaf", role: "analyst", objective: "leaf", dependsOn: ["middle"] },
		]);
		compiled.budget = { maxTokens: 10 };
		const details = await orchestrator.start({ repositoryPath: fixture.root, request: compiled });
		expect(calls).toEqual(["root", "root", "middle", "leaf"]);
		expect(budgets).toEqual([
			{ taskId: "root", maxTokens: 10, softTokenLimit: 9 },
			{ taskId: "root", maxTokens: 8, softTokenLimit: 7 },
			{ taskId: "middle", maxTokens: 10, softTokenLimit: 9 },
			{ taskId: "leaf", maxTokens: 10, softTokenLimit: 9 },
		]);
		expect(details.tasks[0]).toMatchObject({ attempts: 2, usage: { totalTokens: 4 }, turns: 2 });
		expect(details.tasks[1]).toMatchObject({ usage: { totalTokens: 2 }, turns: 1 });
		expect(details.tasks[2]).toMatchObject({ usage: { totalTokens: 2 }, turns: 1 });
		expect(details.usage.totalTokens).toBe(8);
		expect(details.usage.cost.total).toBeCloseTo(0.08);
		expect(ledger.getDagRun("retry-dag")).toMatchObject({ usage: { totalTokens: 8 }, turns: 4 });
		ledger.close();
	});

	it("recovers after more provider availability failures than maxAttempts", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let clock = 10_000;
		let calls = 0;
		const selectedPolicy = policy({ leaseDurationMs: 1_000_000_000 });
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "availability-recovery-dag",
			now: () => {
				clock += 100_000;
				return clock;
			},
			runTask: async (options) => {
				calls++;
				expect(options.retryFeedback).toBeUndefined();
				if (calls <= 4) {
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason: "model_error",
						error: "Child model stopped with error: fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: chatgpt.com:443, timeout: 10000ms))",
						usage: usage(1, 0.01),
						turns: 1,
					};
				}
				return success(options.task);
			},
		});

		const details = await orchestrator.start({
			repositoryPath: fixture.root,
			request: request(
				[{ id: "inspect", role: "analyst", objective: "inspect", maxAttempts: 1 }],
				false,
				selectedPolicy,
			),
		});
		expect(calls).toBe(5);
		expect(details).toMatchObject({
			status: "succeeded",
			usage: { totalTokens: 6 },
			tasks: [{ status: "succeeded", attempts: 1, usage: { totalTokens: 6 }, turns: 5 }],
		});
		expect(ledger.getDagRun("availability-recovery-dag")?.tasks[0]?.attemptRecords).toHaveLength(1);
		expect(
			ledger.listDagEvents("availability-recovery-dag").filter((event) => event.type === "task.requeued"),
		).toHaveLength(4);
		expect(JSON.stringify(ledger.inspectDagRun("availability-recovery-dag"))).not.toContain(
			"UND_ERR_CONNECT_TIMEOUT",
		);
		ledger.close();
	});

	it("feeds bounded repair diagnostics into retry attempts while preserving terminal input failures", async () => {
		const fixture = await repository();
		const repairLedger = new RunLedger(":memory:");
		let repairCalls = 0;
		const repair = new SubagentDagOrchestrator({
			ledger: repairLedger,
			policy: policy(),
			createRunId: () => "repair-feedback-dag",
			runTask: async (options) => {
				repairCalls++;
				if (repairCalls === 1) {
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason: "invalid_handoff",
						error: "missing structured outcome",
						usage: usage(),
						turns: 1,
					};
				}
				expect(options.retryFeedback).toContain("invalid_handoff");
				expect(options.retryFeedback).toContain("missing structured outcome");
				return success(options.task);
			},
		});
		await repair.start({
			repositoryPath: fixture.root,
			request: request([{ id: "repair", role: "analyst", objective: "repair", maxAttempts: 2 }]),
		});
		expect(repairCalls).toBe(2);
		repairLedger.close();

		await writeFile(join(fixture.root, ".gitignore"), "node_modules/\n");
		await git(fixture.root, "add", ".gitignore");
		await git(fixture.root, "commit", "-q", "-m", "ignore dependencies");
		const pathLedger = new RunLedger(":memory:");
		let pathCalls = 0;
		const attemptWorkspaces: string[] = [];
		const pathRepair = new SubagentDagOrchestrator({
			ledger: pathLedger,
			policy: policy(),
			createRunId: () => "path-repair-dag",
			runTask: async (options) => {
				pathCalls++;
				attemptWorkspaces.push(options.snapshotPath);
				if (pathCalls === 1) {
					await mkdir(join(options.snapshotPath, "node_modules"), { recursive: true });
					await writeFile(join(options.snapshotPath, "node_modules", "ignored.txt"), "untrusted dependency\n");
					await writeFile(join(options.snapshotPath, "outside-change.txt"), "outside ownership\n");
					return success(options.task, ["owned.txt"]);
				}
				expect(options.retryFeedback).toContain("path_violation");
				expect(options.retryFeedback).toContain("Changed path is outside owned paths: outside-change.txt");
				await expect(access(join(options.snapshotPath, "node_modules", "ignored.txt"))).rejects.toThrow();
				await expect(access(join(options.snapshotPath, "outside-change.txt"))).rejects.toThrow();
				await writeFile(join(options.snapshotPath, "owned.txt"), "repaired\n");
				return success(options.task, ["owned.txt"]);
			},
		});
		const pathDetails = await pathRepair.start({
			repositoryPath: fixture.root,
			request: request([
				{
					id: "writer",
					role: "writer",
					objective: "repair path violation",
					maxAttempts: 2,
					ownedPaths: ["owned.txt"],
				},
			]),
		});
		expect(pathDetails).toMatchObject({ status: "succeeded", tasks: [{ attempts: 2 }] });
		expect(pathCalls).toBe(2);
		expect(attemptWorkspaces[0]).not.toBe(attemptWorkspaces[1]);
		pathLedger.close();

		const terminalLedger = new RunLedger(":memory:");
		let terminalCalls = 0;
		const terminal = new SubagentDagOrchestrator({
			ledger: terminalLedger,
			policy: policy(),
			createRunId: () => "terminal-task-rejected-dag",
			runTask: async (options) => {
				terminalCalls++;
				return {
					taskId: options.task.id,
					role: options.task.role,
					success: false,
					terminalReason: "task_rejected",
					error: "acceptance criteria are known not to be satisfied",
					usage: usage(),
					turns: 1,
				};
			},
		});
		await expect(
			terminal.start({
				repositoryPath: fixture.root,
				request: request([{ id: "terminal", role: "analyst", objective: "terminal", maxAttempts: 2 }]),
			}),
		).rejects.toBeInstanceOf(SubagentDagRunError);
		expect(terminalCalls).toBe(1);
		terminalLedger.close();
	});

	it("feeds bounded validation stderr and exit status into the Writer repair attempt", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let calls = 0;
		const selectedPolicy = candidatePolicy();
		const validationRegistry = new ValidationRegistry([
			{
				id: CANDIDATE_VALIDATION_ID,
				command: process.execPath,
				args: [
					"-e",
					"const fs=require('node:fs'); if(fs.readFileSync('owned.txt','utf8')!=='good\\n'){console.error('ASSERTION_SENTINEL bad output'); process.exit(7)}",
				],
				timeoutMs: 2_000,
				maxOutputBytes: 4_096,
			},
		]);
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			validationRegistry,
			createRunId: () => "validation-feedback-dag",
			runTask: async (options) => {
				calls++;
				if (calls === 2) {
					expect(options.retryFeedback).toContain("validation_failed");
					expect(options.retryFeedback).toContain("exitCode=7");
					expect(options.retryFeedback).toContain("ASSERTION_SENTINEL bad output");
					expect(options.retryFeedback).toContain("untrustedOutput");
				}
				await writeFile(join(options.snapshotPath, "owned.txt"), calls === 1 ? "bad\n" : "good\n");
				return success(options.task, ["owned.txt"]);
			},
		});
		const details = await orchestrator.start({
			repositoryPath: fixture.root,
			request: request(
				[
					{
						id: "writer",
						role: "writer",
						objective: "repair validation",
						maxAttempts: 2,
						ownedPaths: ["owned.txt"],
						validationCommandIds: [CANDIDATE_VALIDATION_ID],
					},
				],
				false,
				selectedPolicy,
			),
		});
		expect(details).toMatchObject({ status: "succeeded", tasks: [{ attempts: 2 }] });
		ledger.close();
	});

	it.each([
		["technical failure", "model_error", undefined],
		["single-task cancellation", "cancelled", undefined],
		["rejected outcome", undefined, "rejected"],
		["inconclusive outcome", undefined, "inconclusive"],
	] as const)("localizes %s to its dependency branch", async (_label, terminalReason, semanticOutcome) => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const calls: string[] = [];
		const selectedPolicy = policy({ maxConcurrency: 1 });
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => `localized-${terminalReason ?? semanticOutcome}-dag`,
			...fastReaderWorkspace(fixture),
			runTask: async (options) => {
				calls.push(options.task.id);
				if (options.task.id !== "negative") return success(options.task);
				if (terminalReason) {
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason,
						error: `terminal ${terminalReason}`,
						usage: usage(),
						turns: 1,
					};
				}
				const accepted = success(options.task);
				return {
					...accepted,
					handoff: { ...accepted.handoff!, outcome: semanticOutcome! },
				};
			},
		});
		const failure = await orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request(
					[
						{ id: "negative", role: "analyst", objective: "negative", maxAttempts: 1 },
						{ id: "descendant", role: "analyst", objective: "descendant", dependsOn: ["negative"] },
						{ id: "independent", role: "analyst", objective: "independent" },
					],
					false,
					selectedPolicy,
				),
			})
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(SubagentDagRunError);
		expect(calls).toEqual(["negative", "independent"]);
		expect((failure as SubagentDagRunError).details.tasks).toMatchObject([
			{
				taskId: "negative",
				status: semanticOutcome ? "succeeded" : terminalReason === "cancelled" ? "cancelled" : "failed",
			},
			{ taskId: "descendant", status: "blocked", terminalReason: "dependency_failed" },
			{ taskId: "independent", status: "succeeded" },
		]);
		ledger.close();
	});

	it("preserves a negative reviewer artifact but fails the run semantically", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const compiled = request([{ id: "review", role: "reviewer", objective: "review" }]);
		compiled.childModels = { reviewer: { provider: "trusted", model: "review-model" } };
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "negative-review-dag",
			runTask: async (options) => {
				expect(options.childModel).toEqual({ provider: "trusted", model: "review-model" });
				const result = success(options.task);
				return {
					...result,
					isolationLevel: "tool-bounded",
					handoff: { ...result.handoff!, outcome: "rejected", verificationLevel: "self_reported" },
				};
			},
		});
		const failure = await orchestrator
			.start({ repositoryPath: fixture.root, request: compiled })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		expect((failure as SubagentDagRunError).details.tasks[0]).toMatchObject({
			status: "succeeded",
			artifact: {
				quality: {
					semanticOutcome: "rejected",
					review: { status: "rejected", writerCommitClosure: [] },
				},
				execution: { model: "fake/model", isolationLevel: "tool-bounded" },
			},
		});
		expect((failure as Error).message).toContain("semantic outcome rejected");
		ledger.close();
	});

	it("keeps an explicit inconclusive Analyst artifact fail-closed", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "inconclusive-analysis-dag",
			runTask: async (options) => {
				const result = success(options.task);
				return { ...result, handoff: { ...result.handoff!, outcome: "inconclusive" } };
			},
		});
		const failure = await orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request([{ id: "analysis", role: "analyst", objective: "analyze" }]),
			})
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(SubagentDagRunError);
		expect((failure as SubagentDagRunError).details.tasks[0]).toMatchObject({
			status: "succeeded",
			artifact: { quality: { semanticOutcome: "inconclusive" } },
		});
		expect((failure as Error).message).toContain("semantic outcome inconclusive");
		ledger.close();
	});

	it("fails closed after retry exhaustion and leaves descendants blocked", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "failed-dag",
			runTask: async (options) => ({
				taskId: options.task.id,
				role: options.task.role,
				success: false,
				terminalReason: "model_error",
				error: "terminal",
				usage: usage(),
				turns: 1,
			}),
		});
		const failure = await orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request([
					{ id: "root", role: "analyst", objective: "root" },
					{ id: "child", role: "analyst", objective: "child", dependsOn: ["root"] },
				]),
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		expect((failure as SubagentDagRunError).details.tasks.map((task) => task.status)).toEqual(["failed", "blocked"]);
		expect((failure as SubagentDagRunError).details.integration).toBeUndefined();
		ledger.close();
	});

	it("replays a durable artifact-ready checkpoint without rerunning the child", async () => {
		const fixture = await repository();
		const databasePath = ledgerFile(fixture.root);
		temporaryPaths.push(databasePath);
		const selectedPolicy = policy({ leaseDurationMs: 20 });
		let ledger = new RunLedger(databasePath);
		ledger.completeDagTask = (() => {
			throw new Error("simulated controller crash after artifact checkpoint");
		}) as RunLedger["completeDagTask"];
		let calls = 0;
		const first = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "checkpoint-dag",
			// A fixed clock keeps the short lease valid for the whole first attempt so
			// the injected crash, not a load-dependent lease race, terminates start().
			now: () => 1_000_000,
			runTask: async (options) => {
				calls++;
				return success(options.task);
			},
		});
		await expect(
			first.start({
				repositoryPath: fixture.root,
				request: request(
					[{ id: "inspect", role: "analyst", objective: "inspect", maxAttempts: 1 }],
					false,
					selectedPolicy,
				),
			}),
		).rejects.toThrow("simulated controller crash");
		expect(ledger.getDagRun("checkpoint-dag")?.tasks[0]?.checkpoint).toMatchObject({ phase: "artifact_ready" });
		ledger.close();

		ledger = new RunLedger(databasePath);
		const resumed = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			// A later fixed clock observes the crashed controller's lease as expired.
			now: () => 2_000_000,
			runTask: async () => {
				throw new Error("child must not rerun after artifact_ready");
			},
		});
		const details = await resumed.resume({ runId: "checkpoint-dag" });
		expect(details.status).toBe("succeeded");
		expect(calls).toBe(1);
		expect(details.tasks[0]?.attempts).toBe(1);
		ledger.close();
	});

	it("terminalizes a persisted integration failure on resume after a crash boundary", async () => {
		const fixture = await repository();
		const databasePath = ledgerFile(fixture.root);
		temporaryPaths.push(databasePath);
		let ledger = new RunLedger(databasePath);
		const originalSetStatus = ledger.setDagRunStatus.bind(ledger);
		ledger.setDagRunStatus = ((runId, status, now, lease) => {
			if (status === "failed") throw new Error("simulated crash after integration failure persistence");
			return originalSetStatus(runId, status, now, lease);
		}) as RunLedger["setDagRunStatus"];
		const first = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "integration-failure-dag",
			runTask: async (options) => success(options.task),
			mergeTaskCommits: async () => {
				throw new MergeConflictError("writer", "conflict diagnostics");
			},
		});
		await expect(
			first.start({
				repositoryPath: fixture.root,
				request: request([{ id: "inspect", role: "analyst", objective: "inspect" }], true),
			}),
		).rejects.toThrow("simulated crash");
		expect(ledger.getDagRun("integration-failure-dag")).toMatchObject({
			status: "running",
			integrationFailure: { reason: "merge_conflict", taskId: "writer" },
		});
		ledger.close();

		ledger = new RunLedger(databasePath);
		const resumed = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			runTask: async () => {
				throw new Error("completed child must not rerun");
			},
		});
		const failure = await resumed.resume({ runId: "integration-failure-dag" }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		expect((failure as SubagentDagRunError).details).toMatchObject({
			status: "failed",
			integrationFailure: { reason: "merge_conflict", diagnostics: "conflict diagnostics" },
		});
		ledger.close();
	});

	it("pauses a structured provider circuit and resumes the same route, accounting, attempt, and runtime after its delay", async () => {
		const fixture = await repository();
		const initialNow = Date.now();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(initialNow);
		const selectedPolicy = policy({ leaseDurationMs: 1_000_000_000 });
		const ledger = new RunLedger(":memory:");
		const firstRuntime = {
			provider: "trusted",
			model: "original-model",
			thinkingLevel: "high" as const,
			isolationLevel: "tool-bounded" as const,
			sessionId: "provider-circuit-session",
			sessionFile: "/private/provider-circuit-session.jsonl",
			runtimeRoot: "/private/provider-circuit-runtime",
			runtimeRootId: "provider-circuit-runtime-id",
			runtimeGeneration: 3,
			lastEventSeq: 20,
		};
		let calls = 0;
		const routes: unknown[] = [];
		const resumeRuntimes: unknown[] = [];
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "provider-circuit-dag",
			...fastReaderWorkspace(fixture),
			runTask: async (options) => {
				calls++;
				routes.push(options.childModel);
				resumeRuntimes.push(options.resumeRuntime);
				if (calls === 1) {
					const child = { metadata: firstRuntime, closed: false } as unknown as ChildAgentRuntime;
					options.onRuntimeReady?.(child, firstRuntime);
					options.onRuntimeClosed?.(child, firstRuntime);
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason: "provider_circuit_open",
						error: "content-free provider circuit",
						usage: usage(20, 0.2),
						turns: 2,
						runtime: firstRuntime,
						providerCircuitOpen: {
							version: 1,
							reason: "unlimited_auto_retry",
							autoRetryAttempt: 8,
							consecutiveUnlimitedRetries: 8,
							retryDelayMs: 500,
						},
					};
				}
				expect(options.resumeRuntime).toMatchObject({
					sessionId: "provider-circuit-session",
					sessionFile: "/private/provider-circuit-session.jsonl",
					runtimeGeneration: 3,
					lastEventSeq: 20,
				});
				const resumedRuntime = { ...firstRuntime, runtimeGeneration: 4, lastEventSeq: 30 };
				const child = { metadata: resumedRuntime, closed: false } as unknown as ChildAgentRuntime;
				options.onRuntimeReady?.(child, resumedRuntime);
				options.onRuntimeClosed?.(child, resumedRuntime);
				return { ...success(options.task), usage: usage(3, 0.03), turns: 1, runtime: resumedRuntime };
			},
		});
		const compiled = request(
			[{ id: "inspect", role: "analyst", objective: "inspect", maxAttempts: 1 }],
			false,
			selectedPolicy,
		);
		compiled.budget = { maxTokens: 100 };
		compiled.childModels = {
			analyst: { provider: "trusted", model: "original-model", thinkingLevel: "high" },
		};

		const paused = await orchestrator.start({ repositoryPath: fixture.root, request: compiled });
		expect(paused).toMatchObject({
			status: "running",
			pausedAt: expect.any(Number),
			usage: { totalTokens: 20 },
			tasks: [
				{
					status: "pending",
					attempts: 1,
					providerCircuitOpen: {
						reason: "unlimited_auto_retry",
						retryNotBefore: initialNow + 500,
					},
				},
			],
		});
		expect(ledger.listDagEvents("provider-circuit-dag").map((event) => event.type)).toEqual(
			expect.arrayContaining(["provider.circuit_open", "run.paused"]),
		);
		const circuitEvent = ledger
			.listDagEvents("provider-circuit-dag")
			.find((event) => event.type === "provider.circuit_open");
		expect(JSON.stringify(circuitEvent)).not.toContain("content-free provider circuit");

		const resuming = orchestrator.resume({ runId: "provider-circuit-dag" });
		await flushUntil(
			() => ledger.getDagRun("provider-circuit-dag")?.pausedAt === undefined,
			"provider circuit resume to clear its pause",
		);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(499);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		const completed = await resuming;
		expect(completed).toMatchObject({
			status: "succeeded",
			usage: { totalTokens: 23 },
			tasks: [{ status: "succeeded", attempts: 1, usage: { totalTokens: 23 }, turns: 3 }],
		});
		expect(routes).toEqual([
			{ provider: "trusted", model: "original-model", thinkingLevel: "high" },
			{ provider: "trusted", model: "original-model", thinkingLevel: "high" },
		]);
		expect(resumeRuntimes[0]).toBeUndefined();
		expect(ledger.getDagRun("provider-circuit-dag")?.tasks[0]?.attemptRecords).toMatchObject([
			{ attemptNumber: 1, usage: { totalTokens: 23 }, turns: 3, runtime: { runtimeGeneration: 4 } },
		]);
		ledger.close();
	}, 20_000);

	it("interrupts resumable siblings before durably pausing a provider circuit", async () => {
		const fixture = await repository();
		const selectedPolicy = policy({ maxConcurrency: 2, leaseDurationMs: 1_000_000_000 });
		const ledger = new RunLedger(":memory:");
		let markSiblingStarted!: () => void;
		const siblingStarted = new Promise<void>((resolve) => {
			markSiblingStarted = resolve;
		});
		let siblingAborted = false;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "provider-circuit-sibling-dag",
			...fastReaderWorkspace(fixture),
			runTask: async (options) => {
				if (options.task.id === "circuit") {
					await siblingStarted;
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason: "provider_circuit_open",
						usage: usage(10, 0.1),
						turns: 2,
						providerCircuitOpen: {
							version: 1,
							reason: "unlimited_auto_retry",
							autoRetryAttempt: 1,
							consecutiveUnlimitedRetries: 1,
							retryDelayMs: 1_000,
						},
					};
				}
				markSiblingStarted();
				await new Promise<void>((resolve) =>
					options.signal?.addEventListener(
						"abort",
						() => {
							siblingAborted = true;
							resolve();
						},
						{ once: true },
					),
				);
				return {
					taskId: options.task.id,
					role: options.task.role,
					success: false,
					terminalReason: "cancelled",
					usage: usage(5, 0.05),
					turns: 1,
				};
			},
		});

		const paused = await orchestrator.start({
			repositoryPath: fixture.root,
			request: request(
				[
					{ id: "circuit", role: "analyst", objective: "open circuit", maxAttempts: 1 },
					{ id: "sibling", role: "analyst", objective: "remain resumable", maxAttempts: 1 },
				],
				false,
				selectedPolicy,
			),
		});
		expect(siblingAborted).toBe(true);
		expect(paused).toMatchObject({
			status: "running",
			pausedAt: expect.any(Number),
			usage: { totalTokens: 15 },
			tasks: [
				{ taskId: "circuit", status: "pending", attempts: 1 },
				{ taskId: "sibling", status: "pending", attempts: 1 },
			],
		});
		const checkpoints = ledger.getDagRun("provider-circuit-sibling-dag")?.tasks.map((task) => ({
			taskId: task.taskId,
			phase: (task.checkpoint as { phase?: string } | undefined)?.phase,
		}));
		expect(checkpoints).toEqual([
			{ taskId: "circuit", phase: "provider_circuit_open" },
			{ taskId: "sibling", phase: "interrupted" },
		]);
		ledger.close();
	});

	it("keeps an external-writer provider circuit terminal instead of replaying live side effects", async () => {
		const fixture = await repository();
		const externalRoot = await mkdtemp(join(tmpdir(), "subagent-external-circuit-"));
		temporaryPaths.push(externalRoot);
		const selectedPolicy = policy({ leaseDurationMs: 1_000_000_000 });
		const ledger = new RunLedger(":memory:");
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "external-provider-circuit-dag",
			runTask: async (options) => ({
				taskId: options.task.id,
				role: options.task.role,
				success: false,
				terminalReason: "provider_circuit_open",
				usage: usage(4, 0.04),
				turns: 1,
				providerCircuitOpen: {
					version: 1,
					reason: "unlimited_auto_retry",
					autoRetryAttempt: 1,
					consecutiveUnlimitedRetries: 1,
					retryDelayMs: 1_000,
				},
			}),
		});

		const failure = await orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request(
					[
						{
							id: "publish",
							role: "external-writer",
							objective: "publish once",
							externalOwnedPaths: [externalRoot],
						},
					],
					false,
					selectedPolicy,
				),
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SubagentDagRunError);
		expect((failure as SubagentDagRunError).details).toMatchObject({
			status: "failed",
			tasks: [{ taskId: "publish", status: "failed", terminalReason: "provider_circuit_open" }],
		});
		expect((failure as SubagentDagRunError).details.pausedAt).toBeUndefined();
		expect(ledger.listDagEvents("external-provider-circuit-dag").map((event) => event.type)).not.toContain(
			"provider.circuit_open",
		);
		ledger.close();
	});

	it("rejects pause before aborting an active external-writer", async () => {
		const fixture = await repository();
		const externalRoot = await mkdtemp(join(tmpdir(), "subagent-external-pause-"));
		temporaryPaths.push(externalRoot);
		const selectedPolicy = policy({ leaseDurationMs: 100 });
		const ledger = new RunLedger(":memory:");
		let releaseStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		let runnerSignal: AbortSignal | undefined;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "external-pause-dag",
			runTask: async (options) => {
				runnerSignal = options.signal;
				releaseStarted();
				return await new Promise<ChildTaskResult>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() =>
							resolve({
								taskId: options.task.id,
								role: options.task.role,
								success: false,
								terminalReason: "cancelled",
								error: "cancelled",
								usage: usage(),
								turns: 1,
							}),
						{ once: true },
					);
				});
			},
		});
		const running = orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request(
					[
						{
							id: "publish",
							role: "external-writer",
							objective: "publish",
							externalOwnedPaths: [externalRoot],
						},
					],
					false,
					selectedPolicy,
				),
			})
			.catch((error: unknown) => error);
		await started;
		await expect(orchestrator.pause({ runId: "external-pause-dag" })).rejects.toThrow(
			"cannot pause while external-writer",
		);
		expect(runnerSignal?.aborted).toBe(false);
		await orchestrator.cancel({ runId: "external-pause-dag" });
		await running;
		ledger.close();
	});

	it("removes a preserved Child runtime root on explicit terminal cancel", async () => {
		const fixture = await repository();
		const runtimeRoot = await realpath(await mkdtemp(join(tmpdir(), "wj-pi-child-cancel-test-")));
		temporaryPaths.push(runtimeRoot);
		const runtimeRootId = "cancel-runtime-owner";
		await writeFile(
			join(runtimeRoot, ".wj-pi-runtime-owner.json"),
			`${JSON.stringify({ version: 1, id: runtimeRootId })}\n`,
		);
		const ledger = new RunLedger(":memory:");
		let releaseStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "cancel-runtime-dag",
			runTask: async (options) => {
				releaseStarted();
				return await new Promise<ChildTaskResult>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() =>
							resolve({
								taskId: options.task.id,
								role: options.task.role,
								success: false,
								terminalReason: "cancelled",
								error: "cancelled",
								usage: usage(),
								turns: 1,
								runtime: {
									isolationLevel: "tool-bounded",
									runtimeGeneration: 1,
									lastEventSeq: 1,
									runtimeRoot,
									runtimeRootId,
								},
							}),
						{ once: true },
					);
				});
			},
		});
		const running = orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request([{ id: "inspect", role: "analyst", objective: "inspect" }]),
			})
			.catch((error: unknown) => error);
		await started;
		await orchestrator.cancel({ runId: "cancel-runtime-dag" });
		await running;
		await expect(access(runtimeRoot)).rejects.toThrow();
		ledger.close();
	});

	it("pauses an active max-attempt-one run and resumes the same durable attempt", async () => {
		const fixture = await repository();
		const selectedPolicy = policy();
		const ledger = new RunLedger(ledgerFile(fixture.root));
		temporaryPaths.push(ledgerFile(fixture.root));
		let releaseStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		let calls = 0;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "paused-dag",
			runTask: async (options) => {
				calls++;
				if (calls > 1) return success(options.task);
				releaseStarted();
				return await new Promise<ChildTaskResult>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() =>
							resolve({
								taskId: options.task.id,
								role: options.task.role,
								success: false,
								terminalReason: "cancelled",
								error: "paused",
								usage: usage(),
								turns: 1,
							}),
						{ once: true },
					);
				});
			},
		});
		const running = orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request(
					[{ id: "only", role: "analyst", objective: "only", maxAttempts: 1 }],
					false,
					selectedPolicy,
				),
			})
			.catch((error: unknown) => error);
		await started;
		const paused = await orchestrator.pause({ runId: "paused-dag" });
		expect(await running).toBeInstanceOf(DagRunInterruptedError);
		expect(paused).toMatchObject({ status: "running", pausedAt: expect.any(Number), tasks: [{ attempts: 1 }] });
		const resumed = await orchestrator.resume({ runId: "paused-dag" });
		expect(resumed).toMatchObject({ status: "succeeded", tasks: [{ attempts: 1 }] });
		expect(resumed.pausedAt).toBeUndefined();
		expect(resumed.pausedDurationMs).toBeGreaterThanOrEqual(0);
		expect(calls).toBe(2);
		expect(ledger.getDagRun("paused-dag")?.tasks[0]?.attemptRecords).toHaveLength(1);
		expect(ledger.listDagEvents("paused-dag").map((event) => event.type)).toEqual(
			expect.arrayContaining(["run.paused", "run.resumed"]),
		);
		ledger.close();
	});

	it("carries cumulative token, cost, and turn usage across repeated pauses of one attempt", async () => {
		const fixture = await repository();
		const selectedPolicy = policy();
		const ledger = new RunLedger(ledgerFile(fixture.root));
		temporaryPaths.push(ledgerFile(fixture.root));
		let releaseStarted!: () => void;
		let started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		let calls = 0;
		const budgets: Array<{ maxTokens: number; softTokenLimit?: number }> = [];
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "repeated-pause-dag",
			runTask: async (options) => {
				calls++;
				budgets.push({
					maxTokens: options.budget.maxTokens,
					...(options.softTokenLimit === undefined ? {} : { softTokenLimit: options.softTokenLimit }),
				});
				if (calls < 3) {
					releaseStarted();
					await new Promise<void>((resolve) =>
						options.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
					const tokens = calls === 1 ? 40 : 50;
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason: "cancelled",
						error: "paused",
						usage: usage(tokens, tokens / 100),
						turns: calls === 1 ? 2 : 3,
					};
				}
				const result = success(options.task);
				return { ...result, usage: usage(10, 0.1), turns: 1 };
			},
		});
		const compiled = request(
			[{ id: "only", role: "analyst", objective: "only", maxAttempts: 1 }],
			false,
			selectedPolicy,
		);
		compiled.budget = { ...compiled.budget, maxTokens: 100 };
		const first = orchestrator
			.start({ repositoryPath: fixture.root, request: compiled })
			.catch((error: unknown) => error);
		await started;
		await orchestrator.pause({ runId: "repeated-pause-dag" });
		expect(await first).toBeInstanceOf(DagRunInterruptedError);

		started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		const second = orchestrator.resume({ runId: "repeated-pause-dag" }).catch((error: unknown) => error);
		await started;
		await orchestrator.pause({ runId: "repeated-pause-dag" });
		expect(await second).toBeInstanceOf(DagRunInterruptedError);

		const completed = await orchestrator.resume({ runId: "repeated-pause-dag" });
		expect(completed.status).toBe("succeeded");
		expect(completed.tasks[0]?.attempts).toBe(1);
		expect(completed.usage.totalTokens).toBe(100);
		expect(completed.tasks[0]).toMatchObject({ usage: { totalTokens: 100 }, turns: 6 });
		const persistedAccounting = ledger.getDagRun("repeated-pause-dag");
		expect(persistedAccounting).toMatchObject({ usage: { totalTokens: 100 }, turns: 6 });
		expect(persistedAccounting?.tasks[0]?.attemptRecords).toMatchObject([
			{ attemptNumber: 1, usage: { totalTokens: 100 }, turns: 6 },
		]);
		expect(budgets).toHaveLength(3);
		// Token budget shrinks by actual consumed tokens across pauses; turns/cost
		// remain accounting data, not budget dimensions.
		expect(budgets[0]).toEqual({ maxTokens: 100, softTokenLimit: 90 });
		expect(budgets[1]).toEqual({ maxTokens: 60, softTokenLimit: 50 });
		expect(budgets[2]).toEqual({ maxTokens: 10 });
		ledger.close();
	});

	it("defers pause across writer quality so completed model work is not rerun", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let releaseQuality!: () => void;
		const qualityRelease = new Promise<void>((resolve) => {
			releaseQuality = resolve;
		});
		let qualityStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			qualityStarted = resolve;
		});
		let runnerCalls = 0;
		const validationSandboxLauncher = { command: process.execPath, prefixArgs: ["validation-launcher"] };
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			validationSandboxLauncher,
			createRunId: () => "pause-quality-dag",
			runTask: async (options) => {
				runnerCalls++;
				await writeFile(join(options.snapshotPath, "quality.txt"), "quality\n");
				return success(options.task, ["quality.txt"]);
			},
			validateAndCommitWriterTask: async (options) => {
				expect(options.sandboxLauncher).toBe(validationSandboxLauncher);
				qualityStarted();
				await qualityRelease;
				return await validateAndCommitWriterTask(options);
			},
		});
		const running = orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request([
					{ id: "write", role: "writer", objective: "write", maxAttempts: 1, ownedPaths: ["quality.txt"] },
				]),
			})
			.catch((error: unknown) => error);
		await started;
		const pausing = orchestrator.pause({ runId: "pause-quality-dag" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(ledger.getDagRun("pause-quality-dag")?.status).toBe("running");
		releaseQuality();
		const paused = await pausing;
		expect(await running).toBeInstanceOf(DagRunInterruptedError);
		expect(paused).toMatchObject({
			status: "running",
			pausedAt: expect.any(Number),
			tasks: [{ status: "succeeded" }],
		});
		const resumed = await orchestrator.resume({ runId: "pause-quality-dag" });
		expect(resumed.status).toBe("succeeded");
		expect(runnerCalls).toBe(1);
		expect(resumed.usage.totalTokens).toBe(2);
		const samples = ledger
			.inspectDagRun("pause-quality-dag")!
			.events.filter((event) => event.type === "attempt.performance");
		expect(samples).toHaveLength(1);
		expect(samples[0]?.payload).toMatchObject({
			success: true,
			terminalReason: "completed",
			stages: {
				writer_audit: expect.any(Number),
				validation: expect.any(Number),
				commit: expect.any(Number),
			},
		});
		ledger.close();
	});

	it("keeps max-attempt-one resumable when pause interrupts pre-runner workspace setup", async () => {
		const fixture = await repository();
		const selectedPolicy = policy({ leaseDurationMs: 30_000 });
		const ledger = new RunLedger(ledgerFile(fixture.root));
		temporaryPaths.push(ledgerFile(fixture.root));
		let releaseStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		let snapshotCalls = 0;
		let runnerCalls = 0;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "paused-setup-dag",
			createSnapshot: async (repositoryPath, _policy, signal) => {
				snapshotCalls++;
				if (snapshotCalls === 1) {
					releaseStarted();
					await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
					const error = new Error("setup interrupted");
					error.name = "AbortError";
					throw error;
				}
				return {
					path: repositoryPath,
					baseline: {
						repositoryRoot: repositoryPath,
						headCommit: fixture.head,
						snapshotId: "resumed-snapshot",
						fileCount: 1,
						totalBytes: 1,
					},
					cleanup: async () => undefined,
				};
			},
			runTask: async (options) => {
				runnerCalls++;
				return success(options.task);
			},
		});
		const running = orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request(
					[{ id: "only", role: "analyst", objective: "only", maxAttempts: 1 }],
					false,
					selectedPolicy,
				),
			})
			.catch((error: unknown) => error);
		await started;
		const paused = await orchestrator.pause({ runId: "paused-setup-dag" });
		expect(await running).toBeInstanceOf(DagRunInterruptedError);
		expect(paused).toMatchObject({
			status: "running",
			pausedAt: expect.any(Number),
			tasks: [{ status: "pending", attempts: 1 }],
		});
		expect(ledger.getDagRun("paused-setup-dag")?.tasks[0]?.attemptRecords).toMatchObject([
			{ status: "expired", terminalReason: "interrupted", error: "Attempt interrupted by DAG pause" },
		]);
		const resumed = await orchestrator.resume({ runId: "paused-setup-dag" });
		expect(resumed).toMatchObject({ status: "succeeded", tasks: [{ attempts: 1 }] });
		expect(snapshotCalls).toBe(2);
		expect(runnerCalls).toBe(1);
		expect(ledger.getDagRun("paused-setup-dag")?.tasks[0]?.attemptRecords).toHaveLength(1);
		ledger.close();
	});

	it("cancels one active run terminally and keeps pause distinct", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let releaseStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "cancelled-dag",
			runTask: async (options) => {
				releaseStarted();
				return await new Promise<ChildTaskResult>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() =>
							resolve({
								taskId: options.task.id,
								role: options.task.role,
								success: false,
								terminalReason: "cancelled",
								usage: usage(),
								turns: 1,
							}),
						{ once: true },
					);
				});
			},
		});
		const running = orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request([{ id: "only", role: "analyst", objective: "only" }]),
			})
			.catch((error: unknown) => error);
		await started;
		const cancelled = await orchestrator.cancel({ runId: "cancelled-dag" });
		expect(await running).toBeInstanceOf(SubagentDagRunError);
		expect(cancelled).toMatchObject({ status: "cancelled", tasks: [{ status: "cancelled" }] });
		expect(await orchestrator.cancel({ runId: "cancelled-dag" })).toEqual(cancelled);
		await expect(orchestrator.resume({ runId: "cancelled-dag" })).rejects.toBeInstanceOf(SubagentDagRunError);
		ledger.close();
	});

	it("makes terminal cancel win a concurrent race with resumable pause", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let releaseStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			policy: policy(),
			createRunId: () => "pause-cancel-race",
			runTask: async (options) => {
				releaseStarted();
				await new Promise<void>((resolve) =>
					options.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return {
					taskId: options.task.id,
					role: options.task.role,
					success: false,
					terminalReason: "cancelled",
					usage: usage(),
					turns: 1,
				};
			},
		});
		const running = orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request([{ id: "only", role: "analyst", objective: "only" }]),
			})
			.catch((error: unknown) => error);
		await started;
		const pausing = orchestrator.pause({ runId: "pause-cancel-race" });
		const cancelling = orchestrator.cancel({ runId: "pause-cancel-race" });
		const [pauseResult, cancelResult] = await Promise.all([pausing, cancelling]);
		expect(await running).toBeInstanceOf(SubagentDagRunError);
		expect(pauseResult.status).toBe("cancelled");
		expect(cancelResult.status).toBe("cancelled");
		expect(ledger.getDagRun("pause-cancel-race")?.pausedAt).toBeUndefined();
		ledger.close();
	});

	it("preserves an interrupted Writer until the user explicitly discards its result", async () => {
		const fixture = await repository();
		const ledger = new RunLedger(":memory:");
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		let path = "";
		let clock = 1000;
		const orchestrator = new SubagentDagOrchestrator({
			ledger,
			now: () => clock,
			policy: policy({ leaseDurationMs: 30 }),
			createRunId: () => "retain-writer",
			runTask: async (options) => {
				path = options.snapshotPath;
				await writeFile(join(path, "draft.txt"), "undelivered\n");
				ready();
				return new Promise<ChildTaskResult>((resolve) =>
					options.signal?.addEventListener(
						"abort",
						() =>
							resolve({
								taskId: options.task.id,
								role: options.task.role,
								success: false,
								terminalReason: "cancelled",
								usage: usage(),
								turns: 1,
							}),
						{ once: true },
					),
				);
			},
		});
		const running = orchestrator
			.start({
				repositoryPath: fixture.root,
				request: request([{ id: "writer", role: "writer", objective: "Draft", ownedPaths: ["draft.txt"] }]),
			})
			.catch((error) => error);
		await started;
		await expect(orchestrator.shutdown()).rejects.toBeInstanceOf(DagRunInterruptedError);
		expect(await running).toBeInstanceOf(DagRunInterruptedError);
		expect(await readFile(join(path, "draft.txt"), "utf8")).toBe("undelivered\n");
		await expect(reconcileTaskWorktrees(fixture.root, "retain-writer", "writer")).rejects.toThrow(/retained/);
		clock = 2000;
		const cleanup = new SubagentDagOrchestrator({ ledger, now: () => clock, policy: policy() });
		await cleanupConfirmedRun(cleanup, "retain-writer", "discard", (id, intent) =>
			ledger.confirmDagCleanup(id, intent),
		);
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(ledger.getDagRun("retain-writer")?.resources.pins).toBe("released");
		ledger.close();
	});

	it("shuts down without completing an active attempt, then resumes after lease expiry without rerunning success", async () => {
		const fixture = await repository();
		const databasePath = ledgerFile(fixture.root);
		temporaryPaths.push(databasePath);
		const selectedPolicy = policy({ leaseDurationMs: 30 });
		const ledger = new RunLedger(databasePath);
		let releaseStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		const calls: string[] = [];
		const first = new SubagentDagOrchestrator({
			ledger,
			policy: selectedPolicy,
			createRunId: () => "resume-dag",
			runTask: async (options) => {
				calls.push(options.task.id);
				if (options.task.id === "done") return success(options.task);
				releaseStarted();
				return await new Promise<ChildTaskResult>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() =>
							resolve({
								taskId: options.task.id,
								role: options.task.role,
								success: false,
								terminalReason: "cancelled",
								error: "interrupted",
								usage: usage(),
								turns: 1,
							}),
						{ once: true },
					);
				});
			},
		});
		const running = first.start({
			repositoryPath: fixture.root,
			request: request(
				[
					{ id: "done", role: "analyst", objective: "done" },
					{ id: "active", role: "analyst", objective: "active", dependsOn: ["done"], maxAttempts: 2 },
				],
				false,
				selectedPolicy,
			),
		});
		const runningResult = running.catch((error: unknown) => error);
		await started;
		const secondLedger = new RunLedger(databasePath);
		let resumedCalls = 0;
		const resumed = new SubagentDagOrchestrator({
			ledger: secondLedger,
			policy: selectedPolicy,
			runTask: async (options) => {
				resumedCalls++;
				calls.push(options.task.id);
				return success(options.task);
			},
		});
		const resuming = resumed.resume({ runId: "resume-dag" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(resumedCalls).toBe(0);

		await expect(first.shutdown()).rejects.toBeInstanceOf(DagRunInterruptedError);
		expect(await runningResult).toBeInstanceOf(DagRunInterruptedError);
		expect(ledger.getDagRun("resume-dag")?.tasks.map((task) => task.status)).toEqual(["succeeded", "running"]);
		const details = await resuming;
		expect(details.status).toBe("succeeded");
		expect(calls.filter((id) => id === "done")).toHaveLength(1);
		expect(calls.filter((id) => id === "active")).toHaveLength(2);
		expect(resumed.inspect("resume-dag")).toEqual(details);
		expect(() => resumed.inspect("unknown")).toThrow("Unknown DAG run");
		ledger.close();
		secondLedger.close();
	});
});
