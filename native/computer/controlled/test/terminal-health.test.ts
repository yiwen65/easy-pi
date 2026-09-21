import assert from "node:assert/strict";
import test from "node:test";
import {
	ControlledComputerRuntime,
	type ControlledComputerSession,
	type NativeHost,
	type NativeOperation,
	type NativeReceipt,
	type NativeResult,
	type NativeSession,
} from "../adapter.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

for (const resultFirst of [true, false]) {
	test(`native stop is observed before publishing terminal (resultFirst=${resultFirst})`, async () => {
		const result = deferred<NativeResult>();
		const terminal = deferred<NativeReceipt>();
		const started = deferred<void>();
		const value = Object.freeze({ opaque: "fulfilled native result" }) as unknown as NativeResult;
		const receipt: NativeReceipt = { operationId: "native", cancelled: true, inputCommitted: true };
		let cancels = 0;
		const operation = {
			result: () => result.promise,
			terminal: () => terminal.promise,
			startObserve: () => started.resolve(),
			cancel: () => cancels++,
		} as unknown as NativeOperation;
		const native = { newOperation: () => operation, revoke() {}, async close() {} } as unknown as NativeSession;
		const host: NativeHost = { openSession: () => native, revoke() {}, async close() {} };
		let session!: ControlledComputerSession;
		let stopped = false;
		const owned = {
			host,
			destroy() {},
			onTerminal() {
				stopped = true;
				session.revoke();
			},
		};
		const runtime = new ControlledComputerRuntime(owned, { pid: 42, windowId: 1n });
		session = runtime.openSession();
		const call = session.observe(1, 1);
		await started.promise;
		if (resultFirst) result.resolve(value);
		terminal.resolve(receipt);
		assert.strictEqual(await call.receipt, receipt);
		assert.equal(stopped, true, "a model continuation must see the native stop without waiting for a timer");
		assert.equal(session.revoked, true);
		assert.equal(cancels, 0, "do not cancel an already-drained operation on reentrant revocation");
		if (!resultFirst) result.resolve(value);
		assert.strictEqual(await call.result, value, "health observation must preserve the actual fulfilled result");
		await runtime.close();
	});
}
