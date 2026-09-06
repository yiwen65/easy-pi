import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_HARNESS_CONTEXT_ENV, createChildHarnessContext, decidePermission } from "@easy-pi/permissions";
import { createExternalMutationJournal, readExternalMutationJournal } from "@easy-pi/permissions/journal";
import { RunLedger } from "@easy-pi/subagent/ledger";
import type { SnapshotHandle, SubagentDagRunDetails } from "@easy-pi/subagent/types";
import { test } from "vitest";
import { createEasyPiHarness } from "../src/extensions/easy-pi.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

test("extension composes one production Subagent with non-Git operator authority and permission controls", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wj-extension-nongit-")));
	const ledger = new RunLedger(":memory:");
	try {
		const handlers = new Map<string, Handler[]>();
		const tools = new Map<string, Record<string, unknown>>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const permissionTitles: string[] = [];
		const statuses: string[] = [];
		const registeredNames: string[] = [];
		const api = {
			on: (event: string, handler: Handler) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			registerTool: (tool: Record<string, unknown>) => {
				const name = String(tool.name);
				registeredNames.push(name);
				if (tools.has(name)) throw new Error(`duplicate tool: ${name}`);
				tools.set(name, tool);
			},
			registerCommand: (
				name: string,
				command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
			) => commands.set(name, command),
			registerEntryRenderer: () => undefined,
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			sendMessage: () => undefined,
			sendUserMessage: () => undefined,
		} as unknown as ExtensionAPI;
		const snapshot: SnapshotHandle = {
			path: root,
			baseline: {
				repositoryRoot: root,
				headCommit: "abc",
				snapshotId: "snapshot",
				fileCount: 0,
				totalBytes: 0,
			},
			cleanup: async () => undefined,
		};
		let selectedModel: unknown;
		let selectedModels: unknown;
		let pauseCalls = 0;
		const operatorDetails: SubagentDagRunDetails = {
			runId: "operator-run",
			status: "running",
			objective: "Operator test",
			baseline: snapshot.baseline,
			tasks: [
				{
					taskId: "write",
					role: "writer",
					status: "running",
					attempts: 1,
					maxAttempts: 2,
					dependsOn: [],
				},
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			budget: {
				maxTokens: 20_000,
			},
			pausedDurationMs: 0,
			resources: { candidate: "none", pins: "retained" },
		};
		createEasyPiHarness({
			subagent: {
				agentDir: root,
				ledger,
				modelPreferencesPath: join(root, "model-preferences.json"),
				dagOrchestrator: {
					start: async ({ request }) => {
						selectedModel = request.childModel;
						selectedModels = request.childModels;
						return {
							...operatorDetails,
							status: "succeeded",
							tasks: operatorDetails.tasks.map((task) => ({
								...task,
								status: "succeeded" as const,
								terminalReason: "completed" as const,
							})),
							usage: { ...operatorDetails.usage, totalTokens: 2 },
						};
					},
					resume: async () => operatorDetails,
					inspect: () => operatorDetails,
					pause: async () => {
						pauseCalls++;
						return { ...operatorDetails, pausedAt: Date.now() };
					},
					shutdown: async () => undefined,
				},
			},
		})(api);

		assert.deepEqual([...tools.keys()].sort(), ["request_user_input", "subagent"]);
		assert.equal(registeredNames.filter((name) => name === "subagent").length, 1);
		assert.ok(commands.has("permissions"));
		assert.ok(commands.has("subagents"));
		assert.ok(commands.has("subagent-models"));
		assert.equal(commands.has("skill:feynman-teacher"), false);
		assert.equal(handlers.has("resources_discover"), false);
		assert.equal(handlers.has("agent_settled"), false);
		assert.equal(handlers.has("message_end"), false);

		const context = {
			hasUI: false,
			mode: "print",
			cwd: root,
			model: { provider: "openai-codex", id: "gpt-5.4-mini" },
			thinkingLevel: "low",
			modelRegistry: {
				getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true }],
			},
			sessionManager: { getBranch: () => entries },
			ui: {
				setStatus: (_key: string, value: string) => statuses.push(value),
				notify: () => undefined,
				select: async () => undefined,
			},
		} as unknown as ExtensionContext;

		const prompt = await handlers.get("before_agent_start")?.[0]?.(
			{ type: "before_agent_start", systemPrompt: "base" },
			context,
		);
		const systemPrompt = (prompt as { systemPrompt: string }).systemPrompt;
		assert.match(systemPrompt, /smallest task-relevant verification justified by the change risk/);
		assert.match(
			systemPrompt,
			/Permission mode is full-access\. Pi tools run with the permissions of the Pi process/,
		);
		assert.doesNotMatch(systemPrompt, /complete_task|mutation epoch|correction attempt/i);
		assert.doesNotMatch(systemPrompt, /Load a matching skill|docs\/tasks ledger|Use subagents only/);

		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
		assert.equal(statuses.at(-1), "perm:full-access");
		await commands.get("permissions")?.handler("manual-allow", context);
		const blockedManualWrite = await handlers.get("tool_call")?.[0]?.(
			{ type: "tool_call", toolCallId: "write-1", toolName: "write", input: { path: "a.ts", content: "x" } },
			context,
		);
		assert.deepEqual(blockedManualWrite, {
			block: true,
			reason: "Manual Allow requires confirmation for write; non-interactive mode defaults to deny",
		});
		const allowedWriterDag = await handlers.get("tool_call")?.[0]?.(
			{
				type: "tool_call",
				toolCallId: "subagent-writer",
				toolName: "subagent",
				input: { tasks: [{ id: "write", objective: "Write src", ownedPaths: ["src"] }] },
			},
			context,
		);
		assert.equal(allowedWriterDag, undefined);
		const externalWriterInput = {
			tasks: [
				{
					id: "publish",
					objective: "Publish",
					externalOwnedPaths: [join(root, "..", "published.txt")],
				},
			],
		};
		const blockedExternalWriter = await handlers.get("tool_call")?.[0]?.(
			{ type: "tool_call", toolCallId: "external-writer", toolName: "subagent", input: externalWriterInput },
			context,
		);
		assert.match(
			String((blockedExternalWriter as { reason: string }).reason),
			/non-interactive mode defaults to deny/,
		);

		await commands.get("permissions")?.handler("full-access", context);
		assert.equal(
			await handlers.get("tool_call")?.[0]?.(
				{ type: "tool_call", toolCallId: "external-full", toolName: "subagent", input: externalWriterInput },
				context,
			),
			undefined,
		);
		const blockedHard = await handlers.get("tool_call")?.[0]?.(
			{ type: "tool_call", toolCallId: "bash-1", toolName: "bash", input: { command: `rm -rf ${root}` } },
			context,
		);
		assert.equal((blockedHard as { block: boolean }).block, true);

		await commands.get("permissions")?.handler("auto", context);
		const interactiveContext = {
			...context,
			hasUI: true,
			mode: "tui",
			ui: {
				...context.ui,
				select: async (title: string) => {
					permissionTitles.push(title);
					return "Deny";
				},
			},
		} as unknown as ExtensionContext;
		const allowedPush = await handlers.get("tool_call")?.[0]?.(
			{ type: "tool_call", toolCallId: "push-1", toolName: "bash", input: { command: "git push origin main" } },
			interactiveContext,
		);
		assert.equal(allowedPush, undefined);
		assert.equal(permissionTitles.length, 0);
		const deniedExternalWriter = await handlers.get("tool_call")?.[0]?.(
			{ type: "tool_call", toolCallId: "external-auto", toolName: "subagent", input: externalWriterInput },
			interactiveContext,
		);
		assert.deepEqual(deniedExternalWriter, { block: true, reason: "Blocked by user" });
		assert.match(permissionTitles[0] ?? "", /irreversible host writes/);
		permissionTitles.length = 0;

		await commands.get("permissions")?.handler("manual-allow", interactiveContext);
		// Subagent follows the session permission mode: manual-allow gates only write/edit,
		// so writer DAG starts and operator mutations run without a bespoke prompt.
		const allowedWriter = await handlers.get("tool_call")?.[0]?.(
			{
				type: "tool_call",
				toolCallId: "writer-preview",
				toolName: "subagent",
				input: {
					tasks: [
						{
							id: "write-parser",
							objective: "Implement parser",
							ownedPaths: ["src/parser.ts", "test/parser.test.ts"],
						},
					],
				},
			},
			interactiveContext,
		);
		assert.equal(allowedWriter, undefined);

		const allowedAnalyst = await handlers.get("tool_call")?.[0]?.(
			{
				type: "tool_call",
				toolCallId: "analyst-preview",
				toolName: "subagent",
				input: { tasks: [{ id: "inspect", objective: "Inspect durable state" }] },
			},
			interactiveContext,
		);
		assert.equal(allowedAnalyst, undefined);
		assert.equal(permissionTitles.length, 0);

		// Operator mutations also inherit the session mode; repository authority still applies.
		await commands.get("subagents")?.handler("pause operator-run", interactiveContext);
		assert.equal(pauseCalls, 1);
		assert.equal(permissionTitles.length, 0);
		const nestedRepository = join(root, "nested-repository");
		await mkdir(nestedRepository);
		execFileSync("git", ["init", "-q"], { cwd: nestedRepository, stdio: "ignore" });
		await commands.get("subagents")?.handler("pause operator-run", {
			...interactiveContext,
			cwd: nestedRepository,
		} as ExtensionContext);
		assert.equal(pauseCalls, 1);
		assert.equal(permissionTitles.length, 0);

		const questionTool = tools.get("request_user_input") as {
			execute: (
				id: string,
				params: { questions: typeof questions },
				signal: undefined,
				onUpdate: undefined,
				ctx: ExtensionContext,
			) => Promise<{ details: { status: string } }>;
		};
		const questions = [
			{
				header: "Scope",
				id: "scope",
				question: "Choose scope",
				options: [
					{ label: "One", description: "First" },
					{ label: "Two", description: "Second" },
				],
			},
		];
		await assert.rejects(
			questionTool.execute("question-1", { questions }, undefined, undefined, context),
			/input_required: interactive UI is unavailable/,
		);

		const subagentTool = tools.get("subagent") as {
			parameters: { type?: string; properties?: Record<string, unknown> };
			execute: (
				id: string,
				params: unknown,
				signal: undefined,
				onUpdate: undefined,
				ctx: ExtensionContext,
			) => Promise<{ details: { status: string }; usage?: { totalTokens: number } }>;
		};
		assert.equal(subagentTool.parameters.type, "object");
		assert.deepEqual(Object.keys(subagentTool.parameters.properties ?? {}).sort(), ["tasks"]);
		await assert.rejects(
			subagentTool.execute("subagent-empty", {}, undefined, undefined, context),
			/does not match the registered schema/,
		);
		const delegated = await subagentTool.execute(
			"subagent-read",
			{
				tasks: [{ id: "inspect", objective: "Inspect README" }],
			},
			undefined,
			undefined,
			context,
		);
		assert.equal(delegated.details.status, "succeeded");
		assert.equal(delegated.usage?.totalTokens, 2);
		assert.deepEqual(selectedModel, {
			provider: "openai-codex",
			model: "gpt-5.4-mini",
			thinkingLevel: "low",
		});
		assert.deepEqual(selectedModels, {
			analyst: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
			reviewer: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
			writer: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
		});

		for (const handler of handlers.get("session_shutdown") ?? []) {
			await handler({ type: "session_shutdown" }, context);
		}
	} finally {
		ledger.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Child processes use the same WJ permission behavior and tool catalog as Parent", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wj-child-extension-")));
	const contextPath = join(root, "child-harness-context.json");
	const previousContextPath = process.env[CHILD_HARNESS_CONTEXT_ENV];
	const ledger = new RunLedger(":memory:");
	const grantedPath = join(root, "owned", "granted.ts");
	await writeFile(
		contextPath,
		JSON.stringify(
			createChildHarnessContext({
				cwd: root,
				permissionMode: "manual-allow",
				sessionGrants: [`tool:write:path:${grantedPath}`],
				protectedRoots: [root],
			}),
		),
		{ mode: 0o600 },
	);
	await chmod(contextPath, 0o600);
	process.env[CHILD_HARNESS_CONTEXT_ENV] = contextPath;
	try {
		const handlers = new Map<string, Handler[]>();
		const tools: string[] = [];
		const auditRecords: Array<Record<string, unknown>> = [];
		const api = {
			on: (event: string, handler: Handler) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand: () => undefined,
			registerEntryRenderer: () => undefined,
			appendEntry: (_type: string, data: Record<string, unknown>) => auditRecords.push(data),
		} as unknown as ExtensionAPI;
		createEasyPiHarness({ subagent: { agentDir: root, ledger } })(api);

		assert.deepEqual(tools.sort(), ["request_user_input", "subagent"]);
		const toolCall = handlers.get("tool_call")?.[0];
		assert.ok(toolCall);
		let childPermissionPrompts = 0;
		const context = {
			cwd: root,
			hasUI: false,
			mode: "rpc",
			ui: {
				select: async () => {
					childPermissionPrompts++;
					return "Deny";
				},
				setStatus: () => undefined,
			},
		} as unknown as ExtensionContext;
		assert.equal(
			await toolCall({ type: "tool_call", toolName: "read", input: { path: "inside.ts" } }, context),
			undefined,
		);
		assert.equal(
			await toolCall({ type: "tool_call", toolName: "read", input: { path: "../outside.ts" } }, context),
			undefined,
		);
		const ungrantedWrite = {
			type: "tool_call",
			toolCallId: "write-ungranted",
			toolName: "write",
			input: { path: "owned/file.ts", content: "x" },
		};
		assert.equal(await toolCall(ungrantedWrite, context), undefined);
		assert.equal(childPermissionPrompts, 0);
		assert.ok(
			auditRecords.some(
				(record) =>
					record.decision === "allow" && String(record.reason).includes("headless Child allowed for this session"),
			),
		);
		const childTuiContext = { ...context, hasUI: true, mode: "tui" } as unknown as ExtensionContext;
		assert.equal(await toolCall({ ...ungrantedWrite, toolCallId: "write-grant-reuse" }, childTuiContext), undefined);
		assert.equal(childPermissionPrompts, 0);
		const hardDenied = await toolCall(
			{ type: "tool_call", toolCallId: "delete-source", toolName: "bash", input: { command: `rm -rf ${root}` } },
			context,
		);
		assert.equal((hardDenied as { block: boolean }).block, true);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "switch" }, context);
		assert.deepEqual(
			await toolCall({ ...ungrantedWrite, toolCallId: "write-after-session-reset" }, childTuiContext),
			{
				block: true,
				reason: "Blocked by user",
			},
		);
		assert.equal(childPermissionPrompts, 1);
		assert.equal(
			await toolCall({ type: "tool_call", toolName: "write", input: { path: grantedPath, content: "x" } }, context),
			undefined,
		);
		assert.equal(
			await toolCall({ type: "tool_call", toolName: "bash", input: { command: "pwd" } }, context),
			undefined,
		);
		assert.equal(
			await toolCall(
				{
					type: "tool_call",
					toolName: "subagent",
					input: { tasks: [{ id: "nested", objective: "Inspect nested state" }] },
				},
				context,
			),
			undefined,
		);
		assert.equal(
			await toolCall({ type: "tool_call", toolName: "deploy_widget", input: { target: "staging" } }, context),
			undefined,
		);
	} finally {
		if (previousContextPath === undefined) delete process.env[CHILD_HARNESS_CONTEXT_ENV];
		else process.env[CHILD_HARNESS_CONTEXT_ENV] = previousContextPath;
		ledger.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("nested Children inherit ancestor protected roots from the WJ issuer", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wj-nested-child-")));
	const ancestorRoot = await realpath(await mkdtemp(join(tmpdir(), "wj-ancestor-source-")));
	const contextPath = join(ancestorRoot, "child-harness-context.json");
	const previousContextPath = process.env[CHILD_HARNESS_CONTEXT_ENV];
	const ledger = new RunLedger(":memory:");
	execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
	await writeFile(join(root, "README.md"), "nested child fixture\n");
	execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
	execFileSync(
		"git",
		["-c", "user.name=WJ Test", "-c", "user.email=wj-test@example.invalid", "commit", "-q", "-m", "baseline"],
		{ cwd: root, stdio: "ignore" },
	);
	await writeFile(
		contextPath,
		JSON.stringify(
			createChildHarnessContext({
				cwd: root,
				permissionMode: "full-access",
				protectedRoots: [ancestorRoot],
			}),
		),
		{ mode: 0o600 },
	);
	await chmod(contextPath, 0o600);
	process.env[CHILD_HARNESS_CONTEXT_ENV] = contextPath;
	try {
		const handlers = new Map<string, Handler[]>();
		const tools = new Map<string, Record<string, unknown>>();
		let nestedProtectedRoots: string[] | undefined;
		const api = {
			on: (event: string, handler: Handler) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			registerTool: (tool: Record<string, unknown>) => tools.set(String(tool.name), tool),
			registerCommand: () => undefined,
			registerEntryRenderer: () => undefined,
			appendEntry: () => undefined,
			sendMessage: () => undefined,
			sendUserMessage: () => undefined,
		} as unknown as ExtensionAPI;
		createEasyPiHarness({
			subagent: {
				agentDir: root,
				ledger,
				childModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
				runTask: async (options) => {
					assert.ok(options.createChildHarnessContext);
					const nestedContext = options.createChildHarnessContext({
						cwd: options.snapshotPath,
						protectedRoots: [options.workspaceRoot],
						inheritedWriteRoots: [],
					});
					nestedProtectedRoots = nestedContext.protectedRoots;
					assert.equal(
						decidePermission({
							mode: nestedContext.permissionMode,
							toolName: "bash",
							input: { command: `rm -rf ${ancestorRoot}` },
							cwd: nestedContext.cwd,
							sessionGrants: new Set(nestedContext.sessionGrants),
							protectedRoots: nestedContext.protectedRoots,
							inheritedWriteRoots: nestedContext.inheritedWriteRoots,
						}).decision,
						"deny",
					);
					return {
						taskId: options.task.id,
						role: options.task.role,
						success: true,
						terminalReason: "completed",
						handoff: {
							taskId: options.task.id,
							summary: "Nested protection verified",
							outcome: "accepted",
							evidence: [],
							verification: [],
							assumptions: [],
							risks: [],
							nextActions: [],
							verificationLevel: "unverified",
						},
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						turns: 0,
					};
				},
			},
		})(api);
		const subagent = tools.get("subagent") as {
			execute: (...args: unknown[]) => Promise<{ details: { status: string } }>;
		};
		const context = {
			cwd: root,
			model: { provider: "openai-codex", id: "gpt-5.4-mini" },
			thinkingLevel: "low",
			modelRegistry: {
				getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true }],
			},
			ui: { setStatus: () => undefined, notify: () => undefined },
		} as unknown as ExtensionContext;
		const result = await subagent.execute(
			"nested-start",
			{
				tasks: [{ id: "inspect", objective: "Inspect README" }],
			},
			undefined,
			undefined,
			context,
		);
		assert.equal(result.details.status, "succeeded");
		assert.ok(nestedProtectedRoots?.includes(ancestorRoot));
		assert.ok(nestedProtectedRoots?.includes(root));
	} finally {
		if (previousContextPath === undefined) delete process.env[CHILD_HARNESS_CONTEXT_ENV];
		else process.env[CHILD_HARNESS_CONTEXT_ENV] = previousContextPath;
		ledger.close();
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(ancestorRoot, { recursive: true, force: true }),
		]);
	}
});

test("external writers journal WJ-allowed write/edit and post-state", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wj-child-external-")));
	const externalRoot = await realpath(await mkdtemp(join(tmpdir(), "wj-child-output-")));
	const journal = await createExternalMutationJournal({
		runId: "external-run",
		taskId: "publish",
		attemptId: "external-attempt",
		attemptNumber: 1,
	});
	const contextPath = join(root, "child-harness-context.json");
	const previousContextPath = process.env[CHILD_HARNESS_CONTEXT_ENV];
	const ledger = new RunLedger(":memory:");
	await writeFile(
		contextPath,
		JSON.stringify(
			createChildHarnessContext({
				cwd: root,
				permissionMode: "auto",
				protectedRoots: [root],
				inheritedWriteRoots: [externalRoot],
				mutationJournal: journal.policy,
			}),
		),
		{ mode: 0o600 },
	);
	await chmod(contextPath, 0o600);
	process.env[CHILD_HARNESS_CONTEXT_ENV] = contextPath;
	try {
		const handlers = new Map<string, Handler[]>();
		const api = {
			on: (event: string, handler: Handler) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			registerTool: () => undefined,
			registerCommand: () => undefined,
			registerEntryRenderer: () => undefined,
			appendEntry: () => undefined,
		} as unknown as ExtensionAPI;
		createEasyPiHarness({ subagent: { agentDir: root, ledger } })(api);
		const toolCall = handlers.get("tool_call")?.[0];
		const toolResult = handlers.get("tool_result")?.at(-1);
		assert.ok(toolCall);
		assert.ok(toolResult);
		const context = { cwd: root, hasUI: false, mode: "rpc" } as unknown as ExtensionContext;
		const published = join(externalRoot, "published.txt");

		const writeInput = { path: published, content: "one\n" };
		assert.equal(
			await toolCall({ type: "tool_call", toolCallId: "write-1", toolName: "write", input: writeInput }, context),
			undefined,
		);
		assert.equal(Object.isFrozen(writeInput), true);
		assert.throws(() => Object.assign(writeInput, { path: join(root, "escaped.txt") }), TypeError);
		let events = readExternalMutationJournal(journal.policy);
		assert.equal(events.length, 1);
		const authorized = events[0];
		assert.equal(authorized?.type, "authorized");
		if (authorized?.type === "authorized") {
			assert.deepEqual(
				{ ...authorized.mutation, authorizedAt: 0 },
				{
					mutationId: "external-attempt:1",
					runId: "external-run",
					taskId: "publish",
					attemptId: "external-attempt",
					attemptNumber: 1,
					authorizationSequence: 1,
					toolCallId: "write-1",
					operation: "write",
					path: published,
					authorizationStatus: "authorized",
					authorizedAt: 0,
				},
			);
		}
		await writeFile(published, "one\n");
		await toolResult(
			{
				type: "tool_result",
				toolCallId: "write-1",
				toolName: "write",
				input: { path: published, content: "one\n" },
				content: [],
				isError: false,
			},
			context,
		);

		assert.equal(
			await toolCall(
				{ type: "tool_call", toolCallId: "edit-1", toolName: "edit", input: { path: published } },
				context,
			),
			undefined,
		);
		await writeFile(published, "two\n");
		await toolResult(
			{
				type: "tool_result",
				toolCallId: "edit-1",
				toolName: "edit",
				input: { path: published },
				content: [],
				isError: false,
			},
			context,
		);

		const missing = join(externalRoot, "missing.txt");
		assert.equal(
			await toolCall(
				{ type: "tool_call", toolCallId: "write-failed", toolName: "write", input: { path: missing } },
				context,
			),
			undefined,
		);
		await toolResult(
			{
				type: "tool_result",
				toolCallId: "write-failed",
				toolName: "write",
				input: { path: missing },
				content: [],
				isError: true,
			},
			context,
		);

		events = readExternalMutationJournal(journal.policy);
		const observations = events.filter((event) => event.type === "observed");
		assert.equal(observations.length, 3);
		assert.equal(observations[0]?.toolResult, "succeeded");
		assert.equal(observations[0]?.postState.status, "confirmed");
		if (observations[0]?.postState.status === "confirmed") {
			assert.match(observations[0].postState.sha256, /^[a-f0-9]{64}$/);
		}
		assert.equal(observations[2]?.toolResult, "failed");
		assert.deepEqual(observations[2]?.postState, { status: "unavailable", reason: "missing" });

		const beforeAdditionalGrant = events.length;
		const additionallyGrantedPath = join(root, "..", "unapproved.txt");
		assert.equal(
			await toolCall(
				{
					type: "tool_call",
					toolCallId: "write-additional-grant",
					toolName: "write",
					input: { path: additionallyGrantedPath },
				},
				context,
			),
			undefined,
		);
		await toolResult(
			{
				type: "tool_result",
				toolCallId: "write-additional-grant",
				toolName: "write",
				input: { path: additionallyGrantedPath },
				content: [],
				isError: true,
			},
			context,
		);
		await toolCall(
			{ type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: published } },
			context,
		);
		const afterAdditionalGrant = readExternalMutationJournal(journal.policy);
		assert.equal(afterAdditionalGrant.length, beforeAdditionalGrant + 2);
		const additionalAuthorization = afterAdditionalGrant.find(
			(event) => event.type === "authorized" && event.mutation.toolCallId === "write-additional-grant",
		);
		if (!additionalAuthorization || additionalAuthorization.type !== "authorized") {
			assert.fail("additional Child session grant was not journaled");
		}
		assert.equal(additionalAuthorization.mutation.path, additionallyGrantedPath);
	} finally {
		if (previousContextPath === undefined) delete process.env[CHILD_HARNESS_CONTEXT_ENV];
		else process.env[CHILD_HARNESS_CONTEXT_ENV] = previousContextPath;
		ledger.close();
		await journal.cleanup();
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(externalRoot, { recursive: true, force: true }),
		]);
	}
});
