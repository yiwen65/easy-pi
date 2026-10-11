import type { AssistantMessage } from "../types.ts";
import { extractFormattedProviderErrorStatus } from "./error-body.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const PERMANENT_PROVIDER_ERROR_PATTERN =
	/\b(?:invalid_request_error|invalid_function_parameters|invalid_value|authentication_error|permission_error|not_found_error)\b|^Validation error:/i;
const TRANSIENT_PROVIDER_ERROR_TYPE_PATTERN =
	/^(?:overloaded_error|server_busy|rate_limit_error|server_error|internal_error|internal_server_error|service_unavailable|ResourceExhausted)$/i;

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
	"\\b(?:request|connect(?:ion)?|socket|fetch|stream|read) timeout\\b",
	"^timeout(?: error| exceeded|$)",
	"operation was aborted due to timeout",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	// Proxy EOF must use the same completed-item recovery path as a direct transport drop.
	"connection closed by proxy server before the response completed",
	"http2 request did not get a response",
	// Node ERR_HTTP2_STREAM_CANCEL: the HTTP/2 session died before the request was
	// sent, e.g. after the Bedrock SDK's 5-minute session timeout (#10379).
	"pending stream has been canceled",
] as const;

const NETWORK_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern(NETWORK_PROVIDER_ERROR_PATTERNS);
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"rate.?limit",
	"too many requests",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

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
 * Retry policy: bounded transient-error attempts with capped exponential backoff.
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent;
 * kept here so the classifier and policy-driven retry loop stay reusable by other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts shared by all retryable errors. The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Exponential backoff is capped at 30 seconds, or this delay when larger. */
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
 * - All transient failures, including network transport and provider availability errors,
 *   share a budget of `maxRetries` retries. Exponential backoff is capped at 30 seconds
 *   (or `baseDelayMs` when larger), and its exponent is capped to avoid numeric overflow.
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

		// Non-retryable, or retry budget exhausted: return the final error message.
		if (!retryEnabled || !retryable || attempt >= maxAttempts) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const exponent = Math.min(attempt - 1, 30);
		const exponentialDelayMs = policy!.baseDelayMs * 2 ** exponent;
		const delayMs = Math.min(exponentialDelayMs, Math.max(policy!.baseDelayMs, 30_000));
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

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
	if (message.stopReason !== "error" || typeof message.errorMessage !== "string") return false;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message.errorMessage)) return false;
	const { status, text, errorType, providerBody } = getProviderErrorDetails(message);
	if (status === 400) {
		// Qoder's gateway reports temporary model-catalog lookup failures as 400
		// invalid_request_error, including JSON encoded inside another error message.
		// Inspect only message envelopes, never arbitrary body fields. The caller's
		// normal budget/backoff still applies; ordinary request validation stays terminal.
		let reason = text;
		for (let depth = 0; depth < 5; depth++) {
			reason = reason.replace(/^(?:Error:\s*)?(?:OpenAI API error \(400\)|\[?400\]?):\s*/, "");
			if (!/^[{"]/.test(reason)) break;
			try {
				const parsed: unknown = JSON.parse(reason);
				if (typeof parsed === "string") {
					reason = parsed;
					continue;
				}
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) break;
				const envelope = parsed as Record<string, unknown>;
				const error =
					typeof envelope.error === "object" && envelope.error !== null
						? (envelope.error as Record<string, unknown>)
						: envelope;
				if (error.type !== undefined && error.type !== "invalid_request_error") break;
				if (error.code !== undefined && error.code !== "bad_request") break;
				if (typeof error.message !== "string") break;
				reason = error.message;
			} catch {
				break;
			}
		}
		if (
			/^qoder: model_config for .{1,256} not yet known \(run a model list fetch or check upstream connectivity\)$/.test(
				reason,
			)
		)
			return true;
	}
	if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500;
	if (PERMANENT_PROVIDER_ERROR_PATTERN.test(errorType ?? "") || PERMANENT_PROVIDER_ERROR_PATTERN.test(text))
		return false;
	return (
		TRANSIENT_PROVIDER_ERROR_TYPE_PATTERN.test(errorType ?? "") ||
		RETRYABLE_PROVIDER_ERROR_PATTERN.test(text) ||
		(!providerBody && NETWORK_PROVIDER_ERROR_PATTERN.test(text))
	);
}

/** True when an assistant failure is caused by a network transport interruption. */
export function isNetworkAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || typeof message.errorMessage !== "string") return false;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message.errorMessage)) return false;
	const { status, text, errorType, providerBody } = getProviderErrorDetails(message);
	// An HTTP error response is not evidence of a transport interruption, even if
	// its body mentions a timeout or an invalid field named "timeout".
	if (
		status !== undefined ||
		providerBody ||
		PERMANENT_PROVIDER_ERROR_PATTERN.test(errorType ?? "") ||
		PERMANENT_PROVIDER_ERROR_PATTERN.test(text)
	)
		return false;
	return NETWORK_PROVIDER_ERROR_PATTERN.test(text);
}

function getProviderErrorDetails(message: AssistantMessage): {
	status?: number;
	text: string;
	errorType?: string;
	providerBody?: boolean;
} {
	const text = message.errorMessage!.trim();
	// Bedrock already retains trusted SDK metadata alongside its legacy display
	// prefix. Do not treat unrelated diagnostic fields as an HTTP response.
	const sdkStatus = message.diagnostics?.find((diagnostic) => diagnostic.type === "bedrock_response_failure")?.details
		?.status;
	const status = getHttpErrorStatus(sdkStatus) ?? extractFormattedProviderErrorStatus(text);
	if (status !== undefined) return { status, text };
	if (!/^[{["]/.test(text)) return { text };

	// SDK/provider JSON errors may expose a useful message/type, but arbitrary
	// body keys and values must never be scanned as transport/server evidence.
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "string") return { text: parsed, status: extractFormattedProviderErrorStatus(parsed) };
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { text: "" };
		const envelope = parsed as Record<string, unknown>;
		const error =
			typeof envelope.error === "object" && envelope.error !== null
				? (envelope.error as Record<string, unknown>)
				: envelope;
		const types = [error.type, error.code].filter((value): value is string => typeof value === "string");
		return {
			text: typeof error.message === "string" ? error.message : "",
			errorType:
				types.find((type) => PERMANENT_PROVIDER_ERROR_PATTERN.test(type)) ??
				types.find((type) => TRANSIENT_PROVIDER_ERROR_TYPE_PATTERN.test(type)),
			providerBody: true,
		};
	} catch {
		return { text: "" };
	}
}

function getHttpErrorStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}
