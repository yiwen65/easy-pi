import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/google-generative-ai.ts";
import type { Model } from "../src/types.ts";

const { constructedHeaders } = vi.hoisted(() => ({ constructedHeaders: vi.fn() }));
vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		constructor(options: { httpOptions?: { headers?: Record<string, string> } }) {
			constructedHeaders(options.httpOptions?.headers);
		}
		models = {
			async *generateContentStream() {
				yield { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }] };
			},
		};
	},
	FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
	FinishReason: { STOP: "STOP" },
}));

const model: Model<"google-generative-ai"> = {
	id: "gemini-test",
	name: "Test",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 32000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	headers: { "X-Tenant": "old", "X-Keep": "yes" },
};

afterEach(() => vi.clearAllMocks());

describe("Google header overrides", () => {
	it.each([null, "new"])("applies a case-variant override %s before SDK conversion", async (value) => {
		const result = await stream(
			model,
			{ messages: [] },
			{ apiKey: "synthetic", headers: { "x-tenant": value } },
		).result();
		expect(result.stopReason).toBe("stop");
		const headers = constructedHeaders.mock.calls[0][0] as Record<string, string>;
		expect(Object.keys(headers).filter((key) => key.toLowerCase() === "x-tenant")).toHaveLength(
			value === null ? 0 : 1,
		);
		expect(new Headers(headers).get("x-tenant")).toBe(value);
		expect(new Headers(headers).get("x-keep")).toBe("yes");
	});
});
