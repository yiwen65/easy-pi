import { afterEach, expect, test, vi } from "vitest";
import { CollaborationMailboxActivity } from "../src/collaboration-mailbox.ts";

afterEach(() => vi.useRealTimers());

test("wait observes mail before or after subscription without losing a wakeup", async () => {
	const activity = new CollaborationMailboxActivity();
	let pending = true;
	expect(await activity.wait("/root", () => pending)).toEqual({ reason: "mailbox", timed_out: false });
	pending = false;
	const wait = activity.wait("/root", () => pending);
	pending = true;
	activity.notify("/root");
	expect(await wait).toEqual({ reason: "mailbox", timed_out: false });
	activity.close();
});

test("user input takes priority over mailbox activity and is explicitly consumed", async () => {
	const activity = new CollaborationMailboxActivity();
	const wait = activity.wait("/root", () => true);
	activity.notifyUserInput("/root");
	expect(await wait).toEqual({ reason: "user_input", timed_out: false });
	activity.consumeUserInput("/root");
	expect(await activity.wait("/root", () => true)).toEqual({ reason: "mailbox", timed_out: false });
	activity.close();
});

test("timeout and cancelled waits release their subscription without cancelling tasks", async () => {
	vi.useFakeTimers();
	const activity = new CollaborationMailboxActivity();
	const first = activity.wait("/root", () => false, 0);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(await first).toEqual({ reason: "timeout", timed_out: true });
	const abort = new AbortController();
	const cancelled = activity.wait("/root", () => false, undefined, abort.signal);
	const rejected = expect(cancelled).rejects.toThrow(/interrupted/);
	abort.abort();
	await rejected;
	expect(await activity.wait("/root", () => true)).toMatchObject({ reason: "mailbox" });
	expect(vi.getTimerCount()).toBe(0);
	activity.close();
});

test("one waiter per agent; shutdown rejects rather than fabricating timeout", async () => {
	const activity = new CollaborationMailboxActivity();
	const first = activity.wait("/root", () => false);
	const rejected = expect(first).rejects.toThrow(/interrupted/);
	await expect(activity.wait("/root", () => false)).rejects.toThrow(/already waiting/);
	activity.close();
	await rejected;
	await expect(activity.wait("/root", () => true)).rejects.toThrow(/interrupted/);
});
