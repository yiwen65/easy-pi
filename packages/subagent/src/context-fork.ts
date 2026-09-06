import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { COLLABORATION_LIMITS, CollaborationError, type ForkSelection } from "./collaboration-contract.ts";

/** Input must be the host's effective branch context, never raw JSONL or all stored branches. */
export function prepareCollaborationFork(
	context: readonly AgentMessage[],
	selection: ForkSelection = { mode: "all" },
): AgentMessage[] {
	if (selection.mode === "none") return [];
	let selected = context;
	if (selection.mode === "last-turns") {
		if (!Number.isSafeInteger(selection.turns) || selection.turns < 1 || selection.turns > 999999)
			throw new CollaborationError("invalid_arguments", "Invalid fork turn count");
		const complete: AgentMessage[][] = [];
		let turn: AgentMessage[] = [];
		const finish = () => {
			const last = [...turn].reverse().find((message) => message.role === "assistant");
			if (turn[0]?.role === "user" && last?.role === "assistant" && last.stopReason === "stop") complete.push(turn);
		};
		for (const message of context) {
			if (message.role === "user") {
				finish();
				turn = [];
			}
			turn.push(message);
		}
		finish();
		if (complete.length < selection.turns)
			throw new CollaborationError(
				"context_unavailable",
				"Requested complete turns are unavailable in effective context",
			);
		selected = complete.slice(-selection.turns).flat();
	}

	// A spawn call is typically still in flight in the parent. Never import a
	// dangling call/result pair or manufacture a successful tool response for it.
	const output: AgentMessage[] = [];
	for (let index = 0; index < selected.length; index++) {
		const message = selected[index];
		if (message.role === "toolResult") continue;
		if (message.role !== "assistant") {
			output.push(message);
			continue;
		}
		const calls = message.content.filter((item) => item.type === "toolCall");
		if (!calls.length) {
			output.push(message);
			continue;
		}
		const results: AgentMessage[] = [];
		while (selected[index + 1]?.role === "toolResult") results.push(selected[++index]);
		const ids = new Set(calls.map((call) => call.id));
		if (ids.size !== calls.length)
			throw new CollaborationError("context_unavailable", "Ambiguous tool call identities in fork context");
		const paired = calls.every(
			(call) =>
				results.filter(
					(result) =>
						result.role === "toolResult" && result.toolCallId === call.id && result.toolName === call.name,
				).length === 1,
		);
		if (paired && results.length === calls.length) output.push(message, ...results);
	}
	if (Buffer.byteLength(JSON.stringify(output), "utf8") > COLLABORATION_LIMITS.maxForkBytes)
		throw new CollaborationError("limit_reached", "Effective fork context exceeds 256 KiB");
	return structuredClone(output);
}
