import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { NESTED_CALL_LIMITS, ToolInvocationScope } from "../src/core/nested-tool-calls.ts";

function outcome(index: number, args: Record<string, unknown> = {}): AgentToolCallOutcome {
	return {
		toolCall: { type: "toolCall", id: `parent/${index}`, name: "tool", arguments: args },
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
		executionOutcome: "confirmed",
	};
}

describe("nested invocation scope", () => {
	it("bounds display metadata, not the host calls themselves", async () => {
		const scope = new ToolInvocationScope();
		let calls = 0;
		await Promise.all(
			Array.from({ length: 300 }, (_value, index) =>
				scope.run(async () => {
					calls++;
					return outcome(index);
				}),
			),
		);
		const summary = await scope.finish();
		expect(calls).toBe(300);
		expect(summary.calls?.calls).toHaveLength(NESTED_CALL_LIMITS.maxCalls);
		expect(summary.calls?.complete).toBe(false);
	});
	it("bounds argument bytes individually and across calls", async () => {
		const scope = new ToolInvocationScope();
		await scope.run(async () => outcome(0, { text: "x".repeat(9 * 1024) }));
		await Promise.all(
			Array.from({ length: 8 }, (_value, index) =>
				scope.run(async () => outcome(index + 1, { text: "界".repeat(2000) })),
			),
		);
		const summary = await scope.finish();
		expect(summary.calls?.calls[0].arguments).toBeUndefined();
		expect(summary.calls?.calls[0].argumentsBytes).toBeGreaterThan(8 * 1024);
		const bytes =
			summary.calls?.calls.reduce(
				(total, call) => total + (call.arguments ? Buffer.byteLength(JSON.stringify(call.arguments)) : 0),
				0,
			) ?? 0;
		expect(bytes).toBeLessThanOrEqual(NESTED_CALL_LIMITS.maxArgumentBytesTotal);
		expect(summary.calls?.complete).toBe(false);
	});
	it("poisons caught unknown outcomes independently of presentation isError", async () => {
		const scope = new ToolInvocationScope();
		await scope.run(async () => ({ ...outcome(1), executionOutcome: "unknown" }));
		expect(await scope.drain()).toBe("unknown");
		expect((await scope.finish()).executionOutcome).toBe("unknown");
	});
	it("retains provider-specific nested usage", async () => {
		const scope = new ToolInvocationScope();
		const usage = {
			input: 1,
			output: 2,
			reasoning: 1,
			cacheRead: 3,
			cacheWrite: 4,
			cacheWrite1h: 2,
			totalTokens: 10,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		await scope.run(async () => ({ ...outcome(1), result: { ...outcome(1).result, usage } }));
		await scope.run(async () => ({ ...outcome(2), result: { ...outcome(2).result, usage } }));
		expect((await scope.finish()).usage).toMatchObject({
			input: 2,
			reasoning: 2,
			cacheWrite1h: 4,
			totalTokens: 20,
			cost: { total: 20 },
		});
	});
	it("drains rejected unawaited promises without unhandled rejection or false success", async () => {
		const scope = new ToolInvocationScope();
		void scope.run(async () => {
			throw new Error("host failed");
		});
		const summary = await scope.finish();
		expect(summary.executionOutcome).toBe("unknown");
		expect(scope.isAccepting).toBe(false);
	});
});
