import type { ConverseStreamMetadataEvent } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	usage: undefined as ConverseStreamMetadataEvent["usage"],
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = { add: () => undefined };

		async send(): Promise<unknown> {
			return {
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "Thinking" } } } };
					yield {
						contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "signature" } } },
					};
					yield { contentBlockStop: { contentBlockIndex: 0 } };
					yield { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "Hi" } } };
					yield { contentBlockStop: { contentBlockIndex: 1 } };
					yield { metadata: { usage: bedrockMock.usage } };
					yield { messageStop: { stopReason: "end_turn" } };
				})(),
			};
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { FIVE_MINUTES: "5m", ONE_HOUR: "1h" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { Context, Model } from "../src/types.ts";

// Synthetic rates keep this regression independent of catalog updates.
const model: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-cache-cost-test",
	name: "Claude cache cost test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 200_000,
	maxTokens: 4096,
};
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
const usage: NonNullable<ConverseStreamMetadataEvent["usage"]> = {
	inputTokens: 100,
	outputTokens: 5,
	cacheReadInputTokens: 200,
	cacheWriteInputTokens: 1_000_000,
	totalTokens: 1_000_305,
};

async function runBedrock(nextUsage: NonNullable<ConverseStreamMetadataEvent["usage"]>) {
	bedrockMock.usage = nextUsage;
	return streamBedrock(model, context, {
		cacheRetention: "none",
		region: "us-east-1",
		env: {
			AWS_ACCESS_KEY_ID: "dummy-access-key",
			AWS_SECRET_ACCESS_KEY: "dummy-secret-key",
			AWS_SESSION_TOKEN: "",
			AWS_PROFILE: "",
		},
	}).result();
}

describe("Bedrock 1h cache write cost", () => {
	it("sums 1h details without changing total cache writes, usage or reasoning content", async () => {
		const result = await runBedrock({
			...usage,
			cacheDetails: [
				{ ttl: "1h", inputTokens: 150_000 },
				{ ttl: "5m", inputTokens: 600_000 },
				{ ttl: "1h", inputTokens: 250_000 },
				{ ttl: "1h", inputTokens: undefined },
				{ ttl: undefined, inputTokens: 123 },
			],
		});

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "Thinking", thinkingSignature: "signature" },
			{ type: "text", text: "Hi" },
		]);
		expect(result.usage).toMatchObject({ input: 100, output: 5, cacheRead: 200, cacheWrite: 1_000_000 });
		expect(result.usage.totalTokens).toBe(1_000_305);
		expect(result.usage.cacheWrite1h).toBe(400_000);
		// 600k * 6.25/Mtok + 400k * 10/Mtok = 7.75; 1h tokens are a subset, not extra usage.
		expect(result.usage.cost.cacheWrite).toBeCloseTo(7.75, 10);
		expect(result.usage.cost.input).toBeCloseTo(0.0005, 10);
		expect(result.usage.cost.output).toBeCloseTo(0.000125, 10);
		expect(result.usage.cost.cacheRead).toBeCloseTo(0.0001, 10);
		expect(result.usage.cost.total).toBeCloseTo(7.750725, 10);
	});

	it.each([
		{ label: "absent", cacheDetails: undefined },
		{ label: "empty", cacheDetails: [] },
		{ label: "5m-only", cacheDetails: [{ ttl: "5m" as const, inputTokens: 1_000_000 }] },
	])("uses the 5m rate for $label cache details", async ({ cacheDetails }) => {
		const result = await runBedrock({ ...usage, cacheDetails, totalTokens: undefined });

		expect(result.stopReason).toBe("stop");
		expect(result.usage).toMatchObject({ input: 100, output: 5, cacheRead: 200, cacheWrite: 1_000_000 });
		expect(result.usage.cacheWrite1h ?? 0).toBe(0);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(6.25, 10);
		// Preserve Bedrock's existing input + output fallback when totalTokens is absent.
		expect(result.usage.totalTokens).toBe(105);
	});
});
