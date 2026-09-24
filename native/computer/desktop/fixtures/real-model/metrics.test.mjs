import assert from "node:assert/strict";
import test from "node:test";
import { providerFailure, summarize } from "./metrics.mjs";

test("provider failures retain categories, never arbitrary credential-bearing payloads", () => {
	assert.equal(providerFailure("403 https://user:secret@example.test?key=private"), "provider_access_denied");
	assert.equal(providerFailure("WebSocket error token=private"), "provider_websocket_error");
	assert.equal(providerFailure("UND_ERR_CONNECT_TIMEOUT"), "provider_connect_timeout");
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
