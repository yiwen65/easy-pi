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
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSession, ChildSessionCreateOptions, ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import { afterEach, expect, test } from "vitest";
import type { ExtensionAPI, InlineExtension } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";

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
	) {
		const request: ChildSessionCreateOptions = {
			rootSessionId,
			agentPath: "/root/worker",
			cwd,
			agentDir: join(root, "agent"),
			model: { provider: faux.provider.id, id: faux.getModel().id, thinkingLevel: "off" },
			storage,
			getPermissions: permissions,
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

test("native manual permissions do not inherit the legacy headless auto-approval bypass", async () => {
	const f = await fixture();
	const allowed = await f.create("full", full);
	let mode: ChildSessionPermissions["mode"] = "manual-allow";
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
		fauxAssistantMessage(fauxToolCall("write", { path: "denied.txt", content: "no" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("denied"),
	]);
	await restricted.session.run("write denied");
	expect(toolError(restricted.session)).toBe(true);
	expect(existsSync(join(f.cwd, "denied.txt"))).toBe(false);
	mode = "full-access";
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "later.txt", content: "yes" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await restricted.session.run("root explicitly changed policy");
	expect(await readFile(join(f.cwd, "later.txt"), "utf8")).toBe("yes");
	mode = "manual-allow";
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "after-revoke.txt", content: "no" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("denied"),
	]);
	await restricted.session.run("write after revocation");
	expect(existsSync(join(f.cwd, "after-revoke.txt"))).toBe(false);
});

test("inherited exact grants stay local; full access still protects the shared root", async () => {
	const f = await fixture();
	const grant = `tool:write:path:${join(f.cwd, "granted.txt")}`;
	const a = await f.create("granted", () => ({
		mode: "manual-allow",
		sessionGrants: [grant],
		protectedRoots: [f.cwd],
	}));
	const b = await f.create("ungranted", () => ({ mode: "manual-allow", sessionGrants: [], protectedRoots: [f.cwd] }));
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "granted.txt", content: "a" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await a.session.run("use exact grant");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "granted.txt", content: "b" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("denied"),
	]);
	await b.session.run("do not inherit peer grant");
	expect(await readFile(join(f.cwd, "granted.txt"), "utf8")).toBe("a");
	const c = await f.create("full", () => ({ ...full(), protectedRoots: [f.cwd] }));
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: `rm -rf '${f.cwd}'` }), { stopReason: "toolUse" }),
		fauxAssistantMessage("denied"),
	]);
	await c.session.run("test protected deletion");
	expect(toolError(c.session)).toBe(true);
	expect(existsSync(join(f.cwd, "granted.txt"))).toBe(true);
});

test("task text does not execute slash commands or change child permission authority", async () => {
	const f = await fixture();
	const child = await f.create("literal", () => ({ mode: "manual-allow", sessionGrants: [], protectedRoots: [] }));
	let captured: Context | undefined;
	f.faux.setResponses([
		(context) => {
			captured = context;
			return fauxAssistantMessage("literal");
		},
	]);
	await child.session.run("/permissions full-access");
	expect(captured?.systemPrompt).toContain("Permission mode is manual-allow");
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
