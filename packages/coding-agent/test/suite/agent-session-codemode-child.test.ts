import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ChildSessionCreateOptions } from "@easy-pi/subagent/session-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { mcpNamespace } from "../../src/core/mcp-servers.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import type { LoadedMcpConfig, McpStdioServerConfig } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension, getSessionMcpConfig } from "../../src/extensions/mcp/index.ts";
import { bindNativeSession } from "../../src/extensions/native-session-binding.ts";
import { createPiChildSessionHost } from "../../src/extensions/pi-child-session-host.ts";
import { registerPiCollaborationRoot } from "../../src/extensions/pi-collaboration-root.ts";
import { spawnArgs } from "../collaboration-fixture.ts";
import { createHarness, getMessageText } from "./harness.ts";

const fixture = fileURLToPath(new URL("../fixtures/mcp-migration/owned-stdio-server.mjs", import.meta.url));
const echoTool = "mcp__docs__echo";
const otherTool = "mcp__docs__other";
const resourceTools = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
const teamTools = ["spawn_agent", "send_message", "followup_task", "wait_agent", "close_agent"];
const full = () => ({ mode: "full-access" as const, sessionGrants: [], protectedRoots: [] });
const cleanups: Array<() => Promise<void>> = [];

interface AuditRecord {
	event: string;
	server: string;
	pid: number;
	method?: string;
	params?: { name?: string; arguments?: { query?: string } };
}

function readAudit(path: string): AuditRecord[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as AuditRecord)
		: [];
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { revokeOnQuery?: string } = {}) {
	const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "epi-codemode-child-")));
	cleanups.push(async () => rmSync(agentDir, { recursive: true, force: true }));
	const auditPath = join(agentDir, "audit.jsonl");
	const config = (name: string): McpStdioServerConfig => ({
		command: process.execPath,
		args: [fixture, auditPath, name],
		exposure: "codemode",
	});
	const loaded: LoadedMcpConfig = { servers: [{ name: "docs", config: config("docs"), source: "test" }], errors: [] };
	const root = await createHarness({
		hfCompaction: { mode: "off" },
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		initialActiveToolNames: ["codemode"],
		allowedToolNames: ["codemode", echoTool],
		extensionFactories: [
			createCodemodeExtension(),
			{ name: "mcp", factory: createMcpExtension({ agentDir, loadConfig: () => loaded }) },
		],
	});
	cleanups.push(async () => {
		await root.session.shutdown();
		root.cleanup();
	});
	await root.session.bindExtensions({ mode: "rpc" });
	await vi.waitFor(() => expect(root.session.getAllTools().map((tool) => tool.name)).toContain(echoTool));
	const natives = new Map<string, AgentSession>();
	const host = createPiChildSessionHost({
		modelRuntime: root.session.modelRuntime,
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		noExtensions: true,
		getTools: () => root.session.getDelegatableToolNames(),
		getMcpConfig(toolNames) {
			const approved = getSessionMcpConfig(root.session.sessionManager);
			const namespaces = new Set(
				root.session
					.getAllTools()
					.filter((tool) => toolNames.includes(tool.name))
					.map((tool) => tool.namespace?.name),
			);
			return {
				servers: (approved?.servers ?? []).filter((entry) => namespaces.has(mcpNamespace(entry.name))),
				errors: [],
			};
		},
		registerTools: () => {},
		observeSession(identity, session) {
			natives.set(identity.agentPath, session);
			return () => {};
		},
		additionalExtensions: () => [
			(pi) => {
				pi.registerMcpServer("blocked", config("blocked"));
				pi.on("tool_result", (event) => {
					if (event.toolName === echoTool && event.input.query === options.revokeOnQuery)
						root.session.setToolAccessByName(["codemode"]);
				});
			},
		],
	});
	async function create(
		name: string,
		toolAllowed: ChildSessionCreateOptions["toolAllowed"] = (name) => name === "codemode" || name === echoTool,
	) {
		const child = await host.create({
			rootSessionId: root.session.sessionId,
			agentPath: `/root/${name}`,
			cwd: realpathSync(root.tempDir),
			agentDir,
			model: { provider: root.getModel().provider, id: root.getModel().id, thinkingLevel: "off" },
			storage: { kind: "memory" },
			getPermissions: full,
			toolAllowed,
		});
		cleanups.push(() => child.dispose());
		const native = natives.get(`/root/${name}`)!;
		await vi.waitFor(() => expect(native.getAllTools().map((tool) => tool.name)).toContain(echoTool));
		return { child, native };
	}
	const audit = () => readAudit(auditPath);
	const calls = () => audit().filter((record) => record.method === "tools/call");
	const starts = () => audit().filter((record) => record.event === "start");
	return { root, create, calls, starts, audit, agentDir, auditPath };
}

describe("codemode and concrete MCP grants in native children", () => {
	it("owns an independent transport and cannot reach resources, unrelated MCP tools, or root team tools", async () => {
		const f = await setup();
		const { child, native } = await f.create("script");
		const declared: string[][] = [];
		f.root.setResponses([
			(context) => {
				declared.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage(
					fauxToolCall("codemode", {
						code: `
const denied = ${JSON.stringify([...resourceTools, ...teamTools, otherTool])};
if (denied.some(name => ALL_TOOLS.some(tool => tool.name === name))) throw new Error("child catalog widened");
if (denied.some(name => name in tools)) throw new Error("child bindings widened");
return (await tools.${echoTool}({query:"child"})).content[0].text;
`,
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(
				fauxToolCall("deliver_result", { summary: "child script finished", outcome: "succeeded" }),
				{ stopReason: "toolUse" },
			),
		]);
		expect(await child.run("Use only the delegated script target")).toMatchObject({ status: "completed" });
		expect(declared).toEqual([["deliver_result", "report_progress", "codemode"]]);
		expect(native.getDelegatableToolNames().sort()).toEqual(
			["deliver_result", "report_progress", "codemode", echoTool].sort(),
		);
		const result = native.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "codemode",
		);
		expect(result, getMessageText(result)).toMatchObject({ isError: false });
		const call = f.calls().at(-1)!;
		expect(call).toMatchObject({ server: "docs", params: { name: "echo", arguments: { query: "child" } } });
		expect(getMessageText(result)).toContain(`docs:${call.pid}:child`);
		expect(f.starts()).toHaveLength(2);
		expect(new Set(f.starts().map((record) => record.pid)).size).toBe(2);
		expect(f.audit().filter((record) => record.pid === call.pid && record.method?.startsWith("resources/"))).toEqual(
			[],
		);
		expect(f.audit().every((record) => record.server === "docs")).toBe(true);
		expect(existsSync(join(f.agentDir, "auth.json"))).toBe(false);
		expect(existsSync(join(f.agentDir, "mcp-auth.json"))).toBe(false);
		await child.dispose();
		expect(f.audit()).toContainEqual(expect.objectContaining({ event: "exit", pid: call.pid }));
		expect(() => process.kill(call.pid, 0)).toThrow();
		const rootPid = f.starts().find((record) => record.pid !== call.pid)!.pid;
		expect(() => process.kill(rootPid, 0)).not.toThrow();
	});

	it("honors root revocation during a cached script and hides revoked discovery metadata", async () => {
		const f = await setup({ revokeOnQuery: "revoke" });
		const { child, native } = await f.create("revoked");
		f.root.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `
const cached = tools.${echoTool};
await cached({query:"revoke"});
const matches = await searchTools("Echo documentation query");
const description = await describeTool("${echoTool}");
const namespace = await describeNamespace("docs");
let rejected = false;
try { await cached({query:"denied"}); } catch { rejected = true; }
return { matches, description: description ?? null, namespace: namespace ?? null, rejected };
`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("deliver_result", { summary: "revoked", outcome: "succeeded" }), {
				stopReason: "toolUse",
			}),
		]);
		await child.run("The root revokes after the first nested call");
		const result = native.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "codemode",
		);
		expect(result, getMessageText(result)).toMatchObject({ isError: false });
		expect(getMessageText(result)).toContain('"matches":[],"description":null,"namespace":null,"rejected":true');
		expect(f.calls().map((record) => record.params?.arguments?.query)).toEqual(["revoke"]);
		f.root.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `return { matches: await searchTools("Echo documentation query"), available: "${echoTool}" in tools };`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("deliver_result", { summary: "still revoked", outcome: "succeeded" }), {
				stopReason: "toolUse",
			}),
		]);
		await child.run("Follow up after revocation");
		expect(f.calls()).toHaveLength(1);
		const followup = native.messages
			.filter((message) => message.role === "toolResult" && message.toolName === "codemode")
			.at(-1);
		expect(getMessageText(followup)).toContain('"matches":[],"available":false');
	});

	it("enforces a live ancestry restriction independently of the root's current grant", async () => {
		const f = await setup();
		let ancestorAllowsEcho = true;
		const { child, native } = await f.create(
			"ancestor",
			(name) => name === "codemode" || (ancestorAllowsEcho && name === echoTool),
		);
		f.root.setResponses([
			() => {
				ancestorAllowsEcho = false;
				return fauxAssistantMessage(
					fauxToolCall("codemode", {
						code: `return { matches: await searchTools("Echo documentation query"), available: "${echoTool}" in tools };`,
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(fauxToolCall("deliver_result", { summary: "ancestor denied", outcome: "succeeded" }), {
				stopReason: "toolUse",
			}),
		]);
		await child.run("The ancestor narrows while the provider responds");
		const result = native.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "codemode",
		);
		expect(result).toMatchObject({ isError: false });
		expect(getMessageText(result)).toContain('"matches":[],"available":false');
		expect(f.calls()).toEqual([]);
		expect(f.root.session.getDelegatableToolNames()).toContain(echoTool);
	});

	it("production spawn retains concrete script capabilities and the approved config after the file changes", async () => {
		const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "epi-codemode-production-child-")));
		cleanups.push(async () => rmSync(agentDir, { recursive: true, force: true }));
		const auditPath = join(agentDir, "audit.jsonl");
		const configPath = join(agentDir, "mcp.json");
		const config = (server: string): McpStdioServerConfig => ({
			command: process.execPath,
			args: [fixture, auditPath, server],
			exposure: "codemode",
		});
		const approved = config("docs");
		writeFileSync(configPath, JSON.stringify({ mcpServers: { docs: approved, blocked: config("blocked") } }));
		const root = await createHarness({
			hfCompaction: { mode: "off" },
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			initialActiveToolNames: ["codemode"],
			allowedToolNames: ["codemode", echoTool, "spawn_agent", "wait_agent", "get_agent_result", "close_agent"],
			extensionFactories: [
				createCodemodeExtension(),
				{ name: "mcp", factory: createMcpExtension({ agentDir }) },
				{ name: "production-root", factory: (pi) => registerPiCollaborationRoot(pi, agentDir, full) },
			],
		});
		cleanups.push(async () => {
			await root.session.shutdown();
			root.cleanup();
		});
		bindNativeSession(root.session);
		await root.session.bindExtensions({ mode: "rpc" });
		await vi.waitFor(() => expect(root.session.getAllTools().map((tool) => tool.name)).toContain(echoTool));
		expect(getSessionMcpConfig(root.session.sessionManager)?.servers).toEqual([
			expect.objectContaining({ name: "docs", config: approved }),
		]);
		const tool = (name: string) => {
			const found = root.session.agent.state.tools.find((candidate) => candidate.name === name);
			if (!found) throw new Error(`Missing root tool ${name}`);
			return found;
		};
		// The production controller deliberately redacts host exceptions in retained receipts.
		// Forward the real getter unchanged while retaining its first failure for this regression.
		let authorityFailure: string | undefined;
		const getDelegatable = AgentSession.prototype.getDelegatableToolNames;
		const authoritySpy = vi.spyOn(AgentSession.prototype, "getDelegatableToolNames").mockImplementation(function (
			this: AgentSession,
		) {
			try {
				return getDelegatable.call(this);
			} catch (error) {
				authorityFailure ??= error instanceof Error ? (error.stack ?? error.message) : String(error);
				throw error;
			}
		});
		cleanups.push(async () => {
			authoritySpy.mockRestore();
		});
		const rootPid = readAudit(auditPath).find((record) => record.event === "start")!.pid;
		const childPids: number[] = [];
		async function spawnAndCall(name: string) {
			let declared: string[] = [];
			let scriptOutput = "";
			let scriptError: boolean | undefined;
			const result = { summary: `approved-${name}`, outcome: "succeeded" };
			root.setResponses([
				(context) => {
					declared = context.tools?.map((candidate) => candidate.name) ?? [];
					return fauxAssistantMessage(
						fauxToolCall("codemode", {
							code: `return (await tools.${echoTool}({query:${JSON.stringify(name)}})).content[0].text;`,
						}),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const response = context.messages.find(
						(message) => message.role === "toolResult" && message.toolName === "codemode",
					);
					scriptOutput = getMessageText(response);
					scriptError = response?.role === "toolResult" ? response.isError : undefined;
					return fauxAssistantMessage(fauxToolCall("deliver_result", result), { stopReason: "toolUse" });
				},
			]);
			const spawned = await tool("spawn_agent").execute(`spawn-${name}`, {
				...spawnArgs(name, `Echo ${name} using only the concrete script grant`),
				tools: ["codemode", echoTool],
			});
			const receipt = spawned.details as { task_name: string; turn_id: string };
			const waited = await tool("wait_agent").execute(`wait-${name}`, {
				target: receipt.task_name,
				turn_id: receipt.turn_id,
				timeout_ms: 10_000,
			});
			expect(waited.details, JSON.stringify({ receipt: waited.details, authorityFailure })).toMatchObject({
				reason: "terminal",
				result: { turn: { status: "completed" } },
			});
			expect(declared.sort(), scriptOutput).toEqual(["deliver_result", "report_progress", "codemode"].sort());
			expect(scriptError, scriptOutput).toBe(false);
			const call = readAudit(auditPath).find(
				(record) => record.method === "tools/call" && record.params?.arguments?.query === name,
			)!;
			expect(call).toMatchObject({ server: "docs", params: { name: "echo" } });
			expect(scriptOutput).toContain(`docs:${call.pid}:${name}`);
			childPids.push(call.pid);
			const retained = await tool("get_agent_result").execute(`result-${name}`, {
				target: receipt.task_name,
				turn_id: receipt.turn_id,
			});
			expect(retained.details).toMatchObject({ state: "found", result: { preview: JSON.stringify(result) } });
			await tool("close_agent").execute(`close-${name}`, { target: receipt.task_name });
			expect(() => process.kill(call.pid, 0)).toThrow();
		}
		await spawnAndCall("before");
		writeFileSync(
			configPath,
			JSON.stringify({ mcpServers: { docs: config("replacement"), blocked: config("blocked") } }),
		);
		expect(getSessionMcpConfig(root.session.sessionManager)?.servers[0].config).toEqual(approved);
		await spawnAndCall("after");
		expect(new Set([rootPid, ...childPids]).size).toBe(3);
		const audit = readAudit(auditPath);
		expect(audit.filter((record) => record.event === "start")).toHaveLength(3);
		expect(audit.every((record) => record.server === "docs")).toBe(true);
		expect(
			audit.filter((record) => childPids.includes(record.pid) && record.method?.startsWith("resources/")),
		).toEqual([]);
		expect(root.getPendingResponseCount()).toBe(0);
	});
});
