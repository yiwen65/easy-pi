import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness as createSuiteHarness, type Harness, type HarnessOptions } from "./harness.ts";

function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	return createSuiteHarness({ ...options, hfCompaction: { mode: "off" } });
}

function normalizeEventOrder(events: Harness["events"]): string[] {
	const normalized: string[] = [];
	for (const event of events) {
		const label =
			event.type === "message_start" || event.type === "message_end"
				? `${event.type}:${event.message.role}`
				: event.type === "tool_execution_start" || event.type === "tool_execution_end"
					? `${event.type}:${event.toolName}`
					: event.type;
		if (label === "message_update" && normalized[normalized.length - 1] === "message_update") {
			continue;
		}
		normalized.push(label);
	}
	return normalized;
}

describe("AgentSession retry and event characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.useRealTimers();
	});

	it("retries after a transient error and succeeds", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "end:true"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("retries multiple transient failures and succeeds on the final attempt", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("success"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:true"]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("exhausts max retries and emits a failure event", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 too many requests" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 too many requests" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 too many requests" }),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:false"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, false]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("shares one budget across socket, throttle, DNS, and server failures and stops settled", async () => {
		const harness = await createHarness({ settings: { retry: { maxRetries: 3, baseDelayMs: 0 } } });
		harnesses.push(harness);
		const sessionId = harness.session.sessionId;
		const errors = [
			"terminated (UND_ERR_SOCKET: other side closed)",
			"429 too many requests",
			"getaddrinfo EAI_AGAIN api.example.test",
			"503 service unavailable",
		];
		const persistedAtMessageEnd: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				persistedAtMessageEnd.push(
					harness.sessionManager
						.getEntries()
						.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length,
				);
			}
		});
		harness.setResponses(
			errors.map<FauxResponseStep>((errorMessage) => (context) => {
				expect(
					context.messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
				).toBe(false);
				return fauxAssistantMessage("partial response", { stopReason: "error", errorMessage });
			}),
		);

		await harness.session.prompt("test");
		await harness.session.waitForIdle();
		await harness.session.agent.waitForIdle();

		expect(harness.faux.state.callCount).toBe(4);
		expect(persistedAtMessageEnd).toEqual([1, 2, 3, 4]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2, 3]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			{ type: "auto_retry_end", success: false, attempt: 3, finalError: errors[3] },
		]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, true, false]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: errors[3] });
		expect(harness.sessionManager.buildTranscriptEntries().filter((entry) => entry.type === "message")).toHaveLength(
			5,
		);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.agent.state.isStreaming).toBe(false);
		expect(harness.session.sessionId).toBe(sessionId);

		// A new user request uses a fresh budget without replacing the session.
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: errors[0] }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("try again");
		expect(harness.faux.state.callCount).toBe(6);
		expect(harness.eventsOfType("auto_retry_start").at(-1)?.attempt).toBe(1);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toEqual({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		});
		expect(harness.session.sessionId).toBe(sessionId);
	});

	it("limits the default budget to ten retries and preserves all eleven socket failures", async () => {
		const harness = await createHarness({ settings: { retry: { baseDelayMs: 0 } } });
		harnesses.push(harness);
		const failure = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "terminated (UND_ERR_SOCKET: other side closed)",
		});
		harness.setResponses([...Array.from({ length: 11 }, () => failure), fauxAssistantMessage("must not run")]);

		await harness.session.prompt("test");

		expect(harness.settingsManager.getRetrySettings().maxRetries).toBe(10);
		expect(harness.faux.state.callCount).toBe(11);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual(
			Array.from({ length: 10 }, (_, index) => index + 1),
		);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({ success: false, attempt: 10 });
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				),
		).toHaveLength(11);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.agent.state.isStreaming).toBe(false);
	});

	it("does not retry or hide a socket failure with a zero budget", async () => {
		const harness = await createHarness({ settings: { retry: { maxRetries: 0, baseDelayMs: 0 } } });
		harnesses.push(harness);
		const errorMessage = "terminated (UND_ERR_SOCKET: other side closed)";
		harness.setResponses([fauxAssistantMessage("unfinished", { stopReason: "error", errorMessage })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([false]);
		expect(harness.sessionManager.buildTranscriptEntries().at(-1)).toMatchObject({
			type: "message",
			message: { stopReason: "error", errorMessage },
		});
		expect(harness.session.isIdle).toBe(true);
	});

	it.each([
		{ baseDelayMs: 10_000, delays: [10_000, 20_000, 30_000] },
		{ baseDelayMs: 40_000, delays: [40_000, 40_000, 40_000] },
	])("caps backoff without lowering base delay $baseDelayMs", async ({ baseDelayMs, delays }) => {
		const harness = await createHarness({ settings: { retry: { maxRetries: 5, baseDelayMs } } });
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: 3 }, () =>
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "429 too many requests",
				}),
			),
		);
		vi.useFakeTimers();
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.attempt === 3) harness.session.abortRetry();
		});
		const prompt = harness.session.prompt("test");
		await vi.waitFor(() => expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(delays[0]!);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(delays[1]!);
		await prompt;

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual(delays);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
			success: false,
			attempt: 3,
			finalError: "Retry cancelled",
		});
		expect(harness.session.isIdle).toBe(true);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant") {
							await new Promise((resolve) => setTimeout(resolve, 40));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it.each([
		"fetch failed (ECONNRESET)",
		"terminated (UND_ERR_SOCKET: other side closed)",
		"getaddrinfo ENOTFOUND api.example.test",
		"Codex error: Our servers are currently overloaded. Please try again later.",
		"503 service unavailable",
	])("persists failures before subscribers when retry is disabled: %s", async (errorMessage) => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const failure = fauxAssistantMessage("partial answer", { stopReason: "error", errorMessage });
		harness.setResponses([failure]);
		const persistedAtMessageEnd: boolean[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				persistedAtMessageEnd.push(
					harness.sessionManager
						.getEntries()
						.some((entry) => entry.type === "message" && entry.message === event.message),
				);
			}
		});

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([false]);
		expect(persistedAtMessageEnd).toEqual([true]);
		expect(harness.sessionManager.buildTranscriptEntries().at(-1)).toMatchObject({
			type: "message",
			message: { stopReason: "error", errorMessage, content: failure.content },
		});
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.agent.state.isStreaming).toBe(false);
	});

	it.each(["invalid_api_key", "429 insufficient_quota", "503 billing quota exceeded"])(
		"does not retry non-retryable errors: %s",
		async (errorMessage) => {
			const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		},
	);

	it("cancels retry sleep when abortRetry is called", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("test");
		await sawRetryStart;
		harness.session.abortRetry();
		await promptPromise;

		expect(harness.session.isRetrying).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toContain("Retry cancelled");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("waits for the full loop when retry recovery produces tool calls", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.isStreaming).toBe(false);
		await harness.session.prompt("follow-up");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("resets the shared budget after successful tool calls and later prompts", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [echoTool],
			settings: { retry: { maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		const failure = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });
		harness.setResponses([
			failure("terminated (UND_ERR_SOCKET: other side closed)"),
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			failure("503 service unavailable"),
			fauxAssistantMessage("done"),
			failure("getaddrinfo ENOTFOUND api.example.test"),
			fauxAssistantMessage("next turn"),
		]);

		await harness.session.prompt("test");
		expect(harness.faux.state.callCount).toBe(4);
		await harness.session.prompt("follow-up");

		expect(harness.faux.state.callCount).toBe(6);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 1, 1]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => [event.success, event.attempt])).toEqual([
			[true, 1],
			[true, 1],
			[true, 1],
		]);
		expect(harness.session.retryAttempt).toBe(0);
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				),
		).toHaveLength(3);
		expect(
			harness.session.messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
	});

	it("retains queued input without restarting after exhaustion", async () => {
		const harness = await createHarness({ settings: { retry: { maxRetries: 1, baseDelayMs: 0 } } });
		harnesses.push(harness);
		const failure = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "terminated (UND_ERR_SOCKET: other side closed)",
		});
		harness.setResponses([failure, failure, fauxAssistantMessage("must not run")]);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				void harness.session.followUp("queued follow-up");
			}
		});

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getFollowUpMessages()).toEqual(["queued follow-up"]);
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["queued follow-up"] });
	});

	it("cancels socket recovery backoff and leaves queued input available", async () => {
		const harness = await createHarness({ settings: { retry: { maxRetries: 1, baseDelayMs: 30_000 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial", {
				stopReason: "error",
				errorMessage: "terminated (UND_ERR_SOCKET: other side closed)",
			}),
			fauxAssistantMessage("must not run"),
		]);
		const sawRetryStart = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") resolve();
			});
		});
		const prompt = harness.session.prompt("test");
		await sawRetryStart;
		await harness.session.followUp("queued follow-up");
		await harness.session.abort();
		await prompt;

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
		]);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.agent.state.isStreaming).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual(["queued follow-up"]);
		expect(harness.sessionManager.buildTranscriptEntries().at(-1)).toMatchObject({
			type: "message",
			message: { stopReason: "error" },
		});
	});

	it("reports an aborted retry response as cancellation rather than successful recovery", async () => {
		const harness = await createHarness({ settings: { retry: { maxRetries: 2, baseDelayMs: 0 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("partial", { stopReason: "aborted", errorMessage: "Operation aborted" }),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Operation aborted" },
		]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("emits extension events before public event subscribers", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
					pi.on("message_end", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_end") {
				order.push(`public:${event.type}:${event.message.role}`);
			}
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hi");

		expect(order).toEqual([
			"extension:message_start:user",
			"public:message_start:user",
			"extension:message_end:user",
			"public:message_end:user",
			"extension:message_start:assistant",
			"public:message_start:assistant",
			"extension:message_end:assistant",
			"public:message_end:assistant",
		]);
	});

	it("emits the expected event order for a single prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits the expected event order for a tool call turn", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(toolRuns).toEqual(["hello"]);
		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"tool_execution_start:echo",
			"tool_execution_end:echo",
			"message_start:toolResult",
			"message_end:toolResult",
			"turn_end",
			"turn_start",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits streaming deltas for text, thinking, and tool calls in message_update events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("plan"), { type: "text", text: "answer" }, fauxToolCall("echo", { text: "hello" })],
				{
					stopReason: "toolUse",
				},
			),
		]);

		await harness.session.prompt("hi").catch(() => {});

		const updateTypes = harness.eventsOfType("message_update").map((event) => event.assistantMessageEvent.type);
		expect(updateTypes).toContain("thinking_delta");
		expect(updateTypes).toContain("text_delta");
		expect(updateTypes).toContain("toolcall_delta");
	});

	it("emits agent_end for error responses", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "broken" })]);

		await harness.session.prompt("hi");

		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
	});

	it("emits agent_end for aborted runs and persists the aborted assistant message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});
});
