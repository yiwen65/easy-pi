import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createStepSnapshot } from "../src/step-snapshot.ts";
import { createToolPlan } from "../src/tool-plan.ts";
import type { AgentLoopConfig, AgentTool } from "../src/types.ts";

const parameters = Type.Object({ value: Type.String() });

function tool(name: string, execute: AgentTool["execute"]): AgentTool {
	return { name, label: name, description: name, parameters, execute };
}

const config = {
	model: {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	},
	convertToLlm: (messages: never[]) => messages,
} as unknown as AgentLoopConfig;

describe("ToolPlan and StepSnapshot", () => {
	it("copies schemas and preserves the selected handler binding", () => {
		const execute = async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} });
		const original = tool("echo", execute);
		const plan = createToolPlan([original], 1, "step-1");

		(original.parameters as { properties?: Record<string, unknown> }).properties!.value = { type: "number" };
		(original.execute as unknown as { replaced?: boolean }).replaced = true;

		expect(plan.identity).toBe("step-1");
		expect(plan.bindings.echo.execute).toBe(execute);
		expect((plan.bindings.echo.parameters as { properties?: Record<string, unknown> }).properties?.value).toEqual({
			type: "string",
		});
	});

	it("uses the final override and binds it to the step context", () => {
		const first = tool("echo", async () => ({ content: [{ type: "text" as const, text: "first" }], details: {} }));
		const second = tool("echo", async () => ({ content: [{ type: "text" as const, text: "second" }], details: {} }));
		const plan = createToolPlan([first, second], 2);
		const snapshot = createStepSnapshot({ systemPrompt: "", messages: [], tools: [first, second] }, config, 2);

		expect(plan.bindings.echo.execute).toBe(second.execute);
		expect(snapshot.toolPlan.bindings.echo.execute).toBe(second.execute);
		expect(snapshot.context.toolPlan).toBe(snapshot.toolPlan);
	});
});
