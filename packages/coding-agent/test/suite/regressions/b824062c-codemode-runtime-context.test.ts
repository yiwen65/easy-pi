import { AgentToolError } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../../src/extensions/codemode/index.ts";
import { CODEMODE_STORE_ENTRY_TYPE, createCodemodeToolDefinition } from "../../../src/extensions/codemode/tool.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
});

const code = `const results = await Promise.allSettled([
	tools.echo({ value: "first" }),
	tools.echo({ value: "second" })
]);
for (let i = 0; i < results.length; i++) text({ i, ...results[i] });
store("finished", true);`;

async function run(harness: Harness) {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Run the offline batch");
}

describe("b824062c codemode runtime context", () => {
	it.each(["legacy", "executeTool", "waitForNestedTools"] as const)(
		"rejects a %s host context before executing the script, without suspending the task",
		async (missing) => {
			const appendEntry = vi.fn();
			let failure: unknown;
			const harness = await createHarness({
				tools: [],
				initialActiveToolNames: ["codemode"],
				hfCompaction: { mode: "off" },
				settings: { retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						const definition = createCodemodeToolDefinition({ appendEntry });
						pi.registerTool({
							...definition,
							execute: async (id, input, signal, onUpdate, ctx) => {
								// The pre-codemode wrapper passed createContext(), not createToolContext().
								const descriptors = Object.getOwnPropertyDescriptors(ctx);
								for (const key of missing === "legacy"
									? ["tools", "executeTool", "waitForNestedTools"]
									: [missing]) {
									delete descriptors[key];
								}
								const incompatible = Object.defineProperties({}, descriptors) as ExtensionToolContext;
								try {
									return await definition.execute(id, input, signal, onUpdate, incompatible);
								} catch (error) {
									failure = error;
									throw error;
								}
							},
						});
					},
				],
			});
			harnesses.push(harness);
			await run(harness);
			expect(failure, failure instanceof Error ? failure.stack : undefined).toBeInstanceOf(AgentToolError);
			expect(failure).toMatchObject({ executionOutcome: "not_started", details: { calls: [] } });
			expect((failure as Error).message).toContain("Restart Easy Pi");
			expect(appendEntry).not.toHaveBeenCalled();
			expect(harness.eventsOfType("tool_execution_start").every((event) => !event.parentToolCallId)).toBe(true);
			expect(harness.session.suspendedTaskRecovery).toEqual([]);
			const result = harness.session.messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({
				toolName: "codemode",
				isError: true,
				details: { calls: [] },
			});
			expect(harness.session.taskRecovery?.status).toBe("completed");
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it("a fresh runtime executes the same batch through the normal nested pipeline", async () => {
		const executed: string[] = [];
		const harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["codemode"],
			allowedToolNames: ["codemode", "echo"],
			hfCompaction: { mode: "off" },
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					pi.registerTool({
						name: "echo",
						label: "Echo",
						description: "Offline echo",
						exposure: "codemode",
						parameters: Type.Object({ value: Type.String() }),
						contract: { sideEffects: "none", readOnly: true },
						execute: async (_id, { value }) => {
							executed.push(value);
							return { content: [{ type: "text", text: value }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await run(harness);
		expect(executed).toEqual(["first", "second"]);
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ toolName: "codemode", isError: false });
		expect(getMessageText(result)).toContain('"status":"fulfilled","value":"first"');
		expect(getMessageText(result)).toContain('"status":"fulfilled","value":"second"');
		expect(harness.eventsOfType("tool_execution_start").filter((event) => event.parentToolCallId)).toHaveLength(2);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(harness.session.suspendedTaskRecovery).toEqual([]);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE),
		).toMatchObject([{ data: { set: { finished: true }, delete: [] } }]);
	});
});
