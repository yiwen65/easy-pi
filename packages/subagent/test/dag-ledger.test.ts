import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Usage } from "@earendil-works/pi-ai";
import {
	createExternalMutationJournal,
	ExternalMutationJournalReader,
	ExternalMutationJournalWriter,
} from "@easy-pi/permissions/journal";
import { afterEach, describe, expect, it } from "vitest";
import { RunLedger } from "../src/ledger.ts";
import { evaluatePartialCandidateQuality } from "../src/quality-model.ts";
import type {
	CandidateQuality,
	CompiledSubagentDagRequest,
	DagTaskContract,
	IntegrationArtifact,
	SnapshotBaseline,
	TaskArtifact,
} from "../src/types.ts";

const temporaryPaths: string[] = [];

const baseline: SnapshotBaseline = {
	repositoryRoot: "/repo",
	headCommit: "0123456789abcdef",
	snapshotId: "snapshot-id",
	fileCount: 2,
	totalBytes: 20,
};

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 18,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

function readTask(id: string, dependsOn: string[] = [], maxAttempts = 2): DagTaskContract {
	return {
		id,
		role: "scout",
		objective: `Inspect ${id}`,
		nonGoals: [],
		readPaths: ["src"],
		acceptance: ["Report evidence"],
		dependsOn,
		maxAttempts,
		contractHash: `${id}-hash`,
	};
}

function writerTask(id: string, dependsOn: string[]): DagTaskContract {
	return {
		id,
		role: "writer",
		objective: `Implement ${id}`,
		nonGoals: [],
		readPaths: ["src"],
		acceptance: ["Tests pass"],
		dependsOn,
		maxAttempts: 2,
		contractHash: `${id}-hash`,
		ownedPaths: ["src/owned.ts"],
		validationCommandIds: ["unit"],
	};
}

function externalWriterTask(id: string, root: string): DagTaskContract {
	return {
		id,
		role: "external-writer",
		objective: `Publish ${id}`,
		nonGoals: [],
		readPaths: [],
		acceptance: ["Publish output"],
		dependsOn: [],
		maxAttempts: 1,
		contractHash: `${id}-hash`,
		externalOwnedPaths: [root],
	};
}

function request(tasks: DagTaskContract[], merge = false): CompiledSubagentDagRequest {
	return {
		version: 2,
		handoffProtocolVersion: 2,
		objective: "Execute a durable DAG",
		tasks,
		budget: {
			maxTokens: 10_000,
		},
		budgetScope: "task",
		merge: { enabled: merge, refPrefix: "pi/subagent/integration" },
		graph: { sealed: true },
	};
}

function artifact(task: DagTaskContract, id = `${task.id}-artifact`): TaskArtifact {
	const handoff = {
		taskId: task.id,
		summary: "Done",
		outcome: "accepted" as const,
		evidence: [],
		verification: [],
		assumptions: [],
		risks: [],
		nextActions: [],
		verificationLevel: "unverified" as const,
	};
	return {
		artifactVersion: 2,
		artifactId: id,
		taskId: task.id,
		contractHash: task.contractHash,
		handoff: task.role === "writer" ? { ...handoff, artifactVersion: 2, changedPaths: ["src/owned.ts"] } : handoff,
		changedPaths: task.role === "writer" ? ["src/owned.ts"] : [],
		validations:
			task.role === "writer"
				? [{ commandId: "unit", status: "passed", exitCode: 0, stdout: "", stderr: "", durationMs: 1 }]
				: [],
		quality:
			task.role === "writer"
				? {
						semanticOutcome: "accepted",
						pathAudit: "passed",
						validation: { status: "passed", passedCommandIds: ["unit"] },
						review: { status: "not_applicable" },
					}
				: {
						semanticOutcome: "accepted",
						pathAudit: "not_applicable",
						validation: { status: "not_applicable", passedCommandIds: [] },
						review: { status: "not_applicable" },
					},
		...(task.role === "writer" ? { commit: "writer-commit" } : {}),
		createdAt: 1_000,
	};
}

function passedCandidateQuality(taskId = "write"): CandidateQuality {
	const writer = { taskId, artifactId: `${taskId}-artifact`, commit: "writer-commit" };
	return {
		semanticOutcome: "accepted",
		pathAuditCoverage: "full",
		validationCoverage: "full",
		commitPinCoverage: "full",
		reviewCoverage: "none",
		reviewVerdict: "none",
		gate: "passed",
		gateFailures: [],
		writerTaskIds: [taskId],
		pathAuditedWriterTaskIds: [taskId],
		validatedWriterTaskIds: [taskId],
		pinnedWriterTaskIds: [taskId],
		reviewerTaskIds: [],
		acceptedReviewerTaskIds: [],
		fullCoverageReviewerTaskIds: [],
		requiredWriterCommits: [writer],
		reviewedWriterCommits: [],
	};
}

async function ledgerPath(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryPaths.push(directory);
	return join(directory, "runs.sqlite");
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RunLedger DAG persistence", () => {
	it("reports retry and foreign-lease eligibility without treating local claims as wakeups", () => {
		const ledger = new RunLedger(":memory:");
		const tasks = [readTask("retry"), readTask("foreign"), readTask("local")];
		ledger.createDagRun({ runId: "eligibility", request: request(tasks), baseline });
		ledger.setDagRunStatus("eligibility", "running", 1_000);
		const [retry] = ledger.claimRunnableTasks("eligibility", "owner-current", 1_001, 10_000, 1);
		ledger.completeDagTask(
			"eligibility",
			"retry",
			retry.attemptId,
			retry.ownerId,
			{ terminalReason: "process_error", error: "transient" },
			1_002,
		);
		const retryAt = ledger.nextDagRetryAt("eligibility")!;
		expect(
			ledger.listDagEvents("eligibility").find((event) => event.type === "task.requeued")?.payload,
		).toMatchObject({ retryNotBefore: retryAt });
		const [foreign] = ledger.claimRunnableTasks("eligibility", "owner-foreign", 1_003, 5_000, 1);
		expect(foreign.taskId).toBe("foreign");
		const [local] = ledger.claimRunnableTasks("eligibility", "owner-current", 1_004, 7_000, 1);
		expect(local.taskId).toBe("local");

		expect(ledger.nextDagTaskEligibility("eligibility", "owner-current")).toEqual({
			retryAt,
			foreignLeaseAt: foreign.leaseExpiresAt,
		});
		ledger.close();
	});

	it("reopens topology, leases, heartbeat/checkpoint state, and retries from the checkpoint", async () => {
		const path = await ledgerPath("subagent-dag-ledger-");
		const inspect = readTask("inspect");
		const write = writerTask("write", ["inspect"]);
		let ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "dag-1", request: request([inspect, write]), baseline });
		ledger.setDagRunStatus("dag-1", "running", 1_000);

		const [first] = ledger.claimRunnableTasks("dag-1", "owner-a", 1_010, 100, 4);
		expect(first).toMatchObject({ taskId: "inspect", attemptNumber: 1, ownerId: "owner-a" });
		expect(ledger.claimRunnableTasks("dag-1", "owner-b", 1_011, 100, 4)).toEqual([]);
		ledger.checkpointAttempt("dag-1", "inspect", first.attemptId, "owner-a", { cursor: 7 }, 1_020);
		ledger.recordDagAttemptRuntime(
			"dag-1",
			"inspect",
			first.attemptId,
			"owner-a",
			{
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				thinkingLevel: "medium",
				isolationLevel: "tool-bounded",
				sessionId: "session-1",
				sessionFile: "/private/session-1.jsonl",
				runtimeGeneration: 1,
				lastEventSeq: 7,
				isStreaming: true,
				pendingMessageCount: 0,
				activity: "reading",
				nextAction: "wait",
			},
			1_021,
		);
		expect(() =>
			ledger.recordDagAttemptRuntime(
				"dag-1",
				"inspect",
				first.attemptId,
				"owner-a",
				{ isolationLevel: "tool-bounded", runtimeGeneration: 1, lastEventSeq: 6 },
				1_022,
			),
		).toThrow("Stale child runtime metadata");
		expect(ledger.heartbeatAttempt("dag-1", "inspect", first.attemptId, "owner-a", 1_030, 100)).toBe(1_130);
		ledger.close();

		ledger = new RunLedger(path);
		let persisted = ledger.getDagRun("dag-1");
		expect(persisted?.request.tasks[1]).toMatchObject({ id: "write", role: "writer", dependsOn: ["inspect"] });
		expect(persisted?.tasks[0]).toMatchObject({
			status: "running",
			attempts: 1,
			checkpoint: { cursor: 7 },
			leaseExpiresAt: 1_130,
		});
		expect(persisted?.tasks[0]?.attemptRecords[0]).toMatchObject({
			attemptId: first.attemptId,
			status: "running",
			checkpoint: { cursor: 7 },
			leaseExpiresAt: 1_130,
			runtime: {
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				sessionId: "session-1",
				runtimeGeneration: 1,
				lastEventSeq: 7,
			},
		});

		ledger.recoverDagRun("dag-1", 1_131);
		const retryAt = ledger.nextDagRetryAt("dag-1")!;
		expect(ledger.claimRunnableTasks("dag-1", "owner-b", retryAt - 1, 100, 4)).toEqual([]);
		const [retry] = ledger.claimRunnableTasks("dag-1", "owner-b", retryAt, 100, 4);
		expect(retry).toMatchObject({ taskId: "inspect", attemptNumber: 2, checkpoint: { cursor: 7 } });
		expect(retry.attemptId).not.toBe(first.attemptId);
		expect(() =>
			ledger.completeDagTask(
				"dag-1",
				"inspect",
				first.attemptId,
				"owner-a",
				{ artifact: artifact(inspect) },
				retryAt + 1,
			),
		).toThrow("Stale DAG attempt");
		ledger.completeDagTask(
			"dag-1",
			"inspect",
			retry.attemptId,
			"owner-b",
			{ artifact: artifact(inspect), usage },
			retryAt + 1,
		);

		const [writerClaim] = ledger.claimRunnableTasks("dag-1", "writer-owner", 1_141, 100, 4);
		expect(writerClaim).toMatchObject({ taskId: "write", role: "writer" });
		persisted = ledger.getDagRun("dag-1");
		expect(persisted?.tasks[0]?.attemptRecords.map((attempt) => attempt.status)).toEqual(["expired", "succeeded"]);
		expect(ledger.listDagEvents("dag-1").map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"run.created",
				"task.claimed",
				"attempt.heartbeat",
				"attempt.checkpoint",
				"task.requeued",
			]),
		);
		ledger.close();
	});

	it("reclaims an artifact-ready maxAttempts=1 task as the same attempt", async () => {
		const path = await ledgerPath("subagent-dag-artifact-ready-");
		const task = readTask("inspect", [], 1);
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "artifact-ready", request: request([task]), baseline });
		ledger.setDagRunStatus("artifact-ready", "running", 1_200);
		const [claim] = ledger.claimRunnableTasks("artifact-ready", "owner-a", 1_210, 10, 1);
		const result = artifact(task);
		ledger.checkpointAttempt(
			"artifact-ready",
			"inspect",
			claim.attemptId,
			"owner-a",
			{ version: 1, phase: "artifact_ready", artifact: result, usage },
			1_211,
		);
		ledger.recoverDagRun("artifact-ready", 1_220);

		const [recovered] = ledger.claimRunnableTasks("artifact-ready", "owner-b", 1_221, 100, 1);
		expect(recovered).toMatchObject({
			attemptId: claim.attemptId,
			attemptNumber: 1,
			checkpoint: { version: 1, phase: "artifact_ready", artifact: result, usage },
		});
		ledger.completeDagTask(
			"artifact-ready",
			"inspect",
			recovered.attemptId,
			"owner-b",
			{ artifact: result, usage, turns: 1 },
			1_222,
		);
		const persisted = ledger.getDagRun("artifact-ready")?.tasks[0];
		expect(persisted).toMatchObject({ status: "succeeded", attempts: 1, turns: 1, usage });
		expect(persisted?.attemptRecords).toHaveLength(1);
		expect(persisted?.attemptRecords[0]).toMatchObject({
			attemptId: claim.attemptId,
			attemptNumber: 1,
			status: "succeeded",
			turns: 1,
			usage,
		});
		ledger.close();
	});

	it("seeds fresh availability retry generations without reusing prior Child identity", () => {
		const task = readTask("inspect", [], 1);
		const ledger = new RunLedger(":memory:");
		ledger.createDagRun({ runId: "availability-runtime", request: request([task]), baseline });
		ledger.setDagRunStatus("availability-runtime", "running", 1_225);
		const [initial] = ledger.claimRunnableTasks("availability-runtime", "owner-initial", 1_226, 100, 1);
		ledger.recordDagAttemptRuntime(
			"availability-runtime",
			"inspect",
			initial.attemptId,
			initial.ownerId,
			{
				provider: "fake",
				model: "fake/model",
				isolationLevel: "tool-bounded",
				sessionId: "stale-session-1",
				sessionFile: "/private/runtime-1/sessions/session.jsonl",
				runtimeRoot: "/private/runtime-1",
				runtimeRootId: "runtime-1",
				runtimeGeneration: 1,
				lastEventSeq: 80,
				activity: "settled",
				nextAction: "consume handoff",
			},
			1_227,
			undefined,
			true,
		);
		ledger.completeDagTask(
			"availability-runtime",
			"inspect",
			initial.attemptId,
			initial.ownerId,
			{
				terminalReason: "model_error",
				error: "Child model stopped with error: fetch failed (ECONNRESET)",
			},
			1_228,
		);

		const retryAt = ledger.nextDagRetryAt("availability-runtime")!;
		const [retry] = ledger.claimRunnableTasks("availability-runtime", "owner-retry", retryAt, 100, 1);
		expect(retry).toMatchObject({ attemptId: initial.attemptId, attemptNumber: 1 });
		expect(retry.runtime).toMatchObject({
			provider: "fake",
			model: "fake/model",
			isolationLevel: "tool-bounded",
			runtimeGeneration: 1,
			lastEventSeq: 80,
		});
		expect(retry.runtime).not.toHaveProperty("sessionId");
		expect(retry.runtime).not.toHaveProperty("sessionFile");
		expect(retry.runtime).not.toHaveProperty("runtimeRoot");
		expect(retry.runtime).not.toHaveProperty("runtimeRootId");

		ledger.recordDagAttemptRuntime(
			"availability-runtime",
			"inspect",
			retry.attemptId,
			retry.ownerId,
			{
				isolationLevel: "tool-bounded",
				sessionId: "fresh-session-2",
				sessionFile: "/private/runtime-2/sessions/session.jsonl",
				runtimeRoot: "/private/runtime-2",
				runtimeRootId: "runtime-2",
				runtimeGeneration: 2,
				lastEventSeq: 0,
			},
			retryAt + 1,
			undefined,
			true,
		);
		ledger.checkpointAttempt(
			"availability-runtime",
			"inspect",
			retry.attemptId,
			retry.ownerId,
			{ version: 1, phase: "running_child", availabilityRetry: true },
			retryAt + 2,
		);
		ledger.recoverDagRun("availability-runtime", retry.leaseExpiresAt);

		const [recovered] = ledger.claimRunnableTasks(
			"availability-runtime",
			"owner-recovered",
			retry.leaseExpiresAt + 1,
			100,
			1,
		);
		expect(recovered).toMatchObject({ attemptId: initial.attemptId, attemptNumber: 1 });
		expect(recovered.runtime).toMatchObject({ runtimeGeneration: 2, lastEventSeq: 0 });
		expect(recovered.runtime).not.toHaveProperty("sessionId");
		expect(recovered.runtime).not.toHaveProperty("sessionFile");
		expect(recovered.runtime).not.toHaveProperty("runtimeRoot");
		expect(recovered.runtime).not.toHaveProperty("runtimeRootId");
		expect(() =>
			ledger.recordDagAttemptRuntime(
				"availability-runtime",
				"inspect",
				recovered.attemptId,
				recovered.ownerId,
				{ isolationLevel: "tool-bounded", runtimeGeneration: 3, lastEventSeq: 0 },
				retry.leaseExpiresAt + 2,
				undefined,
				true,
			),
		).not.toThrow();
		ledger.close();
	});

	it("reclaims provider availability failures indefinitely without consuming maxAttempts", async () => {
		const task = readTask("inspect", [], 1);
		const ledger = new RunLedger(":memory:");
		ledger.createDagRun({ runId: "availability-retry", request: request([task]), baseline });
		ledger.setDagRunStatus("availability-retry", "running", 1_230);
		let [claim] = ledger.claimRunnableTasks("availability-retry", "owner-0", 1_231, 100, 1);
		const firstAttemptId = claim.attemptId;
		const diagnostic =
			"Child model stopped with error: fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: chatgpt.com:443, timeout: 10000ms))";

		for (let retry = 1; retry <= 4; retry++) {
			ledger.completeDagTask(
				"availability-retry",
				"inspect",
				claim.attemptId,
				claim.ownerId,
				{ terminalReason: "model_error", error: diagnostic },
				claim.leaseExpiresAt - 1,
			);
			const pending = ledger.getDagRun("availability-retry")?.tasks[0];
			expect(pending).toMatchObject({ status: "pending", attempts: 1 });
			expect(pending?.terminalReason).toBeUndefined();
			expect(pending?.error).toBeUndefined();
			expect(pending?.attemptRecords).toHaveLength(1);
			expect(pending?.attemptRecords[0]).toMatchObject({
				attemptId: firstAttemptId,
				attemptNumber: 1,
				status: "expired",
			});
			expect(pending?.attemptRecords[0]?.terminalReason).toBeUndefined();
			expect(pending?.attemptRecords[0]?.error).toBeUndefined();

			const retryAt = ledger.nextDagRetryAt("availability-retry")!;
			expect(ledger.claimRunnableTasks("availability-retry", `early-${retry}`, retryAt - 1, 100, 1)).toEqual([]);
			[claim] = ledger.claimRunnableTasks("availability-retry", `owner-${retry}`, retryAt, 100, 1);
			expect(claim).toMatchObject({ attemptId: firstAttemptId, attemptNumber: 1 });
			if (retry === 1) {
				ledger.recordDagAttemptAccounting(
					"availability-retry",
					"inspect",
					claim.attemptId,
					claim.ownerId,
					usage,
					1,
					retryAt + 1,
				);
				ledger.checkpointAttempt(
					"availability-retry",
					"inspect",
					claim.attemptId,
					claim.ownerId,
					{
						version: 1,
						phase: "running_child",
						availabilityRetry: true,
						attemptUsage: usage,
						attemptTurns: 1,
					},
					retryAt + 2,
				);
				ledger.recoverDagRun("availability-retry", claim.leaseExpiresAt);
				[claim] = ledger.claimRunnableTasks(
					"availability-retry",
					"owner-after-recovery",
					claim.leaseExpiresAt + 1,
					100,
					1,
				);
				expect(claim).toMatchObject({ attemptId: firstAttemptId, attemptNumber: 1 });
			}
		}

		ledger.completeDagTask(
			"availability-retry",
			"inspect",
			claim.attemptId,
			claim.ownerId,
			{ artifact: artifact(task), usage, turns: 1 },
			claim.leaseExpiresAt - 1,
		);
		const completed = ledger.getDagRun("availability-retry")?.tasks[0];
		expect(completed).toMatchObject({ status: "succeeded", attempts: 1, usage, turns: 1 });
		expect(completed?.attemptRecords).toHaveLength(1);
		expect(
			ledger
				.listDagEvents("availability-retry")
				.filter(
					(event) =>
						event.type === "task.requeued" &&
						(event.payload as { reason?: string }).reason === "availability_failure",
				),
		).toHaveLength(4);
		ledger.close();
	});

	it("keeps ordinary model errors and external-writer availability failures bounded", () => {
		const ordinary = readTask("ordinary", [], 1);
		// Persisted or externally constructed contracts must remain safe even if
		// their embedded attempt cap predates the current compiler invariant.
		const external = { ...externalWriterTask("publish", "/external-output"), maxAttempts: 2 };
		const ledger = new RunLedger(":memory:");
		ledger.createDagRun({ runId: "bounded-model-error", request: request([ordinary, external]), baseline });
		ledger.setDagRunStatus("bounded-model-error", "running", 1_240);
		const [ordinaryClaim, externalClaim] = ledger.claimRunnableTasks("bounded-model-error", "owner", 1_241, 100, 2);
		ledger.completeDagTask(
			"bounded-model-error",
			ordinaryClaim.taskId,
			ordinaryClaim.attemptId,
			ordinaryClaim.ownerId,
			{ terminalReason: "model_error", error: "Model returned an invalid response" },
			1_242,
		);
		ledger.completeDagTask(
			"bounded-model-error",
			externalClaim.taskId,
			externalClaim.attemptId,
			externalClaim.ownerId,
			{ terminalReason: "model_error", error: "fetch failed (ECONNRESET)" },
			1_242,
		);
		expect(
			ledger.getDagRun("bounded-model-error")?.tasks.map((record) => [record.status, record.terminalReason]),
		).toEqual([
			["failed", "model_error"],
			["failed", "model_error"],
		]);
		ledger.close();
	});

	it("accumulates absolute attempt accounting into task totals exactly once", async () => {
		const path = await ledgerPath("subagent-dag-accounting-");
		const task = readTask("inspect", [], 2);
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "accounting", request: request([task]), baseline });
		ledger.setDagRunStatus("accounting", "running", 1_300);
		const [first] = ledger.claimRunnableTasks("accounting", "owner-a", 1_310, 100, 1);
		expect(
			ledger.recordDagAttemptAccounting("accounting", "inspect", first.attemptId, "owner-a", usage, 1, 1_311),
		).toBe(true);
		expect(
			ledger.recordDagAttemptAccounting("accounting", "inspect", first.attemptId, "owner-a", usage, 1, 1_312),
		).toBe(false);
		ledger.completeDagTask(
			"accounting",
			"inspect",
			first.attemptId,
			"owner-a",
			{ terminalReason: "process_error", error: "retry", usage, turns: 1 },
			1_313,
		);
		ledger.completeDagTask(
			"accounting",
			"inspect",
			first.attemptId,
			"owner-a",
			{ terminalReason: "process_error", error: "retry", usage, turns: 1 },
			1_314,
		);
		const retryAt = ledger.nextDagRetryAt("accounting")!;
		expect(ledger.claimRunnableTasks("accounting", "owner-b", retryAt - 1, 100, 1)).toEqual([]);
		const [second] = ledger.claimRunnableTasks("accounting", "owner-b", retryAt, 100, 1);
		ledger.completeDagTask(
			"accounting",
			"inspect",
			second.attemptId,
			"owner-b",
			{ artifact: artifact(task), usage, turns: 2 },
			retryAt + 1,
		);

		const persisted = ledger.getDagRun("accounting")?.tasks[0];
		expect(persisted?.turns).toBe(3);
		expect(persisted?.usage).toMatchObject({ totalTokens: 36, cost: { total: 0.66 } });
		expect(persisted?.attemptRecords.map((attempt) => [attempt.turns, attempt.usage.totalTokens])).toEqual([
			[1, 18],
			[2, 18],
		]);
		expect(ledger.listDagEvents("accounting").filter((event) => event.type === "task.requeued")).toHaveLength(1);
		ledger.close();
	});

	it("accounts an expired non-resumable attempt in task and run totals before retry", async () => {
		const path = await ledgerPath("subagent-dag-expired-accounting-");
		const task = readTask("inspect", [], 2);
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "expired-accounting", request: request([task]), baseline });
		ledger.setDagRunStatus("expired-accounting", "running", 1_350);
		const [first] = ledger.claimRunnableTasks("expired-accounting", "owner-a", 1_360, 10, 1);
		ledger.recordDagAttemptAccounting("expired-accounting", "inspect", first.attemptId, "owner-a", usage, 1, 1_361);
		ledger.recoverDagRun("expired-accounting", 1_371);
		expect(ledger.getDagRun("expired-accounting")).toMatchObject({
			usage,
			turns: 1,
			tasks: [{ status: "pending", usage, turns: 1 }],
		});

		const retryAt = ledger.nextDagRetryAt("expired-accounting")!;
		const [second] = ledger.claimRunnableTasks("expired-accounting", "owner-b", retryAt, 100, 1);
		ledger.completeDagTask(
			"expired-accounting",
			"inspect",
			second.attemptId,
			"owner-b",
			{ artifact: artifact(task), usage, turns: 2 },
			retryAt + 1,
		);
		const aggregate = ledger.reconcileDagRunAccounting("expired-accounting", retryAt + 2);
		expect(ledger.getDagRun("expired-accounting")?.tasks[0]).toMatchObject({
			status: "succeeded",
			usage: { totalTokens: 36, cost: { total: 0.66 } },
			turns: 3,
		});
		expect(aggregate).toMatchObject({ usage: { totalTokens: 36, cost: { total: 0.66 } }, turns: 3 });
		ledger.close();
	});

	it("never reclaims an interrupted external-writer attempt even if embedded maxAttempts is greater than one", async () => {
		const path = await ledgerPath("subagent-dag-external-interrupted-");
		const task = { ...externalWriterTask("publish", "/external-output"), maxAttempts: 2 };
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "external-interrupted", request: request([task]), baseline });
		ledger.setDagRunStatus("external-interrupted", "running", 1_380);
		const [claim] = ledger.claimRunnableTasks("external-interrupted", "owner-a", 1_390, 10, 1);
		ledger.recordDagAttemptAccounting("external-interrupted", "publish", claim.attemptId, "owner-a", usage, 1, 1_391);
		ledger.checkpointAttempt(
			"external-interrupted",
			"publish",
			claim.attemptId,
			"owner-a",
			{ version: 1, phase: "interrupted", attemptUsage: usage, attemptTurns: 1 },
			1_392,
		);
		expect(() => ledger.markDagRunPaused("external-interrupted", 1_393)).toThrow("non-resumable task");

		ledger.recoverDagRun("external-interrupted", 1_401);

		const persisted = ledger.getDagRun("external-interrupted")?.tasks[0];
		expect(persisted).toMatchObject({
			status: "failed",
			terminalReason: "retry_exhausted",
			attempts: 1,
			usage,
			turns: 1,
		});
		expect(persisted?.attemptRecords).toMatchObject([
			{ attemptId: claim.attemptId, attemptNumber: 1, status: "expired", usage, turns: 1 },
		]);
		expect(ledger.claimRunnableTasks("external-interrupted", "owner-b", 1_402, 100, 1)).toEqual([]);
		ledger.close();
	});

	it("reclaims artifact-ready external-writer completion without opening a new attempt", async () => {
		const path = await ledgerPath("subagent-dag-external-artifact-ready-");
		const task = externalWriterTask("publish", "/external-output");
		const result = artifact(task);
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "external-artifact-ready", request: request([task]), baseline });
		ledger.setDagRunStatus("external-artifact-ready", "running", 1_410);
		const [claim] = ledger.claimRunnableTasks("external-artifact-ready", "owner-a", 1_420, 10, 1);
		ledger.recordDagAttemptAccounting(
			"external-artifact-ready",
			"publish",
			claim.attemptId,
			"owner-a",
			usage,
			1,
			1_421,
		);
		ledger.checkpointAttempt(
			"external-artifact-ready",
			"publish",
			claim.attemptId,
			"owner-a",
			{ version: 1, phase: "artifact_ready", artifact: result, attemptUsage: usage, attemptTurns: 1 },
			1_422,
		);

		ledger.recoverDagRun("external-artifact-ready", 1_431);
		const [recovered] = ledger.claimRunnableTasks("external-artifact-ready", "owner-b", 1_432, 100, 1);
		expect(recovered).toMatchObject({ attemptId: claim.attemptId, attemptNumber: 1 });
		ledger.completeDagTask(
			"external-artifact-ready",
			"publish",
			recovered.attemptId,
			"owner-b",
			{ artifact: result, usage, turns: 1 },
			1_433,
		);
		expect(ledger.getDagRun("external-artifact-ready")?.tasks[0]).toMatchObject({
			status: "succeeded",
			attempts: 1,
			usage,
			turns: 1,
		});
		ledger.close();
	});

	it("coalesces runtime metadata writes and force-flushes the final sequence", async () => {
		const path = await ledgerPath("subagent-dag-runtime-coalescing-");
		const task = readTask("inspect", [], 1);
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "runtime", request: request([task]), baseline });
		ledger.setDagRunStatus("runtime", "running", 1_400);
		const [claim] = ledger.claimRunnableTasks("runtime", "owner", 1_410, 1_000, 1);
		let durableWrites = 0;
		for (let sequence = 0; sequence <= 130; sequence++) {
			if (
				ledger.recordDagAttemptRuntime(
					"runtime",
					"inspect",
					claim.attemptId,
					"owner",
					{
						isolationLevel: "tool-bounded",
						runtimeGeneration: 1,
						lastEventSeq: sequence,
						activity: `event-${sequence}`,
					},
					1_411 + sequence,
				)
			) {
				durableWrites++;
			}
		}
		expect(durableWrites).toBe(3);
		expect(
			ledger.recordDagAttemptRuntime(
				"runtime",
				"inspect",
				claim.attemptId,
				"owner",
				{ isolationLevel: "tool-bounded", runtimeGeneration: 1, lastEventSeq: 130, activity: "final" },
				1_600,
				undefined,
				true,
			),
		).toBe(true);
		expect(() =>
			ledger.recordDagAttemptRuntime(
				"runtime",
				"inspect",
				claim.attemptId,
				"owner",
				{ isolationLevel: "tool-bounded", runtimeGeneration: 1, lastEventSeq: 129 },
				1_601,
			),
		).toThrow("Stale child runtime metadata");
		expect(ledger.getDagRun("runtime")?.tasks[0]?.attemptRecords[0]?.runtime).toMatchObject({
			lastEventSeq: 130,
			activity: "final",
		});
		expect(ledger.listDagEvents("runtime").filter((event) => event.type === "attempt.runtime")).toHaveLength(4);
		ledger.close();
	});

	it("fails retry-exhausted tasks, blocks every descendant, and rejects the stale lease owner", async () => {
		const path = await ledgerPath("subagent-dag-exhausted-");
		const root = readTask("root", [], 1);
		const child = readTask("child", ["root"], 1);
		const grandchild = readTask("grandchild", ["child"], 1);
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "dag-2", request: request([root, child, grandchild]), baseline });
		ledger.setDagRunStatus("dag-2", "running", 2_000);
		const [claim] = ledger.claimRunnableTasks("dag-2", "owner", 2_010, 10, 3);
		ledger.recoverDagRun("dag-2", 2_020);

		const run = ledger.getDagRun("dag-2");
		expect(run?.tasks.map((task) => [task.taskId, task.status, task.terminalReason])).toEqual([
			["root", "failed", "retry_exhausted"],
			["child", "blocked", "dependency_failed"],
			["grandchild", "blocked", "dependency_failed"],
		]);
		expect(ledger.claimRunnableTasks("dag-2", "other", 2_021, 10, 3)).toEqual([]);
		expect(() =>
			ledger.completeDagTask("dag-2", "root", claim.attemptId, "owner", { artifact: artifact(root) }, 2_021),
		).toThrow("Stale DAG attempt");
		ledger.close();
	});

	it("requeues explicit failures until the final consumed attempt and only then blocks descendants", async () => {
		const path = await ledgerPath("subagent-dag-explicit-retry-");
		const root = readTask("root", [], 2);
		const child = readTask("child", ["root"], 1);
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "dag-explicit-retry", request: request([root, child]), baseline });
		ledger.setDagRunStatus("dag-explicit-retry", "running", 2_100);

		const [first] = ledger.claimRunnableTasks("dag-explicit-retry", "owner-a", 2_110, 100, 1);
		ledger.completeDagTask(
			"dag-explicit-retry",
			"root",
			first.attemptId,
			"owner-a",
			{ terminalReason: "process_error", error: "first failure", usage },
			2_120,
		);
		let run = ledger.getDagRun("dag-explicit-retry");
		expect(run?.tasks.map((task) => [task.taskId, task.status, task.terminalReason])).toEqual([
			["root", "pending", undefined],
			["child", "pending", undefined],
		]);
		expect(run?.tasks[0]?.attemptRecords[0]).toMatchObject({
			status: "failed",
			terminalReason: "process_error",
			error: "first failure",
			usage,
		});

		const retryAt = ledger.nextDagRetryAt("dag-explicit-retry")!;
		const [second] = ledger.claimRunnableTasks("dag-explicit-retry", "owner-b", retryAt, 100, 1);
		expect(second).toMatchObject({ attemptNumber: 2, ownerId: "owner-b" });
		ledger.completeDagTask(
			"dag-explicit-retry",
			"root",
			second.attemptId,
			"owner-b",
			{ terminalReason: "validation_failed", error: "final failure" },
			retryAt + 1,
		);
		run = ledger.getDagRun("dag-explicit-retry");
		expect(run?.tasks.map((task) => [task.taskId, task.status, task.terminalReason])).toEqual([
			["root", "failed", "validation_failed"],
			["child", "blocked", "dependency_failed"],
		]);
		expect(run?.tasks[0]?.attemptRecords.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
		ledger.close();
	});

	it("treats explicit cancellation as terminal without retrying", async () => {
		const path = await ledgerPath("subagent-dag-cancel-completion-");
		const root = readTask("root", [], 2);
		const child = readTask("child", ["root"], 1);
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "dag-cancel-completion", request: request([root, child]), baseline });
		ledger.setDagRunStatus("dag-cancel-completion", "running", 2_200);
		const [claim] = ledger.claimRunnableTasks("dag-cancel-completion", "owner", 2_210, 100, 1);
		ledger.completeDagTask(
			"dag-cancel-completion",
			"root",
			claim.attemptId,
			"owner",
			{ terminalReason: "cancelled" },
			2_220,
		);
		expect(
			ledger.getDagRun("dag-cancel-completion")?.tasks.map((task) => [task.status, task.terminalReason]),
		).toEqual([
			["cancelled", "cancelled"],
			["blocked", "dependency_failed"],
		]);
		ledger.close();
	});

	it("keeps successful artifacts immutable and never claims a succeeded node again", async () => {
		const path = await ledgerPath("subagent-dag-success-");
		const task = writerTask("write", []);
		let ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "dag-3", request: request([task]), baseline });
		ledger.setDagRunStatus("dag-3", "running", 3_000);
		const [claim] = ledger.claimRunnableTasks("dag-3", "owner", 3_010, 100, 1);
		const result = artifact(task);
		ledger.completeDagTask("dag-3", "write", claim.attemptId, "owner", { artifact: result, usage }, 3_020);
		ledger.completeDagTask("dag-3", "write", claim.attemptId, "owner", { artifact: result, usage }, 3_021);
		expect(() =>
			ledger.completeDagTask(
				"dag-3",
				"write",
				claim.attemptId,
				"owner",
				{ artifact: { ...result, artifactId: "replacement" } },
				3_022,
			),
		).toThrow("immutable");
		expect(ledger.claimRunnableTasks("dag-3", "other", 3_023, 100, 1)).toEqual([]);
		ledger.close();

		ledger = new RunLedger(path);
		expect(ledger.getDagRun("dag-3")?.tasks[0]).toMatchObject({
			status: "succeeded",
			terminalReason: "completed",
			artifact: result,
			usage,
		});
		ledger.close();
	});

	it("accepts an identical lost-ack completion after close and reopen without duplicating its event", async () => {
		const path = await ledgerPath("subagent-dag-lost-ack-");
		const task = readTask("inspect");
		const result = artifact(task);
		let ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "dag-lost-ack", request: request([task]), baseline });
		ledger.setDagRunStatus("dag-lost-ack", "running", 3_100);
		const [claim] = ledger.claimRunnableTasks("dag-lost-ack", "owner", 3_110, 100, 1);
		ledger.completeDagTask("dag-lost-ack", "inspect", claim.attemptId, "owner", { artifact: result, usage }, 3_120);
		ledger.close();

		ledger = new RunLedger(path);
		ledger.completeDagTask("dag-lost-ack", "inspect", claim.attemptId, "owner", { artifact: result, usage }, 3_121);
		expect(() =>
			ledger.completeDagTask(
				"dag-lost-ack",
				"inspect",
				claim.attemptId,
				"owner",
				{ artifact: result, usage: { ...usage, totalTokens: usage.totalTokens + 1 } },
				3_122,
			),
		).toThrow("immutable");
		expect(ledger.getDagRun("dag-lost-ack")?.tasks[0]).toMatchObject({ status: "succeeded", artifact: result });
		expect(ledger.listDagEvents("dag-lost-ack").filter((event) => event.type === "task.completed")).toHaveLength(1);
		ledger.close();
	});

	it("persists a provider circuit checkpoint and resumes the same attempt only after its delay", () => {
		const ledger = new RunLedger(":memory:");
		const task = readTask("inspect", [], 1);
		ledger.createDagRun({ runId: "provider-circuit", request: request([task]), baseline });
		const lease = ledger.acquireDagRunLease("provider-circuit", "controller-a", 3_400, 1_000)!;
		ledger.setDagRunStatus("provider-circuit", "running", 3_401, lease);
		const [claim] = ledger.claimRunnableTasks("provider-circuit", "controller-a", 3_402, 1_000, 1, lease);
		ledger.recordDagAttemptRuntime(
			"provider-circuit",
			"inspect",
			claim.attemptId,
			claim.ownerId,
			{
				provider: "trusted",
				model: "original-model",
				isolationLevel: "tool-bounded",
				sessionId: "provider-circuit-session",
				sessionFile: "/private/provider-circuit-session.jsonl",
				runtimeGeneration: 4,
				lastEventSeq: 20,
			},
			3_403,
			lease,
		);
		ledger.openDagProviderCircuit(
			"provider-circuit",
			"inspect",
			claim.attemptId,
			claim.ownerId,
			{
				version: 1,
				reason: "unlimited_auto_retry",
				autoRetryAttempt: 8,
				consecutiveUnlimitedRetries: 8,
				retryDelayMs: 500,
			},
			usage,
			2,
			3_904,
			3_404,
			lease,
		);
		expect(ledger.getDagRun("provider-circuit")).toMatchObject({
			usage,
			turns: 2,
			tasks: [
				{
					status: "running",
					checkpoint: {
						version: 1,
						phase: "provider_circuit_open",
						retryNotBefore: 3_904,
						attemptUsage: usage,
						attemptTurns: 2,
					},
				},
			],
		});
		expect(ledger.releaseDagRunLease("provider-circuit", lease, 3_405)).toBe(true);
		expect(ledger.markDagRunPaused("provider-circuit", 3_406)).toBe(true);
		const resumedLease = ledger.acquireDagRunLease("provider-circuit", "controller-b", 3_500, 1_000)!;
		expect(ledger.clearDagRunPause("provider-circuit", 3_501, resumedLease)).toBe(true);
		expect(ledger.claimRunnableTasks("provider-circuit", "controller-b", 3_903, 1_000, 1, resumedLease)).toEqual([]);
		const [resumed] = ledger.claimRunnableTasks("provider-circuit", "controller-b", 3_904, 1_000, 1, resumedLease);
		expect(resumed).toMatchObject({
			attemptId: claim.attemptId,
			attemptNumber: 1,
			runtime: {
				provider: "trusted",
				model: "original-model",
				sessionId: "provider-circuit-session",
				runtimeGeneration: 4,
			},
		});
		const circuitEvent = ledger
			.listDagEvents("provider-circuit")
			.find((event) => event.type === "provider.circuit_open");
		expect(circuitEvent?.payload).toMatchObject({ retryNotBefore: 3_904, autoRetryAttempt: 8 });
		expect(JSON.stringify(circuitEvent)).not.toContain("errorMessage");
		ledger.close();
	});

	it("preserves the provider circuit retry gate through lease-expiry recovery", () => {
		const ledger = new RunLedger(":memory:");
		const task = readTask("inspect", [], 1);
		ledger.createDagRun({ runId: "provider-circuit-recovery", request: request([task]), baseline });
		ledger.setDagRunStatus("provider-circuit-recovery", "running", 3_500);
		const [claim] = ledger.claimRunnableTasks("provider-circuit-recovery", "controller-a", 3_502, 100, 1);
		ledger.openDagProviderCircuit(
			"provider-circuit-recovery",
			"inspect",
			claim.attemptId,
			claim.ownerId,
			{
				version: 1,
				reason: "unlimited_auto_retry",
				autoRetryAttempt: 8,
				consecutiveUnlimitedRetries: 8,
				retryDelayMs: 500,
			},
			usage,
			2,
			4_004,
			3_504,
		);

		ledger.recoverDagRun("provider-circuit-recovery", claim.leaseExpiresAt);
		expect(ledger.claimRunnableTasks("provider-circuit-recovery", "controller-b", 4_003, 100, 1)).toEqual([]);
		const [resumed] = ledger.claimRunnableTasks("provider-circuit-recovery", "controller-b", 4_004, 100, 1);
		expect(resumed).toMatchObject({ attemptId: claim.attemptId, attemptNumber: 1 });
		ledger.close();
	});

	it("records pause duration without stealing a live controller lease", async () => {
		const path = await ledgerPath("subagent-dag-pause-state-");
		const ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "pausable", request: request([readTask("inspect")]), baseline });
		ledger.setDagRunStatus("pausable", "running", 3_499);
		const live = ledger.acquireDagRunLease("pausable", "controller-a", 3_500, 100);
		expect(live).toBeDefined();
		expect(() => ledger.markDagRunPaused("pausable", 3_550)).toThrow("live controller lease");
		expect(ledger.releaseDagRunLease("pausable", live!, 3_551)).toBe(true);
		expect(ledger.markDagRunPaused("pausable", 3_552)).toBe(true);
		expect(ledger.markDagRunPaused("pausable", 3_553)).toBe(true);
		expect(ledger.getDagRun("pausable")).toMatchObject({ pausedAt: 3_552, pausedDurationMs: 0 });
		expect(ledger.claimRunnableTasks("pausable", "worker", 3_554, 100, 1)).toEqual([]);
		const resumedLease = ledger.acquireDagRunLease("pausable", "controller-b", 3_600, 100);
		expect(resumedLease).toBeDefined();
		expect(ledger.clearDagRunPause("pausable", 3_602, resumedLease!)).toBe(true);
		expect(ledger.clearDagRunPause("pausable", 3_603, resumedLease!)).toBe(false);
		expect(ledger.getDagRun("pausable")).toMatchObject({ pausedDurationMs: 50 });
		expect(ledger.getDagRun("pausable")?.pausedAt).toBeUndefined();
		ledger.close();
	});

	it("enforces sealed and terminal pause invariants at the Ledger boundary", async () => {
		const ledger = new RunLedger(":memory:");
		const task = readTask("inspect");
		ledger.createDagRun({
			runId: "open-terminal",
			request: { ...request([task]), graph: { sealed: false } },
			baseline,
		});
		ledger.setDagRunStatus("open-terminal", "running", 3_700);
		const [claim] = ledger.claimRunnableTasks("open-terminal", "owner", 3_701, 100, 1);
		ledger.completeDagTask("open-terminal", "inspect", claim.attemptId, "owner", { artifact: artifact(task) }, 3_702);
		const successLease = ledger.acquireDagRunLease("open-terminal", "controller-a", 3_703, 100)!;
		expect(() => ledger.setDagRunStatus("open-terminal", "succeeded", 3_704, successLease)).toThrow("Unsealed");
		expect(ledger.releaseDagRunLease("open-terminal", successLease, 3_705)).toBe(true);
		expect(ledger.markDagRunPaused("open-terminal", 3_706)).toBe(true);
		expect(ledger.getDagRun("open-terminal")).toMatchObject({ awaitingExpansion: true, pausedAt: 3_706 });
		const cancelLease = ledger.acquireDagRunLease("open-terminal", "controller-b", 3_715, 100)!;
		ledger.setDagRunStatus("open-terminal", "cancelled", 3_716, cancelLease);
		expect(ledger.getDagRun("open-terminal")).toMatchObject({
			status: "cancelled",
			awaitingExpansion: false,
			pausedDurationMs: 10,
		});
		expect(ledger.getDagRun("open-terminal")?.pausedAt).toBeUndefined();
		ledger.close();
	});

	it("atomically folds active attempt accounting into terminal task and run totals", async () => {
		const ledger = new RunLedger(":memory:");
		const task = readTask("inspect");
		ledger.createDagRun({ runId: "terminal-accounting", request: request([task]), baseline });
		ledger.setDagRunStatus("terminal-accounting", "running", 3_720);
		const [claim] = ledger.claimRunnableTasks("terminal-accounting", "owner", 3_721, 100, 1);
		ledger.recordDagAttemptAccounting("terminal-accounting", "inspect", claim.attemptId, "owner", usage, 2, 3_722);
		const terminalLease = ledger.acquireDagRunLease("terminal-accounting", "controller", 3_723, 100)!;
		ledger.setDagRunStatus("terminal-accounting", "cancelled", 3_724, terminalLease);
		ledger.setDagRunStatus("terminal-accounting", "cancelled", 3_725);
		expect(() => ledger.setDagRunStatus("terminal-accounting", "failed", 3_726)).toThrow("cancelled -> failed");
		expect(ledger.getDagRun("terminal-accounting")).toMatchObject({
			status: "cancelled",
			usage,
			turns: 2,
			tasks: [{ status: "cancelled", usage, turns: 2 }],
		});
		expect(
			ledger.listDagEvents("terminal-accounting").filter((event) => event.type === "run.transition"),
		).toHaveLength(2);
		ledger.close();
	});

	it("persists integration and usage across reopen", async () => {
		const path = await ledgerPath("subagent-dag-integration-");
		const task = writerTask("write", []);
		let ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "dag-4", request: request([task], true), baseline });
		ledger.setDagRunStatus("dag-4", "running", 4_000);
		const [claim] = ledger.claimRunnableTasks("dag-4", "owner", 4_010, 100, 1);
		ledger.completeDagTask("dag-4", "write", claim.attemptId, "owner", { artifact: artifact(task) }, 4_020);
		const integration: IntegrationArtifact = {
			artifactVersion: 1,
			kind: "complete",
			ref: "refs/heads/pi/subagent/integration/dag-4",
			commit: "integration-commit",
			orderedTaskIds: ["write"],
			orderedCommits: ["writer-commit"],
			createdAt: 4_030,
			quality: passedCandidateQuality(),
		};
		ledger.recordDagIntegration("dag-4", integration, 4_030);
		ledger.recordDagIntegration("dag-4", integration, 4_031);
		ledger.setDagRunUsage("dag-4", usage, 4_032);
		const runLease = ledger.acquireDagRunLease("dag-4", "controller", 4_032, 100);
		expect(runLease).toBeDefined();
		ledger.setDagRunStatus("dag-4", "succeeded", 4_033, runLease);
		ledger.close();

		const legacy = new DatabaseSync(path);
		const stored = legacy.prepare("SELECT integration_json FROM dag_runs WHERE run_id = ?").get("dag-4") as {
			integration_json: string;
		};
		const legacyIntegration = JSON.parse(stored.integration_json) as Record<string, unknown>;
		delete legacyIntegration.kind;
		legacy
			.prepare("UPDATE dag_runs SET integration_json = ? WHERE run_id = ?")
			.run(JSON.stringify(legacyIntegration), "dag-4");
		legacy.close();

		ledger = new RunLedger(path);
		expect(ledger.getDagRun("dag-4")).toMatchObject({
			status: "succeeded",
			integration: { ...integration, kind: "complete" },
			usage,
		});
		expect(ledger.listDagEvents("dag-4").filter((event) => event.type === "run.integration")).toHaveLength(1);
		ledger.close();
	});

	it("persists only a settled, validated, explicitly non-accepted Partial Candidate", () => {
		const ledger = new RunLedger(":memory:");
		const writer = writerTask("write", []);
		const failed = readTask("fail", [], 1);
		ledger.createDagRun({ runId: "partial-ledger", request: request([writer, failed], true), baseline });
		ledger.setDagRunStatus("partial-ledger", "running", 4_040);
		const [writerClaim] = ledger.claimRunnableTasks("partial-ledger", "writer-owner", 4_041, 100, 1);
		const writerArtifact = artifact(writer);
		ledger.completeDagTask(
			"partial-ledger",
			"write",
			writerClaim.attemptId,
			"writer-owner",
			{ artifact: writerArtifact },
			4_042,
		);
		const [failedClaim] = ledger.claimRunnableTasks("partial-ledger", "failure-owner", 4_043, 100, 1);
		ledger.completeDagTask(
			"partial-ledger",
			"fail",
			failedClaim.attemptId,
			"failure-owner",
			{ terminalReason: "task_rejected", error: "expected failure" },
			4_044,
		);
		const quality = evaluatePartialCandidateQuality([{ contract: writer, artifact: writerArtifact }], ["write"]);
		const integration: IntegrationArtifact = {
			artifactVersion: 1,
			kind: "partial",
			ref: "refs/heads/pi/subagent/integration/partial-ledger",
			commit: "partial-integration-commit",
			orderedTaskIds: ["write"],
			orderedCommits: ["writer-commit"],
			createdAt: 4_045,
			quality,
			partial: {
				reason: "task_failure",
				completeGateFailures: [],
				trust: "controller_validated",
				includedWriterTaskIds: ["write"],
				omittedWriterTasks: [],
				negativeTasks: [{ taskId: "fail", status: "failed", terminalReason: "task_rejected" }],
			},
		};
		ledger.recordDagIntegration("partial-ledger", integration, 4_045);
		expect(ledger.getDagRun("partial-ledger")?.integration).toEqual(integration);
		const lease = ledger.acquireDagRunLease("partial-ledger", "controller", 4_046, 100)!;
		expect(() => ledger.setDagRunStatus("partial-ledger", "succeeded", 4_047, lease)).toThrow("not succeeded");
		ledger.setDagRunStatus("partial-ledger", "failed", 4_047, lease);
		expect(ledger.getDagRun("partial-ledger")).toMatchObject({
			status: "failed",
			integration: { kind: "partial", quality: { gate: "failed", gateFailures: ["dag_incomplete"] } },
			resources: { candidate: "retained" },
		});
		ledger.close();
	});

	it.each(["failed", "cancelled"] as const)(
		"transactionally fences running attempts and pending tasks when a run becomes %s",
		async (terminalStatus) => {
			const path = await ledgerPath(`subagent-dag-run-${terminalStatus}-`);
			const root = readTask("root");
			const child = readTask("child", ["root"]);
			const runId = `dag-run-${terminalStatus}`;
			const ledger = new RunLedger(path);
			ledger.createDagRun({ runId, request: request([root, child]), baseline });
			ledger.setDagRunStatus(runId, "running", 4_100);
			const [claim] = ledger.claimRunnableTasks(runId, "owner", 4_110, 100, 1);
			const runLease = ledger.acquireDagRunLease(runId, "controller", 4_119, 100);
			expect(runLease).toBeDefined();
			ledger.setDagRunStatus(runId, terminalStatus, 4_120, runLease);

			const expectedTaskStatus = terminalStatus === "cancelled" ? "cancelled" : "failed";
			const expectedReason = terminalStatus === "cancelled" ? "cancelled" : "interrupted";
			const run = ledger.getDagRun(runId);
			expect(run?.tasks.map((task) => [task.status, task.terminalReason])).toEqual([
				[expectedTaskStatus, expectedReason],
				[expectedTaskStatus, expectedReason],
			]);
			expect(run?.tasks[0]?.attemptRecords[0]).toMatchObject({ status: "failed", terminalReason: expectedReason });
			expect(ledger.claimRunnableTasks(runId, "other", 4_121, 100, 2)).toEqual([]);
			expect(() => ledger.heartbeatAttempt(runId, "root", claim.attemptId, "owner", 4_121, 100)).toThrow(
				"Stale DAG attempt",
			);
			expect(() => ledger.checkpointAttempt(runId, "root", claim.attemptId, "owner", { late: true }, 4_121)).toThrow(
				"Stale DAG attempt",
			);
			expect(() =>
				ledger.completeDagTask(runId, "root", claim.attemptId, "owner", { artifact: artifact(root) }, 4_121),
			).toThrow("Stale DAG attempt");
			expect(ledger.getDagRun(runId)).toEqual(run);
			ledger.close();
		},
	);

	it("allows exactly one owner to claim through two database connections", async () => {
		const path = await ledgerPath("subagent-dag-two-connections-");
		const task = readTask("root");
		const first = new RunLedger(path);
		first.createDagRun({ runId: "dag-two-connections", request: request([task]), baseline });
		first.setDagRunStatus("dag-two-connections", "running", 4_200);
		const second = new RunLedger(path);

		const [firstClaims, secondClaims] = await Promise.all([
			Promise.resolve().then(() => first.claimRunnableTasks("dag-two-connections", "owner-a", 4_210, 100, 1)),
			Promise.resolve().then(() => second.claimRunnableTasks("dag-two-connections", "owner-b", 4_210, 100, 1)),
		]);
		const claims = [...firstClaims, ...secondClaims];
		expect(claims).toHaveLength(1);
		expect(["owner-a", "owner-b"]).toContain(claims[0]?.ownerId);
		expect(first.getDagRun("dag-two-connections")?.tasks[0]).toMatchObject({
			status: "running",
			attempts: 1,
			ownerId: claims[0]?.ownerId,
			activeAttemptId: claims[0]?.attemptId,
		});
		first.close();
		second.close();
	});

	it("leases a DAG run with epochs, fences every stale mutation class, and clears the lease on terminal status", async () => {
		const path = await ledgerPath("subagent-dag-run-leases-");
		const task = writerTask("write", []);
		const first = new RunLedger(path);
		first.createDagRun({ runId: "leased", request: request([task], true), baseline });
		const second = new RunLedger(path);

		const [firstLease, competingLease] = await Promise.all([
			Promise.resolve().then(() => first.acquireDagRunLease("leased", "controller-a", 5_000, 100)),
			Promise.resolve().then(() => second.acquireDagRunLease("leased", "controller-b", 5_000, 100)),
		]);
		const lease = firstLease ?? competingLease;
		expect([firstLease, competingLease].filter(Boolean)).toHaveLength(1);
		expect(lease).toBeDefined();
		first.setDagRunStatus("leased", "running", 5_001, lease);
		const renewed = first.heartbeatDagRunLease("leased", lease!, 5_050, 100);
		expect(renewed).toMatchObject({ ownerId: lease?.ownerId, epoch: 1, leaseExpiresAt: 5_150 });
		expect(second.acquireDagRunLease("leased", "controller-b", 5_149, 100)).toBeUndefined();
		const takeover = second.acquireDagRunLease("leased", "controller-b", 5_151, 100);
		expect(takeover).toMatchObject({ ownerId: "controller-b", epoch: 2, leaseExpiresAt: 5_251 });
		expect(first.releaseDagRunLease("leased", renewed!, 5_152)).toBe(false);

		const [claim] = second.claimRunnableTasks("leased", "task-owner", 5_152, 50, 1, takeover);
		const stale = renewed!;
		expect(() => first.setDagRunStatus("leased", "running", 5_153, stale)).toThrow("Stale DAG run lease");
		expect(() => first.setDagRunUsage("leased", usage, 5_153, stale)).toThrow("Stale DAG run lease");
		expect(() => first.claimRunnableTasks("leased", "other", 5_153, 50, 1, stale)).toThrow("Stale DAG run lease");
		expect(() => first.heartbeatAttempt("leased", "write", claim.attemptId, "task-owner", 5_153, 50, stale)).toThrow(
			"Stale DAG run lease",
		);
		expect(() =>
			first.checkpointAttempt("leased", "write", claim.attemptId, "task-owner", { stale: true }, 5_153, stale),
		).toThrow("Stale DAG run lease");
		expect(() =>
			first.completeDagTask(
				"leased",
				"write",
				claim.attemptId,
				"task-owner",
				{ artifact: artifact(task) },
				5_153,
				stale,
			),
		).toThrow("Stale DAG run lease");
		expect(() => first.recoverDagRun("leased", 5_153, stale)).toThrow("Stale DAG run lease");
		expect(() =>
			first.recordDagIntegration(
				"leased",
				{
					artifactVersion: 1,
					kind: "complete",
					ref: "refs/heads/pi/subagent/integration/leased",
					commit: "integration",
					orderedTaskIds: ["write"],
					orderedCommits: ["writer-commit"],
					createdAt: 5_153,
					quality: passedCandidateQuality(),
				},
				5_153,
				stale,
			),
		).toThrow("Stale DAG run lease");
		expect(() =>
			first.recordDagIntegrationFailure(
				"leased",
				{ reason: "process_error", diagnostics: "stale", createdAt: 5_153 },
				5_153,
				stale,
			),
		).toThrow("Stale DAG run lease");
		expect(() => second.setDagRunStatus("leased", "failed", 5_154)).toThrow("lease is required");
		second.setDagRunStatus("leased", "failed", 5_154, takeover);
		expect(second.getDagRun("leased")).toMatchObject({
			status: "failed",
			lease: undefined,
			tasks: [{ status: "failed" }],
		});
		first.close();
		second.close();
	});

	it("enforces integration artifact preconditions and persists bounded structured integration failures", async () => {
		const path = await ledgerPath("subagent-dag-integration-failure-");
		const task = writerTask("write", []);
		let ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "integrate", request: request([task], true), baseline });
		ledger.setDagRunStatus("integrate", "running", 6_000);
		const premature: IntegrationArtifact = {
			artifactVersion: 1,
			kind: "complete",
			ref: "refs/heads/pi/subagent/integration/integrate",
			commit: "integrated",
			orderedTaskIds: ["write"],
			orderedCommits: ["writer-commit"],
			createdAt: 6_010,
			quality: passedCandidateQuality(),
		};
		expect(() => ledger.recordDagIntegration("integrate", premature, 6_010)).toThrow("requires succeeded task");
		const [claim] = ledger.claimRunnableTasks("integrate", "owner", 6_011, 100, 1);
		ledger.completeDagTask("integrate", "write", claim.attemptId, "owner", { artifact: artifact(task) }, 6_012);
		expect(() =>
			ledger.recordDagIntegration("integrate", { ...premature, orderedTaskIds: ["other"], createdAt: 6_013 }, 6_013),
		).toThrow("does not match persisted task artifacts");
		ledger.recordDagIntegration("integrate", premature, 6_014);

		ledger.createDagRun({ runId: "integration-failed", request: request([readTask("inspect")], true), baseline });
		ledger.setDagRunStatus("integration-failed", "running", 6_020);
		const failure = {
			reason: "merge_conflict" as const,
			taskId: "inspect",
			diagnostics: "x".repeat(40_000),
			createdAt: 6_021,
		};
		ledger.recordDagIntegrationFailure("integration-failed", failure, 6_021);
		ledger.close();

		ledger = new RunLedger(path);
		const persisted = ledger.getDagRun("integration-failed")?.integrationFailure;
		expect(persisted).toMatchObject({ reason: "merge_conflict", taskId: "inspect", createdAt: 6_021 });
		expect(Buffer.byteLength(persisted?.diagnostics ?? "")).toBeLessThanOrEqual(32 * 1024);
		expect(() =>
			ledger.recordDagIntegration(
				"integration-failed",
				{ ...premature, orderedTaskIds: [], orderedCommits: [] },
				6_022,
			),
		).toThrow("integration failure");
		ledger.close();
	});

	it("rejects former unversioned ledgers instead of migrating them", async () => {
		const path = await ledgerPath("subagent-ledger-legacy-rejection-");
		const legacy = new DatabaseSync(path);
		legacy.exec(`
			CREATE TABLE dag_runs (
				run_id TEXT PRIMARY KEY, request_json TEXT NOT NULL,
				status TEXT NOT NULL, baseline_json TEXT NOT NULL, usage_json TEXT NOT NULL,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
		`);
		legacy.close();

		expect(() => new RunLedger(path)).toThrow("legacy or unversioned; schema 3 is required");
		const unchanged = new DatabaseSync(path);
		expect(
			unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_schema'").get(),
		).toBeUndefined();
		expect(
			unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dag_runs'").get(),
		).toBeDefined();
		unchanged.close();
	});

	it("migrates schema-2 ledgers by adding persisted retry eligibility", async () => {
		const path = await ledgerPath("subagent-ledger-v2-migration-");
		const created = new RunLedger(path);
		created.close();
		const oldDatabase = new DatabaseSync(path);
		oldDatabase.exec("ALTER TABLE dag_tasks DROP COLUMN retry_not_before");
		oldDatabase.prepare("UPDATE ledger_schema SET version = 2 WHERE singleton = 1").run();
		oldDatabase.close();

		const migrated = new RunLedger(path);
		migrated.close();
		const database = new DatabaseSync(path);
		expect(database.prepare("SELECT version FROM ledger_schema WHERE singleton = 1").get()).toEqual({ version: 3 });
		const columns = database.prepare("PRAGMA table_info(dag_tasks)").all() as unknown as Array<{ name: string }>;
		expect(columns.map((column) => column.name)).toContain("retry_not_before");
		database.close();
	});

	it("rejects an explicit unknown ledger schema version without rewriting it", async () => {
		const path = await ledgerPath("subagent-ledger-version-rejection-");
		const created = new RunLedger(path);
		created.close();
		const database = new DatabaseSync(path);
		database.prepare("UPDATE ledger_schema SET version = 1 WHERE singleton = 1").run();
		database.close();

		expect(() => new RunLedger(path)).toThrow("unsupported schema 1; schema 3 is required");
		const unchanged = new DatabaseSync(path);
		expect(unchanged.prepare("SELECT version FROM ledger_schema WHERE singleton = 1").get()).toEqual({ version: 1 });
		unchanged.close();
	});

	it("lists bounded recent DAG runs and returns rich restart-safe operator inspection", async () => {
		const path = await ledgerPath("subagent-ledger-operator-inventory-");
		const start = Date.now() + 1_000;
		let ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "older-created", request: request([readTask("old")]), baseline });
		ledger.createDagRun({ runId: "middle-running", request: request([readTask("inspect")]), baseline });
		ledger.setDagRunStatus("middle-running", "running", start + 10);
		const runLease = ledger.acquireDagRunLease("middle-running", "controller", start + 11, 1_000);
		expect(runLease).toBeDefined();
		const [claim] = ledger.claimRunnableTasks("middle-running", "worker", start + 12, 1_000, 1, runLease);
		ledger.checkpointAttempt(
			"middle-running",
			"inspect",
			claim.attemptId,
			"worker",
			{ phase: "reading", files: 2 },
			start + 13,
			runLease,
		);
		ledger.createDagRun({ runId: "newest-created", request: request([writerTask("write", [])], true), baseline });
		ledger.setDagRunUsage("newest-created", usage, start + 20);
		ledger.close();

		ledger = new RunLedger(path);
		const recent = ledger.listDagRuns({ limit: 2 });
		expect(recent.map((run) => run.runId)).toEqual(["newest-created", "middle-running"]);
		expect(recent[0]).toMatchObject({
			status: "created",
			counts: { pending: 1, running: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: 0 },
			usage,
			budget: request([]).budget,
			budgetScope: "task",
		});
		expect(ledger.listDagRuns({ statuses: ["running"] })).toMatchObject([
			{ runId: "middle-running", counts: { running: 1 }, lease: runLease },
		]);
		expect(ledger.listDagRuns({ statuses: [] })).toEqual([]);
		expect(() => ledger.listDagRuns({ limit: 101 })).toThrow("between 1 and 100");
		expect(() => ledger.listDagRuns({ statuses: ["unknown" as never] })).toThrow("Invalid DAG run status");

		const inspected = ledger.inspectDagRun("middle-running", 3);
		expect(inspected).toMatchObject({
			runId: "middle-running",
			status: "running",
			request: { objective: "Execute a durable DAG" },
			tasks: [
				{
					taskId: "inspect",
					contract: { dependsOn: [] },
					attempts: 1,
					checkpoint: { phase: "reading", files: 2 },
					attemptRecords: [{ attemptId: claim.attemptId, status: "running" }],
				},
			],
		});
		expect(inspected?.events).toHaveLength(3);
		expect(inspected?.events.map((event) => event.sequence)).toEqual(
			[...(inspected?.events ?? [])].map((event) => event.sequence).sort((left, right) => left - right),
		);
		expect(ledger.inspectDagRun("missing")).toBeUndefined();
		expect(() => ledger.inspectDagRun("middle-running", 501)).toThrow("between 1 and 500");
		ledger.createDagRun({
			runId: "other-repository",
			request: request([readTask("other")]),
			baseline: { ...baseline, repositoryRoot: "/other" },
		});
		ledger.setDagRunUsage("other-repository", usage, start + 30);
		expect(ledger.listDagRuns({ repositoryRoot: "/repo", limit: 2 }).map((run) => run.runId)).toEqual([
			"newest-created",
			"middle-running",
		]);
		expect(ledger.listDagRuns({ repositoryRoot: "/other" }).map((run) => run.runId)).toEqual(["other-repository"]);
		expect(() => ledger.listDagRuns({ repositoryRoot: "" })).toThrow("cannot be empty");
		ledger.close();
	});

	it("persists external mutation authorization and post-state after an invalid handoff", async () => {
		const externalRoot = await mkdtemp(join(tmpdir(), "subagent-ledger-external-"));
		temporaryPaths.push(externalRoot);
		const task = externalWriterTask("publish", externalRoot);
		const ledger = new RunLedger(":memory:");
		ledger.createDagRun({ runId: "external-journal", request: request([task]), baseline });
		ledger.setDagRunStatus("external-journal", "running", 7_000);
		const [claim] = ledger.claimRunnableTasks("external-journal", "controller", 7_001, 1_000, 1);
		const journal = await createExternalMutationJournal({
			runId: claim.runId,
			taskId: claim.taskId,
			attemptId: claim.attemptId,
			attemptNumber: claim.attemptNumber,
		});
		try {
			ledger.registerDagExternalMutationJournal(journal.policy, claim.ownerId, 7_002);
			const changedPath = join(externalRoot, "published.txt");
			const writer = new ExternalMutationJournalWriter(journal.policy);
			writer.authorize("write-1", "write", changedPath, 7_003);
			await writeFile(changedPath, "published\n");
			await writer.observe("write-1", "succeeded", 7_004);
			const reader = new ExternalMutationJournalReader(journal.policy);
			reader.drain((event) => {
				ledger.recordDagExternalMutationEvent(journal.policy, event, claim.ownerId, 7_005 + event.journalSequence);
			});
			const replay = new ExternalMutationJournalReader(journal.policy);
			const replayed: boolean[] = [];
			replay.drain((event) => {
				replayed.push(
					ledger.recordDagExternalMutationEvent(
						journal.policy,
						event,
						claim.ownerId,
						7_010 + event.journalSequence,
					),
				);
			});
			expect(replayed).toEqual([false, false]);
			ledger.completeDagTask(
				claim.runId,
				claim.taskId,
				claim.attemptId,
				claim.ownerId,
				{ terminalReason: "invalid_handoff", error: "Child did not call submit_handoff" },
				7_020,
			);
			const persisted = ledger.inspectDagRun("external-journal");
			expect(persisted?.tasks[0]?.attemptRecords[0]?.externalMutations).toMatchObject([
				{
					operation: "write",
					path: changedPath,
					authorizationStatus: "authorized",
					toolResult: "succeeded",
					postState: { status: "confirmed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
				},
			]);
			expect(persisted?.events.some((event) => event.type === "external_mutation.authorized")).toBe(true);
			expect(persisted?.events.some((event) => event.type === "external_mutation.observed")).toBe(true);
		} finally {
			ledger.close();
			await journal.cleanup();
		}
	});

	it("recovers a fsynced authorization journal after the Controller dies before SQLite ingestion", async () => {
		const path = await ledgerPath("subagent-ledger-external-crash-");
		const externalRoot = await mkdtemp(join(tmpdir(), "subagent-ledger-external-crash-output-"));
		temporaryPaths.push(externalRoot);
		const task = externalWriterTask("publish", externalRoot);
		let ledger = new RunLedger(path);
		ledger.createDagRun({ runId: "external-crash", request: request([task]), baseline });
		ledger.setDagRunStatus("external-crash", "running", 8_000);
		const [claim] = ledger.claimRunnableTasks("external-crash", "crashed-controller", 8_001, 10, 1);
		const journal = await createExternalMutationJournal({
			runId: claim.runId,
			taskId: claim.taskId,
			attemptId: claim.attemptId,
			attemptNumber: claim.attemptNumber,
		});
		try {
			ledger.registerDagExternalMutationJournal(journal.policy, claim.ownerId, 8_002);
			new ExternalMutationJournalWriter(journal.policy).authorize(
				"write-before-crash",
				"write",
				join(externalRoot, "possibly-written.txt"),
				8_003,
			);
			ledger.close();

			ledger = new RunLedger(path);
			ledger.recoverDagRun("external-crash", 8_020);
			const [source] = ledger.listOpenDagExternalMutationJournals("external-crash");
			expect(source).toMatchObject({
				attemptStatus: "expired",
				consumedSequence: 0,
				policy: { attemptId: claim.attemptId },
			});
			new ExternalMutationJournalReader(journal.policy).drain((event) => {
				ledger.recordDagExternalMutationEvent(journal.policy, event, undefined, 8_021 + event.journalSequence);
			});
			const recovered = ledger.getDagRun("external-crash")?.tasks[0]?.attemptRecords[0]?.externalMutations;
			expect(recovered).toMatchObject([
				{
					toolCallId: "write-before-crash",
					authorizationStatus: "authorized",
				},
			]);
			expect(recovered?.[0]?.toolResult).toBeUndefined();
			expect(recovered?.[0]?.postState).toBeUndefined();
			ledger.releaseDagExternalMutationJournal(journal.policy, undefined, 8_030);
			expect(ledger.listOpenDagExternalMutationJournals("external-crash")).toEqual([]);
		} finally {
			ledger.close();
			await journal.cleanup();
		}
	});
});
