import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLiveActivity,
	LIVE_ACTIVITY_LIMITS,
	LiveActivityUpdateScheduler,
	reduceLiveActivity,
} from "../src/live-activity.ts";

function apply(events: Array<Record<string, unknown>>) {
	return events.reduce(reduceLiveActivity, createLiveActivity());
}

afterEach(() => vi.useRealTimers());

describe("subagent live activity", () => {
	it("tracks thinking, answer, and interleaved tool lifecycle state", () => {
		const activity = apply([
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "plan ",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 1,
					delta: "draft",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					toolCall: {
						type: "toolCall",
						id: "a",
						name: "read",
						arguments: { path: "a.ts" },
					},
				},
			},
			{
				type: "tool_execution_start",
				toolCallId: "a",
				toolName: "read",
				args: { path: "a.ts" },
			},
			{
				type: "tool_execution_start",
				toolCallId: "b",
				toolName: "bash",
				args: { command: "false" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "a",
				toolName: "read",
				args: { path: "a.ts" },
				partialResult: { content: [{ type: "text", text: "preview" }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "b",
				toolName: "bash",
				result: { content: [{ type: "text", text: "failed" }] },
				isError: true,
			},
			{
				type: "tool_execution_end",
				toolCallId: "a",
				toolName: "read",
				result: { content: [{ type: "text", text: "done" }] },
				isError: false,
			},
		]);

		expect(activity).toEqual({
			thinking: "plan ",
			text: "draft",
			tools: [
				{
					toolCallId: "a",
					toolName: "read",
					args: '{"path":"a.ts"}',
					output: "done",
					status: "success",
				},
				{
					toolCallId: "b",
					toolName: "bash",
					args: '{"command":"false"}',
					output: "failed",
					status: "error",
				},
			],
		});
	});

	it("uses final assistant content as authoritative and ignores malformed events", () => {
		const initial = apply([
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "stale",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: 7 },
			},
		]);
		const final = reduceLiveActivity(initial, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "final thought" },
					{ type: "text", text: "final answer" },
				],
			},
		});

		expect(final).toMatchObject({
			thinking: "final thought",
			text: "final answer",
		});
	});

	it("bounds all text fields and the recent tool list", () => {
		const events: Array<Record<string, unknown>> = [
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "t".repeat(LIVE_ACTIVITY_LIMITS.thinkingChars + 10),
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "x".repeat(LIVE_ACTIVITY_LIMITS.textChars + 10),
				},
			},
		];
		for (let index = 0; index < LIVE_ACTIVITY_LIMITS.recentTools + 2; index++) {
			events.push({
				type: "tool_execution_end",
				toolCallId: `call-${index}`,
				toolName: "tool",
				result: {
					content: [
						{
							type: "text",
							text: "o".repeat(LIVE_ACTIVITY_LIMITS.toolOutputChars + 10),
						},
					],
				},
				isError: false,
			});
		}
		const activity = apply(events);

		expect(activity.thinking).toHaveLength(LIVE_ACTIVITY_LIMITS.thinkingChars);
		expect(activity.text).toHaveLength(LIVE_ACTIVITY_LIMITS.textChars);
		expect(activity.tools).toHaveLength(LIVE_ACTIVITY_LIMITS.recentTools);
		expect(activity.tools.at(-1)?.output).toHaveLength(LIVE_ACTIVITY_LIMITS.toolOutputChars);
	});

	it("coalesces token updates and flushes lifecycle boundaries", () => {
		vi.useFakeTimers();
		const callback = vi.fn();
		const scheduler = new LiveActivityUpdateScheduler(callback, 100);
		scheduler.schedule();
		scheduler.schedule();
		vi.advanceTimersByTime(99);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledOnce();
		scheduler.schedule();
		scheduler.flush();
		expect(callback).toHaveBeenCalledTimes(2);
		scheduler.schedule();
		scheduler.dispose(true);
		expect(callback).toHaveBeenCalledTimes(3);
		vi.advanceTimersByTime(100);
		expect(callback).toHaveBeenCalledTimes(3);
	});
});
