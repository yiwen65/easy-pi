import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, ResourceScheduler } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	Type,
} from "@earendil-works/pi-ai";
import { validateDelegation } from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSession, ChildSessionCreateOptions } from "@easy-pi/subagent/session-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
} from "../../src/core/agent-session-runtime.ts";
import { createComputerSessionBinding } from "../../src/core/computer/binding.ts";
import {
	ComputerHost,
	type ComputerNativeOperation,
	type ComputerNativeSession,
} from "../../src/core/computer/host.ts";
import type { ExtensionFactory, InlineExtension } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createPiChildSessionHost } from "../../src/extensions/pi-child-session-host.ts";
import { PiCollaborationMonitor } from "../../src/extensions/pi-collaboration-monitor.ts";
import { registerPiCollaborationRoot } from "../../src/extensions/pi-collaboration-root.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

const toolName = "computer_lifecycle_fixture";
const resource = { key: "desktop:lifecycle-fixture", mode: "exclusive" as const };
const fullAccess = () => ({ mode: "full-access" as const, sessionGrants: [], protectedRoots: [] });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function completed(value: number): ComputerNativeOperation<number> {
	return { result: Promise.resolve(value), terminal: Promise.resolve(), cancel: vi.fn() };
}

interface NativeSession extends ComputerNativeSession {
	id: number;
	parent?: NativeSession;
	revoke: ReturnType<typeof vi.fn<() => void>>;
	close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

async function fixture() {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-computer-lifecycle-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const nativeSessions: NativeSession[] = [];
	const nativeRuntime = {
		openSession: vi.fn((parent?: NativeSession): NativeSession => {
			const session = { id: nativeSessions.length + 1, parent, revoke: vi.fn(), close: vi.fn(async () => {}) };
			nativeSessions.push(session);
			return session;
		}),
		close: vi.fn(async () => {}),
	};
	const createRuntime = vi.fn(() => nativeRuntime);
	const scheduler = new ResourceScheduler(1);
	const host = new ComputerHost({ desktopId: "lifecycle-fixture", scheduler, createRuntime });
	cleanups.push(async () => {
		if (host.quarantined) await expect(host.close()).rejects.toMatchObject({ code: "desktop_quarantined" });
		else await host.close();
	});
	const dispatch = vi.fn((native: NativeSession, _signal: AbortSignal) => completed(native.id));
	const binding = createComputerSessionBinding(host.openSession(), (session) => [
		{
			name: toolName,
			label: "Computer lifecycle fixture",
			description: "Fake native operation, not a P01/native tool bridge",
			parameters: Type.Object({}),
			executionResource: resource,
			async execute(_id, _params, signal) {
				const id = await session.run(dispatch, signal);
				return { content: [{ type: "text", text: String(id) }], details: { id } };
			},
		},
	]);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "computer-lifecycle-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const settings = { compaction: { enabled: false }, retry: { enabled: false } };
	async function sdk(options: Partial<CreateAgentSessionOptions> = {}, extensions: ExtensionFactory[] = []) {
		const extensionsResult = await createTestExtensionsResult(extensions, cwd);
		const result = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime,
			model: faux.getModel(),
			settingsManager: SettingsManager.inMemory(settings),
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			...options,
		});
		cleanups.push(async () => {
			if (host.quarantined)
				await expect(result.session.shutdown()).rejects.toMatchObject({ code: "desktop_quarantined" });
			else await result.session.shutdown();
		});
		await result.session.bindExtensions({ onError: () => {} });
		return result.session;
	}
	function tool(session: AgentSession): AgentTool {
		const found = session.agent.state.tools.find((candidate) => candidate.name === toolName);
		if (!found) throw new Error("Missing fixture tool");
		return found;
	}
	async function prompt(session: AgentSession) {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("Use the fake computer.");
		return session.messages.filter((message) => message.role === "toolResult").at(-1);
	}
	function childHost(
		root: AgentSession,
		additionalExtensions?: () => InlineExtension[],
		observe?: (session: AgentSession) => void,
	) {
		const sessions = new Map<string, AgentSession>();
		const child = createPiChildSessionHost({
			modelRuntime,
			settings,
			noExtensions: true,
			getComputer: () => root.computer,
			getTools: () => root.getActiveToolNames(),
			registerTools: () => {},
			additionalExtensions,
			observeSession(identity, session) {
				sessions.set(identity.agentPath, session);
				observe?.(session);
				return () => {};
			},
		});
		async function create(name: string, overrides: Partial<ChildSessionCreateOptions> = {}): Promise<ChildSession> {
			const session = await child.create({
				rootSessionId: root.sessionId,
				agentPath: `/root/${name}`,
				cwd,
				agentDir: cwd,
				model: { provider: faux.provider.id, id: faux.getModel().id, thinkingLevel: "off" },
				storage: { kind: "memory" },
				getPermissions: fullAccess,
				...overrides,
			});
			cleanups.push(() => session.dispose());
			return session;
		}
		return { host: child, sessions, create };
	}
	return {
		cwd,
		nativeRuntime,
		nativeSessions,
		createRuntime,
		scheduler,
		host,
		binding,
		dispatch,
		modelRuntime,
		faux,
		settings,
		sdk,
		tool,
		prompt,
		childHost,
	};
}

describe("explicit Computer SDK lifecycle", () => {
	it("keeps default tools unchanged and performs zero native initialization without opt-in or when suppressed", async () => {
		const f = await fixture();
		const ordinary = await f.sdk();
		expect(ordinary.computer).toBeUndefined();
		expect(ordinary.agent.executionScheduler).toBeUndefined();
		expect(ordinary.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
		expect(ordinary.getAllTools().map((tool) => tool.name)).not.toContain(toolName);
		const suppressed = await f.sdk({ computer: f.binding, noTools: "all" });
		expect(suppressed.getActiveToolNames()).toEqual([]);
		expect(suppressed.computer?.revoked).toBe(true);
		await ordinary.shutdown();
		await suppressed.shutdown();
		expect(f.createRuntime).not.toHaveBeenCalled();
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
	});

	it("uses the injected scheduler and keeps a session owner across separate decisions", async () => {
		const f = await fixture();
		const session = await f.sdk({ computer: f.binding });
		const acquire = vi.spyOn(f.scheduler, "acquire");
		expect(session.agent.executionScheduler).toBe(f.scheduler);
		expect(await f.prompt(session)).toMatchObject({ isError: false, details: { id: 1 } });
		expect(f.scheduler.runningCount).toBe(0);
		expect(await f.prompt(session)).toMatchObject({ isError: false, details: { id: 1 } });
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(f.nativeRuntime.openSession).toHaveBeenCalledTimes(1);
		expect(f.nativeSessions[0].close).not.toHaveBeenCalled();
	});

	it("rejects a snapshotted tool after narrowing while it waits for the shared scheduler", async () => {
		const f = await fixture();
		const session = await f.sdk({ computer: f.binding });
		const stale = f.tool(session);
		const held = await f.scheduler.acquire(resource);
		const waiting = deferred();
		session.agent.onExecutionEvent = (event) => {
			if (event.phase === "scheduler_wait" && event.outcome === "started") waiting.resolve();
		};
		const run = f.prompt(session);
		await waiting.promise;
		session.setActiveToolsByName(["read"]);
		expect(f.binding.revoked).toBe(true);
		session.setActiveToolsByName(["read", toolName]);
		expect(session.getActiveToolNames()).not.toContain(toolName);
		held?.release();
		expect(await run).toMatchObject({ isError: true });
		await expect(stale.execute("stale", {})).rejects.toMatchObject({ code: "session_revoked" });
		expect(f.createRuntime).not.toHaveBeenCalled();
		expect(f.scheduler.pendingCount).toBe(0);
	});

	it("ordinary abort cancels without revocation and retains scheduler admission until terminal acknowledgement", async () => {
		const f = await fixture();
		const session = await f.sdk({ computer: f.binding });
		const entered = deferred();
		const terminal = deferred();
		const cancel = vi.fn();
		f.dispatch.mockImplementationOnce((native) => {
			entered.resolve();
			return { result: Promise.resolve(native.id), terminal: terminal.promise, cancel };
		});
		const running = f.prompt(session);
		await entered.promise;
		let stopped = false;
		const abort = session.abort().then(() => {
			stopped = true;
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(f.binding.revoked).toBe(false);
		expect(f.scheduler.runningCount).toBe(1);
		await Promise.resolve();
		expect(stopped).toBe(false);
		terminal.resolve();
		await running;
		await abort;
		expect(await f.prompt(session)).toMatchObject({ isError: false, details: { id: 1 } });
	});

	it("shutdown revokes the subtree before native callbacks and awaits its own drain, never the shared runtime", async () => {
		const f = await fixture();
		const session = await f.sdk({ computer: f.binding });
		const child = f.binding.fork();
		const grandchild = child.fork();
		await f.prompt(session);
		const stale = f.tool(session);
		const closed = deferred();
		const closingEntered = deferred();
		const reentries: Promise<unknown>[] = [];
		f.nativeSessions[0].revoke.mockImplementation(() => {
			expect([f.binding.revoked, child.revoked, grandchild.revoked]).toEqual([true, true, true]);
			reentries.push(expect(stale.execute("reentrant", {})).rejects.toMatchObject({ code: "session_revoked" }));
			reentries.push(session.shutdown());
		});
		f.nativeSessions[0].close.mockImplementation(() => {
			closingEntered.resolve();
			return closed.promise;
		});
		let settled = false;
		const shuttingDown = session.shutdown().then(() => {
			settled = true;
		});
		expect(f.binding.revoked).toBe(true);
		await closingEntered.promise;
		expect(settled).toBe(false);
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
		closed.resolve();
		await shuttingDown;
		await Promise.all(reentries);
		expect(f.dispatch).toHaveBeenCalledTimes(1);
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
	});

	it.each(["shutdown", "reload"] as const)(
		"%s reports unknown native terminality even while the result promise remains pending",
		async (operation) => {
			const f = await fixture();
			const session = await f.sdk({ computer: f.binding });
			const entered = deferred();
			const terminal = deferred();
			const result = deferred<number>();
			f.dispatch.mockImplementationOnce(() => {
				entered.resolve();
				return { result: result.promise, terminal: terminal.promise, cancel: vi.fn() };
			});
			const running = f.prompt(session);
			await entered.promise;
			const closing = session[operation]();
			const rejected = expect(closing).rejects.toMatchObject({ code: "desktop_quarantined" });
			expect(f.binding.revoked).toBe(true);
			terminal.reject(new Error("no terminal proof"));
			await rejected;
			await running;
			expect(f.host.quarantined).toBe(true);
			expect(() => f.host.openSession()).toThrow("desktop_quarantined");
			expect(f.nativeRuntime.close).not.toHaveBeenCalled();
			expect(f.nativeSessions[0].close).not.toHaveBeenCalled();
			expect(f.dispatch).toHaveBeenCalledTimes(1);
		},
	);

	it("reload revokes before shutdown observers, awaits drain, and rebuilds only fresh binding closures", async () => {
		const f = await fixture();
		const staleCalls: Promise<unknown>[] = [];
		let stale!: AgentTool;
		const session = await f.sdk({ computer: f.binding }, [
			(pi) => {
				pi.on("session_shutdown", () => {
					expect(f.binding.revoked).toBe(true);
					staleCalls.push(
						expect(stale.execute("shutdown-hook", {})).rejects.toMatchObject({ code: "session_revoked" }),
					);
				});
			},
		]);
		stale = f.tool(session);
		await f.prompt(session);
		const closeEntered = deferred();
		const closed = deferred();
		f.nativeSessions[0].close.mockImplementation(() => {
			closeEntered.resolve();
			return closed.promise;
		});
		let reloaded = false;
		const reload = session.reload().then(() => {
			reloaded = true;
		});
		expect(f.binding.revoked).toBe(true);
		await closeEntered.promise;
		expect(reloaded).toBe(false);
		closed.resolve();
		await reload;
		await Promise.all(staleCalls);
		expect(staleCalls).toHaveLength(1);
		expect(session.computer).not.toBe(f.binding);
		expect(session.computer?.revoked).toBe(false);
		expect(session.agent.executionScheduler).toBe(f.scheduler);
		expect(f.tool(session)).not.toBe(stale);
		expect(await f.prompt(session)).toMatchObject({ isError: false, details: { id: 2 } });
		await expect(stale.execute("old-after-reload", {})).rejects.toThrow(/stale/);
		await expect(
			f.binding.tools[0].execute(
				"retained-binding",
				{},
				undefined,
				undefined,
				session.extensionRunner.createContext(),
			),
		).rejects.toMatchObject({ code: "session_revoked" });
	});

	it.each(
		(["reload", "navigation"] as const).flatMap((operation) =>
			(["native revoke", "abort listener"] as const).map((callback) => ({ operation, callback })),
		),
	)("$operation preserves synchronous narrowing in a $callback", async ({ operation, callback }) => {
		const f = await fixture();
		const renew = vi.spyOn(f.binding, "renew");
		const session = await f.sdk({ computer: f.binding });
		await f.prompt(session);
		const target = session.getUserMessagesForForking()[0].entryId;
		const stale = f.tool(session);
		const entered = deferred();
		const terminal = deferred();
		cleanups.push(() => terminal.resolve());
		const narrow = vi.fn(() => session.setActiveToolsByName(["read"]));
		if (callback === "native revoke") f.nativeSessions[0].revoke.mockImplementation(narrow);
		f.dispatch.mockImplementationOnce((native, signal) => {
			if (callback === "abort listener") signal.addEventListener("abort", narrow, { once: true });
			entered.resolve();
			return { result: Promise.resolve(native.id), terminal: terminal.promise, cancel: vi.fn() };
		});
		// A direct host call keeps navigation idle while native work still awaits terminal acknowledgement.
		const running = stale.execute("pending-native", {});
		await entered.promise;
		let finished = false;
		const change = (operation === "reload" ? session.reload() : session.navigateTree(target)).then(() => {
			finished = true;
		});
		expect(narrow).toHaveBeenCalledTimes(1);
		expect(f.binding.revoked).toBe(true);
		expect(session.getActiveToolNames()).not.toContain(toolName);
		await expect(stale.execute("during-drain", {})).rejects.toMatchObject({ code: "session_revoked" });
		expect(finished).toBe(false);
		terminal.resolve();
		await running;
		await change;
		await expect(stale.execute("after-transition", {})).rejects.toThrow(/stale|session_revoked/);
		expect(renew).not.toHaveBeenCalled();
		expect(session.computer).toBe(f.binding);
		expect(session.computer?.revoked).toBe(true);
		session.setActiveToolsByName([toolName, "read"]);
		expect(session.getActiveToolNames()).not.toContain(toolName);
		await session.reload();
		expect(session.computer?.revoked).toBe(true);
		const children = f.childHost(session);
		await children.create("after-narrowing");
		expect(children.sessions.get("/root/after-narrowing")?.computer).toBeUndefined();
		expect(f.nativeSessions).toHaveLength(1);
		expect(f.dispatch).toHaveBeenCalledTimes(2);
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
	});

	it("does not renew authority narrowed by an observer during reload", async () => {
		const f = await fixture();
		let session!: AgentSession;
		session = await f.sdk({ computer: f.binding }, [
			(pi) => {
				pi.on("session_shutdown", () => session.setActiveToolsByName(["read"]));
			},
		]);
		await session.reload();
		expect(session.computer?.revoked).toBe(true);
		session.setActiveToolsByName([toolName, "read"]);
		expect(session.getActiveToolNames()).not.toContain(toolName);
		expect(f.createRuntime).not.toHaveBeenCalled();
	});
});

describe("Computer child authority", () => {
	it.each(["narrowed", "noTools", "excluded", "undelegated"] as const)(
		"allows ordinary children with %s Computer authority and never initializes native resources",
		async (mode) => {
			const f = await fixture();
			const root = await f.sdk({
				computer: f.binding,
				...(mode === "noTools"
					? { noTools: "all" as const }
					: mode === "excluded"
						? { excludeTools: [toolName] }
						: {}),
			});
			if (mode === "narrowed") root.setActiveToolsByName(["read"]);
			const children = f.childHost(root);
			const child = await children.create(
				"ordinary",
				mode === "undelegated" ? { toolAllowed: (name) => name !== toolName } : {},
			);
			const session = children.sessions.get("/root/ordinary")!;
			expect(session.computer).toBeUndefined();
			expect(session.getActiveToolNames()).not.toContain(toolName);
			f.faux.setResponses([fauxAssistantMessage("ordinary coding")]);
			expect(await child.run("No computer work")).toMatchObject({ status: "completed", text: "ordinary coding" });
			await child.dispose();
			expect(f.createRuntime).not.toHaveBeenCalled();
			expect(f.nativeRuntime.close).not.toHaveBeenCalled();
		},
	);

	it("forks real child tools with one scheduler; parent and siblings compete with the persistent session owner", async () => {
		const f = await fixture();
		const root = await f.sdk({ computer: f.binding });
		const children = f.childHost(root);
		const first = await children.create("first");
		await children.create("second");
		const a = children.sessions.get("/root/first")!;
		const b = children.sessions.get("/root/second")!;
		expect(a.computer).not.toBe(f.binding);
		expect(a.computer).not.toBe(b.computer);
		expect(a.agent.executionScheduler).toBe(f.scheduler);
		expect(b.agent.executionScheduler).toBe(f.scheduler);
		expect(await f.prompt(a)).toMatchObject({ isError: false, details: { id: 2 } });
		expect(f.nativeSessions[1].parent).toBe(f.nativeSessions[0]);
		expect(await f.prompt(root)).toMatchObject({ isError: true });
		expect(await f.prompt(b)).toMatchObject({ isError: true });
		await first.dispose();
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
		expect(f.binding.revoked).toBe(false);
		expect(b.computer?.revoked).toBe(false);
		expect(await f.prompt(root)).toMatchObject({ isError: false, details: { id: 1 } });
		root.setActiveToolsByName(["read"]);
		expect(b.computer?.revoked).toBe(true);
		await children.create("ordinary-after-narrowing");
		const ordinary = children.sessions.get("/root/ordinary-after-narrowing")!;
		expect(ordinary.computer).toBeUndefined();
		expect(ordinary.getActiveToolNames()).not.toContain(toolName);
	});

	it("revokes an active child synchronously but retains its owner until both operation and close barriers settle", async () => {
		const f = await fixture();
		const root = await f.sdk({ computer: f.binding });
		const children = f.childHost(root);
		const child = await children.create("active");
		const session = children.sessions.get("/root/active")!;
		const stale = f.tool(session);
		const entered = deferred();
		const terminal = deferred();
		const closed = deferred();
		cleanups.push(() => {
			terminal.resolve();
			closed.resolve();
		});
		const cancel = vi.fn();
		f.dispatch.mockImplementationOnce((native) => {
			entered.resolve();
			return { result: Promise.resolve(native.id), terminal: terminal.promise, cancel };
		});
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("stopped"),
		]);
		const running = child.run("fake native work");
		await entered.promise;
		f.nativeSessions[0].revoke.mockImplementation(() => {
			expect(session.computer?.revoked).toBe(true);
		});
		root.setActiveToolsByName(["read"]);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(session.computer?.revoked).toBe(true);
		expect(f.scheduler.runningCount).toBe(1);
		await expect(stale.execute("revoked-active", {})).rejects.toMatchObject({ code: "session_revoked" });
		const contender = await f.sdk({ computer: f.binding.renew() });
		await expect(f.tool(contender).execute("during-terminal", {})).rejects.toMatchObject({ code: "desktop_busy" });
		terminal.resolve();
		await running;
		expect(f.scheduler.runningCount).toBe(0);
		await expect(f.tool(contender).execute("between-decisions", {})).rejects.toMatchObject({ code: "desktop_busy" });
		const closeEntered = deferred();
		f.nativeSessions[1].close.mockImplementation(() => {
			closeEntered.resolve();
			return closed.promise;
		});
		const closing = child.dispose();
		await closeEntered.promise;
		await expect(f.tool(contender).execute("during-close", {})).rejects.toMatchObject({ code: "desktop_busy" });
		closed.resolve();
		await closing;
		await expect(f.tool(contender).execute("next-owner", {})).resolves.toMatchObject({ details: { id: 3 } });
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
	});

	it("reloads a child using a fresh descendant capability without closing or capturing the parent handle", async () => {
		const f = await fixture();
		const root = await f.sdk({ computer: f.binding });
		const children = f.childHost(root);
		await children.create("reload");
		const child = children.sessions.get("/root/reload")!;
		const old = child.computer!;
		const stale = f.tool(child);
		await f.prompt(child);
		await child.reload();
		expect(child.computer).not.toBe(old);
		expect(old.revoked).toBe(true);
		expect(f.binding.revoked).toBe(false);
		await expect(stale.execute("stale-child", {})).rejects.toThrow(/stale/);
		await expect(
			old.tools[0].execute("retained-child", {}, undefined, undefined, child.extensionRunner.createContext()),
		).rejects.toMatchObject({ code: "session_revoked" });
		expect(await f.prompt(child)).toMatchObject({ isError: false, details: { id: 3 } });
		expect(f.nativeSessions[2].parent).toBe(f.nativeSessions[0]);
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
	});

	it("creates a child from the current root capability after navigation without rebinding old closures", async () => {
		const f = await fixture();
		const attached = vi.spyOn(PiCollaborationMonitor.prototype, "attach");
		cleanups.push(() => attached.mockRestore());
		const root = await f.sdk({ computer: f.binding }, [(pi) => registerPiCollaborationRoot(pi, f.cwd, fullAccess)]);
		cleanups.push(() => root.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
		const stale = f.tool(root);
		await f.prompt(root);
		await root.navigateTree(root.getUserMessagesForForking()[0].entryId);
		expect(root.computer).not.toBe(f.binding);
		expect(root.computer?.revoked).toBe(false);
		await expect(stale.execute("old-branch", {})).rejects.toMatchObject({ code: "session_revoked" });
		const entered = deferred();
		const reply = deferred<AssistantMessage>();
		cleanups.push(() => reply.resolve(fauxAssistantMessage("idle")));
		f.faux.setResponses([
			() => {
				entered.resolve();
				return reply.promise;
			},
		]);
		const spawn = root.agent.state.tools.find((tool) => tool.name === "spawn_agent")!;
		await spawn.execute("after-navigation", {
			task_name: "after-navigation",
			task: { objective: "Wait without using Computer." },
			context: { mode: "isolated" },
			tools: ["read", toolName],
		});
		await entered.promise;
		const child = attached.mock.calls.find(([identity]) => identity.agentPath === "/root/after-navigation")![1];
		const settled = child.waitForIdle();
		reply.resolve(fauxAssistantMessage("idle"));
		await settled;
		expect(child.computer).toBeDefined();
		expect(child.computer).not.toBe(root.computer);
		expect(child.computer?.revoked).toBe(false);
		expect(child.agent.executionScheduler).toBe(f.scheduler);
		expect(await f.prompt(child)).toMatchObject({ isError: false, details: { id: 3 } });
		expect(f.nativeSessions[2].parent).toBe(f.nativeSessions[1]);
		expect(f.nativeSessions[1].parent).toBeUndefined();
		await expect(stale.execute("after-new-child", {})).rejects.toMatchObject({ code: "session_revoked" });
		expect(f.dispatch).toHaveBeenCalledTimes(2);
		const retainedChild = f.tool(child);
		root.setActiveToolsByName(["read"]);
		expect(child.computer?.revoked).toBe(true);
		await expect(retainedChild.execute("narrowed-parent", {})).rejects.toMatchObject({ code: "session_revoked" });
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
	});

	it("narrows a controller ceiling before reentrant observers can use a retained child closure", async () => {
		const f = await fixture();
		const root = await f.sdk({ computer: f.binding });
		const children = f.childHost(root);
		const caller = { rootSessionId: root.sessionId, agentPath: "/root" };
		const store = new CollaborationStore({ path: ":memory:", rootSessionId: root.sessionId, cwd: f.cwd });
		const controller = new CollaborationController({
			store,
			host: children.host,
			agentDir: f.cwd,
			getPermissions: fullAccess,
		});
		cleanups.push(() => controller.shutdown());
		controller.bindTools(caller, () => root.getActiveToolNames());
		const delegation = validateDelegation({
			task: { objective: "fake work" },
			context: { mode: "isolated" },
			capabilities: { tools: "inherit" },
		});
		f.faux.setResponses([fauxAssistantMessage("idle")]);
		await controller.spawn(
			caller,
			"worker",
			"fake work",
			{ provider: f.faux.provider.id, id: f.faux.getModel().id, thinkingLevel: "off" },
			undefined,
			undefined,
			{ delegation, tools: [toolName, "read"] },
		);
		await controller.settled();
		const child = children.sessions.get("/root/worker")!;
		const stale = f.tool(child);
		const attempts: Promise<unknown>[] = [];
		const stop = controller.subscribe(() => {
			if (store.read().agents[0].tools?.includes(toolName)) return;
			expect(child.computer?.revoked).toBe(true);
			attempts.push(expect(stale.execute("observer", {})).rejects.toMatchObject({ code: "session_revoked" }));
		});
		f.faux.setResponses([fauxAssistantMessage("narrowed")]);
		await controller.followup(caller, "worker", "narrow", undefined, { delegation, tools: ["read"] });
		await controller.settled();
		stop();
		await Promise.all(attempts);
		expect(attempts.length).toBeGreaterThan(0);
		expect(f.createRuntime).not.toHaveBeenCalled();
		await child.reload();
		expect(child.getActiveToolNames()).not.toContain(toolName);
		expect(child.computer?.revoked).toBe(true);
	});

	it("controller shutdown closes capability gates before observers and is safe to reenter from native revoke", async () => {
		const f = await fixture();
		const root = await f.sdk({ computer: f.binding });
		const children = f.childHost(root);
		const caller = { rootSessionId: root.sessionId, agentPath: "/root" };
		const store = new CollaborationStore({ path: ":memory:", rootSessionId: root.sessionId, cwd: f.cwd });
		const controller = new CollaborationController({
			store,
			host: children.host,
			agentDir: f.cwd,
			getPermissions: fullAccess,
		});
		cleanups.push(() => controller.shutdown());
		f.faux.setResponses([fauxAssistantMessage("idle")]);
		await controller.spawn(caller, "worker", "fake work", {
			provider: f.faux.provider.id,
			id: f.faux.getModel().id,
			thinkingLevel: "off",
		});
		await controller.settled();
		const child = children.sessions.get("/root/worker")!;
		await f.prompt(child);
		const stale = f.tool(child);
		const attempts: Promise<unknown>[] = [];
		let reentry: Promise<void> | undefined;
		f.nativeSessions[1].revoke.mockImplementation(() => {
			reentry = controller.shutdown();
		});
		controller.subscribe(() => {
			expect(child.computer?.revoked).toBe(true);
			attempts.push(
				expect(stale.execute("shutdown-observer", {})).rejects.toMatchObject({ code: "session_revoked" }),
			);
		});
		const closing = controller.shutdown();
		expect(reentry).toBe(closing);
		expect(child.computer?.revoked).toBe(true);
		await closing;
		await Promise.all(attempts);
		expect(attempts).toHaveLength(1);
		expect(f.binding.revoked).toBe(false);
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
	});

	it("startup cancellation revokes before the extension returns and awaits native close", async () => {
		const f = await fixture();
		const root = await f.sdk({ computer: f.binding });
		let childSession: AgentSession | undefined;
		const entered = deferred();
		const releaseExtension = deferred();
		const nativeClose = deferred();
		const closeEntered = deferred();
		const child = createPiChildSessionHost({
			modelRuntime: f.modelRuntime,
			settings: f.settings,
			getComputer: () => root.computer,
			noExtensions: true,
			getTools: () => root.getActiveToolNames(),
			registerTools: (_identity, pi, getSession) => {
				pi.on("session_start", async () => {
					childSession = getSession();
					await f.tool(childSession).execute("startup", {});
					f.nativeSessions[1].close.mockImplementation(() => {
						closeEntered.resolve();
						return nativeClose.promise;
					});
					entered.resolve();
					await releaseExtension.promise;
				});
			},
		});
		const abort = new AbortController();
		const creating = child.create({
			rootSessionId: root.sessionId,
			agentPath: "/root/startup",
			cwd: f.cwd,
			agentDir: f.cwd,
			model: { provider: f.faux.provider.id, id: f.faux.getModel().id, thinkingLevel: "off" },
			storage: { kind: "memory" },
			getPermissions: fullAccess,
			signal: abort.signal,
		});
		const rejected = expect(creating).rejects.toThrow();
		await entered.promise;
		abort.abort();
		expect(childSession?.computer?.revoked).toBe(true);
		expect(f.binding.revoked).toBe(false);
		releaseExtension.resolve();
		await closeEntered.promise;
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
		nativeClose.resolve();
		await rejected;
		expect(f.nativeSessions[1].close).toHaveBeenCalledTimes(1);
	});
});

describe("Computer runtime replacement and history", () => {
	it("runtime disposal awaits native drain even when a UI callback throws and native revocation reenters disposal", async () => {
		const f = await fixture();
		const session = await f.sdk({ computer: f.binding });
		await f.prompt(session);
		const services = {
			cwd: f.cwd,
			agentDir: f.cwd,
			modelRuntime: f.modelRuntime,
			settingsManager: session.settingsManager,
			resourceLoader: session.resourceLoader,
			diagnostics: [],
		};
		const runtime = new AgentSessionRuntime(session, services, async () => {
			throw new Error("Unexpected replacement");
		});
		const closeEntered = deferred();
		const closed = deferred();
		cleanups.push(() => closed.resolve());
		f.nativeSessions[0].close.mockImplementation(() => {
			closeEntered.resolve();
			return closed.promise;
		});
		let reentry: Promise<void> | undefined;
		f.nativeSessions[0].revoke.mockImplementation(() => {
			reentry = runtime.dispose();
		});
		let callbackRevoked = false;
		runtime.setBeforeSessionInvalidate(() => {
			callbackRevoked = f.binding.revoked;
			throw new Error("UI teardown failed");
		});
		const closing = runtime.dispose();
		const failed = expect(closing).rejects.toThrow("UI teardown failed");
		expect(reentry).toBe(closing);
		expect(f.binding.revoked).toBe(true);
		await closeEntered.promise;
		expect(callbackRevoked).toBe(true);
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
		closed.resolve();
		await failed;
		expect(f.nativeSessions[0].close).toHaveBeenCalledTimes(1);
	});

	it.each(["new", "fork-before", "fork-at", "resume", "import"] as const)(
		"%s drains the old identity and forwards a fresh capability, not history authority",
		async (operation) => {
			const f = await fixture();
			const shutdownIds: string[] = [];
			const shutdownRevoked: boolean[] = [];
			const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent, computer }) => {
				const extensionsResult = await createTestExtensionsResult(
					[
						(pi) => {
							pi.on("session_shutdown", (_event, ctx) => {
								shutdownIds.push(ctx.sessionManager.getSessionId());
								shutdownRevoked.push(computer?.revoked === true);
							});
						},
					],
					f.cwd,
				);
				const services = {
					cwd: f.cwd,
					agentDir: f.cwd,
					modelRuntime: f.modelRuntime,
					settingsManager: SettingsManager.inMemory(f.settings),
					resourceLoader: createTestResourceLoader({ extensionsResult }),
					diagnostics: [],
				};
				return {
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent,
						computer,
						model: f.faux.getModel(),
					})),
					services,
					diagnostics: [],
				};
			};
			const manager =
				operation === "import"
					? SessionManager.create(f.cwd, join(f.cwd, "import-destination"))
					: SessionManager.inMemory(f.cwd);
			const runtime = await createAgentSessionRuntime(factory, {
				cwd: f.cwd,
				agentDir: f.cwd,
				sessionManager: manager,
				computer: f.binding,
			});
			cleanups.push(() => runtime.dispose());
			await runtime.session.bindExtensions({});
			const old = runtime.session;
			const oldId = old.sessionId;
			await f.prompt(old);
			const user = old.getUserMessagesForForking()[0].entryId;
			const leaf = old.sessionManager.getLeafId()!;
			const stale = f.tool(old);
			const target = SessionManager.create(f.cwd, join(f.cwd, "sessions"));
			target.appendMessage({
				role: "user",
				content: "retained serialized computer ref is not authority",
				timestamp: 1,
			});
			target.appendMessage(fauxAssistantMessage("historical answer"));
			expect(existsSync(target.getSessionFile()!)).toBe(true);
			const closingEntered = deferred();
			const closed = deferred();
			cleanups.push(() => closed.resolve());
			f.nativeSessions[0].close.mockImplementation(() => {
				closingEntered.resolve();
				return closed.promise;
			});
			const change =
				operation === "new"
					? runtime.newSession()
					: operation === "fork-before"
						? runtime.fork(user)
						: operation === "fork-at"
							? runtime.fork(leaf, { position: "at" })
							: operation === "resume"
								? runtime.switchSession(target.getSessionFile()!)
								: runtime.importFromJsonl(target.getSessionFile()!);
			await Promise.race([
				closingEntered.promise,
				change.then(() => {
					throw new Error("Replacement skipped native drain");
				}),
			]);
			expect(runtime.session).toBe(old);
			expect(shutdownIds).toEqual([oldId]);
			expect(shutdownRevoked).toEqual([true]);
			await expect(stale.execute("during-replacement", {})).rejects.toThrow(/stale/);
			closed.resolve();
			await change;
			expect(runtime.session).not.toBe(old);
			expect(runtime.session.computer).not.toBe(f.binding);
			expect(runtime.session.computer?.revoked).toBe(false);
			expect(runtime.session.agent.executionScheduler).toBe(f.scheduler);
			expect(await f.prompt(runtime.session)).toMatchObject({ isError: false, details: { id: 2 } });
			expect(f.nativeRuntime.close).not.toHaveBeenCalled();
		},
	);

	it.each(
		(["new", "fork-before", "fork-at", "resume", "import"] as const).flatMap((operation) =>
			(["shutdown observer", "native revoke", "native close", "drain"] as const).map((phase) => ({
				operation,
				phase,
			})),
		),
	)("$operation preserves narrowing during $phase through replacement drain", async ({ operation, phase }) => {
		const f = await fixture();
		let old!: AgentSession;
		const narrow = vi.fn(() => old.setActiveToolsByName(["read"]));
		old = await f.sdk(
			{
				computer: f.binding,
				sessionManager:
					operation === "import"
						? SessionManager.create(f.cwd, join(f.cwd, "import-destination"))
						: SessionManager.inMemory(f.cwd),
			},
			[
				(pi) => {
					if (phase === "shutdown observer") pi.on("session_shutdown", narrow);
				},
			],
		);
		const services = {
			cwd: f.cwd,
			agentDir: f.cwd,
			modelRuntime: f.modelRuntime,
			settingsManager: old.settingsManager,
			resourceLoader: old.resourceLoader,
			diagnostics: [],
		};
		const factory = vi.fn<CreateAgentSessionRuntimeFactory>(async ({ sessionManager, computer }) => ({
			session: await f.sdk({ sessionManager, computer }),
			extensionsResult: createTestResourceLoader().getExtensions(),
			services,
			diagnostics: [],
		}));
		const runtime = new AgentSessionRuntime(old, services, factory);
		cleanups.push(() => runtime.dispose());
		await f.prompt(old);
		const user = old.getUserMessagesForForking()[0].entryId;
		const leaf = old.sessionManager.getLeafId()!;
		const stale = f.tool(old);
		const children = f.childHost(old);
		await children.create("old");
		const oldChild = children.sessions.get("/root/old")!;
		const staleChild = f.tool(oldChild);
		const target = SessionManager.create(f.cwd, join(f.cwd, "sessions"));
		target.appendMessage({ role: "user", content: "history is not authority", timestamp: 1 });
		target.appendMessage(fauxAssistantMessage("retained answer"));
		const closeEntered = deferred();
		const closed = deferred();
		cleanups.push(() => closed.resolve());
		if (phase === "native revoke") f.nativeSessions[0].revoke.mockImplementation(narrow);
		f.nativeSessions[0].close.mockImplementation(() => {
			if (phase === "native close") narrow();
			closeEntered.resolve();
			return closed.promise;
		});
		const change =
			operation === "new"
				? runtime.newSession()
				: operation === "fork-before"
					? runtime.fork(user)
					: operation === "fork-at"
						? runtime.fork(leaf, { position: "at" })
						: operation === "resume"
							? runtime.switchSession(target.getSessionFile()!)
							: runtime.importFromJsonl(target.getSessionFile()!);
		await Promise.race([
			closeEntered.promise,
			change.then(() => {
				throw new Error("Replacement skipped native drain");
			}),
		]);
		if (phase === "drain") narrow();
		expect(narrow).toHaveBeenCalledTimes(1);
		expect(f.binding.revoked).toBe(true);
		expect(oldChild.computer?.revoked).toBe(true);
		expect(runtime.session).toBe(old);
		expect(factory).not.toHaveBeenCalled();
		await expect(stale.execute("old-root", {})).rejects.toThrow(/stale/);
		await expect(staleChild.execute("old-child", {})).rejects.toMatchObject({ code: "session_revoked" });
		closed.resolve();
		await change;
		expect(factory.mock.calls[0][0].computer).toBeUndefined();
		expect(runtime.session.computer).toBeUndefined();
		runtime.session.setActiveToolsByName(["read", toolName]);
		expect(runtime.session.getActiveToolNames()).not.toContain(toolName);
		const newChildren = f.childHost(runtime.session);
		await newChildren.create("new");
		const newChild = newChildren.sessions.get("/root/new")!;
		expect(newChild.computer).toBeUndefined();
		expect(newChild.agent.executionScheduler).toBeUndefined();
		await expect(staleChild.execute("after-replacement", {})).rejects.toMatchObject({ code: "session_revoked" });
		expect(f.nativeSessions).toHaveLength(1);
		expect(f.dispatch).toHaveBeenCalledTimes(1);
		expect(f.nativeRuntime.close).not.toHaveBeenCalled();
	});

	it("preserves vetoes, invalid targets and tree no-ops, but invalidates successful navigation references", async () => {
		const f = await fixture();
		let veto = true;
		const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, computer }) => {
			const extensionsResult = await createTestExtensionsResult(
				[
					(pi) => {
						pi.on("session_before_switch", () => ({ cancel: veto }));
						pi.on("session_before_fork", () => ({ cancel: veto }));
						pi.on("session_before_tree", () => ({ cancel: veto }));
					},
				],
				f.cwd,
			);
			const services = {
				cwd: f.cwd,
				agentDir: f.cwd,
				modelRuntime: f.modelRuntime,
				settingsManager: SettingsManager.inMemory(f.settings),
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				diagnostics: [],
			};
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, computer, model: f.faux.getModel() })),
				services,
				diagnostics: [],
			};
		};
		const runtime = await createAgentSessionRuntime(factory, {
			cwd: f.cwd,
			agentDir: f.cwd,
			sessionManager: SessionManager.inMemory(f.cwd),
			computer: f.binding,
		});
		cleanups.push(() => runtime.dispose());
		await f.prompt(runtime.session);
		const firstUser = runtime.session.getUserMessagesForForking()[0].entryId;
		expect(await runtime.newSession()).toEqual({ cancelled: true });
		expect(await runtime.fork("missing")).toEqual({ cancelled: true });
		expect(await runtime.session.navigateTree(firstUser)).toMatchObject({ cancelled: true });
		expect(await runtime.session.navigateTree(runtime.session.sessionManager.getLeafId()!)).toEqual({
			cancelled: false,
		});
		expect(f.binding.revoked).toBe(false);
		veto = false;
		await expect(runtime.fork("missing")).rejects.toThrow("Invalid entry");
		await expect(runtime.session.navigateTree("missing")).rejects.toThrow("not found");
		expect(f.binding.revoked).toBe(false);
		const stale = f.tool(runtime.session);
		await runtime.session.navigateTree(firstUser);
		expect(f.binding.revoked).toBe(true);
		expect(runtime.session.computer?.revoked).toBe(false);
		await expect(stale.execute("old-branch", {})).rejects.toMatchObject({ code: "session_revoked" });
		expect(await f.prompt(runtime.session)).toMatchObject({ isError: false, details: { id: 2 } });
	});
});
