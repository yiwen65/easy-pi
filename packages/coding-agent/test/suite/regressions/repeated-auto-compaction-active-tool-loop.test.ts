import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const OLD_CONTEXT_MARKER = "old-context-that-must-stay-compacted";

function createNoopTool(): AgentTool {
	return {
		name: "noop",
		label: "No-op",
		description: "Return immediately",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
	};
}

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("auto-compaction during an active tool loop", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps later provider requests on the activated projection", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
			tools: [createNoopTool()],
			initialActiveToolNames: ["noop"],
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => ({ text: "Preserve the current task.", stopReason: "stop" }),
			},
		});
		harnesses.push(harness);

		const model = harness.getModel();
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: `${OLD_CONTEXT_MARKER} ${"x".repeat(8_000)}`,
			timestamp: now - 2_000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old answer", { timestamp: now - 1_000 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(900),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const providerContexts: string[] = [];
		const toolResponse = (context: unknown) => {
			const serialized = JSON.stringify(context);
			providerContexts.push(serialized);
			return {
				...fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
				usage: usage(serialized.includes(OLD_CONTEXT_MARKER) ? 1_000 : 100),
			};
		};
		harness.setResponses([
			(context) => toolResponse(context),
			(context) => toolResponse(context),
			(context) => {
				providerContexts.push(JSON.stringify(context));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Continue the task through both tool calls.");

		expect(providerContexts.map((context) => context.includes(OLD_CONTEXT_MARKER))).toEqual([false, false, false]);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.result)).toHaveLength(1);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
});
