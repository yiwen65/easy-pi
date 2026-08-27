import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
/**
 * Post-removal coverage for the surviving shared summarization choke point
 * (completeSummarization) and the subsystem's production LLM adapter
 * (createPiAiCompleteFn). The legacy generateSummary/compact functions were
 * removed with the summary-only compactor (EPIC-CCTX-001).
 */
import { completeSummarization } from "../src/core/compaction/index.ts";
import { createPiAiCompleteFn } from "../src/core/compaction/subsystem/session-integration.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function assistantOk(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const context: Context = {
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

beforeEach(() => {
	completeSimpleMock.mockReset();
});

describe("completeSummarization (surviving shared choke point)", () => {
	it("forces toolChoice none and returns the assistant message", async () => {
		completeSimpleMock.mockResolvedValue(assistantOk("result text"));
		const result = await completeSummarization(createModel(), context, { maxTokens: 100 });
		expect(result.stopReason).toBe("stop");
		const sentOptions = completeSimpleMock.mock.calls[0][2];
		expect(sentOptions.toolChoice).toBe("none");
		expect(sentOptions.cacheRetention).toBe("none");
		expect(sentOptions.sessionId).toBeTruthy();
	});

	it("retries once on a transient stream drop, then succeeds", async () => {
		// retryAssistantCall retries error AssistantMessages (not thrown exceptions).
		completeSimpleMock
			.mockResolvedValueOnce({ ...assistantOk(""), stopReason: "error", errorMessage: "terminated" })
			.mockResolvedValueOnce(assistantOk("after retry"));
		const result = await completeSummarization(createModel(), context, { maxTokens: 100 }, undefined, {
			enabled: true,
			maxRetries: 2,
			baseDelayMs: 1,
		});
		expect(result.stopReason).toBe("stop");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
	});

	it("honors caller cache retention and routing session", async () => {
		completeSimpleMock.mockResolvedValue(assistantOk("x"));
		await completeSummarization(createModel(), context, {
			maxTokens: 100,
			cacheRetention: "short",
			sessionId: "fixed-route",
		});
		const sentOptions = completeSimpleMock.mock.calls[0][2];
		expect(sentOptions.cacheRetention).toBe("short");
		expect(sentOptions.sessionId).toBe("fixed-route");
	});
});

describe("createPiAiCompleteFn (subsystem production adapter)", () => {
	it("maps provider responses to CompactionLLMResponse with usage", async () => {
		completeSimpleMock.mockResolvedValue(assistantOk("extracted text"));
		const complete = createPiAiCompleteFn({ model: createModel(), apiKey: "k", sessionId: "compact-session" });
		const res = await complete({
			systemPrompt: "policy",
			messages: [{ role: "user", content: "data", timestamp: 1 }],
			promptVersion: "1.0.0",
		});
		expect(res).toEqual({ text: "extracted text", stopReason: "stop", usage: { input: 10, output: 5 } });
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			cacheRetention: "short",
			sessionId: "compact-session",
			toolChoice: "none",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("maxTokens");
	});

	it("maps provider errors to stopReason error (fail closed at the caller)", async () => {
		completeSimpleMock.mockResolvedValue({ ...assistantOk(""), stopReason: "error", errorMessage: "rate limit" });
		const complete = createPiAiCompleteFn({ model: createModel() });
		const res = await complete({
			systemPrompt: "p",
			messages: [{ role: "user", content: "d", timestamp: 1 }],
			promptVersion: "1.0.0",
		});
		expect(res.stopReason).toBe("error");
		expect(res.errorMessage).toBe("rate limit");
	});
});
