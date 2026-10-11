import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { formatProviderError, normalizeProviderError } from "../../../../ai/src/utils/error-body.ts";
import { createHarness } from "../harness.ts";

describe("b824062c permanent provider error retry", () => {
	it.each([
		{ code: "invalid_function_parameters", message: "Invalid schema: properties.timeout must have a type" },
		{ code: "invalid_value", message: "Invalid value: 512" },
	])("makes only one request for a permanent SDK 400: $code", async ({ code, message }) => {
		const error = OpenAI.APIError.generate(
			400,
			{ error: { type: "invalid_request_error", code, message } },
			undefined,
			new Headers(),
		);
		const errorMessage = formatProviderError(normalizeProviderError(error), "OpenAI API error");
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			hfCompaction: { mode: "off" },
		});
		try {
			const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage });
			harness.setResponses([failure, failure, failure]);

			await harness.session.prompt("test permanent request failure");

			expect.soft(harness.faux.state.callCount).toBe(1);
			expect.soft(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect.soft(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
			expect.soft(harness.getPendingResponseCount()).toBe(2);
		} finally {
			harness.cleanup();
		}
	});
});
