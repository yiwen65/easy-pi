import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION, type Tool } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolAccess, ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { RegisteredMcpServer } from "../src/core/mcp-servers.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { canReachMcpServer } from "../src/extensions/mcp/authority.ts";
import { createMcpExtension, getSessionMcpConfig } from "../src/extensions/mcp/index.ts";
import { McpManagerView } from "../src/extensions/mcp/ui.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function harness(access: ToolAccess = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "mcp-adapter-life-"));
	dirs.push(agentDir);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, ToolDefinition>();
	let registered: RegisteredMcpServer[] = [];
	let active: string[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: vi.fn(),
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		getAllTools: () =>
			[...tools.values()].map((tool) => ({
				...tool,
				exposure: tool.exposure ?? "direct",
				sourceInfo: { path: "test", source: "builtin", scope: "temporary", origin: "top-level" },
			})),
		getMcpServers: () => registered,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		mode: "print",
		hasUI: false,
		isProjectTrusted: () => false,
		getToolAccess: () => access,
		sessionManager: {},
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	return {
		agentDir,
		pi,
		ctx,
		tools,
		handlers,
		register: (next: RegisteredMcpServer[]) => {
			registered = next;
		},
	};
}

function transport(resources = false) {
	const pair = createInMemoryTransportPair();
	const methods: string[] = [];
	let offered: Tool[] = [{ name: "search", inputSchema: {}, description: "Search docs" }];
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		methods.push(message.method);
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {}, ...(resources ? { resources: {} } : {}) },
						serverInfo: { name: "fake", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: offered }
					: message.method === "resources/list"
						? { resources: [{ uri: "docs://a", name: "a" }] }
						: message.method === "resources/templates/list"
							? { resourceTemplates: [] }
							: { content: [{ type: "text", text: "ok" }] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	void pair.server.start();
	return {
		...pair,
		methods,
		setTools: (tools: Tool[]) => {
			offered = tools;
		},
	};
}

describe("pre-connect MCP authority", () => {
	it("proves strict/empty/other-namespace allowlists cannot reach a server", () => {
		expect(canReachMcpServer("docs", { allowlist: [] }, true)).toBe(false);
		expect(canReachMcpServer("docs", { allowlist: ["read", "tool_search"] }, true)).toBe(false);
		expect(canReachMcpServer("docs", { allowlist: ["mcp__other__*"] }, false)).toBe(false);
		expect(canReachMcpServer("docs", { allowlist: ["mcp__docs__search"] }, false)).toBe(true);
		expect(canReachMcpServer("docs", { allowlist: ["mcp__docs__*"], excluded: ["mcp__docs__*"] }, false)).toBe(false);
		expect(
			canReachMcpServer("docs", { allowlist: ["mcp__docs__search"], excluded: ["mcp__docs__search"] }, false),
		).toBe(false);
		expect(canReachMcpServer("docs", { allowlist: ["*search*"] }, false)).toBe(true);
		expect(canReachMcpServer("docs", { allowlist: ["read_mcp_resource"] }, true)).toBe(true);
		expect(canReachMcpServer("docs", { allowlist: ["read_mcp_resource"] }, false)).toBe(false);
		expect(canReachMcpServer("x".repeat(80), { allowlist: [`mcp__${"x".repeat(50)}_${"a".repeat(8)}`] }, false)).toBe(
			true,
		);
	});
	it("does not open transports or credentials for denied configured/registered servers", async () => {
		const h = harness({ allowlist: ["read", "tool_search"] });
		h.register([{ name: "registered", config: { command: "unused" }, extensionPath: "test" }]);
		const createTransport = vi.fn(() => transport().client);
		await createToolSearchExtension()(h.pi);
		await createMcpExtension({
			agentDir: h.agentDir,
			loadConfig: () => ({ servers: [{ name: "file", config: { command: "unused" }, source: "test" }], errors: [] }),
			createTransport,
		})(h.pi);
		expect(createTransport).not.toHaveBeenCalled();
		await h.handlers.get("session_start")?.({}, h.ctx);
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
		expect(createTransport).not.toHaveBeenCalled();
	});
});

describe("MCP adapter lifecycle", () => {
	it.each(["unregister", "replace"])(
		"drains a detached registered server's delayed close on immediate shutdown (%s)",
		async (action) => {
			const h = harness();
			const pair = transport();
			const createTransport = vi.fn(() => pair.client);
			let releaseClose!: () => void;
			const closeGate = new Promise<void>((resolve) => {
				releaseClose = resolve;
			});
			let markClosing!: () => void;
			const closing = new Promise<void>((resolve) => {
				markClosing = resolve;
			});
			const close = pair.client.close.bind(pair.client);
			pair.client.close = async () => {
				markClosing();
				await closeGate;
				await close();
			};
			h.register([{ name: "docs", config: { command: "original" }, extensionPath: "test" }]);
			await createMcpExtension({
				agentDir: h.agentDir,
				loadConfig: () => ({ servers: [], errors: [] }),
				createTransport,
			})(h.pi);
			await h.handlers.get("session_start")?.({}, h.ctx);
			await vi.waitFor(() => expect(h.tools.has("mcp__docs__search")).toBe(true));
			h.register(
				action === "unregister"
					? []
					: [{ name: "docs", config: { command: "replacement" }, extensionPath: "test" }],
			);
			const changing = h.handlers.get("mcp_servers_change")?.({}, h.ctx);
			await closing;
			let drained = false;
			const shutdown = Promise.resolve(h.handlers.get("session_shutdown")?.({}, h.ctx)).then(() => {
				drained = true;
			});
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(drained).toBe(false);
				expect(createTransport).toHaveBeenCalledTimes(1);
			} finally {
				releaseClose();
				await changing;
				await shutdown;
			}
			expect(drained).toBe(true);
			expect(createTransport).toHaveBeenCalledTimes(1);
		},
	);

	it("exposes detached approved live config, ignoring external edits until reload and removing it before shutdown drain", async () => {
		const h = harness();
		const path = join(h.agentDir, "mcp.json");
		writeFileSync(path, JSON.stringify({ mcpServers: { docs: { command: "approved", enabled: false } } }));
		await createMcpExtension({ agentDir: h.agentDir })(h.pi);
		expect(getSessionMcpConfig(h.ctx.sessionManager)).toBeUndefined();
		await h.handlers.get("session_start")?.({}, h.ctx);
		expect(getSessionMcpConfig(h.ctx.sessionManager)?.servers[0].config).toEqual({
			command: "approved",
			enabled: false,
		});
		writeFileSync(path, JSON.stringify({ mcpServers: { docs: { command: "changed-externally", enabled: false } } }));
		const snapshot = getSessionMcpConfig(h.ctx.sessionManager)!;
		snapshot.servers[0].config.enabled = true;
		expect(getSessionMcpConfig(h.ctx.sessionManager)?.servers[0].config).toEqual({
			command: "approved",
			enabled: false,
		});
		h.register([
			{
				name: "registered",
				config: { command: "from-extension", enabled: false, exposure: "direct" },
				extensionPath: "test",
			},
		]);
		await h.handlers.get("mcp_servers_change")?.({}, h.ctx);
		expect(getSessionMcpConfig(h.ctx.sessionManager)?.servers.map((entry) => entry.name)).toEqual([
			"docs",
			"registered",
		]);
		h.register([
			{
				name: "registered",
				config: { command: "from-extension", enabled: false, exposure: "hidden" },
				extensionPath: "test",
			},
		]);
		await h.handlers.get("mcp_servers_change")?.({}, h.ctx);
		expect(getSessionMcpConfig(h.ctx.sessionManager)?.servers[1].config.exposure).toBe("hidden");
		const draining = h.handlers.get("session_shutdown")?.({}, h.ctx);
		expect(getSessionMcpConfig(h.ctx.sessionManager)).toBeUndefined();
		await draining;
		await h.handlers.get("session_start")?.({}, h.ctx);
		expect(getSessionMcpConfig(h.ctx.sessionManager)?.servers[0].config).toEqual({
			command: "changed-externally",
			enabled: false,
		});
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
	});
	it("registers deferred tools late, hides withdrawn tools, and closes transports on shutdown", async () => {
		const h = harness();
		const pair = transport();
		const closed = vi.fn();
		pair.client.onClose(closed);
		await createToolSearchExtension()(h.pi);
		await createMcpExtension({
			agentDir: h.agentDir,
			loadConfig: () => ({
				servers: [{ name: "docs", config: { command: "unused", exposure: "deferred" }, source: "test" }],
				errors: [],
			}),
			createTransport: () => pair.client,
		})(h.pi);
		expect(pair.methods).toEqual([]);
		await h.handlers.get("session_start")?.({}, h.ctx);
		await vi.waitFor(() => expect(h.tools.get("mcp__docs__search")?.exposure).toBe("deferred"));
		expect(h.pi.getActiveTools()).toContain("tool_search");
		pair.setTools([{ name: "new", inputSchema: {} }]);
		await pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() => expect(h.tools.get("mcp__docs__search")?.exposure).toBe("hidden"));
		expect(h.tools.get("mcp__docs__new")?.exposure).toBe("deferred");
		const withdrawn = h.tools.get("mcp__docs__search");
		if (!withdrawn) throw new Error("Withdrawn MCP tool is missing");
		await expect(wrapToolDefinition(withdrawn).execute("id", {})).rejects.toMatchObject({
			executionOutcome: "not_started",
		});
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
		expect(closed).toHaveBeenCalledTimes(1);
	});
	it.each([true, false])(
		"strict child grants do not discover generic resources without server scope (restricted=%s)",
		async (restricted) => {
			const h = harness({ allowlist: ["mcp__docs__*"] });
			const pair = transport(true);
			await createMcpExtension({
				agentDir: h.agentDir,
				restricted,
				loadConfig: () => ({
					servers: [{ name: "docs", config: { command: "unused" }, source: "test" }],
					errors: [],
				}),
				createTransport: () => pair.client,
			})(h.pi);
			await h.handlers.get("session_start")?.({}, h.ctx);
			await vi.waitFor(() => expect(h.tools.has("mcp__docs__search")).toBe(true));
			expect(pair.methods).toEqual(["initialize", "tools/list"]);
			expect(h.tools.has("read_mcp_resource")).toBe(false);
			await h.handlers.get("session_shutdown")?.({}, h.ctx);
		},
	);
	it("cancels the first direct-server wait with the current turn signal", async () => {
		const h = harness();
		const pair = createInMemoryTransportPair();
		const initializing = new Promise<void>((resolve) => pair.server.onMessage(() => resolve()));
		void pair.server.start();
		await createMcpExtension({
			agentDir: h.agentDir,
			loadConfig: () => ({
				servers: [{ name: "docs", config: { command: "unused", exposure: "direct" }, source: "test" }],
				errors: [],
			}),
			createTransport: () => pair.client,
		})(h.pi);
		await h.handlers.get("session_start")?.({}, h.ctx);
		await initializing;
		const cancel = new AbortController();
		const start = Date.now();
		const waiting = h.handlers.get("before_agent_start")?.({}, { ...h.ctx, signal: cancel.signal });
		cancel.abort();
		await waiting;
		expect(Date.now() - start).toBeLessThan(1000);
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
	});

	it("drains pending initialization on shutdown", async () => {
		const h = harness();
		const pair = createInMemoryTransportPair();
		const closed = vi.fn();
		pair.client.onClose(closed);
		const initializing = new Promise<void>((resolve) => pair.server.onMessage(() => resolve()));
		void pair.server.start();
		await createMcpExtension({
			agentDir: h.agentDir,
			loadConfig: () => ({ servers: [{ name: "docs", config: { command: "unused" }, source: "test" }], errors: [] }),
			createTransport: () => pair.client,
		})(h.pi);
		await h.handlers.get("session_start")?.({}, h.ctx);
		await initializing;
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
		expect(closed).toHaveBeenCalledTimes(1);
	});
});

describe("MCP manager", () => {
	it("keeps a subscribed menu usable during background changes, honors configurable keys, and disposes waiters", async () => {
		initTheme();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const kb = new KeybindingsManager({ "tui.select.confirm": "tab", "tui.select.cancel": "alt+x" });
		const view = new McpManagerView(tui, theme, kb);
		let update!: () => void;
		const unsubscribe = vi.fn();
		let details = "connecting";
		const menu = view.menu(
			() => ({
				title: "MCP",
				details,
				items: [{ value: "docs", label: "docs", description: "\x1b[?1049hUnsafe" }],
				confirmLabel: "select",
				cancelLabel: "close",
			}),
			(listener) => {
				update = listener;
				return unsubscribe;
			},
		);
		details = "connected";
		update();
		expect(view.render(30).every((line) => visibleWidth(line) <= 30)).toBe(true);
		expect(view.render(30).join("\n")).not.toContain("\x1b[?1049h");
		view.handleInput("\t");
		expect(await menu).toBe("docs");
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		const cancel = new AbortController();
		const redirect = view.redirectUrl("Sign in", "https://example.test/authorize", cancel.signal);
		view.focused = true;
		cancel.abort();
		expect(await redirect).toBeUndefined();
		const pending = view.menu(() => ({ title: "MCP", items: [], confirmLabel: "", cancelLabel: "close" }));
		view.dispose();
		expect(await pending).toBeUndefined();
	});
});
