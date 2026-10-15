import { zstdDecompressSync } from "node:zlib";
import type { Model } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { streamSimple } from "../../ai/src/api/openai-codex-responses.ts";
import { CompactionDiagnostics } from "../src/core/compaction/subsystem/observability.ts";
import { createPiAiCompleteFn } from "../src/core/compaction/subsystem/session-integration.ts";

it.each(
	(["low", "high", "off"] as const).flatMap((thinkingLevel) =>
		([undefined, "default", "fast"] as const).map((serviceTier) => ({ thinkingLevel, serviceTier })),
	),
)(
	"sends inherited $thinkingLevel reasoning and $serviceTier tier without losing Codex cache routing",
	async ({ thinkingLevel, serviceTier }) => {
		const model: Model<"openai-codex-responses"> = {
			id: "synthetic-compactor",
			name: "Synthetic Compactor",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://example.invalid",
			reasoning: true,
			thinkingLevelMap: { off: null, low: "low", high: "high" },
			input: ["text"],
			contextWindow: 100_000,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const apiKey = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64")}.test`;
		const text = "Preserved the task and next action.";
		let body: Record<string, unknown> | undefined;
		let headers: Headers | undefined;
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			headers = new Headers(init?.headers);
			const raw = init?.body;
			body = JSON.parse(typeof raw === "string" ? raw : zstdDecompressSync(raw as Uint8Array).toString());
			const events = [
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: text },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_test",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_test",
						status: "completed",
						usage: {
							input_tokens: 100,
							output_tokens: 20,
							total_tokens: 120,
							input_tokens_details: { cached_tokens: 80 },
							output_tokens_details: { reasoning_tokens: 4 },
						},
					},
				},
			];
			return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const diagnostics = new CompactionDiagnostics();
		const complete = createPiAiCompleteFn({
			model,
			thinkingLevel,
			serviceTier,
			apiKey,
			sessionId: "synthetic-session",
			cacheAffinityId: "parent-cache-affinity",
			promptCacheKey: "shared-prefix",
			diagnostics,
			streamFn: (requestModel, context, options) =>
				streamSimple(requestModel as Model<"openai-codex-responses">, context, {
					...options,
					transport: "sse",
					fetch,
				}),
		});
		const result = await complete({
			systemPrompt: "policy",
			messages: [{ role: "user", content: "history", timestamp: 1 }],
			promptVersion: "test",
		});
		expect(body).toMatchObject({
			model: model.id,
			tool_choice: "none",
			prompt_cache_key: "shared-prefix",
		});
		if (serviceTier === undefined) expect(body).not.toHaveProperty("service_tier");
		else expect(body?.service_tier).toBe(serviceTier === "fast" ? "priority" : "default");
		if (thinkingLevel === "off") expect(body).not.toHaveProperty("reasoning");
		else expect(body).toMatchObject({ reasoning: { effort: thinkingLevel } });
		expect(headers?.get("session-id")).toBe("parent-cache-affinity");
		expect(headers?.get("x-client-request-id")).toBe("synthetic-session");
		expect(body).not.toHaveProperty("previous_response_id");
		expect(body).not.toHaveProperty("max_output_tokens");
		expect(result).toMatchObject({ stopReason: "stop", text });
		expect(fetch).toHaveBeenCalledOnce();
		expect(diagnostics.finish("manual", "activated").attempts[0]).toMatchObject({
			reasoning: thinkingLevel,
			usage: { input: 20, output: 20, cacheRead: 80, reasoning: 4 },
		});
	},
);
