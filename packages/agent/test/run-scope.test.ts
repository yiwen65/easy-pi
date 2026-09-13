import { describe, expect, it } from "vitest";
import { RunScope } from "../src/run-scope.ts";

describe("RunScope", () => {
	it("does not admit effects after cancellation and settles once", async () => {
		const scope = new RunScope({ runId: "run-1", generation: 1 });
		scope.activate();

		expect(scope.canAdmit()).toBe(true);
		scope.requestCancel();
		expect(scope.signal.aborted).toBe(true);
		expect(scope.canAdmit()).toBe(false);

		let settled = false;
		const settledPromise = scope.waitForSettled().then(() => {
			settled = true;
		});
		scope.settle();
		scope.settle();
		await settledPromise;

		expect(settled).toBe(true);
		expect(scope.state).toBe("settled");
	});

	it("rejects a stale generation without changing the active scope", () => {
		const scope = new RunScope({ runId: "run-2", generation: 4 });
		scope.activate();

		expect(scope.canAdmit(3)).toBe(false);
		expect(scope.canAdmit(4)).toBe(true);
		expect(scope.state).toBe("active");
	});
});
