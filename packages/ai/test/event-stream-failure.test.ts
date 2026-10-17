import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

function stream() {
	return new EventStream<number, number>(
		(event) => event === 9,
		(event) => event,
	);
}

describe("EventStream producer failure", () => {
	it("drains queued events before rejecting iteration and final result with the original error", async () => {
		const events = stream();
		const error = new Error("producer rejected");
		events.push(1);
		events.push(2);
		events.fail(error);
		events.push(3);
		const iterator = events[Symbol.asyncIterator]();
		expect(await iterator.next()).toEqual({ value: 1, done: false });
		expect(await iterator.next()).toEqual({ value: 2, done: false });
		await expect(iterator.next()).rejects.toBe(error);
		await expect(events.result()).rejects.toBe(error);
	});

	it("rejects every waiting iterator without requiring a result consumer", async () => {
		const events = stream();
		const first = events[Symbol.asyncIterator]().next();
		const second = events[Symbol.asyncIterator]().next();
		const assertions = [expect(first).rejects.toBeUndefined(), expect(second).rejects.toBeUndefined()];
		events.fail(undefined);
		await Promise.all(assertions);
		// Yield through the unhandled-rejection checkpoint; iterator-only consumption must be safe.
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("allows result-only consumers and ignores later failures", async () => {
		const events = stream();
		const error = new Error("first");
		events.fail(error);
		events.fail(new Error("second"));
		events.end(5);
		await expect(events.result()).rejects.toBe(error);
	});

	it.each(["terminal-event", "end"] as const)("does not replace successful %s completion", async (completion) => {
		const events = stream();
		if (completion === "terminal-event") events.push(9);
		else events.end(9);
		events.fail(new Error("too late"));
		expect(await events.result()).toBe(9);
		const seen: number[] = [];
		for await (const event of events) seen.push(event);
		expect(seen).toEqual(completion === "terminal-event" ? [9] : []);
	});
});
