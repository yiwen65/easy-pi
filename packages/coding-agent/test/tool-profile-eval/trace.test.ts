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
			truncationCount: 0,
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
				truncated: false,
				recovery: false,
				postEditRead: false,
			},
			{
				sequence: 1,
				toolName: "read",
				status: "success",
				durationMs: 5,
				truncated: false,
				recovery: true,
				postEditRead: false,
			},
		]);
		expect(JSON.stringify(trace)).not.toMatch(/secret|private|classified|call-id|read-id/);
	});

	it("classifies invalid read reasons without retaining values or messages", () => {
		let time = 0;
		const collector = createSanitizedToolTraceCollector(() => time++);
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "read",
				toolName: "read",
				args: { path: "/secret/file", offset: -8472 },
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "read",
				toolName: "read",
				isError: true,
				result: {
					content: [{ type: "text", text: "INVALID_INPUT\n\noffset must be a positive safe integer." }],
				},
			}),
		);

		const serialized = JSON.stringify(collector.snapshot());
		expect(collector.snapshot().calls[0]).toMatchObject({
			errorCode: "INVALID_INPUT",
			errorReason: "offset_not_positive_integer",
		});
		expect(serialized).not.toMatch(/8472|secret|positive safe integer/);
	});

	it("classifies current search/read schema conflicts without retaining messages", () => {
		const cases = [
			["Provide exactly one of path or locatorId.", "path_locator_conflict"],
			["mode conflicts with queryTemplate.", "mode_template_conflict"],
			["targetKind conflicts with the structured search mode.", "target_kind_conflict"],
			["Structured search returns AST-backed locators and requires context=0.", "structured_context_conflict"],
			["ranking is only valid for file or structured search.", "ranking_mode_conflict"],
		] as const;
		for (const [message, expected] of cases) {
			const collector = createSanitizedToolTraceCollector();
			collector.handle(event({ type: "tool_execution_start", toolCallId: expected, toolName: "read", args: {} }));
			collector.handle(
				event({
					type: "tool_execution_end",
					toolCallId: expected,
					toolName: "read",
					isError: true,
					result: { content: [{ type: "text", text: `INVALID_INPUT\n\n${message}` }] },
				}),
			);
			expect(collector.snapshot().calls[0]?.errorReason).toBe(expected);
			expect(JSON.stringify(collector.snapshot())).not.toContain(message);
		}
	});

	it("derives target rank, selection, and run-misuse metrics without retaining paths or commands", () => {
		let time = 0;
		const collector = createSanitizedToolTraceCollector(() => time++, { targetPath: "src/target.ts" });
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "search",
				toolName: "search",
				args: { query: "secret-marker" },
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "search",
				toolName: "search",
				isError: false,
				result: {
					content: [{ type: "text", text: "secret content" }],
					details: {
						approximate: true,
						hits: [{ path: "src/noise.ts" }, { path: "src/target.ts" }],
					},
				},
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "run",
				toolName: "run",
				args: { command: "cat src/target.ts" },
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "run",
				toolName: "run",
				isError: false,
				result: { content: [] },
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "edit",
				toolName: "edit",
				args: { operations: [{ kind: "update", path: "src/target.ts" }] },
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "edit",
				toolName: "edit",
				isError: false,
				result: { content: [] },
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "read",
				toolName: "read",
				args: { path: "src/target.ts" },
			}),
		);
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
		expect(trace).toMatchObject({
			runMisuseCount: 1,
			targetFirstRead: true,
			firstSearchTargetRank: 2,
			approximateSearchCount: 1,
			approximateEditWithoutTargetReadCount: 1,
		});
		expect(JSON.stringify(trace)).not.toMatch(/secret|target\.ts|noise\.ts|cat src/);
	});

	it("classifies current v2 recovery codes and Search coverage truncation", () => {
		let time = 0;
		const collector = createSanitizedToolTraceCollector(() => time++);
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "search-overflow",
				toolName: "search",
				args: { query: "private-query" },
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "search-overflow",
				toolName: "search",
				isError: false,
				result: { content: [], details: { coverage: { truncated: true } } },
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "stale-edit",
				toolName: "edit",
				args: { operations: [{ kind: "update", path: "private-path" }] },
			}),
		);
		collector.handle(
			event({
				type: "tool_execution_end",
				toolCallId: "stale-edit",
				toolName: "edit",
				isError: true,
				result: { content: [{ type: "text", text: "STALE_VIEW\n\nprivate stale message" }] },
			}),
		);

		const trace = collector.snapshot();
		expect(trace).toMatchObject({ truncationCount: 1, toolErrorCount: 1 });
		expect(trace.calls).toMatchObject([
			{ toolName: "search", status: "success", truncated: true },
			{ toolName: "edit", status: "error", errorCode: "STALE_VIEW" },
		]);
		expect(JSON.stringify(trace)).not.toMatch(/private-query|private-path|private stale message/);
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
				result: { content: [], details: { truncation: { truncated: true, outputLines: 10 } } },
			}),
		);

		const trace = collector.snapshot();
		expect(trace.firstEditSuccess).toBe(true);
		expect(trace.postEditReadCount).toBe(1);
		expect(trace.peakContextTokens).toBe(95);
		expect(trace.truncationCount).toBe(1);
		expect(trace.calls[1]).toMatchObject({ postEditRead: true });
		expect(JSON.stringify(trace)).not.toContain("sensitive");
	});
});
