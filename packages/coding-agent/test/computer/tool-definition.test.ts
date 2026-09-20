import {
	type AgentTool,
	type AgentToolResult,
	createStepSnapshot,
	createToolPlan,
} from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { defineTool, type ExtensionContext, type ToolDefinition } from "../../src/core/extensions/types.ts";
import { wrapRegisteredTool } from "../../src/core/extensions/wrapper.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";

const parameters = Type.Object({ target: Type.String() });
type Definition = ToolDefinition<typeof parameters, { status: string }>;
const result: AgentToolResult<{ status: string }> = {
	content: [{ type: "text", text: "Done" }],
	details: { status: "ok" },
	addedToolNames: ["existing", "inspect"],
};
const context = { cwd: "/computer-wrapper-test" } as ExtensionContext;

function createDefinition(): Definition {
	return {
		name: "computer",
		label: "Computer",
		description: "Fake computer tool for wrapper tests",
		parameters,
		constrainedSampling: false,
		prepareArguments: () => ({ target: "desktop" }),
		executionMode: "sequential",
		contract: {
			sideEffects: "external",
			readOnly: false,
			idempotent: false,
			reversible: false,
			timeoutMs: 1000,
			retry: { maxRetries: 0 },
			approval: "required",
		},
		executionResource: { key: "computer:desktop", mode: "exclusive" },
		execute: vi.fn<Definition["execute"]>().mockResolvedValue(result),
	};
}

describe("computer tool definition execution metadata", () => {
	it("preserves metadata and execution through ToolDefinition -> AgentTool -> ToolDefinition", async () => {
		const original = createDefinition();
		const ctxFactory = vi.fn(() => context);
		const tool = wrapToolDefinition(original, ctxFactory);
		const roundTrip = createToolDefinitionFromAgentTool(tool);

		for (const converted of [tool, roundTrip]) {
			expect(converted.name).toBe(original.name);
			expect(converted.label).toBe(original.label);
			expect(converted.description).toBe(original.description);
			expect(converted.parameters).toBe(original.parameters);
			expect(converted.constrainedSampling).toBe(false);
			expect(converted.prepareArguments).toBe(original.prepareArguments);
			expect(converted.executionMode).toBe("sequential");
			expect(converted.contract).toBe(original.contract);
			expect(converted.executionResource).toBe(original.executionResource);
		}

		const args = { target: "desktop" };
		const signal = new AbortController().signal;
		const onUpdate = vi.fn();
		expect(ctxFactory).not.toHaveBeenCalled();
		await expect(roundTrip.execute("round-trip", args, signal, onUpdate, context)).resolves.toBe(result);
		expect(original.execute).toHaveBeenCalledExactlyOnceWith("round-trip", args, signal, onUpdate, context);
		expect(ctxFactory).toHaveBeenCalledOnce();
	});

	it("preserves metadata and execution through AgentTool -> ToolDefinition -> AgentTool", async () => {
		const original: AgentTool<typeof parameters, { status: string }> = {
			...createDefinition(),
			execute: vi.fn<AgentTool<typeof parameters, { status: string }>["execute"]>().mockResolvedValue(result),
		};
		const definition = createToolDefinitionFromAgentTool(original);
		const roundTrip = wrapToolDefinition(definition);

		for (const converted of [definition, roundTrip]) {
			expect(converted.contract).toBe(original.contract);
			expect(converted.executionResource).toBe(original.executionResource);
			expect(converted.prepareArguments).toBe(original.prepareArguments);
			expect(converted.executionMode).toBe(original.executionMode);
		}

		const args = { target: "desktop" };
		const signal = new AbortController().signal;
		const onUpdate = vi.fn();
		await expect(roundTrip.execute("agent-round-trip", args, signal, onUpdate)).resolves.toBe(result);
		expect(original.execute).toHaveBeenCalledExactlyOnceWith("agent-round-trip", args, signal, onUpdate);
	});

	it("keeps the new fields optional for existing tool definitions", async () => {
		const definition: Definition = {
			name: "legacy",
			label: "Legacy",
			description: "A tool without execution metadata",
			parameters,
			async execute() {
				return result;
			},
		};
		const tool = wrapToolDefinition(definition);
		const roundTrip = createToolDefinitionFromAgentTool(tool);

		expect(tool.contract).toBeUndefined();
		expect(tool.executionResource).toBeUndefined();
		expect(roundTrip.contract).toBeUndefined();
		expect(roundTrip.executionResource).toBeUndefined();
		await expect(roundTrip.execute("legacy", { target: "desktop" }, undefined, undefined, context)).resolves.toBe(
			result,
		);
	});

	it.each([
		{ activeAfter: ["computer", "inspect", "capture"], addedToolNames: ["existing", "inspect", "capture"] },
		{ activeAfter: ["computer"], addedToolNames: ["existing", "inspect"] },
		{ activeAfter: ["capture"], addedToolNames: ["existing", "inspect"] },
	])("preserves registered-tool context and added names when active tools become $activeAfter", async (testCase) => {
		const definition = createDefinition();
		const runner = {
			createContext: vi.fn(() => context),
			getActiveTools: vi
				.fn<ExtensionRunner["getActiveTools"]>()
				.mockReturnValueOnce(["computer"])
				.mockReturnValueOnce(testCase.activeAfter),
		} satisfies Pick<ExtensionRunner, "createContext" | "getActiveTools">;
		const tool = wrapRegisteredTool(
			{
				definition: defineTool(definition),
				sourceInfo: { path: "<computer-test>", source: "test", scope: "temporary", origin: "top-level" },
			},
			// This unit only exercises the two consumed methods; integration.test.ts uses the real runner.
			runner as unknown as ExtensionRunner,
		);

		expect(tool.contract).toBe(definition.contract);
		expect(tool.executionResource).toBe(definition.executionResource);
		expect(tool.executionMode).toBe("sequential");
		expect(runner.createContext).not.toHaveBeenCalled();
		const args = { target: "desktop" };
		const signal = new AbortController().signal;
		const onUpdate = vi.fn();
		const actual = await tool.execute("registered", args, signal, onUpdate);

		expect(definition.execute).toHaveBeenCalledExactlyOnceWith("registered", args, signal, onUpdate, context);
		expect(runner.createContext).toHaveBeenCalledOnce();
		expect(runner.getActiveTools).toHaveBeenCalledTimes(2);
		expect(actual).toEqual({ ...result, addedToolNames: testCase.addedToolNames });
		expect(result.addedToolNames).toEqual(["existing", "inspect"]);
	});

	it("copies and freezes wrapped execution metadata in ToolPlan and StepSnapshot", () => {
		const definition = createDefinition();
		const resource = { key: "computer:desktop", mode: "exclusive" as const };
		definition.executionResource = resource;
		const expectedContract = structuredClone(definition.contract);
		const tool = wrapToolDefinition(definition);
		const plan = createToolPlan([tool], 1, "computer-plan");
		const snapshot = createStepSnapshot(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				runId: "computer-test",
				model: {
					id: "mock",
					name: "Mock",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
				convertToLlm: () => [],
			},
			2,
		);

		definition.contract!.approval = "never";
		definition.contract!.retry!.maxRetries = 4;
		resource.key = "changed-after-snapshot";

		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(snapshot.stepId).toBe("computer-test-step-2");
		expect(snapshot.context.toolPlan).toBe(snapshot.toolPlan);
		expect(snapshot.context.tools?.[0]).toBe(snapshot.toolPlan.bindings.computer);
		for (const frozenPlan of [plan, snapshot.toolPlan]) {
			const planned = frozenPlan.bindings.computer;
			expect(Object.isFrozen(frozenPlan)).toBe(true);
			expect(Object.isFrozen(frozenPlan.tools)).toBe(true);
			expect(Object.isFrozen(frozenPlan.bindings)).toBe(true);
			expect(Object.isFrozen(planned)).toBe(true);
			expect(planned.contract).toEqual(expectedContract);
			expect(planned.contract).not.toBe(definition.contract);
			expect(Object.isFrozen(planned.contract)).toBe(true);
			expect(Object.isFrozen(planned.contract?.retry)).toBe(true);
			expect(planned.executionResource).toEqual({ key: "computer:desktop", mode: "exclusive" });
			expect(planned.executionResource).not.toBe(resource);
			expect(Object.isFrozen(planned.executionResource)).toBe(true);
			expect(planned.execute).toBe(tool.execute);
		}
	});
});
