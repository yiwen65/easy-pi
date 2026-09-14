import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createEasyPiHarness } from "../src/extensions/easy-pi.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";
import {
	collaborationToolSchemas,
	getCollaborationPrefix,
	prepareCuratedCollaborationContext,
} from "../src/extensions/pi-collaboration-context.ts";
import { registerPiCollaborationTools } from "../src/extensions/pi-collaboration-tools.ts";
import { currentCollaborationPath, followupArgs, spawnArgs } from "./collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
	beforeBind?: (session: AgentSession) => void,
	childExtensions: InlineExtension[] = [],
	observeChild?: (session: AgentSession) => void,
) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-six-tools-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "collaboration-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const manager = SessionManager.create(cwd, join(cwd, "root-history"));
	const identity = { rootSessionId: manager.getSessionId(), agentPath: "/root" };
	let store = new CollaborationStore({
		path: join(cwd, "team", "registry.sqlite"),
		cwd,
		rootSessionId: identity.rootSessionId,
	});
	const settings = { compaction: { enabled: false }, retry: { enabled: false } };
	const getPermissions = (): ChildSessionPermissions => ({
		mode: "full-access",
		sessionGrants: [],
		protectedRoots: [cwd],
	});
	let controller: CollaborationController;
	const host = createPiChildSessionHost({
		modelRuntime,
		settings,
		noExtensions: true,
		getTools: () => session.getActiveToolNames(),
		additionalExtensions: () => childExtensions,
		observeSession: (_identity, native) => {
			observeChild?.(native);
			return () => {};
		},
		registerTools: (child, pi, getSession) =>
			registerPiCollaborationTools({ pi, controller, identity: child, getSession }),
	});
	controller = new CollaborationController({ store, host, agentDir: join(cwd, "agent"), getPermissions });
	let session: AgentSession;
	const settingsManager = SettingsManager.inMemory(settings);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			{
				name: "collaboration-root",
				factory: createEasyPiHarness({
					nativeSession: {
						getPermissions,
						registerTools: (pi) =>
							registerPiCollaborationTools({ pi, controller, identity, getSession: () => session }),
					},
				}),
			},
		],
	});
	await loader.reload();
	({ session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		settingsManager,
		resourceLoader: loader,
		sessionManager: manager,
	}));
	beforeBind?.(session);
	await session.bindExtensions({ mode: "rpc" });
	cleanups.push(async () => {
		await controller.shutdown();
		session.dispose();
	});
	const restart = async () => {
		const file = session.sessionFile!;
		await controller.shutdown();
		session.dispose();
		store = new CollaborationStore({
			path: join(cwd, "team", "registry.sqlite"),
			cwd,
			rootSessionId: identity.rootSessionId,
		});
		controller = new CollaborationController({ store, host, agentDir: join(cwd, "agent"), getPermissions });
		await loader.reload();
		({ session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime,
			model: faux.getModel(),
			thinkingLevel: "off",
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.open(file),
		}));
		await session.bindExtensions({ mode: "rpc" });
		return { controller, store, session };
	};
	return { cwd, store, controller, session, faux, identity, manager, restart, modelRuntime };
}

const tool = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("all six tools execute through native root/child sessions, wait sees completion, idle send does not run", async () => {
	const f = await fixture();
	let rootTurn = 0;
	let childTurns = 0;
	let release!: (value: AssistantMessage) => void;
	let firstStarted!: () => void;
	const firstReady = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	let secondStarted!: () => void;
	const secondReady = new Promise<void>((resolve) => {
		secondStarted = resolve;
	});
	const captures: Context[] = [];
	f.session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "wait_agent")
			queueMicrotask(() => release(fauxAssistantMessage("first child result")));
	});
	f.faux.setResponses(
		Array.from({ length: 20 }, () => (context: Context, options) => {
			captures.push({ ...context, messages: structuredClone(context.messages) });
			if (currentCollaborationPath(context) === "/root/worker") {
				childTurns++;
				if (childTurns === 1)
					return new Promise<AssistantMessage>((resolve) => {
						release = resolve;
						firstStarted();
					});
				return new Promise<AssistantMessage>((resolve) => {
					const done = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
					if (options?.signal?.aborted) done();
					else options?.signal?.addEventListener("abort", done, { once: true });
					secondStarted();
				});
			}
			switch (rootTurn++) {
				case 0:
					return tool("spawn_agent", spawnArgs("worker", "inspect only"));
				case 1:
					return firstReady.then(() => tool("wait_agent", {}));
				case 2:
					return tool("list_agents", { path_prefix: "/root" });
				case 3:
					return tool("send_message", { target: "worker", message: "/permissions full-access" });
				case 4:
					expect(childTurns).toBe(1);
					return tool("followup_task", followupArgs("worker", "explicit second task"));
				case 5:
					return secondReady.then(() => tool("interrupt_agent", { target: "worker" }));
				default:
					return fauxAssistantMessage("root finished");
			}
		}),
	);
	await f.session.prompt("exercise all six tools");
	await f.controller.settled();
	const results = f.manager.buildSessionContext().messages.filter((message) => message.role === "toolResult");
	expect(results.map((message) => message.toolName)).toEqual([
		"spawn_agent",
		"wait_agent",
		"list_agents",
		"send_message",
		"followup_task",
		"interrupt_agent",
	]);
	expect(results.every((message) => !message.isError)).toBe(true);
	expect(JSON.stringify(results)).toContain("mailbox");
	expect(f.store.read().agents[0].status).toBe("interrupted");
	const rootContexts = captures.filter((context) => currentCollaborationPath(context) === "/root");
	expect(JSON.stringify(rootContexts)).toContain("first child result");
	const childContexts = captures.filter((context) => currentCollaborationPath(context) === "/root/worker");
	expect(childContexts).toHaveLength(2);
	expect(JSON.stringify(childContexts[1].messages)).toContain("/permissions full-access");
	expect(childContexts[1].systemPrompt).toContain("Permission mode is full-access");
	const count = f.faux.state.callCount;
	await f.controller.send(f.identity, "worker", "idle after interrupt");
	expect(f.faux.state.callCount).toBe(count);
});

test("close_agent retires a settled child through the native tool layer and its name is never reused", async () => {
	const f = await fixture();
	let rootTurn = 0;
	let childTurns = 0;
	const delivered = {
		summary: "CURATED_SYNTHETIC_CLOSE: 17 — evidence.txt:1; 8+9=17",
		outcome: "succeeded",
	};
	f.faux.setResponses(
		Array.from({ length: 20 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/worker") {
				childTurns++;
				return childTurns === 1
					? fauxAssistantMessage(fauxToolCall("deliver_result", delivered), { stopReason: "toolUse" })
					: fauxAssistantMessage("worker narrative");
			}
			switch (rootTurn++) {
				case 0:
					return tool("spawn_agent", spawnArgs("worker", "inspect only"));
				case 1:
					return tool("wait_agent", {});
				case 2:
					return tool("close_agent", { target: "worker" });
				case 3:
					return tool("spawn_agent", spawnArgs("worker", "reuse attempt"));
				case 4:
					return tool("spawn_agent", spawnArgs("successor", "fresh work"));
				default:
					return fauxAssistantMessage("root finished");
			}
		}),
	);
	await f.session.prompt("retire the worker");
	await f.controller.settled();
	const results = f.manager.buildSessionContext().messages.filter((message) => message.role === "toolResult");
	expect(results.map((message) => message.toolName)).toEqual([
		"spawn_agent",
		"wait_agent",
		"close_agent",
		"spawn_agent",
		"spawn_agent",
	]);
	expect(results[2].isError).toBe(false);
	expect(results[2]).toMatchObject({ details: { previous_status: "completed" } });
	expect(results[3].isError).toBe(true);
	expect(JSON.stringify(results[3])).toContain("Offending values: worker.");
	expect(results[4].isError).toBe(false);
	const agents = f.store.read().agents;
	expect(agents.find((agent) => agent.path === "/root/worker")).toMatchObject({
		status: "closed",
		completionPending: false,
		result: JSON.stringify(delivered),
		resultValidation: { contract: "valid", outcome: "succeeded" },
	});
	const successor = agents.find((agent) => agent.path === "/root/successor");
	expect(successor).toBeDefined();
	expect(successor!.tools).not.toContain("deliver_result");
});

test("mail is injected once, persisted before ack, and an idle root never starts from delivery", async () => {
	const f = await fixture();
	const id = await f.controller.send(f.identity, "/root", "unique durable mailbox text");
	expect(f.faux.state.callCount).toBe(0);
	const contexts: Context[] = [];
	f.faux.setResponses(
		Array.from({ length: 2 }, () => (context: Context) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			return fauxAssistantMessage("answer");
		}),
	);
	await f.session.prompt("first explicit turn");
	await f.session.prompt("second explicit turn");
	await f.controller.settled();
	for (const context of contexts)
		expect(JSON.stringify(context.messages).match(/unique durable mailbox text/g)).toHaveLength(1);
	expect(f.controller.pending(f.identity)).toEqual([]);
	expect(
		f.manager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "epi-collaboration-message"),
	).toHaveLength(1);
	const reopened = SessionManager.open(f.session.sessionFile!);
	expect(JSON.stringify(reopened.getBranch())).toContain(id);
});

test("failed ack stops provider execution and keeps the message for explicit recovery", async () => {
	const f = await fixture();
	f.faux.setResponses([fauxAssistantMessage("establish persistent root")]);
	await f.session.prompt("initial");
	const id = await f.controller.send(f.identity, "/root", "retained after ack failure");
	vi.spyOn(f.store, "commit").mockImplementationOnce(() => {
		throw new Error("synthetic secret must not escape");
	});
	await f.session.prompt("must not execute provider");
	expect(f.faux.state.callCount).toBe(1);
	expect(f.store.read().messages?.some((message) => message.id === id)).toBe(true);
	expect(
		f.manager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "epi-collaboration-message"),
	).toHaveLength(1);
	const resumed = await f.restart();
	expect(f.faux.state.callCount).toBe(1);
	let captured: Context | undefined;
	f.faux.setResponses([
		(context) => {
			captured = context;
			return fauxAssistantMessage("explicit recovery");
		},
	]);
	await resumed.session.prompt("explicit recovery turn");
	await resumed.controller.settled();
	expect(JSON.stringify(captured?.messages).match(/retained after ack failure/g)).toHaveLength(1);
	expect(resumed.controller.pending(f.identity)).toEqual([]);
});

test("child agents carry team tools in context but cannot use them", async () => {
	const children: AgentSession[] = [];
	const f = await fixture(undefined, [], (session) => children.push(session));
	let rootStep = 0;
	let workerStep = 0;
	f.faux.setResponses(
		Array.from({ length: 12 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/worker") {
				if (workerStep++ === 0) return tool("spawn_agent", spawnArgs("leaf", "nested work"));
				return fauxAssistantMessage("worker complete");
			}
			if (rootStep++ === 0) return tool("spawn_agent", spawnArgs("worker", "flat work"));
			return fauxAssistantMessage("root idle");
		}),
	);
	await f.session.prompt("flat team");
	await f.controller.settled();
	// The worker's spawn attempt is rejected and no nested agent is created.
	expect(f.controller.list(f.identity).map((agent) => agent.task_name)).toEqual(["/root/worker"]);
	expect(f.store.read().agents.every((agent) => agent.status === "completed")).toBe(true);
	// Team tools stay visible in child contexts so preserved prefixes remain byte-identical.
	expect(children).toHaveLength(1);
	expect(children[0]!.getActiveToolNames()).toEqual(expect.arrayContaining(["spawn_agent"]));
	expect(JSON.stringify(children[0]!.agent.state.messages)).toContain("nested_delegation");
});

test("native user steering wakes wait without polling or cancelling a child", async () => {
	const f = await fixture();
	const steering: Promise<void>[] = [];
	f.session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "wait_agent")
			steering.push(f.session.steer("new user instruction takes priority"));
	});
	let context: Context | undefined;
	f.faux.setResponses([
		tool("wait_agent", {}),
		(request) => {
			context = request;
			return fauxAssistantMessage("steered");
		},
	]);
	await f.session.prompt("wait for activity");
	await Promise.all(steering);
	expect(JSON.stringify(context?.messages)).toContain("user_input");
	expect(JSON.stringify(context?.messages)).toContain("new user instruction takes priority");
	expect(f.faux.state.callCount).toBe(2);
});

test("settings-injected child model fails explicitly, invalid roots fail safely, and no child request is made", async () => {
	const f = await fixture();
	// Child model/effort come from user settings, not per-call arguments.
	f.session.settingsManager.setSubagentModel("missing/model");
	f.faux.setResponses([
		tool("spawn_agent", spawnArgs("bad", "task")),
		tool("followup_task", followupArgs("/root", "not allowed")),
		tool("interrupt_agent", { target: "/root" }),
		fauxAssistantMessage("rejected"),
	]);
	await f.session.prompt("validate error boundaries");
	const results = f.manager.buildSessionContext().messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(3);
	expect(results.every((message) => message.isError)).toBe(true);
	expect(JSON.stringify(results)).toContain("invalid_arguments");
	expect(JSON.stringify(results)).toContain("model_unavailable");
	// Model/effort configuration is now validated before reserving a child.
	expect(f.store.read().agents).toEqual([]);
	expect(f.faux.state.callCount).toBe(4);
});

test("settings-injected model selects the provider while an unsupported effort is rejected", async () => {
	const f = await fixture();
	const alternate = fauxProvider({ provider: "alternate-faux", tokensPerSecond: 0 });
	f.modelRuntime.registerNativeProvider(alternate.provider);
	let captured: Context | undefined;
	alternate.setResponses([
		(context) => {
			captured = context;
			return fauxAssistantMessage("alternate child result");
		},
	]);
	f.session.settingsManager.setSubagentModel(`alternate-faux/${alternate.getModel().id}`);
	f.faux.setResponses([
		tool(
			"spawn_agent",
			spawnArgs("alternate", "separate provider", { mode: "fork", turns: "all", prefix: "rebuild" }),
		),
		fauxAssistantMessage("root done"),
	]);
	await f.session.prompt("inherited context marker");
	await f.controller.settled();
	expect(alternate.state.callCount).toBe(1);
	expect(f.faux.state.callCount).toBe(2);

	// Phase two: an effort the selected child model does not support is rejected before admission.
	f.session.settingsManager.setSubagentThinkingLevel("max");
	f.faux.setResponses([tool("spawn_agent", spawnArgs("unsupported", "task")), fauxAssistantMessage("root done 2")]);
	await f.session.prompt("phase two");
	await f.controller.settled();
	expect(f.faux.state.callCount).toBe(4);
	expect(JSON.stringify(captured?.messages)).toContain("inherited context marker");
	expect(captured?.tools?.map((item) => item.name)).toEqual(
		expect.arrayContaining([
			"spawn_agent",
			"send_message",
			"followup_task",
			"wait_agent",
			"interrupt_agent",
			"list_agents",
		]),
	);
	expect(captured?.tools?.some((item) => item.name === "subagent")).toBe(false);
	expect(f.store.read().agents.map((agent) => agent.status)).toEqual(["completed"]);
	expect(JSON.stringify(f.session.messages)).toContain("effort_unsupported");
});

test("a checkpoint after native ingestion does not resurrect raw mailbox text during ack recovery", async () => {
	const f = await fixture();
	f.faux.setResponses([fauxAssistantMessage("initial")]);
	await f.session.prompt("establish file");
	const id = await f.controller.send(f.identity, "/root", "raw pre-checkpoint message");
	vi.spyOn(f.store, "commit").mockImplementationOnce(() => {
		throw new Error("ack failure");
	});
	await f.session.prompt("ingest but fail ack");
	f.manager.appendCompactionCheckpoint(
		[{ role: "user", content: "retained summary of prior activity", timestamp: Date.now() }],
		100,
	);
	const restarted = await f.restart();
	let captured: Context | undefined;
	f.faux.setResponses([
		(context) => {
			captured = context;
			return fauxAssistantMessage("explicit continuation");
		},
	]);
	await restarted.session.prompt("continue explicitly");
	await restarted.controller.settled();
	expect(JSON.stringify(captured?.messages)).toContain("retained summary of prior activity");
	expect(JSON.stringify(captured?.messages)).not.toContain("raw pre-checkpoint message");
	expect(restarted.controller.pending(f.identity)).toEqual([]);
	expect(JSON.stringify(restarted.session.sessionManager.getBranch())).toContain(id);
});

test("mailbox ingestion precedes Pi compaction transform and restores the prior host seam on shutdown", async () => {
	let sawBeforePreflight = false;
	let observer: AgentSession["agent"]["transformContext"];
	const f = await fixture((session) => {
		const previous = session.agent.transformContext;
		observer = async (messages, signal) => {
			sawBeforePreflight = JSON.stringify(messages).includes("mailbox before preflight");
			expect(session.sessionManager.getBranch().some((entry) => entry.type === "custom_message")).toBe(true);
			return previous ? await previous(messages, signal) : messages;
		};
		session.agent.transformContext = observer;
	});
	await f.controller.send(f.identity, "/root", "mailbox before preflight");
	f.faux.setResponses([fauxAssistantMessage("done")]);
	await f.session.prompt("explicit request");
	expect(sawBeforePreflight).toBe(true);
	await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	expect(f.session.agent.transformContext).toBe(observer);
});

test("preserved fork uses the real neutral parent request prefix and appends the child assignment", async () => {
	const f = await fixture();
	let parentContext: Context | undefined;
	let childContext: Context | undefined;
	let roots = 0;
	f.faux.setResponses(
		Array.from({ length: 8 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/worker") {
				childContext = {
					...context,
					tools: collaborationToolSchemas(context.tools),
					messages: structuredClone(context.messages),
				};
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "Completed assigned task",
						outcome: "succeeded",
					}),
				);
			}
			if (roots++ === 0) {
				parentContext = {
					...context,
					tools: collaborationToolSchemas(context.tools),
					messages: structuredClone(context.messages),
				};
				return tool(
					"spawn_agent",
					spawnArgs("worker", "only child task", { mode: "fork", turns: "all", prefix: "preserve" }),
				);
			}
			return fauxAssistantMessage("root done");
		}),
	);
	await f.session.prompt("parent background marker");
	await f.controller.settled();
	expect(f.store.read().agents[0]?.status).toBe("completed");
	expect(childContext).toBeDefined();
	expect(childContext!.systemPrompt).toBe(parentContext!.systemPrompt);
	expect(childContext!.tools).toEqual(parentContext!.tools);
	expect(childContext!.messages.slice(0, parentContext!.messages.length)).toEqual(parentContext!.messages);
	expect(JSON.stringify(childContext!.messages.at(-1))).toContain("only child task");
	expect(childContext!.systemPrompt).not.toContain("Collaboration identity:");
	expect(f.controller.list(f.identity)[0]).toMatchObject({
		resultValidation: { contract: "valid" },
		context: { prefix: "required" },
	});
	const record = f.controller.inspect(f.identity, "worker");
	const child = SessionManager.open(record.sessionPath!);
	expect(child.getSessionId()).not.toBe(f.session.sessionId);
	expect(
		child.getEntries().some((entry) => entry.type === "custom" && entry.customType === "epi-collaboration-prefix"),
	).toBe(true);
});

test("prefix diagnostics distinguish missing captures, changed rules, tools and payload hooks", async () => {
	const f = await fixture();
	expect(() => getCollaborationPrefix(f.session)).toThrow(expect.objectContaining({ reason: "prefix_unavailable" }));
	f.faux.setResponses([fauxAssistantMessage("captured")]);
	await f.session.prompt("parent prefix");
	const tools = f.session.agent.state.tools;
	f.session.agent.state.tools = [];
	expect(() => getCollaborationPrefix(f.session)).toThrow(expect.objectContaining({ reason: "prefix_tools_changed" }));
	f.session.agent.state.tools = tools;
	const system = f.session.agent.state.systemPrompt;
	f.session.agent.state.systemPrompt = `${system}\nChanged rule`;
	expect(() => getCollaborationPrefix(f.session)).toThrow(expect.objectContaining({ reason: "prefix_rules_changed" }));
	f.session.agent.state.systemPrompt = system;
	const hooks = vi.spyOn(f.session.extensionRunner, "hasHandlers").mockReturnValue(true);
	expect(() => getCollaborationPrefix(f.session)).toThrow(expect.objectContaining({ reason: "prefix_payload_hook" }));
	hooks.mockRestore();
	expect(f.faux.state.callCount).toBe(1);
});

test("preserve rejects changed capability schemas before child admission, not by silently rebuilding", async () => {
	const f = await fixture();
	const args = spawnArgs("worker", "restricted task", { mode: "fork", turns: "all", prefix: "preserve" });
	f.faux.setResponses([tool("spawn_agent", { ...args, tools: ["read"] }), fauxAssistantMessage("rejected")]);
	await f.session.prompt("parent");
	await f.controller.settled();
	expect(f.store.read().agents).toEqual([]);
	expect(JSON.stringify(f.session.messages)).toContain("context_unavailable");
	expect(JSON.stringify(f.session.messages)).toContain("prefix_tools_changed");
	expect(f.faux.state.callCount).toBe(2);
});

test("the minimal delegation form spawns with canonical defaults persisted", async () => {
	const f = await fixture();
	let rootStep = 0;
	f.faux.setResponses(
		Array.from({ length: 6 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/lite") return fauxAssistantMessage("child done");
			if (rootStep++ === 0) return tool("spawn_agent", { task_name: "lite", task: { objective: "smallest probe" } });
			return fauxAssistantMessage("parent done");
		}),
	);
	await f.session.prompt("parent");
	await f.controller.settled();
	const record = f.store.read().agents.find((agent) => agent.path === "/root/lite");
	expect(record).toMatchObject({
		status: "completed",
		delegation: {
			version: 1,
			task: {
				relationship: "continue",
				objective: "smallest probe",
			},
			// context derived from relationship=continue: fork the conversation (all turns, rebuilt prefix)
			context: { mode: "fork", turns: "all", prefix: "rebuild" },
			capabilities: { tools: "inherit" },
		},
	});
});

test("namespaced tool names normalize before the ceiling check; unknown names fail with the available list", async () => {
	const f = await fixture();
	let rootStep = 0;
	const readerArgs = spawnArgs("reader", "read-only probe");
	const writerArgs = spawnArgs("writer", "write probe");
	f.faux.setResponses(
		Array.from({ length: 8 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/reader") return fauxAssistantMessage("child done");
			const step = rootStep++;
			if (step === 0)
				return tool("spawn_agent", {
					...readerArgs,
					tools: ["functions.read"],
				});
			if (step === 1) return fauxAssistantMessage("first spawn settled");
			if (step === 2)
				return tool("spawn_agent", {
					...writerArgs,
					tools: ["functions.laser_beam"],
				});
			return fauxAssistantMessage("rejected");
		}),
	);
	await f.session.prompt("parent");
	await f.controller.settled();
	// functions.read normalized to the bare name: the child was admitted and ran
	expect(f.store.read().agents[0]?.path).toBe("/root/reader");

	await f.session.prompt("parent2");
	await f.controller.settled();
	// a genuinely unknown name is still refused, and the error now lists what is available
	expect(f.store.read().agents.some((agent) => agent.path === "/root/writer")).toBe(false);
	expect(JSON.stringify(f.session.messages)).toContain("Available:");
});

test("isolated verifier sees its assignment but no parent goals and cannot invoke excluded bash", async () => {
	const f = await fixture();
	let rootStep = 0;
	let childStep = 0;
	let childContext: Context | undefined;
	const args = spawnArgs("reviewer", "independent verification");
	args.task.relationship = "verify";
	f.faux.setResponses(
		Array.from({ length: 8 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/reviewer") {
				childContext ??= context;
				if (childStep++ === 0) return tool("bash", { command: "printf unauthorized > should-not-exist" });
				return fauxAssistantMessage("unstructured result is retained");
			}
			if (rootStep++ === 0)
				return tool("spawn_agent", {
					...args,
					tools: ["read"],
				});
			return fauxAssistantMessage("root finished");
		}),
	);
	await f.session.prompt("PARENT_CONCLUSION_SECRET: the implementation is certainly correct");
	await f.controller.settled();
	expect(JSON.stringify(childContext?.messages)).not.toContain("PARENT_CONCLUSION_SECRET");
	expect(JSON.stringify(childContext?.messages)).toContain("independent verification");
	// The host-owned protocol tool is structurally available to every child, on top of the delegated set.
	expect(childContext?.tools?.map((item) => item.name)).toEqual(["deliver_result", "read"]);
	expect(existsSync(join(f.cwd, "should-not-exist"))).toBe(false);
	expect(f.store.read().agents[0]).toMatchObject({
		result: "unstructured result is retained",
		resultValidation: { contract: "invalid" },
	});
});

test("live root tool revocation blocks an already-advertised child tool", async () => {
	const f = await fixture();
	let rootStep = 0;
	let childStep = 0;
	f.faux.setResponses(
		Array.from({ length: 8 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/worker") {
				if (childStep++ === 0) {
					expect(context.tools?.some((item) => item.name === "bash")).toBe(true);
					f.session.setActiveToolsByName(f.session.getActiveToolNames().filter((name) => name !== "bash"));
					return tool("bash", { command: "printf unauthorized > revoked-tool-output" });
				}
				return fauxAssistantMessage("blocked");
			}
			if (rootStep++ === 0) return tool("spawn_agent", spawnArgs("worker", "check revocation"));
			return fauxAssistantMessage("root finished");
		}),
	);
	await f.session.prompt("exercise runtime gate");
	await f.controller.settled();
	expect(existsSync(join(f.cwd, "revoked-tool-output"))).toBe(false);
	const record = f.controller.inspect(f.identity, "worker");
	const messages = SessionManager.open(record.sessionPath!).buildSessionContext().messages;
	expect(
		messages.some((message) => message.role === "toolResult" && message.toolName === "bash" && message.isError),
	).toBe(true);
});

test("curated context uses exact hash-pinned lines and rejects changed, denied and symlink sources", async () => {
	const f = await fixture();
	const text = "first line\nselected evidence\nlast line";
	await writeFile(join(f.cwd, "evidence.txt"), text);
	const policy = {
		mode: "curated" as const,
		references: [
			{ path: "evidence.txt", sha256: createHash("sha256").update(text).digest("hex"), start_line: 2, end_line: 2 },
		],
	};
	const messages = await prepareCuratedCollaborationContext(f.session, policy);
	expect(JSON.stringify(messages)).toContain("selected evidence");
	expect(JSON.stringify(messages)).not.toContain("first line");
	expect(JSON.stringify(messages)).toContain(policy.references[0].sha256);
	const gate = vi
		.spyOn(f.session.extensionRunner, "emitToolCall")
		.mockResolvedValueOnce({ block: true, reason: "denied" });
	await expect(prepareCuratedCollaborationContext(f.session, policy)).rejects.toThrow(/blocked/);
	gate.mockRestore();
	await symlink(join(f.cwd, "evidence.txt"), join(f.cwd, "alias.txt"));
	await expect(
		prepareCuratedCollaborationContext(f.session, {
			...policy,
			references: [{ ...policy.references[0], path: "alias.txt" }],
		}),
	).rejects.toThrow(/nonsymlink/);
	await writeFile(join(f.cwd, "evidence.txt"), "changed");
	await expect(prepareCuratedCollaborationContext(f.session, policy)).rejects.toMatchObject({
		reason: "source_hash_changed",
	});
	expect(f.faux.state.callCount).toBe(0);
});

test("a rebuilt child rule mismatch fails before inference and returns an actionable prefix failure", async () => {
	const f = await fixture(undefined, [
		(pi) => {
			pi.on("before_agent_start", (event) => ({
				systemPrompt: `${event.systemPrompt}\nAdditional child-only policy`,
			}));
		},
	]);
	f.faux.setResponses([
		tool("spawn_agent", spawnArgs("worker", "preserve", { mode: "fork", turns: "all", prefix: "preserve" })),
		fauxAssistantMessage("root done"),
	]);
	await f.session.prompt("parent context");
	await f.controller.settled();
	expect(f.faux.state.callCount).toBe(2);
	expect(f.store.read().agents[0]).toMatchObject({
		status: "failed",
		resultValidation: { contract: "not_completed" },
	});
	expect(f.store.read().agents[0].result).toContain("no child inference was started");
});

test("a checkpoint change during the spawn batch cannot resurrect the older captured prefix", async () => {
	const f = await fixture();
	f.session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "spawn_agent")
			f.manager.appendCompactionCheckpoint([{ role: "user", content: "replacement checkpoint", timestamp: 4 }], 100);
	});
	f.faux.setResponses([
		tool("spawn_agent", spawnArgs("worker", "preserve", { mode: "fork", turns: "all", prefix: "preserve" })),
		fauxAssistantMessage("root done"),
	]);
	await f.session.prompt("old replaced context");
	await f.controller.settled();
	expect(f.store.read().agents).toEqual([]);
	expect(f.faux.state.callCount).toBe(2);
});

test("execution gate blocks a restricted tool even if a trusted host re-advertises its schema", async () => {
	let nativeChild: AgentSession;
	let bash: AgentSession["agent"]["state"]["tools"][number];
	const f = await fixture(
		undefined,
		[
			(pi) => {
				// setActiveTools cannot bypass the SDK allowlist. Deliberately exercise the
				// stronger public host seam instead, so this test reaches execution gating.
				pi.on("before_agent_start", () => {
					nativeChild.agent.state.tools = [...nativeChild.agent.state.tools, bash];
				});
			},
		],
		(native) => {
			nativeChild = native;
		},
	);
	bash = f.session.agent.state.tools.find((tool) => tool.name === "bash")!;
	let root = 0;
	let child = 0;
	f.faux.setResponses(
		Array.from({ length: 8 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/worker") {
				if (child++ === 0) {
					expect(context.tools?.some((tool) => tool.name === "bash")).toBe(true);
					return tool("bash", { command: "printf forbidden > read-only-bypass" });
				}
				return fauxAssistantMessage("gate checked");
			}
			if (root++ === 0) {
				const args = spawnArgs("worker", "restricted");
				return tool("spawn_agent", {
					...args,
					tools: ["read"],
				});
			}
			return fauxAssistantMessage("root done");
		}),
	);
	await f.session.prompt("root");
	await f.controller.settled();
	expect(existsSync(join(f.cwd, "read-only-bypass"))).toBe(false);
	const record = f.controller.inspect(f.identity, "worker");
	expect(JSON.stringify(SessionManager.open(record.sessionPath!).buildSessionContext().messages)).toContain(
		"Tool denied by live delegation ancestry",
	);
});

test("curated spawn sends only pinned evidence and the current assignment, not parent beliefs", async () => {
	const f = await fixture();
	const text = "omitted source line\npinned evidence line\n";
	await writeFile(join(f.cwd, "source.txt"), text);
	const args = spawnArgs("reviewer", "verify the evidence", {
		mode: "curated",
		references: [
			{ path: "source.txt", sha256: createHash("sha256").update(text).digest("hex"), start_line: 2, end_line: 2 },
		],
	});
	args.task.relationship = "verify";
	let root = 0;
	let captured: Context | undefined;
	f.faux.setResponses(
		Array.from({ length: 6 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/reviewer") {
				captured = context;
				return fauxAssistantMessage("review result");
			}
			return root++ === 0 ? tool("spawn_agent", args) : fauxAssistantMessage("root done");
		}),
	);
	await f.session.prompt("PARENT_BELIEF_DO_NOT_COPY");
	await f.controller.settled();
	expect(f.store.read().agents[0].status).toBe("completed");
	expect(JSON.stringify(captured?.messages)).toContain("pinned evidence line");
	expect(JSON.stringify(captured?.messages)).not.toContain("omitted source line");
	expect(JSON.stringify(captured?.messages)).not.toContain("PARENT_BELIEF_DO_NOT_COPY");
});

test("cold explicit followup retains the delegated ceiling and child history without startup replay", async () => {
	const f = await fixture();
	let root = 0;
	f.faux.setResponses(
		Array.from({ length: 6 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/worker") return fauxAssistantMessage("RETAINED_CHILD_RESULT");
			const args = spawnArgs("worker", "first task");
			return root++ === 0 ? tool("spawn_agent", { ...args, tools: ["read"] }) : fauxAssistantMessage("root done");
		}),
	);
	await f.session.prompt("initial delegation");
	await f.controller.settled();
	const calls = f.faux.state.callCount;
	const restarted = await f.restart();
	expect(f.faux.state.callCount).toBe(calls);
	root = 0;
	let captured: Context | undefined;
	f.faux.setResponses(
		Array.from({ length: 6 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/worker") {
				captured = context;
				return fauxAssistantMessage("second result");
			}
			return root++ === 0
				? tool("followup_task", followupArgs("worker", "second explicit task"))
				: fauxAssistantMessage("root done");
		}),
	);
	await restarted.session.prompt("explicitly continue the child");
	await restarted.controller.settled();
	// deliver_result stays structurally active across cold restarts; the delegated ceiling stays read-only.
	expect(captured?.tools?.map((tool) => tool.name)).toEqual(["deliver_result", "read"]);
	expect(JSON.stringify(captured?.messages)).toContain("RETAINED_CHILD_RESULT");
	expect(JSON.stringify(captured?.messages)).toContain("second explicit task");
	expect(restarted.store.read().agents[0].tools).toEqual(["read"]);
});

test("oversized final output retains full native text and a bounded explicitly truncated invalid result", async () => {
	const f = await fixture();
	const long = "界".repeat(4000);
	let root = 0;
	f.faux.setResponses(
		Array.from({ length: 6 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/worker") return fauxAssistantMessage(long);
			return root++ === 0
				? tool("spawn_agent", spawnArgs("worker", "produce output"))
				: fauxAssistantMessage("root done");
		}),
	);
	await f.session.prompt("initial delegation");
	await f.controller.settled();
	const record = f.controller.inspect(f.identity, "worker");
	expect(Buffer.byteLength(record.result!, "utf8")).toBeLessThanOrEqual(8192);
	expect(record.result).toContain("Preview truncated");
	expect(record.resultValidation?.contract).toBe("invalid");
	expect(JSON.stringify(SessionManager.open(record.sessionPath!).buildSessionContext().messages)).toContain(long);
});

test("unexpected collaboration exceptions expose a safe hint, never their original payload", async () => {
	const f = await fixture();
	vi.spyOn(f.controller, "spawn").mockRejectedValueOnce(new Error("SYNTHETIC_CREDENTIAL_DO_NOT_ECHO"));
	f.faux.setResponses([tool("spawn_agent", spawnArgs("worker", "task")), fauxAssistantMessage("rejected")]);
	await f.session.prompt("exercise sanitized error");
	const results = f.session.messages.filter((message) => message.role === "toolResult");
	const text = JSON.stringify(results);
	expect(text).toContain("storage_error");
	expect(text).toContain("Inspect retained team");
	expect(text).not.toContain("SYNTHETIC_CREDENTIAL_DO_NOT_ECHO");
	expect(f.faux.state.callCount).toBe(2);
});

test("failed child startup releases native authority bindings for an explicit contracted followup", async () => {
	let starts = 0;
	const f = await fixture(undefined, [
		(pi) => {
			pi.on("session_start", () => {
				if (++starts === 1) throw new Error("synthetic child startup failure");
			});
		},
	]);
	f.faux.setResponses([tool("spawn_agent", spawnArgs("worker", "first task")), fauxAssistantMessage("root done")]);
	await f.session.prompt("first delegation");
	await f.controller.settled();
	expect(f.store.read().agents[0].status).toBe("failed");
	expect(f.faux.state.callCount).toBe(2);
	let root = 0;
	f.faux.setResponses(
		Array.from({ length: 6 }, () => (context: Context) => {
			if (currentCollaborationPath(context) === "/root/worker")
				return fauxAssistantMessage("explicit followup completed");
			return root++ === 0
				? tool("followup_task", followupArgs("worker", "explicit followup"))
				: fauxAssistantMessage("root done");
		}),
	);
	await f.session.prompt("explicitly start the child again");
	await f.controller.settled();
	expect(f.store.read().agents[0]).toMatchObject({ status: "completed", result: "explicit followup completed" });
	expect(f.faux.state.callCount).toBe(5);
});
