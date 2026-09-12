import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChildHarnessContext, type PermissionMode } from "@easy-pi/permissions";
import { createExternalMutationJournal, type ExternalMutationJournalEvent } from "@easy-pi/permissions/journal";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveActivity } from "../src/live-activity.ts";
import {
	cleanupChildRuntimeRoot,
	type RunChildTaskOptions,
	runChildTask,
	windowsTaskkillInvocation,
} from "../src/process-runner.ts";
import type {
	DagTaskContract,
	ReadOnlyTaskContract,
	SubagentBudget,
	TaskArtifact,
	WriterHandoff,
} from "../src/types.ts";

const fakeChildPath = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));
const snapshots: string[] = [];

const task: ReadOnlyTaskContract = {
	id: "task-1",
	role: "scout",
	objective: "Inspect the example",
	nonGoals: ["Do not modify files"],
	readPaths: ["src"],
	acceptance: ["Return evidence"],
};

const writerTask: DagTaskContract = {
	id: "writer-1",
	role: "writer",
	objective: "Update the owned file",
	nonGoals: ["Do not change other files"],
	readPaths: ["src"],
	acceptance: ["Return a writer handoff"],
	dependsOn: ["dependency"],
	maxAttempts: 1,
	contractHash: "a".repeat(64),
	ownedPaths: ["owned/file.ts"],
	validationCommandIds: ["unit"],
};

const prerequisiteArtifact: TaskArtifact = {
	artifactVersion: 2,
	artifactId: "dependency-artifact",
	taskId: "dependency",
	contractHash: "b".repeat(64),
	handoff: {
		taskId: "dependency",
		summary: "Found the implementation boundary",
		outcome: "accepted",
		evidence: [],
		verification: [],
		assumptions: [],
		risks: [],
		nextActions: [],
		verificationLevel: "unverified",
	},
	changedPaths: [],
	validations: [
		{
			commandId: "dependency-check",
			status: "passed",
			exitCode: 0,
			stdout: "not projected",
			stderr: "",
			durationMs: 1,
		},
	],
	quality: {
		semanticOutcome: "accepted",
		pathAudit: "not_applicable",
		validation: { status: "not_applicable", passedCommandIds: [] },
		review: { status: "not_applicable" },
	},
	createdAt: 1,
};

function budget(overrides: Partial<SubagentBudget> = {}): SubagentBudget {
	return {
		maxTokens: 100,
		...overrides,
	};
}

async function snapshot(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi child snapshot ; "));
	await mkdir(join(path, "src"), { recursive: true });
	await mkdir(join(path, "pi", "packages", "coding-agent"), { recursive: true });
	snapshots.push(path);
	return path;
}

async function runScenario(
	scenario: string,
	options: {
		budget?: Partial<SubagentBudget>;
		limits?: { wallTimeMs?: number; absoluteWallTimeMs?: number; maxOutputBytes?: number; maxStderrBytes?: number };
		signal?: AbortSignal;
		command?: string;
		task?: ReadOnlyTaskContract | DagTaskContract;
		prerequisiteArtifacts?: readonly TaskArtifact[];
		childModel?: { provider: string; model: string; thinkingLevel: "low" };
		controllerEnvironment?: Readonly<NodeJS.ProcessEnv>;
		permissionMode?: PermissionMode;
		retryFeedback?: string;
		workspaceRoot?: string;
		createChildHarnessContext?: RunChildTaskOptions["createChildHarnessContext"];
	} = {},
) {
	const snapshotPath = await snapshot();
	const selectedTask = options.task ?? task;
	const externalEvents: ExternalMutationJournalEvent[] = [];
	const externalJournal =
		selectedTask.role === "external-writer"
			? await createExternalMutationJournal({
					runId: "process-runner-test",
					taskId: selectedTask.id,
					attemptId: "process-runner-attempt",
					attemptNumber: 1,
				})
			: undefined;
	const result = await runChildTask({
		task: selectedTask,
		transport: "json",
		budget: budget(options.budget),
		limits: options.limits,
		snapshotPath,
		workspaceRoot: options.workspaceRoot ?? snapshotPath,
		prerequisiteArtifacts: options.prerequisiteArtifacts,
		childModel: options.childModel,
		controllerEnvironment: {
			...options.controllerEnvironment,
			WJ_EXPECTED_PROTECTED_ROOT: await realpath(options.workspaceRoot ?? snapshotPath),
		},
		createChildHarnessContext:
			options.createChildHarnessContext ??
			((request) =>
				createChildHarnessContext({
					...request,
					permissionMode: options.permissionMode ?? "full-access",
				})),
		...(externalJournal
			? {
					externalMutationJournal: {
						policy: externalJournal.policy,
						onEvent: (event: ExternalMutationJournalEvent) => externalEvents.push(structuredClone(event)),
					},
				}
			: {}),
		retryFeedback: options.retryFeedback,
		signal: options.signal,
		invocation: {
			command: options.command ?? process.execPath,
			args: options.command ? [] : [fakeChildPath, scenario, snapshotPath],
		},
	});
	await externalJournal?.cleanup();
	return Object.assign(result, { externalMutationEvents: externalEvents });
}

async function runRpcScenario(
	scenario:
		| "rpc-success"
		| "rpc-writer-success"
		| "rpc-missing-handoff"
		| "rpc-model-error"
		| "rpc-unlimited-retry-zero-progress"
		| "rpc-unlimited-retry-with-usage"
		| "rpc-unlimited-retry-reset"
		| "rpc-bounded-retry"
		| "rpc-hang"
		| "rpc-idle-abort-no-settle"
		| "rpc-crash"
		| "rpc-extension-dialog"
		| "rpc-soft-budget"
		| "rpc-budget-partial"
		| "rpc-budget-missing-partial"
		| "rpc-budget-invalid-partial",
	options: Pick<RunChildTaskOptions, "onRuntimeReady" | "onRuntimeEvent" | "onLiveActivity" | "onRuntimeClosed"> &
		Partial<Pick<RunChildTaskOptions, "budget" | "softTokenLimit" | "signal" | "resumeRuntime" | "limits">> = {},
	selectedTask: ReadOnlyTaskContract | DagTaskContract = task,
) {
	const snapshotPath = await snapshot();
	return await runChildTask({
		task: selectedTask,
		budget: budget(),
		snapshotPath,
		workspaceRoot: snapshotPath,
		controllerEnvironment: { WJ_EXPECTED_PROTECTED_ROOT: await realpath(snapshotPath) },
		createChildHarnessContext: (request) => createChildHarnessContext({ ...request, permissionMode: "full-access" }),
		...(selectedTask.role === "writer" ? { prerequisiteArtifacts: [prerequisiteArtifact] } : {}),
		invocation: {
			command: process.execPath,
			args: [fakeChildPath, scenario, snapshotPath],
		},
		...options,
	});
}

afterEach(async () => {
	await Promise.all(snapshots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runChildTask", () => {
	it("selects argv-only hidden taskkill process-tree termination on Windows", () => {
		expect(windowsTaskkillInvocation(4321)).toEqual({
			command: "taskkill",
			args: ["/PID", "4321", "/T", "/F"],
			options: { windowsHide: true, shell: false, stdio: "ignore" },
		});
	});

	it("fails closed before Child execution when the WJ context issuer is missing", async () => {
		const snapshotPath = await snapshot();
		const result = await runChildTask({
			task,
			budget: budget(),
			snapshotPath,
			workspaceRoot: snapshotPath,
			invocation: { command: join(tmpdir(), "must-not-run") },
		});

		expect(result).toMatchObject({ success: false, terminalReason: "process_error" });
		expect(result.error).toContain("WJ-owned Child Harness context provider");
	});

	it("uses a controller-owned transport invocation and parses current Pi events into a structured result", async () => {
		const result = await runScenario("success");

		expect(result.success).toBe(true);
		expect(result.terminalReason).toBe("completed");
		expect(result.handoff?.taskId).toBe("task-1");
		expect(result.turns).toBe(2);
		expect(result.model).toBe("fake/model");
		expect(result.isolationLevel).toBe("tool-bounded");
		expect(result.usage).toMatchObject({
			input: 5,
			output: 7,
			cacheRead: 2,
			cacheWrite: 4,
			totalTokens: 12,
		});
		expect(result.usage.cost.total).toBeCloseTo(0.12);
	});

	it("uses process-isolated RPC and accepts only the submitted protocol-v2 handoff", async () => {
		const activities: string[] = [];
		const result = await runRpcScenario("rpc-success", {
			onRuntimeEvent: (_runtime, _event, metadata) => {
				if (metadata.activity) activities.push(metadata.activity);
			},
		});

		expect(result.success).toBe(true);
		expect(result.handoff).toMatchObject({ taskId: "task-1", outcome: "accepted" });
		expect(result.runtime).toMatchObject({
			sessionId: "fake-rpc-session",
			runtimeGeneration: 1,
			provider: "fake",
			model: "fake/model",
			lastEventSeq: expect.any(Number),
		});
		expect(result.runtime?.sessionFile).toBeUndefined();
		expect(result.performance).toMatchObject({
			childStartMs: expect.any(Number),
			firstModelEventMs: expect.any(Number),
			modelExecutionMs: expect.any(Number),
			handoffMs: expect.any(Number),
		});
		expect(result.performance?.handoffMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(result.performance)).not.toContain("diagnostic only");
		expect(activities).toEqual(
			expect.arrayContaining([
				"thinking",
				"using submit_handoff",
				"processing tool result",
				"completed a turn",
				"finishing",
			]),
		);
	});

	it("reuses one recorded RPC runtime root across resume and removes it at terminal completion", async () => {
		const controller = new AbortController();
		const interrupted = await runRpcScenario("rpc-hang", {
			signal: controller.signal,
			onRuntimeReady: () => setTimeout(() => controller.abort(), 20),
		});
		expect(interrupted).toMatchObject({ success: false, terminalReason: "cancelled" });
		const runtimeRoot = interrupted.runtime?.runtimeRoot;
		expect(runtimeRoot).toBeTruthy();
		expect(interrupted.runtime?.sessionFile).toBeTruthy();
		await expect(access(runtimeRoot!)).resolves.toBeUndefined();
		await writeFile(interrupted.runtime!.sessionFile!, "fake durable session\n");

		const resumed = await runRpcScenario("rpc-success", { resumeRuntime: interrupted.runtime });
		expect(resumed.success, resumed.error).toBe(true);
		await expect(access(runtimeRoot!)).rejects.toThrow();
	});

	it("does not wait for Child inactivity when pre-prompt cancellation emits no agent_settled", async () => {
		const controller = new AbortController();
		let cancelledAt = 0;
		const result = await runRpcScenario("rpc-idle-abort-no-settle", {
			signal: controller.signal,
			limits: { wallTimeMs: 1_000, absoluteWallTimeMs: 5_000 },
			onRuntimeReady: () => {
				cancelledAt = Date.now();
				controller.abort();
			},
		});
		try {
			expect(result).toMatchObject({ success: false, terminalReason: "cancelled" });
			expect(cancelledAt).toBeGreaterThan(0);
			expect(Date.now() - cancelledAt).toBeLessThan(500);
		} finally {
			if (result.runtime?.runtimeRoot) await cleanupChildRuntimeRoot(result.runtime);
		}
	});

	it("refuses recursive runtime cleanup when the ownership marker does not match", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "wj-pi-child-marker-test-")));
		snapshots.push(root);
		await writeFile(join(root, ".wj-pi-runtime-owner.json"), `${JSON.stringify({ version: 1, id: "actual" })}\n`);
		await expect(
			cleanupChildRuntimeRoot({
				isolationLevel: "tool-bounded",
				runtimeGeneration: 1,
				lastEventSeq: 0,
				runtimeRoot: root,
				runtimeRootId: "forged",
			}),
		).rejects.toThrow("ownership marker");
		await expect(access(root)).resolves.toBeUndefined();
	});

	it("publishes immutable bounded live activity snapshots from RPC events", async () => {
		const snapshots: LiveActivity[] = [];
		const result = await runRpcScenario("rpc-success", {
			onLiveActivity: (_runtime, activity) => snapshots.push(activity),
		});

		expect(result.success).toBe(true);
		const running = snapshots.find((activity) => activity.tools[0]?.status === "running");
		const completed = snapshots.find((activity) => activity.tools[0]?.status === "success");
		expect(running?.tools[0]).toMatchObject({ toolName: "submit_handoff", status: "running" });
		expect(completed?.tools[0]).toMatchObject({ toolName: "submit_handoff", status: "success" });
		expect(running?.tools[0]?.status).toBe("running");
		expect(snapshots.at(-1)?.text).toBe("diagnostic only");
	});

	it("cancels a headless RPC extension dialog so the Child can submit and settle", async () => {
		const activities: string[] = [];
		const result = await runRpcScenario("rpc-extension-dialog", {
			onRuntimeEvent: (_runtime, _event, metadata) => {
				if (metadata.activity) activities.push(metadata.activity);
			},
		});

		expect(result).toMatchObject({
			success: true,
			terminalReason: "completed",
			handoff: { taskId: "task-1", outcome: "accepted" },
		});
		expect(activities).toContain("extension_ui_request");
	});

	it("steers an RPC child exactly once to submit a final handoff at the relative 90% threshold", async () => {
		const result = await runRpcScenario("rpc-soft-budget", {
			budget: { maxTokens: 10 },
			softTokenLimit: 9,
		});

		expect(result.success).toBe(true);
		expect(result.usage.totalTokens).toBe(9);
		expect(result.handoff).toMatchObject({ taskId: "task-1", outcome: "accepted" });
	});

	it.each([
		["rpc-budget-partial", true],
		["rpc-budget-missing-partial", false],
		["rpc-budget-invalid-partial", false],
	] as const)("preserves only a valid RPC hard-limit handoff for %s", async (scenario, hasPartial) => {
		const result = await runRpcScenario(scenario, { budget: { maxTokens: 10 } });

		expect(result).toMatchObject({ success: false, terminalReason: "budget_exhausted" });
		if (hasPartial) {
			expect(result.partialHandoff).toMatchObject({
				taskId: "task-1",
				outcome: "inconclusive",
				verificationLevel: "unverified",
			});
		} else {
			expect(result.partialHandoff).toBeUndefined();
		}
	});

	it("tells RPC writers that unavailable shell verification and child commits are not inconclusive", async () => {
		const result = await runRpcScenario("rpc-writer-success", {}, { ...writerTask, validationCommandIds: [] });

		expect(result.success).toBe(true);
		expect(result.handoff).toMatchObject({ taskId: "writer-1", outcome: "accepted" });
	});

	it("treats final RPC assistant prose as diagnostics when submit_handoff is missing", async () => {
		const result = await runRpcScenario("rpc-missing-handoff");

		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("invalid_handoff");
		expect(result.error).toContain("did not call submit_handoff");
		expect(result.error).toContain("diagnostic only");
	});

	it("contains an RPC child uncaught exception as a task-local process failure", async () => {
		const result = await runRpcScenario("rpc-crash");

		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("process_error");
		expect(result.error).toContain("simulated child uncaught exception");
	});

	it("preserves a bounded, terminal-safe RPC provider error diagnostic", async () => {
		const result = await runRpcScenario("rpc-model-error");

		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("model_error");
		expect(result.error).toContain("provider overloaded");
		expect(result.error).not.toContain("\u0007");
		expect(result.error?.length).toBeLessThanOrEqual(2_050);
	});

	it("opens the provider circuit after eight structured unlimited retries with no progress", async () => {
		const result = await runRpcScenario("rpc-unlimited-retry-zero-progress", {
			limits: { wallTimeMs: 300, absoluteWallTimeMs: 1_000 },
		});

		expect(result).toMatchObject({
			success: false,
			terminalReason: "provider_circuit_open",
			usage: { totalTokens: 0 },
			turns: 0,
			providerCircuitOpen: {
				version: 1,
				reason: "unlimited_auto_retry",
				autoRetryAttempt: 8,
				consecutiveUnlimitedRetries: 8,
				retryDelayMs: 4_000,
			},
		});
		expect(JSON.stringify(result)).not.toContain("provider-secret-sentinel");
		if (result.runtime?.runtimeRoot) await cleanupChildRuntimeRoot(result.runtime);
	});

	it("opens the provider circuit on the first unlimited retry after reported usage", async () => {
		const result = await runRpcScenario("rpc-unlimited-retry-with-usage", {
			limits: { wallTimeMs: 300, absoluteWallTimeMs: 1_000 },
		});

		expect(result).toMatchObject({
			success: false,
			terminalReason: "provider_circuit_open",
			usage: { totalTokens: 3 },
			turns: 0,
			providerCircuitOpen: {
				autoRetryAttempt: 1,
				consecutiveUnlimitedRetries: 1,
				retryDelayMs: 3_000,
			},
		});
		expect(JSON.stringify(result)).not.toContain("provider-secret-sentinel");
		if (result.runtime?.runtimeRoot) await cleanupChildRuntimeRoot(result.runtime);
	});

	it("resets the zero-progress streak after a successful unlimited retry", async () => {
		const result = await runRpcScenario("rpc-unlimited-retry-reset");

		expect(result).toMatchObject({ success: true, terminalReason: "completed" });
		expect(result).not.toHaveProperty("providerCircuitOpen");
	});

	it("does not open the provider circuit for bounded retry events", async () => {
		const result = await runRpcScenario("rpc-bounded-retry");

		expect(result).toMatchObject({ success: true, terminalReason: "completed" });
		expect(result).not.toHaveProperty("providerCircuitOpen");
	});

	it.each(["tolerant-handoff", "oversized-optional-handoff"])(
		"rejects non-v2 handoff payload %s instead of normalizing paid output",
		async (scenario) => {
			const result = await runScenario(scenario);
			expect(result.success).toBe(false);
			expect(result.terminalReason).toBe("invalid_handoff");
			expect(result.error).toMatch(/handoff/i);
		},
	);

	it("accepts full JSON events while JSON runs request compact events", async () => {
		const result = await runScenario("full-json-success");
		expect(result.success).toBe(true);
		expect(result.handoff?.taskId).toBe("task-1");
		expect(result.turns).toBe(2);
	});

	it("passes an explicit trusted child provider, model, and thinking level as controller-owned argv", async () => {
		const result = await runScenario("model-selection", {
			childModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
		});
		expect(result.success).toBe(true);
		expect(result.model).toBe("fake/model");
	});

	it("receives a WJ-issued inherited permission context without Subagent policy fields", async () => {
		const result = await runScenario("permission-mode", {
			permissionMode: "full-access",
			controllerEnvironment: { WJ_EXPECT_INHERITED_PERMISSION_CONTEXT: "1" },
		});
		expect(result.success, result.error).toBe(true);
	});

	it("omits internal read hints, non-goals, and acceptance arrays from the Child prompt", async () => {
		const result = await runScenario("success", {
			task: { ...task, readPaths: ["packages/coding-agent/src/core/tools/run.ts"] },
		});

		expect(result.success, result.error).toBe(true);
		expect(result.handoff?.taskId).toBe("task-1");
	});

	it("does not expose workspace-absolute read hints in the Child prompt", async () => {
		const workspaceRoot = await snapshot();
		const result = await runScenario("success", {
			workspaceRoot,
			task: { ...task, readPaths: [join(workspaceRoot, "src")] },
			controllerEnvironment: { WJ_FORBIDDEN_PROMPT_PATH: workspaceRoot },
		});
		expect(result.success).toBe(true);
	});

	it("defines task-completion outcome semantics for Analyst negative findings", async () => {
		const result = await runScenario("success");
		expect(result.success, result.error).toBe(true);
	});

	it("preserves verdict outcome semantics for Reviewers", async () => {
		const result = await runScenario("reviewer-success", {
			task: { ...task, role: "reviewer" },
		});
		expect(result.success, result.error).toBe(true);
	});

	it("does not expose external absolute read hints in the Child prompt", async () => {
		const workspaceRoot = await snapshot();
		const externalRoot = await snapshot();
		const result = await runScenario("success", {
			workspaceRoot,
			task: { ...task, readPaths: ["src", externalRoot] },
			controllerEnvironment: { WJ_FORBIDDEN_PROMPT_PATH: externalRoot },
		});
		expect(result.success).toBe(true);
	});

	it("inherits the parent runtime while overriding cache affinity with a controller-derived key", async () => {
		const result = await runScenario("runtime-parity", {
			controllerEnvironment: {
				WJ_PARENT_RUNTIME_SENTINEL: "inherited",
				WJ_SUBAGENT_PROMPT_CACHE_KEY: "caller-controlled",
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects unsafe child model argv values before spawning Pi", async () => {
		const result = await runScenario("success", {
			childModel: { provider: "openai-codex", model: "--help", thinkingLevel: "low" },
		});
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("process_error");
		expect(result.error).toContain("Unsafe child model selection");
	});

	it("passes exact external writable roots to an external-writer child", async () => {
		const workspaceRoot = await snapshot();
		const externalRoot = await snapshot();
		const externalTask: DagTaskContract = {
			id: "external-1",
			role: "external-writer",
			objective: "Publish external file",
			nonGoals: ["Do not write elsewhere"],
			readPaths: [],
			acceptance: ["Record the published path"],
			dependsOn: ["dependency"],
			maxAttempts: 1,
			contractHash: "c".repeat(64),
			externalOwnedPaths: [externalRoot],
		};
		const result = await runScenario("external-writer-success", {
			workspaceRoot,
			task: externalTask,
			prerequisiteArtifacts: [prerequisiteArtifact],
			controllerEnvironment: { WJ_EXPECTED_EXTERNAL_WRITE: externalRoot },
		});
		expect(result.success).toBe(true);
		expect(result.role).toBe("external-writer");
		expect(result.handoff).toMatchObject({
			taskId: "external-1",
			externalChangedPaths: [],
		});
		expect(result.externalMutationEvents.map((event) => event.type)).toEqual(["authorized", "observed"]);
		expect(result.externalMutationEvents[0]).toMatchObject({
			type: "authorized",
			mutation: { operation: "write", path: join(await realpath(externalRoot), "published.txt") },
		});
		expect(result.externalMutationEvents[1]).toMatchObject({
			type: "observed",
			toolResult: "succeeded",
			postState: { status: "confirmed" },
		});
	});

	it("rejects a WJ context issuer that changes the Parent-approved external roots", async () => {
		const workspaceRoot = await snapshot();
		const externalRoot = await snapshot();
		const extraRoot = await snapshot();
		const externalTask: DagTaskContract = {
			id: "external-1",
			role: "external-writer",
			objective: "Publish external file",
			nonGoals: [],
			readPaths: [],
			acceptance: [],
			dependsOn: [],
			maxAttempts: 1,
			contractHash: "f".repeat(64),
			externalOwnedPaths: [externalRoot],
		};
		const result = await runScenario("external-writer-success", {
			workspaceRoot,
			task: externalTask,
			createChildHarnessContext: (request) =>
				createChildHarnessContext({
					...request,
					permissionMode: "full-access",
					inheritedWriteRoots: [...(request.inheritedWriteRoots ?? []), extraRoot],
				}),
		});

		expect(result).toMatchObject({ success: false, terminalReason: "process_error" });
		expect(result.error).toContain("do not match the Parent-approved task roots");
	});

	it("returns authorized external mutation evidence when the child handoff is missing", async () => {
		const workspaceRoot = await snapshot();
		const externalRoot = await snapshot();
		const externalTask: DagTaskContract = {
			id: "external-1",
			role: "external-writer",
			objective: "Publish external file",
			nonGoals: [],
			readPaths: [],
			acceptance: [],
			dependsOn: ["dependency"],
			maxAttempts: 1,
			contractHash: "e".repeat(64),
			externalOwnedPaths: [externalRoot],
		};
		const result = await runScenario("external-writer-invalid-handoff", {
			workspaceRoot,
			task: externalTask,
			prerequisiteArtifacts: [prerequisiteArtifact],
			controllerEnvironment: { WJ_EXPECTED_EXTERNAL_WRITE: externalRoot },
		});
		expect(result).toMatchObject({ success: false, terminalReason: "invalid_handoff" });
		expect(result.externalMutationEvents).toHaveLength(2);
		expect(result.externalMutationEvents[0]).toMatchObject({ type: "authorized" });
		expect(result.externalMutationEvents[1]).toMatchObject({
			type: "observed",
			postState: { status: "confirmed" },
		});
	});

	it.each([
		["inside", (workspaceRoot: string) => join(workspaceRoot, "output")],
		["containing", (workspaceRoot: string) => dirname(workspaceRoot)],
	] as const)("rejects an external-writer root %s the source workspace", async (_position, externalRoot) => {
		const workspaceRoot = await snapshot();
		const result = await runScenario("external-writer-success", {
			workspaceRoot,
			task: {
				id: "external-1",
				role: "external-writer",
				objective: "Publish external file",
				nonGoals: [],
				readPaths: [],
				acceptance: [],
				dependsOn: [],
				maxAttempts: 1,
				contractHash: "d".repeat(64),
				externalOwnedPaths: [externalRoot(workspaceRoot)],
			},
		});
		expect(result).toMatchObject({ success: false, terminalReason: "process_error" });
		expect(result.error).toContain("must not overlap the source workspace");
	});

	it("passes a bounded Writer task contract and parses the writer handoff", async () => {
		const result = await runScenario("writer-success", {
			task: writerTask,
			prerequisiteArtifacts: [prerequisiteArtifact],
		});

		expect(result.success).toBe(true);
		expect(result.role).toBe("writer");
		expect((result.handoff as WriterHandoff).changedPaths).toEqual([]);
	});

	it.each([
		["analyst", "success", "scout"],
		["reviewer", "reviewer-success", "reviewer"],
	] as const)("injects a bounded transitive DependencyView for the %s role", async (_label, scenario, role) => {
		const dependencyTask: DagTaskContract = {
			id: "task-1",
			role,
			objective: "Inspect the example",
			nonGoals: ["Do not modify files"],
			readPaths: ["src"],
			acceptance: ["Return evidence"],
			dependsOn: ["dependency"],
			maxAttempts: 1,
			contractHash: "d".repeat(64),
		};
		const result = await runScenario(scenario, {
			task: dependencyTask,
			prerequisiteArtifacts: [prerequisiteArtifact],
			controllerEnvironment: { WJ_EXPECT_DEPENDENCY_VIEW: prerequisiteArtifact.artifactId },
		});
		expect(result.success, result.error).toBe(true);
		expect(result.role).toBe(role);
	});

	it("passes bounded retry repair context as untrusted data", async () => {
		const result = await runScenario("retry-feedback", {
			retryFeedback: "Repair invalid_handoff: missing outcome",
		});
		expect(result.success).toBe(true);
	});

	it("does not impose a runner tool allowlist on the parent-session tool catalog", async () => {
		const writer = await runScenario("writer-forbidden-tool", {
			task: writerTask,
			prerequisiteArtifacts: [prerequisiteArtifact],
		});
		const readOnly = await runScenario("read-only-edit");
		const shell = await runScenario("forbidden-tool");
		expect(writer.success).toBe(true);
		expect(readOnly.success).toBe(true);
		expect(shell.success).toBe(true);
	});

	it.each([
		["malformed-json", "protocol_error"],
		["invalid-handoff", "invalid_handoff"],
		["nonzero", "process_error"],
		["model-error", "model_error"],
		["invalid-args-hash", "protocol_error"],
	] as const)("fails closed for %s", async (scenario, terminalReason) => {
		const result = await runScenario(scenario);
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe(terminalReason);
	});

	it("detects a stuck tool-call loop and terminates with loop_detected", async () => {
		const result = await runScenario("loop");
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("loop_detected");
		expect(result.error).toContain("read");
	});

	it("terminates when the token budget is exhausted without inventing a missing partial handoff", async () => {
		const result = await runScenario("budget-missing-partial", { budget: { maxTokens: 10 } });
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("budget_exhausted");
		expect(result.partialHandoff).toBeUndefined();
	});

	it.each([
		["budget-partial", true],
		["budget-missing-partial", false],
		["budget-invalid-partial", false],
	] as const)("preserves only a valid JSON hard-limit handoff for %s", async (scenario, hasPartial) => {
		const result = await runScenario(scenario, { budget: { maxTokens: 10 } });
		expect(result).toMatchObject({ success: false, terminalReason: "budget_exhausted" });
		if (hasPartial) {
			expect(result.partialHandoff).toMatchObject({
				taskId: "task-1",
				outcome: "inconclusive",
				verificationLevel: "unverified",
			});
		} else {
			expect(result.partialHandoff).toBeUndefined();
		}
	});

	it("accepts a valid cumulative JSON event stream larger than the former 64 KiB cap", async () => {
		const result = await runScenario("long-valid-stream");
		expect(result.success).toBe(true);
		expect(result.handoff?.taskId).toBe("task-1");
	});

	it("accepts one valid ignored JSON event larger than 256 KiB when the cumulative stream is bounded", async () => {
		const result = await runScenario("oversized-event");
		expect(result.success).toBe(true);
		expect(result.handoff?.taskId).toBe("task-1");
	});

	it.each([
		["large-output", { maxOutputBytes: 128 }],
		["large-stderr", { maxStderrBytes: 128 }],
	] as const)("terminates %s with a transport-specific reason", async (scenario, limit) => {
		const result = await runScenario(scenario, { limits: limit });
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("transport_limit");
	});

	it("enforces streaming token budgets and preserves reported usage before message_end", async () => {
		const result = await runScenario("streaming-budget", { budget: { maxTokens: 10 } });
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("budget_exhausted");
		expect(result.usage.totalTokens).toBe(40);
	});

	it("lets valid JSON activity extend execution beyond one elapsed inactivity interval", async () => {
		const result = await runScenario("active-before-success", { limits: { wallTimeMs: 200 } });
		expect(result.success, result.error).toBe(true);
		expect(result.terminalReason).toBe("completed");
	});

	it("enforces an absolute attempt deadline even while the child emits activity", async () => {
		const result = await runScenario("active-before-success", {
			limits: { wallTimeMs: 200, absoluteWallTimeMs: 120 },
		});
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("timeout");
		expect(result.error).toContain("absolute attempt limit");
	});

	it("enforces the inactivity timeout when the child emits no events", async () => {
		const result = await runScenario("hang", { limits: { wallTimeMs: 25 } });
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("timeout");
	});

	it("propagates parent cancellation to the child process group and its descendants", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const startedAt = Date.now();
		const result = await runScenario("descendant-hang", { signal: controller.signal });
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("cancelled");
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	it("returns process errors for invocation failures", async () => {
		const result = await runScenario("unused", { command: join(tmpdir(), "missing-pi-executable") });
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("process_error");
	});

	it("does not spawn when the parent is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runScenario("unused", {
			command: join(tmpdir(), "missing-pi-executable"),
			signal: controller.signal,
		});
		expect(result.success).toBe(false);
		expect(result.terminalReason).toBe("cancelled");
	});
});
