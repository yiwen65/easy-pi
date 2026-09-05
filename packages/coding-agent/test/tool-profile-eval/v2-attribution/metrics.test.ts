import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	assistantMetrics,
	Budget,
	bytes,
	contentFreeWrite,
	LIMITS,
	PayloadMeter,
	pairedLogRatioInterval,
	unionDuration,
} from "./metrics.ts";

const roots: string[] = [];
function temporary(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-attribution-metrics-"));
	roots.push(root);
	return root;
}
function usage(tokens = 100): Usage {
	return {
		input: tokens - 30,
		output: 10,
		cacheRead: 20,
		cacheWrite: 0,
		totalTokens: tokens,
		reasoning: 7,
		cost: { input: 0.01, output: 0.01, cacheRead: 0.001, cacheWrite: 0, total: 0.021 },
	};
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("content-free exclusive attribution", () => {
	it("reconciles disjoint UTF-8 JSON values, structural bytes, and retained history without counting same-request duplicates as retention", () => {
		const meter = new PayloadMeter();
		const payload = {
			model: "example",
			instructions: '公共 "instruction"',
			tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
			input: [
				{ role: "user", content: "alpha" },
				{ role: "user", content: "alpha" },
				{ type: "reasoning", encrypted_content: "opaque" },
				{ type: "function_call", arguments: "{}" },
				{ type: "function_call_output", output: "result" },
				{ role: "assistant", content: "ok" },
				{ role: "developer", content: "other" },
			],
		};
		const first = meter.observe(payload);
		expect(Object.values(first.sections).reduce((a, b) => a + b, 0)).toBe(bytes(payload));
		expect(first.retainedHistoryBytes).toBe(0);
		expect(first.newHistoryBytes).toBe(payload.input.reduce((sum, item) => sum + bytes(item), 0));
		expect(first.toolParameterBytes.read).toBe(bytes(payload.tools[0].parameters));
		const second = meter.observe({ ...payload, input: [...payload.input, { role: "assistant", content: "new" }] });
		expect(second.retainedHistoryBytes).toBe(first.newHistoryBytes);
		expect(second.newHistoryBytes).toBe(bytes({ role: "assistant", content: "new" }));
		expect(first.sections.protocol).toBeGreaterThan(0);
		contentFreeWrite(join(temporary(), "safe.json"), first);
	});
	it("treats reasoning as an output subset and never estimates opaque model thinking from visible summaries", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "ok" },
				{ type: "thinking", thinking: "brief", thinkingSignature: "opaque" },
				{ type: "toolCall", id: "t", name: "read", arguments: { path: "a" } },
			],
			usage: usage(),
		} as AssistantMessage;
		expect(assistantMetrics(message)).toEqual({
			argumentBytes: bytes({ path: "a" }),
			textBytes: 2,
			thinkingSummaryBytes: 5,
			reasoningSignatureBytes: 6,
			toolCalls: 1,
			reportedReasoningTokens: 7,
		});
	});
	it("rejects raw contents, paths and oversized strings", () => {
		for (const value of [{ content: "secret" }, { detail: "/Users/private" }, { detail: "x".repeat(129) }])
			expect(() => contentFreeWrite(join(temporary(), "unsafe.json"), value)).toThrow();
	});
});

describe("durable serialized budget", () => {
	it("reconciles authoritative input/cache/output totals and preserves attempt identity across process-style reloads", () => {
		const path = join(temporary(), "ledger.json");
		const clock = Date.now();
		const budget = new Budget(path, clock);
		budget.start("development-D-11-A-0");
		budget.reserve(400_000, 0.4);
		budget.commit(usage());
		const next = new Budget(path, clock);
		expect(next.tokens).toBe(100);
		expect(next.state.requests).toBe(1);
		expect(() => next.start("development-D-11-A-0")).toThrow("attempt_forbidden");
		expect(() => new Budget(path, clock + 1)).toThrow("clock_changed");
	});
	it("reserves catalog capacity before dispatch, and stops before N+1", () => {
		const budget = new Budget(join(temporary(), "ledger.json"), Date.now());
		budget.state.requests = LIMITS.requests;
		expect(() => budget.reserve(400_000, 0.4)).toThrow("request_budget");
		budget.state.requests = 0;
		budget.state.inputTokens = LIMITS.tokens - 399_999;
		expect(() => budget.reserve(400_000, 0.4)).toThrow("token_budget");
		budget.state.inputTokens = 0;
		budget.state.costUsd = 14.9;
		expect(() => budget.reserve(400_000, 0.4)).toThrow("cost_budget");
		expect(budget.state.requests).toBe(0);
	});
	it("keeps unknown usage pending and permanently prevents subsequent requests", () => {
		const path = join(temporary(), "ledger.json");
		const clock = Date.now();
		const budget = new Budget(path, clock);
		budget.start("probe-base");
		budget.reserve(400_000, 0.4);
		expect(() => budget.commit({ ...usage(), input: Number.NaN })).toThrow("usage_unknown");
		const next = new Budget(path, clock);
		expect(next.state.pending?.tokens).toBe(400_000);
		expect(() => next.reserve(400_000, 0.4)).toThrow("unreconciled_usage");
	});
	it("stops on reservation breach or expired non-resettable clock", () => {
		const budget = new Budget(join(temporary(), "ledger.json"), Date.now());
		budget.reserve(10, 0.4);
		budget.commit(usage());
		expect(budget.state.stop).toBe("reservation_exceeded");
		const expired = new Budget(join(temporary(), "ledger.json"), Date.now() - LIMITS.elapsedMs);
		expect(() => expired.start("probe-base")).toThrow("time_budget");
	});
});

it("separates concurrent tool union from summed durations and uses deterministic paired uncertainty", () => {
	expect(
		unionDuration([
			[0, 10],
			[5, 12],
			[20, 24],
		]),
	).toBe(16);
	expect(
		pairedLogRatioInterval([
			[100, 50],
			[200, 100],
		]),
	).toEqual([Math.log(0.5), Math.log(0.5)]);
	expect(
		pairedLogRatioInterval([
			[100, 50],
			[100, 200],
		])?.[1],
	).toBeGreaterThan(0);
	expect(pairedLogRatioInterval([[100, 50]])).toBeNull();
});
