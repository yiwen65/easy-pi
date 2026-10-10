import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each<Record<string, string>>([
		{ "retry-after": "not-a-date" },
		{ "retry-after": "Infinity" },
		{ "retry-after": "-Infinity" },
		{ "retry-after": "1e308" },
		{ "retry-after-ms": "Infinity" },
		{ "retry-after-ms": "-Infinity" },
		{ "retry-after-ms": "not-a-number" },
	])("falls back to exponential backoff for invalid Retry-After: %j", async (headers) => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, headers))
			.mockRejectedValueOnce(providerError(429, headers))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 2 }).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(499);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);

		expect(await result).toBe("ok");
		expect(request).toHaveBeenCalledTimes(3);
	});

	it.each<{ headers: Record<string, string>; delayMs: number }>([
		{ headers: { "retry-after": "1.5" }, delayMs: 1500 },
		{ headers: { "retry-after": "Wed, 01 Jan 2025 00:00:02 GMT" }, delayMs: 2000 },
		{ headers: { "retry-after-ms": "Infinity", "retry-after": "1.5" }, delayMs: 1500 },
		{ headers: { "retry-after-ms": "1250", "retry-after": "Infinity" }, delayMs: 1250 },
	])("honors valid Retry-After seconds, dates, and header precedence: %j", async ({ headers, delayMs }) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, headers))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: delayMs }).catch(
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(delayMs - 1);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		expect(await result).toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each<Record<string, string>>([
		{ "retry-after-ms": "2000" },
		{ "retry-after": "2" },
		{ "retry-after": "Wed, 01 Jan 2025 00:00:02 GMT" },
	])("retains the configured cap for valid Retry-After values: %j", async (headers) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, headers));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 2s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps fallback backoff capped and bounded by maxRetries", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
		const error = providerError(429, { "retry-after": "not-a-date" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		const result = retryProviderRequest(request, { maxRetries: 6 }).catch((caught: unknown) => caught);

		for (const [index, delayMs] of [500, 1000, 2000, 4000, 8000, 8000].entries()) {
			await vi.advanceTimersByTimeAsync(delayMs - 1);
			expect(request).toHaveBeenCalledTimes(index + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(request).toHaveBeenCalledTimes(index + 2);
		}

		expect(await result).toBe(error);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts fallback exponential backoff without another request", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
		const controller = new AbortController();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(providerError(429, { "retry-after": "not-a-date" }));
		const result = retryProviderRequest(request, { maxRetries: 2, signal: controller.signal }).catch(
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(100);
		controller.abort();

		expect(await result).toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
