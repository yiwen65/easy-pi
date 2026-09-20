import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { ActionEffect } from "@trycua/cua-driver";
import { type NativeCall, NativeComputerAdapter, type NativeDriver, type OwnedNativeDriver } from "../adapter.ts";

type Observation = Awaited<ReturnType<NativeDriver["getWindowState"]>>;
type ClickResult = Awaited<ReturnType<NativeDriver["click"]>>;

const input: Parameters<NativeDriver["getWindowState"]>[0] = {
	pid: 42,
	windowId: 9_007_199_254_740_993n,
	includeAccessibilityTree: true,
	includeScreenshot: false,
};
const observation: Observation = {
	pid: input.pid,
	windowId: input.windowId,
	snapshotId: "mock-snapshot",
	images: [],
	degraded: true,
	truncated: true,
};
// Opaque identity fixture only: constructing/encoding generated unions requires
// SDK value imports. This test never passes this marker into a real binding.
const clickInput = Object.freeze({ fixture: "click-input" }) as unknown as Parameters<NativeDriver["click"]>[0];
// The generated declaration assigns Unverifiable = 2; no SDK enum is imported at runtime.
const unconfirmed: ClickResult & { effect: ActionEffect.Unverifiable } = { effect: 2, route: 0 };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function fixture() {
	const events: string[] = [];
	const driver: NativeDriver = {
		async getWindowState() {
			events.push("observe");
			return observation;
		},
		async click() {
			events.push("click");
			return unconfirmed;
		},
		async shutdown(...args) {
			assert.deepEqual(args, []);
			events.push("shutdown");
		},
	};
	const owned: OwnedNativeDriver = {
		driver,
		destroy: () => events.push("destroy"),
	};
	const adapter = new NativeComputerAdapter(() => {
		events.push("create");
		return owned;
	});
	return { adapter, driver, owned, events };
}

test("importing and constructing the adapter does not create; unused close stays lazy", async () => {
	const { adapter, events } = fixture();
	assert.deepEqual(events, []);
	const closing = adapter.close();
	assert.strictEqual(adapter.close(), closing);
	await closing;
	assert.deepEqual(events, []);
});

test("open is shared, reentrant-safe and attempted only once", async () => {
	const { owned, events } = fixture();
	let nested: Promise<void> | undefined;
	let adapter!: NativeComputerAdapter;
	adapter = new NativeComputerAdapter(() => {
		events.push("create");
		nested = adapter.open();
		return owned;
	});
	const opening = adapter.open();
	assert.strictEqual(adapter.open(), opening);
	await opening;
	assert.strictEqual(nested, opening);
	assert.strictEqual(adapter.open(), opening);
	await adapter.observe(input).result;
	await adapter.click(clickInput).result;
	await adapter.close();
	assert.deepEqual(events, ["create", "observe", "click", "shutdown", "destroy"]);
});

test("a synchronous creator failure is cached without retry or manufactured result", async () => {
	const failure = new Error("mock create failure");
	let attempts = 0;
	const adapter = new NativeComputerAdapter(() => {
		attempts++;
		throw failure;
	});
	const opening = adapter.open();
	assert.strictEqual(adapter.open(), opening);
	await assert.rejects(opening, (error: unknown) => error === failure);
	assert.strictEqual(adapter.open(), opening);
	await assert.rejects(adapter.observe(input).result, (error: unknown) => error === failure);
	await assert.rejects(adapter.click(clickInput).result, (error: unknown) => error === failure);
	assert.equal(attempts, 1);
	await adapter.close();
});

test("pre-aborted external signals and immediate cancel prevent creation and dispatch", async () => {
	const { adapter, events } = fixture();
	const controller = new AbortController();
	const reason = new Error("cancelled before admission");
	controller.abort(reason);
	await assert.rejects(adapter.observe(input, controller.signal).result, (error: unknown) => error === reason);
	const call = adapter.click(clickInput);
	call.cancel();
	await assert.rejects(call.result, { name: "AbortError" });
	await adapter.close();
	assert.deepEqual(events, []);
});

test("observe forwards the exact record, bigint identity and native output without conversion", async () => {
	const { adapter, driver } = fixture();
	driver.getWindowState = async (received, options) => {
		assert.strictEqual(received, input);
		assert.equal(received.windowId, 9_007_199_254_740_993n);
		assert.ok(options?.signal instanceof AbortSignal);
		assert.equal(options.signal.aborted, false);
		return observation;
	};
	assert.strictEqual(await adapter.observe(input).result, observation);
	await adapter.close();
});

test("click forwards an unconfirmed native action unchanged", async () => {
	const { adapter, driver } = fixture();
	driver.click = async (received, options) => {
		assert.strictEqual(received, clickInput);
		assert.ok(options?.signal instanceof AbortSignal);
		return unconfirmed;
	};
	assert.strictEqual(await adapter.click(clickInput).result, unconfirmed);
	await adapter.close();
});

test("synchronous and asynchronous SDK failures are forwarded without retry", async () => {
	const { adapter, driver, events } = fixture();
	const failure = new Error("mock SDK failure");
	let dispatches = 0;
	driver.getWindowState = () => {
		dispatches++;
		throw failure;
	};
	driver.click = async () => {
		dispatches++;
		throw failure;
	};
	await assert.rejects(adapter.observe(input).result, (error: unknown) => error === failure);
	await assert.rejects(adapter.click(clickInput).result, (error: unknown) => error === failure);
	assert.equal(dispatches, 2);
	await adapter.close();
	assert.deepEqual(events, ["create", "shutdown", "destroy"]);
});

test("cancel requests SDK cancellation once but waits for its actual result", async () => {
	const { adapter, driver } = fixture();
	const entered = deferred<void>();
	const native = deferred<ClickResult>();
	let aborts = 0;
	driver.click = (_input, options) => {
		assert.ok(options);
		options.signal.addEventListener("abort", () => aborts++);
		entered.resolve();
		return native.promise;
	};
	const call = adapter.click(clickInput);
	let settled = false;
	void call.result.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await entered.promise;
	call.cancel();
	call.cancel();
	await nextTurn();
	assert.equal(aborts, 1);
	assert.equal(settled, false);
	native.resolve(unconfirmed);
	assert.strictEqual(await call.result, unconfirmed);
	call.cancel();
	assert.equal(aborts, 1);
	await adapter.close();
});

test("external abort forwards to the per-call signal and preserves the SDK rejection", async () => {
	const { adapter, driver } = fixture();
	const controller = new AbortController();
	const entered = deferred<AbortSignal>();
	const native = deferred<Observation>();
	const failure = new Error("mock native cancellation acknowledgement");
	driver.getWindowState = (_input, options) => {
		assert.ok(options);
		entered.resolve(options.signal);
		return native.promise;
	};
	const call = adapter.observe(input, controller.signal);
	const signal = await entered.promise;
	assert.notStrictEqual(signal, controller.signal);
	controller.abort();
	assert.equal(signal.aborted, true);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	const rejected = assert.rejects(call.result, (error: unknown) => error === failure);
	native.reject(failure);
	await rejected;
	await adapter.close();
});

test("cancelling one call does not cancel another call", async () => {
	const { adapter, driver } = fixture();
	const entered = deferred<void>();
	const native = deferred<Observation>();
	const signals: AbortSignal[] = [];
	driver.getWindowState = (_input, options) => {
		assert.ok(options);
		signals.push(options.signal);
		if (signals.length === 2) entered.resolve();
		return native.promise;
	};
	const first = adapter.observe(input);
	const second = adapter.observe(input);
	await entered.promise;
	first.cancel();
	assert.equal(signals[0]?.aborted, true);
	assert.equal(signals[1]?.aborted, false);
	native.resolve(observation);
	await Promise.all([first.result, second.result]);
	await adapter.close();
});

test("a synchronous reentrant external abort is delivered after SDK listener installation", async () => {
	const { adapter, driver } = fixture();
	const controller = new AbortController();
	const entered = deferred<void>();
	const native = deferred<Observation>();
	const events: string[] = [];
	driver.getWindowState = (_input, options) => {
		assert.ok(options);
		controller.abort();
		assert.equal(options.signal.aborted, false);
		events.push("invoked");
		options.signal.addEventListener("abort", () => events.push("abort"));
		events.push("listener installed");
		entered.resolve();
		return native.promise;
	};
	const call = adapter.observe(input, controller.signal);
	await entered.promise;
	assert.deepEqual(events, ["invoked", "listener installed", "abort"]);
	native.resolve(observation);
	assert.strictEqual(await call.result, observation);
	await adapter.close();
});

test("a synchronous reentrant handle cancel also waits for SDK listener installation", async () => {
	const { adapter, driver } = fixture();
	const native = deferred<ClickResult>();
	const entered = deferred<void>();
	let call!: NativeCall<ClickResult>;
	let aborts = 0;
	driver.click = (_input, options) => {
		assert.ok(options);
		call.cancel();
		assert.equal(options.signal.aborted, false);
		options.signal.addEventListener("abort", () => aborts++);
		entered.resolve();
		return native.promise;
	};
	call = adapter.click(clickInput);
	await entered.promise;
	assert.equal(aborts, 1);
	native.resolve(unconfirmed);
	assert.strictEqual(await call.result, unconfirmed);
	await adapter.close();
});

test("external abort listeners are removed on both successful and failed settlement", async () => {
	const { adapter, driver } = fixture();
	for (const fail of [false, true]) {
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const failure = new Error("mock failure");
		driver.getWindowState = async (_input, options) => {
			assert.ok(options);
			received = options.signal;
			assert.equal(getEventListeners(controller.signal, "abort").length, 1);
			if (fail) throw failure;
			return observation;
		};
		const call = adapter.observe(input, controller.signal);
		if (fail) await assert.rejects(call.result, (error: unknown) => error === failure);
		else assert.strictEqual(await call.result, observation);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		controller.abort();
		assert.equal(received?.aborted, false);
	}
	await adapter.close();
});

test("close gates calls, cancels pending work, awaits SDK settlement and shutdown before destroy", async () => {
	const { adapter, driver, events } = fixture();
	const entered = deferred<AbortSignal>();
	const native = deferred<Observation>();
	const shutdownEntered = deferred<void>();
	const shutdown = deferred<void>();
	let reentrantClose: Promise<void> | undefined;
	driver.getWindowState = (_input, options) => {
		assert.ok(options);
		events.push("observe");
		options.signal.addEventListener("abort", () => {
			reentrantClose = adapter.close();
		});
		entered.resolve(options.signal);
		return native.promise;
	};
	driver.shutdown = (...args) => {
		assert.deepEqual(args, []);
		events.push("shutdown");
		shutdownEntered.resolve();
		return shutdown.promise;
	};
	const call = adapter.observe(input);
	const signal = await entered.promise;
	const closing = adapter.close();
	assert.strictEqual(adapter.close(), closing);
	assert.strictEqual(reentrantClose, closing);
	assert.equal(signal.aborted, true);
	await nextTurn();
	assert.deepEqual(events, ["create", "observe"]);
	await assert.rejects(adapter.open(), /closed/);
	await assert.rejects(adapter.observe(input).result, /closed/);
	await assert.rejects(adapter.click(clickInput).result, /closed/);
	native.resolve(observation);
	assert.strictEqual(await call.result, observation);
	await shutdownEntered.promise;
	assert.deepEqual(events, ["create", "observe", "shutdown"]);
	shutdown.resolve();
	await closing;
	assert.deepEqual(events, ["create", "observe", "shutdown", "destroy"]);
});

test("abort during synchronous creation prevents dispatch and leaves the owner available for cleanup", async () => {
	const { owned, events } = fixture();
	const controller = new AbortController();
	const adapter = new NativeComputerAdapter(() => {
		events.push("create");
		controller.abort();
		return owned;
	});
	await assert.rejects(adapter.observe(input, controller.signal).result, { name: "AbortError" });
	assert.deepEqual(events, ["create"]);
	await adapter.close();
	assert.deepEqual(events, ["create", "shutdown", "destroy"]);
});

test("close waits for a queued explicit open without starting creation", async () => {
	const { adapter, events } = fixture();
	const opening = adapter.open();
	const closing = adapter.close();
	await assert.rejects(opening, /closed/);
	await closing;
	assert.deepEqual(events, []);
});

test("closing queued work before lazy creation never invokes the creator", async () => {
	const { adapter, events } = fixture();
	const call = adapter.observe(input);
	const closing = adapter.close();
	await assert.rejects(call.result, /closed/);
	await closing;
	assert.deepEqual(events, []);
});

test("calls are tracked before a creator reenters close", async () => {
	const { driver, owned, events } = fixture();
	let adapter!: NativeComputerAdapter;
	let closing: Promise<void> | undefined;
	adapter = new NativeComputerAdapter(() => {
		events.push("create");
		closing = adapter.close();
		return owned;
	});
	driver.getWindowState = async () => {
		assert.fail("must not dispatch after close during creation");
	};
	await assert.rejects(adapter.observe(input).result, /closed/);
	assert.ok(closing);
	await closing;
	assert.deepEqual(events, ["create", "shutdown", "destroy"]);
});

test("failed shutdown retains the handle and caches the same close rejection", async () => {
	const { adapter, driver, events } = fixture();
	const failure = new Error("mock shutdown failure");
	driver.shutdown = async (...args) => {
		assert.deepEqual(args, []);
		events.push("shutdown failed");
		throw failure;
	};
	await adapter.open();
	const closing = adapter.close();
	await assert.rejects(closing, (error: unknown) => error === failure);
	assert.strictEqual(adapter.close(), closing);
	await assert.rejects(adapter.close(), (error: unknown) => error === failure);
	await assert.rejects(adapter.open(), /closed/);
	await assert.rejects(adapter.observe(input).result, /closed/);
	await assert.rejects(adapter.click(clickInput).result, /closed/);
	assert.deepEqual(events, ["create", "shutdown failed"]);
});
