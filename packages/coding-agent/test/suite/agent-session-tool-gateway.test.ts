import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function echoTool(runs: unknown[]): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, params) => {
			runs.push(params);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

describe("AgentSession tool gateway wiring (T-012)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("re-validates hook-mutated arguments: non-conforming mutations never execute", async () => {
		const runs: unknown[] = [];
		const harness = await createHarness({
			tools: [echoTool(runs)],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						// Remove a required field: not coercible, must fail validation.
						delete (event.input as Record<string, unknown>).text;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");
		expect(runs).toHaveLength(0);
		const toolResult = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResult?.isError).toBe(true);
	});

	it("valid hook mutations still reach execution", async () => {
		const runs: unknown[] = [];
		const harness = await createHarness({
			tools: [echoTool(runs)],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						(event.input as Record<string, unknown>).text = "mutated";
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");
		expect(runs).toEqual([{ text: "mutated" }]);
	});
});
