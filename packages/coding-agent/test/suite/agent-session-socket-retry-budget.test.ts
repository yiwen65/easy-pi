import { createServer } from "node:http";
import type { FetchFunction, Model } from "@earendil-works/pi-ai";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { Agent as HttpAgent, fetch as httpFetch } from "undici";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

const socketError = "terminated (UND_ERR_SOCKET: other side closed)";
const token = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-retry-test" } }),
).toString("base64")}.bbb`;
const sse = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

const cases = [
	{ name: "normal completion", budget: 2, disabled: false, disconnects: 0, calls: 1, failures: 0 },
	{ name: "recovery within budget", budget: 2, disabled: false, disconnects: 1, calls: 2, failures: 1 },
	{ name: "custom budget exhaustion", budget: 2, disabled: false, disconnects: 3, calls: 3, failures: 3 },
	{ name: "zero budget", budget: 0, disabled: false, disconnects: 1, calls: 1, failures: 1 },
	{ name: "disabled recovery", budget: 2, disabled: true, disconnects: 1, calls: 1, failures: 1 },
	{ name: "default ten retries", budget: undefined, disabled: false, disconnects: 12, calls: 11, failures: 11 },
];

describe("AgentSession real HTTP socket retry budget", () => {
	it.each(cases)("$name", async ({ budget, disabled, disconnects, calls, failures }) => {
		let requestCount = 0;
		const server = createServer((request, response) => {
			requestCount++;
			request.resume();
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.flushHeaders();
			const reasoning = {
				type: "reasoning",
				id: "local_reasoning",
				summary: [],
				content: [],
			};
			response.write(sse({ type: "response.output_item.added", output_index: 0, item: reasoning }));
			response.write(
				sse({
					type: "response.output_item.done",
					output_index: 0,
					item: { ...reasoning, encrypted_content: "synthetic-reasoning-not-a-secret" },
				}),
			);
			const interrupted = requestCount <= disconnects;
			const timer = setTimeout(() => {
				if (interrupted) {
					request.socket.destroy();
					return;
				}
				response.write(
					sse({
						type: "response.output_item.added",
						output_index: 1,
						item: { type: "message", id: "local_message", role: "assistant", content: [] },
					}),
				);
				response.write(sse({ type: "response.output_text.delta", output_index: 1, delta: "recovered" }));
				response.write(
					sse({
						type: "response.output_item.done",
						output_index: 1,
						item: {
							type: "message",
							id: "local_message",
							role: "assistant",
							content: [{ type: "output_text", text: "recovered" }],
						},
					}),
				);
				response.end(
					sse({
						type: "response.completed",
						response: {
							id: "local_response",
							status: "completed",
							usage: {
								input_tokens: 1,
								output_tokens: 10,
								total_tokens: 11,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				);
			}, 10);
			response.on("close", () => clearTimeout(timer));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener");
		const dispatcher = new HttpAgent({ allowH2: false, headersTimeout: 5000, bodyTimeout: 5000 });
		const localFetch: FetchFunction = async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			expect(url.hostname).toBe("127.0.0.1");
			expect(url.port).toBe(String(address.port));
			const headers = init?.headers;
			const body = init?.body;
			if (!(headers instanceof Headers) || (typeof body !== "string" && !(body instanceof Uint8Array))) {
				throw new Error("Unexpected local Codex request shape");
			}
			const response = await httpFetch(url, {
				method: init?.method,
				headers: Object.fromEntries(headers.entries()),
				body,
				signal: init?.signal,
				dispatcher,
			});
			// npm undici and Node's fetch expose different Response/File types.
			// Preserve the live body stream, including its socket-error rejection.
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: Object.fromEntries(response.headers.entries()),
			});
		};
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "Local socket test",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		};
		const harness = await createHarness({
			tools: [],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: !disabled, maxRetries: budget, baseDelayMs: 0 } },
		});
		const sessionId = harness.session.sessionId;
		harness.setResponses(
			Array.from({ length: calls + 1 }, () => async (context, options) => {
				expect(
					context.messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
				).toBe(false);
				return streamCodex(model, context, {
					apiKey: token,
					transport: "sse",
					fetch: localFetch,
					signal: options?.signal,
					timeoutMs: 5000,
					maxRetries: 0,
				}).result();
			}),
		);

		try {
			await harness.session.prompt("Local socket retry diagnostic only");
			await harness.session.waitForIdle();
			const assistants = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
				);
			const errors = assistants.filter((message) => message.stopReason === "error");
			expect(requestCount).toBe(calls);
			expect(harness.faux.state.callCount).toBe(calls);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(assistants).toHaveLength(calls);
			expect(errors).toHaveLength(failures);
			expect(errors.every((message) => message.errorMessage === socketError)).toBe(true);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(calls - 1);
			expect(assistants.at(-1)?.stopReason).toBe(failures === calls ? "error" : "stop");
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.agent.state.isStreaming).toBe(false);
			expect(harness.session.sessionId).toBe(sessionId);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		} finally {
			await harness.session.abort();
			harness.cleanup();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await dispatcher.close();
		}
	});
});
