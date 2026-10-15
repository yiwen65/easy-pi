import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSummarization, type SummarizationAttemptMetrics } from "../src/core/compaction/compaction.ts";
import { CompactionDiagnostics } from "../src/core/compaction/subsystem/observability.ts";
import { createPiAiCompleteFn, HfCompactionHost } from "../src/core/compaction/subsystem/session-integration.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const model: Model<"openai-codex-responses"> = {
	id: "synthetic-compactor",
	name: "Synthetic Compactor",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = { messages: [{ role: "user", content: "source material", timestamp: 1 }] };
const handoff = "## Conversation timeline\nPreserved the migration result.\n## Current continuation point\nRun tests.";

function response(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		...fauxAssistantMessage(handoff),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 300,
			cacheWrite: 10,
			reasoning: 5,
			totalTokens: 430,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		},
		...overrides,
	};
}

function scriptedStream(messages: AssistantMessage[]): StreamFn {
	let index = 0;
	return () => {
		const stream = createAssistantMessageEventStream();
		const message = messages[index++]!;
		queueMicrotask(() => {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else if (message.stopReason !== "pending") {
				stream.push({ type: "done", reason: message.stopReason, message });
			}
		});
		return stream;
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("compaction attempt diagnostics", () => {
	it("separates first event, first thinking and first nonempty text without waiting for iterator close", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const message = response();
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			setTimeout(() => stream.push({ type: "start", partial: message }), 10);
			setTimeout(
				() => stream.push({ type: "thinking_delta", contentIndex: 0, delta: "think", partial: message }),
				20,
			);
			setTimeout(() => stream.push({ type: "text_delta", contentIndex: 0, delta: "", partial: message }), 25);
			setTimeout(() => stream.push({ type: "text_delta", contentIndex: 0, delta: "answer", partial: message }), 30);
			setTimeout(() => stream.push({ type: "done", reason: "stop", message }), 40);
			return stream;
		};
		const attempts: SummarizationAttemptMetrics[] = [];
		const promise = completeSummarization(model, context, {}, streamFn, undefined, undefined, (m) =>
			attempts.push(m),
		);
		await vi.advanceTimersByTimeAsync(40);
		expect(await promise).toBe(message);
		expect(attempts).toEqual([
			{
				durationMs: 40,
				firstEventMs: 10,
				firstThinkingMs: 20,
				firstTextMs: 30,
				stopReason: "stop",
				usage: message.usage,
			},
		]);
	});

	it("leaves text latency absent for an error-only response and preserves complete usage", async () => {
		const diagnostics = new CompactionDiagnostics();
		const error = response({ stopReason: "error", errorMessage: "secret-provider-error" });
		const complete = createPiAiCompleteFn({ model, diagnostics, streamFn: scriptedStream([error]) });
		expect((await complete({ ...context, systemPrompt: "secret-prompt", promptVersion: "test" })).stopReason).toBe(
			"error",
		);
		const snapshot = diagnostics.finish("manual", "failed");
		expect(snapshot.attempts).toHaveLength(1);
		expect(snapshot.attempts[0]).toMatchObject({
			provider: model.provider,
			model: model.id,
			requestIndex: 1,
			usage: error.usage,
		});
		expect(snapshot.attempts[0]?.firstTextMs).toBeUndefined();
		expect(JSON.stringify(snapshot)).not.toContain("secret");
		expect(JSON.stringify(snapshot)).not.toContain("source material");
	});

	it("keeps every retry attempt and its usage while forwarding the existing callbacks", async () => {
		const diagnostics = new CompactionDiagnostics();
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const complete = createPiAiCompleteFn({
			model,
			diagnostics,
			streamFn: scriptedStream([response({ stopReason: "error", errorMessage: "terminated" }), response()]),
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			callbacks: { onRetryScheduled, onRetryFinished },
		});
		expect((await complete({ ...context, systemPrompt: "policy", promptVersion: "test" })).stopReason).toBe("stop");
		const snapshot = diagnostics.finish("threshold", "activated");
		expect(snapshot.attempts.map((m) => [m.requestIndex, m.stopReason, m.usage?.cacheRead])).toEqual([
			[1, "error", 300],
			[1, "stop", 300],
		]);
		expect(snapshot).toMatchObject({ retryCount: 1, scheduledRetryDelayMs: 1 });
		expect(onRetryScheduled).toHaveBeenCalledOnce();
		expect(onRetryFinished).toHaveBeenCalledWith(true, 1);
	});

	it("records thrown and aborted invocations without inventing token timings or masking errors", async () => {
		const error = new Error("private auth error");
		const onAttempt = vi.fn();
		const streamFn: StreamFn = () => {
			throw error;
		};
		await expect(completeSummarization(model, context, {}, streamFn, undefined, undefined, onAttempt)).rejects.toBe(
			error,
		);
		expect(onAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ stopReason: "error", usage: undefined, firstTextMs: undefined }),
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			completeSummarization(
				model,
				context,
				{ signal: controller.signal },
				streamFn,
				undefined,
				undefined,
				onAttempt,
			),
		).rejects.toBe(error);
		expect(onAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ stopReason: "aborted" }));
	});

	it("does not let an observer failure change a successful summarization", async () => {
		const message = response();
		const result = await completeSummarization(
			model,
			context,
			{},
			scriptedStream([message]),
			undefined,
			undefined,
			() => {
				throw new Error("observer unavailable");
			},
		);
		expect(result).toBe(message);
	});

	it("distinguishes overflow replay from transient retries and records host phases", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "migration context ".repeat(1000), timestamp: 1 });
		manager.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "call-1",
			content: [{ type: "text", text: "x".repeat(1000) }],
			details: undefined,
			isError: false,
			timestamp: 2,
		});
		const diagnostics = new CompactionDiagnostics();
		const overflow = response();
		overflow.usage = { ...overflow.usage, input: 200_000, totalTokens: 200_330 };
		const complete = createPiAiCompleteFn({ model, diagnostics, streamFn: scriptedStream([overflow, response()]) });
		const host = new HfCompactionHost({
			sessionId: "test",
			getSystemPrompt: () => "policy",
			config: { mode: "full_pipeline" },
		});
		const result = await host.attemptCompaction({ branchEntries: manager.getBranch(), complete, diagnostics });
		expect(result.activated).toBe(true);
		const snapshot = diagnostics.finish("overflow", "activated");
		expect(snapshot.attempts.map((m) => m.requestIndex)).toEqual([1, 2]);
		expect(snapshot.attempts.map((m) => m.usage?.input)).toEqual([200_000, 100]);
		expect(snapshot.retryCount).toBe(0);
		expect(snapshot.stages?.preparationMs).toBeGreaterThanOrEqual(0);
		expect(snapshot.stages?.generationMs).toBeGreaterThanOrEqual(0);
		expect(snapshot.stages?.validationMs).toBeGreaterThanOrEqual(0);
	});

	it("records host stages even when generation throws or preparation rejects", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "history".repeat(100), timestamp: 1 });
		const diagnostics = new CompactionDiagnostics();
		const host = new HfCompactionHost({
			sessionId: "test",
			getSystemPrompt: () => "policy",
			config: { mode: "full_pipeline" },
		});
		const result = await host.attemptCompaction({
			branchEntries: manager.getBranch(),
			diagnostics,
			complete: async () => {
				throw new Error("failed");
			},
		});
		expect(result.activated).toBe(false);
		expect(diagnostics.finish("manual", "failed").stages?.generationMs).toBeGreaterThanOrEqual(0);
		const emptyDiagnostics = new CompactionDiagnostics();
		await host.attemptCompaction({ branchEntries: [], diagnostics: emptyDiagnostics });
		expect(emptyDiagnostics.finish("manual", "failed").stages).toMatchObject({ generationMs: 0, validationMs: 0 });
	});
});
