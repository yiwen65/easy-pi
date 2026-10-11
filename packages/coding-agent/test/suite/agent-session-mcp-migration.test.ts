import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION, type Tool } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import type { McpExposure } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const tools: Tool[] = [
	{
		name: "search",
		description: "Search documentation guides",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{ name: "fail", description: "A known failure", inputSchema: { type: "object", properties: {} } },
];

function server(calls: string[], options: { dropCall?: boolean; listTools?: () => Tool[]; resources?: boolean } = {}) {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		let result: unknown = {};
		switch (request.method) {
			case "initialize":
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, ...(options.resources ? { resources: {} } : {}) },
					serverInfo: { name: "docs", version: "1" },
				};
				break;
			case "tools/list":
				result = { tools: options.listTools?.() ?? tools };
				break;
			case "resources/list":
				result = { resources: [{ uri: "docs://intro", name: "intro" }] };
				break;
			case "resources/templates/list":
				result = { resourceTemplates: [] };
				break;
			case "resources/read":
				result = { contents: [{ uri: "docs://intro", text: "Resource introduction" }] };
				break;
			case "tools/call": {
				const params = request.params as { name: string; arguments: Record<string, unknown> };
				calls.push(params.name);
				if (options.dropCall) {
					void pair.server.close();
					return;
				}
				result =
					params.name === "fail"
						? { content: [{ type: "text", text: "Known remote failure" }], isError: true }
						: { content: [{ type: "text", text: `Guide: ${params.arguments.query}` }] };
				break;
			}
		}
		void pair.server.send({ jsonrpc: "2.0", id: request.id, result });
	});
	void pair.server.start();
	return pair;
}

describe("MCP migration through easy-pi session", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	async function setup(
		options: {
			exposure?: McpExposure;
			allowed?: string[];
			excluded?: string[];
			dropCall?: boolean;
			resources?: boolean;
			sessionManager?: SessionManager;
			listTools?: () => Tool[];
			extra?: ExtensionFactory[];
			wait?: boolean;
		} = {},
	) {
		const agentDir = mkdtempSync(join(tmpdir(), "epi-mcp-session-"));
		directories.push(agentDir);
		const calls: string[] = [];
		const transports: ReturnType<typeof server>[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			allowedToolNames: options.allowed,
			excludedToolNames: options.excluded,
			sessionManager: options.sessionManager,
			extensionFactories: [
				...(options.extra ?? []),
				createToolSearchExtension(),
				createMcpExtension({
					agentDir,
					loadConfig: () => ({
						servers: [
							{
								name: "docs",
								config: { command: "unused", exposure: options.exposure ?? "direct" },
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
		await harness.session.bindExtensions({ mode: "rpc" });
		if (options.wait !== false)
			await vi.waitFor(() =>
				expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
			);
		return { harness, calls, transports };
	}

	it("runs direct calls through hooks and keeps remote hints out of replay contracts", async () => {
		const intercepted: string[] = [];
		const { harness, calls } = await setup({
			extra: [
				(pi) => {
					pi.on("tool_call", (event) => {
						intercepted.push(event.toolName);
					});
				},
			],
		});
		expect(harness.session.getToolDefinition("mcp__docs__search")?.contract).toEqual({ sideEffects: "external" });
		expect(harness.session.agent.state.tools.find((tool) => tool.name === "mcp__docs__search")?.contract).toEqual({
			sideEffects: "external",
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "MCP" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search");
		expect(calls).toEqual(["search"]);
		expect(intercepted).toContain("mcp__docs__search");
		expect(harness.session.taskRecovery?.status).toBe("completed");
	});

	it.each([{ allowed: [] }, { allowed: ["read"] }, { allowed: ["read", "tool_search"] }])(
		"does not connect servers outside strict grants $allowed",
		async ({ allowed }) => {
			const { harness, transports } = await setup({ allowed, wait: false, exposure: "deferred" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(transports).toHaveLength(0);
			expect(harness.session.getAllTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
		},
	);

	it("loads deferred tools only after search and obeys wildcard exclusions", async () => {
		const { harness, calls } = await setup({
			exposure: "deferred",
			allowed: ["tool_search", "mcp__docs__*"],
			excluded: ["mcp__docs__fail"],
		});
		expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
		expect(harness.session.getDelegatableToolNames()).toContain("mcp__docs__search");
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("mcp__docs__fail");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "documentation guides", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "discovered" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find documentation");
		expect(calls).toEqual(["search"]);
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && message.addedToolNames?.includes("mcp__docs__search"),
			),
		).toBe(true);
	});

	it("keeps an explicit remote error confirmed rather than pausing for reconciliation", async () => {
		const { harness } = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__fail", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("failure observed"),
		]);
		await harness.session.prompt("fail");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "mcp__docs__fail",
		);
		expect(result).toMatchObject({ isError: true });
		expect(getMessageText(result)).toContain("Known remote failure");
		expect(harness.session.taskRecovery?.status).toBe("completed");
	});

	it("never retries an uncertain sent call after the transport drops", async () => {
		const { harness, calls } = await setup({ dropCall: true });
		const outcomes: string[] = [];
		let originalTaskId: string | undefined;
		let recordedUnknown = false;
		const dispatchAttempts: string[] = [];
		const previousDispatch = harness.session.agent.beforeToolDispatch;
		harness.session.agent.beforeToolDispatch = async (context) => {
			dispatchAttempts.push(context.toolCall.name);
			await previousDispatch?.(context);
		};
		const previousResult = harness.session.agent.onToolResult;
		harness.session.agent.onToolResult = async (message, context) => {
			outcomes.push(context.executionOutcome);
			originalTaskId ??= harness.session.taskRecovery?.id;
			await previousResult?.(message, context);
			if (context.executionOutcome === "unknown")
				recordedUnknown = harness.session.taskRecovery?.status === "needs_reconciliation";
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "effect" })], { stopReason: "toolUse" }),
			// Native recovery may start an independent inspection task. Even that task cannot replay the unresolved effect.
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "effect" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("External evidence is required; the original operation remains unresolved."),
		]);
		await harness.session.prompt("call");
		expect(calls).toEqual(["search"]);
		expect(dispatchAttempts).toEqual(["mcp__docs__search", "mcp__docs__search"]);
		// A rejected before-dispatch attempt does not enter the execution-result hook.
		expect(outcomes).toEqual(["unknown"]);
		expect(recordedUnknown).toBe(true);
		const current = harness.session.taskRecovery;
		const paused =
			current?.id === originalTaskId
				? current
				: current?.suspendedTasks?.find((task) => task.state.id === originalTaskId)?.state;
		expect(paused?.status).toBe("needs_reconciliation");
		expect(paused?.tools[0]).toMatchObject({ safe: false, dispatched: true });
		expect(paused?.tools[0].result).toBeUndefined();
	});

	it("withdraws changed tools from declarations and delegation authority", async () => {
		let offered = [...tools];
		const { harness, transports } = await setup({ listTools: () => offered });
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
		offered = [];
		await transports[0].server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() => expect(harness.session.getDelegatableToolNames()).not.toContain("mcp__docs__search"));
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
	});

	it("lists and reads root resources through the same tool pipeline", async () => {
		const { harness } = await setup({ resources: true });
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("read_mcp_resource"));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read_mcp_resource", { server: "docs", uri: "docs://intro" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("read"),
		]);
		await harness.session.prompt("resource");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "read_mcp_resource",
		);
		expect(getMessageText(result)).toContain("Resource introduction");
	});
});
