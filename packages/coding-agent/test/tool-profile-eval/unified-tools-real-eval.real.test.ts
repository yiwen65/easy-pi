import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import {
	createEvalCases,
	createEvalSession,
	EVAL_BASELINE,
	EVAL_LIMITS,
	EVAL_MODEL,
	EVAL_ORDER,
	EvalBudget,
	gradeFixture,
	materialize,
	saveContentFree,
	sessionContract,
	verifyFixture,
} from "./unified-tools-real-eval.ts";
import { assertProviderContextBoundary, sha256, stableHash } from "./v2-bounded-real-eval.ts";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1" && process.env.PI_REAL_UNIFIED_TOOLS === "1";
const PREFLIGHT = process.env.PI_UNIFIED_EVAL_PREFLIGHT === "1";
const PI_ROOT = resolve(import.meta.dirname, "../../../..");
const SOURCE_NAMES = [
	"unified-tools-real-eval.ts",
	"unified-tools-real-eval.test.ts",
	"unified-tools-real-eval.real.test.ts",
];
const ALLOWED_REFERENCE_LINES = [
	`- Main documentation: ${PI_ROOT}/packages/coding-agent/README.md`,
	`- Additional docs: ${PI_ROOT}/packages/coding-agent/docs`,
	`- Examples: ${PI_ROOT}/packages/coding-agent/examples (extensions, custom tools, SDK)`,
];
const STOP_CODES = new Set([
	"time_budget",
	"request_budget",
	"token_budget",
	"cost_budget",
	"session_request_cap",
	"usage_unreconciled",
	"usage_unknown",
	"reservation_exceeded",
	"session_timeout",
	"workspace_boundary",
	"protected_verifier",
	"payload_contract",
	"provider_failure",
]);

function category(error: unknown): string {
	return error instanceof Error && STOP_CODES.has(error.message) ? error.message : "infrastructure_failure";
}

function sourceContract() {
	if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: PI_ROOT, encoding: "utf8" }).trim() !== EVAL_BASELINE)
		throw new Error("baseline_changed");
	if (
		execFileSync(
			"git",
			["diff", "--name-only", "HEAD", "--", "packages/agent/src", "packages/coding-agent/src", "packages/ai/src"],
			{ cwd: PI_ROOT, encoding: "utf8" },
		).trim()
	)
		throw new Error("product_changed");
	return {
		baseline: EVAL_BASELINE,
		implementationHashes: SOURCE_NAMES.map((name) => sha256(readFileSync(join(import.meta.dirname, name)))),
		casesHash: stableHash(createEvalCases()),
		orderHash: stableHash(EVAL_ORDER),
		limitsHash: stableHash(EVAL_LIMITS),
	};
}

interface ToolRecord {
	ordinal: number;
	request: number;
	name: string;
	isError: boolean;
	code: string;
	bytes: number;
	exitCode?: number | null;
	terminationReason?: string | null;
	timedOut?: boolean;
	verification: boolean;
	mutation: boolean;
}

interface AttemptRecord {
	attemptId: string;
	caseId: string;
	profile: string;
	status: string;
	stopCategory: string | null;
	passed: boolean;
	filesystemPassed: boolean;
	independentCheckPassed: boolean;
	modelVerificationObserved: boolean;
	failureRecoveryObserved: boolean;
	requests: number;
	payloadsWithMax: number;
	payloadBytes: number;
	toolCalls: number;
	toolErrors: number;
	toolResultBytes: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	elapsedMs: number;
	modelElapsedMs: number;
	schemaHash: string;
	systemPromptHash: string;
	tools: ToolRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function forbiddenValues(auth: unknown): string[] {
	const values = Object.entries(process.env).flatMap(([key, value]) =>
		value && /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key) && value.length >= 16 ? [value] : [],
	);
	const visit = (value: unknown): void => {
		if (typeof value === "string" && value.length >= 16) values.push(value);
		else if (isRecord(value)) for (const item of Object.values(value)) visit(item);
	};
	visit(auth);
	return values;
}

describe.skipIf(!RUN && !PREFLIGHT)("new unified tools bounded provider evaluation", () => {
	it(
		"freezes without generation or executes exactly one sealed paired matrix",
		{ timeout: EVAL_LIMITS.elapsedMs + 60_000 },
		async () => {
			if (RUN && PREFLIGHT) throw new Error("conflicting_modes");
			const requestedRoot = process.env.PI_UNIFIED_EVAL_DIR;
			if (!requestedRoot || !/^\/tmp\/pi-unified-real-eval-[A-Za-z0-9]+$/.test(requestedRoot))
				throw new Error("explicit_temporary_root_required");
			const root = realpathSync(requestedRoot);
			const startedAtMs = Number(readFileSync(join(root, "started-at-ms.txt"), "utf8").trim());
			const budget = new EvalBudget(startedAtMs, (state) => saveContentFree(join(root, "budget.json"), state));
			budget.assertTime();
			const contract = sourceContract();
			const previousMode = process.env.PI_HF_COMPACTION;
			process.env.PI_HF_COMPACTION = "off";
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.create(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const model = runtime.getModel(EVAL_MODEL.provider, EVAL_MODEL.id);
			if (!model || model.thinkingLevelMap?.max !== "max" || !runtime.hasConfiguredAuth(model.provider))
				throw new Error("model_auth_or_max_unavailable");
			// Codex does not forward maxTokens: reserve the entire catalog capacity, not an unenforced output option.
			const reservedTokens = model.contextWindow + model.maxTokens;
			const priceRows = [model.cost, ...(model.cost.tiers ?? [])];
			const inputPrice = Math.max(...priceRows.flatMap((row) => [row.input, row.cacheRead, row.cacheWrite]));
			const outputPrice = Math.max(...priceRows.map((row) => row.output));
			const reservedCostUsd = (model.contextWindow * inputPrice + model.maxTokens * outputPrice) / 1_000_000;
			const metadata = { ...contract, modelHash: stableHash(model), reservedTokens, reservedCostUsd };
			const contracts: Record<string, { schemaHash: string; systemPromptHash: string }> = {};
			const records: AttemptRecord[] = [];
			let stopCategory: string | undefined;
			try {
				if (PREFLIGHT) {
					if (existsSync(join(root, "run-started.json"))) throw new Error("attempt_already_started");
					for (const slot of EVAL_ORDER) {
						const entry = createEvalCases().find((item) => item.id === slot.caseId)!;
						const cwd = join(root, slot.attemptId);
						materialize(cwd, entry.initial);
						const host = await createEvalSession({
							cwd,
							agentDir: join(root, "agent"),
							entry,
							profile: slot.profile,
							runtime,
						});
						try {
							assertProviderContextBoundary(
								{
									systemPrompt: host.session.systemPrompt,
									tools: host.session.agent.state.tools.map(({ name, description, parameters }) => ({
										name,
										description,
										parameters,
									})),
								},
								{
									publicRoot: root,
									forbiddenRoots: [PI_ROOT],
									forbiddenValues: [],
									allowedForbiddenRootLines: ALLOWED_REFERENCE_LINES,
								},
							);
							contracts[slot.attemptId] = sessionContract(host.session, cwd, join(root, "agent"));
						} finally {
							await host.close();
							rmSync(cwd, { recursive: true, force: true });
						}
					}
					saveContentFree(join(root, "freeze.json"), { ...metadata, contracts }, true);
					console.log(
						JSON.stringify({
							stage: "preflight",
							model: model.id,
							thinking: "max",
							configuredAuth: true,
							modelRequests: 0,
							frozenSessions: EVAL_ORDER.length,
							reservedTokens,
							reservedCostUsd,
						}),
					);
					return;
				}
				const frozen = JSON.parse(readFileSync(join(root, "freeze.json"), "utf8")) as typeof metadata & {
					contracts: typeof contracts;
				};
				const { contracts: frozenContracts, ...frozenMetadata } = frozen;
				if (stableHash(frozenMetadata) !== stableHash(metadata)) throw new Error("frozen_contract_changed");
				saveContentFree(
					join(root, "run-started.json"),
					{ startedAtMs: Date.now(), contractHash: stableHash(frozen) },
					true,
				);
				configureHttpDispatcher();
				const auth = await runtime.getAuth(model);
				if (!auth) throw new Error("auth_unavailable");
				const secrets = forbiddenValues(auth);
				for (const slot of EVAL_ORDER) {
					if (stopCategory || budget.state.stop) break;
					budget.startAttempt(slot.attemptId);
					const before = structuredClone(budget.state);
					const entry = createEvalCases().find((item) => item.id === slot.caseId)!;
					const cwd = join(root, slot.attemptId);
					materialize(cwd, entry.initial);
					saveContentFree(
						join(root, `${slot.attemptId}-started.json`),
						{ attemptId: slot.attemptId, startedAtMs: Date.now() },
						true,
					);
					let requests = 0;
					let payloadsWithMax = 0;
					let payloadBytes = 0;
					let requestStartedAt = 0;
					let modelElapsedMs = 0;
					let localStop: string | undefined;
					let emittedToolCalls = 0;
					const toolArgs = new Map<string, { command?: unknown; cwd?: unknown }>();
					const tools: ToolRecord[] = [];
					const guardedRuntime = new Proxy(runtime, {
						get(target, property) {
							if (property === "streamSimple")
								return (...args: Parameters<ModelRuntime["streamSimple"]>) => {
									try {
										if (requests >= EVAL_LIMITS.sessionRequests) throw new Error("session_request_cap");
										if (
											args[0].id !== model.id ||
											args[0].provider !== model.provider ||
											args[2]?.reasoning !== "max"
										)
											throw new Error("payload_contract");
										assertProviderContextBoundary(args[1], {
											publicRoot: root,
											forbiddenRoots: [PI_ROOT],
											forbiddenValues: secrets,
											allowedForbiddenRootLines: ALLOWED_REFERENCE_LINES,
										});
										budget.reserve(reservedTokens, reservedCostUsd);
										requests += 1;
										requestStartedAt = Date.now();
										let payloadSeen = false;
										return target.streamSimple(args[0], args[1], {
											...args[2],
											transport: "sse",
											maxRetries: 0,
											onPayload: async (payload, targetModel) => {
												const transformed = (await args[2]?.onPayload?.(payload, targetModel)) ?? payload;
												if (
													payloadSeen ||
													!isRecord(transformed) ||
													transformed.model !== model.id ||
													!isRecord(transformed.reasoning) ||
													transformed.reasoning.effort !== "max"
												)
													throw new Error("payload_contract");
												assertProviderContextBoundary(transformed, {
													publicRoot: root,
													forbiddenRoots: [PI_ROOT],
													forbiddenValues: secrets,
													allowedForbiddenRootLines: ALLOWED_REFERENCE_LINES,
												});
												budget.assertTime();
												payloadSeen = true;
												payloadsWithMax += 1;
												payloadBytes += Buffer.byteLength(JSON.stringify(transformed));
												return transformed;
											},
										});
									} catch (error) {
										localStop = category(error);
										budget.stop(localStop);
										throw new Error(localStop);
									}
								};
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					}) as ModelRuntime;
					const host = await createEvalSession({
						cwd,
						agentDir: join(root, "agent"),
						entry,
						profile: slot.profile,
						runtime: guardedRuntime,
					});
					const actualContract = sessionContract(host.session, cwd, join(root, "agent"));
					if (stableHash(actualContract) !== stableHash(frozenContracts[slot.attemptId]))
						throw new Error("session_contract_changed");
					const priorHook = host.session.agent.beforeToolCall;
					host.session.agent.beforeToolCall = async (context, signal) => {
						try {
							return await priorHook?.(context, signal);
						} catch (error) {
							localStop = category(error);
							budget.stop(localStop);
							return { block: true, reason: "Evaluation workspace boundary violation.", terminate: true };
						}
					};
					host.session.agent.shouldStopAfterTurn = ({ toolResults }) => {
						if (budget.state.stop || localStop) return true;
						if (requests >= EVAL_LIMITS.sessionRequests && toolResults.length > 0) {
							localStop = "session_request_cap";
							return true;
						}
						return false;
					};
					const unsubscribe = host.session.subscribe((event) => {
						if (event.type !== "message_end") return;
						if (event.message.role === "assistant") {
							if (requestStartedAt) {
								modelElapsedMs += Date.now() - requestStartedAt;
								requestStartedAt = 0;
							}
							for (const part of event.message.content)
								if (part.type === "toolCall") {
									emittedToolCalls += 1;
									toolArgs.set(part.id, part.arguments);
								}
							if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
								localStop ??= "provider_failure";
								budget.stop("usage_unknown");
								return;
							}
							try {
								budget.commit(event.message.usage);
							} catch (error) {
								localStop = category(error);
							}
						} else if (event.message.role === "toolResult") {
							const message = event.message;
							const details = isRecord(message.details) ? message.details : {};
							const args = toolArgs.get(message.toolCallId);
							const verification =
								message.toolName === "bash" &&
								args?.command === entry.verifyCommand &&
								resolve(cwd, typeof args?.cwd === "string" ? args.cwd : ".") === resolve(cwd, entry.verifyCwd);
							const knownCodes = [
								"NONZERO_EXIT",
								"TIMEOUT",
								"ABORTED",
								"SIGNAL",
								"UNKNOWN_TERMINATION",
								"PREIMAGE_MISMATCH",
								"INVALID_INPUT",
								"READ_PROVIDER_FAILED",
								"SEARCH_PROVIDER_FAILED",
							];
							tools.push({
								ordinal: tools.length + 1,
								request: requests,
								name: message.toolName,
								isError: message.isError,
								code:
									typeof details.code === "string" && knownCodes.includes(details.code)
										? details.code
										: message.isError
											? "TOOL_ERROR"
											: "OK",
								bytes: Buffer.byteLength(JSON.stringify(message.content)),
								verification,
								mutation:
									["edit", "write"].includes(message.toolName) &&
									!message.isError &&
									(slot.profile === "legacy" || details.status === "applied"),
								...(message.toolName === "bash"
									? {
											exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
											terminationReason: ["exit", "signal", "timeout", "aborted"].includes(
												String(details.terminationReason),
											)
												? String(details.terminationReason)
												: null,
											timedOut: details.timedOut === true,
										}
									: {}),
							});
							if (["READ_PROVIDER_FAILED", "SEARCH_PROVIDER_FAILED"].includes(String(details.code))) {
								localStop = "infrastructure_failure";
								budget.stop(localStop);
							}
						}
					});
					const startedAt = Date.now();
					const deadline = Math.min(
						EVAL_LIMITS.sessionElapsedMs,
						EVAL_LIMITS.elapsedMs - (startedAt - startedAtMs),
					);
					const timeout = setTimeout(
						() => {
							localStop = "session_timeout";
							budget.stop(localStop);
							void host.session.abort();
						},
						Math.max(1, deadline),
					);
					try {
						const instructions = `${entry.prompt}\n\nEvaluation environment: only this synthetic workspace is available. Shell commands allowed verbatim: ${entry.commands.join("; ")}. Do not change check.cjs files. Use file tools for changes. Do not access network, environment variables, or outside paths. Return a brief completion summary.`;
						try {
							await host.session.prompt(instructions);
						} catch (error) {
							localStop ??= category(error);
							budget.stop(localStop);
						}
						if (budget.state.pending) {
							budget.stop("usage_unknown");
							localStop ??= "usage_unknown";
						}
						const filesystemPassed = gradeFixture(cwd, entry);
						const independentCheckPassed = verifyFixture(cwd, entry);
						const successfulCheck = [...tools]
							.reverse()
							.find((tool) => tool.verification && !tool.isError && tool.exitCode === 0);
						const lastMutation = [...tools].reverse().find((tool) => tool.mutation);
						const modelVerificationObserved =
							!!successfulCheck && (!lastMutation || successfulCheck.ordinal > lastMutation.ordinal);
						const failedCheck = tools.find(
							(tool) =>
								tool.verification &&
								tool.isError &&
								tool.exitCode !== null &&
								tool.exitCode !== undefined &&
								tool.exitCode !== 0,
						);
						const recovery =
							!!failedCheck &&
							!!successfulCheck &&
							tools.some(
								(tool) =>
									tool.mutation &&
									tool.ordinal > failedCheck.ordinal &&
									tool.ordinal < successfulCheck.ordinal,
							);
						const passed =
							filesystemPassed &&
							independentCheckPassed &&
							modelVerificationObserved &&
							(!entry.requireFailureRecovery || recovery) &&
							!budget.state.stop;
						const record: AttemptRecord = {
							...slot,
							...actualContract,
							status: passed ? "passed" : (localStop ?? "task_failed"),
							stopCategory: localStop ?? null,
							passed,
							filesystemPassed,
							independentCheckPassed,
							modelVerificationObserved,
							failureRecoveryObserved: recovery,
							requests,
							payloadsWithMax,
							payloadBytes,
							toolCalls: emittedToolCalls,
							toolErrors: tools.filter((tool) => tool.isError).length,
							toolResultBytes: tools.reduce((sum, tool) => sum + tool.bytes, 0),
							inputTokens: budget.state.inputTokens - before.inputTokens,
							outputTokens: budget.state.outputTokens - before.outputTokens,
							cacheReadTokens: budget.state.cacheReadTokens - before.cacheReadTokens,
							cacheWriteTokens: budget.state.cacheWriteTokens - before.cacheWriteTokens,
							costUsd: budget.state.costUsd - before.costUsd,
							elapsedMs: Date.now() - startedAt,
							modelElapsedMs,
							tools,
						};
						saveContentFree(join(root, `${slot.attemptId}.json`), record, true);
						records.push(record);
						console.log(
							JSON.stringify({
								attemptId: slot.attemptId,
								status: record.status,
								requests,
								toolCalls: emittedToolCalls,
								toolErrors: record.toolErrors,
								costUsd: record.costUsd,
							}),
						);
					} finally {
						clearTimeout(timeout);
						unsubscribe();
						await host.close();
					}
					stopCategory = budget.state.stop;
				}
			} catch (error) {
				stopCategory = category(error);
				if (!PREFLIGHT) budget.stop(stopCategory);
			} finally {
				if (previousMode === undefined) delete process.env.PI_HF_COMPACTION;
				else process.env.PI_HF_COMPACTION = previousMode;
				if (RUN) {
					mkdirSync(root, { recursive: true });
					saveContentFree(
						join(root, "results.json"),
						{
							version: 1,
							...metadata,
							provider: EVAL_MODEL.provider,
							model: EVAL_MODEL.id,
							thinking: "max",
							status: !stopCategory && records.length === EVAL_ORDER.length ? "completed" : "partial",
							stopCategory: stopCategory ?? null,
							budget: budget.state,
							records,
							missingAttempts: EVAL_ORDER.filter(
								(slot) => !records.some((record) => record.attemptId === slot.attemptId),
							).map((slot) => slot.attemptId),
						},
						true,
					);
				}
			}
			expect(stopCategory, "evaluation infrastructure must not silently pass").toBeUndefined();
			expect(records).toHaveLength(EVAL_ORDER.length);
		},
	);
});
