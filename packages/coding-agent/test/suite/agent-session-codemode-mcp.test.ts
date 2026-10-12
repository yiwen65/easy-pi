import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION, type Tool } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import type { TaskRecoveryState } from "../../src/core/task-recovery.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { CODEMODE_STORE_ENTRY_TYPE } from "../../src/extensions/codemode/tool.ts";
import type { McpExposure } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const searchName = "mcp__docs__search";
const failName = "mcp__docs__fail";
const hiddenName = "mcp__docs__hidden";
const tools: Tool[] = [
	{
		name: "search",
		description: "Search documentation guides",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		outputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{ name: "fail", description: "Known remote failure", inputSchema: { type: "object", properties: {} } },
	{ name: "hidden", description: "Private hidden operation", inputSchema: { type: "object", properties: {} } },
];

interface RpcCall {
	name: string;
	arguments: Record<string, unknown>;
}

function server(calls: RpcCall[], options: { dropOnce?: boolean; onCall?: (call: RpcCall) => void } = {}) {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		let result: unknown = {};
		switch (request.method) {
			case "initialize":
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "docs", version: "1" },
				};
				break;
			case "tools/list":
				result = { tools };
				break;
			case "tools/call": {
				const params = request.params as unknown as RpcCall;
				const call = { name: params.name, arguments: params.arguments };
				calls.push(call);
				options.onCall?.(call);
				if (options.dropOnce && calls.length === 1) {
					void pair.server.close();
					return;
				}
				result =
					call.name === "fail"
						? {
								content: [
									{ type: "text", text: "Known remote failure", _meta: { private: "block-metadata" } },
									{
										type: "resource",
										resource: {
											uri: "docs://failed",
											text: "Public failure detail",
											_meta: { private: "resource-metadata" },
										},
										_meta: { private: "embedded-metadata" },
									},
								],
								isError: true,
								_meta: { credential: "must-not-reach-script" },
							}
						: {
								content: [
									{
										type: "text",
										text: `Guide: ${call.arguments.query}`,
										_meta: { private: "block-metadata" },
									},
									{
										type: "resource",
										resource: {
											uri: "docs://guide",
											text: "Public guide detail",
											_meta: { private: "resource-metadata" },
										},
										_meta: { private: "embedded-metadata" },
									},
								],
								structuredContent: { query: call.arguments.query },
								_meta: { credential: "must-not-reach-script" },
							};
				break;
			}
		}
		void pair.server.send({ jsonrpc: "2.0", id: request.id, result });
	});
	void pair.server.start();
	return pair;
}

function originalTask(harness: Harness, taskId: string): TaskRecoveryState | undefined {
	const current = harness.session.taskRecovery;
	if (current?.id === taskId) return current;
	return current?.suspendedTasks?.find((task) => task.state.id === taskId)?.state;
}

describe("codemode through real QuickJS and MCP", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function setup(
		options: {
			exposure?: McpExposure;
			allowed?: string[];
			excluded?: string[];
			active?: string[];
			autoEnableCodemode?: boolean;
			dropOnce?: boolean;
			onCall?: (call: RpcCall) => void;
			extra?: ExtensionFactory[];
			wait?: boolean;
			liveCheck?: (name: string) => boolean;
		} = {},
	) {
		const agentDir = mkdtempSync(join(tmpdir(), "epi-codemode-mcp-"));
		directories.push(agentDir);
		const calls: RpcCall[] = [];
		const transports: ReturnType<typeof server>[] = [];
		const harness = await createHarness({
			hfCompaction: { mode: "off" },
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			initialActiveToolNames: options.active ?? ["codemode"],
			allowedToolNames: options.allowed,
			excludedToolNames: options.excluded,
			extensionFactories: [
				createCodemodeExtension(),
				...(options.extra ?? []),
				createMcpExtension({
					agentDir,
					loadConfig: () => ({
						...(options.autoEnableCodemode === undefined
							? {}
							: { autoEnableCodemode: options.autoEnableCodemode }),
						servers: [
							{
								name: "docs",
								config: {
									command: "unused",
									exposure: options.exposure ?? "codemode",
									toolExposure: { hidden: "hidden" },
								},
								source: "test",
							},
						],
						errors: [],
					}),
					createTransport: () => {
						const pair = server(calls, options);
						transports.push(pair);
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		if (options.liveCheck) harness.session.setLiveToolAccessCheck(options.liveCheck);
		await harness.session.bindExtensions({ mode: "rpc" });
		if (options.wait !== false) {
			await vi.waitFor(() =>
				expect(harness.session.getAllTools().some((tool) => tool.name === searchName)).toBe(true),
			);
		}
		const script = async (code: string) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Run the local script");
			const result = harness.session.messages
				.filter((message) => message.role === "toolResult" && message.toolName === "codemode")
				.at(-1);
			expect(result?.role).toBe("toolResult");
			return result;
		};
		return { harness, calls, transports, script };
	}

	it("returns full public MCP results, preserves known error certainty, and keeps nested results out of the transcript", async () => {
		const hooks: Array<{ name: string; parent?: string }> = [];
		const f = await setup({
			allowed: ["codemode", "mcp__docs__*"],
			extra: [
				(pi) =>
					pi.on("tool_call", (event) => {
						hooks.push({ name: event.toolName, parent: event.parentToolCallId });
					}),
			],
		});
		const result = await f.script(`
const found = await tools.${searchName}({ query: "sandbox" });
const failed = await tools.${failName}({});
if (found._meta !== undefined || failed._meta !== undefined) throw new Error("private metadata leaked");
for (const result of [found, failed]) {
  for (const block of result.content) {
    if (block._meta !== undefined || (block.type === "resource" && block.resource._meta !== undefined)) throw new Error("nested protocol metadata leaked");
  }
}
if (found.content[0].text !== "Guide: sandbox" || found.structuredContent.query !== "sandbox") throw new Error("lost public result");
if (failed.isError !== true || failed.content[0].text !== "Known remote failure") throw new Error("lost confirmed MCP error");
store("result", found.structuredContent);
return { found: found.structuredContent, failed: failed.isError };
`);
		expect(result).toMatchObject({ isError: false });
		expect(getMessageText(result)).toContain('"found":{"query":"sandbox"},"failed":true');
		expect(f.calls.map((call) => call.name)).toEqual(["search", "fail"]);
		expect(f.harness.session.taskRecovery?.status).toBe("completed");
		expect(hooks.filter((hook) => hook.parent).map((hook) => hook.name)).toEqual([searchName, failName]);
		expect(
			f.harness.session.messages.filter(
				(message) => message.role === "toolResult" && message.toolName.startsWith("mcp__"),
			),
		).toEqual([]);
		expect(f.harness.session.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: CODEMODE_STORE_ENTRY_TYPE,
				data: { set: { result: { query: "sandbox" } }, delete: [] },
			}),
		);
	});

	it("keeps wildcard startup eligibility while enforcing a live concrete restriction", async () => {
		const allowed = new Set(["codemode", searchName]);
		const f = await setup({ allowed: ["codemode", "mcp__docs__*"], liveCheck: (name) => allowed.has(name) });
		expect(f.transports).toHaveLength(1);
		expect(f.harness.session.getToolAccess().allowlist).toContain("mcp__docs__*");
		expect(f.harness.session.getAllTools().map((tool) => tool.name)).not.toContain(failName);
		const result = await f.script(`return (await tools.${searchName}({query:"live wildcard"})).structuredContent;`);
		expect(result).toMatchObject({ isError: false });
		expect(f.calls).toHaveLength(1);
		allowed.delete(searchName);
		const revoked = await f.script(`return { entries: ALL_TOOLS, matches: await searchTools("documentation") };`);
		expect(getMessageText(revoked)).toContain('"entries":[],"matches":[]');
		expect(f.calls).toHaveLength(1);
	});

	it("calls deferred targets without tool_search or declaring them to the provider", async () => {
		const f = await setup({ exposure: "deferred", allowed: ["codemode", searchName] });
		const declarations: string[][] = [];
		f.harness.setResponses([
			(context) => {
				declarations.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage(
					fauxToolCall("codemode", {
						code: `return (await tools.${searchName}({ query: "deferred" })).content[0].text;`,
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				declarations.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage("done");
			},
		]);
		await f.harness.session.prompt("Use only the script declaration");
		expect(declarations).toEqual([["codemode"], ["codemode"]]);
		expect(f.harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(f.calls).toEqual([{ name: "search", arguments: { query: "deferred" } }]);
		const result = f.harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "codemode",
		);
		expect(result).toMatchObject({ isError: false });
		expect(getMessageText(result)).toContain("Guide: deferred");
	});

	it.each(["direct", "deferred", "codemode"] as const)(
		"codemode alone grants no %s MCP targets and opens no transport",
		async (exposure) => {
			const f = await setup({ exposure, allowed: ["codemode"], wait: false });
			const result = await f.script("return ALL_TOOLS.map(tool => tool.name);");
			expect(result).toMatchObject({ isError: false });
			expect(getMessageText(result)).toContain("[]");
			expect(f.transports).toEqual([]);
			expect(f.calls).toEqual([]);
			expect(f.harness.session.getAllTools().map((tool) => tool.name)).toEqual(["codemode"]);
		},
	);

	it("does not expose excluded or hidden tools through discovery or script bindings", async () => {
		const f = await setup({ allowed: ["codemode", "mcp__docs__*"], excluded: [failName] });
		const result = await f.script(`
const entries = ALL_TOOLS.map(tool => tool.name);
const described = [await describeTool("${failName}"), await describeTool("${hiddenName}")];
const matches = await searchTools("Known remote failure Private hidden operation");
const denied = ["${failName}" in tools, "${hiddenName}" in tools, "codemode" in tools];
return { entries, described, matches: matches.map(tool => tool.name), denied };
`);
		expect(result).toMatchObject({ isError: false });
		expect(getMessageText(result)).toContain(`"entries":["${searchName}"]`);
		expect(getMessageText(result)).toContain('"described":[null,null]');
		expect(getMessageText(result)).toContain('"matches":[]');
		expect(getMessageText(result)).toContain('"denied":[false,false,false]');
		expect(f.calls).toEqual([]);
	});

	it.each([
		{ allowed: undefined, autoEnableCodemode: true, enabled: true },
		{ allowed: [searchName], autoEnableCodemode: true, enabled: false },
		// `codemode` is a default tool now; auto-activation cannot bring back a disabled tool.
		{ allowed: undefined, autoEnableCodemode: false, excluded: ["codemode"], enabled: false },
		// Explicit tool selection activates codemode independently of MCP's automatic activation setting.
		{ allowed: ["codemode", searchName], autoEnableCodemode: false, enabled: true },
	])("auto-enable obeys both the whitelist and config: $allowed / $autoEnableCodemode", async (options) => {
		const f = await setup({ ...options, active: [] });
		expect(f.harness.session.getActiveToolNames().includes("codemode")).toBe(options.enabled);
		expect(f.harness.session.getActiveToolNames()).not.toContain(searchName);
		expect(f.calls).toEqual([]);
	});

	it("re-reads discovery metadata and cached call authority after revocation inside a script", async () => {
		let revoke: (() => void) | undefined;
		const f = await setup({ allowed: ["codemode", searchName], onCall: () => revoke?.() });
		revoke = () => f.harness.session.setToolAccessByName(["codemode"]);
		const result = await f.script(`
const cached = tools.${searchName};
await cached({ query: "first" });
const matches = await searchTools("documentation guides");
const description = await describeTool("${searchName}");
const namespace = await describeNamespace("docs");
let rejected = false;
try { await cached({ query: "second" }); } catch { rejected = true; }
return { matches, description: description ?? null, namespace: namespace ?? null, rejected };
`);
		expect(result).toMatchObject({ isError: false });
		expect(getMessageText(result)).toContain('"matches":[],"description":null,"namespace":null,"rejected":true');
		expect(f.calls).toEqual([{ name: "search", arguments: { query: "first" } }]);
	});

	it("cannot catch a disconnected effect into success or store, and blocks both direct and nested repetition", async () => {
		const f = await setup({ exposure: "direct", allowed: ["codemode", searchName], dropOnce: true });
		let originalTaskId: string | undefined;
		const previousDispatch = f.harness.session.agent.beforeToolDispatch;
		f.harness.session.agent.beforeToolDispatch = async (context) => {
			originalTaskId ??= f.harness.session.taskRecovery?.id;
			await previousDispatch?.(context);
		};
		const firstCall = {
			...fauxToolCall("codemode", {
				code: `try { await tools.${searchName}({query:"effect"}); } catch {} store("unsafe", true); return "caught";`,
			}),
			id: "first-script",
		};
		f.harness.setResponses([
			fauxAssistantMessage(firstCall, { stopReason: "toolUse" }),
			// The native recovery inspection successor must not repeat the unknown RPC.
			fauxAssistantMessage(
				{ ...fauxToolCall(searchName, { query: "effect" }), id: "direct-repeat" },
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("External evidence is required."),
		]);
		await f.harness.session.prompt("Call the effect once");
		expect(originalTaskId).toBeDefined();
		const paused = originalTask(f.harness, originalTaskId!);
		expect(paused?.status).toBe("needs_reconciliation");
		expect(paused?.tools.find((tool) => tool.call.name === searchName)).toMatchObject({
			safe: false,
			dispatched: true,
		});
		expect(paused?.tools.find((tool) => tool.call.name === searchName)?.result).toBeUndefined();
		expect(paused?.tools.find((tool) => tool.call.name === "codemode")).toMatchObject({
			safe: false,
			dispatched: true,
		});
		expect(paused?.tools.find((tool) => tool.call.name === "codemode")?.result).toBeUndefined();
		expect(
			f.harness.session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE),
		).toBe(false);
		expect(f.calls).toHaveLength(1);
		await f.script(`try { await tools.${searchName}({query:"effect"}); } catch (error) { return error.message; }`);
		expect(f.calls).toHaveLength(1);
		expect(
			originalTask(f.harness, originalTaskId!)?.tools.find((tool) => tool.call.name === searchName)?.result,
		).toBeUndefined();
	});
});
