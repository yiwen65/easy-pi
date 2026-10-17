import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type CallToolResult, type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodemodeExtension } from "../../../src/extensions/codemode/index.ts";
import { CODEMODE_STORE_ENTRY_TYPE } from "../../../src/extensions/codemode/tool.ts";
import { createMcpExtension } from "../../../src/extensions/mcp/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const clickName = "mcp__desktop__desktop_click";

describe("desktop CLI uncertainty through MCP and codemode", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function setup(mode: "unknown" | "native-error") {
		const agentDir = mkdtempSync(join(tmpdir(), "epi-desktop-certainty-"));
		directories.push(agentDir);
		const calls: unknown[] = [];
		const pair = createInMemoryTransportPair();
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			const request = message as JsonRpcRequest;
			let result: unknown = {};
			if (request.method === "initialize") {
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "desktop-fixture", version: "1" },
				};
			} else if (request.method === "tools/list") {
				result = {
					tools: [
						{
							name: "desktop_click",
							inputSchema: { type: "object", properties: { ref_id: { type: "string" } } },
						},
					],
				};
			} else if (request.method === "tools/call") {
				calls.push(request.params);
				// Match the envelopes independently covered by tools/agent-desktop-mcp/server.test.mjs.
				const response: CallToolResult =
					mode === "unknown"
						? {
								isError: true,
								_meta: { "io.easy-pi/execution-outcome": "unknown" },
								content: [
									{
										type: "text",
										text: "agent-desktop execution failed: timed out. Desktop effects may be unknown; observe before retrying.",
									},
								],
							}
						: {
								isError: true,
								content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "STALE_REF" } }) }],
								structuredContent: { ok: false, error: { code: "STALE_REF" } },
							};
				result = response;
			}
			void pair.server.send({ jsonrpc: "2.0", id: request.id, result });
		});
		await pair.server.start();
		const harness = await createHarness({
			hfCompaction: { mode: "off" },
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			initialActiveToolNames: ["codemode"],
			allowedToolNames: ["codemode", clickName],
			extensionFactories: [
				createCodemodeExtension(),
				createMcpExtension({
					agentDir,
					loadConfig: () => ({
						servers: [
							{
								name: "desktop",
								config: { command: "unused", exposure: "direct" },
								source: "test",
							},
						],
						errors: [],
					}),
					createTransport: () => pair.client,
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "rpc" });
		await vi.waitFor(() => expect(harness.session.getAllTools().some((tool) => tool.name === clickName)).toBe(true));
		return { harness, calls };
	}

	it("cannot catch an interrupted desktop effect into store success or repeat it", async () => {
		const { harness, calls } = await setup("unknown");
		let taskId: string | undefined;
		const previousDispatch = harness.session.agent.beforeToolDispatch;
		harness.session.agent.beforeToolDispatch = async (context) => {
			taskId ??= harness.session.taskRecovery?.id;
			await previousDispatch?.(context);
		};
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `try { await tools.${clickName}({ref_id:"@sabc:e1"}); } catch {} store("unsafe", true); return "caught";`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall(clickName, { ref_id: "@sabc:e1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Inspect the desktop before retrying."),
		]);
		await harness.session.prompt("Exercise the stubbed desktop failure");
		const current = harness.session.taskRecovery;
		const paused =
			current?.id === taskId ? current : current?.suspendedTasks?.find((task) => task.state.id === taskId)?.state;
		expect(paused?.status).toBe("needs_reconciliation");
		for (const name of [clickName, "codemode"]) {
			expect(paused?.tools.find((tool) => tool.call.name === name)).toMatchObject({ safe: false, dispatched: true });
			expect(paused?.tools.find((tool) => tool.call.name === name)?.result).toBeUndefined();
		}
		expect(
			harness.session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE),
		).toBe(false);
		expect(calls).toHaveLength(1);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `try { await tools.${clickName}({ref_id:"@sabc:e1"}); } catch (error) { return error.message; }`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("External evidence is required."),
		]);
		await harness.session.prompt("Try the same stubbed operation from another script");
		expect(calls).toHaveLength(1);
	});

	it("preserves genuine CLI errors as confirmed structured MCP results", async () => {
		const { harness, calls } = await setup("native-error");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `const result = await tools.${clickName}({ref_id:"@sabc:e1"}); if (result.isError !== true || result.structuredContent.error.code !== "STALE_REF") throw new Error("lost native error"); store("known", true); return result.structuredContent;`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Inspect the stubbed native error");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "codemode",
		);
		expect(result).toMatchObject({ isError: false });
		expect(getMessageText(result)).toContain("STALE_REF");
		expect(harness.session.taskRecovery?.status).toBe("completed");
		expect(harness.session.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: CODEMODE_STORE_ENTRY_TYPE,
				data: { set: { known: true }, delete: [] },
			}),
		);
		expect(calls).toHaveLength(1);
	});
});
