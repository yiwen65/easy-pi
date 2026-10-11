import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isNetworkAssistantError, isRetryableAssistantError } from "../src/utils/retry.ts";

const unavailableConfig =
	'qoder: model_config for "dfmodel" not yet known (run a model list fetch or check upstream connectivity)';
const wrappedError = JSON.stringify({
	message: `[400]: ${JSON.stringify({ error: { message: unavailableConfig } })}`,
	type: "invalid_request_error",
	code: "bad_request",
});

describe("Qoder model configuration availability", () => {
	it.each([`400: ${wrappedError}`, `OpenAI API error (400): ${wrappedError}`, `400: ${unavailableConfig}`])(
		"retries the captured temporary model configuration error: %s",
		(errorMessage) => {
			const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
			expect(isRetryableAssistantError(message)).toBe(true);
			expect(isNetworkAssistantError(message)).toBe(false);
		},
	);

	it.each([
		`401: ${wrappedError}`,
		`403: ${wrappedError}`,
		`404: ${wrappedError}`,
		`422: ${wrappedError}`,
		'400: qoder: model_config for "dfmodel" is invalid',
		'400: model_config for "dfmodel" not yet known',
		`400: ${wrappedError} insufficient_quota`,
		`400: ${JSON.stringify({ message: "Invalid input", details: unavailableConfig })}`,
		`400: ${JSON.stringify({ error: { type: "authentication_error", message: unavailableConfig } })}`,
		`400: ${JSON.stringify({ error: { code: "invalid_value", message: unavailableConfig } })}`,
	])("keeps permanent failures terminal: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});
});
