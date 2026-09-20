import { ResourceScheduler } from "@earendil-works/pi-agent-core";

/** Trusted native boundary. Revocation is synchronous; close acknowledges terminal native work. */
export interface ComputerNativeSession {
	revoke(): void;
	close(): Promise<void>;
}

export interface ComputerNativeRuntime<S extends ComputerNativeSession> {
	/** The factory owns cleanup of partial creation that it does not return. */
	openSession(parent?: S): S | Promise<S>;
	/** No session may shut down the shared runtime. Only the host calls this. */
	close(): Promise<void>;
}

export interface ComputerNativeOperation<T> {
	readonly result: Promise<T>;
	/** Fulfillment proves terminal native work, not merely an SDK future settling. */
	readonly terminal: Promise<void>;
	cancel(): void;
}

export type ComputerHostErrorCode =
	| "session_revoked"
	| "desktop_busy"
	| "desktop_quarantined"
	| "native_unavailable"
	| "native_fault"
	| "cancelled_before_dispatch"
	| "cancelled";

export class ComputerHostError extends Error {
	readonly code: ComputerHostErrorCode;

	constructor(code: ComputerHostErrorCode) {
		super(code);
		this.name = "ComputerHostError";
		this.code = code;
	}
}

interface PendingOperation {
	cancel(): void;
	done: Promise<unknown>;
}

/**
 * Host-owned, opt-in runtime. Owner identity spans model decisions; this is NOT a second scheduler.
 * Tool execution takes the shared scheduler lease outside run(). Never acquire it again here.
 * A native backend must itself own the cooperative cross-process lease through terminal shutdown.
 */
export class ComputerHost<S extends ComputerNativeSession> {
	readonly desktopId: string;
	readonly scheduler: ResourceScheduler;
	private readonly create: () => ComputerNativeRuntime<S> | Promise<ComputerNativeRuntime<S>>;
	private readonly sessions = new Set<ComputerSession<S>>();
	private runtimePromise?: Promise<ComputerNativeRuntime<S>>;
	private owner: ComputerSession<S> | undefined;
	private closing?: Promise<void>;
	private stopped = false;
	private isolated = false;

	constructor(options: {
		desktopId: string;
		scheduler?: ResourceScheduler;
		createRuntime: () => ComputerNativeRuntime<S> | Promise<ComputerNativeRuntime<S>>;
	}) {
		if (!options.desktopId || options.desktopId.length > 128) throw new Error("Invalid computer desktop identity");
		this.desktopId = options.desktopId;
		this.scheduler = options.scheduler ?? new ResourceScheduler();
		this.create = options.createRuntime;
	}

	get quarantined(): boolean {
		return this.isolated;
	}

	openSession(parent?: ComputerSession<S>): ComputerSession<S> {
		if (this.stopped) throw new ComputerHostError("session_revoked");
		if (this.isolated) throw new ComputerHostError("desktop_quarantined");
		if (parent && (!this.sessions.has(parent) || parent.revoked)) throw new ComputerHostError("session_revoked");
		const session = new ComputerSession(this, parent);
		this.sessions.add(session);
		parent?.children.add(session);
		return session;
	}

	/** Internal identity check: strings, serialized IDs and freshly constructed lookalikes confer no authority. */
	admit(session: ComputerSession<S>): void {
		if (this.isolated) throw new ComputerHostError("desktop_quarantined");
		if (this.stopped || !this.sessions.has(session) || session.revoked)
			throw new ComputerHostError("session_revoked");
		if (this.owner && this.owner !== session) throw new ComputerHostError("desktop_busy");
		this.owner = session;
	}

	/** Single-flight and cached failure, including synchronous factory reentrancy. */
	native(): Promise<ComputerNativeRuntime<S>> {
		this.runtimePromise ??= Promise.resolve().then(() => {
			if (this.stopped || this.isolated) throw new ComputerHostError("session_revoked");
			return this.create();
		});
		return this.runtimePromise;
	}

	quarantine(): void {
		// No timeout, automatic recovery, new runtime or owner transfer from this state.
		this.isolated = true;
		this.revoke([...this.sessions]);
	}

	revoke(roots: readonly ComputerSession<S>[]): void {
		const affected = new Set<ComputerSession<S>>();
		const visit = (session: ComputerSession<S>) => {
			if (session.revoked) return;
			session.markRevoked();
			affected.add(session);
			for (const child of session.children) visit(child);
		};
		for (const session of roots) visit(session);
		// Close the entire ancestry gate before any native callback/abort listener can reenter JS.
		for (const session of affected) session.cancelNative();
	}

	release(session: ComputerSession<S>): void {
		if (this.isolated) throw new ComputerHostError("desktop_quarantined");
		if (this.owner === session) this.owner = undefined;
		this.sessions.delete(session);
		session.parent?.children.delete(session);
	}

	close(): Promise<void> {
		if (!this.closing) {
			this.stopped = true;
			const sessions = [...this.sessions];
			this.closing = Promise.resolve().then(async () => {
				const closed = await Promise.allSettled(sessions.map((session) => session.close()));
				if (closed.some((result) => result.status === "rejected") || this.isolated) {
					throw new ComputerHostError("desktop_quarantined");
				}
				// A failed factory must have cleaned up its partial creation; no automatic retry.
				const runtime = await this.runtimePromise?.catch(() => undefined);
				if (runtime) {
					try {
						await runtime.close();
					} catch {
						this.quarantine();
						throw new ComputerHostError("desktop_quarantined");
					}
				}
			});
			this.revoke(sessions);
		}
		return this.closing;
	}
}

/** Only handles returned by ComputerHost.openSession are admitted. Never persist a live handle. */
export class ComputerSession<S extends ComputerNativeSession> {
	readonly host: ComputerHost<S>;
	readonly parent: ComputerSession<S> | undefined;
	/** Internal host bookkeeping; not model inputs. */
	readonly children = new Set<ComputerSession<S>>();
	private _revoked = false;
	private nativeSession?: S;
	private opening?: Promise<S>;
	private closing?: Promise<void>;
	private readonly pending = new Set<PendingOperation>();

	constructor(host: ComputerHost<S>, parent?: ComputerSession<S>) {
		this.host = host;
		this.parent = parent;
	}

	get revoked(): boolean {
		return this._revoked;
	}

	markRevoked(): void {
		this._revoked = true;
	}

	fork(): ComputerSession<S> {
		return this.host.openSession(this);
	}

	/** A new capability; never revives this handle or its descendants. */
	renew(): ComputerSession<S> {
		return this.host.openSession(this.parent);
	}

	revoke(): void {
		this.host.revoke([this]);
	}

	/** Ordinary stop cancels this session's current operation without renewing its authority. */
	cancel(): void {
		for (const operation of [...this.pending]) operation.cancel();
	}

	cancelNative(): void {
		try {
			this.nativeSession?.revoke();
		} catch {
			this.host.quarantine();
		}
		this.cancel();
	}

	private native(): Promise<S> {
		this.opening ??= Promise.resolve().then(async () => {
			if (this.revoked) throw new ComputerHostError("session_revoked");
			const runtime = await this.host.native();
			const parent = await this.parent?.native();
			if (this.revoked) throw new ComputerHostError("session_revoked");
			const session = await runtime.openSession(parent);
			this.nativeSession = session;
			// Revocation may have happened during asynchronous native creation.
			if (this.revoked) {
				try {
					session.revoke();
				} catch {
					this.host.quarantine();
				}
				throw new ComputerHostError("session_revoked");
			}
			return session;
		});
		return this.opening;
	}

	run<T>(dispatch: (session: S, signal: AbortSignal) => ComputerNativeOperation<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) return Promise.reject(new ComputerHostError("cancelled_before_dispatch"));
		try {
			this.host.admit(this);
			// Direct callers get a refusal, not another waiting queue. Tools use the shared scheduler.
			if (this.pending.size) throw new ComputerHostError("desktop_busy");
		} catch (error) {
			return Promise.reject(error);
		}
		const controller = new AbortController();
		let call: ComputerNativeOperation<T> | undefined;
		let cancelled = false;
		const cancel = () => {
			if (cancelled) return;
			cancelled = true;
			controller.abort();
			try {
				call?.cancel();
			} catch {
				this.host.quarantine();
			}
		};
		const operation: PendingOperation = {
			cancel,
			done: Promise.resolve().then(async () => {
				if (this.revoked) throw new ComputerHostError("session_revoked");
				if (cancelled) throw new ComputerHostError("cancelled_before_dispatch");
				let native: S;
				try {
					native = await this.native();
				} catch {
					throw new ComputerHostError(this.revoked ? "session_revoked" : "native_unavailable");
				}
				if (this.revoked) throw new ComputerHostError("session_revoked");
				if (cancelled) throw new ComputerHostError("cancelled_before_dispatch");
				try {
					call = dispatch(native, controller.signal);
				} catch {
					// A throwing dispatcher might already have submitted native work without returning its handle.
					this.host.quarantine();
					throw new ComputerHostError("desktop_quarantined");
				}
				// Observe result rejection now, even if native terminal acknowledgement is delayed.
				const resultPromise = call.result.then(
					(value) => ({ status: "fulfilled" as const, value }),
					() => ({ status: "rejected" as const }),
				);
				if (cancelled) {
					try {
						call.cancel();
					} catch {
						this.host.quarantine();
					}
				}
				try {
					await call.terminal;
				} catch {
					this.host.quarantine();
					throw new ComputerHostError("desktop_quarantined");
				}
				if (this.host.quarantined) throw new ComputerHostError("desktop_quarantined");
				const result = await resultPromise;
				if (result.status === "rejected") throw new ComputerHostError(cancelled ? "cancelled" : "native_fault");
				// A fulfilled native result retains its actual delivery/effect semantics even after a cancel race.
				return result.value;
			}),
		};
		this.pending.add(operation);
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		const cleanup = () => {
			signal?.removeEventListener("abort", cancel);
			// Quarantine retains the operation handle too; GC is not a native drain mechanism.
			if (!this.host.quarantined) this.pending.delete(operation);
		};
		void operation.done.then(cleanup, cleanup);
		return operation.done as Promise<T>;
	}

	close(): Promise<void> {
		if (!this.closing) {
			const children = [...this.children];
			this.closing = Promise.resolve().then(async () => {
				const childrenClosed = await Promise.allSettled(children.map((child) => child.close()));
				await Promise.allSettled([...this.pending].map((operation) => operation.done));
				await this.opening?.catch(() => undefined);
				if (childrenClosed.some((result) => result.status === "rejected")) this.host.quarantine();
				if (this.host.quarantined) throw new ComputerHostError("desktop_quarantined");
				try {
					await this.nativeSession?.close();
				} catch {
					this.host.quarantine();
					throw new ComputerHostError("desktop_quarantined");
				}
				this.host.release(this);
			});
			// Assign the promise before callbacks that can synchronously reenter close().
			this.revoke();
		}
		return this.closing;
	}
}
