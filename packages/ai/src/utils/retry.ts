import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const HTTP_SERVER_ERROR_PATTERN = "\\b5\\d\\d\\b";

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const NETWORK_PROVIDER_ERROR_PATTERNS = [
	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNRESET",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
] as const;

const NETWORK_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern(NETWORK_PROVIDER_ERROR_PATTERNS);
const UNLIMITED_RETRY_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	HTTP_SERVER_ERROR_PATTERN,
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"bad gateway",
	"gateway timeout",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	HTTP_SERVER_ERROR_PATTERN,
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	...NETWORK_PROVIDER_ERROR_PATTERNS,
	"terminated",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

/**
 * Retry policy: bounded transient-error attempts plus unlimited recovery for network
 * failures and provider availability errors with exponential backoff (`baseDelayMs * 2^(attempt-1)`). Matches `settings.retry`
 * (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent; kept here so the classifier
 * and the policy-driven retry loop live together and stay reusable by other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max bounded retry attempts. The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
		unlimited: boolean,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Network transport failures and provider availability errors retry until recovery or
 *   cancellation. Other transient failures retry up to `maxRetries` times. Backoff for unlimited retries
 *   is capped at 30 seconds (or `baseDelayMs` when larger) to avoid numeric overflow.
 * - Emits `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep
 *   before the retried call starts, and `onRetryFinished` once at the end.
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const retryEnabled = policy?.enabled === true;
	const maxAttempts = retryEnabled ? policy.maxRetries : 0;

	let attempt = 0;
	let boundedAttempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		const retryable = isRetryableAssistantError(response);
		const unlimited = isUnlimitedRetryAssistantError(response);

		// Non-retryable, or bounded retry budget exhausted: return the final error message.
		if (!retryEnabled || !retryable || (!unlimited && boundedAttempt >= maxAttempts)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		if (!unlimited) boundedAttempt++;
		const reportedAttempt = unlimited ? attempt : boundedAttempt;
		lastRetry = { attempt: reportedAttempt, errorMessage: response.errorMessage || "Unknown error" };
		const exponent = unlimited ? Math.min(attempt - 1, 30) : boundedAttempt - 1;
		const exponentialDelayMs = policy!.baseDelayMs * 2 ** exponent;
		const delayMs = unlimited
			? Math.min(exponentialDelayMs, Math.max(policy!.baseDelayMs, 30_000))
			: exponentialDelayMs;
		await callbacks?.onRetryScheduled?.(reportedAttempt, maxAttempts, delayMs, lastRetry.errorMessage, unlimited);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

/** True when an assistant failure is caused by a network transport interruption. */
export function isNetworkAssistantError(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		typeof message.errorMessage === "string" &&
		NETWORK_PROVIDER_ERROR_PATTERN.test(message.errorMessage)
	);
}

/** True when a transient failure should retry until recovery or cancellation. */
export function isUnlimitedRetryAssistantError(message: AssistantMessage): boolean {
	const errorMessage = message.errorMessage;
	return (
		typeof errorMessage === "string" &&
		isRetryableAssistantError(message) &&
		(isNetworkAssistantError(message) || UNLIMITED_RETRY_PROVIDER_ERROR_PATTERN.test(errorMessage))
	);
}
