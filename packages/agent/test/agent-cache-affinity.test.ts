import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { Agent } from "../src/agent.ts";

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
