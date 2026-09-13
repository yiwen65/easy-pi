import { describe, expect, it } from "vitest";
import { ResourceScheduler } from "../src/resource-scheduler.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("ResourceScheduler", () => {
	it("bounds execution and releases a shared resource lease", async () => {
		const scheduler = new ResourceScheduler(1);
		const first = await scheduler.acquire({ key: "workspace", mode: "exclusive" });
		const second = scheduler.acquire({ key: "workspace", mode: "shared" });
		let secondStarted = false;
		void second.then((lease) => {
			secondStarted = lease !== undefined;
			lease?.release();
		});

		expect(scheduler.runningCount).toBe(1);
		expect(secondStarted).toBe(false);
		first?.release();
		await Promise.resolve();
		expect(secondStarted).toBe(true);
		expect(scheduler.pendingCount).toBe(0);
	});

	it("cancels a queued waiter without consuming a slot", async () => {
		const scheduler = new ResourceScheduler(1);
		const first = await scheduler.acquire();
		const controller = new AbortController();
		const waiting = scheduler.acquire({}, controller.signal);
		controller.abort();

		expect(await waiting).toBeUndefined();
		expect(scheduler.pendingCount).toBe(0);
		first?.release();
	});

	it("allows independent shared keys to overlap", async () => {
		const scheduler = new ResourceScheduler(2);
		const release = deferred();
		const first = await scheduler.acquire({ key: "a", mode: "shared" });
		const second = await scheduler.acquire({ key: "a", mode: "shared" });
		expect(scheduler.runningCount).toBe(2);
		release.resolve();
		await release.promise;
		first?.release();
		second?.release();
		expect(scheduler.runningCount).toBe(0);
	});
});
