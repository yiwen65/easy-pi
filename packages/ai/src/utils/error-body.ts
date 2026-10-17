// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

/** Read a bounded diagnostic prefix without dropping caller cancellation after response headers. */
export async function readProviderErrorBody(response: Response, signal?: AbortSignal): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const maxBytes = 4000;
	let bytes = 0;
	let text = "";
	let complete = false;
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (bytes < maxBytes) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) {
				complete = true;
				return text + decoder.decode();
			}
			const chunk = value.subarray(0, maxBytes - bytes);
			bytes += chunk.byteLength;
			text += decoder.decode(chunk, { stream: true });
		}
		return `${text}${decoder.decode()}... [truncated]`;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (!complete) {
			try {
				await reader.cancel();
			} catch {}
		}
		reader.releaseLock();
	}
}

export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Raw HTTP body reason, already trimmed and truncated to the cap. */
	body?: string;
	/** Bounded nested error details hidden behind generic messages such as `fetch failed`. */
	causeDetails?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		causeDetails: extractCauseDetails(error),
		message: error.message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

function extractCauseDetails(error: Error): string | undefined {
	const details: string[] = [];
	const seen = new Set<unknown>([error]);

	const visit = (value: unknown): void => {
		if (value === undefined || value === null || seen.has(value) || details.length >= 3) return;
		seen.add(value);

		if (value instanceof AggregateError) {
			for (const nested of value.errors) visit(nested);
			return;
		}
		if (!(value instanceof Error)) return;

		const code = "code" in value && typeof value.code === "string" ? value.code : undefined;
		const detail = code ? `${code}: ${value.message}` : value.message;
		if (detail && !details.includes(detail)) details.push(detail);
		visit(value.cause);
	};

	visit(error.cause);
	if (details.length === 0) return undefined;
	return truncateErrorText(details.join("; "), 500);
}

/**
 * Probe the HTTP status, first valid HTTP code wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	for (const status of [
		error.statusCode,
		error.status,
		error.$metadata?.httpStatusCode,
		error.$response?.statusCode,
	]) {
		if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status;
	}
	return undefined;
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

// Only supported HTTP display forms carry status. A number elsewhere in an
// error body (e.g. an invalid parameter value of 512) is not HTTP evidence.
export function extractFormattedProviderErrorStatus(message: string): number | undefined {
	const match = message
		.trim()
		.match(
			/^(?:Error:\s*)?(?:(?:OpenAI API error|Azure OpenAI API error) \(([45]\d{2})\):|HTTP(?:\/\d(?:\.\d)?)?(?:\s+(?:status(?: code)?|error))?\s+([45]\d{2})\b|([45]\d{2})(?=:\s*|\s+[{[]|\s+(?:status code|bad request|unauthorized|forbidden|not found|request timeout|conflict|unprocessable entity|too many requests|internal server error|not implemented|bad gateway|service unavailable|gateway timeout|origin timeout)\b))/i,
		);
	return match ? Number(match[1] ?? match[2] ?? match[3]) : undefined;
}

/**
 * Compose a display string with the authoritative HTTP status, when available.
 * Preserve messages that already carry that status/body; otherwise surface the
 * status and body (or message), with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	let formatted: string;
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		formatted =
			prefix !== undefined && norm.status !== undefined
				? `${prefix} (${norm.status}): ${norm.message}`
				: norm.message;
	} else {
		formatted = prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
	}
	// Some SDKs supply status separately even when the message carries the body.
	// Keep that authoritative status available to the outer assistant retry policy.
	if (
		norm.status !== undefined &&
		prefix === undefined &&
		extractFormattedProviderErrorStatus(formatted) !== norm.status
	) {
		const sdkStatusPrefix = `${norm.status} `;
		formatted = `${norm.status}: ${formatted.startsWith(sdkStatusPrefix) ? formatted.slice(sdkStatusPrefix.length) : formatted}`;
	}
	return norm.causeDetails && !formatted.includes(norm.causeDetails)
		? `${formatted} (${norm.causeDetails})`
		: formatted;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
