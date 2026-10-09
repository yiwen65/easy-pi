import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it("reconciles thinking text supplied by an end snapshot", async () => {
		const body = [
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "Partial" },
			{ type: "thinking_end", contentIndex: 0, content: "Complete thinking" },
			{ type: "done", reason: "stop", usage },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.example.com" });
		expect((await stream.result()).content[0]).toMatchObject({ thinking: "Complete thinking" });
	});

	it("preserves tool-call metadata received only on toolcall_end", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test|fc_test", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"hello"}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				itemComplete: true,
				toolCall: {
					type: "toolCall",
					id: "call_test|fc_test",
					name: "lookup",
					arguments: { value: "hello" },
					namespace: "dynamic_tools",
				},
			},
			{ type: "done", reason: "toolUse", usage },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const endEvent = events.find((event) => event.type === "toolcall_end");

		expect(endEvent).toMatchObject({
			type: "toolcall_end",
			itemComplete: true,
			toolCall: { namespace: "dynamic_tools" },
		});
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { value: "hello" },
			namespace: "dynamic_tools",
		});
	});

	it.each(["text", "thinking"] as const)("preserves %s completion markers without inventing them", async (kind) => {
		for (const itemComplete of [true, false, undefined]) {
			const body = [
				{ type: "start" },
				{ type: `${kind}_start`, contentIndex: 0 },
				{ type: `${kind}_delta`, contentIndex: 0, delta: "complete" },
				{ type: `${kind}_end`, contentIndex: 0, itemComplete },
				{ type: "error", reason: "error", errorMessage: "Network connection lost", usage },
			]
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join("");
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body)),
			);
			const stream = streamProxy(
				model,
				{ messages: [] },
				{ authToken: "test", proxyUrl: "https://proxy.example.com" },
			);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			expect(events.find((event) => event.type === `${kind}_end`)).toMatchObject({ itemComplete });
		}
	});

	it("forwards promptCacheKey independently from sessionId", async () => {
		let requestOptions: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requestOptions = JSON.parse(String(init?.body)).options as Record<string, unknown>;
				return new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`, {
					status: 200,
				});
			}),
		);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
				promptCacheKey: "shared-agent-prefix",
				sessionId: "transport-session",
			},
		);
		await stream.result();

		expect(requestOptions?.promptCacheKey).toBe("shared-agent-prefix");
		expect(requestOptions?.sessionId).toBe("transport-session");
	});
});
