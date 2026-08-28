import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { toCompactJsonEvent, toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #7290: JSON event streams stay linear", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function measureUpdateBytes(text: string): Promise<number> {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(text)]);

		await harness.session.prompt("respond");

		const sessionUpdates = harness.eventsOfType("message_update");
		for (const update of sessionUpdates) {
			expect(update).toHaveProperty("message");
			expect(update.assistantMessageEvent).toHaveProperty("partial");
		}

		const updates = sessionUpdates.map((event) => toJsonEvent(event));
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update).not.toHaveProperty("message");
			expect(update.assistantMessageEvent).not.toHaveProperty("partial");
		}
		return updates.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
	}

	it("emits delta-only message updates whose size scales linearly", async () => {
		const smallBytes = await measureUpdateBytes("x".repeat(2_000));
		const largeBytes = await measureUpdateBytes("x".repeat(4_000));

		expect(largeBytes).toBeGreaterThan(smallBytes);
		expect(largeBytes / smallBytes).toBeLessThan(2.2);
	});

	it("projects large tool payloads to bounded compact lifecycle events", () => {
		const sentinel = `large-result-${"x".repeat(300_000)}`;
		const toolEnd: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { content: [{ type: "text", text: sentinel }], details: { duplicate: sentinel } },
			isError: false,
		};

		expect(JSON.stringify(toJsonEvent(toolEnd))).toContain(sentinel);
		const compact = toCompactJsonEvent(toolEnd);
		expect(compact).toEqual({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			isError: false,
		});
		expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(256);
		expect(JSON.stringify(compact)).not.toContain("large-result");
	});

	it("omits aggregate snapshots and hashes large tool arguments", () => {
		const largeArgs = { path: "owned/file.ts", content: "write-payload".repeat(30_000) };
		const toolStart: AgentSessionEvent = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "write",
			args: largeArgs,
		};
		const compactStart = toCompactJsonEvent(toolStart);
		expect(compactStart).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "write",
		});
		expect(compactStart).toHaveProperty("argsHash", expect.stringMatching(/^[a-f0-9]{64}$/));
		expect(toCompactJsonEvent({ ...toolStart, toolCallId: "call-2" })).toHaveProperty(
			"argsHash",
			(compactStart as { argsHash: string }).argsHash,
		);
		expect(Buffer.byteLength(JSON.stringify(compactStart))).toBeLessThan(256);

		const assistant = fauxAssistantMessage("done");
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text" as const, text: "x".repeat(300_000) }],
			details: { duplicate: "x".repeat(300_000) },
			isError: false,
			timestamp: Date.now(),
		};
		expect(toCompactJsonEvent({ type: "turn_end", message: assistant, toolResults: [toolResult] })).toBeUndefined();
		expect(
			toCompactJsonEvent({ type: "agent_end", messages: [assistant, toolResult], willRetry: false }),
		).toBeUndefined();
	});

	it("keeps only runner-required assistant message fields", () => {
		const assistant = fauxAssistantMessage("final handoff");
		assistant.content.push({
			type: "toolCall",
			id: "call-1",
			name: "write",
			arguments: { content: "x".repeat(300_000) },
		});
		const compact = toCompactJsonEvent({ type: "message_end", message: assistant });
		expect(compact).toMatchObject({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "final handoff" }],
				model: assistant.model,
				usage: assistant.usage,
				stopReason: assistant.stopReason,
			},
		});
		expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(1_024);
	});
});
