import type { ComputerHost } from "@trycua/cua-driver";
import type {
	ComputerNativeOperation,
	ComputerNativeRuntime,
	ComputerNativeSession,
} from "../../../packages/coding-agent/src/core/computer/host.ts";

export type NativeHost = Pick<ReturnType<typeof ComputerHost.create>, "openSession" | "revoke" | "close">;
export type NativeSession = ReturnType<NativeHost["openSession"]>;
export type NativeOperation = ReturnType<NativeSession["newOperation"]>;
export type NativeResult = Awaited<ReturnType<NativeOperation["result"]>>;
export type NativeReceipt = Awaited<ReturnType<NativeOperation["terminal"]>>;

export type OwnedNativeHost = {
	host: NativeHost;
	destroy: () => void;
	/** Refresh trusted native health before publishing a genuine terminal to the host loop. */
	onTerminal?: () => void;
};

export type ComputerTarget = {
	readonly pid: Parameters<NativeHost["openSession"]>[0];
	readonly windowId: Parameters<NativeHost["openSession"]>[1];
};

export interface ControlledComputerCall extends ComputerNativeOperation<NativeResult> {
	/** Undefined only when no native operation was allocated. Never a synthetic native receipt. */
	readonly receipt: Promise<NativeReceipt | undefined>;
}

interface PendingCall {
	terminal: Promise<void>;
	cancel(): void;
	invalidate(error: unknown): void;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	// Callers may consume terminal before result, or only one of the two.
	void promise.catch(() => undefined);
	return { promise, resolve, reject };
}

/**
 * Trusted, explicitly injected ownership boundary; importing this module loads no native code.
 * Native creation/partial-creation cleanup belongs to the caller. The target is immutable and
 * native admission validates it. No session may close the shared host or release its desktop lease.
 */
export class ControlledComputerRuntime implements ComputerNativeRuntime<ControlledComputerSession> {
	private owned: OwnedNativeHost | undefined;
	private openNative: ((parent?: NativeSession) => NativeSession) | undefined;
	private readonly sessions = new Map<ControlledComputerSession, NativeSession>();
	private stopped = false;
	private failure: { error: unknown } | undefined;
	private closing: Promise<void> | undefined;

	constructor(owned: OwnedNativeHost, target: ComputerTarget | ((parent?: NativeSession) => NativeSession)) {
		this.owned = owned;
		if (typeof target === "function") {
			// Trusted native session factory, never a model-supplied callback.
			this.openNative = target;
		} else {
			const captured = Object.freeze({ ...target });
			this.openNative = (parent) => owned.host.openSession(captured.pid, captured.windowId, parent);
		}
	}

	get revoked(): boolean {
		return this.stopped;
	}

	get quarantined(): boolean {
		return this.failure !== undefined;
	}

	/** Internal lifecycle check, also used by sessions before releasing their handles. */
	assertHealthy(): void {
		if (this.failure) throw this.failure.error;
	}

	openSession(parent?: ControlledComputerSession): ControlledComputerSession {
		this.assertHealthy();
		if (this.stopped) throw new Error("Controlled computer runtime is closed");
		if (parent && (!this.sessions.has(parent) || parent.revoked)) {
			throw new Error("Controlled computer parent is foreign or revoked");
		}
		let native: NativeSession;
		try {
			native = this.openNative!(parent ? this.sessions.get(parent) : undefined);
		} catch (error) {
			// A failed native ownership call cannot establish a safe host state.
			this.quarantine(error);
			throw error;
		}
		return this.retainSession(native, parent);
	}

	/** Trusted composition only: native must be a child returned by this parent's SDK operation. */
	adoptChild(parent: ControlledComputerSession, native: NativeSession): ControlledComputerSession {
		if (!this.sessions.has(parent)) throw new Error("Controlled computer parent is foreign");
		if ([...this.sessions.values()].includes(native)) throw new Error("Controlled computer handle already owned");
		return this.retainSession(native, parent);
	}

	private retainSession(native: NativeSession, parent?: ControlledComputerSession): ControlledComputerSession {
		const session = new ControlledComputerSession(this, native, parent);
		this.sessions.set(session, native);
		parent?.children.add(session);
		// An injected/native call may reenter close/revoke before returning its handle.
		if (this.stopped || parent?.revoked) {
			session.revoke();
			throw new Error("Controlled computer session was revoked during creation");
		}
		return session;
	}

	/** Internal: uncertainty is permanent. Never destroy, retry, or unlock from quarantine. */
	quarantine(error: unknown): void {
		if (this.failure) return;
		this.failure = { error };
		this.stopped = true;
		for (const session of this.sessions.keys()) session.invalidate(error);
		try {
			this.owned?.host.revoke();
		} catch {
			// Preserve the first failure and every owned handle, not a fictitious drain.
		}
	}

	/** Health is not terminal proof; observe it before an awaiting Agent can continue. */
	observeTerminal(): void {
		try {
			this.owned?.onTerminal?.();
		} catch (error) {
			this.quarantine(error);
		}
	}

	/** Internal: called only after this session's native close acknowledged drain. */
	release(session: ControlledComputerSession): void {
		this.sessions.delete(session);
	}

	close(): Promise<void> {
		if (!this.closing) {
			this.stopped = true;
			// Cache before any synchronous native callback can reenter close().
			this.closing = Promise.resolve()
				.then(async () => {
					this.assertHealthy();
					await Promise.all([...this.sessions.keys()].map((session) => session.close()));
					this.assertHealthy();
					if (this.owned) {
						await this.owned.host.close();
						this.assertHealthy();
						this.owned.destroy();
						this.owned = undefined;
						this.openNative = undefined;
					}
				})
				.catch((error: unknown) => {
					this.quarantine(error);
					throw error;
				});
			try {
				this.owned?.host.revoke();
				for (const session of this.sessions.keys()) session.revoke();
			} catch (error) {
				this.quarantine(error);
			}
		}
		return this.closing;
	}
}

/** Independent native capability; parent identity is supplied only by its owning runtime. */
export class ControlledComputerSession implements ComputerNativeSession {
	/** Internal subtree bookkeeping, not model input. */
	readonly children = new Set<ControlledComputerSession>();
	private readonly runtime: ControlledComputerRuntime;
	private readonly parent: ControlledComputerSession | undefined;
	private native: NativeSession | undefined;
	private stopped = false;
	private closing: Promise<void> | undefined;
	private readonly pending = new Set<PendingCall>();

	/** Internal; use runtime.openSession(), which registers ownership before returning. */
	constructor(runtime: ControlledComputerRuntime, native: NativeSession, parent?: ControlledComputerSession) {
		this.runtime = runtime;
		this.native = native;
		this.parent = parent;
	}

	get revoked(): boolean {
		return this.stopped || this.runtime.revoked || (this.parent?.revoked ?? false);
	}

	/** No authority is inferred here; the trusted caller supplies a genuine native child result. */
	adoptChild(native: NativeSession): ControlledComputerSession {
		return this.runtime.adoptChild(this, native);
	}

	observe(
		maxElements: Parameters<NativeOperation["startObserve"]>[0],
		maxDepth: Parameters<NativeOperation["startObserve"]>[1],
		signal?: AbortSignal,
	): ControlledComputerCall {
		return this.callNative((operation) => operation.startObserve(maxElements, maxDepth), signal);
	}

	click(elementToken: Parameters<NativeOperation["startClick"]>[0], signal?: AbortSignal): ControlledComputerCall {
		return this.callNative((operation) => operation.startClick(elementToken), signal);
	}

	plan(plan: Parameters<NativeOperation["startPlan"]>[0], signal?: AbortSignal): ControlledComputerCall {
		return this.callNative((operation) => operation.startPlan(plan), signal);
	}

	revoke(): void {
		if (this.stopped) return;
		// Descendants read the ancestor gate before any native callback can reenter JS.
		this.stopped = true;
		try {
			this.native?.revoke();
			for (const child of this.children) child.revoke();
			for (const call of this.pending) call.cancel();
		} catch (error) {
			this.runtime.quarantine(error);
			throw error;
		}
	}

	/** Internal: rejected terminal proof must not wait for a possibly forever-pending result. */
	invalidate(error: unknown): void {
		this.stopped = true;
		for (const call of this.pending) {
			call.invalidate(error);
			try {
				call.cancel();
			} catch {
				// Quarantine already retains this operation/session/host.
			}
		}
	}

	close(): Promise<void> {
		if (!this.closing) {
			this.closing = Promise.resolve()
				.then(async () => {
					this.runtime.assertHealthy();
					await Promise.all([...this.children].map((child) => child.close()));
					await Promise.all([...this.pending].map((call) => call.terminal));
					this.runtime.assertHealthy();
					await this.native?.close();
					this.runtime.assertHealthy();
					this.native = undefined;
					this.runtime.release(this);
					this.parent?.children.delete(this);
				})
				.catch((error: unknown) => {
					this.runtime.quarantine(error);
					throw error;
				});
			try {
				this.revoke();
			} catch {
				// close() reports the cached quarantine failure asynchronously.
			}
		}
		return this.closing;
	}

	/** Internal trusted composition seam; retains the same allocation/cancel/drain protocol. */
	callNative(start: (operation: NativeOperation) => void, signal?: AbortSignal): ControlledComputerCall {
		const result = deferred<NativeResult>();
		const receipt = deferred<NativeReceipt | undefined>();
		const terminal = receipt.promise.then(() => undefined);
		void terminal.catch(() => undefined);
		let native: NativeOperation | undefined;
		let cancelled = signal?.aborted ?? false;
		let invoking = false;
		let cancellationSent = false;
		let drained = false;
		const cancel = () => {
			if (drained) return;
			cancelled = true;
			if (!native || invoking || cancellationSent) return;
			cancellationSent = true;
			try {
				native.cancel();
			} catch (error) {
				this.runtime.quarantine(error);
				throw error;
			}
		};
		const requestCancel = () => {
			try {
				cancel();
			} catch {
				// An AbortSignal listener must not throw outside the owned promise boundary.
			}
		};
		const pending: PendingCall = {
			terminal,
			cancel,
			invalidate: (error) => {
				receipt.reject(error);
				signal?.removeEventListener("abort", requestCancel);
			},
		};
		const complete = (value: NativeReceipt | undefined) => {
			drained = true;
			signal?.removeEventListener("abort", requestCancel);
			if (!this.runtime.quarantined) {
				this.pending.delete(pending);
				native = undefined;
			}
			if (value !== undefined) this.runtime.observeTerminal();
			receipt.resolve(value);
		};
		// Register before allocation/start or any injected callback. No generated waiter gets a signal.
		this.pending.add(pending);
		if (!cancelled) signal?.addEventListener("abort", requestCancel, { once: true });
		if (signal?.aborted) cancelled = true;
		void Promise.resolve().then(() => {
			if (this.revoked || cancelled) {
				result.reject(
					cancelled
						? (signal?.reason ?? new DOMException("Computer operation cancelled before allocation", "AbortError"))
						: new Error("Controlled computer session is revoked"),
				);
				complete(undefined);
				return;
			}
			try {
				invoking = true;
				native = this.native!.newOperation();
			} catch (error) {
				result.reject(error);
				this.runtime.quarantine(error);
				return;
			} finally {
				invoking = false;
			}
			if (cancelled) requestCancel();
			let subscriberFailed = false;
			try {
				void native.terminal().then(complete, (error: unknown) => this.runtime.quarantine(error));
			} catch (error) {
				subscriberFailed = true;
				this.runtime.quarantine(error);
			}
			try {
				void native.result().then(result.resolve, result.reject);
			} catch (error) {
				subscriberFailed = true;
				result.reject(error);
			}
			if (subscriberFailed || cancelled || this.revoked) {
				requestCancel();
				return;
			}
			try {
				invoking = true;
				start(native);
			} catch (error) {
				// Even a synchronous start error can follow native admission. Cancel, then drain.
				result.reject(error);
				cancelled = true;
			} finally {
				invoking = false;
				if (cancelled) requestCancel();
			}
		});
		return { result: result.promise, receipt: receipt.promise, terminal, cancel };
	}
}
