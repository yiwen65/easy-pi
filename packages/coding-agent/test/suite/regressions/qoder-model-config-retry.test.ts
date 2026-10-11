import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const errorMessage = `400: ${JSON.stringify({
	message: `[400]: ${JSON.stringify({
		error: {
			message:
				'qoder: model_config for "dfmodel" not yet known (run a model list fetch or check upstream connectivity)',
		},
	})}`,
	type: "invalid_request_error",
	code: "bad_request",
})}`;

describe("Qoder model config error after tool execution", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
	});

	it("continues after a transient config error without replaying a completed tool", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "receipt" }], details: {} }));
		const tool: AgentTool = {
			name: "effect",
			label: "effect",
			description: "effect",
			parameters: Type.Object({}),
			execute,
		};
		const harness = await createHarness({
			tools: [tool],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("effect", {}, { id: "effect-once" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			(context) => {
				expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
				expect(
					context.messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
				).toBe(false);
				return fauxAssistantMessage("recovered");
			},
		]);

		await harness.session.prompt("run effect and continue");

		expect(execute).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([{ type: "auto_retry_end", success: true, attempt: 1 }]);
		expect(harness.session.taskRecovery?.status).toBe("completed");
		expect(harness.session.isIdle).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.errorMessage === errorMessage,
				),
		).toBe(true);
	});

	it.each([0, 2])("stops at the configured retry budget %i", async (maxRetries) => {
		const harness = await createHarness({
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: true, maxRetries, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: maxRetries + 2 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage })),
		);
		await harness.session.prompt("test");
		expect(harness.faux.state.callCount).toBe(maxRetries + 1);
		expect(harness.session.taskRecovery?.status).toBe("interrupted");
		expect(harness.session.isIdle).toBe(true);
	});
});
