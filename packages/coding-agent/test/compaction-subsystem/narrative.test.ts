import type { Tool } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { generateCompactionItem } from "../../src/core/compaction/subsystem/narrative.ts";
import type { CompactionLLMRequest, CompleteFn } from "../../src/core/compaction/subsystem/types.ts";

const messages = [
	{ role: "user" as const, content: "migrate auth to /src/auth/v2", timestamp: 1 },
	{
		role: "toolResult" as const,
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text" as const, text: "x".repeat(10_000) }],
		details: undefined,
		isError: false,
		timestamp: 2,
	},
];

describe("local Remote V2-style compaction item", () => {
	it("appends a local compaction trigger to the canonical provider prefix", async () => {
		let capturedRequest: CompactionLLMRequest | undefined;
		const complete: CompleteFn = async (request) => {
			capturedRequest = request;
			return { text: "Goal: migrate auth.\nNext: wire the v2 handler.", stopReason: "stop" };
		};
		const tools: Tool[] = [{ name: "read", description: "Read a file", parameters: Type.Object({}) }];

		const result = await generateCompactionItem({
			messages,
			complete,
			systemPrompt: "CURRENT SYSTEM",
			tools,
		});

		expect(result.rejected).toBe(false);
		expect(capturedRequest).toMatchObject({ systemPrompt: "CURRENT SYSTEM", tools });
		expect(capturedRequest?.messages.slice(0, -1).map((message) => message.role)).toEqual(["user", "toolResult"]);
		expect(capturedRequest?.messages.at(-1)).toMatchObject({ role: "user" });
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("local_compaction_trigger");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("latest explicitly stated user goal");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("file paths, symbols, identifiers");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("Later user messages override earlier goals");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("Do not reproduce the system prompt");
		expect(JSON.stringify(capturedRequest?.messages)).not.toContain("<untrusted-history>");
	});

	it("uses an adaptive output ceiling supplied by the checkpoint host", async () => {
		let capturedRequest: CompactionLLMRequest | undefined;
		await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			maxOutputTokens: 512,
			complete: async (request) => {
				capturedRequest = request;
				return { text: "Compacted state", stopReason: "stop" };
			},
		});
		expect(capturedRequest?.maxTokens).toBe(512);
	});

	it("keeps the original provider message structure instead of serializing or clipping it", async () => {
		let capturedRequest: CompactionLLMRequest | undefined;
		await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			complete: async (request) => {
				capturedRequest = request;
				return { text: "Compacted state", stopReason: "stop" };
			},
		});
		expect(capturedRequest?.messages[1]).toEqual(messages[1]);
		expect(JSON.stringify(capturedRequest?.messages[1])).toContain("x".repeat(10_000));
	});

	it("rewrites only tool results when an overflow leaves no room for the local compact request", async () => {
		let capturedRequest: CompactionLLMRequest | undefined;
		await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			messageTokenBudget: 20,
			complete: async (request) => {
				capturedRequest = request;
				return { text: "Compacted state", stopReason: "stop" };
			},
		});
		expect(JSON.stringify(capturedRequest?.messages[1])).toContain("truncated before local compaction");
		expect(JSON.stringify(messages[1])).toContain("x".repeat(10_000));
	});

	it("rejects an empty or failed compactor response without publishing fallback state", async () => {
		const result = await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			complete: async () => ({ text: "", stopReason: "error", errorMessage: "provider failed" }),
		});
		expect(result).toMatchObject({ rejected: true, reason: "provider failed" });
	});
});
