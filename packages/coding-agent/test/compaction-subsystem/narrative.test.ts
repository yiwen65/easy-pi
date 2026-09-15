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

/** A handoff that satisfies validateCompactionSummary(): structured, and long enough to be credible. */
const compliantHandoff = [
	"## Conversation timeline",
	"User asked to migrate auth to /src/auth/v2; the assistant read the handler and confirmed the v2 layout.",
	"",
	"## Current continuation point",
	"Primary objective: finish the auth migration. Next concrete action: wire the v2 handler and re-run tests.",
].join("\n");

describe("local Remote V2-style compaction item", () => {
	it("appends a local compaction trigger to the canonical provider prefix", async () => {
		let capturedRequest: CompactionLLMRequest | undefined;
		const complete: CompleteFn = async (request) => {
			capturedRequest = request;
			return { text: compliantHandoff, stopReason: "stop" };
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
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("active goal hierarchy");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("primary objectives");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("process objectives");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("user-led causal episodes");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("source order");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("user request -> assistant and tool work");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("previous compaction summary");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("file paths, symbols, identifiers");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain(
			"Do not copy raw Search, Read, or Edit source snippets",
		);
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("bounded live-evidence section");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("conflicts with it at the same scope");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("fixed handoff length");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("Current continuation point");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("machine-readable contract, ledger, JSON");
		expect(JSON.stringify(capturedRequest?.messages.at(-1))).toContain("Do not reproduce the system prompt");
		expect(JSON.stringify(capturedRequest?.messages)).not.toContain("<untrusted-history>");
		expect(capturedRequest?.promptVersion).toBe("remote-v2-local-5");
	});

	it("does not impose a fixed output ceiling on the handoff", async () => {
		let capturedRequest: CompactionLLMRequest | undefined;
		await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			complete: async (request) => {
				capturedRequest = request;
				return { text: "Compacted state", stopReason: "stop" };
			},
		});
		expect(capturedRequest).not.toHaveProperty("maxTokens");
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

	it("rewrites only tool results when the trimmed history fits the local compact budget", async () => {
		let capturedRequest: CompactionLLMRequest | undefined;
		await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			messageTokenBudget: 200,
			complete: async (request) => {
				capturedRequest = request;
				return { text: compliantHandoff, stopReason: "stop" };
			},
		});
		expect(JSON.stringify(capturedRequest?.messages[1])).toContain("truncated before local compaction");
		expect(JSON.stringify(messages[1])).toContain("x".repeat(10_000));
	});

	it("fails closed instead of sending a history that cannot fit the local compact budget", async () => {
		let completeCalled = false;
		const result = await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			messageTokenBudget: 20,
			complete: async () => {
				completeCalled = true;
				return { text: compliantHandoff, stopReason: "stop" };
			},
		});
		expect(completeCalled).toBe(false);
		expect(result.rejected).toBe(true);
		expect(result.text).toBe("");
		expect(result.reason).toContain("cannot fit the model context");
		expect(JSON.stringify(messages[1])).toContain("x".repeat(10_000));
	});

	it("still attempts the request when the fixed costs alone exhaust the budget", async () => {
		let capturedRequest: CompactionLLMRequest | undefined;
		const result = await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			messageTokenBudget: 0,
			complete: async (request) => {
				capturedRequest = request;
				return { text: compliantHandoff, stopReason: "stop" };
			},
		});
		expect(result.rejected).toBe(false);
		// Tool results are still rewritten; the request simply cannot be made to fit, so the summary
		// gates decide whether the answer may replace the branch.
		expect(JSON.stringify(capturedRequest?.messages[1])).toContain("truncated before local compaction");
	});

	it("rejects an empty or failed compactor response without publishing fallback state", async () => {
		const result = await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			complete: async () => ({ text: "", stopReason: "error", errorMessage: "provider failed" }),
		});
		expect(result).toMatchObject({ rejected: true, reason: "provider failed" });
	});

	it("rejects a degenerate one-character handoff that a truncated provider returned as stop", async () => {
		const result = await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			complete: async () => ({ text: "#", stopReason: "stop", usage: { input: 763_998, output: 1 } }),
		});
		expect(result.rejected).toBe(true);
		expect(result.text).toBe("");
		expect(result.reason).toContain("degenerate");
		expect(result.modelUsage).toEqual({ input: 763_998, output: 1 });
	});

	it("rejects a short unstructured handoff once the history is large enough to matter", async () => {
		const largeHistory = [{ role: "user" as const, content: "x".repeat(100_000), timestamp: 1 }];
		const result = await generateCompactionItem({
			messages: largeHistory,
			systemPrompt: "CURRENT SYSTEM",
			complete: async () => ({ text: "plausible but unstructured handoff. ".repeat(8), stopReason: "stop" }),
		});
		expect(result.rejected).toBe(true);
		expect(result.reason).toContain("required section");
	});

	it("accepts a terse handoff when the history it replaces is small", async () => {
		const result = await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			complete: async () => ({ text: "Preserve the post-tool task state.", stopReason: "stop" }),
		});
		expect(result.rejected).toBe(false);
	});

	it("accepts a long handoff that omits the prescribed sections", async () => {
		const result = await generateCompactionItem({
			messages,
			systemPrompt: "CURRENT SYSTEM",
			complete: async () => ({ text: "unstructured but substantive handoff. ".repeat(40), stopReason: "stop" }),
		});
		expect(result.rejected).toBe(false);
	});

	it("rejects a structured handoff that is implausibly small for the history it replaces", async () => {
		const largeHistory = [{ role: "user" as const, content: "x".repeat(200_000), timestamp: 1 }];
		const result = await generateCompactionItem({
			messages: largeHistory,
			systemPrompt: "CURRENT SYSTEM",
			complete: async () => ({
				// ~198 chars: above the absolute floor and structured, yet far below the ~400 chars
				// (0.2% of the 50k-token history) that a credible handoff would need.
				text: `## Conversation timeline\n${"one episode. ".repeat(10)}\n## Current continuation point\nnext action.`,
				stopReason: "stop",
			}),
		});
		expect(result.rejected).toBe(true);
		expect(result.reason).toContain("implausibly small");
	});
});
