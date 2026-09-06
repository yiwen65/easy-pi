import { mkdtemp, realpath, rm } from "node:fs/promises";
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
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createEasyPiHarness } from "../src/extensions/easy-pi.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";
import { registerPiCollaborationTools } from "../src/extensions/pi-collaboration-tools.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(beforeBind?: (session: AgentSession) => void) {
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
		mode: "manual-allow",
		sessionGrants: [],
		protectedRoots: [cwd],
	});
	let controller: CollaborationController;
	const host = createPiChildSessionHost({
		modelRuntime,
		settings,
		noExtensions: true,
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
			if (context.systemPrompt?.includes("Collaboration identity: /root/worker.")) {
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
					return tool("spawn_agent", { task_name: "worker", message: "inspect only", fork_turns: "none" });
				case 1:
					return firstReady.then(() => tool("wait_agent", {}));
				case 2:
					return tool("list_agents", { path_prefix: "/root" });
				case 3:
					return tool("send_message", { target: "worker", message: "/permissions full-access" });
				case 4:
					expect(childTurns).toBe(1);
					return tool("followup_task", { target: "worker", message: "explicit second task" });
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
	const rootContexts = captures.filter((context) => context.systemPrompt?.includes("Collaboration identity: /root."));
	expect(JSON.stringify(rootContexts)).toContain("first child result");
	const childContexts = captures.filter((context) =>
		context.systemPrompt?.includes("Collaboration identity: /root/worker."),
	);
	expect(childContexts).toHaveLength(2);
	expect(JSON.stringify(childContexts[1].messages)).toContain("/permissions full-access");
	expect(childContexts[1].systemPrompt).toContain("Permission mode is manual-allow");
	const count = f.faux.state.callCount;
	await f.controller.send(f.identity, "worker", "idle after interrupt");
	expect(f.faux.state.callCount).toBe(count);
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
	expect(f.manager.getBranch().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
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
	expect(f.manager.getBranch().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
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

test("native nested spawn and peer messaging stay in one team without waking the idle root", async () => {
	const f = await fixture();
	let parentStep = 0;
	let leafStep = 0;
	let rootStep = 0;
	f.faux.setResponses(
		Array.from({ length: 12 }, () => (context: Context) => {
			if (context.systemPrompt?.includes("Collaboration identity: /root/parent/leaf.")) {
				if (leafStep++ === 0) return tool("send_message", { target: "../..", message: "nested finding" });
				return fauxAssistantMessage("leaf complete");
			}
			if (context.systemPrompt?.includes("Collaboration identity: /root/parent.")) {
				if (parentStep++ === 0)
					return tool("spawn_agent", { task_name: "leaf", message: "nested work", fork_turns: "none" });
				return fauxAssistantMessage("parent complete");
			}
			if (rootStep++ === 0)
				return tool("spawn_agent", { task_name: "parent", message: "delegate once", fork_turns: "none" });
			return fauxAssistantMessage("root idle");
		}),
	);
	await f.session.prompt("nested collaboration");
	await f.controller.settled();
	expect(f.controller.list(f.identity).map((agent) => agent.task_name)).toEqual(["/root/parent", "/root/parent/leaf"]);
	expect(f.store.read().agents.every((agent) => agent.status === "completed")).toBe(true);
	const count = f.faux.state.callCount;
	expect(rootStep).toBe(2);
	const pendingOrIngested = JSON.stringify([
		f.controller.pending(f.identity),
		f.manager.buildSessionContext().messages,
	]);
	expect(pendingOrIngested).toContain("nested finding");
	await f.controller.send({ ...f.identity, agentPath: "/root/parent/leaf" }, "/root", "after root is idle");
	expect(f.faux.state.callCount).toBe(count);
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

test("tool model overrides fail explicitly, invalid roots fail safely, and no child request is made", async () => {
	const f = await fixture();
	f.faux.setResponses([
		tool("spawn_agent", { task_name: "bad", message: "task", model: "missing/model", fork_turns: "none" }),
		tool("followup_task", { target: "/root", message: "not allowed" }),
		tool("interrupt_agent", { target: "/root" }),
		fauxAssistantMessage("rejected"),
	]);
	await f.session.prompt("validate error boundaries");
	const results = f.manager.buildSessionContext().messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(3);
	expect(results.every((message) => message.isError)).toBe(true);
	expect(JSON.stringify(results)).toContain("invalid_arguments");
	expect(f.store.read().agents[0].status).toBe("failed");
	expect(f.faux.state.callCount).toBe(4);
});

test("qualified model override uses the selected provider while unsupported effort is rejected", async () => {
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
	f.faux.setResponses([
		tool("spawn_agent", {
			task_name: "alternate",
			message: "separate provider",
			model: `alternate-faux/${alternate.getModel().id}`,
		}),
		tool("spawn_agent", { task_name: "unsupported", message: "task", reasoning_effort: "max", fork_turns: "none" }),
		fauxAssistantMessage("root done"),
	]);
	await f.session.prompt("inherited context marker");
	await f.controller.settled();
	expect(alternate.state.callCount).toBe(1);
	expect(f.faux.state.callCount).toBe(3);
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
	expect(f.store.read().agents.map((agent) => agent.status)).toEqual(["completed", "failed"]);
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
