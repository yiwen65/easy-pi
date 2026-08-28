import { describe, expect, test, vi } from "vitest";
import { AGENTPORT_STARTUP_READY_SEQUENCE, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode startup readiness", () => {
	test("flushes the final startup frame before emitting the AgentPort marker", () => {
		const calls: string[] = [];
		const context = {
			ui: {
				renderNow: vi.fn(() => calls.push("render")),
				terminal: {
					write: vi.fn((data: string) => calls.push(data)),
				},
			},
		};
		const signalStartupReady = Reflect.get(InteractiveMode.prototype, "signalStartupReady") as (
			this: typeof context,
		) => void;

		signalStartupReady.call(context);

		expect(calls).toEqual(["render", AGENTPORT_STARTUP_READY_SEQUENCE]);
	});
});
