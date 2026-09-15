import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	Type,
} from "@earendil-works/pi-ai";
import {
	COLLABORATION_LIMITS,
	DELIVER_RESULT_TOOL_NAME,
	DelegationResultSchema,
	validateDelegation,
} from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import { prepareCollaborationFork } from "@easy-pi/subagent/context-fork";
import type { ChildSession, ChildSessionCreateOptions, ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import { afterEach, expect, test } from "vitest";
import type { ExtensionAPI, InlineExtension } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createPiChildSessionHost, preparePiCollaborationFork } from "../src/extensions/pi-child-session-host.ts";
import { taskContract } from "./collaboration-fixture.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
	additionalExtensions?: (identity: { rootSessionId: string; agentPath: string }) => InlineExtension[],
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "epi-native-host-")));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	await mkdir(cwd);
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "native-host-faux", tokensPerSecond: 0 });
	runtime.registerNativeProvider(faux.provider);
	const shutdowns: string[] = [];
	const host = createPiChildSessionHost({
		modelRuntime: runtime,
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		noExtensions: true,
		registerTools: (identity, pi: ExtensionAPI) => {
			pi.registerTool({
				name: "probe_identity",
				label: "Identity",
				description: "Test identity",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: identity.rootSessionId }], details: {} };
				},
			});
			pi.on("before_agent_start", (event) => ({
				systemPrompt: `${event.systemPrompt}\nIdentity: ${identity.rootSessionId}${identity.agentPath}`,
			}));
			pi.on("session_shutdown", () => {
				shutdowns.push(identity.rootSessionId);
			});
		},
		additionalExtensions,
	});
	async function create(
		rootSessionId: string,
		permissions: () => ChildSessionPermissions,
		storage: ChildSessionCreateOptions["storage"] = { kind: "memory" },
		fork?: ChildSessionCreateOptions["fork"],
		signal?: AbortSignal,
	) {
		const request: ChildSessionCreateOptions = {
			rootSessionId,
			agentPath: "/root/worker",
			cwd,
			agentDir: join(root, "agent"),
			model: { provider: faux.provider.id, id: faux.getModel().id, thinkingLevel: "off" },
			storage,
			fork,
			getPermissions: permissions,
			signal,
		};
		const session = await host.create(request);
		cleanups.push(() => session.dispose());
		return { session, request };
	}
	return { root, cwd, host, faux, runtime, shutdowns, create };
}

const full = (): ChildSessionPermissions => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] });

function toolError(session: ChildSession): boolean {
	return session.context().some((message) => message.role === "toolResult" && message.isError);
}

test("independent native sessions share the model runtime, not identities, histories or disposal", async () => {
	const f = await fixture();
	const a = await f.create("team-a", full);
	const b = await f.create("team-b", full);
	expect(a.session.sessionId).not.toBe(b.session.sessionId);
	expect(f.faux.state.callCount).toBe(0);
	const contexts: Context[] = [];
	f.faux.setResponses([
		(context) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			return fauxAssistantMessage("a");
		},
		(context) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			return fauxAssistantMessage("b");
		},
	]);
	const results = await Promise.all([a.session.run("a-only"), b.session.run("b-only")]);
	expect(
		a.session
			.context()
			.filter((message) => message.role === "assistant")
			.map((message) => message.errorMessage),
	).toEqual([undefined]);
	expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
	expect(contexts.map((context) => context.systemPrompt?.match(/Identity: [^\n]+/g))).toEqual(
		expect.arrayContaining([["Identity: team-a/root/worker"], ["Identity: team-b/root/worker"]]),
	);
	for (const context of contexts) {
		expect(context.tools?.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "write", "probe_identity"]),
		);
		expect(context.tools?.map((tool) => tool.name)).not.toContain("subagent");
	}
	expect(JSON.stringify(a.session.context())).not.toContain("b-only");
	expect(JSON.stringify(b.session.context())).not.toContain("a-only");
	const clone = a.session.context();
	clone.length = 0;
	expect(a.session.context().length).toBeGreaterThan(0);
	await a.session.dispose();
	await a.session.dispose();
	expect(f.shutdowns).toEqual(["team-a"]);
	f.faux.setResponses([fauxAssistantMessage("still alive")]);
	expect(await b.session.run("continue b")).toMatchObject({ status: "completed", text: "still alive" });
	expect(f.runtime.getModel(f.faux.provider.id, f.faux.getModel().id)).toBeDefined();
	expect(existsSync(join(f.root, "agent", "auth.json"))).toBe(false);
	expect(existsSync(join(f.root, "agent", "subagent", "state.sqlite"))).toBe(false);
});

test("native children run under full access and fail closed on legacy parent modes", async () => {
	const f = await fixture();
	const allowed = await f.create("full", full);
	let mode: ChildSessionPermissions["mode"] = "full-access";
	const restricted = await f.create("restricted", () => ({ mode, sessionGrants: [], protectedRoots: [f.cwd] }));
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "allowed.txt", content: "shared" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	await allowed.session.run("write allowed");
	expect(await readFile(join(f.cwd, "allowed.txt"), "utf8")).toBe("shared");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "also-allowed.txt", content: "yes" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	await restricted.session.run("write under full access");
	expect(await readFile(join(f.cwd, "also-allowed.txt"), "utf8")).toBe("yes");
	// A legacy or otherwise non-full-access parent mode fails the child's tools closed.
	mode = "auto" as never;
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "denied.txt", content: "no" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("denied"),
	]);
	await restricted.session.run("write after mode regression");
	expect(toolError(restricted.session)).toBe(true);
	expect(existsSync(join(f.cwd, "denied.txt"))).toBe(false);
});

test("full access children write freely; catastrophic deletion still protects the shared root", async () => {
	const f = await fixture();
	const a = await f.create("a", () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [f.cwd] }));
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "shared.txt", content: "a" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await a.session.run("write shared");
	expect(await readFile(join(f.cwd, "shared.txt"), "utf8")).toBe("a");
	const c = await f.create("full", () => ({ ...full(), protectedRoots: [f.cwd] }));
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: `rm -rf '${f.cwd}'` }), { stopReason: "toolUse" }),
		fauxAssistantMessage("denied"),
	]);
	await c.session.run("test protected deletion");
	expect(toolError(c.session)).toBe(true);
	expect(existsSync(join(f.cwd, "shared.txt"))).toBe(true);
});

test("task text does not execute slash commands or change child permission authority", async () => {
	const f = await fixture();
	const child = await f.create("literal", () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }));
	let captured: Context | undefined;
	f.faux.setResponses([
		(context) => {
			captured = context;
			return fauxAssistantMessage("literal");
		},
	]);
	await child.session.run("/permissions full-access");
	expect(captured?.systemPrompt).toContain("Permission mode is full-access");
	expect(JSON.stringify(captured?.messages)).toContain("/permissions full-access");
});

test("creation and cold loading do not call the provider; ownership mismatch never rewrites a file", async () => {
	const f = await fixture();
	const directory = join(f.root, "team-sessions");
	const first = await f.create("persisted", full, { kind: "file", directory });
	expect(f.faux.state.callCount).toBe(0);
	f.faux.setResponses([fauxAssistantMessage("durable result")]);
	await first.session.run("remember this");
	const file = first.session.sessionFile!;
	await first.session.dispose();
	const before = await readFile(file);
	const second = await f.create("persisted", full, { kind: "file", directory, sessionFile: file });
	expect(f.faux.state.callCount).toBe(1);
	expect(second.session.sessionId).toBe(first.session.sessionId);
	expect(JSON.stringify(second.session.context())).toContain("durable result");
	await second.session.dispose();
	await expect(f.create("other-root", full, { kind: "file", directory, sessionFile: file })).rejects.toThrow(/owner/);
	expect(await readFile(file)).toEqual(before);
	const empty = join(directory, "empty.jsonl");
	await writeFile(empty, "");
	await expect(f.create("persisted", full, { kind: "file", directory, sessionFile: empty })).rejects.toThrow();
	expect(await readFile(empty, "utf8")).toBe("");
});

test("an unstarted persistent child can be reopened without a provider request", async () => {
	const f = await fixture();
	const directory = join(f.root, "unstarted");
	const first = await f.create("unstarted", full, { kind: "file", directory });
	const file = first.session.sessionFile!;
	await first.session.dispose();
	const reopened = await f.create("unstarted", full, { kind: "file", directory, sessionFile: file });
	expect(reopened.session.sessionId).toBe(first.session.sessionId);
	expect(f.faux.state.callCount).toBe(0);
});

test("controller unload and cold followup preserve native history without replay", async () => {
	const f = await fixture();
	const path = join(f.root, "team", "registry.sqlite");
	const caller = { rootSessionId: "team", agentPath: "/root" };
	const make = () => {
		const store = new CollaborationStore({ path, cwd: f.cwd, rootSessionId: "team" });
		const controller = new CollaborationController({
			store,
			host: f.host,
			agentDir: join(f.root, "agent"),
			getPermissions: full,
		});
		cleanups.push(() => controller.shutdown());
		return { store, controller };
	};
	const first = make();
	for (let index = 0; index < 4; index++) {
		f.faux.setResponses([fauxAssistantMessage(`durable-${index}`)]);
		await first.controller.spawn(caller, `worker${index}`, `task-${index}`, {
			provider: f.faux.provider.id,
			id: f.faux.getModel().id,
			thinkingLevel: "off",
		});
		await first.controller.settled();
	}
	expect(first.controller.list(caller).filter((agent) => agent.loaded)).toHaveLength(3);
	expect(first.controller.list(caller)[0].loaded).toBe(false);
	await first.controller.shutdown();
	const second = make();
	expect(second.controller.list(caller).every((agent) => !agent.loaded)).toBe(true);
	expect(f.faux.state.callCount).toBe(4);
	let context: Context | undefined;
	f.faux.setResponses([
		(request) => {
			context = request;
			return fauxAssistantMessage("new explicit answer");
		},
	]);
	await second.controller.followup(caller, "worker0", "explicit followup");
	await second.controller.settled();
	expect(f.faux.state.callCount).toBe(5);
	expect(JSON.stringify(context?.messages)).toContain("durable-0");
	expect(JSON.stringify(context?.messages)).not.toContain("durable-1");
	expect(second.store.read().agents[0]).toMatchObject({ status: "completed", result: "new explicit answer" });
});

test("fork imports only the effective checkpoint and branch, survives cold load, and never replays parent tools", async () => {
	const f = await fixture();
	const parent = SessionManager.inMemory(f.cwd);
	const ancestor = parent.appendMessage({ role: "user", content: "discarded-before-checkpoint", timestamp: 1 });
	parent.appendMessage(fauxAssistantMessage("off-branch-answer"));
	parent.branch(ancestor);
	parent.appendCompactionCheckpoint(
		[
			{ role: "user", content: "effective checkpoint task", timestamp: 2 },
			fauxAssistantMessage("effective checkpoint answer"),
		],
		100,
	);
	parent.appendMessage({ role: "user", content: "current parent turn", timestamp: 3 });
	parent.appendMessage(
		fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "worker" }), { stopReason: "toolUse" }),
	);
	const fork = preparePiCollaborationFork(parent, { mode: "all" });
	expect(fork).toEqual(prepareCollaborationFork(parent.buildSessionContext().messages));
	expect(() => preparePiCollaborationFork(parent, { mode: "last-turns", turns: 1 })).toThrow(/unavailable/);
	const directory = join(f.root, "fork");
	const child = await f.create("forked", full, { kind: "file", directory }, fork);
	await child.session.dispose();
	const file = child.session.sessionFile!;
	const reopened = await f.create("forked", full, { kind: "file", directory, sessionFile: file });
	expect(f.faux.state.callCount).toBe(0);
	expect(reopened.session.context()).toEqual(fork);
	let captured: Context | undefined;
	f.faux.setResponses([
		(context) => {
			captured = context;
			return fauxAssistantMessage("child result");
		},
	]);
	await reopened.session.run("new child task");
	const serialized = JSON.stringify(captured?.messages);
	expect(serialized).toContain("effective checkpoint answer");
	expect(serialized).toContain("new child task");
	expect(reopened.session.forkContext({ mode: "last-turns", turns: 1 }).map((message) => message.role)).toEqual([
		"user",
		"assistant",
	]);
	expect(() => reopened.session.forkContext({ mode: "last-turns", turns: 2 })).toThrow(/unavailable/);
	expect(serialized).not.toContain("discarded-before-checkpoint");
	expect(serialized).not.toContain("off-branch-answer");
	expect(
		captured?.messages.some(
			(message) => message.role === "assistant" && message.content.some((item) => item.type === "toolCall"),
		),
	).toBe(false);
	await expect(f.create("forked", full, { kind: "file", directory, sessionFile: file }, fork)).rejects.toThrow(
		/existing child/,
	);
});

test("startup cancellation cleans native bindings after an asynchronous extension returns", async () => {
	const entered = deferred();
	const release = deferred();
	const f = await fixture(() => [
		(pi) => {
			pi.on("session_start", async () => {
				entered.resolve();
				await release.promise;
			});
		},
	]);
	const abort = new AbortController();
	const creating = f.create("cancelled-start", full, { kind: "memory" }, undefined, abort.signal);
	const rejected = expect(creating).rejects.toThrow();
	await entered.promise;
	abort.abort();
	release.resolve();
	await rejected;
	expect(f.shutdowns).toEqual(["cancelled-start"]);
	expect(f.faux.state.callCount).toBe(0);
});

test("abort before asynchronous preflight completes cannot start a provider request", async () => {
	const entered = deferred();
	const release = deferred();
	const f = await fixture(() => [
		(pi) => {
			pi.on("before_agent_start", async () => {
				entered.resolve();
				await release.promise;
			});
		},
	]);
	const child = await f.create("abort", full);
	const run = child.session.run("blocked preflight");
	await entered.promise;
	const abort = child.session.abort();
	release.resolve();
	expect(await run).toMatchObject({ status: "interrupted" });
	await abort;
	expect(f.faux.state.callCount).toBe(0);
});

test("abort cancels an active provider stream and preserves the reusable child session", async () => {
	const f = await fixture();
	const child = await f.create("active-abort", full);
	const entered = deferred();
	f.faux.setResponses([
		(_context, options) =>
			new Promise<AssistantMessage>((resolve) => {
				options?.signal?.addEventListener(
					"abort",
					() => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
					{ once: true },
				);
				entered.resolve();
			}),
	]);
	const run = child.session.run("start provider");
	await entered.promise;
	await child.session.abort();
	expect(await run).toMatchObject({ status: "interrupted" });
	expect(f.faux.state.callCount).toBe(1);
	f.faux.setResponses([fauxAssistantMessage("explicit followup works")]);
	expect(await child.session.run("new explicit task")).toMatchObject({
		status: "completed",
		text: "explicit followup works",
	});
});

test("run admission is immediate and dispose prevents a deferred run from starting", async () => {
	const f = await fixture();
	const child = await f.create("closing", full);
	const run = child.session.run("start");
	expect(() => child.session.run("duplicate")).toThrow(/already running/);
	const closing = child.session.dispose();
	expect(await run).toMatchObject({ status: "interrupted" });
	await closing;
	expect(f.faux.state.callCount).toBe(0);
	expect(() => child.session.run("after close")).toThrow(/closed/);
});

test("child extension provider cleanup cannot unregister a root-owned provider", async () => {
	const f = await fixture(() => [
		(pi) => {
			pi.on("session_shutdown", () => {
				pi.unregisterProvider("native-host-faux");
			});
		},
	]);
	const child = await f.create("provider-isolation", full);
	await child.session.dispose();
	expect(f.runtime.getModel(f.faux.provider.id, f.faux.getModel().id)).toBeDefined();
});

test("initial and cold followup requests carry the deliver_result contract without repairing invalid real-provider output", async () => {
	const f = await fixture();
	const caller = { rootSessionId: "result-contract", agentPath: "/root" };
	const reference = {
		path: "evidence.txt",
		sha256: "dd04b89cadf9af64537e008365c20ff80f5f87d6278a9c91fa6bbe796c85f429",
		start_line: 1,
		end_line: 1,
	};
	const delegation = validateDelegation({
		task: taskContract("Extract the numeric result from the supplied evidence."),
		context: { mode: "curated", references: [reference] },
		capabilities: { tools: "inherit" },
	});
	// Removed result sections (artifacts/evidence/checks/risks) are rejected; the summary carries the citation.
	const invalid = JSON.stringify({
		summary: "CURATED_SYNTHETIC_B92A: 17",
		outcome: "succeeded",
		evidence: [{ path: reference.path, sha256: reference.sha256, observation: "8+9=17" }],
	});
	const valid = JSON.stringify({
		summary: `CURATED_SYNTHETIC_B92A: 17 — evidence ${reference.path}:1 sha256=${reference.sha256}; 8+9=17`,
		outcome: "succeeded",
	});
	const requests: Context[] = [];
	const make = () => {
		const store = new CollaborationStore({
			path: join(f.root, "result-contract", "registry.sqlite"),
			cwd: f.cwd,
			rootSessionId: caller.rootSessionId,
		});
		const controller = new CollaborationController({
			store,
			host: f.host,
			agentDir: join(f.root, "agent"),
			getPermissions: full,
		});
		cleanups.push(() => controller.shutdown());
		return { store, controller };
	};
	f.faux.setResponses(
		[invalid, valid].map((text) => (context: Context) => {
			// Tool executes are functions; keep the wire-visible shape only.
			requests.push(
				JSON.parse(
					JSON.stringify({
						systemPrompt: context.systemPrompt,
						messages: context.messages,
						tools: context.tools?.map(({ name, parameters }) => ({ name, parameters })),
					}),
				),
			);
			return fauxAssistantMessage(text);
		}),
	);
	const first = make();
	await first.controller.spawn(
		caller,
		"worker",
		delegation.task.objective,
		{
			provider: f.faux.provider.id,
			id: f.faux.getModel().id,
			thinkingLevel: "off",
		},
		[
			{
				role: "user",
				content: JSON.stringify({ ...reference, text: "CURATED_SYNTHETIC_B92A: 8+9=17" }),
				timestamp: 1,
			},
		],
		undefined,
		{ delegation, tools: [] },
	);
	await first.controller.settled();
	expect(f.faux.state.callCount).toBe(1);
	expect(first.store.read().agents[0]).toMatchObject({
		status: "completed",
		result: invalid,
		resultValidation: { contract: "invalid" },
	});
	expect(first.store.read().messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				to: "/root",
				kind: "result",
				text: invalid,
				resultValidation: { contract: "invalid" },
			}),
		]),
	);
	await first.controller.shutdown();
	const second = make();
	expect(f.faux.state.callCount).toBe(1);
	await second.controller.followup(caller, "worker", "Explicit new task", undefined, {
		delegation: { ...delegation, task: { ...delegation.task, objective: "Explicit new task" } },
		tools: [],
	});
	await second.controller.settled();
	expect(f.faux.state.callCount).toBe(2);
	expect(second.store.read().agents[0]).toMatchObject({
		result: valid,
		resultValidation: { contract: "valid", outcome: "succeeded" },
	});
	for (const context of requests) {
		const message = context.messages.at(-1)!;
		expect(message.role).toBe("user");
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		const deliver = context.tools?.find((tool) => tool.name === DELIVER_RESULT_TOOL_NAME);
		expect(deliver, "the actual provider request must carry the deliver_result tool").toBeDefined();
		expect(deliver!.parameters).toEqual(DelegationResultSchema);
		expect(text).toContain("only summary and outcome are required");
		expect(text).toContain("residual risks in the summary text");
		expect(text).toContain(`${COLLABORATION_LIMITS.maxMessageBytes} UTF-8 bytes`);
		expect(context.systemPrompt).not.toContain("Final result JSON Schema:");
	}
	expect(JSON.stringify(requests[1].messages)).toContain("This follow-up retains your existing child history");
});

test("the deliver_result protocol tool overrides the final text, replaces earlier deliveries, and works despite an empty delegated tool list", async () => {
	const f = await fixture();
	const caller = { rootSessionId: "deliver-tool", agentPath: "/root" };
	const first = {
		summary:
			"CURATED_SYNTHETIC_B92A: 17 — evidence.txt:1 sha256=dd04b89cadf9af64537e008365c20ff80f5f87d6278a9c91fa6bbe796c85f429; 8+9=17",
		outcome: "succeeded",
	};
	const second = { ...first, summary: "CURATED_SYNTHETIC_B92A: 18" };
	const delegation = validateDelegation({
		task: taskContract("Compute the numeric result from the supplied evidence."),
		context: { mode: "isolated" },
		capabilities: { tools: "inherit" },
	});
	const store = new CollaborationStore({
		path: ":memory:",
		cwd: f.cwd,
		rootSessionId: caller.rootSessionId,
	});
	const controller = new CollaborationController({
		store,
		host: f.host,
		agentDir: join(f.root, "agent"),
		getPermissions: full,
	});
	cleanups.push(() => controller.shutdown());
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall(DELIVER_RESULT_TOOL_NAME, first), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall(DELIVER_RESULT_TOOL_NAME, second), { stopReason: "toolUse" }),
		fauxAssistantMessage("This narrative is not the contracted result."),
	]);
	await controller.spawn(
		caller,
		"worker",
		delegation.task.objective,
		{ provider: f.faux.provider.id, id: f.faux.getModel().id, thinkingLevel: "off" },
		[],
		undefined,
		{ delegation, tools: [] },
	);
	await controller.settled();
	expect(f.faux.state.callCount).toBe(3);
	expect(store.read().agents[0]).toMatchObject({
		status: "completed",
		result: JSON.stringify(second),
		resultValidation: { contract: "valid", outcome: "succeeded" },
	});
});

test("a failed extension startup rejects the host instead of silently continuing without its hooks", async () => {
	const f = await fixture(() => [
		(pi) => {
			pi.on("session_start", () => {
				throw new Error("synthetic failure");
			});
		},
	]);
	await expect(f.create("startup-error", full)).rejects.toThrow(/startup failed/);
	expect(f.faux.state.callCount).toBe(0);
});
