import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { ComputerNativeRuntime } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import {
	type ComputerTarget,
	type ControlledComputerCall,
	ControlledComputerRuntime,
	ControlledComputerSession,
	type NativeHost,
	type NativeOperation,
	type NativeReceipt,
	type NativeResult,
	type NativeSession,
} from "../adapter.ts";

const target: ComputerTarget = { pid: 42, windowId: 9_007_199_254_740_993n };
// Opaque identity fixtures, never encoded by a real generated union/FFI converter.
const observation = Object.freeze({ fixture: "raw observation" }) as unknown as NativeResult;
const action = Object.freeze({ fixture: "raw unconfirmed action" }) as unknown as NativeResult;
const receipt: NativeReceipt = { operationId: "fake-operation", cancelled: false, inputCommitted: false };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function operationFixture(events: string[]) {
	const result = deferred<NativeResult>();
	const terminal = deferred<NativeReceipt>();
	const started = deferred<void>();
	const starts: unknown[][] = [];
	let cancellations = 0;
	const native: NativeOperation = {
		startObserve(...args) {
			assert.equal(args.length, 2);
			starts.push(args);
			events.push("observe");
			started.resolve();
		},
		startClick(...args) {
			assert.equal(args.length, 1);
			starts.push(args);
			events.push("click");
			started.resolve();
		},
		startPlan(...args) {
			assert.equal(args.length, 1);
			starts.push(args);
			events.push("plan");
			started.resolve();
		},
		cancel(...args) {
			assert.deepEqual(args, []);
			cancellations++;
			events.push("cancel");
		},
		result(...args) {
			assert.deepEqual(args, []);
			return result.promise;
		},
		terminal(...args) {
			assert.deepEqual(args, []);
			return terminal.promise;
		},
	};
	return {
		native,
		result,
		terminal,
		started,
		starts,
		get cancellations() {
			return cancellations;
		},
	};
}

function fixture(selectedTarget: ComputerTarget = target) {
	const events: string[] = [];
	const sessions: NativeSession[] = [];
	const opens: Parameters<NativeHost["openSession"]>[] = [];
	const queue: ReturnType<typeof operationFixture>[] = [];
	const host: NativeHost = {
		openSession(...args) {
			assert.equal(args.length, 3);
			opens.push(args);
			events.push("open session");
			const session: NativeSession = {
				newOperation(...args) {
					assert.deepEqual(args, []);
					events.push("allocate");
					const operation = queue.shift();
					assert.ok(operation, "unexpected native allocation");
					return operation.native;
				},
				revoke(...args) {
					assert.deepEqual(args, []);
					events.push("session revoke");
				},
				async close(...args) {
					assert.deepEqual(args, []);
					events.push("session close");
				},
			};
			sessions.push(session);
			return session;
		},
		revoke(...args) {
			assert.deepEqual(args, []);
			events.push("host revoke");
		},
		async close(...args) {
			assert.deepEqual(args, []);
			events.push("host close");
		},
	};
	const owned = { host, destroy: () => events.push("destroy") };
	const runtime = new ControlledComputerRuntime(owned, selectedTarget);
	// Compile-time compatibility; importing this adapter never imports the host implementation.
	const compatible: ComputerNativeRuntime<ControlledComputerSession> = runtime;
	assert.strictEqual(compatible, runtime);
	return {
		runtime,
		host,
		owned,
		events,
		sessions,
		opens,
		operation: () => {
			const operation = operationFixture(events);
			queue.push(operation);
			return operation;
		},
	};
}

test("a fresh process can import without SDK resolution, native loading, or the host runtime", () => {
	const guard = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
 if (specifier.includes('@trycua') || specifier.endsWith('.node') || specifier.endsWith('/core/computer/host.ts')) {
  throw new Error('unexpected runtime dependency: ' + specifier);
 }
 return next(specifier, context);
}});
process.dlopen = () => { throw new Error('unexpected native load'); };`;
	const url = new URL("../adapter.ts", import.meta.url).href;
	const child = spawnSync(
		process.execPath,
		[
			"--import",
			`data:text/javascript,${encodeURIComponent(guard)}`,
			"--input-type=module",
			"--eval",
			`import { ControlledComputerRuntime } from ${JSON.stringify(url)};
if (typeof ControlledComputerRuntime !== 'function') throw new Error('missing adapter');`,
		],
		{ encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
	);
	assert.equal(child.error, undefined);
	assert.equal(child.status, 0, child.stderr);
});

test("construction invokes nothing; unused owned host closes and destroys once", async () => {
	const f = fixture();
	assert.deepEqual(f.events, []);
	const closing = f.runtime.close();
	assert.strictEqual(f.runtime.close(), closing);
	await closing;
	assert.deepEqual(f.events, ["host revoke", "host close", "destroy"]);
	assert.throws(() => f.runtime.openSession(), /closed/);
});

test("sessions use the copied exact target and actual independent parent handles", async () => {
	const mutable = { ...target };
	const f = fixture(mutable);
	mutable.pid = 7;
	mutable.windowId = 8n;
	const parent = f.runtime.openSession();
	const child = f.runtime.openSession(parent);
	const peer = f.runtime.openSession();
	assert.deepEqual(f.opens, [
		[target.pid, target.windowId, undefined],
		[target.pid, target.windowId, f.sessions[0]],
		[target.pid, target.windowId, undefined],
	]);
	assert.notStrictEqual(f.sessions[0], f.sessions[1]);
	assert.notStrictEqual(child, parent);
	await child.close();
	assert.equal(parent.revoked, false);
	assert.equal(peer.revoked, false);
	assert.equal(f.events.includes("host close"), false);
	assert.equal(f.events.includes("destroy"), false);
	await f.runtime.close();
});

test("a genuine returned child is retained, revoked and drained with its parent", async () => {
	const f = fixture();
	const parent = f.runtime.openSession();
	const childNative = f.host.openSession(target.pid, target.windowId, f.sessions[0]);
	const child = parent.adoptChild(childNative);
	assert.equal(parent.children.has(child), true);
	const op = f.operation();
	const call = child.click("child-token");
	await op.started.promise;
	parent.revoke();
	assert.equal(child.revoked, true);
	assert.equal(op.cancellations, 1);
	const closing = parent.close();
	await nextTurn();
	assert.equal(f.events.includes("session close"), false);
	op.result.resolve(action);
	op.terminal.resolve({ ...receipt, cancelled: true, inputCommitted: true });
	await call.terminal;
	await closing;
	assert.equal(f.events.filter((event) => event === "session close").length, 2);
	assert.equal(parent.children.size, 0);
	assert.equal(f.events.includes("host close"), false);
	await f.runtime.close();
});

test("child adoption rejects foreign parents and already-owned handle identities", async () => {
	const f = fixture();
	const other = fixture();
	const parent = f.runtime.openSession();
	const foreign = other.runtime.openSession();
	const childNative = f.host.openSession(target.pid, target.windowId, f.sessions[0]);
	assert.throws(() => f.runtime.adoptChild(foreign, childNative), /foreign/);
	assert.throws(() => parent.adoptChild(f.sessions[0]!), /already owned/);
	const child = parent.adoptChild(childNative);
	assert.throws(() => parent.adoptChild(childNative), /already owned/);
	assert.equal(parent.children.size, 1);
	assert.equal(child.revoked, false);
	await Promise.all([f.runtime.close(), other.runtime.close()]);
});

test("a child returned after parent revocation is retained for close but never published", async () => {
	const f = fixture();
	const parent = f.runtime.openSession();
	const childNative = f.host.openSession(target.pid, target.windowId, f.sessions[0]);
	parent.revoke();
	assert.throws(() => parent.adoptChild(childNative), /revoked during creation/);
	assert.equal(parent.children.size, 1);
	assert.equal([...parent.children][0]?.revoked, true);
	await parent.close();
	assert.equal(f.events.filter((event) => event === "session close").length, 2);
	assert.equal(f.events.includes("allocate"), false);
	await f.runtime.close();
});

test("foreign, forged and revoked parents are refused before native allocation", async () => {
	const f = fixture();
	const other = fixture();
	const parent = f.runtime.openSession();
	const foreign = other.runtime.openSession();
	const forged = new ControlledComputerSession(f.runtime, f.sessions[0]!);
	assert.throws(() => f.runtime.openSession(foreign), /foreign or revoked/);
	assert.throws(() => f.runtime.openSession(forged), /foreign or revoked/);
	parent.revoke();
	assert.throws(() => f.runtime.openSession(parent), /foreign or revoked/);
	assert.equal(f.opens.length, 1);
	await Promise.all([f.runtime.close(), other.runtime.close()]);
});

test("preabort and immediate cancel allocate no native operation", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const controller = new AbortController();
	const reason = new Error("already cancelled");
	controller.abort(reason);
	const preaborted = session.observe(20, 3, controller.signal);
	await assert.rejects(preaborted.result, (error: unknown) => error === reason);
	assert.equal(await preaborted.receipt, undefined);
	await preaborted.terminal;
	const cancelled = session.click("token");
	cancelled.cancel();
	await assert.rejects(cancelled.result, { name: "AbortError" });
	await cancelled.terminal;
	assert.equal(await cancelled.receipt, undefined);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.deepEqual(f.events, ["open session"]);
	await f.runtime.close();
});

test("raw results and receipts are forwarded independently, without invented action success", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	for (const kind of ["observe", "click"] as const) {
		const op = f.operation();
		const call = kind === "observe" ? session.observe(512, 32) : session.click("exact-token");
		await op.started.promise;
		assert.deepEqual(op.starts, kind === "observe" ? [[512, 32]] : [["exact-token"]]);
		const raw = kind === "observe" ? observation : action;
		op.result.resolve(raw);
		assert.strictEqual(await call.result, raw);
		let terminal = false;
		void call.terminal.then(() => {
			terminal = true;
		});
		await nextTurn();
		assert.equal(terminal, false);
		op.terminal.resolve(receipt);
		assert.strictEqual(await call.receipt, receipt);
		assert.equal(await call.terminal, undefined);
	}
	await f.runtime.close();
});

test("a bounded plan crosses start once and preserves its result after cancellation through terminal", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const plan: Parameters<NativeOperation["startPlan"]>[0] = { snapshotId: "fixture-snapshot", steps: [] };
	const call = session.plan(plan);
	await op.started.promise;
	assert.strictEqual(op.starts[0]?.[0], plan);
	assert.deepEqual(f.events, ["open session", "allocate", "plan"]);
	call.cancel();
	op.result.resolve(action);
	assert.strictEqual(await call.result, action);
	const closing = f.runtime.close();
	await nextTurn();
	assert.equal(f.events.includes("destroy"), false);
	op.terminal.resolve({ ...receipt, cancelled: true, inputCommitted: true });
	assert.equal((await call.receipt)?.inputCommitted, true);
	await closing;
	assert.equal(op.cancellations, 1);
});

test("abort during inert allocation is latched, explicitly cancelled and never started", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const controller = new AbortController();
	const allocate = f.sessions[0]!.newOperation;
	f.sessions[0]!.newOperation = () => {
		controller.abort();
		assert.equal(op.cancellations, 0);
		return allocate();
	};
	const call = session.observe(20, 3, controller.signal);
	await nextTurn();
	assert.equal(op.cancellations, 1);
	assert.deepEqual(op.starts, []);
	op.result.reject(new Error("native cancelled while inert"));
	await assert.rejects(call.result, /native cancelled while inert/);
	op.terminal.resolve({ ...receipt, cancelled: true });
	await call.terminal;
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	await f.runtime.close();
});

test("abort and handle cancellation during start are delivered only after start returns", async () => {
	for (const external of [false, true]) {
		const f = fixture();
		const session = f.runtime.openSession();
		const op = f.operation();
		const controller = new AbortController();
		let call!: ControlledComputerCall;
		op.native.startClick = () => {
			if (external) controller.abort();
			else call.cancel();
			assert.equal(op.cancellations, 0);
			op.started.resolve();
		};
		call = session.click("token", controller.signal);
		await op.started.promise;
		assert.equal(op.cancellations, 1);
		call.cancel();
		assert.equal(op.cancellations, 1);
		op.result.resolve(action);
		assert.strictEqual(await call.result, action);
		op.terminal.resolve({ ...receipt, cancelled: true, inputCommitted: true });
		await call.terminal;
		controller.abort();
		call.cancel();
		assert.equal(op.cancellations, 1);
		await f.runtime.close();
	}
});

test("cancelling one session's operation does not cancel a sibling", async () => {
	const f = fixture();
	const first = f.runtime.openSession();
	const second = f.runtime.openSession();
	const a = f.operation();
	const b = f.operation();
	const callA = first.click("a");
	const callB = second.click("b");
	await Promise.all([a.started.promise, b.started.promise]);
	callA.cancel();
	assert.equal(a.cancellations, 1);
	assert.equal(b.cancellations, 0);
	for (const op of [a, b]) {
		op.result.resolve(action);
		op.terminal.resolve(receipt);
	}
	await Promise.all([callA.terminal, callB.terminal]);
	await f.runtime.close();
});

test("early result rejection neither removes cancellation nor counts as terminal drain", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const controller = new AbortController();
	const call = session.observe(20, 3, controller.signal);
	await op.started.promise;
	op.result.reject(new Error("early subscriber failure"));
	await nextTurn(); // No unhandled rejection even when a caller has not consumed result yet.
	await assert.rejects(call.result, /early subscriber failure/);
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	controller.abort();
	assert.equal(op.cancellations, 1);
	const closing = f.runtime.close();
	await nextTurn();
	assert.equal(f.events.includes("session close"), false);
	assert.equal(f.events.includes("host close"), false);
	assert.equal(f.events.includes("destroy"), false);
	op.terminal.resolve(receipt);
	await call.terminal;
	await closing;
	assert.equal(f.events.at(-1), "destroy");
});

test("external abort listeners remain through result settlement and detach only at terminal proof", async () => {
	for (const fail of [false, true]) {
		const f = fixture();
		const session = f.runtime.openSession();
		const op = f.operation();
		const controller = new AbortController();
		const call = session.observe(20, 3, controller.signal);
		await op.started.promise;
		if (fail) {
			op.result.reject(new Error("native result failure"));
			await assert.rejects(call.result, /native result failure/);
		} else {
			op.result.resolve(observation);
			await call.result;
		}
		assert.equal(getEventListeners(controller.signal, "abort").length, 1);
		op.terminal.resolve(receipt);
		await call.terminal;
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		controller.abort();
		assert.equal(op.cancellations, 0);
		await f.runtime.close();
	}
});

test("close waits for terminal, then native session close, then native host close before destroy", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const sessionClosing = deferred<void>();
	const sessionEntered = deferred<void>();
	const hostClosing = deferred<void>();
	const hostEntered = deferred<void>();
	f.sessions[0]!.close = (...args) => {
		assert.deepEqual(args, []);
		f.events.push("session close");
		sessionEntered.resolve();
		return sessionClosing.promise;
	};
	f.host.close = (...args) => {
		assert.deepEqual(args, []);
		f.events.push("host close");
		hostEntered.resolve();
		return hostClosing.promise;
	};
	const call = session.click("token");
	await op.started.promise;
	op.result.resolve(action);
	await call.result;
	const closing = f.runtime.close();
	assert.strictEqual(f.runtime.close(), closing);
	await nextTurn();
	assert.equal(f.events.includes("session close"), false);
	op.terminal.resolve(receipt);
	await sessionEntered.promise;
	assert.equal(f.events.includes("host close"), false);
	sessionClosing.resolve();
	await hostEntered.promise;
	assert.equal(f.events.includes("destroy"), false);
	hostClosing.resolve();
	await closing;
	assert.equal(f.events.at(-1), "destroy");
	assert.strictEqual(session.close(), session.close());
});

test("a start failure cancels and drains even if the result subscriber never settles", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const failure = new Error("start failed after possible admission");
	op.native.startObserve = () => {
		throw failure;
	};
	const call = session.observe(20, 3);
	await assert.rejects(call.result, (error: unknown) => error === failure);
	assert.equal(op.cancellations, 1);
	const closing = f.runtime.close();
	await nextTurn();
	assert.equal(f.events.includes("session close"), false);
	op.terminal.resolve(receipt);
	await call.terminal;
	await closing;
	assert.equal(f.events.at(-1), "destroy");
});

test("terminal failure with pending result rejects close promptly and retains every owner", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const call = session.click("token");
	await op.started.promise;
	let resultSettled = false;
	void call.result.then(
		() => {
			resultSettled = true;
		},
		() => {
			resultSettled = true;
		},
	);
	const failure = new Error("terminal proof unavailable");
	op.terminal.reject(failure);
	await assert.rejects(call.terminal, (error: unknown) => error === failure);
	await assert.rejects(call.receipt, (error: unknown) => error === failure);
	assert.equal(f.runtime.quarantined, true);
	assert.equal(op.cancellations, 1);
	await assert.rejects(session.close(), (error: unknown) => error === failure);
	const closing = f.runtime.close();
	await assert.rejects(closing, (error: unknown) => error === failure);
	assert.strictEqual(f.runtime.close(), closing);
	assert.equal(resultSettled, false);
	assert.equal(f.events.includes("session close"), false);
	assert.equal(f.events.includes("host close"), false);
	assert.equal(f.events.includes("destroy"), false);
	assert.throws(
		() => f.runtime.openSession(),
		(error: unknown) => error === failure,
	);
});

test("synchronous terminal waiter failure quarantines without starting or awaiting result", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const failure = new Error("cannot subscribe to terminal");
	op.native.terminal = () => {
		throw failure;
	};
	const call = session.click("token");
	await assert.rejects(call.terminal, (error: unknown) => error === failure);
	assert.deepEqual(op.starts, []);
	assert.equal(op.cancellations, 1);
	await assert.rejects(f.runtime.close(), (error: unknown) => error === failure);
	assert.equal(f.events.includes("destroy"), false);
});

test("synchronous result waiter failure cancels inert work but still waits for terminal", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const failure = new Error("result waiter failure");
	op.native.result = () => {
		throw failure;
	};
	const call = session.click("token");
	await assert.rejects(call.result, (error: unknown) => error === failure);
	assert.deepEqual(op.starts, []);
	assert.equal(op.cancellations, 1);
	const closing = f.runtime.close();
	await nextTurn();
	assert.equal(f.events.includes("destroy"), false);
	op.terminal.resolve(receipt);
	await closing;
	assert.equal(f.runtime.quarantined, false);
});

test("allocation failure fails closed and does not manufacture a native terminal receipt", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const failure = new Error("native allocation uncertainty");
	f.sessions[0]!.newOperation = () => {
		throw failure;
	};
	const call = session.click("token");
	await assert.rejects(call.result, (error: unknown) => error === failure);
	await assert.rejects(call.receipt, (error: unknown) => error === failure);
	await assert.rejects(f.runtime.close(), (error: unknown) => error === failure);
	assert.equal(f.events.includes("destroy"), false);
});

test("native cancel failure rejects terminal proof, caches quarantine and never destroys", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const failure = new Error("native cancel failed");
	op.native.cancel = () => {
		throw failure;
	};
	const call = session.click("token");
	await op.started.promise;
	assert.throws(call.cancel, (error: unknown) => error === failure);
	await assert.rejects(call.terminal, (error: unknown) => error === failure);
	op.terminal.resolve(receipt); // A later receipt cannot undo the conservative quarantine.
	await assert.rejects(f.runtime.close(), (error: unknown) => error === failure);
	assert.equal(f.events.includes("destroy"), false);
});

test("external abort contains a native cancel exception inside the owned failure boundary", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const controller = new AbortController();
	const failure = new Error("cancel failed from abort listener");
	op.native.cancel = () => {
		throw failure;
	};
	const call = session.observe(20, 3, controller.signal);
	await op.started.promise;
	controller.abort();
	await assert.rejects(call.terminal, (error: unknown) => error === failure);
	await nextTurn();
	await assert.rejects(f.runtime.close(), (error: unknown) => error === failure);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("ancestor gate closes before native revoke can reenter a child", async () => {
	const f = fixture();
	const parent = f.runtime.openSession();
	const child = f.runtime.openSession(parent);
	let nested: ControlledComputerCall | undefined;
	f.sessions[0]!.revoke = () => {
		assert.equal(child.revoked, true);
		nested = child.click("must-not-start");
	};
	parent.revoke();
	assert.ok(nested);
	await assert.rejects(nested.result, { name: "AbortError" });
	await nested.terminal;
	assert.equal(f.events.includes("allocate"), false);
	await parent.close();
	assert.equal(f.events.filter((event) => event === "session close").length, 2);
	assert.equal(f.events.includes("host close"), false);
	await f.runtime.close();
});

test("native session revoke failure closes descendant admission and retains the host", async () => {
	const f = fixture();
	const parent = f.runtime.openSession();
	const child = f.runtime.openSession(parent);
	const op = f.operation();
	const call = child.click("token");
	await op.started.promise;
	const failure = new Error("revoke failed");
	f.sessions[0]!.revoke = () => {
		throw failure;
	};
	assert.throws(
		() => parent.revoke(),
		(error: unknown) => error === failure,
	);
	assert.equal(child.revoked, true);
	await assert.rejects(call.terminal, (error: unknown) => error === failure);
	await assert.rejects(child.click("forbidden").result, /revoked/);
	await assert.rejects(parent.close(), (error: unknown) => error === failure);
	await assert.rejects(f.runtime.close(), (error: unknown) => error === failure);
	assert.equal(f.events.includes("session close"), false);
	assert.equal(f.events.includes("host close"), false);
	assert.equal(f.events.includes("destroy"), false);
});

test("native session close rejection is cached and prevents shared host shutdown", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const failure = new Error("session close failed");
	let attempts = 0;
	f.sessions[0]!.close = async (...args) => {
		assert.deepEqual(args, []);
		attempts++;
		throw failure;
	};
	const closing = session.close();
	await assert.rejects(closing, (error: unknown) => error === failure);
	assert.strictEqual(session.close(), closing);
	await assert.rejects(f.runtime.close(), (error: unknown) => error === failure);
	assert.equal(attempts, 1);
	assert.equal(f.events.includes("host close"), false);
	assert.equal(f.events.includes("destroy"), false);
});

test("native host revoke, close and destroy failures are retained without retry", async () => {
	for (const phase of ["revoke", "close", "destroy"] as const) {
		const f = fixture();
		const failure = new Error(`host ${phase} failed`);
		let attempts = 0;
		const fail = () => {
			attempts++;
			throw failure;
		};
		if (phase === "revoke") f.host.revoke = fail;
		else if (phase === "close") f.host.close = fail;
		else f.owned.destroy = fail;
		const closing = f.runtime.close();
		await assert.rejects(closing, (error: unknown) => error === failure);
		assert.strictEqual(f.runtime.close(), closing);
		await assert.rejects(f.runtime.close(), (error: unknown) => error === failure);
		assert.equal(f.runtime.quarantined, true);
		// Quarantine makes one additional best-effort revoke request, never another close/destroy.
		assert.equal(attempts, phase === "revoke" ? 2 : 1);
		assert.equal(f.events.includes("destroy"), false);
	}
});

test("close promise identity is installed before reentrant native callbacks", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	let hostNested: Promise<void> | undefined;
	let sessionNested: Promise<void> | undefined;
	f.host.revoke = () => {
		hostNested = f.runtime.close();
	};
	f.sessions[0]!.revoke = () => {
		sessionNested = session.close();
	};
	const closing = f.runtime.close();
	assert.strictEqual(hostNested, closing);
	assert.strictEqual(sessionNested, session.close());
	await closing;
	assert.equal(f.events.filter((event) => event === "destroy").length, 1);
});

test("close before queued allocation prevents all native operation allocation", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const call = session.click("token");
	const closing = f.runtime.close();
	await assert.rejects(call.result, { name: "AbortError" });
	await call.terminal;
	await closing;
	assert.equal(f.events.includes("allocate"), false);
});

test("close reentered during allocation cancels the returned inert handle before drain", async () => {
	const f = fixture();
	const session = f.runtime.openSession();
	const op = f.operation();
	const allocate = f.sessions[0]!.newOperation;
	let closing: Promise<void> | undefined;
	f.sessions[0]!.newOperation = () => {
		closing = f.runtime.close();
		return allocate();
	};
	const call = session.click("token");
	await nextTurn();
	assert.ok(closing);
	assert.deepEqual(op.starts, []);
	assert.equal(op.cancellations, 1);
	assert.equal(f.events.includes("session close"), false);
	op.result.resolve(action);
	op.terminal.resolve(receipt);
	await call.terminal;
	await closing;
	assert.equal(f.events.at(-1), "destroy");
});

test("runtime owns and drains a session returned after reentrant close during native creation", async () => {
	const f = fixture();
	const open = f.host.openSession;
	let closing: Promise<void> | undefined;
	f.host.openSession = (...args) => {
		closing = f.runtime.close();
		return open(...args);
	};
	assert.throws(() => f.runtime.openSession(), /revoked during creation/);
	assert.ok(closing);
	await closing;
	assert.ok(f.events.indexOf("session close") < f.events.indexOf("host close"));
	assert.equal(f.events.at(-1), "destroy");
});
