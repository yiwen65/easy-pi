import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { prepareCollaborationFork } from "../src/context-fork.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const call = fauxToolCall("read", { path: "file" }, { id: "call-one" });
const result: AgentMessage = {
	role: "toolResult",
	toolCallId: call.id,
	toolName: "read",
	content: [{ type: "text", text: "file text" }],
	isError: false,
	timestamp: 2,
};

test("all preserves complete pairs but omits the current unfinished spawn batch and orphan results", () => {
	const source: AgentMessage[] = [
		user("parent task"),
		fauxAssistantMessage(call, { stopReason: "toolUse" }),
		result,
		fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "child" }), { stopReason: "toolUse" }),
	];
	const fork = prepareCollaborationFork(source);
	expect(fork).toEqual(source.slice(0, 3));
	fork.length = 0;
	expect(source).toHaveLength(4);
	expect(prepareCollaborationFork([result])).toEqual([]);
});

test("N counts complete user turns, not messages or an in-flight final turn", () => {
	const source = [
		user("first"),
		fauxAssistantMessage("answer one"),
		user("second"),
		fauxAssistantMessage(call, { stopReason: "toolUse" }),
		result,
		fauxAssistantMessage("answer two"),
		user("current"),
		fauxAssistantMessage(call, { stopReason: "toolUse" }),
	];
	expect(prepareCollaborationFork(source, { mode: "last-turns", turns: 1 })).toEqual(source.slice(2, 6));
	expect(() => prepareCollaborationFork(source, { mode: "last-turns", turns: 3 })).toThrow(/unavailable/);
	expect(prepareCollaborationFork(source, { mode: "none" })).toEqual([]);
});

test("fork rejects oversized context and ambiguous IDs rather than truncating history", () => {
	expect(() => prepareCollaborationFork([user("x".repeat(256 * 1024))])).toThrow(/256 KiB/);
	expect(() =>
		prepareCollaborationFork([fauxAssistantMessage([call, call], { stopReason: "toolUse" }), result]),
	).toThrow(/Ambiguous/);
});

test("partial parallel batches cannot leave dangling calls in inherited context", () => {
	const second = fauxToolCall("read", { path: "other" }, { id: "call-two" });
	expect(
		prepareCollaborationFork([
			user("parallel"),
			fauxAssistantMessage([call, second], { stopReason: "toolUse" }),
			result,
		]),
	).toEqual([user("parallel")]);
});
