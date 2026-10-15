import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import { createPiAiCompleteFn } from "../src/core/compaction/subsystem/session-integration.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const model: Model<"openai-codex-responses"> = {
	id: "synthetic-fast-summary",
	name: "Synthetic",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 8192,
};

it.each([undefined, "default", "fast"] as const)(
	"keeps independent and explicitly configured summaries separate (%s)",
	async (serviceTier) => {
		const captured: SimpleStreamOptions[] = [];
		const streamFn: StreamFn = (_model, _context, options) => {
			captured.push({ ...options });
			const stream = createAssistantMessageEventStream();
			stream.end(fauxAssistantMessage("summary"));
			return stream;
		};
		const complete = createPiAiCompleteFn({ model, serviceTier, thinkingLevel: "high", streamFn });
		await complete({
			systemPrompt: "policy",
			messages: [{ role: "user", content: "history", timestamp: 1 }],
			promptVersion: "test",
		});
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "branch history", timestamp: 1 });
		const result = await generateBranchSummary(manager.getBranch(), {
			model,
			serviceTier,
			signal: new AbortController().signal,
			streamFn,
		});
		expect(result.error).toBeUndefined();
		expect(captured).toHaveLength(2);
		for (const options of captured) {
			if (serviceTier === undefined) expect(options).not.toHaveProperty("serviceTier");
			else expect(options.serviceTier).toBe(serviceTier);
			expect(options.toolChoice).toBe("none");
		}
		expect(captured[0].reasoning).toBe("high");
	},
);
