import { dirname, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { ChildHarnessContextProvider } from "@easy-pi/permissions";
import {
	defaultSubagentBudgetPreferencesPath,
	readSubagentBudgetPreferences,
	resetSubagentBudgetPreferences,
	SubagentBudgetPreferencesError,
	writeSubagentBudgetPreferences,
} from "./budget-preferences.ts";
import type { TrustedSandboxLauncher } from "./child-runtime-policy.ts";
import {
	assertSubagentToolRequestSize,
	compileSubagentToolDagRequest,
	createSubagentToolRequestSchema,
	DEFAULT_SUBAGENT_POLICY,
	MAX_SUBAGENT_TOKENS_PER_TASK,
	MIN_SUBAGENT_TOKENS_PER_TASK,
	parseSubagentToolRequest,
} from "./contracts.ts";
import {
	type CandidateDiffOptions,
	type DagOperatorOptions,
	type DagOrchestratorDependencies,
	type DagOrchestratorProgress,
	DagRunInterruptedError,
	type ExpandDagRunOptions,
	type ResumeDagRunOptions,
	type StartDagRunOptions,
	SubagentDagOrchestrator,
	SubagentDagRunError,
	type TaskControlOptions,
} from "./dag-orchestrator.ts";
import { type DagRunInspection, type ListDagRunsOptions, RunLedger } from "./ledger.ts";
import {
	defaultSubagentModelPreferencesPath,
	type ResolvedSubagentModels,
	readSubagentModelPreferences,
	resetSubagentModelPreferences,
	resolveSubagentModels,
	SubagentModelPreferencesError,
	writeSubagentModelPreferences,
} from "./model-preferences.ts";
import { ValidationRegistry } from "./quality.ts";
import type {
	CandidateDiff,
	ChildModelOverride,
	ChildModelPolicy,
	ChildModelRole,
	ChildModelSelection,
	DagRunSummary,
	DagTaskDetails,
	SubagentDagRunDetails,
	SubagentModelPreferences,
	SubagentPolicy,
	SubagentRetentionPolicy,
	ValidationCommand,
} from "./types.ts";
import { createWorkspaceRouter, resolveWorkspaceRoot } from "./workspace-router.ts";
import { NotAGitRepositoryError, type resolveRepositoryRoot } from "./worktree.ts";

export type SubagentToolDetails = SubagentDagRunDetails;

export interface SubagentDagOrchestratorAdapter {
	start(options: StartDagRunOptions): Promise<SubagentDagRunDetails>;
	resume(options: ResumeDagRunOptions): Promise<SubagentDagRunDetails>;
	expand?(options: ExpandDagRunOptions): Promise<SubagentDagRunDetails>;
	inspect(runId: string | ResumeDagRunOptions): SubagentDagRunDetails;
	list?(options?: ListDagRunsOptions): DagRunSummary[];
	inspectOperator?(runId: string, eventLimit?: number): DagRunInspection;
	pause?(options: DagOperatorOptions): Promise<SubagentDagRunDetails>;
	cancel?(options: DagOperatorOptions): Promise<SubagentDagRunDetails>;
	diffCandidate?(options: CandidateDiffOptions): Promise<CandidateDiff>;
	releaseCandidate?(options: DagOperatorOptions): Promise<SubagentDagRunDetails>;
	gc?(options: DagOperatorOptions): Promise<SubagentDagRunDetails>;
	controlTask?(options: TaskControlOptions): Promise<SubagentDagRunDetails>;
	sweepRetention?(policy?: SubagentRetentionPolicy): Promise<unknown>;
	shutdown(): Promise<void>;
}

export type SubagentOperatorMutation = "resume" | "pause" | "cancel" | "release" | "gc";

export interface SubagentOperatorAuthorizationRequest {
	operation: SubagentOperatorMutation;
	runId: string;
	details: SubagentDagRunDetails;
}

export type SubagentOperatorAuthorizer = (
	request: SubagentOperatorAuthorizationRequest,
	ctx: ExtensionCommandContext,
) => Promise<boolean>;

export type SubagentOperatorReadAuthorizer = (ctx: ExtensionCommandContext) => Promise<boolean>;

export interface SubagentExtensionOptions
	extends Partial<Pick<DagOrchestratorDependencies, "createSnapshot" | "runTask" | "createRunId">> {
	/** Product-owned data root; never inferred from Pi user state. */
	agentDir: string;
	ledger?: RunLedger;
	ledgerPath?: string;
	policy?: SubagentPolicy;
	validationCommands?: readonly ValidationCommand[];
	/** Trusted override. By default every run pins the parent Agent's current provider, model, and thinking level. */
	childModel?: ChildModelSelection;
	/** Trusted role-aware model routing. Values are persisted with each run. */
	childModels?: ChildModelPolicy;
	/** Trusted test/embedding seam for the global user model preferences file. */
	modelPreferencesPath?: string;
	/** Trusted test/embedding seam for the global user task-budget preferences file. */
	budgetPreferencesPath?: string;
	controllerEnvironment?: Readonly<NodeJS.ProcessEnv>;
	/** Trusted launcher for Child Pi; does not implicitly apply to validation. */
	sandboxLauncher?: TrustedSandboxLauncher;
	/** Independent trusted launcher for controller-run validation commands. */
	validationSandboxLauncher?: TrustedSandboxLauncher;
	/** Required WJ-owned issuer for every real Child attempt. */
	createChildHarnessContext?: ChildHarnessContextProvider;
	/** Disabled unless explicitly configured by the trusted embedding. */
	retentionPolicy?: SubagentRetentionPolicy;
	/** Test/embedding seam. Production callers normally let the extension build the durable DAG orchestrator. */
	dagOrchestrator?: SubagentDagOrchestratorAdapter;
	/** Parent-Harness authority for direct TUI mutations. Missing authority fails closed. */
	authorizeOperator?: SubagentOperatorAuthorizer;
	/** Optional parent-Harness gate for command-side list/inspect/diff access. */
	authorizeOperatorRead?: SubagentOperatorReadAuthorizer;
	/** Trusted test/embedding seam; production resolves the Git top-level or, outside Git, the canonical directory. */
	resolveRepositoryRoot?: typeof resolveRepositoryRoot;
	/** Root for internal mirror repositories backing non-Git workspaces. Defaults to `<ledgerDir>/mirror-repos`. */
	mirrorRoot?: string;
}

const MAX_RENDER_TEXT = 1_200;
const MAX_RENDER_ITEMS = 12;
export const MAX_SUBAGENT_RESULT_BYTES = 50 * 1024;
export const MAX_SUBAGENT_RESULT_LINES = 2_000;

function sanitizeTuiText(value: string, preserveNewlines = false): string {
	// Pi's Text component intentionally preserves ANSI. Remove every C0/C1
	// terminal control from repository/model-originated text before rendering.
	const safe = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
	return preserveNewlines ? safe : safe.replace(/[\t\n]+/g, " ");
}

function boundedText(value: string, limit = MAX_RENDER_TEXT): string {
	const normalized = sanitizeTuiText(value).replace(/\s+/g, " ").trim();
	return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function shortRunId(runId: string): string {
	return runId.length <= 16 ? runId : `${runId.slice(0, 12)}…`;
}

async function assertRunRepository(
	details: SubagentDagRunDetails,
	cwd: string,
	resolver: typeof resolveRepositoryRoot,
): Promise<void> {
	let currentRoot: string;
	try {
		currentRoot = await resolver(cwd);
	} catch (error) {
		if (error instanceof NotAGitRepositoryError) {
			// Fail closed: ownership of a Git-scoped run cannot be verified here.
			throw new Error(
				`Subagent run ${details.runId} cannot be verified because the current directory is not inside a Git repository`,
			);
		}
		throw error;
	}
	if (currentRoot !== details.baseline.repositoryRoot) {
		throw new Error(`Subagent run ${details.runId} belongs to a different repository`);
	}
}

function usageText(details: SubagentToolDetails): string {
	const tokens = details.usage.totalTokens.toLocaleString("en-US");
	return `${tokens} tok · $${details.usage.cost.total.toFixed(4)}`;
}

function budgetText(details: SubagentToolDetails): string {
	const usage = details.usage.totalTokens.toLocaleString("en-US");
	const budget = details.budget.maxTokens.toLocaleString("en-US");
	return details.budgetScope === "task"
		? `${usage} tok total · ${budget} tok/task · $${details.usage.cost.total.toFixed(4)}`
		: `${usage}/${budget} tok · $${details.usage.cost.total.toFixed(4)}`;
}

function dagStateText(counts: DagOrchestratorProgress["counts"]): string {
	return [
		`${counts.completed}/${counts.total} complete`,
		...(counts.running > 0 ? [`${counts.running} running`] : []),
		...(counts.pending > 0 ? [`${counts.pending} pending`] : []),
		...(counts.failed > 0 ? [`${counts.failed} failed`] : []),
		...(counts.cancelled > 0 ? [`${counts.cancelled} cancelled`] : []),
		...(counts.blocked > 0 ? [`${counts.blocked} blocked`] : []),
	].join(" · ");
}

function dagProgressText(progress: DagOrchestratorProgress): string {
	const integration = progress.details.integration
		? `; candidate ${progress.details.integration.ref}`
		: progress.details.integrationFailure
			? `; integration ${progress.details.integrationFailure.reason}: ${boundedText(progress.details.integrationFailure.diagnostics, 300)}`
			: "";
	return `Subagent DAG ${shortRunId(progress.details.runId)}: ${dagStateText(progress.counts)} · ${usageText(progress.details)}${integration}`;
}

function modelLine(value: string): string {
	return sanitizeTuiText(value).replace(/\s+/g, " ").trim();
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
	if (maxBytes <= 0) return { text: "", truncated: true };
	const suffix = "…";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	if (maxBytes <= suffixBytes) return { text: "", truncated: true };
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") + suffixBytes <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return { text: `${value.slice(0, low)}${suffix}`, truncated: true };
}

function displayedExecution(task: DagTaskDetails): "report" | "review" | "isolated-write" | "external-write" {
	if (task.role === "writer") return "isolated-write";
	if (task.role === "external-writer") return "external-write";
	return task.role === "reviewer" ? "review" : "report";
}

function executionLabel(task: DagTaskDetails): "Report" | "Review" | "Isolated Write" | "External Write" {
	const execution = displayedExecution(task);
	return execution === "external-write"
		? "External Write"
		: execution === "isolated-write"
			? "Isolated Write"
			: execution === "review"
				? "Review"
				: "Report";
}

function taskStatusLabel(status: DagTaskDetails["status"]): string {
	return {
		pending: "Waiting",
		running: "Running",
		succeeded: "Done",
		failed: "Failed",
		cancelled: "Cancelled",
		blocked: "Blocked",
	}[status];
}

function activityLabel(activity: string | undefined): string | undefined {
	if (!activity) return undefined;
	const labels: Record<string, string> = {
		ready: "Starting child",
		message_update: "Thinking",
		message_start: "Thinking",
		agent_start: "Thinking",
		tool_execution_start: "Using a tool",
		tool_execution_end: "Processing tool result",
		message_end: "Completed a turn",
		agent_end: "Finishing",
		agent_settled: "Finishing",
		settled: "Finishing",
		completed: "Completed",
	};
	const normalized = modelLine(activity);
	const label = labels[normalized] ?? normalized;
	return label.length === 0 ? undefined : `${label[0]!.toUpperCase()}${label.slice(1)}`;
}

function taskPresentationModel(task: DagTaskDetails): { model?: string; thinking?: string; isolation?: string } {
	const runtime = task.runtime;
	const execution = task.artifact?.execution;
	return {
		model: runtime?.model ?? execution?.model,
		thinking: runtime?.thinkingLevel ?? execution?.thinkingLevel,
		isolation: runtime?.isolationLevel ?? execution?.isolationLevel,
	};
}

function liveTaskText(task: DagTaskDetails): string[] {
	const activity = task.status === "running" ? activityLabel(task.runtime?.activity) : undefined;
	const lines = [
		`  ${modelLine(task.taskId)} · ${executionLabel(task)} · ${taskStatusLabel(task.status)}${activity ? ` — ${activity}` : ""}`,
	];
	const presentation = taskPresentationModel(task);
	if (presentation.model || presentation.thinking) {
		lines.push(
			`    ${[
				presentation.model ? modelLine(presentation.model) : undefined,
				presentation.thinking ? `${modelLine(presentation.thinking)} effort` : undefined,
			]
				.filter(Boolean)
				.join(" · ")}`,
		);
	}
	return lines;
}

function visibleLiveTasks(details: SubagentToolDetails): DagTaskDetails[] {
	return [
		...details.tasks.filter((task) => task.status === "running"),
		...details.tasks.filter((task) => task.status === "pending"),
	].slice(0, 4);
}

function liveResultText(details: SubagentToolDetails): string {
	const visible = visibleLiveTasks(details);
	const lines = visible.flatMap(liveTaskText);
	const omitted =
		details.tasks.filter((task) => task.status === "running" || task.status === "pending").length - visible.length;
	if (omitted > 0) lines.push(`  … ${omitted} more active or waiting`);
	return lines.join("\n");
}

function liveActivityResultText(details: SubagentToolDetails, expanded: boolean, theme: Theme): string {
	const lines: string[] = [];
	for (const task of visibleLiveTasks(details)) {
		const activity = task.liveActivity;
		if (!activity) continue;
		const thinking = boundedText(activity.thinking, expanded ? MAX_RENDER_TEXT : 240);
		if (thinking) lines.push(`    ${theme.fg("accent", `✦ ${thinking}`)}`);
		for (const tool of activity.tools) {
			const symbol =
				tool.status === "pending" ? "◇" : tool.status === "running" ? "◈" : tool.status === "error" ? "✕" : "◆";
			const color =
				tool.status === "error"
					? "error"
					: tool.status === "success"
						? "success"
						: tool.status === "running"
							? "accent"
							: "muted";
			const name = boundedText(tool.toolName, 128);
			const args = boundedText(tool.args, expanded ? 400 : 120);
			lines.push(`    ${theme.fg(color, `${symbol} ${name}`)}${args ? theme.fg("dim", ` ${args}`) : ""}`);
			if (tool.output) {
				const safeOutput = sanitizeTuiText(tool.output, true).trim().split("\n");
				const preview = (expanded ? safeOutput.slice(-6) : safeOutput.slice(-1)).join("\n");
				if (preview) lines.push(`      ${theme.fg("dim", preview)}`);
			}
		}
		if (activity.text.trim()) {
			const safeText = sanitizeTuiText(activity.text, true).trim().split("\n");
			const preview = (expanded ? safeText.slice(-12) : safeText.slice(-3)).join("\n");
			if (preview) lines.push(`    ${theme.fg("toolOutput", preview)}`);
		}
	}
	return lines.join("\n");
}

function compactModelText(value: string, maxBytes: number): { text: string; truncated: boolean } {
	return truncateUtf8(modelLine(value), maxBytes);
}

function taskStatusLine(task: DagTaskDetails): string {
	const terminal = task.terminalReason && task.terminalReason !== "completed" ? `; ${task.terminalReason}` : "";
	const outcome = task.artifact?.handoff.outcome ?? task.partialHandoff?.outcome;
	return `- ${modelLine(task.taskId)} [${displayedExecution(task)}]: ${task.status}${terminal}${outcome ? `; outcome=${outcome}` : ""}`;
}

function validationFailureDetail(result: NonNullable<DagTaskDetails["artifact"]>["validations"][number]): string {
	const diagnostic = result.stderr || result.stdout;
	const bounded = diagnostic ? compactModelText(diagnostic, 160).text : "";
	return `${modelLine(result.commandId)}=${result.status}${result.exitCode === undefined ? "" : `(exit ${result.exitCode})`}${bounded ? `:${bounded}` : ""}`;
}

function taskQualityText(quality: NonNullable<NonNullable<DagTaskDetails["artifact"]>["quality"]>): string {
	return `semantic=${quality.semanticOutcome}; path-audit=${quality.pathAudit}; validation=${quality.validation.status}; review=${quality.review.status}`;
}

function candidateQualityText(integration: NonNullable<SubagentToolDetails["integration"]>): string {
	const quality = integration.quality!;
	const trust =
		integration.kind === "partial"
			? integration.partial.trust
			: quality.writerTaskIds.length > 0 && quality.validationCoverage === "not_applicable"
				? "unvalidated"
				: "controller-checked";
	return `kind=${integration.kind}; accepted=${integration.kind === "partial" ? "no" : quality.gate === "passed" ? "yes" : "no"}; semantic=${quality.semanticOutcome}; path-audit=${quality.pathAuditCoverage}; validation=${quality.validationCoverage}; commit-pin=${quality.commitPinCoverage}; review=${quality.reviewCoverage}/${quality.reviewVerdict}; gate=${quality.gate}; trust=${trust}`;
}

function partialCandidateText(integration: NonNullable<SubagentToolDetails["integration"]>): string | undefined {
	if (integration.kind !== "partial") return undefined;
	const omitted = integration.partial.omittedWriterTasks
		.map((task) => `${modelLine(task.taskId)}:${task.reason}`)
		.join(", ");
	const negative = integration.partial.negativeTasks
		.map(
			(task) =>
				`${modelLine(task.taskId)}:${task.semanticOutcome ? `semantic_${task.semanticOutcome}` : (task.terminalReason ?? task.status)}`,
		)
		.join(", ");
	return `reason=${integration.partial.reason}; complete-gate-failures=${integration.partial.completeGateFailures.join(", ") || "none"}; included=${integration.partial.includedWriterTaskIds.map(modelLine).join(", ") || "none"}; omitted=${omitted || "none"}; negative=${negative || "none"}`;
}

function externalMutationText(mutation: NonNullable<DagTaskDetails["externalMutations"]>[number]): string {
	const post = mutation.postState
		? mutation.postState.status === "confirmed"
			? `confirmed sha256=${mutation.postState.sha256}`
			: `unavailable(${mutation.postState.reason})`
		: "unavailable(not-observed)";
	return `#${mutation.authorizationSequence} ${mutation.operation} ${mutation.path}; authorization=authorized; tool=${mutation.toolResult ?? "unknown"}; post-state=${post}`;
}

function aggregateTaskDetail(task: DagTaskDetails): { text: string; omitted: boolean } {
	if (!task.artifact) {
		const error = compactModelText(task.error ?? "No diagnostic", 500);
		const mutationRisk = task.externalMutations?.length
			? ` | Controller-authorized external mutations: ${task.externalMutations.length}; post-state=${task.externalMutations.every((mutation) => mutation.postState?.status === "confirmed") ? "confirmed" : "incomplete"}`
			: "";
		const partial = task.partialHandoff;
		if (!partial) return { text: `Error: ${error.text}${mutationRisk}`, omitted: error.truncated };
		const summary = compactModelText(partial.summary, 320);
		const risks = partial.risks.slice(0, 2).map((risk) => compactModelText(risk, 100).text);
		const evidence = partial.evidence.slice(0, 2).map((item) => {
			const location = `${item.path}${item.lineRange ? `:${item.lineRange}` : ""}`;
			return `${compactModelText(location, 80).text} — ${compactModelText(item.claim, 120).text}`;
		});
		return {
			text: [
				`Error: ${error.text}${mutationRisk}`,
				`Partial handoff (task incomplete; no artifact): ${summary.text}`,
				...(risks.length > 0 ? [`Risks: ${risks.join("; ")}`] : []),
				...(evidence.length > 0 ? [`Evidence: ${evidence.join("; ")}`] : []),
			].join(" | "),
			omitted:
				error.truncated ||
				summary.truncated ||
				partial.risks.length > risks.length ||
				partial.evidence.length > evidence.length,
		};
	}
	const { artifact } = task;
	const handoff = artifact.handoff;
	const segments: string[] = [];
	let omitted = false;
	const summary = compactModelText(handoff.summary, 320);
	segments.push(`Summary: ${summary.text}`);
	omitted ||= summary.truncated;
	segments.push(`Quality: ${taskQualityText(artifact.quality)}`);
	if (artifact.quality.validation.status === "not_run") {
		segments.push("Controller validation: unvalidated (no command configured)");
	}
	if (artifact.execution) {
		segments.push(
			`Execution: ${artifact.execution.isolationLevel}${artifact.execution.model ? `; model=${modelLine(artifact.execution.model)}` : ""}`,
		);
	}

	const failedValidations = artifact.validations.filter((result) => result.status !== "passed");
	const passedValidations = artifact.validations.length - failedValidations.length;
	if (failedValidations.length > 0 || passedValidations > 0) {
		const critical = failedValidations.slice(0, 2).map(validationFailureDetail);
		omitted ||=
			failedValidations.length > critical.length ||
			failedValidations.some((result) => Buffer.byteLength(modelLine(result.stderr || result.stdout), "utf8") > 160);
		segments.push(
			`Controller validations: ${[
				...critical,
				...(passedValidations > 0 ? [`${passedValidations} passed`] : []),
			].join(", ")}`,
		);
	}

	if (handoff.risks.length > 0) {
		const risks = handoff.risks.slice(0, 2).map((risk) => compactModelText(risk, 80).text);
		omitted ||=
			handoff.risks.length > risks.length ||
			handoff.risks.some((risk) => Buffer.byteLength(modelLine(risk), "utf8") > 80);
		segments.push(`Risks: ${risks.join("; ")}`);
	}
	if (handoff.evidence.length > 0) {
		const evidence = handoff.evidence.slice(0, 2).map((item) => {
			const path = compactModelText(`${item.path}${item.lineRange ? `:${item.lineRange}` : ""}`, 80);
			const claim = compactModelText(item.claim, 120);
			omitted ||= path.truncated || claim.truncated;
			return `${path.text} — ${claim.text}`;
		});
		omitted ||= handoff.evidence.length > evidence.length;
		segments.push(`Evidence: ${evidence.join("; ")}`);
	}

	const criticalVerification = handoff.verification.filter((item) => item.status !== "passed");
	const passedVerification = handoff.verification.length - criticalVerification.length;
	if (handoff.verification.length > 0) {
		const critical = criticalVerification.slice(0, 2).map((item) => {
			const details = item.details ? compactModelText(item.details, 80).text : "";
			return `${compactModelText(item.check, 80).text}=${item.status}${details ? `:${details}` : ""}`;
		});
		omitted ||=
			criticalVerification.length > critical.length ||
			handoff.verification.some(
				(item) =>
					Buffer.byteLength(modelLine(item.check), "utf8") > 80 ||
					(item.details !== undefined && Buffer.byteLength(modelLine(item.details), "utf8") > 80),
			);
		segments.push(
			`Child-reported verification: ${[
				...critical,
				...(passedVerification > 0 ? [`${passedVerification} passed`] : []),
			].join(", ")}`,
		);
	}

	if (artifact.changedPaths.length > 0) {
		const changed = artifact.changedPaths.slice(0, 4).map((path) => compactModelText(path, 80).text);
		omitted ||=
			artifact.changedPaths.length > changed.length ||
			artifact.changedPaths.some((path) => Buffer.byteLength(modelLine(path), "utf8") > 80);
		segments.push(`Changed: ${changed.join(", ")}`);
	}
	if (artifact.externalChangedPaths?.length) {
		segments.push(
			`Child-claimed external paths: ${artifact.externalChangedPaths.slice(0, 4).map(modelLine).join(", ")}`,
		);
		omitted ||= artifact.externalChangedPaths.length > 4;
	}
	if (task.externalMutations?.length) {
		segments.push(`Controller-authorized external mutations: ${task.externalMutations.length}`);
	}
	if (artifact.commit) segments.push(`Commit: ${modelLine(artifact.commit)}`);
	return { text: segments.join(" | "), omitted };
}

function aggregateFinalText(details: SubagentToolDetails): string {
	const statusLines = details.tasks.map(taskStatusLine);
	const essential = [
		`## Subagent run ${modelLine(details.runId)}`,
		`Status: ${details.status}`,
		...(details.graphVersion === undefined
			? []
			: [
					`Graph: v${details.graphVersion} · ${details.graphSealed ? "sealed" : details.awaitingExpansion ? "awaiting expansion" : "open"}`,
				]),
		"Tasks:",
		...statusLines,
		...(details.integration
			? [
					`${details.integration.kind === "partial" ? "Partial Candidate (non-accepted)" : "Candidate"}: ${modelLine(details.integration.ref)} @ ${modelLine(details.integration.commit)}`,
					...(details.integration.quality
						? [`Candidate quality: ${candidateQualityText(details.integration)}`]
						: []),
					...(partialCandidateText(details.integration)
						? [`Partial provenance: ${partialCandidateText(details.integration)}`]
						: []),
				]
			: []),
	].join("\n");
	const recovery =
		"\n\n[Per-task details were truncated to the model-result limit. Every task is included above; full operator history remains in the durable ledger and /subagents.]";
	const taskDetails = details.tasks.map((task) => ({ label: `Task ${task.taskId}`, ...aggregateTaskDetail(task) }));
	const candidates = [
		{ label: "Objective", text: details.objective, omitted: false },
		...taskDetails,
		...(details.integrationFailure
			? [
					{
						label: `Integration ${details.integrationFailure.reason}`,
						text: details.integrationFailure.diagnostics,
						omitted: false,
					},
				]
			: []),
	];
	const separators = candidates.length * Buffer.byteLength("\n\n", "utf8");
	const available = Math.max(
		0,
		MAX_SUBAGENT_RESULT_BYTES - Buffer.byteLength(essential + recovery, "utf8") - separators,
	);
	const perCandidate = candidates.length === 0 ? 0 : Math.floor(available / candidates.length);
	let truncated = candidates.some((candidate) => candidate.omitted);
	const sections = candidates.flatMap((candidate) => {
		const prefix = `${modelLine(candidate.label)}: `;
		const textBudget = Math.max(0, perCandidate - Buffer.byteLength(prefix, "utf8"));
		const bounded = truncateUtf8(modelLine(candidate.text), textBudget);
		truncated ||= bounded.truncated;
		return bounded.text ? [`${prefix}${bounded.text}`] : [];
	});
	let result = `${essential}${sections.length > 0 ? `\n\n${sections.join("\n\n")}` : ""}${truncated ? recovery : ""}`;
	if (result.split("\n").length > MAX_SUBAGENT_RESULT_LINES) {
		const mandatoryLines = essential.split("\n");
		const remaining = Math.max(0, MAX_SUBAGENT_RESULT_LINES - mandatoryLines.length - 2);
		result = `${essential}\n\n${sections.slice(0, remaining).join("\n")}${recovery}`;
	}
	if (Buffer.byteLength(result, "utf8") > MAX_SUBAGENT_RESULT_BYTES) {
		const fallback = details.tasks.map((task) => {
			const summary =
				task.artifact?.handoff.summary ?? task.partialHandoff?.summary ?? task.error ?? "No result detail";
			return `Task ${modelLine(task.taskId)}: ${compactModelText(summary, 256).text}`;
		});
		result = `${essential}\n\n${fallback.join("\n")}${recovery}`;
	}
	return result;
}

function finalText(details: SubagentToolDetails): string {
	return aggregateFinalText(details);
}

function expandedTaskText(task: DagTaskDetails): string[] {
	const lines = [
		`- ${modelLine(task.taskId)} · ${executionLabel(task)} · ${taskStatusLabel(task.status)} · attempt ${task.attempts}/${task.maxAttempts}${task.dependsOn.length > 0 ? ` · waits for ${task.dependsOn.map(modelLine).join(", ")}` : ""}`,
	];
	const presentation = taskPresentationModel(task);
	if (presentation.model || presentation.thinking) {
		lines.push(
			`  Model: ${[
				presentation.model ? modelLine(presentation.model) : undefined,
				presentation.thinking ? `${modelLine(presentation.thinking)} effort` : undefined,
			]
				.filter(Boolean)
				.join(" · ")}`,
		);
	}
	if (presentation.isolation) lines.push(`  Isolation: ${modelLine(presentation.isolation)}`);
	if (task.usage)
		lines.push(
			`  Usage: ${task.usage.totalTokens.toLocaleString("en-US")} tok · $${task.usage.cost.total.toFixed(4)}`,
		);
	const activity = activityLabel(task.runtime?.activity);
	if (task.status === "running" && activity) lines.push(`  Activity: ${activity}`);
	if (task.nextAction && task.nextAction !== "none" && task.nextAction !== "wait") {
		lines.push(`  Next: ${boundedText(task.nextAction, 500)}`);
	}
	if (task.providerCircuitOpen) {
		lines.push(
			`  Provider circuit: open · ${task.providerCircuitOpen.reason} · retry eligible at ${task.providerCircuitOpen.retryNotBefore.toLocaleString("en-US")}`,
		);
	}
	if (task.error) lines.push(`  Error: ${boundedText(task.error)}`);
	if (task.externalMutations?.length) {
		const mutations = task.externalMutations.slice(0, MAX_RENDER_ITEMS);
		lines.push(
			`  Controller-authorized external mutations: ${mutations.map(externalMutationText).join(" | ")}${task.externalMutations.length > mutations.length ? " …" : ""}`,
		);
	}
	const partial = task.partialHandoff;
	if (partial) {
		lines.push("  Partial handoff (incomplete; no artifact):");
		lines.push(`    Summary: ${boundedText(partial.summary)}`);
		if (partial.risks.length > 0)
			lines.push(
				`    Risks: ${partial.risks
					.slice(0, MAX_RENDER_ITEMS)
					.map((risk) => boundedText(risk, 300))
					.join(" | ")}`,
			);
		if (partial.evidence.length > 0) {
			lines.push(
				`    Evidence: ${partial.evidence
					.slice(0, MAX_RENDER_ITEMS)
					.map((item) => `${boundedText(item.path, 200)} — ${boundedText(item.claim, 300)}`)
					.join(" | ")}`,
			);
		}
		if (partial.nextActions.length > 0)
			lines.push(
				`    Next: ${partial.nextActions
					.slice(0, MAX_RENDER_ITEMS)
					.map((action) => boundedText(action, 300))
					.join(" | ")}`,
			);
	}
	const artifact = task.artifact;
	if (artifact) {
		lines.push(`  Result: ${boundedText(artifact.handoff.summary)}`);
		if (artifact.changedPaths.length > 0) {
			const paths = artifact.changedPaths.slice(0, MAX_RENDER_ITEMS);
			lines.push(`  Changed: ${paths.join(", ")}${artifact.changedPaths.length > paths.length ? " …" : ""}`);
		}
		if (artifact.externalChangedPaths?.length) {
			const paths = artifact.externalChangedPaths.slice(0, MAX_RENDER_ITEMS);
			lines.push(
				`  External paths (child-claimed): ${paths.join(", ")}${artifact.externalChangedPaths.length > paths.length ? " …" : ""}`,
			);
		}
		if (artifact.validations.length > 0) {
			lines.push(
				`  Validation: ${artifact.validations
					.slice(0, MAX_RENDER_ITEMS)
					.map((result) => `${result.commandId}=${result.status}`)
					.join(", ")}`,
			);
		}
		if (artifact.commit) lines.push(`  Commit: ${artifact.commit}`);
	}
	return lines;
}

function expandedResultText(details: SubagentToolDetails): string {
	const count = (status: DagTaskDetails["status"]): number =>
		details.tasks.filter((task) => task.status === status).length;
	const completed = count("succeeded") + count("failed") + count("cancelled") + count("blocked");
	const lines = [
		`Run: ${details.runId}`,
		`Status: ${details.pausedAt !== undefined ? "Paused (resumable)" : details.status === "succeeded" ? "Completed" : `${details.status[0]!.toUpperCase()}${details.status.slice(1)}`}`,
		`Progress: ${completed}/${details.tasks.length} done${count("running") > 0 ? ` · ${count("running")} active` : ""}${count("pending") > 0 ? ` · ${count("pending")} waiting` : ""}`,
		...(details.graphVersion === undefined
			? []
			: [
					`Graph: v${details.graphVersion} · ${details.graphSealed ? "sealed" : details.awaitingExpansion ? "awaiting expansion" : "open"}`,
				]),
		"Objective:",
		`  ${boundedText(details.objective, 300)}`,
		`Budget: ${budgetText(details)}`,
		"Tasks:",
	];
	for (const task of details.tasks) lines.push(...expandedTaskText(task));
	if (details.integration) {
		lines.push(
			`${details.integration.kind === "partial" ? "Partial Candidate (non-accepted)" : "Candidate"}: ${details.integration.ref} @ ${details.integration.commit}`,
		);
		if (details.integration.quality) {
			lines.push(`Candidate quality: ${candidateQualityText(details.integration)}`);
		}
		const partial = partialCandidateText(details.integration);
		if (partial) lines.push(`Partial provenance: ${partial}`);
		lines.push(`Candidate lifecycle: ${details.resources.candidate}; pins: ${details.resources.pins}`);
	}
	if (details.integrationFailure) {
		lines.push(
			`Integration failure: ${details.integrationFailure.reason} — ${boundedText(details.integrationFailure.diagnostics)}`,
		);
	}
	if (details.awaitingExpansion)
		lines.push(`Next: expand graph v${details.graphVersion} and then resume ${details.runId}`);
	else if (details.pausedAt !== undefined) lines.push(`Recovery: /subagents resume ${details.runId}`);
	else if (details.status === "running") lines.push(`Control: /subagents inspect ${details.runId} | pause | cancel`);
	else if (details.status === "failed") lines.push(`Inspect: /subagents inspect ${details.runId}`);
	return lines.join("\n");
}

function dagResultSummary(details: SubagentDagRunDetails): string {
	const count = (status: DagTaskDetails["status"]): number =>
		details.tasks.filter((task) => task.status === status).length;
	const completed = count("succeeded") + count("failed") + count("cancelled") + count("blocked");
	const states = [
		`${completed}/${details.tasks.length} done`,
		...(count("running") > 0 ? [`${count("running")} active`] : []),
		...(count("pending") > 0 ? [`${count("pending")} waiting`] : []),
		...(count("failed") > 0 ? [`${count("failed")} failed`] : []),
		...(count("cancelled") > 0 ? [`${count("cancelled")} cancelled`] : []),
		...(count("blocked") > 0 ? [`${count("blocked")} blocked`] : []),
	].join(" · ");
	const prefix = `${states} · ${usageText(details)} · run ${shortRunId(details.runId)}`;
	if (details.pausedAt !== undefined) return `${prefix} · paused`;
	if (details.integration) {
		return `${prefix} · ${details.integration.kind === "partial" ? "partial candidate (non-accepted)" : "candidate"} ${details.integration.ref}`;
	}
	if (details.integrationFailure) return `${prefix} · integration ${details.integrationFailure.reason}`;
	return prefix;
}

type SubagentCommandAction = "list" | "inspect" | "resume" | "pause" | "cancel" | "diff" | "release" | "gc";

interface ParsedSubagentCommand {
	action: SubagentCommandAction;
	runId?: string;
}

function parseSubagentCommand(args: string): ParsedSubagentCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { action: "list" };
	if (parts.length > 2)
		throw new Error("Usage: /subagents [list|inspect|resume|pause|cancel|diff|release|gc] [runId]");
	const action = parts[0] as SubagentCommandAction;
	if (!["list", "inspect", "resume", "pause", "cancel", "diff", "release", "gc"].includes(action)) {
		throw new Error(`Unknown Subagent action: ${parts[0]}`);
	}
	if (action === "list") {
		if (parts.length !== 1) throw new Error("Usage: /subagents list");
		return { action };
	}
	const runId = parts[1];
	if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
		throw new Error(`Usage: /subagents ${action} <runId>`);
	}
	return { action, runId };
}

function inventoryDescription(run: DagRunSummary): string {
	const done = run.counts.succeeded + run.counts.failed + run.counts.cancelled + run.counts.blocked;
	const paused = run.pausedAt === undefined ? "" : " · paused";
	return `${run.status}${paused} · ${done}/${Object.values(run.counts).reduce((sum, count) => sum + count, 0)} terminal · ${run.usage.totalTokens.toLocaleString("en-US")} tok · ${boundedText(run.objective, 90)}`;
}

function performanceDuration(durationMs: number): string {
	return `${Math.round(durationMs).toLocaleString("en-US")} ms`;
}

function operatorInspectionText(details: SubagentDagRunDetails, inspection?: DagRunInspection): string {
	const lines = [expandedResultText(details)];
	if (inspection) {
		lines.push(
			"",
			`Created: ${new Date(inspection.createdAt).toISOString()}`,
			`Updated: ${new Date(inspection.updatedAt).toISOString()}`,
		);
		const report = inspection.performance;
		lines.push(
			`Performance: outcome ${report.outcome} · wall ${performanceDuration(report.wallClockMs)} · active ${performanceDuration(report.activeWallClockMs)} · critical path ${performanceDuration(report.criticalPathMs)} · claim wait ${performanceDuration(report.claimWaitMs)} · runnable idle ${performanceDuration(report.runnableButIdleMs)} · retries ${report.retryCount.toLocaleString("en-US")} · ${report.usage.totalTokens.toLocaleString("en-US")} tok · ${report.turns.toLocaleString("en-US")} turns`,
		);
		const stages = Object.entries(report.stages).sort(([left], [right]) => left.localeCompare(right));
		if (stages.length > 0) {
			lines.push("Performance stages:");
			for (const [stage, distribution] of stages) {
				if (!distribution) continue;
				lines.push(
					`  ${stage}: n=${distribution.count.toLocaleString("en-US")} · total=${performanceDuration(distribution.totalMs)} · P50=${performanceDuration(distribution.p50Ms)} · P95=${performanceDuration(distribution.p95Ms)} · max=${performanceDuration(distribution.maxMs)}`,
				);
			}
		}
		for (const task of inspection.tasks) {
			const latest = task.attemptRecords.at(-1);
			if (latest) {
				lines.push(
					`Attempt ${task.taskId} #${latest.attemptNumber}: ${latest.status}${latest.terminalReason ? `/${latest.terminalReason}` : ""}${latest.error ? ` — ${boundedText(latest.error, 300)}` : ""}`,
				);
				if (latest.runtime) {
					lines.push(
						`  runtime: ${boundedText([latest.runtime.provider, latest.runtime.model, latest.runtime.thinkingLevel, latest.runtime.isolationLevel, latest.runtime.sessionId, `gen ${latest.runtime.runtimeGeneration}`, `event ${latest.runtime.lastEventSeq}`, latest.runtime.activity].filter(Boolean).join(" · "), 500)}`,
					);
				}
			}
		}
		if (inspection.events.length > 0) {
			lines.push("", "Recent events:");
			for (const event of inspection.events.slice(-12)) {
				lines.push(`- #${event.sequence} ${event.type}${event.taskId ? ` (${event.taskId})` : ""}`);
			}
		}
	}
	return lines.slice(0, 120).join("\n");
}

async function showTextOverlay(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${title}: ${boundedText(text, 500)}`, "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild({
			render: (width: number) => [theme.fg("accent", "─".repeat(Math.max(1, width)))],
			invalidate() {},
		});
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Text(sanitizeTuiText(text, true), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Esc to close"), 1, 0));
		container.addChild({
			render: (width: number) => [theme.fg("accent", "─".repeat(Math.max(1, width)))],
			invalidate() {},
		});
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) {
					done();
				}
				tui.requestRender();
			},
		};
	});
}

async function selectRun(ctx: ExtensionCommandContext, runs: readonly DagRunSummary[]): Promise<string | undefined> {
	if (runs.length === 0) {
		ctx.ui.notify("No durable Subagent DAG runs found", "info");
		return undefined;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify(runs.map((run) => `${run.runId}: ${inventoryDescription(run)}`).join("\n"), "info");
		return undefined;
	}
	const items: SelectItem[] = runs.map((run) => ({
		value: run.runId,
		label: run.runId,
		description: inventoryDescription(run),
	}));
	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild({
			render: (width: number) => [theme.fg("accent", "─".repeat(Math.max(1, width)))],
			invalidate() {},
		});
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagent Runs")), 1, 0));
		const list = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (value) => theme.fg("accent", value),
			selectedText: (value) => theme.fg("accent", value),
			description: (value) => theme.fg("muted", value),
			scrollInfo: (value) => theme.fg("dim", value),
			noMatch: (value) => theme.fg("warning", value),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · Enter actions · Esc close"), 1, 0));
		container.addChild({
			render: (width: number) => [theme.fg("accent", "─".repeat(Math.max(1, width)))],
			invalidate() {},
		});
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return selected ?? undefined;
}

type PreferencesTarget = "default" | ChildModelRole;

function parentModelSelection(
	ctx: Pick<ExtensionCommandContext, "model" | "thinkingLevel">,
): ChildModelSelection | undefined {
	return ctx.model
		? {
				provider: ctx.model.provider,
				model: ctx.model.id,
				...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
			}
		: undefined;
}

function clonePreferences(preferences: SubagentModelPreferences | undefined): SubagentModelPreferences {
	return preferences ? structuredClone(preferences) : { version: 1 };
}

function targetOverride(
	preferences: SubagentModelPreferences,
	target: PreferencesTarget,
): ChildModelOverride | undefined {
	return target === "default" ? preferences.default : preferences.roles?.[target];
}

function setTargetOverride(
	preferences: SubagentModelPreferences,
	target: PreferencesTarget,
	override: ChildModelOverride | undefined,
): void {
	if (target === "default") {
		preferences.default = override;
		return;
	}
	preferences.roles ??= {};
	preferences.roles[target] = override;
	if (Object.values(preferences.roles).every((value) => value === undefined)) delete preferences.roles;
}

function hasPreferenceValues(preferences: SubagentModelPreferences): boolean {
	return (
		preferences.default !== undefined || Object.values(preferences.roles ?? {}).some((value) => value !== undefined)
	);
}

function canonicalModel(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function displaySelectionSource(
	source: ResolvedSubagentModels["roles"][ChildModelRole]["modelSource"] | "unset",
): string {
	if (source === "parent") return "inherited(parent)";
	if (source === "default" || source === "role") return `configured(${source})`;
	if (source === "unset") return "inherited(unset)";
	return `trusted-locked(${source === "trusted-childModels" ? "role" : "default"})`;
}

function describeResolvedModels(
	preferencesPath: string,
	preferences: SubagentModelPreferences | undefined,
	resolved: ResolvedSubagentModels,
): string {
	const raw = preferences ? JSON.stringify(preferences, null, 2) : "(missing; inherit from parent)";
	const lines = [`Path: ${preferencesPath}`, "", "Raw configuration:", raw, "", "Effective selections:"];
	for (const role of ["analyst", "reviewer", "writer"] as const) {
		const item = resolved.roles[role];
		const effort = item.selection.thinkingLevel ?? "unset";
		lines.push(
			`- ${role}: ${item.selection.provider}/${item.selection.model} · thinking=${effort} · model=${displaySelectionSource(item.modelSource)} · thinking=${displaySelectionSource(item.thinkingSource)}`,
		);
	}
	return lines.join("\n");
}

function resolveModelsForContext(
	ctx: Pick<ExtensionCommandContext, "model" | "thinkingLevel" | "modelRegistry">,
	preferences: SubagentModelPreferences | undefined,
	options: Pick<SubagentExtensionOptions, "childModel" | "childModels">,
): ResolvedSubagentModels {
	return resolveSubagentModels({
		parent: parentModelSelection(ctx as Pick<ExtensionCommandContext, "model" | "thinkingLevel">),
		preferences,
		trustedChildModel: options.childModel,
		trustedChildModels: options.childModels,
		availableModels: ctx.modelRegistry.getAvailable(),
	});
}

async function showModelPreferences(
	ctx: ExtensionCommandContext,
	preferencesPath: string,
	options: Pick<SubagentExtensionOptions, "childModel" | "childModels">,
): Promise<void> {
	try {
		const preferences = await readSubagentModelPreferences(preferencesPath);
		const resolved = resolveModelsForContext(ctx, preferences, options);
		await showTextOverlay(ctx, "Subagent Models", describeResolvedModels(preferencesPath, preferences, resolved));
	} catch (error) {
		await showTextOverlay(
			ctx,
			"Subagent Models",
			`Path: ${preferencesPath}\nStatus: invalid\nError: ${error instanceof Error ? error.message : String(error)}\nRepair: /subagent-models reset`,
		);
	}
}

async function chooseAvailableModel(ctx: ExtensionCommandContext): Promise<Model<Api> | undefined> {
	const available = [...ctx.modelRegistry.getAvailable()].sort((left, right) =>
		canonicalModel(left).localeCompare(canonicalModel(right)),
	);
	if (available.length === 0) {
		ctx.ui.notify("No Subagent models are available in the current registry", "warning");
		return undefined;
	}
	const options = new Map<string, Model<Api>>();
	for (const model of available) {
		const key = boundedText(canonicalModel(model), 300);
		const name = boundedText(model.name, 120);
		const base = name && name !== model.id ? `${key} — ${name}` : key;
		let label = base;
		let duplicate = 2;
		while (options.has(label)) label = `${base} (${duplicate++})`;
		options.set(label, model);
	}
	const selected = await ctx.ui.select("Choose available Subagent model", [...options.keys()]);
	return selected === undefined ? undefined : options.get(selected);
}

function mutateTarget(
	preferences: SubagentModelPreferences,
	target: PreferencesTarget,
	mutation: (override: ChildModelOverride) => ChildModelOverride | undefined,
): void {
	setTargetOverride(preferences, target, mutation({ ...(targetOverride(preferences, target) ?? {}) }));
}

function supportedEffortsForTarget(
	ctx: ExtensionCommandContext,
	preferences: SubagentModelPreferences,
	target: PreferencesTarget,
	options: Pick<SubagentExtensionOptions, "childModel" | "childModels">,
): NonNullable<ChildModelSelection["thinkingLevel"]>[] {
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	return levels.filter((level) => {
		const prospective = clonePreferences(preferences);
		mutateTarget(prospective, target, (override) => ({ ...override, thinkingLevel: level }));
		try {
			resolveModelsForContext(ctx, prospective, options);
			return true;
		} catch {
			return false;
		}
	});
}

async function persistProspectivePreferences(
	ctx: ExtensionCommandContext,
	preferencesPath: string,
	preferences: SubagentModelPreferences,
	options: Pick<SubagentExtensionOptions, "childModel" | "childModels">,
): Promise<void> {
	resolveModelsForContext(ctx, preferences, options);
	if (hasPreferenceValues(preferences)) await writeSubagentModelPreferences(preferencesPath, preferences);
	else await resetSubagentModelPreferences(preferencesPath);
}

async function loadPreferencesForMutation(
	ctx: ExtensionCommandContext,
	preferencesPath: string,
): Promise<SubagentModelPreferences | undefined> {
	try {
		return (await readSubagentModelPreferences(preferencesPath)) ?? { version: 1 };
	} catch (error) {
		const repair = await ctx.ui.confirm(
			"Repair Subagent model preferences?",
			boundedText(
				`${error instanceof Error ? error.message : String(error)}. Delete the invalid file and restore inheritance?`,
				500,
			),
		);
		if (!repair) return undefined;
		await resetSubagentModelPreferences(preferencesPath);
		ctx.ui.notify("Invalid Subagent model preferences were reset", "info");
		return { version: 1 };
	}
}

async function editModelPreferences(
	ctx: ExtensionCommandContext,
	preferencesPath: string,
	options: Pick<SubagentExtensionOptions, "childModel" | "childModels">,
): Promise<void> {
	if (!ctx.hasUI) throw new Error("/subagent-models changes require an interactive UI; use /subagent-models show");
	const loaded = await loadPreferencesForMutation(ctx, preferencesPath);
	if (!loaded) return;
	const preferences = clonePreferences(loaded);
	const targetLabel = await ctx.ui.select("Configure Subagent models", ["default", "analyst", "reviewer", "writer"]);
	if (!targetLabel) return;
	const target = targetLabel as PreferencesTarget;
	if (target !== "default" && (options.childModels?.[target] ?? options.childModel)) {
		ctx.ui.notify(`${target} is trusted-locked by the Harness embedding`, "warning");
		return;
	}
	const action = await ctx.ui.select(`Configure ${target}`, [
		"Set model",
		"Set thinking effort",
		"Inherit model",
		"Inherit thinking effort",
		"Reset target",
		"Show configuration",
	]);
	if (!action) return;
	if (action === "Show configuration") {
		await showModelPreferences(ctx, preferencesPath, options);
		return;
	}
	if (action === "Set model") {
		const selected = await chooseAvailableModel(ctx);
		if (!selected) return;
		mutateTarget(preferences, target, (override) => ({
			...override,
			provider: selected.provider,
			model: selected.id,
		}));
	} else if (action === "Set thinking effort") {
		const supported = supportedEffortsForTarget(ctx, preferences, target, options);
		if (supported.length === 0) {
			throw new Error(
				`No thinking effort is supported by every effective ${target} selection; choose a model first`,
			);
		}
		const level = await ctx.ui.select("Choose supported thinking effort", supported);
		if (!level) return;
		mutateTarget(preferences, target, (override) => ({
			...override,
			thinkingLevel: level as ChildModelSelection["thinkingLevel"],
		}));
	} else if (action === "Inherit model") {
		mutateTarget(preferences, target, (override) => {
			delete override.provider;
			delete override.model;
			return override.thinkingLevel === undefined ? undefined : override;
		});
	} else if (action === "Inherit thinking effort") {
		mutateTarget(preferences, target, (override) => {
			delete override.thinkingLevel;
			return override.provider === undefined ? undefined : override;
		});
	} else {
		setTargetOverride(preferences, target, undefined);
	}
	await persistProspectivePreferences(ctx, preferencesPath, preferences, options);
	ctx.ui.notify(`Subagent model preferences updated for ${target}; new runs will use the change`, "info");
}

function parseModelPreferencesCommand(args: string): "edit" | "show" | "reset" {
	const value = args.trim();
	if (value === "") return "edit";
	if (value === "show" || value === "reset") return value;
	throw new Error("Usage: /subagent-models [show|reset]");
}

type SubagentBudgetCommand = { action: "show" | "reset" } | { action: "set"; maxTokens: number };

function parseSubagentBudgetCommand(args: string, maximum: number): SubagentBudgetCommand {
	const parts = args.trim().split(/\s+/u);
	if (parts.length === 1 && (parts[0] === "show" || parts[0] === "reset")) return { action: parts[0] };
	if (parts.length !== 2 || parts[0] !== "set" || !/^\d+[kKmM]?$/u.test(parts[1]!)) {
		throw new Error("Usage: /subagent-budget show|set <value>|reset (value: integer tokens, K, or M)");
	}
	const raw = parts[1]!;
	const suffix = raw.at(-1)?.toLowerCase();
	const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
	const digits = multiplier === 1 ? raw : raw.slice(0, -1);
	const maxTokens = Number(digits) * multiplier;
	if (!Number.isSafeInteger(maxTokens) || maxTokens < MIN_SUBAGENT_TOKENS_PER_TASK || maxTokens > maximum) {
		throw new RangeError(
			`Subagent task budget must be between ${MIN_SUBAGENT_TOKENS_PER_TASK.toLocaleString("en-US")} and ${maximum.toLocaleString("en-US")} tokens`,
		);
	}
	return { action: "set", maxTokens };
}

function errorDetails(error: unknown): SubagentToolDetails | undefined {
	if (error instanceof SubagentDagRunError) return error.details;
	if (error instanceof DagRunInterruptedError) return error.details;
	return undefined;
}

function semanticVerdict(
	details: SubagentToolDetails,
): { outcome: "rejected" | "inconclusive"; label: string } | undefined {
	if (
		details.status !== "failed" ||
		details.integration?.kind === "partial" ||
		details.integrationFailure !== undefined ||
		details.tasks.some((task) => task.status === "failed" || task.status === "cancelled")
	) {
		return undefined;
	}
	const negative = details.tasks.filter(
		(task) =>
			task.status === "succeeded" &&
			(task.artifact?.quality.semanticOutcome === "rejected" ||
				task.artifact?.quality.semanticOutcome === "inconclusive"),
	);
	if (negative.length === 0) return undefined;
	const outcome = negative.some((task) => task.artifact?.quality.semanticOutcome === "rejected")
		? "rejected"
		: "inconclusive";
	const reviewerOnly = negative.every((task) => task.role === "reviewer");
	return {
		outcome,
		label: reviewerOnly
			? outcome === "rejected"
				? "review found issues"
				: "review inconclusive"
			: outcome === "rejected"
				? "result rejected"
				: "result inconclusive",
	};
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function assertValidationConfiguration(policy: SubagentPolicy, registeredIds: readonly string[]): string[] {
	const configured = policy.allowedValidationCommandIds ?? [];
	const effective = sortedUnique(registeredIds);
	if (new Set(configured).size !== configured.length) {
		throw new Error("Subagent policy contains duplicate validation command IDs");
	}
	const allowed = [...configured].sort();
	if (JSON.stringify(allowed) !== JSON.stringify(effective)) {
		throw new Error(
			`Subagent validation policy/registry mismatch; policy: ${allowed.join(", ") || "none"}; registry: ${effective.join(", ") || "none"}`,
		);
	}
	return effective;
}

export function createSubagentExtension(options: SubagentExtensionOptions) {
	return function subagentExtension(pi: ExtensionAPI): void {
		const validationCommands = options.validationCommands ?? [];
		const validationRegistry = new ValidationRegistry(validationCommands);
		const registeredValidationIds = validationCommands.map((command) => command.id);
		const policy =
			options.policy ??
			({
				...DEFAULT_SUBAGENT_POLICY,
				allowedValidationCommandIds: registeredValidationIds,
			} satisfies SubagentPolicy);
		const validationCommandIds = assertValidationConfiguration(policy, registeredValidationIds);
		const parameters = createSubagentToolRequestSchema(policy);
		const sessionBudgetMaximum = Math.min(policy.maximumBudget.maxTokens, MAX_SUBAGENT_TOKENS_PER_TASK);
		const configuredSessionDefault = Math.min(policy.defaultBudget.maxTokens, sessionBudgetMaximum);
		if (!Number.isSafeInteger(configuredSessionDefault) || configuredSessionDefault < MIN_SUBAGENT_TOKENS_PER_TASK) {
			throw new RangeError(
				`Subagent default task budget must be a safe integer of at least ${MIN_SUBAGENT_TOKENS_PER_TASK.toLocaleString("en-US")} tokens`,
			);
		}
		const ownsLedger = options.ledger === undefined;
		const ledgerPath = options.ledgerPath ?? join(options.agentDir, "subagent", "state.sqlite");
		const modelPreferencesPath =
			options.modelPreferencesPath ?? defaultSubagentModelPreferencesPath(options.agentDir);
		const budgetPreferencesPath =
			options.budgetPreferencesPath ?? defaultSubagentBudgetPreferencesPath(options.agentDir);
		const readEffectiveUserBudget = async (): Promise<number> => {
			const preferences = await readSubagentBudgetPreferences(budgetPreferencesPath);
			if (preferences && preferences.maxTokens > sessionBudgetMaximum) {
				throw new SubagentBudgetPreferencesError(
					`Persisted Subagent task budget ${preferences.maxTokens.toLocaleString("en-US")} exceeds the configured maximum ${sessionBudgetMaximum.toLocaleString("en-US")} at ${budgetPreferencesPath}`,
				);
			}
			return preferences?.maxTokens ?? configuredSessionDefault;
		};
		const ledger = options.ledger ?? new RunLedger(ledgerPath, { lazy: true });
		const mirrorRoot =
			options.mirrorRoot ??
			(ledgerPath === ":memory:"
				? join(options.agentDir, "subagent", "mirror-repos")
				: join(dirname(ledgerPath), "mirror-repos"));
		const failedRuns = new Map<string, SubagentToolDetails>();
		const workspaceRouter = createWorkspaceRouter({
			mirrorRoot,
			mirrorLimits: { maxFiles: policy.maxSnapshotFiles, maxBytes: policy.maxSnapshotBytes },
		});
		const dagOrchestrator: SubagentDagOrchestratorAdapter =
			options.dagOrchestrator ??
			new SubagentDagOrchestrator({
				ledger,
				policy,
				validationRegistry,
				createSnapshot: options.createSnapshot,
				runTask: options.runTask,
				createRunId: options.createRunId,
				controllerEnvironment: options.controllerEnvironment,
				sandboxLauncher: options.sandboxLauncher,
				validationSandboxLauncher: options.validationSandboxLauncher,
				createChildHarnessContext: options.createChildHarnessContext,
				retentionPolicy: options.retentionPolicy,
				workspace: {
					createFrozenBaseline: workspaceRouter.createFrozenBaseline,
					pinRunBaseline: workspaceRouter.pinRunBaseline,
					releaseRunBaselinePin: workspaceRouter.releaseRunBaselinePin,
					pinTaskCommit: workspaceRouter.pinTaskCommit,
					releaseTaskCommitPin: workspaceRouter.releaseTaskCommitPin,
					reconcileTaskWorktrees: workspaceRouter.reconcileTaskWorktrees,
					createTaskWorktree: workspaceRouter.createTaskWorktree,
					validateWorktreeOwnership: workspaceRouter.validateWorktreeOwnership,
				},
				mergeTaskCommits: workspaceRouter.mergeTaskCommits,
				releaseMergeCandidateRef: workspaceRouter.releaseMergeCandidateRef,
				inspectMergeCandidateRef: workspaceRouter.inspectMergeCandidateRef,
				inspectMergeCandidateDiff: workspaceRouter.inspectMergeCandidateDiff,
			});

		const repositoryRootResolver = options.resolveRepositoryRoot ?? resolveWorkspaceRoot;
		const listRuns = (listOptions: ListDagRunsOptions = {}): DagRunSummary[] =>
			dagOrchestrator.list?.(listOptions) ?? ledger.listDagRuns(listOptions);
		const inspectOperator = (runId: string): DagRunInspection | undefined =>
			dagOrchestrator.inspectOperator?.(runId, 100) ?? ledger.inspectDagRun(runId, 100);

		const authorizeMutation = async (
			operation: SubagentOperatorMutation,
			runId: string,
			ctx: ExtensionCommandContext,
		): Promise<boolean> => {
			// The parent authorizer is the sole gate; operator mutations are no longer
			// tied to an interactive TUI so headless/print sessions can manage runs.
			if (!options.authorizeOperator) {
				ctx.ui.notify("Subagent operator mutation has no parent authorization policy", "error");
				return false;
			}
			return await options.authorizeOperator({ operation, runId, details: dagOrchestrator.inspect(runId) }, ctx);
		};

		const performCommand = async (
			action: Exclude<SubagentCommandAction, "list">,
			runId: string,
			ctx: ExtensionCommandContext,
		): Promise<void> => {
			const persistedDetails = dagOrchestrator.inspect(runId);
			await assertRunRepository(persistedDetails, ctx.cwd, repositoryRootResolver);
			if (action === "inspect") {
				const details = persistedDetails;
				await showTextOverlay(ctx, `Subagent ${runId}`, operatorInspectionText(details, inspectOperator(runId)));
				return;
			}
			if (action === "diff") {
				if (!dagOrchestrator.diffCandidate) throw new Error("Candidate diff is unavailable in this embedding");
				const diff = await dagOrchestrator.diffCandidate({ runId, maxBytes: 64 * 1024, maxPaths: 200 });
				const suffix = diff.truncated ? "\n\n[bounded output truncated]" : "";
				await showTextOverlay(
					ctx,
					`Candidate diff ${runId}`,
					`Files: ${diff.changedPaths.join(", ") || "none"}\n\n${diff.patch || "No textual diff"}${suffix}`,
				);
				return;
			}
			if (!(await authorizeMutation(action, runId, ctx))) {
				ctx.ui.notify(`Subagent ${action} denied`, "warning");
				return;
			}
			ctx.ui.setStatus("subagent-operator", sanitizeTuiText(`subagent ${action} ${shortRunId(runId)}…`));
			try {
				let details: SubagentDagRunDetails;
				if (action === "resume") {
					details = await dagOrchestrator.resume({
						runId,
						onProgress: (progress) =>
							ctx.ui.setStatus("subagent-operator", sanitizeTuiText(dagProgressText(progress))),
					});
				} else if (action === "pause") {
					if (!dagOrchestrator.pause) throw new Error("Pause is unavailable in this embedding");
					details = await dagOrchestrator.pause({ runId });
				} else if (action === "cancel") {
					if (!dagOrchestrator.cancel) throw new Error("Cancel is unavailable in this embedding");
					details = await dagOrchestrator.cancel({ runId });
				} else if (action === "release") {
					if (!dagOrchestrator.releaseCandidate)
						throw new Error("Candidate release is unavailable in this embedding");
					details = await dagOrchestrator.releaseCandidate({ runId });
				} else {
					if (!dagOrchestrator.gc) throw new Error("Resource GC is unavailable in this embedding");
					details = await dagOrchestrator.gc({ runId });
				}
				ctx.ui.notify(`Subagent ${runId}: ${action} completed (${details.status})`, "info");
			} finally {
				ctx.ui.setStatus("subagent-operator", undefined);
			}
		};

		const openDashboard = async (ctx: ExtensionCommandContext): Promise<void> => {
			let repositoryRoot: string;
			try {
				repositoryRoot = await repositoryRootResolver(ctx.cwd);
			} catch (error) {
				if (error instanceof NotAGitRepositoryError) {
					// Durable runs only exist for Git repositories, so a non-Git cwd
					// legitimately scopes the inventory to zero runs.
					ctx.ui.notify("Not inside a Git repository; no repository-scoped Subagent runs", "info");
					return;
				}
				throw error;
			}
			const runs = listRuns({ limit: 30, repositoryRoot });
			const runId = await selectRun(ctx, runs);
			if (!runId || ctx.mode !== "tui") return;
			const details = dagOrchestrator.inspect(runId);
			const actions: Array<{ label: string; action: Exclude<SubagentCommandAction, "list"> }> = [
				{ label: "Inspect details", action: "inspect" },
			];
			if (details.status === "created" || details.status === "running") {
				if (details.pausedAt !== undefined || details.lease === undefined) {
					actions.push({ label: "Resume", action: "resume" });
				} else {
					actions.push({ label: "Pause", action: "pause" });
				}
				actions.push({ label: "Cancel terminally", action: "cancel" });
			}
			if (details.integration && details.resources.candidate === "retained") {
				actions.push({ label: "Inspect candidate diff", action: "diff" });
				actions.push({ label: "Release candidate ref", action: "release" });
			}
			if (
				["succeeded", "failed", "cancelled"].includes(details.status) &&
				details.resources.pins !== "released" &&
				(details.resources.candidate === "none" || details.resources.candidate === "released")
			) {
				actions.push({ label: "Garbage-collect retained pins", action: "gc" });
			}
			const selected = await ctx.ui.select(
				`Subagent ${runId}`,
				actions.map((item) => item.label),
			);
			const action = actions.find((item) => item.label === selected)?.action;
			if (action) await performCommand(action, runId, ctx);
		};

		pi.registerCommand("subagents", {
			description: "List, inspect, resume, pause, cancel, diff, release, or GC durable Subagent DAG runs",
			getArgumentCompletions: (prefix) => {
				const actions: SubagentCommandAction[] = [
					"list",
					"inspect",
					"resume",
					"pause",
					"cancel",
					"diff",
					"release",
					"gc",
				];
				const trimmed = prefix.trimStart();
				if (!trimmed.includes(" ")) {
					return actions
						.filter((action) => action.startsWith(trimmed))
						.map((action) => ({ value: action, label: action }));
				}
				// The completion API has no repository context. Do not disclose global
				// durable run IDs; the repository-filtered dashboard provides discovery.
				return null;
			},
			async handler(args, ctx) {
				try {
					if (options.authorizeOperatorRead && !(await options.authorizeOperatorRead(ctx))) {
						ctx.ui.notify("Subagent operator access denied", "warning");
						return;
					}
					const parsed = parseSubagentCommand(args);
					if (parsed.action === "list") await openDashboard(ctx);
					else await performCommand(parsed.action, parsed.runId!, ctx);
				} catch (error) {
					ctx.ui.setStatus("subagent-operator", undefined);
					ctx.ui.notify(boundedText(error instanceof Error ? error.message : String(error), 500), "error");
				}
			},
		});

		pi.registerCommand("subagent-budget", {
			description: "Show, persist, or reset the user token budget for each task in future Subagent runs",
			getArgumentCompletions: (prefix) =>
				["show", "set", "reset"]
					.filter((action) => action.startsWith(prefix.trim()))
					.map((action) => ({ value: action, label: action })),
			async handler(args, ctx) {
				try {
					const command = parseSubagentBudgetCommand(args, sessionBudgetMaximum);
					if (command.action === "set") {
						await writeSubagentBudgetPreferences(budgetPreferencesPath, command.maxTokens);
						ctx.ui.notify(
							`Subagent task budget persisted at ${command.maxTokens.toLocaleString("en-US")} tokens per task; existing runs are unaffected`,
							"info",
						);
						return;
					}
					if (command.action === "reset") {
						await resetSubagentBudgetPreferences(budgetPreferencesPath);
						ctx.ui.notify(
							`Subagent task budget reset persistently to ${configuredSessionDefault.toLocaleString("en-US")} tokens per task; existing runs are unaffected`,
							"info",
						);
						return;
					}
					let effectiveBudget: number;
					try {
						effectiveBudget = await readEffectiveUserBudget();
					} catch (error) {
						throw new SubagentBudgetPreferencesError(
							`Cannot read Subagent budget preferences at ${budgetPreferencesPath}: ${error instanceof Error ? error.message : String(error)}. Repair with /subagent-budget set <value> or /subagent-budget reset`,
							{ cause: error },
						);
					}
					ctx.ui.notify(
						`Subagent task budget default: ${effectiveBudget.toLocaleString("en-US")} tokens per task (allowed ${MIN_SUBAGENT_TOKENS_PER_TASK.toLocaleString("en-US")}–${sessionBudgetMaximum.toLocaleString("en-US")}); existing runs are unaffected`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(boundedText(error instanceof Error ? error.message : String(error), 500), "error");
				}
			},
		});

		pi.registerCommand("subagent-models", {
			description: "Show or configure persistent model and thinking-effort routing for Subagent roles",
			getArgumentCompletions: (prefix) =>
				["show", "reset"]
					.filter((action) => action.startsWith(prefix.trim()))
					.map((action) => ({ value: action, label: action })),
			async handler(args, ctx) {
				try {
					const action = parseModelPreferencesCommand(args);
					if (action === "show") {
						await showModelPreferences(ctx, modelPreferencesPath, options);
						return;
					}
					if (action === "reset") {
						if (!ctx.hasUI) {
							throw new Error("/subagent-models reset requires an interactive UI confirmation");
						}
						const confirmed = await ctx.ui.confirm(
							"Reset Subagent model preferences?",
							"Delete the global preferences file? Existing runs are unaffected; new runs will inherit again.",
						);
						if (!confirmed) return;
						const removed = await resetSubagentModelPreferences(modelPreferencesPath);
						ctx.ui.notify(
							removed ? "Subagent model preferences reset" : "Subagent model preferences were already absent",
							"info",
						);
						return;
					}
					await editModelPreferences(ctx, modelPreferencesPath, options);
				} catch (error) {
					ctx.ui.notify(boundedText(error instanceof Error ? error.message : String(error), 500), "error");
				}
			},
		});

		const tool: ToolDefinition<typeof parameters, SubagentToolDetails> = {
			name: "subagent",
			label: "Subagent",
			description: "Run one bounded durable task DAG and return every task result.",
			promptSnippet: "Run a bounded durable task DAG",
			promptGuidelines: [
				"Prefer one coherent task that can inspect, implement, and verify its own module; split only for real parallelism, independent review, or separate side-effect boundaries.",
				"Describe the outcome, scope, and only context the repository cannot supply in objective; let the Subagent discover implementation details.",
				"Use dependsOn only for required execution ordering. Use reviewOf for an independent verdict; it implies dependencies and must cover every isolated Writer when candidate review is requested.",
				"All tasks inherit Parent WJ permission mode, session grants, and tool catalog.",
				"Omit write paths for a report task. ownedPaths selects an isolated Writer and Candidate; Controller-registered validation commands are applied automatically.",
				"externalOwnedPaths selects irreversible external writes, cannot be mixed with isolated Writers, and is never retried automatically.",
			],
			parameters,
			renderShell: "self",
			executionMode: "sequential",
			async execute(toolCallId, rawParams, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentToolDetails>> {
				assertSubagentToolRequestSize(rawParams);
				const params = parseSubagentToolRequest(rawParams, parameters);
				const setStatus = (text: string | undefined): void =>
					ctx.ui?.setStatus("subagent", text === undefined ? undefined : sanitizeTuiText(text));
				setStatus("subagent: preparing");
				try {
					const inheritedChildModel = parentModelSelection(ctx as ExtensionCommandContext);
					const childModel = options.childModel ?? inheritedChildModel;
					let effectiveBudget: number;
					try {
						effectiveBudget = await readEffectiveUserBudget();
					} catch (error) {
						throw new SubagentBudgetPreferencesError(
							`Cannot start Subagent because ${budgetPreferencesPath} is invalid: ${error instanceof Error ? error.message : String(error)}. Repair with /subagent-budget set <value> or /subagent-budget reset`,
							{ cause: error },
						);
					}
					const compiled = compileSubagentToolDagRequest(
						params,
						{
							...policy,
							defaultBudget: { ...policy.defaultBudget, maxTokens: effectiveBudget },
						},
						validationCommandIds,
					);
					let preferences: SubagentModelPreferences | undefined;
					try {
						preferences = await readSubagentModelPreferences(modelPreferencesPath);
					} catch (error) {
						throw new SubagentModelPreferencesError(
							`Cannot start Subagent because ${modelPreferencesPath} is invalid: ${error instanceof Error ? error.message : String(error)}. Repair with /subagent-models show or /subagent-models reset`,
							{ cause: error },
						);
					}
					const childModels = resolveModelsForContext(
						ctx as ExtensionCommandContext,
						preferences,
						options,
					).childModels;
					const request = {
						...compiled,
						...(childModel ? { childModel } : {}),
						childModels,
					};
					const details = await dagOrchestrator.start({
						request,
						repositoryPath: ctx.cwd,
						signal,
						onProgress: (progress) => {
							const text = dagProgressText(progress);
							setStatus(text);
							onUpdate?.({
								content: [{ type: "text", text }],
								details: progress.details,
								usage: progress.details.usage,
							});
						},
					});
					if (details.integration) {
						ctx.ui?.notify(`Subagent ${details.runId}: candidate ready at ${details.integration.ref}`, "info");
					} else if (details.status === "succeeded") {
						ctx.ui?.notify(`Subagent ${details.runId}: completed`, "info");
					}
					if (options.retentionPolicy?.enabled && dagOrchestrator.sweepRetention) {
						await dagOrchestrator.sweepRetention(options.retentionPolicy);
					}
					return {
						content: [
							{
								type: "text",
								text: finalText(details) || "No Subagent output",
							},
						],
						details,
						usage: details.usage,
					};
				} catch (error) {
					const details = errorDetails(error);
					if (details) {
						const verdict =
							error instanceof SubagentDagRunError && error.message.includes(" semantic outcome ")
								? semanticVerdict(details)
								: undefined;
						if (verdict) {
							ctx.ui?.notify(
								`Subagent ${shortRunId(details.runId)}: ${verdict.label} — findings available`,
								"warning",
							);
							return {
								content: [{ type: "text", text: finalText(details) }],
								details,
								usage: details.usage,
							};
						}
						failedRuns.set(toolCallId, details);
						ctx.ui?.notify(
							`Subagent ${details.runId}: ${details.status} — ${boundedText(error instanceof Error ? error.message : String(error), 300)}`,
							"error",
						);
					}
					throw error;
				} finally {
					setStatus(undefined);
				}
			},
			renderCall(args, theme) {
				const taskCount = Array.isArray(args.tasks) ? args.tasks.length : 0;
				const label = `run DAG with ${taskCount} task${taskCount === 1 ? "" : "s"}`;
				return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", label)}`, 0, 0);
			},
			renderResult(result, { isPartial, expanded }, theme) {
				const details = result.details;
				const status = isPartial ? "running" : details.status;
				const verdict = isPartial ? undefined : semanticVerdict(details);
				const summary = sanitizeTuiText(dagResultSummary(details));
				const tone = verdict
					? "warning"
					: status === "succeeded"
						? "success"
						: status === "running" || status === "created"
							? "warning"
							: "error";
				const rawStatusLabel =
					details.pausedAt !== undefined
						? "Paused"
						: (verdict?.label ??
							(status === "succeeded"
								? "Completed"
								: status === "created"
									? "Starting"
									: `${status[0]!.toUpperCase()}${status.slice(1)}`));
				const statusLabel = sanitizeTuiText(rawStatusLabel);
				const header = `${theme.fg(tone, statusLabel)} ${theme.fg("accent", summary)}`;
				if (isPartial) {
					const live = liveResultText(details);
					const activity = liveActivityResultText(details, expanded, theme);
					return new Text(
						`${header}${live ? `\n${sanitizeTuiText(live, true)}` : ""}${activity ? `\n${activity}` : ""}`,
						0,
						0,
					);
				}
				if (!expanded) return new Text(header, 0, 0);
				const body = expandedResultText(details);
				return new Text(`${header}\n${sanitizeTuiText(body, true)}`, 0, 0);
			},
		};

		pi.registerTool(tool);
		pi.on("tool_result", (event) => {
			if (event.toolName !== "subagent") return;
			const details = failedRuns.get(event.toolCallId);
			if (!details) return;
			failedRuns.delete(event.toolCallId);
			return {
				content: [{ type: "text", text: finalText(details) }],
				details,
				usage: details.usage,
				isError: true,
			};
		});
		pi.on("session_shutdown", async () => {
			const settled = await Promise.allSettled([Promise.resolve().then(() => dagOrchestrator.shutdown())]);
			const unexpected: unknown[] = [];
			if (settled[0].status === "rejected" && !(settled[0].reason instanceof DagRunInterruptedError)) {
				unexpected.push(settled[0].reason);
			}
			failedRuns.clear();
			if (ownsLedger) {
				try {
					ledger.close();
				} catch (error) {
					unexpected.push(error);
				}
			}
			if (unexpected.length === 1) throw unexpected[0];
			if (unexpected.length > 1) throw new AggregateError(unexpected, "Subagent shutdown failed");
		});
	};
}
