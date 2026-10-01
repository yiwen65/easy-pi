import assert from "node:assert/strict";

export function meteredStream(stream, meter, reportedCost) {
	return (model, context, options) => {
		meter.start(reportedCost());
		return stream(model, context, {
			...options,
			maxTokens: 2048,
			maxRetries: 0,
			timeoutMs: 30_000,
			websocketConnectTimeoutMs: 15_000,
		});
	};
}

export function createRequestMeter(now = () => performance.now()) {
	let turns = 0;
	let modelMs = 0;
	const requestMs = [];
	let started;
	return {
		start(reportedCost) {
			assert.ok(turns < 24 && reportedCost < 10, "Model budget exhausted");
			assert.equal(started, undefined, "Overlapping model request");
			turns++;
			started = now();
		},
		finish() {
			if (started !== undefined) {
				const duration = now() - started;
				modelMs += duration;
				requestMs.push(duration);
				started = undefined;
			}
		},
		get turns() {
			return turns;
		},
		get modelMs() {
			return modelMs;
		},
		get requestMs() {
			return [...requestMs];
		},
	};
}

export function providerFailure(message) {
	if (!message) return undefined;
	if (message === "Model budget exhausted") return "model_budget_exhausted";
	if (/UND_ERR_CONNECT_TIMEOUT|connect.*timed? ?out/i.test(message)) return "provider_connect_timeout";
	if (/WebSocket idle timeout|UND_ERR_BODY_TIMEOUT|body timeout/i.test(message)) return "provider_idle_timeout";
	if (/websocket/i.test(message)) return "provider_websocket_error";
	if (/\b(?:401|403)\b/.test(message)) return "provider_access_denied";
	return "provider_error";
}

export function summarize(samples) {
	assert.ok(Array.isArray(samples) && samples.length > 0, "No attempts");
	for (const row of samples) {
		assert.equal(typeof row.passed, "boolean");
		assert.ok(Number.isFinite(row.cost) && row.cost >= 0, "Invalid reported cost");
		if (row.passed) {
			assert.equal(row.cleanup, true, "Success requires proved cleanup");
			assert.ok(!row.failure && !row.interrupted, "Interrupted attempt cannot pass");
			assert.ok(Number.isFinite(row.taskMs) && row.taskMs >= 0, "Invalid successful duration");
		}
	}
	const success = samples.filter((row) => row.passed);
	const sorted = success.map((row) => row.taskMs).sort((a, b) => a - b);
	const percentile = (p) => (sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null);
	return {
		attempts: samples.length,
		passed: success.length,
		failed: samples.length - success.length,
		cleanupUnproved: samples.filter((row) => !row.cleanup).length,
		reportedCostUSD: samples.reduce((sum, row) => sum + row.cost, 0),
		successTaskMs: { p50: percentile(0.5), p95: percentile(0.95), samples: sorted.length },
		failures: samples
			.filter((row) => !row.passed)
			.map(({ id, failure, interrupted, taskMs, attemptMs }) => ({ id, failure, interrupted, taskMs, attemptMs })),
	};
}
