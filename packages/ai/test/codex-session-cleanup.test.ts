import { afterEach, expect, test, vi } from "vitest";
import {
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Model } from "../src/types.ts";

afterEach(() => {
	cleanupSessionResources();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
});

test("native session cleanup clears its Codex counters and fallback marker without affecting another session", async () => {
	let connections = 0;
	vi.stubGlobal(
		"WebSocket",
		class {
			constructor() {
				connections++;
				throw new Error("synthetic offline connection failure");
			}
		},
	);
	const model: Model<"openai-codex-responses"> = {
		id: "cleanup-probe",
		name: "Cleanup probe",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } }),
	).toString("base64");
	const apiKey = `aaa.${payload}.bbb`;
	const fetch = vi.fn(
		async () =>
			new Response(
				'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
			),
	);
	const run = (sessionId: string) =>
		stream(
			model,
			{ messages: [{ role: "user", content: "probe", timestamp: 1 }] },
			{
				apiKey,
				sessionId,
				transport: "auto",
				fetch,
				env: {},
			},
		).result();
	await run("disposed-child");
	await run("surviving-root");
	expect(connections).toBe(2);
	expect(getOpenAICodexWebSocketDebugStats("disposed-child")?.websocketFallbackActive).toBe(true);
	const rootStats = getOpenAICodexWebSocketDebugStats("surviving-root");
	cleanupSessionResources("disposed-child");
	expect(getOpenAICodexWebSocketDebugStats("disposed-child")).toBeUndefined();
	expect(getOpenAICodexWebSocketDebugStats("surviving-root")).toEqual(rootStats);
	await run("disposed-child");
	expect(connections).toBe(3);
	cleanupSessionResources();
	expect(getOpenAICodexWebSocketDebugStats("disposed-child")).toBeUndefined();
	expect(getOpenAICodexWebSocketDebugStats("surviving-root")).toBeUndefined();
});
