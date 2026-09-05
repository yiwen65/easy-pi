import { execFileSync } from "node:child_process";
import {
	constants,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	createReadV2Tool,
	type ExecutionEnv,
	ExecutionError,
	err,
	type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, Context, Tool } from "@earendil-works/pi-ai/compat";
import { NodeExecutionEnv as DirectNodeEnv } from "../../../../agent/src/harness/env/nodejs.ts";
import { createReadV2Tool as directRead } from "../../../../agent/src/harness/tools/read-v2.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../../../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession, type ToolDefinition } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createBashToolDefinition } from "../../../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../../../src/core/tools/edit.ts";
import { FffSearchProvider } from "../../../src/core/tools/fff-search-provider.ts";
import { NodeReadProviderV2 } from "../../../src/core/tools/node-read-provider-v2.ts";
import { TypeScriptCodeIndexProvider } from "../../../src/core/tools/typescript-code-index-provider.ts";
import { createWriteToolDefinition } from "../../../src/core/tools/write.ts";
import { assertFixturePath, assertToolBoundary, safeEnvironment } from "../unified-tools-real-eval.ts";
import { assertProviderContextBoundary, sha256, stableHash } from "../v2-bounded-real-eval.ts";
import {
	applyExternalChange,
	attemptId,
	collateralUnchanged,
	DEV_IDS,
	type Fixture,
	fixture,
	materialize,
	PROBE_IDS,
	targetCorrect,
	VALIDATION_IDS,
	VALIDATION_ORDER,
	validAttempt,
	verify,
} from "./fixtures.ts";
import {
	assistantMetrics,
	BASELINE,
	Budget,
	bytes,
	contentFreeWrite,
	LIMITS,
	object,
	type PayloadMeasurement,
	PayloadMeter,
	unionDuration,
	type Variant,
} from "./metrics.ts";

export const PI_ROOT = resolve(import.meta.dirname, "../../../../..");
export const MODEL = { provider: "openai-codex", id: "gpt-5.6-luna" } as const;
const TOOL_NAMES = {
	A: ["read", "bash", "edit", "write"],
	B: ["search", "read", "edit", "bash"],
	C: ["search", "read", "edit", "bash"],
} as const;
const IMPLEMENTATION_FILES = [
	"metrics.ts",
	"fixtures.ts",
	"runner.ts",
	"metrics.test.ts",
	"runner.test.ts",
	"real.test.ts",
	"../unified-tools-real-eval.ts",
	"../v2-bounded-real-eval.ts",
];
const STOP_CODES = new Set([
	"time_budget",
	"request_budget",
	"token_budget",
	"cost_budget",
	"unreconciled_usage",
	"usage_unknown",
	"reservation_exceeded",
	"payload_contract",
	"workspace_boundary",
	"protected_verifier",
	"session_timeout",
	"provider_failure",
	"source_changed",
	"freeze_changed",
	"attempt_forbidden",
]);
export function stopCode(error: unknown): string {
	return error instanceof Error && STOP_CODES.has(error.message) ? error.message : "infrastructure_failure";
}

export function sourceIdentity() {
	if (createReadV2Tool !== directRead || NodeExecutionEnv !== DirectNodeEnv)
		throw new Error("mixed_workspace_aliases");
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PI_ROOT, encoding: "utf8" }).trim();
	const paths = execFileSync(
		"git",
		[
			"ls-files",
			"-z",
			"packages/agent/src",
			"packages/ai/src",
			"packages/coding-agent/src",
			"packages/client/src",
			"packages/protocol/src",
			"packages/tui/src",
			"packages/telemetry/src",
			"vitest.base.ts",
			"packages/coding-agent/vitest.config.ts",
			"package-lock.json",
		],
		{ cwd: PI_ROOT, encoding: "utf8" },
	)
		.split("\0")
		.filter(Boolean)
		.sort();
	return {
		revision,
		productHash: stableHash(paths.map((path) => [path, sha256(readFileSync(join(PI_ROOT, path)))])),
		catalogHash: stableHash(
			readdirSync(join(PI_ROOT, "packages/ai/src/providers/data"))
				.sort()
				.map((name) => [name, sha256(readFileSync(join(PI_ROOT, "packages/ai/src/providers/data", name)))]),
		),
		runnerHash: stableHash(
			IMPLEMENTATION_FILES.map((name) => [name, sha256(readFileSync(join(import.meta.dirname, name)))]),
		),
		fixtureHash: stableHash([...DEV_IDS, ...VALIDATION_IDS].map(fixture)),
		allocationHash: stableHash({ PROBE_IDS, DEV_IDS, VALIDATION_ORDER, LIMITS }),
		readFunctionHash: sha256(createReadV2Tool.toString()),
		nodeFunctionHash: sha256(NodeExecutionEnv.toString()),
	};
}

/** Only installation reference paths are normalized; production guidance and task cwd remain intact. */
export function normalizeSystem(value: string): string {
	return value
		.replaceAll(`${PI_ROOT}/packages/coding-agent/README.md`, "/reference/pi/README.md")
		.replaceAll(`${PI_ROOT}/packages/coding-agent/docs`, "/reference/pi/docs")
		.replaceAll(`${PI_ROOT}/packages/coding-agent/examples`, "/reference/pi/examples");
}
export function checkedCommand(cwd: string, data: Fixture, command: string, commandCwd: string): string {
	assertFixturePath(cwd, commandCwd);
	if (resolve(commandCwd) !== cwd || !data.commands.includes(command.trim())) throw new Error("restricted_command");
	if (readFileSync(join(cwd, "check.cjs"), "utf8") !== data.initial["check.cjs"])
		throw new Error("protected_verifier");
	if (command.trim() === "node check.cjs") return `${JSON.stringify(process.execPath)} check.cjs`;
	if (command.trim() === "find . -type f") return "/usr/bin/find . -type f";
	if (command.trim() === "grep -R -n leaseWindowTicks src") return "/usr/bin/grep -R -n leaseWindowTicks src";
	throw new Error("restricted_command");
}

export class FixtureMonitor {
	faultApplied = false;
	unsafeWriteEvents = 0;
	collateralWriteEvents = 0;
	private readonly cwd: string;
	private readonly data: Fixture;
	constructor(cwd: string, data: Fixture) {
		this.cwd = cwd;
		this.data = data;
	}
	after(name: string, args: unknown, details: unknown, isError: boolean): boolean {
		const path = object(details)?.path ?? object(args)?.path;
		let injected = false;
		if (
			!this.faultApplied &&
			this.data.external &&
			name === "read" &&
			!isError &&
			typeof path === "string" &&
			resolve(this.cwd, path) === join(this.cwd, this.data.target)
		) {
			applyExternalChange(this.cwd, this.data);
			this.faultApplied = true;
			injected = true;
		}
		return injected;
	}
	observeWrites(): void {
		if (!collateralUnchanged(this.cwd, this.data)) this.collateralWriteEvents += 1;
		if (this.faultApplied && !targetCorrect(this.cwd, this.data, true)) this.unsafeWriteEvents += 1;
	}
}

export async function createHost(
	cwd: string,
	agentDir: string,
	data: Fixture,
	variant: Variant,
	runtime: ModelRuntime,
	monitor?: FixtureMonitor,
) {
	if (realpathSync(cwd) !== cwd) throw new Error("noncanonical_workspace");
	const model = runtime.getModel(MODEL.provider, MODEL.id);
	if (!model || model.thinkingLevelMap?.max !== "max") throw new Error("model_max_unavailable");
	const base = new NodeExecutionEnv({ cwd });
	const restricted = new Proxy(base, {
		get(target, property) {
			if (property === "writeFile")
				return async (...args: Parameters<NodeExecutionEnv["writeFile"]>) => {
					const result = await target.writeFile(...args);
					monitor?.observeWrites();
					return result;
				};
			if (property === "renameFile")
				return async (...args: Parameters<NodeExecutionEnv["renameFile"]>) => {
					const result = await target.renameFile(...args);
					monitor?.observeWrites();
					return result;
				};
			if (property === "remove")
				return async (...args: Parameters<NodeExecutionEnv["remove"]>) => {
					const result = await target.remove(...args);
					monitor?.observeWrites();
					return result;
				};
			if (property === "exec")
				return (command: string, options?: ShellExecOptions) => {
					try {
						return target.exec(checkedCommand(cwd, data, command, options?.cwd ?? cwd), {
							...options,
							inheritEnv: false,
							env: safeEnvironment(cwd),
						});
					} catch {
						return Promise.resolve(
							err(
								new ExecutionError(
									"spawn_error",
									"Only the listed commands in the synthetic workspace are permitted.",
								),
							),
						);
					}
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExecutionEnv;
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false, maxRetries: 0 },
		transport: "sse",
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const search = new FffSearchProvider(base);
	const code = new TypeScriptCodeIndexProvider();
	const observedWrite = async (path: string, value: string): Promise<void> => {
		await writeFile(path, value, "utf-8");
		monitor?.observeWrites();
	};
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime: runtime,
		thinkingLevel: "max",
		toolProfile: variant === "A" ? "legacy" : "v2",
		tools: [...TOOL_NAMES[variant]],
		customTools:
			variant === "A"
				? [
						createBashToolDefinition(cwd, {
							spawnHook: ({ command, cwd: commandCwd }) => ({
								command: checkedCommand(cwd, data, command, commandCwd),
								cwd: commandCwd,
								env: safeEnvironment(cwd),
							}),
						}) as ToolDefinition,
						createEditToolDefinition(cwd, {
							operations: {
								readFile,
								writeFile: observedWrite,
								access: (path) => access(path, constants.R_OK | constants.W_OK),
							},
						}) as ToolDefinition,
						createWriteToolDefinition(cwd, {
							operations: {
								writeFile: observedWrite,
								mkdir: async (path) => {
									await mkdir(path, { recursive: true });
								},
							},
						}) as ToolDefinition,
					]
				: undefined,
		workspacePolicy: {
			roots: [cwd],
			allowOutsideWorkspaceRead: false,
			allowOutsideWorkspaceWrite: false,
			followSymlinks: false,
		},
		toolsV2: {
			executionEnv: restricted,
			search: { provider: search, codeIndexProvider: code },
			read: { provider: new NodeReadProviderV2(base) },
		},
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
	});
	if (
		stableHash(session.getActiveToolNames().sort()) !== stableHash([...TOOL_NAMES[variant]].sort()) ||
		session.hfCompactionHost !== undefined
	)
		throw new Error("session_contract");
	const upstream = session.agent.beforeToolCall;
	session.agent.beforeToolCall = async (context, signal) => {
		assertToolBoundary(cwd, context.args);
		if (["edit", "write"].includes(context.toolCall.name) && JSON.stringify(context.args).includes("check.cjs"))
			throw new Error("protected_verifier");
		return upstream?.(context, signal);
	};
	return {
		session,
		close: async () => {
			session.dispose();
			await search.close();
			await code.close();
			await base.cleanup();
		},
	};
}
export function protocol(host: Awaited<ReturnType<typeof createHost>>) {
	return {
		systemPrompt: normalizeSystem(host.session.systemPrompt),
		tools: host.session.agent.state.tools.map(({ name, description, parameters, constrainedSampling }) => ({
			name,
			description,
			parameters,
			constrainedSampling,
		})),
	};
}
type Protocol = ReturnType<typeof protocol>;
interface Freeze {
	identity: ReturnType<typeof sourceIdentity>;
	clock: number;
	modelHash: string;
	reservedTokens: number;
	reservedCostUsd: number;
	protocolHashes: Record<string, string>;
	iteration: number;
}
function loadFreeze(root: string, tag: string): Freeze {
	return JSON.parse(readFileSync(join(root, `freeze-${tag}.json`), "utf8")) as Freeze;
}
function readProtocol(root: string, tag: string, frozen: Freeze): Protocol {
	const value = JSON.parse(readFileSync(join(root, `protocol-${tag}.json`), "utf8")) as Protocol;
	if (stableHash(value) !== frozen.protocolHashes[tag]) throw new Error("freeze_changed");
	return value;
}
function assertFreeze(
	current: ReturnType<typeof sourceIdentity>,
	frozen: Freeze,
	modelHash: string,
	clock: number,
): void {
	if (stableHash(current) !== stableHash(frozen.identity) || modelHash !== frozen.modelHash || clock !== frozen.clock)
		throw new Error("freeze_changed");
}
function forbiddenValues(auth: unknown): string[] {
	const values = Object.entries(process.env).flatMap(([key, value]) =>
		value && /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key) && value.length >= 16 ? [value] : [],
	);
	const visit = (value: unknown): void => {
		if (typeof value === "string" && value.length >= 16) values.push(value);
		else if (object(value)) for (const item of Object.values(object(value)!)) visit(item);
	};
	visit(auth);
	return values;
}
interface RequestRecord {
	ordinal: number;
	globalOrdinal: number;
	payload?: PayloadMeasurement;
	maxConfirmed: boolean;
	elapsedMs: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	generated?: ReturnType<typeof assistantMetrics>;
}
class RequestMeter {
	readonly records: RequestRecord[] = [];
	readonly runtime: ModelRuntime;
	private started = 0;
	private readonly budget: Budget;
	private readonly root: string;
	private readonly id: string;
	constructor(
		runtime: ModelRuntime,
		budget: Budget,
		root: string,
		id: string,
		frozen: Freeze,
		cap: number,
		secrets: string[],
	) {
		this.budget = budget;
		this.root = root;
		this.id = id;
		const payloadMeter = new PayloadMeter();
		this.runtime = new Proxy(runtime, {
			get: (target, property) => {
				if (property === "streamSimple")
					return (...args: Parameters<ModelRuntime["streamSimple"]>) => {
						try {
							if (this.records.length >= cap) throw new Error("attempt_forbidden");
							if (args[0].id !== MODEL.id || args[0].provider !== MODEL.provider || args[2]?.reasoning !== "max")
								throw new Error("payload_contract");
							const context = { ...args[1], systemPrompt: normalizeSystem(args[1].systemPrompt ?? "") };
							const boundary = {
								publicRoot: root,
								forbiddenRoots: [PI_ROOT, "/Users/"],
								forbiddenValues: secrets,
							};
							assertProviderContextBoundary(context, boundary);
							const globalOrdinal = budget.reserve(frozen.reservedTokens, frozen.reservedCostUsd);
							const record: RequestRecord = {
								ordinal: this.records.length + 1,
								globalOrdinal,
								maxConfirmed: false,
								elapsedMs: 0,
							};
							this.records.push(record);
							this.started = Date.now();
							return target.streamSimple(args[0], context, {
								...args[2],
								transport: "sse",
								maxRetries: 0,
								onPayload: async (payload, model) => {
									const transformed = (await args[2]?.onPayload?.(payload, model)) ?? payload;
									const body = object(transformed);
									if (record.payload || body?.model !== MODEL.id || object(body.reasoning)?.effort !== "max")
										throw new Error("payload_contract");
									assertProviderContextBoundary(transformed, boundary);
									budget.assertTime();
									record.payload = payloadMeter.observe(transformed);
									record.maxConfirmed = true;
									return transformed;
								},
							});
						} catch (error) {
							budget.stop(stopCode(error));
							throw new Error(stopCode(error));
						}
					};
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as ModelRuntime;
	}
	finish(message: AssistantMessage): void {
		const record = this.records[this.records.length - 1];
		if (!record || record.generated) {
			this.budget.stop("payload_contract");
			return;
		}
		record.elapsedMs = Date.now() - this.started;
		record.generated = assistantMetrics(message);
		try {
			this.budget.commit(message.usage);
			Object.assign(record, {
				inputTokens: message.usage.input,
				outputTokens: message.usage.output,
				cacheReadTokens: message.usage.cacheRead,
				cacheWriteTokens: message.usage.cacheWrite,
				costUsd: message.usage.cost.total,
			});
			if (!record.maxConfirmed) this.budget.stop("payload_contract");
			if (["error", "aborted"].includes(message.stopReason)) this.budget.stop("provider_failure");
		} catch (error) {
			this.budget.stop(stopCode(error));
		}
		contentFreeWrite(join(this.root, `${this.id}-request-${record.ordinal}.json`), record, true);
	}
}

export async function freezeRun(
	root: string,
	tag: "AB" | "C1" | "C2",
	runtime: ModelRuntime,
	clock: number,
): Promise<void> {
	const identity = sourceIdentity();
	if (tag === "AB" && identity.revision !== BASELINE) throw new Error("source_changed");
	const model = runtime.getModel(MODEL.provider, MODEL.id);
	if (!model || model.thinkingLevelMap?.max !== "max" || !runtime.hasConfiguredAuth(model.provider))
		throw new Error("model_auth_or_max_unavailable");
	const priceRows = [model.cost, ...(model.cost.tiers ?? [])];
	const reservedTokens = model.contextWindow + model.maxTokens;
	const reservedCostUsd =
		(model.contextWindow * Math.max(...priceRows.flatMap((row) => [row.input, row.cacheRead, row.cacheWrite])) +
			model.maxTokens * Math.max(...priceRows.map((row) => row.output))) /
		1_000_000;
	if (
		tag === "AB" &&
		execFileSync("git", ["diff", "--name-only", "HEAD", "--", "packages"], { cwd: PI_ROOT, encoding: "utf8" }).trim()
	)
		throw new Error("source_changed");
	if (tag !== "AB") {
		const base = loadFreeze(root, "AB");
		if (
			base.identity.runnerHash !== identity.runnerHash ||
			base.identity.fixtureHash !== identity.fixtureHash ||
			base.identity.allocationHash !== identity.allocationHash ||
			base.clock !== clock
		)
			throw new Error("freeze_changed");
		const ledger = new Budget(join(root, "budget.json"), clock);
		if (ledger.state.attempts.some((id) => id.startsWith("validation-"))) throw new Error("attempt_forbidden");
		for (const id of DEV_IDS)
			for (const variant of ["A", "B"] as const)
				if (!existsSync(join(root, `${attemptId("development", id, variant, 0)}.json`)))
					throw new Error("baseline_incomplete");
	}
	const protocolHashes: Record<string, string> = {};
	const cwd = join(root, "workspace");
	if (existsSync(cwd)) throw new Error("workspace_not_empty");
	materialize(cwd, fixture("D-11"));
	try {
		for (const variant of tag === "AB" ? (["A", "B"] as const) : (["C"] as const)) {
			const host = await createHost(cwd, join(root, "agent"), fixture("D-11"), variant, runtime);
			try {
				const value = protocol(host);
				assertProviderContextBoundary(value, {
					publicRoot: root,
					forbiddenRoots: [PI_ROOT, "/Users/"],
					forbiddenValues: [],
				});
				const key = variant === "C" ? tag : variant;
				protocolHashes[key] = stableHash(value);
				// Public protocol INPUT snapshots for crossed probes; never model responses, fixtures or credentials.
				writeFileSync(join(root, `protocol-${key}.json`), JSON.stringify(value), { flag: "wx", mode: 0o600 });
			} finally {
				await host.close();
			}
		}
	} finally {
		rmSync(cwd, { recursive: true });
	}
	contentFreeWrite(
		join(root, `freeze-${tag}.json`),
		{
			identity,
			clock,
			modelHash: stableHash(model),
			reservedTokens,
			reservedCostUsd,
			protocolHashes,
			iteration: tag === "AB" ? 0 : Number(tag.slice(1)),
		} satisfies Freeze,
		true,
	);
}

interface ToolRecord {
	ordinal: number;
	request: number;
	name: string;
	isError: boolean;
	code: string;
	resultBytes: number;
	argumentBytes: number;
	suppliedFields: number;
	elapsedMs: number;
	verification: boolean;
	mutation: boolean;
	faultInjected: boolean;
	knownPathDiscovery: boolean;
	exitCode: number | null;
}
export async function executeRun(
	root: string,
	mode: string,
	caseId: string,
	variant: Variant,
	iteration: number,
	runtime: ModelRuntime,
	budget: Budget,
): Promise<void> {
	const isProbe = mode === "probe";
	if (isProbe ? !(PROBE_IDS as readonly string[]).includes(caseId) : !validAttempt(mode, caseId, variant, iteration))
		throw new Error("attempt_forbidden");
	const selection =
		mode === "validation"
			? (JSON.parse(readFileSync(join(root, "candidate.json"), "utf8")) as { iteration: number; freezeHash: string })
			: undefined;
	const candidateIteration = selection?.iteration ?? iteration;
	const tag = (isProbe ? caseId.includes("C") : variant === "C") ? `C${candidateIteration}` : "AB";
	const frozen = loadFreeze(root, tag);
	const model = runtime.getModel(MODEL.provider, MODEL.id);
	if (!model) throw new Error("model_unavailable");
	assertFreeze(sourceIdentity(), frozen, stableHash(model), budget.state.clock);
	const id = isProbe ? `probe-${caseId}` : attemptId(mode as "development" | "validation", caseId, variant, iteration);
	if (mode === "validation") {
		const completed = budget.state.attempts.filter((value) => value.startsWith("validation-"));
		const next = VALIDATION_ORDER[completed.length];
		if (!next || next.caseId !== caseId || next.variant !== variant) throw new Error("attempt_forbidden");
		const selected = JSON.parse(readFileSync(join(root, "candidate.json"), "utf8")) as {
			iteration: number;
			freezeHash: string;
		};
		const candidate = loadFreeze(root, `C${selected.iteration}`);
		if (
			selected.freezeHash !== stableHash(candidate) ||
			(variant === "C" && candidate.identity.productHash !== frozen.identity.productHash)
		)
			throw new Error("freeze_changed");
		for (const dev of DEV_IDS)
			if (!existsSync(join(root, `${attemptId("development", dev, "C", selected.iteration)}.json`)))
				throw new Error("candidate_incomplete");
	}
	budget.start(id);
	contentFreeWrite(
		join(root, `${id}-started.json`),
		{ id, startedAtMs: Date.now(), freezeHash: stableHash(frozen) },
		true,
	);
	configureHttpDispatcher();
	const auth = await runtime.getAuth(model);
	if (!auth) {
		budget.stop("auth_unavailable");
		throw new Error("auth_unavailable");
	}
	const cap = isProbe ? 1 : mode === "validation" ? 9 : 8;
	const meter = new RequestMeter(runtime, budget, root, id, frozen, cap, forbiddenValues(auth));
	if (isProbe) {
		const base = loadFreeze(root, "AB");
		const candidateKey = `C${iteration}`;
		const get = (letter: string) =>
			letter === "C" ? readProtocol(root, candidateKey, frozen) : readProtocol(root, letter, base);
		const parts = caseId.split("-");
		let systemPrompt = "You are a helpful assistant.";
		let tools: Tool[] = [];
		if (parts[0] === "system" || parts[0] === "full") systemPrompt = get(parts[1]).systemPrompt;
		if (parts[0] === "tools" || parts[0] === "full") tools = get(parts[1]).tools;
		if (parts.length === 4) tools = get(parts[3]).tools;
		const context: Context = {
			systemPrompt,
			tools,
			messages: [{ role: "user", content: "Reply exactly OK. Do not call tools.", timestamp: 0 }],
		};
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			Math.min(LIMITS.sessionMs, LIMITS.elapsedMs - (Date.now() - budget.state.clock)),
		);
		try {
			meter.finish(
				await meter.runtime
					.streamSimple(model, context, { reasoning: "max", toolChoice: "none", signal: controller.signal })
					.result(),
			);
			contentFreeWrite(
				join(root, `${id}.json`),
				{
					id,
					mode,
					passed: !budget.state.stop && meter.records[0]?.generated?.toolCalls === 0,
					records: meter.records,
					stopCategory: budget.state.stop ?? null,
				},
				true,
			);
		} finally {
			clearTimeout(timer);
		}
		return;
	}
	const data = fixture(caseId);
	const cwd = join(root, "workspace");
	if (existsSync(cwd)) throw new Error("workspace_not_empty");
	materialize(cwd, data);
	const monitor = new FixtureMonitor(cwd, data);
	const host = await createHost(cwd, join(root, "agent"), data, variant, meter.runtime, monitor);
	if (stableHash(protocol(host)) !== frozen.protocolHashes[variant === "C" ? tag : variant])
		throw new Error("session_contract_changed");
	const upstreamBefore = host.session.agent.beforeToolCall;
	host.session.agent.beforeToolCall = async (context, signal) => {
		try {
			return await upstreamBefore?.(context, signal);
		} catch (error) {
			budget.stop(stopCode(error));
			return { block: true, terminate: true, reason: "Evaluation workspace boundary violation." };
		}
	};
	const injected = new Set<string>();
	const upstreamAfter = host.session.agent.afterToolCall;
	host.session.agent.afterToolCall = async (context, signal) => {
		if (monitor.after(context.toolCall.name, context.args, context.result.details, context.isError))
			injected.add(context.toolCall.id);
		return upstreamAfter?.(context, signal);
	};
	let capped = false;
	host.session.agent.shouldStopAfterTurn = ({ toolResults }) => {
		if (budget.state.stop) return true;
		if (meter.records.length >= cap && toolResults.length > 0) {
			capped = true;
			return true;
		}
		return false;
	};
	const toolStarts = new Map<string, number>();
	const args = new Map<string, Record<string, unknown>>();
	const intervals: Array<[number, number]> = [];
	const tools: ToolRecord[] = [];
	const unsubscribe = host.session.subscribe((event) => {
		if (event.type === "tool_execution_start") toolStarts.set(event.toolCallId, Date.now());
		if (event.type === "tool_execution_end") {
			const start = toolStarts.get(event.toolCallId);
			if (start !== undefined) intervals.push([start, Date.now()]);
		}
		if (event.type !== "message_end") return;
		if (event.message.role === "assistant") {
			for (const part of event.message.content) if (part.type === "toolCall") args.set(part.id, part.arguments);
			meter.finish(event.message);
		} else if (event.message.role === "toolResult") {
			const message = event.message;
			const details = object(message.details) ?? {};
			const input = args.get(message.toolCallId) ?? {};
			const code =
				typeof details.code === "string" && /^[A-Z_]{1,60}$/.test(details.code)
					? details.code
					: message.isError
						? "TOOL_ERROR"
						: "OK";
			tools.push({
				ordinal: tools.length + 1,
				request: meter.records.length,
				name: message.toolName,
				isError: message.isError,
				code,
				resultBytes: bytes(message.content),
				argumentBytes: bytes(input),
				suppliedFields: Object.keys(input).length,
				elapsedMs: Date.now() - (toolStarts.get(message.toolCallId) ?? Date.now()),
				verification:
					message.toolName === "bash" &&
					input.command === "node check.cjs" &&
					resolve(cwd, typeof input.cwd === "string" ? input.cwd : ".") === cwd,
				mutation:
					["edit", "write"].includes(message.toolName) &&
					!message.isError &&
					(variant === "A" || details.status === "applied"),
				faultInjected: injected.has(message.toolCallId),
				knownPathDiscovery: data.knownPath && message.toolName === "search",
				exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
			});
			if (["READ_PROVIDER_FAILED", "SEARCH_PROVIDER_FAILED"].includes(code)) budget.stop("infrastructure_failure");
		}
	});
	const start = Date.now();
	const timer = setTimeout(
		() => {
			budget.stop("session_timeout");
			void host.session.abort();
		},
		Math.max(1, Math.min(LIMITS.sessionMs, LIMITS.elapsedMs - (start - budget.state.clock))),
	);
	try {
		try {
			await host.session.prompt(
				`${data.prompt}\n\nEvaluation environment: only this synthetic workspace is available. Shell commands allowed verbatim: ${data.commands.join("; ")}. Do not change check.cjs. Use file tools for changes. Do not access network, environment variables, or outside paths. Return a brief completion summary.`,
			);
		} catch (error) {
			budget.stop(stopCode(error));
		}
		const elapsedMs = Date.now() - start;
		if (budget.state.pending) budget.stop("usage_unknown");
		const filesystemPassed = targetCorrect(cwd, data, monitor.faultApplied) && collateralUnchanged(cwd, data);
		const independentCheckPassed = verify(cwd, data);
		const lastCheck = [...tools].reverse().find((tool) => tool.verification && !tool.isError && tool.exitCode === 0);
		const lastMutation = [...tools].reverse().find((tool) => tool.mutation);
		const modelVerificationObserved = !!lastCheck && (!lastMutation || lastCheck.ordinal > lastMutation.ordinal);
		const safe = monitor.unsafeWriteEvents === 0 && monitor.collateralWriteEvents === 0;
		const passed =
			filesystemPassed &&
			independentCheckPassed &&
			modelVerificationObserved &&
			safe &&
			!budget.state.stop &&
			!capped;
		const toolElapsedMs = unionDuration(intervals);
		const modelElapsedMs = meter.records.reduce((sum, record) => sum + record.elapsedMs, 0);
		const result = {
			id,
			mode,
			caseId,
			variant,
			iteration,
			family: data.family,
			passed,
			safe,
			filesystemPassed,
			independentCheckPassed,
			modelVerificationObserved,
			faultApplied: monitor.faultApplied,
			unsafeWriteEvents: monitor.unsafeWriteEvents,
			collateralWriteEvents: monitor.collateralWriteEvents,
			capped,
			stopCategory: budget.state.stop ?? null,
			elapsedMs,
			modelElapsedMs,
			toolElapsedMs,
			orchestrationMs: elapsedMs - modelElapsedMs - toolElapsedMs,
			records: meter.records,
			tools,
			productHash: frozen.identity.productHash,
			protocolHash: frozen.protocolHashes[variant === "C" ? tag : variant],
		};
		contentFreeWrite(join(root, `${id}.json`), result, true);
		console.log(JSON.stringify({ id, passed, safe, requests: meter.records.length, elapsedMs }));
	} finally {
		clearTimeout(timer);
		unsubscribe();
		await host.close();
		renameSync(cwd, join(root, `${id}-fixture`));
	}
}

export async function entry(): Promise<void> {
	const requested = process.env.PI_V2_ATTRIBUTION_DIR;
	if (!requested || !/^\/tmp\/pi-v2-attribution-[A-Za-z0-9]+$/.test(requested))
		throw new Error("explicit_root_required");
	const root = realpathSync(requested);
	const clock = Number(readFileSync(join(root, "started-at-ms.txt"), "utf8").trim());
	const budget = new Budget(join(root, "budget.json"), clock);
	budget.assertTime();
	const lock = join(root, "active.lock");
	writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
	try {
		process.env.PI_HF_COMPACTION = "off";
		delete process.env.PI_EXPERIMENTAL;
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const mode = process.env.PI_V2_ATTRIBUTION_MODE;
		if (mode === "freeze") {
			const tag = process.env.PI_V2_ATTRIBUTION_TAG;
			if (!["AB", "C1", "C2"].includes(tag ?? "")) throw new Error("explicit_tag_required");
			await freezeRun(root, tag as "AB" | "C1" | "C2", runtime, clock);
			console.log(JSON.stringify({ mode, tag, requests: 0 }));
		} else {
			if (process.env.PI_REAL_MODEL_EVAL !== "1" || process.env.PI_V2_ATTRIBUTION_REAL !== "1")
				throw new Error("real_opt_in_required");
			await executeRun(
				root,
				mode ?? "",
				process.env.PI_V2_ATTRIBUTION_CASE ?? "",
				process.env.PI_V2_ATTRIBUTION_VARIANT as Variant,
				Number(process.env.PI_V2_ATTRIBUTION_ITERATION),
				runtime,
				budget,
			);
			if (budget.state.stop) throw new Error(budget.state.stop);
		}
	} catch (error) {
		if (process.env.PI_V2_ATTRIBUTION_MODE !== "freeze") budget.stop(stopCode(error));
		throw new Error(stopCode(error));
	} finally {
		rmSync(lock);
	}
}
