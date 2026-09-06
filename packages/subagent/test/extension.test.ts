import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_POLICY, MAX_SUBAGENT_REQUEST_BYTES } from "../src/contracts.ts";
import { DagRunInterruptedError, SubagentDagRunError } from "../src/dag-orchestrator.ts";
import {
	createSubagentExtension,
	MAX_SUBAGENT_RESULT_BYTES,
	MAX_SUBAGENT_RESULT_LINES,
	type SubagentDagOrchestratorAdapter,
	type SubagentOperatorAuthorizationRequest,
} from "../src/extension.ts";
import { RunLedger, ZERO_USAGE } from "../src/ledger.ts";
import { writeSubagentModelPreferences } from "../src/model-preferences.ts";
import type { SubagentDagRunDetails } from "../src/types.ts";
import { NotAGitRepositoryError } from "../src/worktree.ts";

const testAgentDir = mkdtempSync(join(tmpdir(), "easy-pi-subagent-prefs-"));
afterAll(() => rmSync(testAgentDir, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "utf8", shell: false }, (error, stdout, stderr) => {
			if (error) return reject(new Error(String(stderr).trim() || error.message));
			resolve(String(stdout).trim());
		});
	});
}

function modelToolContext(cwd = "/repo") {
	const model = { provider: "openai-codex", id: "parent", reasoning: true };
	return {
		cwd,
		model,
		thinkingLevel: "low",
		modelRegistry: { getAvailable: () => [model] },
		ui: { setStatus: () => undefined, notify: () => undefined },
	};
}

function dagDetails(status: "running" | "succeeded" | "failed", totalTokens: number): SubagentDagRunDetails {
	const taskStatus = status === "succeeded" ? "succeeded" : status === "failed" ? "failed" : "running";
	return {
		runId: "dag-run",
		status,
		objective: "Implement",
		baseline: {
			repositoryRoot: "/repo",
			headCommit: "abc",
			snapshotId: "dag-snapshot",
			fileCount: 1,
			totalBytes: 1,
		},
		tasks: [
			{
				taskId: "write",
				role: "writer",
				status: taskStatus,
				attempts: 1,
				maxAttempts: 2,
				dependsOn: [],
				usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost, total: 0.04 }, totalTokens: 4 },
				runtime: {
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					thinkingLevel: "medium",
					isolationLevel: "tool-bounded",
					sessionId: "session-1",
					runtimeGeneration: 2,
					lastEventSeq: 9,
					activity: status === "running" ? "using read" : "completed",
				},
				nextAction: status === "running" ? "wait or send task control" : "none",
				...(status === "running"
					? {
							liveActivity: {
								thinking: "live thought\u001b]0;unsafe\u0007",
								text: "draft answer",
								tools: [
									{
										toolCallId: "call-0",
										toolName: "grep",
										args: '{"pattern":"TODO"}',
										output: "",
										status: "pending" as const,
									},
									{
										toolCallId: "call-1",
										toolName: "read",
										args: '{"path":"README.md"}',
										output: "file preview",
										status: "running" as const,
									},
									{
										toolCallId: "call-2",
										toolName: "bash",
										args: '{"command":"npm test"}',
										output: "passed",
										status: "success" as const,
									},
									{
										toolCallId: "call-3",
										toolName: "write",
										args: '{"path":"bad"}',
										output: "denied",
										status: "error" as const,
									},
								],
							},
						}
					: {}),
				...(status === "succeeded" ? { terminalReason: "completed" as const } : {}),
				...(status === "failed" ? { terminalReason: "model_error" as const, error: "provider failed" } : {}),
			},
		],
		usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost }, totalTokens },
		budget: { maxTokens: 20_000 },
		budgetScope: "task" as const,
		graphVersion: 1,
		graphSealed: true,
		pausedDurationMs: 0,
		resources: { candidate: status === "succeeded" ? "retained" : "none", pins: "retained" },
		...(status === "succeeded"
			? {
					integration: {
						artifactVersion: 1 as const,
						kind: "complete" as const,
						ref: "refs/heads/pi/subagent/integration/dag-run",
						commit: "def",
						orderedTaskIds: ["write"],
						orderedCommits: ["def"],
						createdAt: 1,
						quality: {
							semanticOutcome: "accepted",
							pathAuditCoverage: "full",
							validationCoverage: "not_applicable",
							commitPinCoverage: "full",
							reviewCoverage: "none",
							reviewVerdict: "none",
							gate: "passed",
							gateFailures: [],
							writerTaskIds: ["write"],
							pathAuditedWriterTaskIds: ["write"],
							validatedWriterTaskIds: [],
							pinnedWriterTaskIds: ["write"],
							reviewerTaskIds: [],
							acceptedReviewerTaskIds: [],
							fullCoverageReviewerTaskIds: [],
							requiredWriterCommits: [{ taskId: "write", artifactId: "artifact-write", commit: "def" }],
							reviewedWriterCommits: [],
						},
					},
				}
			: {}),
	};
}

describe("createSubagentExtension", () => {
	it("uses an injected DAG adapter for one-shot start, progress, and safe rendering", async () => {
		let registered: ToolDefinition | undefined;
		let shutdown: (() => Promise<void>) | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on(event: string, handler: unknown) {
				if (event === "session_shutdown") shutdown = handler as () => Promise<void>;
			},
		} as unknown as ExtensionAPI;
		const details = dagDetails("succeeded", 9);
		const start = vi.fn(async (options: Parameters<SubagentDagOrchestratorAdapter["start"]>[0]) => {
			expect(options.repositoryPath).toBe("/repo");
			expect(options.request.childModel).toEqual({
				provider: "openai-codex",
				model: "gpt-5.4-mini",
				thinkingLevel: "low",
			});
			expect(options.request.tasks[0]).toMatchObject({ role: "writer", validationCommandIds: ["unit"] });
			expect(options.request.merge.enabled).toBe(true);
			const progressDetails = dagDetails("running", 3);
			options.onProgress?.({
				details: progressDetails,
				counts: {
					total: 1,
					completed: 0,
					pending: 0,
					running: 1,
					succeeded: 0,
					failed: 0,
					cancelled: 0,
					blocked: 0,
				},
				total: 1,
				completed: 0,
				pending: 0,
				running: 1,
				succeeded: 0,
				failed: 0,
				cancelled: 0,
				blocked: 0,
			});
			return details;
		});
		const resume = vi.fn(async (_options: Parameters<SubagentDagOrchestratorAdapter["resume"]>[0]) => details);
		const expand = vi.fn(
			async (_options: Parameters<NonNullable<SubagentDagOrchestratorAdapter["expand"]>>[0]) => details,
		);
		const inspect = vi.fn((_runId: Parameters<SubagentDagOrchestratorAdapter["inspect"]>[0]) => details);
		const controlTask = vi.fn(async () => dagDetails("running", 9));
		const dagOrchestrator: SubagentDagOrchestratorAdapter = {
			start,
			expand,
			resume,
			inspect,
			controlTask,
			shutdown: vi.fn(async () => {}),
		};
		const ledger = new RunLedger(":memory:");
		createSubagentExtension({
			agentDir: testAgentDir,
			ledger,
			dagOrchestrator,
			childModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
			resolveRepositoryRoot: async (cwd) => cwd,
			validationCommands: [
				{
					id: "unit",
					command: process.execPath,
					args: [],
					timeoutMs: 1_000,
					maxOutputBytes: 1_000,
				},
			],
		})(pi);

		const updates = vi.fn();
		const statuses: Array<string | undefined> = [];
		const notifications: string[] = [];
		const context = {
			cwd: "/repo",
			model: { provider: "openai-codex", id: "gpt-5.4-mini" },
			thinkingLevel: "low",
			modelRegistry: {
				getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true }],
			},
			ui: {
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				notify: (message: string) => notifications.push(message),
			},
		};
		const result = await registered?.execute(
			"dag-start",
			{
				tasks: [
					{
						id: "write",
						objective: "Write",
						ownedPaths: ["src/write.ts"],
					},
				],
			},
			undefined,
			updates,
			context as never,
		);
		expect(registered?.description).not.toContain("unit");
		expect(registered?.renderShell).toBe("self");
		const promptGuidelines = registered?.promptGuidelines?.join(" ") ?? "";
		expect(promptGuidelines).toContain("Prefer one coherent task");
		expect(promptGuidelines).toContain("let the Subagent discover implementation details");
		expect(promptGuidelines).toContain("reviewOf for an independent verdict");
		expect(promptGuidelines).toContain("Controller-registered validation commands are applied automatically");
		expect(promptGuidelines).not.toContain("focusPaths");
		expect(promptGuidelines).toContain("inherit Parent WJ permission mode, session grants, and tool catalog");
		expect(promptGuidelines).not.toContain("maxTokensPerTask");
		expect(start).toHaveBeenCalledOnce();
		expect(updates.mock.calls[0]?.[0].content[0].text).toContain("1 running");
		const theme = {
			fg: (color: string, text: string) => `[${color}]${text}[/]`,
			bold: (text: string) => text,
		};
		const partial = registered?.renderResult?.(
			updates.mock.calls[0]?.[0] as never,
			{ isPartial: true, expanded: false } as never,
			theme as never,
			undefined as never,
		);
		const partialText = partial?.render(500).join("\n") ?? "";
		expect(partialText).toContain("write · Isolated Write · Running — Using read");
		expect(partialText).toContain("gpt-5.6-luna · medium effort");
		expect(partialText).toContain("[accent]✦ live thought]0;unsafe[/]");
		expect(partialText).toContain("[muted]◇ grep[/]");
		expect(partialText).toContain("[accent]◈ read[/]");
		expect(partialText).toContain("[success]◆ bash[/]");
		expect(partialText).toContain("[error]✕ write[/]");
		expect(partialText).toContain("file preview");
		expect(partialText).toContain("draft answer");
		expect(partialText).not.toContain("\u001b");
		expect(partialText).not.toContain("\u0007");
		expect(result?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Candidate:"),
		});
		expect(result?.content[0]?.type === "text" ? result.content[0].text : "").toContain("trust=unvalidated");
		expect(result?.usage?.totalTokens).toBe(9);
		expect(statuses).toEqual(expect.arrayContaining([expect.stringContaining("dag-run"), undefined]));
		expect(statuses.at(-1)).toBeUndefined();
		expect(notifications).toContain(
			"Subagent dag-run: candidate ready at refs/heads/pi/subagent/integration/dag-run",
		);

		for (const rejected of [
			{ operation: "start", tasks: [{ id: "inspect", objective: "inspect" }] },
			{ operation: "resume", runId: "dag-run" },
			{ operation: "inspect", runId: "dag-run", taskId: "write" },
			{ operation: "expand", runId: "dag-run", tasks: [] },
			{ operation: "message", runId: "dag-run", taskId: "write", message: "focus here" },
		]) {
			expect(Value.Check(registered?.parameters as never, rejected)).toBe(false);
		}
		expect(resume).not.toHaveBeenCalled();
		expect(inspect).not.toHaveBeenCalled();
		expect(expand).not.toHaveBeenCalled();
		expect(controlTask).not.toHaveBeenCalled();

		expect(() =>
			registered?.renderCall?.({ tasks: [{ id: "write" }] }, theme as never, undefined as never),
		).not.toThrow();
		const rendered = registered?.renderResult?.(
			result as never,
			{ isPartial: false, expanded: false } as never,
			theme as never,
			undefined as never,
		);
		const collapsed = rendered?.render(500).join("\n") ?? "";
		expect(collapsed).toContain("dag-run");
		expect(collapsed).toContain("1/1 done");
		expect(collapsed).toContain("9 tok");
		expect(collapsed).toContain("candidate refs/heads/pi/subagent/integration/dag-run");
		expect(collapsed).not.toContain("0 running");
		expect(collapsed).not.toContain("Objective: Implement");
		const ansiTheme = {
			fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[39m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
		};
		const ansiRendered = registered?.renderResult?.(
			result as never,
			{ isPartial: false, expanded: false } as never,
			ansiTheme as never,
			undefined as never,
		);
		expect(ansiRendered?.render(500).join("\n")).toContain("\u001b[");
		const expanded = registered?.renderResult?.(
			result as never,
			{ isPartial: false, expanded: true } as never,
			theme as never,
			undefined as never,
		);
		const expandedText = expanded?.render(500).join("\n") ?? "";
		expect(expandedText).toContain("Run: dag-run");
		expect(expandedText).toMatch(/Objective:\s+Implement/);
		expect(expandedText).toContain("attempt 1/2");
		expect(expandedText).toContain("Model: gpt-5.6-luna · medium effort");
		expect(expandedText).toContain("Isolation: tool-bounded");
		expect(expandedText).toContain("Usage: 4 tok · $0.0400");
		expect(expandedText).not.toContain("session=session-1");
		expect(expandedText).not.toContain("generation=");
		expect(expandedText).not.toContain("event=");
		expect(expandedText).toContain("9 tok total · 20,000 tok/task");
		expect(expandedText).toContain("Candidate lifecycle: retained; pins: retained");
		await shutdown?.();
		ledger.close();
	});

	it("hides validation IDs, applies them in the Controller, and rejects policy/registry drift", () => {
		let registered: ToolDefinition | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on() {},
		} as unknown as ExtensionAPI;
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			validationCommands: [
				{ id: "unit:test", command: process.execPath, args: [], timeoutMs: 1_000, maxOutputBytes: 1_000 },
			],
			dagOrchestrator: {
				start: async () => dagDetails("succeeded", 0),
				resume: async () => dagDetails("succeeded", 0),
				inspect: () => dagDetails("succeeded", 0),
				shutdown: async () => {},
			},
		})(pi);
		expect(
			Value.Check(registered?.parameters as never, {
				tasks: [
					{
						id: "write",
						objective: "write",
						ownedPaths: ["src"],
						validationCommandIds: ["unit:test"],
					},
				],
			}),
		).toBe(false);
		expect(
			Value.Check(registered?.parameters as never, {
				tasks: [{ id: "write", objective: "write", ownedPaths: ["src"] }],
			}),
		).toBe(true);
		expect(
			Value.Check(registered?.parameters as never, {
				childModels: { writer: { provider: "attacker", model: "injected" } },
				tasks: [{ id: "inspect", objective: "inspect" }],
			}),
		).toBe(false);
		expect(() =>
			createSubagentExtension({
				agentDir: testAgentDir,
				ledgerPath: ":memory:",
				policy: { ...DEFAULT_SUBAGENT_POLICY, allowedValidationCommandIds: ["policy-only"] },
			})(pi),
		).toThrow("validation policy/registry mismatch");
	});

	it("keeps isolated writer candidates available and labels them unvalidated when no validation is registered", async () => {
		let registered: ToolDefinition | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on() {},
		} as unknown as ExtensionAPI;
		const ledger = new RunLedger(":memory:");
		const details = dagDetails("succeeded", 0);
		details.tasks[0]!.artifact = {
			artifactVersion: 2,
			artifactId: "artifact-write",
			taskId: "write",
			contractHash: "hash",
			handoff: {
				taskId: "write",
				summary: "Implemented the requested change",
				outcome: "accepted",
				evidence: [],
				verification: [],
				assumptions: [],
				risks: [],
				nextActions: [],
				verificationLevel: "unverified",
				artifactVersion: 2,
				changedPaths: [],
			},
			changedPaths: [],
			validations: [],
			quality: {
				semanticOutcome: "accepted",
				pathAudit: "passed",
				validation: { status: "not_run", passedCommandIds: [] },
				review: { status: "not_applicable" },
			},
			commit: "def",
			createdAt: 1,
		};
		createSubagentExtension({
			agentDir: testAgentDir,
			ledger,
			modelPreferencesPath: join(tmpdir(), "wj-subagent-test-no-validation-model-preferences.json"),
			budgetPreferencesPath: join(tmpdir(), "wj-subagent-test-no-validation-budget-preferences.json"),
			dagOrchestrator: {
				start: async () => details,
				resume: async () => details,
				inspect: () => details,
				shutdown: async () => {},
			},
		})(pi);

		expect(registered?.description).not.toContain("createCandidate");
		expect(
			Value.Check(registered?.parameters as never, {
				tasks: [{ id: "write", objective: "write", ownedPaths: ["src"] }],
			}),
		).toBe(true);
		expect(
			Value.Check(registered?.parameters as never, {
				createCandidate: true,
				tasks: [{ id: "write", objective: "write", ownedPaths: ["src"] }],
			}),
		).toBe(false);
		const result = await registered?.execute(
			"unvalidated",
			{ tasks: [{ id: "write", objective: "write", ownedPaths: ["src"] }] },
			undefined,
			undefined,
			modelToolContext() as never,
		);
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Controller validation: unvalidated (no command configured)");
		expect(text).toContain("trust=unvalidated");
		ledger.close();
	});

	it("labels failed-run delivery as a non-accepted Partial Candidate with provenance", async () => {
		let registered: ToolDefinition | undefined;
		let toolResultHandler: ((event: { toolName: string; toolCallId: string }) => unknown) | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on(event: string, handler: unknown) {
				if (event === "tool_result") {
					toolResultHandler = handler as (event: { toolName: string; toolCallId: string }) => unknown;
				}
			},
		} as unknown as ExtensionAPI;
		const details = dagDetails("succeeded", 9);
		details.status = "failed";
		details.tasks.push({
			taskId: "fail",
			role: "scout",
			status: "failed",
			attempts: 1,
			maxAttempts: 1,
			dependsOn: [],
			terminalReason: "model_error",
			error: "branch failed",
		});
		const complete = details.integration!;
		details.integration = {
			...complete,
			kind: "partial",
			quality: { ...complete.quality!, gate: "failed", gateFailures: ["dag_incomplete"] },
			partial: {
				reason: "task_failure",
				completeGateFailures: [],
				trust: "controller_validated",
				includedWriterTaskIds: ["write"],
				omittedWriterTasks: [],
				negativeTasks: [{ taskId: "fail", status: "failed", terminalReason: "model_error" }],
			},
		};
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			modelPreferencesPath: join(tmpdir(), "wj-subagent-test-partial-model-preferences.json"),
			budgetPreferencesPath: join(tmpdir(), "wj-subagent-test-partial-budget-preferences.json"),
			dagOrchestrator: {
				start: async () => {
					throw new SubagentDagRunError("branch failed", details);
				},
				resume: async () => details,
				inspect: () => details,
				shutdown: async () => {},
			},
		})(pi);
		await expect(
			registered?.execute(
				"partial-result",
				{
					tasks: [
						{ id: "write", objective: "write", ownedPaths: ["src"] },
						{ id: "fail", objective: "fail" },
					],
				},
				undefined,
				undefined,
				modelToolContext() as never,
			),
		).rejects.toThrow("branch failed");
		const patched = toolResultHandler?.({ toolName: "subagent", toolCallId: "partial-result" }) as
			| { content?: Array<{ type: string; text: string }>; details?: SubagentDagRunDetails; isError?: boolean }
			| undefined;
		const text = patched?.content?.[0]?.text ?? "";
		expect(patched?.isError).toBe(true);
		expect(text).toContain("Partial Candidate (non-accepted)");
		expect(text).toContain("kind=partial; accepted=no");
		expect(text).toContain("trust=controller_validated");
		expect(text).toContain("reason=task_failure");
		expect(text).toContain("negative=fail:model_error");
		const rendered = registered?.renderResult?.(
			patched as never,
			{ isPartial: false, expanded: true } as never,
			{ fg: (_color: string, value: string) => value, bold: (value: string) => value } as never,
			undefined as never,
		);
		expect(rendered?.render(500).join("\n")).toContain("Partial Candidate (non-accepted)");
	});

	it("rejects oversized requests before invoking the DAG adapter", async () => {
		let registered: ToolDefinition | undefined;
		const start = vi.fn(async () => dagDetails("succeeded", 0));
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on() {},
		} as unknown as ExtensionAPI;
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			dagOrchestrator: {
				start,
				resume: async () => dagDetails("succeeded", 0),
				inspect: () => dagDetails("succeeded", 0),
				shutdown: async () => {},
			},
		})(pi);
		await expect(
			registered?.execute(
				"large",
				{
					tasks: [{ id: "inspect", objective: "x".repeat(MAX_SUBAGENT_REQUEST_BYTES) }],
				},
				undefined,
				undefined,
				{
					cwd: "/repo",
					model: { provider: "openai-codex", id: "gpt-5.4-mini" },
					thinkingLevel: "low",
					modelRegistry: {
						getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true }],
					},
					ui: { setStatus: () => undefined },
				} as never,
			),
		).rejects.toThrow("byte limit");
		expect(start).not.toHaveBeenCalled();
	});

	it("bounds aggregate model output while preserving every task status", async () => {
		let registered: ToolDefinition | undefined;
		const details = dagDetails("failed", 0);
		details.tasks = Array.from({ length: 32 }, (_, index) => ({
			taskId: `task-${index}`,
			role: index === 1 ? ("reviewer" as const) : ("scout" as const),
			status: index % 2 === 0 ? ("succeeded" as const) : ("failed" as const),
			attempts: 1,
			maxAttempts: 1,
			dependsOn: [],
			terminalReason: index % 2 === 0 ? ("completed" as const) : ("model_error" as const),
			...(index % 2 === 0
				? {
						artifact: {
							artifactVersion: 2 as const,
							artifactId: `artifact-${index}`,
							taskId: `task-${index}`,
							contractHash: "hash",
							handoff: {
								taskId: `task-${index}`,
								summary: "s".repeat(10_000),
								outcome: "accepted" as const,
								evidence: [
									{ path: `src/task-${index}.ts`, lineRange: "1-5", claim: "Relevant implementation" },
								],
								verification: [
									{
										check: "child-check",
										status: "not-run" as const,
										details: "Requires parent verification",
									},
								],
								assumptions: [],
								risks: ["Runtime behavior remains unverified"],
								nextActions: [],
								verificationLevel: "unverified" as const,
							},
							changedPaths: [`src/task-${index}.ts`],
							validations: [
								{
									commandId: "unit",
									status: "failed" as const,
									exitCode: 1,
									stdout: "",
									stderr: "assertion failed",
									durationMs: 10,
								},
							],
							quality: {
								semanticOutcome: "accepted" as const,
								pathAudit: "not_applicable" as const,
								validation: { status: "not_applicable" as const, passedCommandIds: [] },
								review: { status: "not_applicable" as const },
							},
							createdAt: 1,
						},
					}
				: { error: "e".repeat(10_000) }),
		}));
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on() {},
		} as unknown as ExtensionAPI;
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			modelPreferencesPath: join(tmpdir(), "wj-subagent-test-no-aggregate-preferences.json"),
			resolveRepositoryRoot: async (cwd) => cwd,
			dagOrchestrator: {
				start: async () => details,
				resume: async () => details,
				inspect: () => details,
				shutdown: async () => {},
			},
		})(pi);
		const result = await registered?.execute(
			"run-large",
			{ tasks: [{ id: "aggregate", objective: "Return all task results" }] },
			undefined,
			undefined,
			modelToolContext() as never,
		);
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_SUBAGENT_RESULT_BYTES);
		expect(text.split("\n").length).toBeLessThanOrEqual(MAX_SUBAGENT_RESULT_LINES);
		for (let index = 0; index < 32; index++) {
			expect(text).toContain(`Task task-${index}:`);
			if (index % 2 === 0) {
				expect(text).toContain(`task-${index} [report]: succeeded; outcome=accepted`);
				expect(text).toContain(`src/task-${index}.ts`);
			} else {
				expect(text).toContain(`task-${index}${index === 1 ? " [review]" : " [report]"}: failed; model_error`);
				expect(text).toContain("Error:");
			}
		}
		expect(text).not.toContain("task-0 [scout]");
		expect(text).not.toContain("task-0 [analyst]");
		expect(text).toContain("Controller validations:");
		expect(text).toContain("Risks:");
		expect(text).toContain("Evidence:");
		expect(text).toContain("Child-reported verification:");
		expect(text).toContain("Per-task details were truncated");
		expect(text).not.toContain('"operation":"inspect"');
		expect(text).not.toContain('"taskId"');
		expect(text).not.toMatch(/inspect (?:one|each|the) task/i);
	});

	it("shows a budget partial handoff in the active model result and expanded TUI without claiming completion", async () => {
		let registered: ToolDefinition | undefined;
		const details = dagDetails("failed", 11);
		details.tasks[0] = {
			...details.tasks[0]!,
			status: "failed",
			terminalReason: "budget_exhausted",
			error: "Child exceeded token limit",
			partialHandoff: {
				taskId: "write",
				summary: "Reached the parser boundary before budget exhaustion",
				outcome: "inconclusive",
				evidence: [{ path: "src/parser.ts", lineRange: "10-20", claim: "Located the remaining branch" }],
				verification: [{ check: "static inspection", status: "passed" }],
				assumptions: [],
				risks: ["Runtime checks were not completed"],
				nextActions: ["Resume with enough budget to finish the branch"],
				verificationLevel: "self_reported",
				artifactVersion: 2,
				changedPaths: ["src/parser.ts"],
			},
		};
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on() {},
		} as unknown as ExtensionAPI;
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			modelPreferencesPath: join(tmpdir(), "wj-subagent-test-no-partial-preferences.json"),
			resolveRepositoryRoot: async (cwd) => cwd,
			dagOrchestrator: {
				start: async () => details,
				resume: async () => details,
				inspect: () => details,
				shutdown: async () => {},
			},
		})(pi);
		const result = await registered?.execute(
			"run-partial",
			{ tasks: [{ id: "write", objective: "Return partial progress" }] },
			undefined,
			undefined,
			modelToolContext() as never,
		);
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Partial handoff (task incomplete; no artifact)");
		expect(text).toContain("Reached the parser boundary");
		expect(text).toContain("Runtime checks were not completed");
		expect(text).toContain("Located the remaining branch");
		expect(text).not.toContain("Quality:");
		expect(details.tasks[0]?.artifact).toBeUndefined();

		const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
		const rendered = registered?.renderResult?.(
			result as never,
			{ isPartial: false, expanded: true } as never,
			theme as never,
			undefined as never,
		);
		const renderedText = rendered?.render(500).join("\n") ?? "";
		expect(renderedText).toContain("Partial handoff (incomplete; no artifact)");
		expect(renderedText).toContain("Reached the parser boundary");
	});

	it("returns bounded evidence-rich task details in the active one-shot result", async () => {
		let registered: ToolDefinition | undefined;
		const details = dagDetails("succeeded", 0);
		details.tasks = [
			{
				taskId: "writer",
				role: "writer",
				status: "succeeded",
				attempts: 1,
				maxAttempts: 1,
				dependsOn: [],
				terminalReason: "completed",
				artifact: {
					artifactVersion: 2,
					artifactId: "artifact-writer",
					taskId: "writer",
					contractHash: "hash",
					handoff: {
						taskId: "writer",
						summary: "Implemented the parser change",
						outcome: "accepted",
						evidence: [{ path: "src/parser.ts", lineRange: "10-20", claim: "Implements parsing" }],
						verification: [
							{ check: "child-static-review", status: "passed" },
							{ check: "runtime", status: "not-run", details: "Parent must run integration tests" },
						],
						assumptions: ["Input remains UTF-8"],
						risks: ["Malformed input path needs fuzzing"],
						nextActions: ["Run parser integration tests"],
						verificationLevel: "self_reported",
						artifactVersion: 2,
						changedPaths: ["src/parser.ts"],
					},
					changedPaths: ["src/parser.ts"],
					validations: [
						{
							commandId: "unit",
							status: "failed",
							exitCode: 1,
							stdout: "",
							stderr: "\u001b[31massertion failed\u001b[0m".repeat(100),
							durationMs: 25,
						},
					],
					quality: {
						semanticOutcome: "rejected",
						pathAudit: "passed",
						validation: { status: "failed", passedCommandIds: [] },
						review: { status: "not_applicable" },
					},
					commit: "abc123",
					createdAt: 1,
				},
			},
		];
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on() {},
		} as unknown as ExtensionAPI;
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			modelPreferencesPath: join(tmpdir(), "wj-subagent-test-no-task-preferences.json"),
			resolveRepositoryRoot: async (cwd) => cwd,
			dagOrchestrator: {
				start: async () => details,
				resume: async () => details,
				inspect: () => details,
				shutdown: async () => {},
			},
		})(pi);
		const result = await registered?.execute(
			"run-task",
			{ tasks: [{ id: "writer", objective: "Return writer result" }] },
			undefined,
			undefined,
			modelToolContext() as never,
		);
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_SUBAGENT_RESULT_BYTES);
		expect(text).toContain("writer [isolated-write]: succeeded; outcome=accepted");
		expect(text).toContain("Controller validations:");
		expect(text).toContain("Quality: semantic=rejected; path-audit=passed; validation=failed; review=not_applicable");
		expect(text).toContain("unit=failed(exit 1)");
		expect(text).toContain("Evidence: src/parser.ts:10-20 — Implements parsing");
		expect(text).toContain("Child-reported verification:");
		expect(text).toContain("Risks:");
		expect(text).toContain("Changed: src/parser.ts");
		expect(text).toContain("Commit: abc123");
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain('"operation":"inspect"');
		expect(Value.Check(registered?.parameters as never, { taskId: "missing" })).toBe(false);
	});

	it("registers deterministic operator commands, completions, authorization, and non-TUI denial", async () => {
		let registered: ToolDefinition | undefined;
		let command:
			| {
					handler(args: string, ctx: unknown): Promise<void>;
					getArgumentCompletions?(prefix: string): unknown;
			  }
			| undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand(name: string, value: typeof command) {
				if (name === "subagents") command = value;
			},
			on() {},
		} as unknown as ExtensionAPI;
		const details = { ...dagDetails("running", 4), objective: "Operator \u001b]0;owned\u0007 test" };
		details.tasks[0]!.providerCircuitOpen = {
			version: 1,
			reason: "unlimited_auto_retry",
			autoRetryAttempt: 8,
			consecutiveUnlimitedRetries: 8,
			retryDelayMs: 500,
			retryNotBefore: 2_001,
		};
		const resume = vi.fn(async () => details);
		const pause = vi.fn(async () => ({ ...details, pausedAt: 10 }));
		const cancel = vi.fn(async () => ({ ...details, status: "cancelled" as const }));
		const releaseCandidate = vi.fn(async () => ({
			...details,
			resources: { ...details.resources, candidate: "released" as const },
		}));
		const gc = vi.fn(async () => ({ ...details, resources: { ...details.resources, pins: "released" as const } }));
		const diffCandidate = vi.fn(async () => ({
			runId: "dag-run",
			baselineCommit: "abc",
			candidateRef: "refs/heads/pi/subagent/integration/dag-run",
			candidateCommit: "def",
			changedPaths: ["src/write.ts"],
			patch: "diff --git a/src/write.ts b/src/write.ts\n+\u001b]0;owned\u0007payload",
			truncated: false,
		}));
		const dagOrchestrator: SubagentDagOrchestratorAdapter = {
			start: async () => details,
			resume,
			inspect: () => details,
			inspectOperator: () =>
				({
					createdAt: 1,
					updatedAt: 1_501,
					tasks: [],
					events: [],
					performance: {
						version: 1,
						runId: "dag-run",
						status: "running",
						outcome: "running",
						wallClockMs: 1_500,
						activeWallClockMs: 1_200,
						criticalPathMs: 900,
						claimWaitMs: 100,
						runnableButIdleMs: 25,
						retryCount: 2,
						usage: details.usage,
						turns: 3,
						stages: {
							model_execution: { count: 2, totalMs: 700, p50Ms: 300, p95Ms: 400, maxMs: 400 },
						},
					},
				}) as never,
			list: () => [
				{
					runId: details.runId,
					status: details.status,
					objective: details.objective,
					repositoryRoot: "/repo",
					counts: { pending: 0, running: 1, succeeded: 0, failed: 0, cancelled: 0, blocked: 0 },
					usage: details.usage,
					budget: details.budget,
					createdAt: 1,
					updatedAt: 2,
					pausedDurationMs: 0,
					resources: details.resources,
				},
			],
			pause,
			cancel,
			diffCandidate,
			releaseCandidate,
			gc,
			shutdown: async () => {},
		};
		const authorizeOperator = vi.fn(async (_request: SubagentOperatorAuthorizationRequest) => true);
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			dagOrchestrator,
			authorizeOperator,
			resolveRepositoryRoot: async (cwd) => cwd,
		})(pi);
		expect(registered?.name).toBe("subagent");
		expect(command).toBeDefined();
		expect(command?.getArgumentCompletions?.("res")).toEqual([{ value: "resume", label: "resume" }]);
		expect(command?.getArgumentCompletions?.("resume d")).toBeNull();
		await expect(
			registered?.execute("model-resume-rejected", { operation: "resume", runId: "dag-run" }, undefined, undefined, {
				cwd: "/other",
			} as never),
		).rejects.toThrow("does not match the registered schema");
		expect(resume).not.toHaveBeenCalled();

		const notifications: Array<[string, string | undefined]> = [];
		const statuses: Array<string | undefined> = [];
		const renderedOverlays: string[] = [];
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const context = {
			mode: "tui",
			hasUI: true,
			cwd: "/repo",
			ui: {
				notify: (message: string, type?: string) => notifications.push([message, type]),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				select: async () => undefined,
				custom: async (
					factory: (
						tui: { requestRender(): void },
						theme: { fg(color: string, text: string): string; bold(text: string): string },
						keybindings: { matches(): boolean },
						done: (value: unknown) => void,
					) => { render(width: number): string[]; handleInput?(data: string): void },
				) => {
					let result: unknown;
					const component = await factory(
						{ requestRender() {} },
						theme,
						{ matches: () => true },
						(value: unknown) => {
							result = value;
						},
					);
					renderedOverlays.push(component.render?.(500).join("\n") ?? "");
					component.handleInput?.("escape");
					return result;
				},
			},
		};
		await command?.handler("", context);
		for (const action of ["resume", "pause", "cancel", "release", "gc"] as const) {
			await command?.handler(`${action} dag-run`, context);
		}
		expect(authorizeOperator.mock.calls.map((call) => call[0].operation)).toEqual([
			"resume",
			"pause",
			"cancel",
			"release",
			"gc",
		]);
		expect(resume).toHaveBeenCalledOnce();
		expect(pause).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		expect(releaseCandidate).toHaveBeenCalledOnce();
		expect(gc).toHaveBeenCalledOnce();
		expect(statuses.at(-1)).toBeUndefined();
		await command?.handler("inspect dag-run", context);
		await command?.handler("diff dag-run", context);
		expect(diffCandidate).toHaveBeenCalledOnce();
		const overlays = renderedOverlays.join("\n");
		expect(overlays).toContain(
			"Performance: outcome running · wall 1,500 ms · active 1,200 ms · critical path 900 ms · claim wait 100 ms · runnable idle 25 ms · retries 2 · 4 tok · 3 turns",
		);
		expect(overlays).toContain("model_execution: n=2 · total=700 ms · P50=300 ms · P95=400 ms · max=400 ms");
		expect(overlays).toContain("Provider circuit: open · unlimited_auto_retry · retry eligible at 2,001");
		expect(overlays).not.toContain("\u001b");
		expect(renderedOverlays.join("\n")).not.toContain("\u0007");
		await command?.handler("unknown dag-run", context);
		expect(notifications).toContainEqual(["Unknown Subagent action: unknown", "error"]);

		const nonTui = { ...context, mode: "print" };
		await command?.handler("pause dag-run", nonTui);
		// Operator mutations inherit the session mode; the parent authorizer is the
		// only gate, so headless pause executes without an interactive TUI.
		expect(pause).toHaveBeenCalledTimes(2);
	});

	it("persists the user-configured task budget across extension instances", async () => {
		type Command = { handler(args: string, ctx: unknown): Promise<void> };
		type Runtime = { tool: ToolDefinition; command: Command };
		const requests: Array<{ budget: { maxTokens: number } }> = [];
		const root = await mkdtemp(join(tmpdir(), "subagent-budget-command-"));
		const budgetPreferencesPath = join(root, "budget.json");
		const notifications: Array<[string, string | undefined]> = [];
		const context = {
			mode: "print",
			hasUI: false,
			cwd: "/repo",
			model: { provider: "openai-codex", id: "parent", reasoning: true },
			thinkingLevel: "medium",
			modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "parent", reasoning: true }] },
			ui: {
				notify: (message: string, type?: string) => notifications.push([message, type]),
				setStatus: () => undefined,
			},
		};
		const register = (): Runtime => {
			let tool: ToolDefinition | undefined;
			let command: Command | undefined;
			const pi = {
				registerTool(value: ToolDefinition) {
					tool = value;
				},
				registerCommand(name: string, value: Command) {
					if (name === "subagent-budget") command = value;
				},
				on() {},
			} as unknown as ExtensionAPI;
			createSubagentExtension({
				agentDir: testAgentDir,
				ledgerPath: ":memory:",
				modelPreferencesPath: join(root, "models.json"),
				budgetPreferencesPath,
				resolveRepositoryRoot: async (cwd) => cwd,
				dagOrchestrator: {
					start: async ({ request }) => {
						requests.push({ budget: { ...request.budget } });
						return dagDetails("succeeded", 0);
					},
					resume: async () => dagDetails("succeeded", 0),
					inspect: () => dagDetails("succeeded", 0),
					shutdown: async () => undefined,
				},
			})(pi);
			if (!tool || !command) throw new Error("Subagent tool or budget command was not registered");
			return { tool, command };
		};
		const start = async (runtime: Runtime, extra: Record<string, unknown> = {}): Promise<void> => {
			await runtime.tool.execute(
				`start-${requests.length}`,
				{
					tasks: [{ id: "inspect", objective: "Inspect" }],
					...extra,
				},
				undefined,
				undefined,
				context as never,
			);
		};

		let runtime = register();
		await runtime.command.handler("show", context);
		expect(notifications.at(-1)?.[0]).toContain("10,000,000 tokens per task");
		await start(runtime);
		await runtime.command.handler("set 20M", context);
		runtime = register();
		await start(runtime);
		await expect(start(runtime, { maxTokensPerTask: 30_000_000 })).rejects.toThrow(
			"does not match the registered schema",
		);

		await runtime.command.handler("set 250000", context);
		runtime = register();
		await start(runtime);
		await runtime.command.handler("set 1000M", context);
		runtime = register();
		await start(runtime);
		expect(requests.map((request) => request.budget.maxTokens)).toEqual([
			10_000_000, 20_000_000, 250_000, 1_000_000_000,
		]);

		await runtime.command.handler("set 99K", context);
		expect(notifications.at(-1)).toEqual([
			"Subagent task budget must be between 100,000 and 1,000,000,000 tokens",
			"error",
		]);
		await runtime.command.handler("set 1001M", context);
		expect(notifications.at(-1)?.[1]).toBe("error");
		await runtime.command.handler("set 1.5M", context);
		expect(notifications.at(-1)?.[0]).toContain("Usage: /subagent-budget show|set <value>|reset");
		await runtime.command.handler("set 100K", context);
		runtime = register();
		await start(runtime);
		expect(requests.at(-1)?.budget.maxTokens).toBe(100_000);
		await runtime.command.handler("reset", context);
		runtime = register();
		await start(runtime);
		expect(requests.at(-1)?.budget.maxTokens).toBe(10_000_000);

		await writeFile(budgetPreferencesPath, "not-json", { mode: 0o600 });
		runtime = register();
		await runtime.command.handler("show", context);
		expect(notifications.at(-1)?.[0]).toContain("Repair with /subagent-budget set <value> or /subagent-budget reset");
		await expect(start(runtime)).rejects.toThrow(
			/Repair with \/subagent-budget set <value> or \/subagent-budget reset/,
		);
		await runtime.command.handler("set 20M", context);
		runtime = register();
		await start(runtime);
		expect(requests.at(-1)?.budget.maxTokens).toBe(20_000_000);
	});

	it("reloads preferences only for new starts and pins independent role selections", async () => {
		let tool: ToolDefinition | undefined;
		const requests: Array<{ childModels?: unknown }> = [];
		const root = await mkdtemp(join(tmpdir(), "subagent-model-lifecycle-"));
		const preferencesPath = join(root, "models.json");
		const details = dagDetails("succeeded", 1);
		const pi = {
			registerTool(value: ToolDefinition) {
				tool = value;
			},
			registerCommand() {},
			on() {},
		} as unknown as ExtensionAPI;
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			modelPreferencesPath: preferencesPath,
			resolveRepositoryRoot: async (cwd) => cwd,
			dagOrchestrator: {
				start: async ({ request }) => {
					requests.push(request);
					return details;
				},
				resume: async () => details,
				inspect: () => details,
				shutdown: async () => undefined,
			},
		})(pi);
		const models = [
			{ provider: "openai-codex", id: "parent", name: "Parent", reasoning: true },
			{ provider: "openai-codex", id: "luna", name: "Luna", reasoning: true, thinkingLevelMap: { max: "max" } },
			{ provider: "openai-codex", id: "sol", name: "Sol", reasoning: true, thinkingLevelMap: { max: "max" } },
		];
		const context = {
			cwd: "/repo",
			model: models[0],
			thinkingLevel: "medium",
			modelRegistry: { getAvailable: () => models },
			ui: { setStatus: () => undefined, notify: () => undefined },
		};
		await writeSubagentModelPreferences(preferencesPath, {
			version: 1,
			default: { provider: "openai-codex", model: "luna", thinkingLevel: "low" },
			roles: { reviewer: { provider: "openai-codex", model: "sol", thinkingLevel: "high" } },
		});
		const startParams = {
			tasks: [{ id: "inspect", objective: "Inspect" }],
		};
		await tool?.execute("start-one", startParams, undefined, undefined, context as never);
		expect(requests[0]?.childModels).toEqual({
			analyst: { provider: "openai-codex", model: "luna", thinkingLevel: "low" },
			reviewer: { provider: "openai-codex", model: "sol", thinkingLevel: "high" },
			writer: { provider: "openai-codex", model: "luna", thinkingLevel: "low" },
		});

		// Durable resume remains internal; the model tool rejects it before reading preferences.
		await writeFile(preferencesPath, "broken", { mode: 0o600 });
		await expect(
			tool?.execute("resume-old", { operation: "resume", runId: "dag-run" }, undefined, undefined, context as never),
		).rejects.toThrow("does not match the registered schema");
		await expect(tool?.execute("start-broken", startParams, undefined, undefined, context as never)).rejects.toThrow(
			/Repair with \/subagent-models/,
		);

		await writeSubagentModelPreferences(preferencesPath, {
			version: 1,
			default: { provider: "openai-codex", model: "sol", thinkingLevel: "high" },
		});
		await tool?.execute("start-two", startParams, undefined, undefined, context as never);
		expect(requests[1]?.childModels).toEqual({
			analyst: { provider: "openai-codex", model: "sol", thinkingLevel: "high" },
			reviewer: { provider: "openai-codex", model: "sol", thinkingLevel: "high" },
			writer: { provider: "openai-codex", model: "sol", thinkingLevel: "high" },
		});
	});

	it("provides safe headless show and UI-only searchable editing, inheritance, and reset", async () => {
		type Command = { handler(args: string, ctx: unknown): Promise<void> };
		let command: Command | undefined;
		const root = await mkdtemp(join(tmpdir(), "subagent-model-command-"));
		const preferencesPath = join(root, "models.json");
		const models = [
			{ provider: "openai-codex", id: "parent", name: "Parent", reasoning: true },
			{ provider: "openai-codex", id: "sol", name: "Sol Searchable", reasoning: true },
		];
		const pi = {
			registerTool() {},
			registerCommand(name: string, value: Command) {
				if (name === "subagent-models") command = value;
			},
			on() {},
		} as unknown as ExtensionAPI;
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			modelPreferencesPath: preferencesPath,
			dagOrchestrator: {
				start: async () => dagDetails("succeeded", 0),
				resume: async () => dagDetails("succeeded", 0),
				inspect: () => dagDetails("succeeded", 0),
				shutdown: async () => undefined,
			},
		})(pi);
		const notifications: Array<[string, string | undefined]> = [];
		const baseContext = {
			mode: "print",
			hasUI: false,
			cwd: "/repo",
			model: models[0],
			thinkingLevel: "medium",
			modelRegistry: { getAvailable: () => models },
			ui: {
				notify: (message: string, type?: string) => notifications.push([message, type]),
				setStatus: () => undefined,
			},
		};
		await command?.handler("show", baseContext);
		expect(notifications.at(-1)?.[0]).toContain("inherit from parent");
		await command?.handler("reset", baseContext);
		expect(notifications.at(-1)).toEqual(["/subagent-models reset requires an interactive UI confirmation", "error"]);

		const selections = ["reviewer", "Set model", "openai-codex/sol — Sol Searchable"];
		const presentedCandidates: string[][] = [];
		const interactiveContext = {
			...baseContext,
			mode: "rpc",
			hasUI: true,
			ui: {
				...baseContext.ui,
				select: async (title: string, options: string[]) => {
					if (title === "Choose available Subagent model") presentedCandidates.push([...options]);
					return selections.shift();
				},
				input: async () => {
					throw new Error("Set model must not request free-form input");
				},
				confirm: async () => true,
			},
		};
		await command?.handler("", interactiveContext);
		expect(presentedCandidates).toEqual([["openai-codex/parent — Parent", "openai-codex/sol — Sol Searchable"]]);
		expect(JSON.parse(await readFile(preferencesPath, "utf8"))).toEqual({
			version: 1,
			roles: { reviewer: { provider: "openai-codex", model: "sol" } },
		});

		selections.push("reviewer", "Inherit model");
		await command?.handler("", interactiveContext);
		await expect(readFile(preferencesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		await writeFile(preferencesPath, "{bad", { mode: 0o600 });
		selections.push(undefined as never);
		await command?.handler("", interactiveContext);
		await expect(readFile(preferencesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("serves operator commands outside Git via workspace-root identity", async () => {
		let command:
			| {
					handler(args: string, ctx: unknown): Promise<void>;
			  }
			| undefined;
		const pi = {
			registerTool() {},
			registerCommand(name: string, value: typeof command) {
				if (name === "subagents") command = value;
			},
			on() {},
		} as unknown as ExtensionAPI;
		const details = dagDetails("running", 4);
		details.baseline.repositoryRoot = "/nongit";
		const listOptions: unknown[] = [];
		const list = vi.fn((options: unknown) => {
			listOptions.push(options);
			return [
				{
					runId: details.runId,
					status: details.status,
					objective: details.objective,
					repositoryRoot: "/nongit",
					counts: { pending: 0, running: 1, succeeded: 0, failed: 0, cancelled: 0, blocked: 0 },
					usage: details.usage,
					budget: details.budget,
					createdAt: 1,
					updatedAt: 2,
					pausedDurationMs: 0,
					resources: details.resources,
				},
			];
		});
		const dagOrchestrator: SubagentDagOrchestratorAdapter = {
			start: async () => details,
			resume: async () => details,
			inspect: () => details,
			list,
			shutdown: async () => {},
		};
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			dagOrchestrator,
			resolveRepositoryRoot: async (cwd) => cwd,
		})(pi);

		const notifications: Array<[string, string | undefined]> = [];
		const context = {
			mode: "print",
			hasUI: false,
			cwd: "/nongit",
			ui: {
				notify: (message: string, type?: string) => notifications.push([message, type]),
				setStatus: () => {},
				select: async () => undefined,
			},
		};
		await command?.handler("list", context);
		expect(listOptions[0]).toMatchObject({ repositoryRoot: "/nongit" });
		expect(notifications.some(([message]) => message.includes("dag-run"))).toBe(true);

		await command?.handler("inspect dag-run", context);
		expect(notifications.filter(([, type]) => type === "error")).toEqual([]);

		await command?.handler("inspect dag-run", { ...context, cwd: "/other" });
		const crossDirectory = notifications.filter(([, type]) => type === "error").at(-1);
		expect(crossDirectory?.[0]).toContain("belongs to a different repository");
	});

	it("degrades gracefully when a custom resolver reports a non-Git directory", async () => {
		let command:
			| {
					handler(args: string, ctx: unknown): Promise<void>;
			  }
			| undefined;
		const pi = {
			registerTool() {},
			registerCommand(name: string, value: typeof command) {
				if (name === "subagents") command = value;
			},
			on() {},
		} as unknown as ExtensionAPI;
		const details = dagDetails("running", 4);
		const list = vi.fn(() => []);
		const dagOrchestrator: SubagentDagOrchestratorAdapter = {
			start: async () => details,
			resume: async () => details,
			inspect: () => details,
			list,
			shutdown: async () => {},
		};
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			dagOrchestrator,
			resolveRepositoryRoot: async (cwd) => {
				throw new NotAGitRepositoryError(cwd);
			},
		})(pi);

		const notifications: Array<[string, string | undefined]> = [];
		const context = {
			mode: "tui",
			hasUI: true,
			cwd: "/nongit",
			ui: {
				notify: (message: string, type?: string) => notifications.push([message, type]),
				setStatus: () => {},
				select: async () => undefined,
			},
		};
		await command?.handler("list", context);
		expect(notifications).toContainEqual(["Not inside a Git repository; no repository-scoped Subagent runs", "info"]);
		expect(list).not.toHaveBeenCalled();

		await command?.handler("inspect dag-run", context);
		const inspectError = notifications.filter(([, type]) => type === "error").at(-1);
		expect(inspectError?.[0]).toContain("not inside a Git repository");
		expect(inspectError?.[0]).not.toContain("exit 128");
	});

	it("returns every settled branch through the real orchestrator failure-result hook", async () => {
		let registered: ToolDefinition | undefined;
		let toolResultHandler: ((event: { toolName: string; toolCallId: string }) => unknown) | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on(event: string, handler: unknown) {
				if (event === "tool_result") {
					toolResultHandler = handler as (event: { toolName: string; toolCallId: string }) => unknown;
				}
			},
		} as unknown as ExtensionAPI;
		const root = await mkdtemp(join(tmpdir(), "subagent-extension-mixed-result-"));
		await git(root, "init", "-q", "-b", "main");
		await git(root, "config", "user.name", "Extension Test");
		await git(root, "config", "user.email", "extension@example.test");
		await writeFile(join(root, "base.txt"), "base\n");
		await git(root, "add", "base.txt");
		await git(root, "commit", "-q", "-m", "base");
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			modelPreferencesPath: join(root, "models.json"),
			budgetPreferencesPath: join(root, "budget.json"),
			createRunId: () => "mixed-real-dag",
			policy: { ...DEFAULT_SUBAGENT_POLICY, maxConcurrency: 1, maxTaskAttempts: 1 },
			runTask: async (options) => {
				if (options.task.id === "fail") {
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: false,
						terminalReason: "model_error",
						error: "expected branch failure",
						usage: { ...ZERO_USAGE, totalTokens: 2 },
						turns: 1,
					};
				}
				return {
					taskId: options.task.id,
					role: options.task.role,
					success: true,
					terminalReason: "completed",
					handoff: {
						taskId: options.task.id,
						summary: "independent branch completed",
						evidence: [{ path: "base.txt", lineRange: "1", claim: "independent evidence" }],
						verification: [],
						assumptions: [],
						risks: [],
						nextActions: [],
						outcome: "accepted",
						verificationLevel: "self_reported",
					},
					usage: { ...ZERO_USAGE, totalTokens: 3 },
					turns: 1,
				};
			},
		})(pi);

		await expect(
			registered?.execute(
				"mixed-real-call",
				{
					tasks: [
						{ id: "fail", objective: "fail" },
						{ id: "independent", objective: "complete" },
					],
				},
				undefined,
				undefined,
				modelToolContext(root) as never,
			),
		).rejects.toThrow("expected branch failure");
		const patch = toolResultHandler?.({ toolName: "subagent", toolCallId: "mixed-real-call" }) as
			| { isError?: boolean; content?: Array<{ type: string; text: string }>; details?: SubagentDagRunDetails }
			| undefined;
		expect(patch).toMatchObject({
			isError: true,
			details: {
				status: "failed",
				tasks: [
					{ taskId: "fail", status: "failed", terminalReason: "model_error" },
					{ taskId: "independent", status: "succeeded", terminalReason: "completed" },
				],
			},
		});
		const text = patch?.content?.[0]?.text ?? "";
		expect(text).toContain("fail [report]: failed");
		expect(text).toContain("independent [report]: succeeded");
		expect(text).toContain("independent branch completed");
		expect(text).toContain("independent evidence");
	});

	it("patches failed DAG usage and treats shutdown interruption as durable cleanup", async () => {
		let registered: ToolDefinition | undefined;
		let shutdown: (() => Promise<void>) | undefined;
		let toolResultHandler: ((event: { toolName: string; toolCallId: string }) => unknown) | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on(event: string, handler: unknown) {
				if (event === "session_shutdown") shutdown = handler as () => Promise<void>;
				if (event === "tool_result") {
					toolResultHandler = handler as (event: { toolName: string; toolCallId: string }) => unknown;
				}
			},
		} as unknown as ExtensionAPI;
		const failed = dagDetails("failed", 7);
		const dagOrchestrator: SubagentDagOrchestratorAdapter = {
			start: async () => {
				throw new SubagentDagRunError("DAG failed", failed);
			},
			resume: async () => failed,
			inspect: () => failed,
			shutdown: async () => {
				throw new DagRunInterruptedError("durably interrupted", failed.runId, failed);
			},
		};
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			dagOrchestrator,
			childModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
		})(pi);
		const modelContext = {
			cwd: "/repo",
			model: { provider: "openai-codex", id: "gpt-5.4-mini" },
			thinkingLevel: "low",
			modelRegistry: {
				getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true }],
			},
			ui: { setStatus: () => undefined, notify: () => undefined },
		} as never;

		await expect(
			registered?.execute(
				"failed-dag-call",
				{
					tasks: [{ id: "task", objective: "Fail" }],
				},
				undefined,
				undefined,
				modelContext,
			),
		).rejects.toThrow("DAG failed");
		const patch = toolResultHandler?.({ toolName: "subagent", toolCallId: "failed-dag-call" }) as
			| { isError?: boolean; usage?: { totalTokens: number } }
			| undefined;
		expect(patch).toMatchObject({ isError: true, usage: { totalTokens: 7 } });
		await expect(
			registered?.execute(
				"cleanup-call",
				{
					tasks: [{ id: "task", objective: "Fail again" }],
				},
				undefined,
				undefined,
				modelContext,
			),
		).rejects.toThrow("DAG failed");
		await expect(shutdown?.()).resolves.toBeUndefined();
		expect(toolResultHandler?.({ toolName: "subagent", toolCallId: "cleanup-call" })).toBeUndefined();
	});

	it("returns a negative reviewer verdict with findings without mislabeling it as a tool execution error", async () => {
		let registered: ToolDefinition | undefined;
		let toolResultHandler: ((event: { toolName: string; toolCallId: string }) => unknown) | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			on(event: string, handler: unknown) {
				if (event === "tool_result") {
					toolResultHandler = handler as (event: { toolName: string; toolCallId: string }) => unknown;
				}
			},
		} as unknown as ExtensionAPI;
		const negative = dagDetails("failed", 12);
		negative.tasks = [
			{
				taskId: "review",
				role: "reviewer",
				status: "succeeded",
				attempts: 1,
				maxAttempts: 1,
				dependsOn: [],
				terminalReason: "completed",
				artifact: {
					artifactVersion: 2,
					artifactId: "review-artifact",
					taskId: "review",
					contractHash: "a".repeat(64),
					handoff: {
						taskId: "review",
						summary: "MEDIUM: destination can retain stale data",
						evidence: [{ path: "src/filler.cc", lineRange: "10-20", claim: "Failure path does not clear" }],
						verification: [],
						assumptions: [],
						risks: [],
						nextActions: [],
						outcome: "rejected",
						verificationLevel: "self_reported",
					},
					changedPaths: [],
					validations: [],
					quality: {
						semanticOutcome: "rejected",
						pathAudit: "not_applicable",
						validation: { status: "not_applicable", passedCommandIds: [] },
						review: { status: "rejected", writerCommitClosure: [] },
					},
					createdAt: 1,
				},
			},
		];
		const root = await mkdtemp(join(tmpdir(), "subagent-semantic-verdict-"));
		let failureMessage = "Subagent task review semantic outcome rejected";
		createSubagentExtension({
			agentDir: testAgentDir,
			ledgerPath: ":memory:",
			modelPreferencesPath: join(root, "models.json"),
			dagOrchestrator: {
				start: async () => {
					throw new SubagentDagRunError(failureMessage, negative);
				},
				resume: async () => negative,
				inspect: () => negative,
				shutdown: async () => undefined,
			},
		})(pi);
		const notifications: Array<[string, string | undefined]> = [];
		const result = await registered?.execute(
			"semantic-review",
			{
				tasks: [
					{ id: "subject", objective: "Produce the review subject" },
					{ id: "review", objective: "Review", reviewOf: ["subject"] },
				],
			},
			undefined,
			undefined,
			{
				cwd: "/repo",
				model: { provider: "openai-codex", id: "gpt-5.6-sol" },
				thinkingLevel: "high",
				modelRegistry: {
					getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true }],
				},
				ui: {
					setStatus: () => undefined,
					notify: (message: string, type?: string) => notifications.push([message, type]),
				},
			} as never,
		);
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("MEDIUM: destination can retain stale data");
		expect(result?.details).toBe(negative);
		expect(notifications).toContainEqual(["Subagent dag-run: review found issues — findings available", "warning"]);
		expect(toolResultHandler?.({ toolName: "subagent", toolCallId: "semantic-review" })).toBeUndefined();
		const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
		const rendered = registered?.renderResult?.(
			result as never,
			{ isPartial: false, expanded: false } as never,
			theme as never,
			undefined as never,
		);
		expect(rendered?.render(500).join("\n")).toContain("review found issues");
		failureMessage = "Child was inactive for 1800000 ms";
		await expect(
			registered?.execute(
				"technical-failure-with-negative-artifact",
				{
					tasks: [
						{ id: "subject", objective: "Produce the review subject" },
						{ id: "review", objective: "Review", reviewOf: ["subject"] },
					],
				},
				undefined,
				undefined,
				{
					cwd: "/repo",
					model: { provider: "openai-codex", id: "gpt-5.6-sol" },
					thinkingLevel: "high",
					modelRegistry: {
						getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true }],
					},
					ui: { setStatus: () => undefined, notify: () => undefined },
				} as never,
			),
		).rejects.toThrow("inactive for 1800000 ms");
	});
});
