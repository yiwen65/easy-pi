import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import {
	isNetworkAssistantError,
	isRetryableAssistantError,
	type RetryPolicy,
	retryAssistantCall,
} from "../src/utils/retry.ts";

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)";
const bunFetchSocketClosedMessage =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const openAIResponsesEarlyEofMessage = "OpenAI Responses stream ended before a terminal response event";
const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";
const terminatedSocketError = "terminated (UND_ERR_SOCKET: other side closed)";

describe("provider retry classification", () => {
	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
			),
		).toBe(true);
	});

	it("matches Bun fetch socket drop wording", () => {
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage });
		expect(isRetryableAssistantError(message)).toBe(true);
		expect(isNetworkAssistantError(message)).toBe(true);
	});

	it.each([
		"fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: chatgpt.com:443, timeout: 10000ms))",
		"ECONNRESET: Client network socket disconnected before secure TLS connection was established",
		terminatedSocketError,
	])("classifies connection and socket failures as network failures: %s", (errorMessage) => {
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
		expect(isRetryableAssistantError(message)).toBe(true);
		expect(isNetworkAssistantError(message)).toBe(true);
	});

	it("matches upstream request buffer exhaustion wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			),
		).toBe(true);
	});

	it.each([
		wrappedDnsLookupError,
		"connect ENOTFOUND api.example.com",
		"EAI_AGAIN api.example.com",
		"getaddrinfo failed for api.example.com",
	])("matches DNS transport failure wording: %s", (errorMessage) => {
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
		expect(isRetryableAssistantError(message)).toBe(true);
		expect(isNetworkAssistantError(message)).toBe(true);
	});

	it("matches OpenAI Responses streams that end before terminal events", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIResponsesEarlyEofMessage }),
			),
		).toBe(true);
	});

	it.each([
		"Codex error: Our servers are currently overloaded. Please try again later.",
		"500 internal server error",
		"501 status code",
		"502 bad gateway",
		"503 service unavailable",
		"504 gateway timeout",
		"524 origin timeout",
		"599 status code",
	])("classifies provider availability failures as retryable: %s", (errorMessage) => {
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
		expect(isRetryableAssistantError(message)).toBe(true);
	});

	it("classifies rate limits as retryable", () => {
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 too many requests" });
		expect(isRetryableAssistantError(message)).toBe(true);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});
});

describe("retryAssistantCall", () => {
	const disabled: RetryPolicy = { enabled: false, maxRetries: 3, baseDelayMs: 0 };
	const enabled: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };

	it("returns a successful response immediately without retrying", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("ok"));
		const res = await retryAssistantCall(produce, enabled, undefined);
		expect(res.content).toEqual([{ type: "text", text: "ok" }]);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("does not retry an aborted message", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "aborted" }));
		const onRetryScheduled = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it.each(["insufficient_quota", "429 quota exceeded", "503 billing limit exceeded"])(
		"does not retry quota/billing exhaustion: %s",
		async (errorMessage) => {
			const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage }));
			const onRetryScheduled = vi.fn();
			const onRetryFinished = vi.fn();
			const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
			expect(res.stopReason).toBe("error");
			expect(produce).toHaveBeenCalledTimes(1);
			expect(onRetryScheduled).not.toHaveBeenCalled();
			expect(onRetryFinished).not.toHaveBeenCalled();
		},
	);

	it("retries a transient error up to maxRetries then returns the final error", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
		expect(onRetryScheduled).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 3, "terminated");
	});

	it("stops retrying once a call succeeds", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(true, 2);
	});

	it.each([
		terminatedSocketError,
		wrappedDnsLookupError,
		"fetch failed: connect timeout",
		"503 service unavailable",
		"Codex error: Our servers are currently overloaded. Please try again later.",
	])("bounds retryable failures by maxRetries: %s", async (errorMessage) => {
		const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage });
		let calls = 0;
		const produce = vi.fn(async () => (++calls <= 2 ? failure : fauxAssistantMessage("past budget")));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const policy: RetryPolicy = { ...enabled, maxRetries: 1 };

		const res = await retryAssistantCall(produce, policy, undefined, { onRetryScheduled, onRetryFinished });

		expect(res).toBe(failure);
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryScheduled.mock.calls).toEqual([[1, 1, 0, errorMessage]]);
		expect(onRetryFinished).toHaveBeenCalledExactlyOnceWith(false, 1, errorMessage);
	});

	it("shares one budget across socket, provider, rate-limit, and DNS failures", async () => {
		const errors = [terminatedSocketError, "503 service unavailable", "429 too many requests", wrappedDnsLookupError];
		const failures = errors.map((errorMessage) => fauxAssistantMessage("", { stopReason: "error", errorMessage }));
		let calls = 0;
		const produce = vi.fn(async () => failures[calls++] ?? fauxAssistantMessage("past budget"));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();

		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });

		expect(res).toBe(failures[3]);
		expect(produce).toHaveBeenCalledTimes(4);
		expect(onRetryScheduled.mock.calls).toEqual([
			[1, 3, 0, errors[0]],
			[2, 3, 0, errors[1]],
			[3, 3, 0, errors[2]],
		]);
		expect(onRetryFinished).toHaveBeenCalledExactlyOnceWith(false, 3, wrappedDnsLookupError);
	});

	it.each([terminatedSocketError, "503 service unavailable", "429 too many requests"])(
		"does not retry with maxRetries=0: %s",
		async (errorMessage) => {
			const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage });
			let calls = 0;
			const produce = vi.fn(async () => (++calls === 1 ? failure : fauxAssistantMessage("past budget")));
			const onRetryScheduled = vi.fn();
			const onRetryFinished = vi.fn();
			const policy: RetryPolicy = { ...enabled, maxRetries: 0 };

			const res = await retryAssistantCall(produce, policy, undefined, { onRetryScheduled, onRetryFinished });

			expect(res).toBe(failure);
			expect(produce).toHaveBeenCalledTimes(1);
			expect(onRetryScheduled).not.toHaveBeenCalled();
			expect(onRetryFinished).not.toHaveBeenCalled();
		},
	);

	it("recovers before exhausting a mixed-error budget", async () => {
		const errors = [terminatedSocketError, "503 service unavailable"];
		let calls = 0;
		const produce = vi.fn(async () => {
			const errorMessage = errors[calls++];
			return errorMessage
				? fauxAssistantMessage("", { stopReason: "error", errorMessage })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();

		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });

		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(3);
		expect(onRetryScheduled.mock.calls).toEqual([
			[1, 3, 0, errors[0]],
			[2, 3, 0, errors[1]],
		]);
		expect(onRetryFinished).toHaveBeenCalledExactlyOnceWith(true, 2);
	});

	it("returns a non-retryable error after a scheduled retry", async () => {
		const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" });
		const produce = vi
			.fn(async () => failure)
			.mockResolvedValueOnce(fauxAssistantMessage("", { stopReason: "error", errorMessage: terminatedSocketError }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();

		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });

		expect(res).toBe(failure);
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryScheduled).toHaveBeenCalledTimes(1);
		expect(onRetryFinished).toHaveBeenCalledExactlyOnceWith(false, 1, "429 quota exceeded");
	});

	it("reports an aborted retried call as unsuccessful", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("", { stopReason: "aborted" });
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1);
	});

	it.each(["terminated", terminatedSocketError, "503 service unavailable"])(
		"does not retry when policy is disabled: %s",
		async (errorMessage) => {
			const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage }));
			const onRetryScheduled = vi.fn();
			const onRetryFinished = vi.fn();
			const res = await retryAssistantCall(produce, disabled, undefined, { onRetryScheduled, onRetryFinished });
			expect(res.stopReason).toBe("error");
			expect(produce).toHaveBeenCalledTimes(1);
			expect(onRetryScheduled).not.toHaveBeenCalled();
			expect(onRetryFinished).not.toHaveBeenCalled();
		},
	);

	it("does not retry without a policy", async () => {
		const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: terminatedSocketError });
		const produce = vi.fn(async () => failure);
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();

		const res = await retryAssistantCall(produce, undefined, undefined, { onRetryScheduled, onRetryFinished });

		expect(res).toBe(failure);
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it.each([terminatedSocketError, "503 service unavailable", "429 too many requests"])(
		"caps exponential backoff at 30 seconds for ten retries: %s",
		async (errorMessage) => {
			vi.useFakeTimers();
			try {
				const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage });
				const produce = vi.fn(async () => failure);
				const policy: RetryPolicy = { enabled: true, maxRetries: 10, baseDelayMs: 2_000 };
				const onRetryScheduled = vi.fn();
				const pending = retryAssistantCall(produce, policy, undefined, { onRetryScheduled });
				await vi.runAllTimersAsync();
				const res = await pending;

				expect(res).toBe(failure);
				expect(produce).toHaveBeenCalledTimes(11);
				expect(onRetryScheduled.mock.calls.map((call) => call[2])).toEqual([
					2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
				]);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("does not lower an explicit base delay above 30 seconds", async () => {
		vi.useFakeTimers();
		try {
			const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: terminatedSocketError });
			const produce = vi.fn(async () => failure);
			const policy: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 45_000 };
			const onRetryScheduled = vi.fn();
			const pending = retryAssistantCall(produce, policy, undefined, { onRetryScheduled });
			await vi.runAllTimersAsync();
			const res = await pending;

			expect(res).toBe(failure);
			expect(produce).toHaveBeenCalledTimes(4);
			expect(onRetryScheduled.mock.calls.map((call) => call[2])).toEqual([45_000, 45_000, 45_000]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps zero-delay backoff finite when the uncapped exponent would overflow", async () => {
		vi.useFakeTimers();
		try {
			const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 too many requests" });
			const produce = vi.fn(async () => failure);
			const policy: RetryPolicy = { enabled: true, maxRetries: 1_030, baseDelayMs: 0 };
			const onRetryScheduled = vi.fn();
			const pending = retryAssistantCall(produce, policy, undefined, { onRetryScheduled });
			await vi.runAllTimersAsync();
			const res = await pending;

			expect(res).toBe(failure);
			expect(produce).toHaveBeenCalledTimes(1_031);
			expect(onRetryScheduled).toHaveBeenCalledTimes(1_030);
			expect(onRetryScheduled.mock.calls.every((call) => call[2] === 0)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("emits onRetryAttemptStart after backoff before each retried call", async () => {
		const events: string[] = [];
		let n = 0;
		const produce = vi.fn(async () => {
			events.push(`produce:${n}`);
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn((attempt: number) => {
			events.push(`retry:${attempt}`);
		});
		const onRetryAttemptStart = vi.fn(() => {
			events.push("attempt-start");
		});
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryAttemptStart });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(onRetryScheduled).toHaveBeenCalledTimes(2);
		expect(onRetryAttemptStart).toHaveBeenCalledTimes(2);
		expect(events).toEqual([
			"produce:0",
			"retry:1",
			"attempt-start",
			"produce:1",
			"retry:2",
			"attempt-start",
			"produce:2",
		]);
	});

	it.each(["terminated", terminatedSocketError])("cancels backoff without another call: %s", async (errorMessage) => {
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage }));
			const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 10_000 };
			const onRetryAttemptStart = vi.fn();
			const onRetryFinished = vi.fn();
			const pending = retryAssistantCall(produce, policy, controller.signal, {
				onRetryAttemptStart,
				onRetryFinished,
			});
			await vi.advanceTimersByTimeAsync(1_000);
			controller.abort();
			const res = await pending;

			expect(res.stopReason).toBe("aborted");
			expect(res.errorMessage).toBeUndefined();
			expect(produce).toHaveBeenCalledTimes(1);
			expect(onRetryAttemptStart).not.toHaveBeenCalled();
			expect(onRetryFinished).toHaveBeenCalledExactlyOnceWith(false, 1, errorMessage);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
