import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../../../../../packages/agent/dist/index.js";
import { createAssistantMessageEventStream } from "../../../../../packages/ai/dist/utils/event-stream.js";
import { createRequestMeter, meteredStream, providerFailure, summarize } from "./metrics.mjs";

test("real Agent invocation stops before request 25 and never counts the synthetic error twice", async () => {
	const meter = createRequestMeter();
	let calls = 0;
	let toolCalls = 0;
	const errors = [];
	const model = {
		id: "local-budget-fixture",
		name: "Local budget fixture",
		provider: "fixture",
		api: "openai-responses",
		reasoning: false,
		input: ["text"],
		contextWindow: 100000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const backend = (_model, _context, options) => {
		calls++;
		assert.ok(calls <= 24);
		assert.equal(options.maxTokens, 2048);
		assert.equal(options.maxRetries, 0);
		assert.equal(options.timeoutMs, 30_000);
		assert.equal(options.websocketConnectTimeoutMs, 15_000);
		const stream = createAssistantMessageEventStream();
		const message = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "toolCall", id: `call-${calls}`, name: "next", arguments: { turn: calls } }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		stream.push({ type: "done", reason: "toolUse", message });
		return stream;
	};
	const agent = new Agent({
		streamFn: backend,
		initialState: {
			model,
			tools: [
				{
					name: "next",
					label: "Next",
					description: "Local fixture only",
					parameters: {
						type: "object",
						properties: { turn: { type: "integer" } },
						required: ["turn"],
						additionalProperties: false,
					},
					async execute() {
						toolCalls++;
						return { content: [{ type: "text", text: "Continue" }], details: {} };
					},
				},
			],
		},
	});
	agent.streamFunction = meteredStream(agent.streamFunction, meter, () => 0);
	agent.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			meter.finish();
			if (event.message.stopReason === "error") errors.push(event.message.errorMessage);
		}
	});
	await agent.prompt("Run the local tool until the request budget stops you.");
	assert.equal(calls, 24);
	assert.equal(toolCalls, 24);
	assert.equal(meter.turns, 24);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /Model budget exhausted/);
	assert.equal(providerFailure(errors[0]), "model_budget_exhausted");
	assert.ok(meter.modelMs >= 0);
});

test("request admission bounds real invocations and counts each interval once", () => {
	let now = 100;
	const meter = createRequestMeter(() => now);
	for (let i = 0; i < 24; i++) {
		meter.start(0);
		now += 10;
		meter.finish();
		meter.finish();
	}
	assert.throws(() => meter.start(0), /budget exhausted/);
	now += 1000;
	meter.finish(); // synthetic failure with no admitted request
	assert.equal(meter.turns, 24);
	assert.equal(meter.modelMs, 240);
	assert.deepEqual(meter.requestMs, Array(24).fill(10));
	const copied = meter.requestMs;
	copied.push(1000);
	assert.equal(meter.requestMs.length, 24);
	const expensive = createRequestMeter(() => now);
	assert.throws(() => expensive.start(10), /budget exhausted/);
	assert.equal(expensive.turns, 0);
});

test("provider failures retain categories, never arbitrary credential-bearing payloads", () => {
	assert.equal(providerFailure("403 https://user:secret@example.test?key=private"), "provider_access_denied");
	assert.equal(providerFailure("WebSocket error token=private"), "provider_websocket_error");
	assert.equal(providerFailure("UND_ERR_CONNECT_TIMEOUT"), "provider_connect_timeout");
	assert.equal(providerFailure("WebSocket idle timeout after 30000ms token=private"), "provider_idle_timeout");
	assert.equal(providerFailure("arbitrary secret"), "provider_error");
	assert.equal(providerFailure(undefined), undefined);
});

const success = { id: "task", passed: true, cleanup: true, taskMs: 100, cost: 0.1 };
test("all failures and their cost remain in denominator", () => {
	const result = summarize([success, { id: "failed", passed: false, cleanup: true, cost: 0.2 }]);
	assert.equal(result.attempts, 2);
	assert.equal(result.passed, 1);
	assert.equal(result.failures[0].id, "failed");
	assert.ok(Math.abs(result.reportedCostUSD - 0.3) < 1e-9);
	assert.deepEqual(result.successTaskMs, { p50: 100, p95: 100, samples: 1 });
});
test("no success has no fabricated latency", () => {
	assert.equal(summarize([{ passed: false, cost: 0, cleanup: false }]).successTaskMs.p50, null);
});
test("success must have timing, cleanup and no interruption", () => {
	for (const patch of [{ cleanup: false }, { interrupted: true }, { failure: {} }, { taskMs: NaN }, { cost: -1 }]) {
		assert.throws(() => summarize([{ ...success, ...patch }]));
	}
	assert.throws(() => summarize([]));
});
