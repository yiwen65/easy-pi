import type { CuaDriverLike } from "@trycua/cua-driver";

export type NativeDriver = Pick<CuaDriverLike, "getWindowState" | "click" | "shutdown">;

export type OwnedNativeDriver = {
	driver: NativeDriver;
	destroy: () => void;
};

export type NativeCall<T> = {
	result: Promise<T>;
	cancel: () => void;
};

/**
 * Trusted-host adapter, with no native loader or default creator.
 * The creator owns any partial creation it does not return.
 * SDK promise settlement (including cancellation/shutdown) does not prove that
 * OS work is terminal. This must not be used as a P01 ComputerBackend bridge.
 */
export class NativeComputerAdapter {
	private readonly create: () => OwnedNativeDriver;
	private owned: OwnedNativeDriver | undefined;
	private opening: Promise<void> | undefined;
	private readonly pending = new Set<NativeCall<unknown>>();
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(create: () => OwnedNativeDriver) {
		this.create = create;
	}

	open(): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Native computer adapter is closed"));
		this.opening ??= Promise.resolve().then(() => {
			if (this.closed) throw new Error("Native computer adapter is closed");
			this.owned = this.create();
		});
		return this.opening;
	}

	observe(
		input: Parameters<NativeDriver["getWindowState"]>[0],
		signal?: AbortSignal,
	): NativeCall<Awaited<ReturnType<NativeDriver["getWindowState"]>>> {
		return this.call((driver, callSignal) => driver.getWindowState(input, { signal: callSignal }), signal);
	}

	click(
		input: Parameters<NativeDriver["click"]>[0],
		signal?: AbortSignal,
	): NativeCall<Awaited<ReturnType<NativeDriver["click"]>>> {
		return this.call((driver, callSignal) => driver.click(input, { signal: callSignal }), signal);
	}

	/** Gate new work, request cancellation, then wait for SDK settlement before cleanup. */
	close(): Promise<void> {
		if (!this.closing) {
			this.closed = true;
			const pending = [...this.pending];
			const opening = this.opening;
			// Assign before cancel: an SDK abort listener may reenter close().
			this.closing = Promise.resolve().then(async () => {
				await Promise.allSettled([...pending.map((call) => call.result), opening]);
				if (this.owned) {
					// Cleanup must not inherit a cancelled call's signal. A shutdown
					// rejection retains the owned handle; destroying it is not a drain.
					await this.owned.driver.shutdown();
					this.owned.destroy();
					this.owned = undefined;
				}
			});
			for (const call of pending) call.cancel();
		}
		return this.closing;
	}

	private call<T>(
		invoke: (driver: NativeDriver, signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): NativeCall<T> {
		const controller = new AbortController();
		let cancelled = false;
		let invoking = false;
		let settled = false;
		const cancel = () => {
			if (settled) return;
			cancelled = true;
			if (!invoking) controller.abort(signal?.reason);
		};
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();

		const call: NativeCall<T> = {
			cancel,
			// Defer work so it is tracked before open() or any injected code runs.
			result: Promise.resolve().then(async () => {
				if (this.closed) throw new Error("Native computer adapter is closed");
				controller.signal.throwIfAborted();
				await this.open();
				if (this.closed) throw new Error("Native computer adapter is closed");
				controller.signal.throwIfAborted();
				invoking = true;
				let result: Promise<T>;
				try {
					result = invoke(this.owned!.driver, controller.signal);
				} finally {
					invoking = false;
					// Generated bindings install their abort listener after their FFI
					// invocation. A synchronous reentrant abort must wait until then.
					if (cancelled) controller.abort(signal?.reason);
				}
				return await result;
			}),
		};
		this.pending.add(call);
		const cleanup = () => {
			settled = true;
			signal?.removeEventListener("abort", cancel);
			this.pending.delete(call);
		};
		void call.result.then(cleanup, cleanup);
		return call;
	}
}
