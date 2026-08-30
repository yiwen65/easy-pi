import { execFileSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type ExecutionEnv, ExecutionError, err, type ShellExecOptions } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { FffSearchProvider } from "../../src/core/tools/fff-search-provider.ts";
import { NodeReadProviderV2 } from "../../src/core/tools/node-read-provider-v2.ts";
import { OpenAICompatibleEmbeddingSearchProvider } from "../../src/core/tools/openai-compatible-embedding-search-provider.ts";
import { TypeScriptCodeIndexProvider } from "../../src/core/tools/typescript-code-index-provider.ts";
import { createSanitizedToolTraceCollector } from "./trace.ts";
import {
	assertContentFreeRecord,
	assertProviderContextBoundary,
	classifyToolResultText,
	initialBudgetState,
	loadV2BoundedRealEvalManifest,
	normalizeFrozenSystemPrompt,
	ProviderContextMetricsAccumulator,
	sha256,
	stableHash,
	stableValue,
	statusEntriesTouchOnlyTarget,
	toolRequestFingerprint,
	V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256,
	V2BoundedEvalBudgetLedger,
	type V2BoundedEvalBudgetState,
	type V2BoundedEvalCase,
	type V2BoundedEvalPhase,
} from "./v2-bounded-real-eval.ts";

const RUN_BASELINE = process.env.PI_REAL_V2_BOUNDED_BASELINE === "1";
const RUN_ITERATION_1 = process.env.PI_REAL_V2_BOUNDED_ITERATION_1 === "1";
const RUN_ITERATION_2 = process.env.PI_REAL_V2_BOUNDED_ITERATION_2 === "1";
const RUN_HELD_OUT = process.env.PI_REAL_V2_BOUNDED_HELD_OUT === "1";
const RUN_FLAGS = [RUN_BASELINE, RUN_ITERATION_1, RUN_ITERATION_2, RUN_HELD_OUT].filter(Boolean).length;
const RUN = RUN_FLAGS > 0;
if (RUN) configureHttpDispatcher();

const PI_ROOT = resolve(import.meta.dirname, "../../../..");
const ALLOWED_PI_DOCUMENTATION_LINES = [
	`- Main documentation: ${PI_ROOT}/packages/coding-agent/README.md`,
	`- Additional docs: ${PI_ROOT}/packages/coding-agent/docs`,
	`- Examples: ${PI_ROOT}/packages/coding-agent/examples (extensions, custom tools, SDK)`,
];
const GOOGLE_EMBEDDING_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/embeddings";
const STRUCTURED_MODES = new Set([
	"symbol_definition",
	"symbol_references",
	"symbol_implementations",
	"call_sites",
	"assignment_lhs",
	"jsx_element",
	"ast_match",
]);

interface ToolCallMetric {
	sequence: number;
	toolName: string;
	status: "success" | "error";
	mode?: string;
	errorCode?: string;
	durationMs: number;
	resultBytes: number;
	usefulBytes: number;
	irrelevantBytes: number;
	ambiguousBytes: number;
	exactFingerprint: string;
	semanticFingerprint: string;
}

interface PendingToolMetric {
	sequence: number;
	toolName: string;
	mode?: string;
	action?: string;
	args: unknown;
	startedAt: number;
	exactFingerprint: string;
	semanticFingerprint: string;
}

interface DetailedToolMetrics {
	calls: ToolCallMetric[];
	callsByTool: Record<string, number>;
	toolReturnBytes: number;
	usefulReturnBytes: number;
	irrelevantReturnBytes: number;
	ambiguousReturnBytes: number;
	duplicateExactRequests: number;
	duplicateSemanticRequests: number;
	repeatedSearchRequests: number;
	repeatedReadRequests: number;
	semanticSearches: number;
	structuredSearches: number;
	approximateSearches: number;
	partialSearches: number;
	truncatedSearches: number;
	firstSearchTargetRank: number | null;
	recallAt5: number | null;
	mrr: number | null;
	targetFirstRead: boolean | null;
	wrongCandidateReads: number;
	requiredRangeCoverage: number;
	firstEditSuccess: boolean | null;
	recoveryCalls: number;
	postEditReads: number;
	verifierRuns: number;
	verifierRunSucceeded: boolean;
	verifierExitCode: number | null;
	verifierSignal: string | null;
	verifierTerminationReason: string | null;
	verifierTerminationRequested: boolean | null;
	verifierTimedOut: boolean;
}

interface FaultController {
	handle(event: AgentSessionEvent): void;
	wasApplied(): boolean;
	wasAppliedBeforeEdit(): boolean;
}

function nonEmptyEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Real bounded evaluation requires ${name}`);
	return value;
}

function sessionFailureCategory(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (message.startsWith("provider_context_")) return "chat_data_boundary_violation";
	if (message.startsWith("evaluation_integrity_failure")) return "evaluation_integrity_failure";
	if (
		/^(?:session_chat_request_budget_exhausted|chat_request_budget_exhausted|paid_request_budget_exhausted|combined_token_budget_exhausted|known_cost_budget_exhausted|evaluation_time_budget_exhausted|evaluation_usage_reconciliation_pending)$/.test(
			message,
		)
	) {
		return message;
	}
	return "chat_provider_or_infrastructure";
}

function phaseFromFlags(): V2BoundedEvalPhase {
	if (RUN_FLAGS !== 1) throw new Error("Set exactly one bounded real-evaluation stage flag");
	if (RUN_BASELINE) return "baseline";
	if (RUN_ITERATION_1) return "iteration_1";
	if (RUN_ITERATION_2) return "iteration_2";
	return "held_out";
}

function selectedCases(phase: V2BoundedEvalPhase, manifest: ReturnType<typeof loadV2BoundedRealEvalManifest>) {
	if (phase === "baseline") return manifest.stageOrder.development.map((id) => requireCase(manifest.cases, id));
	if (phase === "held_out") return manifest.stageOrder.heldOut.map((id) => requireCase(manifest.cases, id));
	const id = nonEmptyEnvironment("PI_V2_EVAL_CASE_ID");
	const evalCase = requireCase(manifest.cases, id);
	if (evalCase.stage !== "development") throw new Error("Optimization iterations may use development cases only");
	return [evalCase];
}

function requireCase(cases: V2BoundedEvalCase[], id: string): V2BoundedEvalCase {
	const evalCase = cases.find((entry) => entry.id === id);
	if (!evalCase) throw new Error(`Unknown sealed evaluation case: ${id}`);
	return evalCase;
}

function git(cwd: string, args: string[], options: { buffer?: boolean } = {}): string | Buffer {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: options.buffer ? undefined : "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
}

function gitText(cwd: string, args: string[]): string {
	return String(git(cwd, args)).trim();
}

function replaceUnique(content: string, oldText: string, newText: string): string {
	const first = content.indexOf(oldText);
	if (first < 0 || content.indexOf(oldText, first + oldText.length) >= 0) {
		throw new Error("sealed_mutation_anchor_invalid");
	}
	return content.slice(0, first) + newText + content.slice(first + oldText.length);
}

function normalizedPath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function pathMatches(value: unknown, expected: string): boolean {
	if (typeof value !== "string") return false;
	const left = normalizedPath(value);
	const right = normalizedPath(expected);
	return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resultDetails(result: unknown): Record<string, unknown> | undefined {
	if (!isRecord(result) || !isRecord(result.details)) return undefined;
	return result.details;
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	return result.content
		.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

function errorCode(result: unknown): string | undefined {
	const first = resultText(result).split("\n", 1)[0];
	return /^[A-Z][A-Z0-9_]+$/.test(first) ? first : undefined;
}

function modeFromArgs(toolName: string, args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	if (toolName === "search") {
		if (typeof args.mode === "string") return args.mode;
		if (isRecord(args.queryTemplate) && typeof args.queryTemplate.type === "string") return args.queryTemplate.type;
		return typeof args.kind === "string" ? args.kind : undefined;
	}
	if (toolName === "edit") return typeof args.action === "string" ? args.action : undefined;
	return undefined;
}

function searchTargetRank(result: unknown, targetPath: string): number | null {
	const hits = resultDetails(result)?.hits;
	if (!Array.isArray(hits)) return null;
	const index = hits.findIndex((hit) => isRecord(hit) && pathMatches(hit.path, targetPath));
	return index < 0 ? 0 : index + 1;
}

function rangeCoverage(details: Record<string, unknown> | undefined, evalCase: V2BoundedEvalCase): number {
	if (!details || !pathMatches(details.path, evalCase.targetPath)) return 0;
	if (!Array.isArray(details.range) || details.range.length !== 2) return 0;
	const start = Number(details.range[0]);
	const end = Number(details.range[1]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 0;
	const requiredStart = evalCase.requiredRange.startLine;
	const requiredEnd = evalCase.requiredRange.endLine;
	const overlap = Math.max(0, Math.min(end, requiredEnd) - Math.max(start, requiredStart) + 1);
	return Math.min(1, overlap / (requiredEnd - requiredStart + 1));
}

function createDetailedToolCollector(
	evalCase: V2BoundedEvalCase,
	workspaceRoot: string,
	allowedRunCommand: string,
): { handle(event: AgentSessionEvent): void; snapshot(): DetailedToolMetrics } {
	const pending = new Map<string, PendingToolMetric>();
	const calls: ToolCallMetric[] = [];
	const callsByTool: Record<string, number> = { search: 0, read: 0, edit: 0, run: 0 };
	const exactFingerprints = new Set<string>();
	const semanticFingerprints = new Set<string>();
	const searchFingerprints = new Set<string>();
	const readFingerprints = new Set<string>();
	let sequence = 0;
	let toolReturnBytes = 0;
	let usefulReturnBytes = 0;
	let irrelevantReturnBytes = 0;
	let ambiguousReturnBytes = 0;
	let duplicateExactRequests = 0;
	let duplicateSemanticRequests = 0;
	let repeatedSearchRequests = 0;
	let repeatedReadRequests = 0;
	let semanticSearches = 0;
	let structuredSearches = 0;
	let approximateSearches = 0;
	let partialSearches = 0;
	let truncatedSearches = 0;
	let firstSearchTargetRank: number | null = null;
	let targetFirstRead: boolean | null = null;
	let wrongCandidateReads = 0;
	let requiredRangeCoverage = 0;
	let firstEditSuccess: boolean | null = null;
	let awaitingRecovery = false;
	let recoveryCalls = 0;
	let successfulCommitSeen = false;
	let postEditReads = 0;
	let verifierRuns = 0;
	let verifierRunSucceeded = false;
	let verifierExitCode: number | null = null;
	let verifierSignal: string | null = null;
	let verifierTerminationReason: string | null = null;
	let verifierTerminationRequested: boolean | null = null;
	let verifierTimedOut = false;

	return {
		handle(event) {
			if (event.type === "tool_execution_start") {
				const exactFingerprint = toolRequestFingerprint(event.toolName, event.args, workspaceRoot, false);
				const semanticFingerprint = toolRequestFingerprint(event.toolName, event.args, workspaceRoot, true);
				if (exactFingerprints.has(exactFingerprint)) duplicateExactRequests += 1;
				if (semanticFingerprints.has(semanticFingerprint)) duplicateSemanticRequests += 1;
				exactFingerprints.add(exactFingerprint);
				semanticFingerprints.add(semanticFingerprint);
				if (event.toolName === "search") {
					if (searchFingerprints.has(semanticFingerprint)) repeatedSearchRequests += 1;
					searchFingerprints.add(semanticFingerprint);
					const mode = modeFromArgs(event.toolName, event.args);
					if (mode === "semantic_candidate") semanticSearches += 1;
					if (mode && STRUCTURED_MODES.has(mode)) structuredSearches += 1;
				}
				if (event.toolName === "read") {
					if (readFingerprints.has(semanticFingerprint)) repeatedReadRequests += 1;
					readFingerprints.add(semanticFingerprint);
				}
				if (awaitingRecovery) {
					recoveryCalls += 1;
					awaitingRecovery = false;
				}
				callsByTool[event.toolName] = (callsByTool[event.toolName] ?? 0) + 1;
				pending.set(event.toolCallId, {
					sequence: sequence++,
					toolName: event.toolName,
					mode: modeFromArgs(event.toolName, event.args),
					action: isRecord(event.args) && typeof event.args.action === "string" ? event.args.action : undefined,
					args: event.args,
					startedAt: Date.now(),
					exactFingerprint,
					semanticFingerprint,
				});
				return;
			}
			if (event.type !== "tool_execution_end") return;
			const started = pending.get(event.toolCallId);
			if (!started) return;
			pending.delete(event.toolCallId);
			const text = resultText(event.result);
			const bytes = Buffer.byteLength(text);
			const labels = classifyToolResultText(text, evalCase);
			toolReturnBytes += bytes;
			usefulReturnBytes += labels.useful;
			irrelevantReturnBytes += labels.irrelevant;
			ambiguousReturnBytes += labels.ambiguous;
			if (event.isError) awaitingRecovery = true;
			const details = resultDetails(event.result);
			if (started.toolName === "search" && !event.isError) {
				if (firstSearchTargetRank === null) {
					firstSearchTargetRank = searchTargetRank(event.result, evalCase.targetPath);
				}
				if (details?.approximate === true) approximateSearches += 1;
				if (details?.partial === true) partialSearches += 1;
				if (isRecord(details?.coverage) && details.coverage.truncated === true) truncatedSearches += 1;
			}
			if (started.toolName === "read" && !event.isError && details?.kind === "text") {
				const isTarget = pathMatches(details.path, evalCase.targetPath);
				if (targetFirstRead === null) targetFirstRead = isTarget;
				if (!isTarget && targetFirstRead !== true) wrongCandidateReads += 1;
				requiredRangeCoverage = Math.max(requiredRangeCoverage, rangeCoverage(details, evalCase));
				if (successfulCommitSeen && isTarget) postEditReads += 1;
			}
			if (started.toolName === "edit") {
				if (firstEditSuccess === null) firstEditSuccess = !event.isError;
				if (started.action === "commit" && !event.isError) successfulCommitSeen = true;
			}
			if (started.toolName === "run" && isRecord(started.args) && started.args.command === allowedRunCommand) {
				verifierRuns += 1;
				verifierExitCode = typeof details?.exitCode === "number" ? details.exitCode : null;
				verifierSignal = typeof details?.signal === "string" ? details.signal : null;
				verifierTerminationReason =
					typeof details?.terminationReason === "string" ? details.terminationReason : null;
				verifierTerminationRequested =
					typeof details?.terminationRequested === "boolean" ? details.terminationRequested : null;
				verifierTimedOut = details?.timedOut === true;
				verifierRunSucceeded = !event.isError && verifierExitCode === 0 && text.includes("PASS");
			}
			calls.push({
				sequence: started.sequence,
				toolName: started.toolName,
				status: event.isError ? "error" : "success",
				...(started.mode ? { mode: started.mode } : {}),
				...(event.isError && errorCode(event.result) ? { errorCode: errorCode(event.result) } : {}),
				durationMs: Math.max(0, Date.now() - started.startedAt),
				resultBytes: bytes,
				usefulBytes: labels.useful,
				irrelevantBytes: labels.irrelevant,
				ambiguousBytes: labels.ambiguous,
				exactFingerprint: started.exactFingerprint,
				semanticFingerprint: started.semanticFingerprint,
			});
		},
		snapshot() {
			const rank = firstSearchTargetRank;
			return {
				calls: [...calls].sort((left, right) => left.sequence - right.sequence),
				callsByTool: { ...callsByTool },
				toolReturnBytes,
				usefulReturnBytes,
				irrelevantReturnBytes,
				ambiguousReturnBytes,
				duplicateExactRequests,
				duplicateSemanticRequests,
				repeatedSearchRequests,
				repeatedReadRequests,
				semanticSearches,
				structuredSearches,
				approximateSearches,
				partialSearches,
				truncatedSearches,
				firstSearchTargetRank: rank,
				recallAt5: rank === null ? null : rank > 0 && rank <= 5 ? 1 : 0,
				mrr: rank === null ? null : rank > 0 ? 1 / rank : 0,
				targetFirstRead,
				wrongCandidateReads,
				requiredRangeCoverage,
				firstEditSuccess,
				recoveryCalls,
				postEditReads,
				verifierRuns,
				verifierRunSucceeded,
				verifierExitCode,
				verifierSignal,
				verifierTerminationReason,
				verifierTerminationRequested,
				verifierTimedOut,
			};
		},
	};
}

function createFaultController(evalCase: V2BoundedEvalCase, cwd: string): FaultController {
	let applied = false;
	let editStartedBeforeFault = false;
	const reads = new Map<string, boolean>();
	return {
		handle(event) {
			if (!evalCase.fault) return;
			if (event.type === "tool_execution_start") {
				if (event.toolName === "edit" && !applied) editStartedBeforeFault = true;
				if (event.toolName === "read" && !applied) {
					const args = isRecord(event.args) ? event.args : {};
					reads.set(event.toolCallId, pathMatches(args.path, evalCase.targetPath));
				}
				return;
			}
			if (event.type !== "tool_execution_end" || applied) return;
			const details = resultDetails(event.result);
			const targetRead = reads.get(event.toolCallId) === true || pathMatches(details?.path, evalCase.targetPath);
			reads.delete(event.toolCallId);
			if (event.isError || !targetRead) return;
			const target = join(cwd, evalCase.targetPath);
			const current = readFileSync(target, "utf8");
			if (current.includes(evalCase.fault.marker)) throw new Error("fault_marker_already_present");
			const next = replaceUnique(
				current,
				evalCase.fault.anchor,
				`${evalCase.fault.marker}\n${evalCase.fault.anchor}`,
			);
			writeFileSync(target, next);
			applied = true;
		},
		wasApplied: () => applied,
		wasAppliedBeforeEdit: () => applied && !editStartedBeforeFault,
	};
}

function createRestrictedExecutionEnv(
	base: NodeExecutionEnv,
	allowedCommand: string,
	verifierPath: string,
	contractRoot: string,
): ExecutionEnv {
	const safeEnvironment: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: contractRoot,
		TMPDIR: join(contractRoot, "tmp"),
		LANG: process.env.LANG ?? "C.UTF-8",
		LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		PI_V2_EVAL_VERIFY: verifierPath,
	};
	return new Proxy(base, {
		get(target, property) {
			if (property === "exec") {
				return (command: string, options?: ShellExecOptions) => {
					if (command.trim() !== allowedCommand) {
						return Promise.resolve(
							err(new ExecutionError("spawn_error", "Evaluation Run permits only the frozen verifier command.")),
						);
					}
					return target.exec(command, {
						...options,
						inheritEnv: false,
						env: safeEnvironment,
					});
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExecutionEnv;
}

function collectForbiddenValues(auth: unknown): string[] {
	const values = new Set<string>();
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			if (value.length >= 8) values.add(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (isRecord(value)) for (const nested of Object.values(value)) visit(nested);
	};
	visit(auth);
	for (const [key, value] of Object.entries(process.env)) {
		if (value && /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key) && value.length >= 8) values.add(value);
	}
	return [...values];
}

function budgetStatePath(contractRoot: string): string {
	return join(contractRoot, "budget-state.json");
}

function loadBudgetState(contractRoot: string): V2BoundedEvalBudgetState {
	const statePath = budgetStatePath(contractRoot);
	if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, "utf8")) as V2BoundedEvalBudgetState;
	const clock: unknown = JSON.parse(readFileSync(join(contractRoot, "evaluation-clock.json"), "utf8"));
	if (!isRecord(clock) || clock.contractHash !== V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256) {
		throw new Error("Evaluation clock does not match the sealed contract");
	}
	const startedAtMs = Number(clock.startedAtMs);
	return initialBudgetState(startedAtMs);
}

function persistBudgetState(contractRoot: string, state: V2BoundedEvalBudgetState): void {
	assertContentFreeRecord(state);
	const target = budgetStatePath(contractRoot);
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(stableValue(state), null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, target);
}

function ensureWithinContractRoot(contractRoot: string, path: string): void {
	const root = resolve(contractRoot);
	const candidate = resolve(path);
	if (candidate !== root && !candidate.startsWith(`${root}/`))
		throw new Error("Evaluation path escaped contract root");
}

function writeOnce(path: string, value: unknown, contractRoot: string): void {
	ensureWithinContractRoot(contractRoot, path);
	assertContentFreeRecord(value);
	mkdirSync(dirname(path), { recursive: true });
	const descriptor = openSync(path, "wx", 0o600);
	try {
		writeSync(descriptor, `${JSON.stringify(stableValue(value), null, 2)}\n`);
	} finally {
		closeSync(descriptor);
	}
}

function externalContractPreflight(
	contractRoot: string,
	manifest: ReturnType<typeof loadV2BoundedRealEvalManifest>,
): void {
	if (!isAbsolute(contractRoot) || !existsSync(contractRoot))
		throw new Error("Contract root must be an existing absolute path");
	if (sha256(readFileSync(join(contractRoot, "sealed-contract.json"))) !== V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256) {
		throw new Error("External sealed contract hash changed");
	}
	if (
		sha256(readFileSync(join(contractRoot, "verify.mjs"))) !==
		"f7aeef7a39e53ba87af955072068397378c0cccbb2a846c7c22d82d39605f892"
	) {
		throw new Error("External verifier hash changed");
	}
	for (const repository of Object.values(manifest.repositories)) {
		const cwd = join(contractRoot, repository.id);
		if (gitText(cwd, ["rev-parse", "HEAD"]) !== repository.commit) throw new Error("Public clone commit drifted");
		if (gitText(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])) {
			throw new Error("Public clone must be clean before a stage starts");
		}
	}
}

function productState(): { piHead: string; piDiffHash: string } {
	const piHead = gitText(PI_ROOT, ["rev-parse", "HEAD"]);
	const productDiff = git(PI_ROOT, [
		"diff",
		"HEAD",
		"--binary",
		"--",
		"packages/agent/src",
		"packages/coding-agent/src",
	]);
	return { piHead, piDiffHash: sha256(Buffer.isBuffer(productDiff) ? productDiff : Buffer.from(productDiff)) };
}

function gitStatusEntries(cwd: string): string[] {
	const status = execFileSync(
		"git",
		["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
		{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	return status.split("\0").filter(Boolean);
}

function targetStatusOnly(cwd: string, evalCase: V2BoundedEvalCase): boolean {
	return statusEntriesTouchOnlyTarget(gitStatusEntries(cwd), evalCase.targetPath);
}

function currentTargetHash(cwd: string, evalCase: V2BoundedEvalCase): string {
	return sha256(readFileSync(join(cwd, evalCase.targetPath)));
}

function prepareMutation(cwd: string, evalCase: V2BoundedEvalCase, verifierPath: string): void {
	if (gitStatusEntries(cwd).length > 0) throw new Error("fixture_not_clean_before_mutation");
	const original = git(cwd, ["show", `HEAD:${evalCase.targetPath}`], { buffer: true });
	const originalBytes = Buffer.isBuffer(original) ? original : Buffer.from(original);
	if (sha256(originalBytes) !== evalCase.originalSha256) throw new Error("fixture_original_hash_mismatch");
	const mutated = replaceUnique(originalBytes.toString("utf8"), evalCase.oldText, evalCase.mutatedText);
	writeFileSync(join(cwd, evalCase.targetPath), mutated);
	chmodSync(join(cwd, evalCase.targetPath), evalCase.expectedMode);
	if (currentTargetHash(cwd, evalCase) !== evalCase.mutatedSha256) throw new Error("fixture_mutation_hash_mismatch");
	let verifierFailed = false;
	try {
		execFileSync(verifierPath, [evalCase.id], { cwd, stdio: "ignore" });
	} catch {
		verifierFailed = true;
	}
	if (!verifierFailed) throw new Error("fixture_mutation_did_not_fail");
}

function restoreClone(cwd: string): void {
	const entries = gitStatusEntries(cwd);
	for (const entry of entries) {
		const status = entry.slice(0, 2);
		const relativePath = entry.slice(3);
		const absolutePath = resolve(cwd, relativePath);
		const within = relative(cwd, absolutePath);
		if (!within || within.startsWith("..") || within.includes(".git")) throw new Error("cleanup_path_rejected");
		if (status === "??") {
			rmSync(absolutePath, { recursive: true, force: true });
			continue;
		}
		const treeEntry = gitText(cwd, ["ls-tree", "HEAD", "--", relativePath]);
		if (!treeEntry) throw new Error("tracked_cleanup_source_missing");
		const mode = Number.parseInt(treeEntry.slice(0, 6), 8);
		const original = git(cwd, ["show", `HEAD:${relativePath}`], { buffer: true });
		mkdirSync(dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, Buffer.isBuffer(original) ? original : Buffer.from(original));
		chmodSync(absolutePath, mode & 0o777);
	}
	if (gitStatusEntries(cwd).length > 0) throw new Error("fixture_cleanup_incomplete");
}

function approvedTargetHashes(cwd: string, evalCase: V2BoundedEvalCase): Set<string> {
	const originalValue = git(cwd, ["show", `HEAD:${evalCase.targetPath}`], { buffer: true });
	const original = (Buffer.isBuffer(originalValue) ? originalValue : Buffer.from(originalValue)).toString("utf8");
	const mutated = replaceUnique(original, evalCase.oldText, evalCase.mutatedText);
	const hashes = new Set([evalCase.originalSha256, evalCase.mutatedSha256, evalCase.expectedSha256]);
	if (evalCase.fault) {
		hashes.add(
			sha256(replaceUnique(mutated, evalCase.fault.anchor, `${evalCase.fault.marker}\n${evalCase.fault.anchor}`)),
		);
	}
	return hashes;
}

function workspaceStateApproved(cwd: string, evalCase: V2BoundedEvalCase, allowedHashes: Set<string>): boolean {
	const entries = gitStatusEntries(cwd);
	if (entries.some((entry) => entry.slice(3) !== evalCase.targetPath)) return false;
	try {
		return allowedHashes.has(currentTargetHash(cwd, evalCase));
	} catch {
		return false;
	}
}

function createEmbeddingFetchGuard(options: {
	codeIndex: TypeScriptCodeIndexProvider;
	cwd: string;
	evalCase: V2BoundedEvalCase;
	ledger: V2BoundedEvalBudgetLedger;
	maxRequests: number;
	usdPerMillionTokens: number;
	onBoundaryViolation(): void;
}): typeof fetch {
	let sessionRequests = 0;
	const allowedHashes = approvedTargetHashes(options.cwd, options.evalCase);
	return async (input, init) => {
		let body: Record<string, unknown>;
		try {
			body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		} catch {
			options.onBoundaryViolation();
			throw new Error("embedding_boundary_invalid_json");
		}
		if (body.model !== "gemini-embedding-001" || !Array.isArray(body.input)) {
			options.onBoundaryViolation();
			throw new Error("embedding_boundary_invalid_shape");
		}
		if (!workspaceStateApproved(options.cwd, options.evalCase, allowedHashes)) {
			options.onBoundaryViolation();
			throw new Error("embedding_boundary_workspace_state");
		}
		const request = {
			query: options.evalCase.semanticQuery,
			kind: "text" as const,
			path: join(options.cwd, options.evalCase.semanticPath),
			case: "sensitive" as const,
			regex: false,
			mode: "semantic_candidate" as const,
			context: 0,
			limit: 5,
			ranking: "task" as const,
			honorIgnore: true,
			includeHidden: false,
			followSymlinks: false,
		};
		const page = await options.codeIndex.listSemanticDocuments(request);
		const allowedDocuments = new Set(page.documents.map((document) => document.text));
		const values = body.input;
		if (
			!values.every(
				(value) =>
					typeof value === "string" && (value === options.evalCase.semanticQuery || allowedDocuments.has(value)),
			)
		) {
			options.onBoundaryViolation();
			throw new Error("embedding_boundary_non_public_input");
		}
		if (sessionRequests >= options.maxRequests) throw new Error("embedding_session_request_budget_exhausted");
		const estimatedTokens = Math.ceil(
			values.reduce((sum, value) => sum + (typeof value === "string" ? value.length : 0), 0) / 4,
		);
		const reservationId = `embedding-${options.ledger.snapshot().embeddingRequests + 1}`;
		options.ledger.reserveEmbedding(reservationId, estimatedTokens, Date.now());
		sessionRequests += 1;
		let response: Response;
		try {
			response = await fetch(input, init);
		} catch (error) {
			options.ledger.markPendingUsageUnknown("embedding_transport_usage_unknown");
			throw error;
		}
		let usedTokens = estimatedTokens;
		try {
			const payload: unknown = await response.clone().json();
			if (isRecord(payload) && isRecord(payload.usage)) {
				const reported = payload.usage.prompt_tokens ?? payload.usage.total_tokens;
				if (Number.isSafeInteger(reported) && Number(reported) >= 0) usedTokens = Number(reported);
			}
		} catch {
			// Conservative estimated usage is frozen when the endpoint omits readable usage.
		}
		options.ledger.commitEmbedding(reservationId, usedTokens, (usedTokens * options.usdPerMillionTokens) / 1_000_000);
		return response;
	};
}

function guardedRuntime(options: {
	runtime: ModelRuntime;
	ledger: V2BoundedEvalBudgetLedger;
	contextMetrics: ProviderContextMetricsAccumulator;
	publicRoot: string;
	forbiddenValues: string[];
	maxOutputTokens: number;
	onChatDispatch(): void;
}): ModelRuntime {
	return new Proxy(options.runtime, {
		get(target, property) {
			if (property === "streamSimple") {
				return (...args: Parameters<ModelRuntime["streamSimple"]>): ReturnType<ModelRuntime["streamSimple"]> => {
					options.onChatDispatch();
					assertProviderContextBoundary(args[1], {
						publicRoot: options.publicRoot,
						forbiddenRoots: [PI_ROOT],
						forbiddenValues: options.forbiddenValues,
						allowedForbiddenRootLines: ALLOWED_PI_DOCUMENTATION_LINES,
					});
					const estimatedInputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(stableValue(args[1]))) / 4);
					const reservationId = `chat-${options.ledger.snapshot().chatRequests + 1}`;
					options.ledger.reserveChat(reservationId, estimatedInputTokens, options.maxOutputTokens, Date.now());
					options.contextMetrics.observe(args[1]);
					return target.streamSimple(args[0], args[1], {
						...args[2],
						maxTokens: options.maxOutputTokens,
						maxRetries: 0,
					});
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ModelRuntime;
}

function schemaHash(session: {
	getAllTools(): ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
}): string {
	return stableHash(
		session.getAllTools().map(({ name, description, parameters }) => ({ name, description, parameters })),
	);
}

function gradeFilesystem(
	cwd: string,
	evalCase: V2BoundedEvalCase,
	verifierPath: string,
	faultApplied: boolean,
): {
	targetCorrect: boolean;
	wrongLocationsUnchanged: boolean;
	modeCorrect: boolean;
	verificationPassed: boolean;
	externalChangePreserved: boolean;
} {
	const target = join(cwd, evalCase.targetPath);
	let verificationPassed = false;
	try {
		execFileSync(verifierPath, [evalCase.id], { cwd, stdio: "ignore", timeout: 10_000 });
		verificationPassed = true;
	} catch {
		verificationPassed = false;
	}
	let targetCorrect = false;
	let modeCorrect = false;
	let externalChangePreserved = !evalCase.fault;
	if (existsSync(target)) {
		targetCorrect = currentTargetHash(cwd, evalCase) === evalCase.expectedSha256;
		modeCorrect = (statSync(target).mode & 0o777) === evalCase.expectedMode;
		externalChangePreserved = evalCase.fault
			? faultApplied && readFileSync(target, "utf8").includes(evalCase.fault.marker)
			: true;
	}
	return {
		targetCorrect,
		wrongLocationsUnchanged: targetStatusOnly(cwd, evalCase),
		modeCorrect,
		verificationPassed,
		externalChangePreserved,
	};
}

function activationGrade(
	metrics: DetailedToolMetrics,
	evalCase: V2BoundedEvalCase,
	manifest: ReturnType<typeof loadV2BoundedRealEvalManifest>,
	faultAppliedBeforeEdit: boolean,
): Record<string, boolean> {
	return {
		search: (metrics.callsByTool.search ?? 0) > 0,
		read: (metrics.callsByTool.read ?? 0) > 0,
		edit: (metrics.callsByTool.edit ?? 0) > 0,
		run: (metrics.callsByTool.run ?? 0) > 0,
		semantic: !manifest.activationGates.semanticRequired.includes(evalCase.id) || metrics.semanticSearches > 0,
		structured:
			!manifest.activationGates.structuredVerificationRequired.includes(evalCase.id) ||
			metrics.structuredSearches > 0,
		postEditRead: !manifest.activationGates.postEditReadRequired || metrics.postEditReads > 0,
		verifierRun:
			!manifest.activationGates.verifierRunRequired ||
			(metrics.verifierRunSucceeded &&
				metrics.verifierSignal === null &&
				metrics.verifierTerminationReason === "exit" &&
				metrics.verifierTerminationRequested === false &&
				!metrics.verifierTimedOut),
		fault: !manifest.activationGates.faultRequired.includes(evalCase.id) || faultAppliedBeforeEdit,
	};
}

function phaseAttemptId(phase: V2BoundedEvalPhase, caseId: string): string {
	return `${phase}-${caseId}`;
}

function heldOutFreezePreflight(contractRoot: string, currentProduct: ReturnType<typeof productState>): void {
	const value: unknown = JSON.parse(readFileSync(join(contractRoot, "candidate-freeze.json"), "utf8"));
	if (
		!isRecord(value) ||
		value.contractHash !== V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256 ||
		value.piHead !== currentProduct.piHead ||
		value.piDiffHash !== currentProduct.piDiffHash
	) {
		throw new Error("Held-out candidate freeze does not match current product state");
	}
}

function sessionRecordPath(contractRoot: string, attemptId: string): string {
	return join(contractRoot, "records", `${attemptId}.json`);
}

function loadStartedAttemptRecord(contractRoot: string, attemptId: string): unknown {
	const path = sessionRecordPath(contractRoot, attemptId);
	if (!existsSync(path)) throw new Error("started_attempt_record_missing");
	const record: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(record) || record.attemptId !== attemptId) throw new Error("started_attempt_record_invalid");
	assertContentFreeRecord(record);
	return record;
}

function nextSummaryPath(contractRoot: string, phase: V2BoundedEvalPhase, sessionsStarted: number): string {
	const primary = join(contractRoot, "summaries", `${phase}.json`);
	return existsSync(primary)
		? join(contractRoot, "summaries", `${phase}-continuation-${sessionsStarted}.json`)
		: primary;
}

describe.skipIf(!RUN)("bounded real v2 public-repository evaluation", () => {
	const manifest = loadV2BoundedRealEvalManifest();
	let contractRoot = "";
	let verifierPath = "";
	let runtime: ModelRuntime;
	let auth: unknown;
	let ledger: V2BoundedEvalBudgetLedger;
	let phase: V2BoundedEvalPhase;
	let cases: V2BoundedEvalCase[];
	const records: unknown[] = [];
	let previousCompactionMode: string | undefined;

	beforeAll(async () => {
		phase = phaseFromFlags();
		contractRoot = nonEmptyEnvironment("PI_V2_EVAL_CONTRACT_ROOT");
		verifierPath = join(contractRoot, "verify.mjs");
		externalContractPreflight(contractRoot, manifest);
		const currentProduct = productState();
		if (!currentProduct.piHead.startsWith(manifest.baselineCommit)) {
			throw new Error("Pi HEAD no longer matches the frozen baseline lineage");
		}
		if (phase === "baseline" && currentProduct.piDiffHash !== sha256("")) {
			throw new Error("Baseline product source is modified");
		}
		if (phase === "held_out") heldOutFreezePreflight(contractRoot, currentProduct);
		cases = selectedCases(phase, manifest);
		ledger = new V2BoundedEvalBudgetLedger(manifest, loadBudgetState(contractRoot), (state) =>
			persistBudgetState(contractRoot, state),
		);
		ledger.assertElapsed(Date.now());
		runtime = await ModelRuntime.create({ credentials: AuthStorage.create(), allowModelNetwork: false });
		const model = runtime.getModel(manifest.provider.chat.provider, manifest.provider.chat.model);
		if (!model) throw new Error("Required target model is unavailable");
		auth = await runtime.getAuth(model);
		if (!auth) throw new Error("Required target-model auth is unavailable");
		nonEmptyEnvironment("GOOGLE_API_KEY");
		previousCompactionMode = process.env.PI_HF_COMPACTION;
		process.env.PI_HF_COMPACTION = "off";
	});

	afterAll(() => {
		if (previousCompactionMode === undefined) delete process.env.PI_HF_COMPACTION;
		else process.env.PI_HF_COMPACTION = previousCompactionMode;
	});

	it(
		"runs only the frozen stage with pre-dispatch breakers and content-free records",
		{ timeout: 2_000_000 },
		async () => {
			let systemicStop: string | undefined;
			for (const evalCase of cases) {
				if (systemicStop) break;
				const attemptId = phaseAttemptId(phase, evalCase.id);
				if (ledger.snapshot().attemptIds.includes(attemptId)) {
					records.push(loadStartedAttemptRecord(contractRoot, attemptId));
					continue;
				}
				const cwd = join(contractRoot, manifest.repositories[evalCase.repository].id);
				const publicRoot = realpathSync(cwd);
				const currentProduct = productState();
				ledger.startSession(attemptId, Date.now());
				const budgetAtSessionStart = ledger.snapshot();
				writeOnce(
					join(contractRoot, "attempts", `${attemptId}.json`),
					{
						version: 1,
						attemptId,
						caseId: evalCase.id,
						phase,
						contractHash: V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256,
						piHead: currentProduct.piHead,
						piDiffHash: currentProduct.piDiffHash,
						startedAtMs: Date.now(),
					},
					contractRoot,
				);
				const codeIndex = new TypeScriptCodeIndexProvider();
				let embeddingBoundaryViolation = false;
				const semanticProvider = new OpenAICompatibleEmbeddingSearchProvider(codeIndex, {
					baseUrl: GOOGLE_EMBEDDING_BASE_URL,
					model: manifest.provider.embedding.model,
					apiKey: nonEmptyEnvironment("GOOGLE_API_KEY"),
					usdPerMillionTokens: manifest.provider.embedding.usdPerMillionTokens,
					maxCostUsd: manifest.budgets.maxKnownCostUsd,
					maxDocuments: manifest.provider.embedding.maxDocumentsPerSession,
					batchSize: manifest.provider.embedding.batchSize,
					maxInputBytes: manifest.provider.embedding.maxInputBytesPerOperation,
					maxRequests: manifest.budgets.maxEmbeddingRequestsPerSession,
					fetchFn: createEmbeddingFetchGuard({
						codeIndex,
						cwd,
						evalCase,
						ledger,
						maxRequests: manifest.budgets.maxEmbeddingRequestsPerSession,
						usdPerMillionTokens: manifest.provider.embedding.usdPerMillionTokens,
						onBoundaryViolation: () => {
							embeddingBoundaryViolation = true;
						},
					}),
				});
				const baseEnv = new NodeExecutionEnv({ cwd });
				const executionEnv = createRestrictedExecutionEnv(
					baseEnv,
					manifest.allowedRunCommands[evalCase.id],
					verifierPath,
					contractRoot,
				);
				const searchProvider = new FffSearchProvider(baseEnv);
				const readProvider = new NodeReadProviderV2(baseEnv);
				const settingsManager = SettingsManager.inMemory();
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir: contractRoot,
					settingsManager,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				});
				await resourceLoader.reload();
				const contextMetrics = new ProviderContextMetricsAccumulator(evalCase);
				let sessionChatRequests = 0;
				const model = runtime.getModel(manifest.provider.chat.provider, manifest.provider.chat.model);
				if (!model) throw new Error("Required target model disappeared");
				const sessionRuntime = guardedRuntime({
					runtime,
					ledger,
					contextMetrics,
					publicRoot,
					forbiddenValues: collectForbiddenValues(auth),
					maxOutputTokens: manifest.provider.chat.maxOutputTokensPerRequest,
					onChatDispatch: () => {
						sessionChatRequests += 1;
						if (sessionChatRequests > evalCase.maxChatRequests) {
							throw new Error("session_chat_request_budget_exhausted");
						}
					},
				});
				const { session } = await createAgentSession({
					cwd,
					agentDir: contractRoot,
					modelRuntime: sessionRuntime,
					model,
					thinkingLevel: "max",
					toolProfile: "v2",
					workspacePolicy: {
						roots: [cwd],
						allowOutsideWorkspaceRead: false,
						allowOutsideWorkspaceWrite: false,
						followSymlinks: true,
					},
					toolsV2: {
						executionEnv,
						search: { provider: searchProvider, codeIndexProvider: codeIndex, semanticProvider },
						read: { provider: readProvider },
					},
					settingsManager,
					resourceLoader,
					sessionManager: SessionManager.inMemory(cwd),
				});
				const actualSchemaHash = schemaHash(session);
				const referenceCase = requireCase(manifest.cases, manifest.stageOrder.development[0]);
				const referenceWorkspace = join(contractRoot, manifest.repositories[referenceCase.repository].id);
				const normalizedSystemPrompt = normalizeFrozenSystemPrompt(
					session.systemPrompt,
					contractRoot,
					cwd,
					referenceWorkspace,
				);
				if (actualSchemaHash !== manifest.provider.frozenToolContract.schemaHash) {
					throw new Error("model_visible_schema_hash_changed");
				}
				if (sha256(normalizedSystemPrompt) !== manifest.provider.frozenToolContract.normalizedSystemPromptHash) {
					throw new Error("model_visible_system_prompt_hash_changed");
				}
				if (session.getActiveToolNames().join(",") !== "search,read,edit,run") {
					throw new Error("model_visible_tool_set_changed");
				}
				const traceCollector = createSanitizedToolTraceCollector(Date.now, { targetPath: evalCase.targetPath });
				const detailedCollector = createDetailedToolCollector(
					evalCase,
					cwd,
					manifest.allowedRunCommands[evalCase.id],
				);
				const faultController = createFaultController(evalCase, cwd);
				let assistantTurns = 0;
				let localUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
				let stopCategory: string | undefined;
				let pendingChatId: string | undefined;
				session.agent.shouldStopAfterTurn = ({ toolResults }) => {
					if (assistantTurns < evalCase.maxChatRequests || toolResults.length === 0) return false;
					stopCategory ??= "session_chat_request_budget_exhausted";
					return true;
				};
				const unsubscribe = session.subscribe((event) => {
					traceCollector.handle(event);
					detailedCollector.handle(event);
					faultController.handle(event);
					if (event.type === "message_start" && event.message.role === "assistant") {
						pendingChatId = ledger.snapshot().pending?.id;
					}
					if (event.type === "message_end" && event.message.role === "assistant") {
						assistantTurns += 1;
						const reservationId = pendingChatId ?? ledger.snapshot().pending?.id;
						if (!reservationId) {
							ledger.markIntegrityFailure("chat_usage_reservation_missing");
							stopCategory = "chat_usage_reservation_missing";
							return;
						}
						if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
							ledger.markPendingUsageUnknown("chat_response_usage_unknown");
							stopCategory ??= "chat_response_usage_unknown";
							return;
						}
						const usage = event.message.usage;
						const tokenValues = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
						if (
							tokenValues.some((value) => !Number.isSafeInteger(value) || value < 0) ||
							tokenValues.reduce((sum, value) => sum + value, 0) === 0
						) {
							ledger.markPendingUsageUnknown("chat_reported_usage_invalid");
							stopCategory ??= "chat_reported_usage_invalid";
							return;
						}
						const prices = manifest.provider.chat.usdPerMillionTokens;
						const computedCostUsd =
							(usage.input * prices.input +
								usage.output * prices.output +
								usage.cacheRead * prices.cacheRead +
								usage.cacheWrite * prices.cacheWrite) /
							1_000_000;
						const reportedCostUsd =
							Number.isFinite(usage.cost.total) && usage.cost.total >= 0 ? usage.cost.total : 0;
						const finalized = {
							inputTokens: usage.input,
							outputTokens: usage.output,
							cacheReadTokens: usage.cacheRead,
							cacheWriteTokens: usage.cacheWrite,
							costUsd: Math.max(computedCostUsd, reportedCostUsd),
						};
						ledger.commitChat(reservationId, finalized);
						pendingChatId = undefined;
						localUsage = {
							inputTokens: localUsage.inputTokens + finalized.inputTokens,
							outputTokens: localUsage.outputTokens + finalized.outputTokens,
							cacheReadTokens: localUsage.cacheReadTokens + finalized.cacheReadTokens,
							cacheWriteTokens: localUsage.cacheWriteTokens + finalized.cacheWriteTokens,
							costUsd: localUsage.costUsd + finalized.costUsd,
						};
					}
					if (event.type === "tool_execution_end" && event.isError) {
						const code = errorCode(event.result);
						if (code === "SEARCH_PROVIDER_FAILED" || code === "READ_PROVIDER_FAILED") {
							stopCategory = embeddingBoundaryViolation
								? "embedding_data_boundary_violation"
								: "tool_provider_unavailable";
							void session.abort();
						}
					}
				});
				const startedAt = Date.now();
				const timeout = setTimeout(() => {
					stopCategory = "session_timeout";
					void session.abort();
				}, manifest.budgets.maxSessionElapsedMs);
				try {
					prepareMutation(cwd, evalCase, verifierPath);
					try {
						await session.prompt(evalCase.prompt);
					} catch (error) {
						stopCategory ??= sessionFailureCategory(error);
					}
					const pending = ledger.snapshot().pending;
					if (pending?.kind === "chat") {
						ledger.markPendingUsageUnknown("chat_transport_usage_unknown");
						stopCategory ??= "chat_transport_usage_unknown";
					}
					const elapsedMs = Date.now() - startedAt;
					const stats = session.getSessionStats();
					const detailed = detailedCollector.snapshot();
					const sanitizedTrace = traceCollector.snapshot();
					const filesystem = gradeFilesystem(cwd, evalCase, verifierPath, faultController.wasApplied());
					const activation = activationGrade(detailed, evalCase, manifest, faultController.wasAppliedBeforeEdit());
					const activationComplete = Object.values(activation).every(Boolean);
					const filesystemComplete = Object.values(filesystem).every(Boolean);
					const context = contextMetrics.snapshot();
					const embeddingUsage = semanticProvider.getUsage();
					const budgetAfterSession = ledger.snapshot();
					const usageReconciled =
						stats.tokens.input === localUsage.inputTokens &&
						stats.tokens.output === localUsage.outputTokens &&
						stats.tokens.cacheRead === localUsage.cacheReadTokens &&
						stats.tokens.cacheWrite === localUsage.cacheWriteTokens &&
						budgetAfterSession.inputTokens - budgetAtSessionStart.inputTokens === localUsage.inputTokens &&
						budgetAfterSession.outputTokens - budgetAtSessionStart.outputTokens === localUsage.outputTokens &&
						budgetAfterSession.cacheReadTokens - budgetAtSessionStart.cacheReadTokens ===
							localUsage.cacheReadTokens &&
						budgetAfterSession.cacheWriteTokens - budgetAtSessionStart.cacheWriteTokens ===
							localUsage.cacheWriteTokens &&
						budgetAfterSession.chatRequests - budgetAtSessionStart.chatRequests === context.providerRequests &&
						budgetAfterSession.embeddingRequests - budgetAtSessionStart.embeddingRequests ===
							embeddingUsage.requests &&
						budgetAfterSession.embeddingTokens - budgetAtSessionStart.embeddingTokens ===
							embeddingUsage.estimatedOrReportedTokens &&
						budgetAfterSession.pending === undefined;
					if (!usageReconciled) stopCategory ??= "usage_reconciliation_failed";
					if (
						!filesystem.wrongLocationsUnchanged ||
						!filesystem.modeCorrect ||
						!filesystem.externalChangePreserved
					) {
						stopCategory ??= "filesystem_safety_violation";
					}
					const booleanScores = [...Object.values(filesystem), ...Object.values(activation), usageReconciled];
					const score = booleanScores.filter(Boolean).length / booleanScores.length;
					const record = {
						version: 1,
						phase,
						attemptId,
						caseId: evalCase.id,
						status: stopCategory ? "aborted" : "completed",
						...(stopCategory ? { stopCategory } : {}),
						contractHash: V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256,
						promptHash: evalCase.promptHash,
						schemaHash: actualSchemaHash,
						piHead: currentProduct.piHead,
						piDiffHash: currentProduct.piDiffHash,
						success: !stopCategory && filesystemComplete && activationComplete && usageReconciled,
						score,
						filesystem,
						activation,
						search: {
							semanticSearches: detailed.semanticSearches,
							structuredSearches: detailed.structuredSearches,
							approximateSearches: detailed.approximateSearches,
							partialSearches: detailed.partialSearches,
							truncatedSearches: detailed.truncatedSearches,
							firstTargetRank: detailed.firstSearchTargetRank,
							recallAt5: detailed.recallAt5,
							mrr: detailed.mrr,
							wrongCandidateReads: detailed.wrongCandidateReads,
						},
						read: {
							targetFirst: detailed.targetFirstRead,
							requiredRangeCoverage: detailed.requiredRangeCoverage,
							postEditReads: detailed.postEditReads,
						},
						edit: {
							firstSuccess: detailed.firstEditSuccess,
							recoveryCalls: detailed.recoveryCalls,
						},
						run: {
							verifierRuns: detailed.verifierRuns,
							verifierSucceeded: detailed.verifierRunSucceeded,
							exitCode: detailed.verifierExitCode,
							signal: detailed.verifierSignal,
							terminationReason: detailed.verifierTerminationReason,
							terminationRequested: detailed.verifierTerminationRequested,
							timedOut: detailed.verifierTimedOut,
						},
						efficiency: {
							turns: assistantTurns,
							callsByTool: detailed.callsByTool,
							duplicateExactRequests: detailed.duplicateExactRequests,
							duplicateSemanticRequests: detailed.duplicateSemanticRequests,
							repeatedSearchRequests: detailed.repeatedSearchRequests,
							repeatedReadRequests: detailed.repeatedReadRequests,
							toolReturnBytes: detailed.toolReturnBytes,
							usefulReturnBytes: detailed.usefulReturnBytes,
							irrelevantReturnBytes: detailed.irrelevantReturnBytes,
							ambiguousReturnBytes: detailed.ambiguousReturnBytes,
							providerRequests: context.providerRequests,
							providerPayloadBytes: context.providerPayloadBytes,
							activeToolResultContextBytes: context.activeToolResultContextBytes,
							usefulContextBytes: context.useful,
							duplicateContextBytes: context.duplicate,
							irrelevantContextBytes: context.irrelevant,
							ambiguousContextBytes: context.ambiguous,
							peakActiveToolResultBytes: context.peakActiveToolResultBytes,
							peakContextTokens: sanitizedTrace.peakContextTokens,
							truncationCount: sanitizedTrace.truncationCount,
							toolErrorCount: sanitizedTrace.toolErrorCount,
							elapsedMs,
							toolElapsedMs: sanitizedTrace.toolElapsedMs,
							modelAndHostElapsedMs: Math.max(0, elapsedMs - sanitizedTrace.toolElapsedMs),
						},
						usage: {
							...localUsage,
							embeddingRequests: embeddingUsage.requests,
							embeddingTokens: embeddingUsage.estimatedOrReportedTokens,
							embeddingCostUsd: embeddingUsage.estimatedCostUsd,
							knownCostUsd: localUsage.costUsd + embeddingUsage.estimatedCostUsd,
							usageReconciled,
						},
						trace: detailed.calls,
					};
					assertContentFreeRecord(record);
					writeOnce(sessionRecordPath(contractRoot, attemptId), record, contractRoot);
					records.push(record);
					console.log(JSON.stringify({ eval: "v2-bounded-real-record", ...record }));
					if (stopCategory) systemicStop = stopCategory;
				} finally {
					clearTimeout(timeout);
					unsubscribe();
					session.dispose();
					await semanticProvider.close();
					await codeIndex.close();
					await searchProvider.close();
					await baseEnv.cleanup();
					restoreClone(cwd);
				}
			}
			const summary = {
				version: 1,
				phase,
				attempted: records.length,
				completed: records.filter((record) => isRecord(record) && record.status === "completed").length,
				successes: records.filter((record) => isRecord(record) && record.success === true).length,
				...(systemicStop ? { stopCategory: systemicStop } : {}),
				budget: ledger.snapshot(),
			};
			assertContentFreeRecord(summary);
			writeOnce(nextSummaryPath(contractRoot, phase, ledger.snapshot().sessionsStarted), summary, contractRoot);
			console.log(JSON.stringify({ eval: "v2-bounded-real-summary", ...summary }));
			expect(systemicStop).toBeUndefined();
			expect(records).toHaveLength(cases.length);
		},
	);
});
