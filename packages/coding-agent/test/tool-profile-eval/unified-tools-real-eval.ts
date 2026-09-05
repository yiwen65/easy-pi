import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type ExecutionEnv, ExecutionError, err, type ShellExecOptions } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession, type ToolDefinition } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { FffSearchProvider } from "../../src/core/tools/fff-search-provider.ts";
import { NodeReadProviderV2 } from "../../src/core/tools/node-read-provider-v2.ts";
import type { ToolProfile } from "../../src/core/tools/tool-profile.ts";
import { TypeScriptCodeIndexProvider } from "../../src/core/tools/typescript-code-index-provider.ts";
import { assertContentFreeRecord, sha256, stableHash } from "./v2-bounded-real-eval.ts";

export const EVAL_BASELINE = "9fbba6fceabd126a0ea3d53822385c4d4464eaf3";
export const EVAL_LIMITS = {
	costUsd: 15,
	requests: 80,
	tokens: 800_000,
	elapsedMs: 150 * 60_000,
	sessionRequests: 10,
	sessionElapsedMs: 10 * 60_000,
} as const;
export const EVAL_MODEL = { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "max" } as const;
export const PROFILE_NAMES = {
	legacy: ["read", "bash", "edit", "write"],
	v2: ["search", "read", "edit", "bash"],
} as const;

export interface EvalCase {
	id: string;
	initial: Record<string, string>;
	expected: Record<string, string>;
	jsonPaths: string[];
	prompt: string;
	commands: string[];
	verifyCommand: string;
	verifyCwd: string;
	requireFailureRecovery: boolean;
}

const checker = (assertions: string): string =>
	`const fs = require("node:fs");\nconst text = (p) => fs.readFileSync(p, "utf8");\ntry {\n  if (!(${assertions})) { console.log("FAIL: requested values are not correct"); process.exit(1); }\n  console.log("PASS");\n} catch { console.log("FAIL: required fixture is missing or invalid"); process.exit(1); }\n`;

export function createEvalCases(): EvalCase[] {
	const retry = `${Array.from({ length: 160 }, (_, i) => `// Worker retry policy note ${i + 1}.`).join("\n")}\nexport const retryLimit = 3;\nexport const retryJitter = 0.15;\n`;
	const noise = Object.fromEntries(
		Array.from({ length: 48 }, (_, i) => [`examples/policy-${i}.ts`, "export const retryLimit = 3;\n"]),
	);
	return [
		{
			id: "U-01",
			initial: {
				...noise,
				"src/worker/retry.ts": retry,
				"src/preview/retry.ts": "export const retryLimit = 3;\n",
				"docs/retry.md": "Example retryLimit = 3; do not edit documentation for a live setting change.\n",
				"check.cjs": checker('text("src/worker/retry.ts").includes("export const retryLimit = 7;")'),
			},
			expected: { "src/worker/retry.ts": retry.replace("retryLimit = 3", "retryLimit = 7") },
			jsonPaths: [],
			prompt:
				"Locate the live worker retryLimit setting and increase it from 3 to 7. Preserve retryJitter, preview settings, examples, comments, and documentation. Verify the change with node check.cjs.",
			commands: ["find . -type f", "grep -R -n retryLimit src", "node check.cjs"],
			verifyCommand: "node check.cjs",
			verifyCwd: ".",
			requireFailureRecovery: false,
		},
		{
			id: "U-02",
			initial: {
				"src/timeout.ts": "export const timeoutMs = 4000;\nexport const retryCount = 2;\n",
				"src/help.ts": 'export const timeoutLabel = "4 seconds";\nexport const retryLabel = "2 retries";\n',
				"examples/timeout.ts": "export const timeoutMs = 4000;\n",
				"check.cjs": checker(
					'text("src/timeout.ts").includes("timeoutMs = 6000;") && text("src/help.ts").includes(\'timeoutLabel = "6 seconds";\')',
				),
			},
			expected: {
				"src/timeout.ts": "export const timeoutMs = 6000;\nexport const retryCount = 2;\n",
				"src/help.ts": 'export const timeoutLabel = "6 seconds";\nexport const retryLabel = "2 retries";\n',
			},
			jsonPaths: [],
			prompt:
				"Change the production timeout in src/timeout.ts from 4000 to 6000 milliseconds and its label in src/help.ts from 4 seconds to 6 seconds. Preserve retry values, formatting, and examples. Verify with node check.cjs.",
			commands: ["find . -type f", "node check.cjs"],
			verifyCommand: "node check.cjs",
			verifyCwd: ".",
			requireFailureRecovery: false,
		},
		{
			id: "U-03",
			initial: {
				"src/quota.mjs": "export function cap(value) {\n  return Math.min(value, 5);\n",
				"examples/quota.mjs": "export function cap(value) { return Math.min(value, 5); }\n",
			},
			expected: { "src/quota.mjs": "export function cap(value) {\n  return Math.min(value, 5);\n}\n" },
			jsonPaths: [],
			prompt:
				"First run node --check src/quota.mjs and inspect its failure. Then repair only the missing closing brace in src/quota.mjs, preserving its existing lines and behavior. Run the same check again and confirm success. Do not modify examples.",
			commands: ["node --check src/quota.mjs"],
			verifyCommand: "node --check src/quota.mjs",
			verifyCwd: ".",
			requireFailureRecovery: true,
		},
		{
			id: "U-04",
			initial: {
				"service/config.json": '{\n  "timeoutProfile": "quick",\n  "retries": 2\n}\n',
				"service/check.cjs": checker(
					'JSON.parse(text("config.json")).timeoutProfile === "steady" && JSON.parse(text("timeouts.json")).connectMs === 6000 && JSON.parse(text("timeouts.json")).requestMs === 24000',
				),
				"examples/config.json": '{"timeoutProfile":"quick","retries":2}\n',
			},
			expected: {
				"service/config.json": '{\n  "timeoutProfile": "steady",\n  "retries": 2\n}\n',
				"service/timeouts.json": '{\n  "connectMs": 6000,\n  "requestMs": 24000\n}\n',
			},
			jsonPaths: ["service/config.json", "service/timeouts.json"],
			prompt:
				"Set service/config.json timeoutProfile to steady, retaining retries. Create service/timeouts.json with exactly connectMs=6000 and requestMs=24000. Do not alter examples. Verify with command node check.cjs and Bash cwd set to service (use the cwd parameter, not a shell cd).",
			commands: ["node check.cjs"],
			verifyCommand: "node check.cjs",
			verifyCwd: "service",
			requireFailureRecovery: false,
		},
	];
}

export const EVAL_ORDER = createEvalCases().flatMap((entry, index) =>
	(index % 2 === 0 ? (["legacy", "v2"] as const) : (["v2", "legacy"] as const)).map((profile) => ({
		caseId: entry.id,
		profile,
		attemptId: `${entry.id}-${profile}`,
	})),
);

export function materialize(cwd: string, files: Record<string, string>): void {
	for (const [path, value] of Object.entries(files)) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), value, { mode: 0o644 });
	}
}

export function fixtureFiles(cwd: string, prefix = ""): string[] {
	return readdirSync(join(cwd, prefix), { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(prefix, entry.name);
			return entry.isDirectory() ? fixtureFiles(cwd, path) : [path];
		})
		.sort();
}

export function gradeFixture(cwd: string, entry: EvalCase): boolean {
	const wanted = { ...entry.initial, ...entry.expected };
	if (stableHash(fixtureFiles(cwd)) !== stableHash(Object.keys(wanted).sort())) return false;
	try {
		return Object.entries(wanted).every(([path, expected]) => {
			const stat = lstatSync(join(cwd, path));
			if (!stat.isFile() || (stat.mode & 0o777) !== 0o644) return false;
			const actual = readFileSync(join(cwd, path), "utf8");
			return entry.jsonPaths.includes(path)
				? stableHash(JSON.parse(actual)) === stableHash(JSON.parse(expected))
				: actual === expected;
		});
	} catch {
		return false;
	}
}

export function safeEnvironment(root: string): Record<string, string> {
	return { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}

export function assertFixturePath(cwd: string, value: string): void {
	const path = resolve(cwd, value);
	const rel = relative(cwd, path);
	if (rel === ".." || rel.startsWith("../") || value.startsWith("~") || value.includes("://")) {
		throw new Error("workspace_boundary");
	}
	let parent = path;
	while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
	const realRel = relative(realpathSync(cwd), realpathSync(parent));
	if (realRel === ".." || realRel.startsWith("../")) throw new Error("workspace_boundary");
}

export function assertToolBoundary(cwd: string, args: unknown): void {
	if (Array.isArray(args)) {
		for (const item of args) assertToolBoundary(cwd, item);
	} else if (args && typeof args === "object") {
		for (const [key, value] of Object.entries(args)) {
			if (["path", "file_path", "cwd", "from", "to", "destination"].includes(key) && typeof value === "string") {
				assertFixturePath(cwd, value);
				if (value.endsWith("check.cjs") && ("content" in args || "edits" in args || "oldText" in args)) {
					throw new Error("protected_verifier");
				}
			}
			if (value && typeof value === "object") assertToolBoundary(cwd, value);
		}
	}
}

export function guardedCommand(cwd: string, entry: EvalCase, command: string, commandCwd: string): string {
	assertFixturePath(cwd, commandCwd);
	if (!entry.commands.includes(command.trim())) throw new Error("restricted_command");
	if (command.trim() === entry.verifyCommand && resolve(commandCwd) !== resolve(cwd, entry.verifyCwd)) {
		throw new Error("verification_cwd");
	}
	for (const [path, content] of Object.entries(entry.initial)) {
		if (path.endsWith("check.cjs") && readFileSync(join(cwd, path), "utf8") !== content) {
			throw new Error("protected_verifier");
		}
	}
	const normalized = command.trim();
	if (normalized.startsWith("node ")) return `${JSON.stringify(process.execPath)} ${normalized.slice(5)}`;
	if (normalized === "find . -type f") return "/usr/bin/find . -type f";
	if (normalized === "grep -R -n retryLimit src") return "/usr/bin/grep -R -n retryLimit src";
	throw new Error("restricted_command");
}

export function verifyFixture(cwd: string, entry: EvalCase): boolean {
	const commandCwd = resolve(cwd, entry.verifyCwd);
	try {
		guardedCommand(cwd, entry, entry.verifyCommand, commandCwd);
		execFileSync(process.execPath, entry.verifyCommand.slice(5).split(" "), {
			cwd: commandCwd,
			env: safeEnvironment(cwd),
			stdio: "ignore",
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

export async function createEvalSession(options: {
	cwd: string;
	agentDir: string;
	entry: EvalCase;
	profile: ToolProfile;
	runtime: ModelRuntime;
}) {
	const { cwd, agentDir, entry, profile, runtime } = options;
	const model = runtime.getModel(EVAL_MODEL.provider, EVAL_MODEL.id);
	if (!model || model.thinkingLevelMap?.max !== "max") throw new Error("model_max_unavailable");
	const base = new NodeExecutionEnv({ cwd });
	const restrictedEnv = new Proxy(base, {
		get(target, property) {
			if (property === "exec") {
				return (command: string, execOptions?: ShellExecOptions) => {
					try {
						const checked = guardedCommand(cwd, entry, command, execOptions?.cwd ?? cwd);
						return target.exec(checked, { ...execOptions, inheritEnv: false, env: safeEnvironment(cwd) });
					} catch {
						return Promise.resolve(
							err(
								new ExecutionError(
									"spawn_error",
									"Evaluation permits only the listed commands and working directory.",
								),
							),
						);
					}
				};
			}
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
	const searchProvider = new FffSearchProvider(base);
	const codeIndex = new TypeScriptCodeIndexProvider();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime: runtime,
		thinkingLevel: "max",
		toolProfile: profile,
		tools: [...PROFILE_NAMES[profile]],
		customTools:
			profile === "legacy"
				? [
						// SDK's heterogeneous registry erases the concrete renderer argument schema.
						createBashToolDefinition(cwd, {
							spawnHook: ({ command, cwd: commandCwd }) => ({
								command: guardedCommand(cwd, entry, command, commandCwd),
								cwd: commandCwd,
								env: safeEnvironment(cwd),
							}),
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
			executionEnv: restrictedEnv,
			search: { provider: searchProvider, codeIndexProvider: codeIndex },
			read: { provider: new NodeReadProviderV2(base) },
		},
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
	});
	if (stableHash(session.getActiveToolNames().sort()) !== stableHash([...PROFILE_NAMES[profile]].sort())) {
		throw new Error("tool_set_changed");
	}
	if (session.hfCompactionHost !== undefined) throw new Error("extra_model_calls_enabled");
	const upstreamHook = session.agent.beforeToolCall;
	session.agent.beforeToolCall = async (context, signal) => {
		assertToolBoundary(cwd, context.args);
		return upstreamHook?.(context, signal);
	};
	return {
		session,
		close: async () => {
			session.dispose();
			await searchProvider.close?.();
			await codeIndex.close();
		},
	};
}

export interface EvalBudgetState {
	startedAtMs: number;
	attempts: string[];
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	pending?: { tokens: number; costUsd: number };
	stop?: string;
}

export class EvalBudget {
	readonly state: EvalBudgetState;
	constructor(startedAtMs: number, privatePersist: (state: EvalBudgetState) => void = () => {}) {
		if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) throw new Error("invalid_clock");
		this.state = {
			startedAtMs,
			attempts: [],
			requests: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		};
		this.persist = privatePersist;
	}
	private readonly persist: (state: EvalBudgetState) => void;
	get tokens(): number {
		return (
			this.state.inputTokens + this.state.outputTokens + this.state.cacheReadTokens + this.state.cacheWriteTokens
		);
	}
	assertTime(now = Date.now()): void {
		if (now < this.state.startedAtMs || now - this.state.startedAtMs >= EVAL_LIMITS.elapsedMs)
			throw new Error("time_budget");
	}
	startAttempt(id: string): void {
		this.assertTime();
		if (
			this.state.stop ||
			this.state.pending ||
			this.state.attempts.includes(id) ||
			!EVAL_ORDER.some((entry) => entry.attemptId === id)
		)
			throw new Error("attempt_not_permitted");
		this.state.attempts.push(id);
		this.persist(this.state);
	}
	reserve(tokens: number, costUsd: number): void {
		this.assertTime();
		if (this.state.stop || this.state.pending) throw new Error("usage_unreconciled");
		if (!Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isFinite(costUsd) || costUsd <= 0)
			throw new Error("invalid_reservation");
		if (this.state.requests >= EVAL_LIMITS.requests) throw new Error("request_budget");
		if (this.tokens + tokens > EVAL_LIMITS.tokens) throw new Error("token_budget");
		if (this.state.costUsd + costUsd > EVAL_LIMITS.costUsd) throw new Error("cost_budget");
		this.state.requests += 1;
		this.state.pending = { tokens, costUsd };
		this.persist(this.state);
	}
	commit(usage: Usage): void {
		const pending = this.state.pending;
		const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
		if (
			!pending ||
			counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
			counts.reduce((a, b) => a + b, 0) === 0 ||
			!Number.isFinite(usage.cost.total) ||
			usage.cost.total <= 0
		) {
			this.stop("usage_unknown");
			throw new Error("usage_unknown");
		}
		this.state.inputTokens += usage.input;
		this.state.outputTokens += usage.output;
		this.state.cacheReadTokens += usage.cacheRead;
		this.state.cacheWriteTokens += usage.cacheWrite;
		this.state.costUsd += usage.cost.total;
		this.state.pending = undefined;
		if (counts.reduce((a, b) => a + b, 0) > pending.tokens || usage.cost.total > pending.costUsd)
			this.stop("reservation_exceeded");
		this.persist(this.state);
	}
	stop(category: string): void {
		this.state.stop ??= category;
		this.persist(this.state);
	}
}

export function saveContentFree(path: string, value: unknown, exclusive = false): void {
	assertContentFreeRecord(value);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? "wx" : "w", mode: 0o600 });
}

export function sessionContract(
	session: Awaited<ReturnType<typeof createEvalSession>>["session"],
	cwd: string,
	agentDir: string,
) {
	return {
		schemaHash: stableHash(
			session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
		),
		systemPromptHash: sha256(session.systemPrompt.replaceAll(cwd, "$WORKSPACE").replaceAll(agentDir, "$AGENT_DIR")),
	};
}
