import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { createSanitizedToolTraceCollector } from "./trace.ts";

function event(value: AgentSessionEvent): AgentSessionEvent {
	return value;
}

describe("sanitized tool trace collector", () => {
	it("retains behavior metrics but no argument, path, command, content, or response text", () => {
		let time = 100;
		const collector = createSanitizedToolTraceCollector(() => time);
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "secret-call-id",
				toolName: "edit",
				args: {
					operations: [
						{ kind: "move", path: "/secret/source.ts", to: "/secret/final.ts" },
						{ kind: "update", path: "/secret/final.ts", oldText: "private", newText: "classified" },
					],
				},
			}),
		);
		time = 112;
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "secret-call-id",
				toolName: "edit",
				isError: true,
				result: { content: [{ type: "text", text: "EDIT_CONTEXT_NOT_FOUND\n\n/secret/final.ts private" }] },
			}),
		);
		time = 115;
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "read-id",
				toolName: "read",
				args: { path: "/secret/final.ts" },
			}),
		);
		time = 120;
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "read-id",
				toolName: "read",
				isError: false,
				result: { content: [{ type: "text", text: "classified response" }] },
			}),
		);

		const trace = collector.snapshot();
		expect(trace).toMatchObject({
			toolCallCount: 2,
			toolErrorCount: 1,
			firstEditSuccess: false,
			recoveryCallCount: 1,
			postEditReadCount: 0,
			toolElapsedMs: 17,
		});
		expect(trace.calls).toEqual([
			{
				sequence: 0,
				toolName: "edit",
				status: "error",
				errorCode: "EDIT_CONTEXT_NOT_FOUND",
				operationKinds: ["move", "update"],
				durationMs: 12,
				recovery: false,
				postEditRead: false,
			},
			{
				sequence: 1,
				toolName: "read",
				status: "success",
				durationMs: 5,
				recovery: true,
				postEditRead: false,
			},
		]);
		expect(JSON.stringify(trace)).not.toMatch(/secret|private|classified|call-id|read-id/);
	});

	it("counts successful edit confirmation reads and peak context without retaining message content", () => {
		let time = 0;
		const collector = createSanitizedToolTraceCollector(() => time);
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "edit",
				toolName: "edit",
				args: { operations: [{ kind: "update", path: "sensitive", oldText: "a", newText: "b" }] },
			}),
		);
		time = 4;
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "edit",
				toolName: "edit",
				isError: false,
				result: { content: [{ type: "text", text: "sensitive result" }] },
			}),
		);
		collector.handle(
			event({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "sensitive model output" }],
					api: "openai-responses",
					provider: "test",
					model: "test",
					usage: {
						input: 30,
						output: 5,
						cacheRead: 60,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
			}),
		);
		collector.handle(
			event({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "sensitive" } }),
		);
		time = 7;
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "read",
				toolName: "read",
				isError: false,
				result: { content: [] },
			}),
		);

		const trace = collector.snapshot();
		expect(trace.firstEditSuccess).toBe(true);
		expect(trace.postEditReadCount).toBe(1);
		expect(trace.peakContextTokens).toBe(95);
		expect(trace.calls[1]).toMatchObject({ postEditRead: true });
		expect(JSON.stringify(trace)).not.toContain("sensitive");
	});
});
