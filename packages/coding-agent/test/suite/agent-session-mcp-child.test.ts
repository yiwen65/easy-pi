import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ChildSession, ChildSessionCreateOptions } from "@easy-pi/subagent/session-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { mcpNamespace } from "../../src/core/mcp-servers.ts";
import type { LoadedMcpConfig, McpExposure, McpStdioServerConfig } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension, getSessionMcpConfig } from "../../src/extensions/mcp/index.ts";
import { bindNativeSession } from "../../src/extensions/native-session-binding.ts";
import { createPiChildSessionHost } from "../../src/extensions/pi-child-session-host.ts";
import { registerPiCollaborationRoot } from "../../src/extensions/pi-collaboration-root.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { spawnArgs } from "../collaboration-fixture.ts";
import { createHarness, getMessageText } from "./harness.ts";

const fixture = fileURLToPath(new URL("../fixtures/mcp-migration/owned-stdio-server.mjs", import.meta.url));
const resourceNames = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
const echoTool = "mcp__docs__echo";
const otherTool = "mcp__docs__other";
const full = () => ({ mode: "full-access" as const, sessionGrants: [], protectedRoots: [] });
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface AuditRecord {
	event: string;
	server: string;
	pid: number;
	cwd?: string;
	marker?: string;
	method?: string;
	params?: { name?: string; arguments?: { query?: string } };
}

async function setup(exposure: McpExposure = "direct") {
	const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "epi-mcp-child-")));
	cleanups.push(async () => rmSync(agentDir, { recursive: true, force: true }));
	const auditPath = join(agentDir, "audit.jsonl");
	const config = (name: string): McpStdioServerConfig => ({
		command: process.execPath,
		args: [fixture, auditPath, name],
		env: { MCP_MIGRATION_FIXTURE_MARKER: "instance-scoped" },
		exposure,
	});
	const loaded: LoadedMcpConfig = { servers: [{ name: "docs", config: config("docs"), source: "test" }], errors: [] };
	const root = await createHarness({
		initialActiveToolNames: [],
		hfCompaction: { mode: "off" },
		extensionFactories: [
			createToolSearchExtension(),
			{ name: "mcp", factory: createMcpExtension({ agentDir, loadConfig: () => loaded }) },
		],
	});
	cleanups.push(async () => {
		await root.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await root.session.shutdown();
		root.cleanup();
	});
	await root.session.bindExtensions({ mode: "rpc" });
	await vi.waitFor(() => expect(root.session.getAllTools().some((tool) => tool.name === echoTool)).toBe(true));
	const cwd = realpathSync(root.tempDir);
	const natives = new Map<string, AgentSession>();
	const snapshots: string[][] = [];
	const host = createPiChildSessionHost({
		modelRuntime: root.session.modelRuntime,
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		noExtensions: true,
		getTools: () => root.session.getDelegatableToolNames(),
		getMcpConfig(toolNames) {
			snapshots.push([...toolNames]);
			const namespaces = new Set(
				root.session
					.getAllTools()
					.filter((tool) => toolNames.includes(tool.name))
					.map((tool) => tool.namespace?.name),
			);
			return { servers: loaded.servers.filter((entry) => namespaces.has(mcpNamespace(entry.name))), errors: [] };
		},
		registerTools: () => {},
		observeSession(identity, session) {
			natives.set(identity.agentPath, session);
			return () => {};
		},
		// An approved user extension still cannot connect a server outside the live child grant.
		additionalExtensions: () => [
			(pi) => {
				pi.registerMcpServer("blocked", config("blocked"));
			},
		],
	});
	async function create(name: string, toolAllowed?: ChildSessionCreateOptions["toolAllowed"]) {
		const child = await host.create({
			rootSessionId: root.session.sessionId,
			agentPath: `/root/${name}`,
			cwd,
			agentDir,
			model: { provider: root.getModel().provider, id: root.getModel().id, thinkingLevel: "off" },
			storage: { kind: "memory" },
			getPermissions: full,
			toolAllowed,
		});
		cleanups.push(() => child.dispose());
		return { child, native: natives.get(`/root/${name}`)! };
	}
	const audit = (): AuditRecord[] =>
		existsSync(auditPath)
			? readFileSync(auditPath, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as AuditRecord)
			: [];
	const starts = () => audit().filter((record) => record.event === "start");
	const calls = () => audit().filter((record) => record.method === "tools/call");
	async function call(child: ChildSession, query: string) {
		root.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("Permission mode is full-access");
				return fauxAssistantMessage(fauxToolCall(echoTool, { query }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(fauxToolCall("deliver_result", { summary: query, outcome: "succeeded" }), {
				stopReason: "toolUse",
			}),
		]);
		expect(await child.run(`Echo ${query}`)).toMatchObject({
			status: "completed",
			text: JSON.stringify({ summary: query, outcome: "succeeded" }),
		});
	}
	return { root, create, agentDir, cwd, snapshots, audit, starts, calls, call };
}

describe("MCP ownership and live authority in native children", () => {
	it.each(["explicit", "inherit"] as const)(
		"executes a real stdio MCP call under %s delegation and preserves delivery/identity",
		async (grant) => {
			const processCwd = process.cwd();
			const marker = process.env.MCP_MIGRATION_FIXTURE_MARKER;
			const f = await setup();
			expect(resourceNames.every((name) => f.root.session.getActiveToolNames().includes(name))).toBe(true);
			const allowed = new Set([echoTool, "tool_search"]);
			const { child, native } = await f.create(
				grant,
				grant === "explicit" ? (name) => allowed.has(name) : undefined,
			);
			await vi.waitFor(() => expect(native.getActiveToolNames()).toContain(echoTool));
			expect(native.getActiveToolNames()).toContain("deliver_result");
			expect(child.identity).toEqual({ rootSessionId: f.root.session.sessionId, agentPath: `/root/${grant}` });
			for (const name of resourceNames) expect(native.getDelegatableToolNames()).not.toContain(name);
			if (grant === "explicit") expect(native.getAllTools().map((tool) => tool.name)).not.toContain(otherTool);
			await f.call(child, grant);
			const call = f.calls().at(-1)!;
			expect(call).toMatchObject({ server: "docs", params: { name: "echo", arguments: { query: grant } } });
			expect(
				getMessageText(
					child.context().find((message) => message.role === "toolResult" && message.toolName === echoTool),
				),
			).toBe(`docs:${call.pid}:${grant}`);
			expect(f.starts()).toHaveLength(2);
			expect(new Set(f.starts().map((record) => record.pid)).size).toBe(2);
			expect(f.starts().every((record) => record.server === "docs" && record.marker === "instance-scoped")).toBe(
				true,
			);
			expect(f.starts().find((record) => record.pid === call.pid)?.cwd).toBe(f.cwd);
			expect(
				f.audit().filter((record) => record.pid === call.pid && record.method?.startsWith("resources/")),
			).toEqual([]);
			expect(f.snapshots.every((names) => resourceNames.every((name) => !names.includes(name)))).toBe(true);
			expect(existsSync(join(f.agentDir, "auth.json"))).toBe(false);
			expect(existsSync(join(f.agentDir, "mcp-auth.json"))).toBe(false);
			expect(process.cwd()).toBe(processCwd);
			expect(process.env.MCP_MIGRATION_FIXTURE_MARKER).toBe(marker);
		},
	);

	it("keeps deferred tools undisclosed until discovery and retains activation on explicit follow-up", async () => {
		const f = await setup("deferred");
		const { child, native } = await f.create("discovery");
		await vi.waitFor(() => expect(native.getAllTools().map((tool) => tool.name)).toContain(otherTool));
		expect(native.getActiveToolNames()).not.toContain(echoTool);
		expect(native.getActiveToolNames()).not.toContain(otherTool);
		const declared: string[][] = [];
		f.root.setResponses([
			(context) => {
				declared.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "Echo documentation query", limit: 1 }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				declared.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage(
					fauxToolCall("deliver_result", { summary: "discovered", outcome: "succeeded" }),
					{ stopReason: "toolUse" },
				);
			},
		]);
		expect(await child.run("Discover the documentation echo tool")).toMatchObject({ status: "completed" });
		expect(declared[0]).not.toContain(echoTool);
		expect(declared[0]).not.toContain(otherTool);
		expect(declared[1]).toContain(echoTool);
		expect(declared[1]).not.toContain(otherTool);
		expect(native.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "toolResult", toolName: "tool_search", addedToolNames: [echoTool] }),
			]),
		);
		await f.call(child, "follow-up");
		expect(native.getActiveToolNames()).toContain(echoTool);
		expect(native.getActiveToolNames()).not.toContain(otherTool);
		expect(f.calls().map((record) => record.params?.arguments?.query)).toEqual(["follow-up"]);
		expect(f.starts()).toHaveLength(2);
		expect(JSON.stringify(child.context())).toContain("Discover the documentation echo tool");
	});

	it("revokes cached calls and undiscovered metadata before tool execution, then preserves revocation on follow-up", async () => {
		const f = await setup("deferred");
		const { child, native } = await f.create("revoked");
		await vi.waitFor(() => expect(native.getAllTools().map((tool) => tool.name)).toContain(otherTool));
		f.root.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "Echo documentation query", limit: 1 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("deliver_result", { summary: "ready", outcome: "succeeded" }), {
				stopReason: "toolUse",
			}),
		]);
		await child.run("Discover echo before the root revokes MCP");
		expect(native.getActiveToolNames()).toContain(echoTool);
		const before = f.calls().length;
		f.root.setResponses([
			() => {
				f.root.session.setToolAccessByName(["tool_search"]);
				return fauxAssistantMessage(
					[
						fauxToolCall(echoTool, { query: "denied" }),
						fauxToolCall("tool_search", { query: "Other undiscovered operation", limit: 1 }),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(fauxToolCall("deliver_result", { summary: "revoked", outcome: "succeeded" }), {
				stopReason: "toolUse",
			}),
		]);
		expect(await child.run("The root revokes while the model is responding")).toMatchObject({ status: "completed" });
		expect(f.calls()).toHaveLength(before);
		expect(
			native.messages.filter((message) => message.role === "toolResult" && message.toolName === echoTool).at(-1),
		).toMatchObject({ isError: true });
		const search = native.messages
			.filter((message) => message.role === "toolResult" && message.toolName === "tool_search")
			.at(-1);
		expect(getMessageText(search)).toBe("No matching tools found.");
		expect(native.getAllTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
		f.root.setResponses([
			(context) => {
				expect(context.tools?.some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "Echo documentation query" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(fauxToolCall("deliver_result", { summary: "still revoked", outcome: "succeeded" }), {
				stopReason: "toolUse",
			}),
		]);
		await child.run("Follow up after revocation");
		expect(f.calls()).toHaveLength(before);
		expect(native.getDelegatableToolNames()).not.toContain(echoTool);
	});

	it("does not inherit generic resource names or connect any server for a resource-only grant", async () => {
		const f = await setup();
		const before = f.starts();
		const { child, native } = await f.create("resource-only", (name) => resourceNames.includes(name));
		f.root.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("list_mcp_resources", { server: "docs" }),
					fauxToolCall("read_mcp_resource", { server: "blocked", uri: "blocked://intro" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("deliver_result", { summary: "scope denied", outcome: "succeeded" }), {
				stopReason: "toolUse",
			}),
		]);
		expect(await child.run("Generic names are not server authority")).toMatchObject({ status: "completed" });
		expect(native.getActiveToolNames()).toEqual(["deliver_result"]);
		expect(f.starts()).toEqual(before);
		expect(f.calls()).toEqual([]);
		for (const name of resourceNames) expect(native.getToolDefinition(name)).toBeUndefined();
		const denied = child
			.context()
			.filter((message) => message.role === "toolResult" && message.toolName !== "deliver_result");
		expect(denied).toHaveLength(2);
		expect(denied.every((message) => message.role === "toolResult" && message.isError)).toBe(true);
	});

	it("disposes only its own transport while the root and another child remain usable", async () => {
		const f = await setup();
		const a = await f.create("a", (name) => name === echoTool);
		const b = await f.create("b", (name) => name === echoTool);
		await f.call(a.child, "a-first");
		await f.call(b.child, "b-first");
		const aPid = f.calls().find((record) => record.params?.arguments?.query === "a-first")!.pid;
		const bPid = f.calls().find((record) => record.params?.arguments?.query === "b-first")!.pid;
		const rootPid = f.starts()[0].pid;
		expect(new Set([aPid, bPid, rootPid]).size).toBe(3);
		await a.child.dispose();
		await a.child.dispose();
		expect(f.audit()).toContainEqual(expect.objectContaining({ event: "exit", pid: aPid }));
		expect(() => process.kill(aPid, 0)).toThrow();
		f.root.setResponses([
			fauxAssistantMessage(fauxToolCall(echoTool, { query: "root-after-close" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("root alive"),
		]);
		await f.root.session.prompt("Root echo after disposing child a");
		await f.call(b.child, "b-after-close");
		expect(f.calls().find((record) => record.params?.arguments?.query === "root-after-close")?.pid).toBe(rootPid);
		expect(f.calls().find((record) => record.params?.arguments?.query === "b-after-close")?.pid).toBe(bPid);
		expect(f.starts()).toHaveLength(3);
		expect(JSON.stringify(a.child.context())).not.toContain("b-after-close");
	});

	it("production spawn uses the root's approved MCP view after an on-disk config replacement", async () => {
		const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "epi-mcp-production-root-")));
		cleanups.push(async () => rmSync(agentDir, { recursive: true, force: true }));
		const auditPath = join(agentDir, "audit.jsonl");
		const configPath = join(agentDir, "mcp.json");
		const config = (server: string): McpStdioServerConfig => ({
			command: process.execPath,
			args: [fixture, auditPath, server],
			exposure: "direct",
		});
		const approved = config("docs");
		writeFileSync(configPath, JSON.stringify({ mcpServers: { docs: approved, blocked: config("blocked") } }));
		const root = await createHarness({
			initialActiveToolNames: [],
			allowedToolNames: [echoTool, "spawn_agent", "wait_agent", "get_agent_result", "close_agent"],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			hfCompaction: { mode: "off" },
			extensionFactories: [
				{ name: "mcp", factory: createMcpExtension({ agentDir }) },
				{ name: "production-root", factory: (pi) => registerPiCollaborationRoot(pi, agentDir, full) },
			],
		});
		cleanups.push(async () => {
			await root.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await root.session.shutdown();
			root.cleanup();
		});
		bindNativeSession(root.session);
		await root.session.bindExtensions({ mode: "rpc" });
		await vi.waitFor(() => expect(root.session.getActiveToolNames()).toContain(echoTool));
		expect(root.session.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toContain(
			"<inline:mcp>",
		);
		expect(getSessionMcpConfig(root.session.sessionManager)).toMatchObject({
			servers: [{ name: "docs", config: approved }],
		});
		const tool = (name: string) => {
			const found = root.session.agent.state.tools.find((candidate) => candidate.name === name);
			if (!found) throw new Error(`Missing production root tool ${name}`);
			return found;
		};
		const audit = (): AuditRecord[] =>
			readFileSync(auditPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as AuditRecord);
		const rootPid = audit().find((record) => record.event === "start")!.pid;
		const childPids: number[] = [];
		async function spawnAndCall(name: string) {
			const result = { summary: `approved-${name}`, outcome: "succeeded" };
			let declared: string[] = [];
			let taskText = "";
			let responseText = "";
			let responseError: boolean | undefined;
			// Root tools execute through their real bound facade; only the child consumes faux responses.
			root.setResponses([
				(context) => {
					taskText = getMessageText(context.messages.filter((message) => message.role === "user").at(-1));
					declared = context.tools?.map((candidate) => candidate.name) ?? [];
					return fauxAssistantMessage(fauxToolCall(echoTool, { query: name }), { stopReason: "toolUse" });
				},
				(context) => {
					const response = context.messages.find(
						(message) => message.role === "toolResult" && message.toolName === echoTool,
					);
					responseText = getMessageText(response);
					responseError = response?.role === "toolResult" ? response.isError : undefined;
					return fauxAssistantMessage(fauxToolCall("deliver_result", result), { stopReason: "toolUse" });
				},
			]);
			const spawned = await tool("spawn_agent").execute(`spawn-${name}`, {
				...spawnArgs(name, `Echo ${name} using the approved MCP tool`),
				tools: [echoTool],
			});
			const receipt = spawned.details as { task_name: string; turn_id: string };
			const waited = await tool("wait_agent").execute(`wait-${name}`, {
				target: receipt.task_name,
				turn_id: receipt.turn_id,
				timeout_ms: 10_000,
			});
			expect(waited.details).toMatchObject({ reason: "terminal", result: { turn: { status: "completed" } } });
			expect(taskText).toContain(`You are child /root/${name};`);
			expect(
				declared.sort(),
				`Child result: ${responseText}; fixture starts: ${JSON.stringify(audit().filter((record) => record.event === "start"))}`,
			).toEqual(["deliver_result", echoTool].sort());
			for (const resource of resourceNames) expect(declared).not.toContain(resource);
			expect(responseError, responseText).toBe(false);
			const call = audit().find(
				(record) => record.method === "tools/call" && record.params?.arguments?.query === name,
			)!;
			expect(call).toMatchObject({ server: "docs", params: { name: "echo" } });
			expect(responseText).toBe(`docs:${call.pid}:${name}`);
			childPids.push(call.pid);
			const retained = await tool("get_agent_result").execute(`result-${name}`, {
				target: receipt.task_name,
				turn_id: receipt.turn_id,
			});
			expect(retained.details).toMatchObject({ state: "found", result: { preview: JSON.stringify(result) } });
			await tool("close_agent").execute(`close-${name}`, { target: receipt.task_name });
		}
		await spawnAndCall("before");
		// Same configured name and executable, but changed process arguments would open a different server.
		const replacement = config("replacement");
		writeFileSync(configPath, JSON.stringify({ mcpServers: { docs: replacement, blocked: config("blocked") } }));
		expect(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.docs).toEqual(replacement);
		expect(getSessionMcpConfig(root.session.sessionManager)?.servers[0].config).toEqual(approved);
		await spawnAndCall("after");
		expect(new Set([rootPid, ...childPids]).size).toBe(3);
		expect(audit().filter((record) => record.event === "start")).toHaveLength(3);
		expect(audit().every((record) => record.server === "docs")).toBe(true);
		expect(
			audit().filter((record) => childPids.includes(record.pid) && record.method?.startsWith("resources/")),
		).toEqual([]);
		expect(root.faux.state.callCount).toBe(4);
		expect(root.getPendingResponseCount()).toBe(0);
	});
});
