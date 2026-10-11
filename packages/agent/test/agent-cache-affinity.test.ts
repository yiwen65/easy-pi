import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { Agent } from "../src/agent.ts";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { StreamFn } from "../src/types.ts";

test("cache affinity passes from constructor and live updates without replacing session or prompt key", async () => {
	const requests: SimpleStreamOptions[] = [];
	const agent = new Agent({
		sessionId: "native-child",
		promptCacheKey: "logical-prefix",
		cacheAffinityId: "ancestor",
		streamFn: (_model, _context, options) => {
			requests.push(options ?? {});
			const stream = createAssistantMessageEventStream();
			const message = fauxAssistantMessage("synthetic result");
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		},
	});
	await agent.prompt("first");
	agent.cacheAffinityId = "next-ancestor";
	await agent.prompt("followup");
	expect(requests).toEqual([
		expect.objectContaining({
			sessionId: "native-child",
			promptCacheKey: "logical-prefix",
			cacheAffinityId: "ancestor",
		}),
		expect.objectContaining({
			sessionId: "native-child",
			promptCacheKey: "logical-prefix",
			cacheAffinityId: "next-ancestor",
		}),
	]);
	expect(agent.sessionId).toBe("native-child");
});

test("routing snapshots cannot replace native identity or unrelated request options", async () => {
	const requests: SimpleStreamOptions[] = [];
	const streamFn: StreamFn = (_model, _context, options) => {
		requests.push(options ?? {});
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("result") });
		stream.end();
		return stream;
	};
	await runAgentLoop(
		[{ role: "user", content: "request", timestamp: Date.now() }],
		{ systemPrompt: "", messages: [] },
		{
			model: new Agent({ streamFn }).state.model,
			convertToLlm: () => [],
			sessionId: "native-child",
			maxTokens: 17,
			getRequestRouting: () => ({
				promptCacheKey: "new-key",
				cacheAffinityId: undefined,
				transport: "sse",
				sessionId: "must-not-replace-native-id",
				maxTokens: 99,
			}),
		},
		() => {},
		undefined,
		streamFn,
	);
	expect(requests).toHaveLength(1);
	expect(requests[0].promptCacheKey).toBe("new-key");
	expect(requests[0].sessionId).toBe("native-child");
	expect(requests[0].maxTokens).toBe(17);
});

test("input-boundary routing updates are captured per request without changing native identity", async () => {
	const requests: SimpleStreamOptions[] = [];
	const agent = new Agent({
		sessionId: "native-child",
		promptCacheKey: "logical-prefix",
		cacheAffinityId: "ancestor",
		transport: "sse",
		streamFn: (_model, _context, options) => {
			requests.push(options ?? {});
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("result") });
			stream.end();
			return stream;
		},
	});
	agent.subscribe(async (event) => {
		if (event.type !== "message_end" || event.message.role !== "user") return;
		await Promise.resolve();
		agent.promptCacheKey = undefined;
		agent.cacheAffinityId = undefined;
		agent.transport = "websocket";
	});
	await agent.prompt("first");
	agent.promptCacheKey = "new-logical-prefix";
	agent.cacheAffinityId = "new-ancestor";
	agent.transport = "sse";
	await agent.prompt("separate run");
	expect(requests).toHaveLength(2);
	for (const request of requests) {
		expect(request.promptCacheKey).toBeUndefined();
		expect(request.cacheAffinityId).toBeUndefined();
		expect(request.transport).toBe("websocket");
		expect(request.sessionId).toBe("native-child");
	}
	expect(agent.sessionId).toBe("native-child");
});
