import { AgentToolError } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { CODEMODE_STORE_ENTRY_TYPE, type CodemodeToolDetails } from "../../src/extensions/codemode/tool.ts";
import { createHarness, type Harness } from "./harness.ts";

function result(harness: Harness): ToolResultMessage {
	const message = harness.session.messages
		.slice()
		.reverse()
		.find((message) => message.role === "toolResult" && message.toolName === "codemode");
	if (!message || message.role !== "toolResult") throw new Error("Missing codemode result");
	return message;
}

function text(message: ToolResultMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

async function run(harness: Harness, code: string): Promise<ToolResultMessage> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Run the local script");
	return result(harness);
}

describe("codemode extension in AgentSession", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
	});

	async function setup(register?: (pi: ExtensionAPI) => void, allowedToolNames?: string[]) {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			allowedToolNames,
			extensionFactories: [createCodemodeExtension(), ...(register ? [register] : [])],
		});
		harnesses.push(harness);
		return harness;
	}

	it("executes typed nested tool results through the session and emits no orphan transcript results", async () => {
		const harness = await setup((pi) => {
			pi.registerTool({
				name: "stats",
				label: "Stats",
				description: "Return file stats",
				exposure: "codemode",
				parameters: Type.Object({}),
				outputSchema: Type.Object({ files: Type.Number() }),
				contract: { sideEffects: "none", readOnly: true },
				execute: async () => ({
					content: [{ type: "text", text: "two files" }],
					details: {},
					structuredContent: { files: 2 },
				}),
			});
		});
		const message = await run(harness, 'text((await tools.stats({})).files); return "done";');
		expect(message.isError).toBe(false);
		expect(text(message)).toContain("==> text 1/2 <==\n2\n==> text 2/2 <==\ndone");
		expect((message.details as CodemodeToolDetails).calls).toMatchObject([
			{ name: "stats", status: "ok", executionOutcome: "confirmed" },
		]);
		expect(harness.session.messages.filter((item) => item.role === "toolResult")).toHaveLength(1);
		expect(
			harness
				.eventsOfType("tool_execution_start")
				.some((event) => event.toolName === "stats" && event.parentToolCallId === message.toolCallId),
		).toBe(true);
	});

	it("applies nested validation and hook blocks while permitting a script to handle known failures", async () => {
		let executions = 0;
		const harness = await setup((pi) => {
			pi.registerTool({
				name: "echo",
				label: "Echo",
				description: "Echo input",
				exposure: "codemode",
				parameters: Type.Object({ value: Type.String() }),
				contract: { sideEffects: "none", readOnly: true },
				execute: async (_id, { value }) => {
					executions++;
					return { content: [{ type: "text", text: value }], details: {} };
				},
			});
			pi.on("tool_call", (event) =>
				event.toolName === "echo" && event.input.value === "blocked"
					? { block: true, reason: "blocked by hook" }
					: undefined,
			);
		});
		const message = await run(
			harness,
			'const errors = []; for (const args of [{}, {value: "blocked"}]) { try { await tools.echo(args); } catch (e) { errors.push(e.message); } } return errors;',
		);
		expect(message.isError).toBe(false);
		expect(text(message)).toContain("blocked by hook");
		expect(executions).toBe(0);
		expect((message.details as CodemodeToolDetails).calls.map((call) => call.executionOutcome)).toEqual([
			"not_started",
			"not_started",
		]);
	});

	it("does not make undelegated tools visible through catalog or script calls", async () => {
		let executions = 0;
		const harness = await setup(
			(pi) => {
				pi.registerTool({
					name: "secret",
					label: "Secret",
					description: "private description",
					exposure: "codemode",
					parameters: Type.Object({}),
					execute: async () => {
						executions++;
						return { content: [], details: {} };
					},
				});
			},
			["codemode"],
		);
		const message = await run(
			harness,
			'return { names: ALL_TOOLS.map(t => t.name), description: await describeTool("secret"), matches: await searchTools("private"), callable: "secret" in tools };',
		);
		expect(message.isError, text(message)).toBe(false);
		expect(text(message)).toContain('"names":[]');
		expect(text(message)).toContain('"matches":[]');
		expect(text(message)).toContain('"callable":false');
		expect(text(message)).not.toContain("private description");
		expect(executions).toBe(0);
	});

	it("persists store only for successful scripts and restores the active branch", async () => {
		const harness = await setup();
		const anchor = harness.sessionManager.appendCustomEntry("anchor");
		const increment = 'const n = (load("n") ?? 0) + 1; store("n", n); return n;';
		expect(text(await run(harness, increment))).toContain("\n1");
		expect(text(await run(harness, increment))).toContain("\n2");
		harness.sessionManager.branch(anchor);
		expect(text(await run(harness, increment))).toContain("\n1");
		const failed = await run(harness, 'text("partial"); store("n", 5); throw new Error("boom");');
		expect(failed.isError).toBe(true);
		expect(text(failed)).toContain("partial");
		expect(text(failed)).toContain("boom");
		const entries = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE);
		expect(entries).toHaveLength(1);
	});

	it("only mode keeps direct capabilities active without provider declarations or prompt snippets", async () => {
		const harness = await setup((pi) => {
			pi.registerTool({
				name: "echo",
				label: "Echo",
				description: "Echo input",
				promptSnippet: "Echo input",
				promptGuidelines: ["Use echo for input"],
				parameters: Type.Object({}),
				contract: { sideEffects: "none" },
				execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
			});
		});
		harness.settingsManager.applyOverrides({ codemode: { mode: "only" } });
		harness.session.setActiveToolsByName(["echo", "codemode"]);
		expect(harness.session.getActiveToolNames()).toEqual(["echo", "codemode"]);
		expect(harness.session.agent.state.tools.map((tool) => tool.name)).toEqual(["codemode"]);
		expect(harness.session.agent.state.tools[0].description).toContain("### `echo`");
		expect(harness.session.agent.state.tools[0].description).toContain("Use echo for input");
		expect(harness.session.systemPrompt).not.toContain("- echo: Echo input");
		expect(text(await run(harness, "return await tools.echo({});"))).toContain("echoed");
	});

	it("cannot hide an unknown nested side effect or commit script store after catching it", async () => {
		let effects = 0;
		let originalTaskId: string | undefined;
		let harness: Harness;
		harness = await setup((pi) => {
			pi.registerTool({
				name: "effect",
				label: "Effect",
				description: "Remote side effect",
				exposure: "codemode",
				parameters: Type.Object({}),
				contract: { sideEffects: "external" },
				execute: async () => {
					effects++;
					originalTaskId = harness.session.taskRecovery?.id;
					throw new AgentToolError("connection lost after dispatch", {});
				},
			});
		});
		await run(harness, 'try { await tools.effect({}); } catch {} store("unsafe", 1); return "caught";');
		expect(effects).toBe(1);
		const tasks = [harness.session.taskRecovery, ...harness.session.suspendedTaskRecovery.map((item) => item.state)];
		const original = tasks.find((state) => state?.id === originalTaskId);
		expect(
			original?.tools.some(
				(entry) => entry.call.name === "effect" && entry.dispatched && !entry.safe && !entry.result,
			),
		).toBe(true);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE),
		).toBe(false);
	});
});
