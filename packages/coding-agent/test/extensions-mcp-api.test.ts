import { AgentToolError } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionAPI,
	ExtensionContextActions,
	ExtensionError,
	ExtensionFactory,
	McpServersChangeEvent,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
} from "../src/core/extensions/types.ts";
import { wrapRegisteredTool } from "../src/core/extensions/wrapper.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const actions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

const contextActions: ExtensionContextActions = {
	getModel: () => undefined,
	getScopedModels: () => [],
	isIdle: () => true,
	isProjectTrusted: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
};

const tool: ToolDefinition = {
	name: "search",
	label: "Search",
	description: "Search docs",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "result" }], details: undefined }),
};

describe("extension MCP registration API", () => {
	it("supports initial registrations, live post-bind changes, snapshots and owner-only removal", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let owner!: ExtensionAPI;
		let other!: ExtensionAPI;
		const observed: McpServersChangeEvent[] = [];
		const ownerExtension = await loadExtensionFromFactory(
			(pi) => {
				owner = pi;
				pi.registerMcpServer("initial", { command: "node" });
				pi.on("mcp_servers_change", (event) => {
					observed.push(event);
				});
			},
			process.cwd(),
			eventBus,
			runtime,
			"<inline:owner>",
		);
		const otherExtension = await loadExtensionFromFactory(
			(pi) => {
				other = pi;
			},
			process.cwd(),
			eventBus,
			runtime,
			"<inline:other>",
		);
		expect(owner.getMcpServers()).toEqual([
			{ name: "initial", config: { command: "node" }, extensionPath: "<inline:owner>" },
		]);
		expect(other.getMcpServers()).toEqual(owner.getMcpServers());
		expect(observed).toEqual([]);
		const runner = new ExtensionRunner(
			[ownerExtension, otherExtension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		runner.bindCore(actions, contextActions);
		expect(observed).toEqual([]);

		owner.registerMcpServer("late", { url: "https://example.test/mcp" });
		expect(observed).toHaveLength(1);
		expect(observed[0].type).toBe("mcp_servers_change");
		expect(observed[0].servers.map((server) => server.name)).toEqual(["initial", "late"]);
		const snapshot = owner.getMcpServers();
		snapshot[0].config.exposure = "hidden";
		expect(owner.getMcpServers()[0].config.exposure).toBeUndefined();
		owner.registerMcpServer("initial", { command: "updated", exposure: "direct" });
		await vi.waitFor(() => expect(observed).toHaveLength(2));
		expect(observed[0].servers[0].config).toEqual({ command: "node" });
		expect(owner.getMcpServers()[0].config).toEqual({ command: "updated", exposure: "direct" });

		expect(() => other.registerMcpServer("initial", { command: "other" })).toThrow("already registered by extension");
		other.unregisterMcpServer("initial");
		owner.unregisterMcpServer("missing");
		expect(observed).toHaveLength(2);
		owner.unregisterMcpServer("late");
		await vi.waitFor(() => expect(observed).toHaveLength(3));
		expect(observed[2].servers.map((server) => server.name)).toEqual(["initial"]);
		runner.invalidate();
		expect(() => owner.registerMcpServer("stale", { command: "node" })).toThrow("stale");
		expect(() => owner.unregisterMcpServer("initial")).toThrow("stale");
		expect(() => owner.getMcpServers()).toThrow("stale");
		// The runtime's raw registry cannot dispatch into a torn-down extension runner.
		runtime.mcpServers.register({ name: "unbound", config: { command: "node" }, extensionPath: "internal" });
		expect(observed).toHaveLength(3);
	});

	it("does not retain registrations from a failed factory", async () => {
		const runtime = createExtensionRuntime();
		runtime.mcpServers.register({
			name: "existing",
			config: { command: "original" },
			extensionPath: "<inline:owner>",
		});
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.registerMcpServer("existing", { command: "replaced" });
					pi.registerMcpServer("orphan", { command: "node" });
					throw new Error("factory failed");
				},
				process.cwd(),
				createEventBus(),
				runtime,
				"<inline:owner>",
			),
		).rejects.toThrow("factory failed");
		expect(runtime.mcpServers.list()).toEqual([
			{ name: "existing", config: { command: "original" }, extensionPath: "<inline:owner>" },
		]);
	});

	it("validates entries and namespace collisions through the public API", async () => {
		const runtime = createExtensionRuntime();
		let api!: ExtensionAPI;
		await loadExtensionFromFactory(
			(pi) => {
				api = pi;
			},
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:owner>",
		);
		expect(() => api.registerMcpServer("bad name", { command: "node" })).toThrow("invalid server name");
		expect(() => api.registerMcpServer("bad", { url: "not-a-url" })).toThrow(
			"Invalid MCP server registered by extension",
		);
		api.registerMcpServer("my-docs", { command: "node" });
		expect(() => api.registerMcpServer("my_docs", { command: "node" })).toThrow("conflicts with registered server");
		expect(api.getMcpServers().map((server) => server.name)).toEqual(["my-docs"]);
	});

	it("reports an unhandled server once without breaking registration", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => pi.registerMcpServer("orphan", { command: "node" }),
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:owner>",
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		const errors: ExtensionError[] = [];
		runner.onError((error) => errors.push(error));
		runner.bindCore(actions, contextActions);
		runner.reportUnhandledMcpServers();
		runner.reportUnhandledMcpServers();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ extensionPath: "<inline:owner>", event: "register_mcp_server" });
		expect(errors[0].error).toContain("no loaded extension connects MCP servers");
		expect(runtime.mcpServers.list()).toHaveLength(1);
	});
});

describe("one-shot extension session shutdown", () => {
	async function createRunner(factory: ExtensionFactory): Promise<ExtensionRunner> {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		runner.bindCore(actions, contextActions);
		return runner;
	}

	it("dispatches simultaneous shutdown once and lets both callers await pending cleanup", async () => {
		let releaseCleanup!: () => void;
		const cleanup = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		const onShutdown = vi.fn(async () => {
			await cleanup;
		});
		const runner = await createRunner((pi) => pi.on("session_shutdown", onShutdown));
		const first = runner.emit({ type: "session_shutdown", reason: "quit" });
		const second = runner.emit({ type: "session_shutdown", reason: "quit" });
		let firstSettled = false;
		let secondSettled = false;
		void first.then(() => {
			firstSettled = true;
		});
		void second.then(() => {
			secondSettled = true;
		});
		await Promise.resolve();
		expect(onShutdown).toHaveBeenCalledTimes(1);
		expect(first).toBe(second);
		expect(firstSettled).toBe(false);
		expect(secondSettled).toBe(false);
		releaseCleanup();
		expect(await Promise.all([first, second])).toEqual([undefined, undefined]);
		expect(firstSettled).toBe(true);
		expect(secondSettled).toBe(true);
	});

	it("does not redispatch after a completed manual shutdown", async () => {
		const onShutdown = vi.fn();
		const runner = await createRunner((pi) => pi.on("session_shutdown", onShutdown));
		const manual = runner.emit({ type: "session_shutdown", reason: "reload" });
		await manual;
		const sessionShutdown = runner.emit({ type: "session_shutdown", reason: "quit" });
		await sessionShutdown;
		expect(sessionShutdown).toBe(manual);
		expect(onShutdown).toHaveBeenCalledTimes(1);
		expect(onShutdown.mock.calls[0][0]).toMatchObject({ reason: "reload" });
	});

	it("reserves the drain before callbacks synchronously reenter shutdown emission", async () => {
		let runner!: ExtensionRunner;
		let nested: Promise<undefined> | undefined;
		let reentered = false;
		const onShutdown = vi.fn(() => {
			if (reentered) return;
			reentered = true;
			nested = runner.emit({ type: "session_shutdown", reason: "quit" });
		});
		runner = await createRunner((pi) => pi.on("session_shutdown", onShutdown));
		const first = runner.emit({ type: "session_shutdown", reason: "quit" });
		await first;
		expect(nested).toBe(first);
		expect(onShutdown).toHaveBeenCalledTimes(1);
	});

	it("keeps independent shutdown drains for different runners", async () => {
		const onShutdown = vi.fn();
		const first = await createRunner((pi) => pi.on("session_shutdown", onShutdown));
		const second = await createRunner((pi) => pi.on("session_shutdown", onShutdown));
		const firstDrain = first.emit({ type: "session_shutdown", reason: "quit" });
		const secondDrain = second.emit({ type: "session_shutdown", reason: "quit" });
		expect(firstDrain).not.toBe(secondDrain);
		await Promise.all([firstDrain, secondDrain]);
		expect(onShutdown).toHaveBeenCalledTimes(2);
		await first.emit({ type: "session_shutdown", reason: "quit" });
		expect(onShutdown).toHaveBeenCalledTimes(2);
	});

	it("preserves generic handler error isolation and normal stale-context guards", async () => {
		const cleanedUp = vi.fn();
		const normalEvent = vi.fn();
		const runner = await createRunner((pi) => {
			pi.on("session_shutdown", () => {
				throw new Error("cleanup failed");
			});
			pi.on("session_shutdown", cleanedUp);
			pi.on("agent_start", (_event, ctx) => {
				normalEvent(ctx.cwd);
			});
		});
		const errors: ExtensionError[] = [];
		runner.onError((error) => errors.push(error));
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		expect(cleanedUp).toHaveBeenCalledTimes(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ event: "session_shutdown", error: "cleanup failed" });
		await runner.emit({ type: "agent_start" });
		await runner.emit({ type: "agent_start" });
		expect(normalEvent).toHaveBeenCalledTimes(2);
		runner.invalidate();
		await runner.emit({ type: "agent_start" });
		expect(normalEvent).toHaveBeenCalledTimes(2);
		expect(errors[1]).toMatchObject({ event: "agent_start", error: expect.stringContaining("stale") });
	});
});

describe("tool exposure interface", () => {
	it("forwards live authorization filters as detached snapshots with stale-context guards", async () => {
		const runtime = createExtensionRuntime();
		const runner = new ExtensionRunner(
			[],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		const access = { allowlist: ["mcp__docs__*"], excluded: ["mcp__docs__delete"] };
		runner.bindCore(actions, { ...contextActions, getToolAccess: () => access });
		const ctx = runner.createContext();
		expect(ctx.getToolAccess?.()).toEqual(access);
		const snapshot = ctx.getToolAccess?.();
		expect(snapshot?.allowlist).not.toBe(access.allowlist);
		access.allowlist.push("read");
		expect(ctx.getToolAccess?.().allowlist).toEqual(["mcp__docs__*", "read"]);
		expect(snapshot?.allowlist).toEqual(["mcp__docs__*"]);
		runner.invalidate();
		expect(() => ctx.getToolAccess?.()).toThrow("stale");
	});

	it("preserves execution contract, resource requests and AgentToolError through the existing wrapper", async () => {
		const runtime = createExtensionRuntime();
		const error = new AgentToolError("remote failed", { server: "docs" });
		const definition: ToolDefinition = {
			...tool,
			exposure: "deferred",
			contract: { sideEffects: "external", readOnly: false },
			executionResource: { key: "docs", mode: "exclusive" },
			execute: async () => {
				throw error;
			},
		};
		const extension = await loadExtensionFromFactory(
			(pi) => pi.registerTool(definition),
			process.cwd(),
			createEventBus(),
			runtime,
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		runner.bindCore(actions, contextActions);
		const wrapped = wrapRegisteredTool(extension.tools.get(tool.name)!, runner);
		expect(wrapped.contract).toBe(definition.contract);
		expect(wrapped.executionResource).toBe(definition.executionResource);
		await expect(wrapped.execute("call", {})).rejects.toBe(error);
	});

	it("preserves metadata and refreshes the runtime tool list after binding", async () => {
		const runtime = createExtensionRuntime();
		let api!: ExtensionAPI;
		const extension = await loadExtensionFromFactory(
			(pi) => {
				api = pi;
				pi.registerTool(tool);
			},
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:tools>",
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		const refresh = vi.fn();
		// AgentSession supplies this projection; this interface test verifies forwarding, not activation policy.
		const getAllTools = (): ToolInfo[] =>
			runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => ({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				exposure: definition.exposure ?? "direct",
				namespace: definition.namespace,
				annotations: definition.annotations,
				sourceInfo,
			}));
		runner.bindCore({ ...actions, refreshTools: refresh, getAllTools }, contextActions);
		expect(api.getAllTools()[0].exposure).toBe("direct");
		for (const exposure of ["direct", "model-only", "codemode", "deferred", "hidden"] satisfies ToolExposure[]) {
			api.registerTool({
				...tool,
				exposure,
				namespace: { name: "mcp__docs", description: "Docs", instructions: "Search before reading." },
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
				contract: { readOnly: true, sideEffects: "none" },
				executionResource: { key: "docs", mode: "shared" },
			});
			expect(api.getAllTools()[0]).toMatchObject({
				exposure,
				namespace: { name: "mcp__docs", description: "Docs", instructions: "Search before reading." },
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			});
		}
		expect(refresh).toHaveBeenCalledTimes(5);
		expect(runner.getToolDefinition("search")?.contract).toEqual({ readOnly: true, sideEffects: "none" });
		expect(runner.getToolDefinition("search")?.executionResource).toEqual({ key: "docs", mode: "shared" });
	});

	it("rejects unsupported exposure aliases even when a JavaScript extension bypasses TypeScript", async () => {
		const runtime = createExtensionRuntime();
		let api!: ExtensionAPI;
		await loadExtensionFromFactory(
			(pi) => {
				api = pi;
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		expect(() => api.registerTool({ ...tool, exposure: "codemode-deferred" as ToolExposure })).toThrow(
			"Invalid exposure",
		);
	});
});
