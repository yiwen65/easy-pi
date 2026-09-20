import { ResourceScheduler } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, type Mock, vi } from "vitest";
import { createComputerSessionBinding } from "../../src/core/computer/binding.ts";
import {
	ComputerHost,
	type ComputerNativeOperation,
	type ComputerNativeRuntime,
	type ComputerNativeSession,
	ComputerSession,
} from "../../src/core/computer/host.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

interface NativeSession extends ComputerNativeSession {
	readonly id: number;
	readonly parent?: NativeSession;
	revoke: Mock<() => void>;
	close: Mock<() => Promise<void>>;
}

function createNativeSession(id: number, parent?: NativeSession): NativeSession {
	return { id, parent, revoke: vi.fn(), close: vi.fn(async () => {}) };
}

function fixture(scheduler = new ResourceScheduler()) {
	const sessions: NativeSession[] = [];
	const runtime = {
		openSession: vi.fn<(parent?: NativeSession) => NativeSession | Promise<NativeSession>>((parent) => {
			const session = createNativeSession(sessions.length + 1, parent);
			sessions.push(session);
			return session;
		}),
		close: vi.fn(async () => {}),
	};
	const factory = vi.fn<() => ComputerNativeRuntime<NativeSession> | Promise<ComputerNativeRuntime<NativeSession>>>(
		() => runtime,
	);
	const host = new ComputerHost({ desktopId: "host-fixture", scheduler, createRuntime: factory });
	return { host, scheduler, factory, runtime, sessions };
}

function pendingOperation<T>() {
	const result = deferred<T>();
	const terminal = deferred<void>();
	const cancel = vi.fn<() => void>();
	const call: ComputerNativeOperation<T> = { result: result.promise, terminal: terminal.promise, cancel };
	return { result, terminal, cancel, call };
}

function completed<T>(value: T): ComputerNativeOperation<T> {
	return { result: Promise.resolve(value), terminal: Promise.resolve(), cancel: vi.fn() };
}

function createTools(session: ComputerSession<NativeSession>) {
	return [
		{
			name: "computer_fixture",
			label: "Computer fixture",
			description: "Only a fake native operation",
			parameters: Type.Object({}),
			executionResource: { key: `desktop:${session.host.desktopId}`, mode: "exclusive" as const },
			execute: async () => {
				const id = await session.run((native) => completed(native.id));
				return { content: [{ type: "text" as const, text: String(id) }], details: { id } };
			},
		} satisfies ToolDefinition,
	];
}

describe("Computer host ownership and lazy lifecycle", () => {
	it("keeps unused sessions, descendants, bindings and close completely lazy", async () => {
		const { host, factory, runtime, scheduler } = fixture();
		const session = host.openSession();
		const binding = createComputerSessionBinding(session, createTools);
		const child = binding.fork();
		const replacement = binding.renew();
		expect(binding.scheduler).toBe(scheduler);
		expect(child.scheduler).toBe(scheduler);
		expect(replacement.scheduler).toBe(scheduler);
		expect(factory).not.toHaveBeenCalled();
		const closing = host.close();
		expect(host.close()).toBe(closing);
		expect([binding.revoked, child.revoked, replacement.revoked]).toEqual([true, true, true]);
		expect(() => host.openSession()).toThrow("session_revoked");
		await closing;
		expect(factory).not.toHaveBeenCalled();
		expect(runtime.openSession).not.toHaveBeenCalled();
		expect(runtime.close).not.toHaveBeenCalled();
	});

	it("holds one owner across decisions and transfers only after that session closes", async () => {
		const { host, factory, runtime, sessions } = fixture();
		const owner = host.openSession();
		const next = host.openSession();
		await expect(owner.run((native) => completed(native.id))).resolves.toBe(1);
		await expect(next.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_busy" });
		await expect(owner.run((native) => completed(native.id))).resolves.toBe(1);
		expect(runtime.openSession).toHaveBeenCalledTimes(1);
		await owner.close();
		expect(sessions[0].close).toHaveBeenCalledTimes(1);
		expect(runtime.close).not.toHaveBeenCalled();
		await expect(next.run((native) => completed(native.id))).resolves.toBe(2);
		expect(factory).toHaveBeenCalledTimes(1);
		await host.close();
		expect(runtime.close).toHaveBeenCalledTimes(1);
	});

	it("retains ownership until the native session close barrier acknowledges termination", async () => {
		const { host, runtime, sessions } = fixture();
		const session = host.openSession();
		const contender = host.openSession();
		await session.run(() => completed("finished"));
		const entered = deferred<void>();
		const closed = deferred<void>();
		sessions[0].close.mockImplementation(() => {
			entered.resolve();
			return closed.promise;
		});
		const closing = session.close();
		await entered.promise;
		await expect(contender.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_busy" });
		expect(runtime.openSession).toHaveBeenCalledTimes(1);
		expect(runtime.close).not.toHaveBeenCalled();
		closed.resolve();
		await closing;
		await expect(contender.run(() => completed("next owner"))).resolves.toBe("next owner");
		await host.close();
	});

	it("caches host close before reentrant native callbacks and awaits shared runtime shutdown", async () => {
		const { host, runtime, sessions } = fixture();
		await host.openSession().run(() => completed("finished"));
		const entered = deferred<void>();
		const closed = deferred<void>();
		const reentries: Promise<void>[] = [];
		sessions[0].revoke.mockImplementation(() => reentries.push(host.close()));
		runtime.close.mockImplementation(() => {
			reentries.push(host.close());
			entered.resolve();
			return closed.promise;
		});
		const closing = host.close();
		const settled = vi.fn();
		void closing.then(settled, settled);
		await entered.promise;
		expect(reentries).toHaveLength(2);
		for (const reentry of reentries) expect(reentry).toBe(closing);
		expect(settled).not.toHaveBeenCalled();
		expect(() => host.openSession()).toThrow("session_revoked");
		closed.resolve();
		await closing;
		expect(sessions[0].close).toHaveBeenCalledTimes(1);
		expect(runtime.close).toHaveBeenCalledTimes(1);
	});

	it("does not acquire the shared scheduler a second time inside run", async () => {
		const { host, scheduler } = fixture(new ResourceScheduler(1));
		const lease = await scheduler.acquire({ key: "desktop:host-fixture", mode: "exclusive" });
		const acquire = vi.spyOn(scheduler, "acquire").mockImplementation(() => {
			throw new Error("Nested scheduler acquisition would deadlock");
		});
		try {
			await expect(host.openSession().run(() => completed("under outer lease"))).resolves.toBe("under outer lease");
			expect(acquire).not.toHaveBeenCalled();
			expect(scheduler.runningCount).toBe(1);
			expect(scheduler.pendingCount).toBe(0);
		} finally {
			lease?.release();
			await host.close();
		}
	});

	it("rejects constructed lookalikes and foreign parents without native initialization", async () => {
		const first = fixture();
		const second = fixture();
		const forged = new ComputerSession(first.host);
		await expect(forged.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "session_revoked" });
		expect(() => first.host.openSession(second.host.openSession())).toThrow("session_revoked");
		expect(first.factory).not.toHaveBeenCalled();
		expect(second.factory).not.toHaveBeenCalled();
		await Promise.all([first.host.close(), second.host.close()]);
	});

	it("caches a single runtime promise before a factory can synchronously reenter", async () => {
		const { host, runtime, factory } = fixture();
		const entered = deferred<void>();
		const opening = deferred<ComputerNativeRuntime<NativeSession>>();
		let reentrant: Promise<ComputerNativeRuntime<NativeSession>> | undefined;
		factory.mockImplementation(() => {
			reentrant = host.native();
			entered.resolve();
			return opening.promise;
		});
		const first = host.native();
		expect(host.native()).toBe(first);
		await entered.promise;
		expect(reentrant).toBe(first);
		opening.resolve(runtime);
		await expect(first).resolves.toBe(runtime);
		expect(factory).toHaveBeenCalledTimes(1);
		await host.close();
		expect(runtime.close).toHaveBeenCalledTimes(1);
	});

	it.each(["throw", "reject"] as const)("caches and sanitizes factory %s without retry", async (failure) => {
		const { host, factory, runtime } = fixture();
		factory.mockImplementation(() => {
			const error = new Error("PRIVATE-INITIALIZATION-FAILURE");
			if (failure === "throw") throw error;
			return Promise.reject(error);
		});
		const session = host.openSession();
		const dispatch = vi.fn(() => completed("forbidden"));
		for (let index = 0; index < 2; index++) {
			await expect(session.run(dispatch)).rejects.toMatchObject({
				code: "native_unavailable",
				message: "native_unavailable",
			});
		}
		expect(factory).toHaveBeenCalledTimes(1);
		expect(dispatch).not.toHaveBeenCalled();
		await host.close();
		expect(runtime.close).not.toHaveBeenCalled();
	});

	it("caches native session initialization failure while still closing its shared runtime", async () => {
		const { host, runtime } = fixture();
		runtime.openSession.mockRejectedValue(new Error("PRIVATE-SESSION-FAILURE"));
		const session = host.openSession();
		for (let index = 0; index < 2; index++) {
			await expect(session.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "native_unavailable" });
		}
		expect(runtime.openSession).toHaveBeenCalledTimes(1);
		await host.close();
		expect(runtime.close).toHaveBeenCalledTimes(1);
	});
});

describe("Computer cancellation and dispatch barriers", () => {
	it("does not initialize or claim ownership for a pre-aborted caller", async () => {
		const { host, factory } = fixture();
		const session = host.openSession();
		const controller = new AbortController();
		controller.abort();
		const dispatch = vi.fn(() => completed("forbidden"));
		await expect(session.run(dispatch, controller.signal)).rejects.toMatchObject({
			code: "cancelled_before_dispatch",
		});
		expect(factory).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
		await expect(host.openSession().run(() => completed("other owner"))).resolves.toBe("other owner");
		await host.close();
	});

	it.each(["abort", "revoke"] as const)(
		"blocks %s before the queued run callback initializes native",
		async (action) => {
			const { host, factory } = fixture();
			const session = host.openSession();
			const controller = new AbortController();
			const dispatch = vi.fn(() => completed("forbidden"));
			const running = session.run(dispatch, controller.signal);
			if (action === "abort") controller.abort();
			else session.revoke();
			await expect(running).rejects.toMatchObject({
				code: action === "abort" ? "cancelled_before_dispatch" : "session_revoked",
			});
			expect(factory).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
			await host.close();
		},
	);

	it("rejects a stale callback already queued on the external scheduler", async () => {
		const { host, scheduler, factory } = fixture();
		const session = host.openSession();
		const resource = { key: "desktop:host-fixture", mode: "exclusive" as const };
		const lease = await scheduler.acquire(resource);
		const dispatch = vi.fn(() => completed("forbidden"));
		const queued = scheduler.acquire(resource).then(async (nextLease) => {
			try {
				return await session.run(dispatch);
			} finally {
				nextLease?.release();
			}
		});
		expect(scheduler.pendingCount).toBe(1);
		session.revoke();
		lease?.release();
		await expect(queued).rejects.toMatchObject({ code: "session_revoked" });
		expect(dispatch).not.toHaveBeenCalled();
		expect(factory).not.toHaveBeenCalled();
		expect(scheduler.runningCount).toBe(0);
		await host.close();
	});

	it.each(["runtime", "session"] as const)("latches abort during asynchronous %s creation", async (stage) => {
		const { host, factory, runtime } = fixture();
		const entered = deferred<void>();
		const resume = deferred<void>();
		const native = createNativeSession(1);
		if (stage === "runtime") {
			factory.mockImplementation(async () => {
				entered.resolve();
				await resume.promise;
				return runtime;
			});
		} else {
			runtime.openSession.mockImplementation(async () => {
				entered.resolve();
				await resume.promise;
				return native;
			});
		}
		const controller = new AbortController();
		const dispatch = vi.fn(() => completed("forbidden"));
		const running = host.openSession().run(dispatch, controller.signal);
		await entered.promise;
		controller.abort();
		resume.resolve();
		await expect(running).rejects.toMatchObject({ code: "cancelled_before_dispatch" });
		expect(dispatch).not.toHaveBeenCalled();
		expect(host.quarantined).toBe(false);
		await host.close();
		expect(runtime.close).toHaveBeenCalledTimes(1);
	});

	it.each(["runtime", "session"] as const)("closes safely across asynchronous %s creation", async (stage) => {
		const { host, factory, runtime } = fixture();
		const entered = deferred<void>();
		const resume = deferred<void>();
		const native = createNativeSession(1);
		if (stage === "runtime") {
			factory.mockImplementation(async () => {
				entered.resolve();
				await resume.promise;
				return runtime;
			});
		} else {
			runtime.openSession.mockImplementation(async () => {
				entered.resolve();
				await resume.promise;
				return native;
			});
		}
		const session = host.openSession();
		const dispatch = vi.fn(() => completed("forbidden"));
		const running = session.run(dispatch);
		await entered.promise;
		const closing = host.close();
		expect(host.close()).toBe(closing);
		expect(session.revoked).toBe(true);
		expect(runtime.close).not.toHaveBeenCalled();
		resume.resolve();
		await expect(running).rejects.toMatchObject({ code: "session_revoked" });
		await closing;
		expect(dispatch).not.toHaveBeenCalled();
		expect(runtime.close).toHaveBeenCalledTimes(1);
		if (stage === "runtime") expect(runtime.openSession).not.toHaveBeenCalled();
		else {
			expect(native.revoke).toHaveBeenCalledTimes(1);
			expect(native.close).toHaveBeenCalledTimes(1);
		}
	});

	it("latches cancellation before the dispatcher returns its handle and preserves confirmed delivery", async () => {
		const { host } = fixture();
		const session = host.openSession();
		const controller = new AbortController();
		const operation = pendingOperation<string>();
		const entered = deferred<void>();
		const aborted: boolean[] = [];
		const running = session.run((_native, signal) => {
			signal.addEventListener("abort", () => aborted.push(signal.aborted), { once: true });
			controller.abort();
			entered.resolve();
			return operation.call;
		}, controller.signal);
		await entered.promise;
		expect(aborted).toEqual([true]);
		expect(operation.cancel).toHaveBeenCalledTimes(1);
		controller.abort();
		expect(operation.cancel).toHaveBeenCalledTimes(1);
		await expect(session.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_busy" });
		operation.result.resolve("delivered before cancellation");
		operation.terminal.resolve();
		await expect(running).resolves.toBe("delivered before cancellation");
		await host.close();
	});

	it.each(["session", "binding"] as const)(
		"allows ordinary %s.cancel reuse only after terminal acknowledgement without revoking authority",
		async (target) => {
			const { host, factory, runtime, sessions } = fixture();
			const session = host.openSession();
			const contender = host.openSession();
			const tools = createTools(session);
			const binding = createComputerSessionBinding(session, () => tools);
			const cancel = () => (target === "session" ? session.cancel() : binding.cancel());
			cancel();
			expect(factory).not.toHaveBeenCalled();
			const entered = deferred<void>();
			const operation = pendingOperation<string>();
			const aborted = vi.fn();
			operation.cancel.mockImplementation(() => operation.result.reject(new Error("SDK cancelled")));
			const running = session.run((_native, signal) => {
				signal.addEventListener("abort", aborted, { once: true });
				entered.resolve();
				return operation.call;
			});
			const settled = vi.fn();
			void running.then(settled, settled);
			await entered.promise;
			cancel();
			cancel();
			expect(aborted).toHaveBeenCalledTimes(1);
			expect(operation.cancel).toHaveBeenCalledTimes(1);
			await expect(session.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_busy" });
			await expect(contender.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_busy" });
			expect(settled).not.toHaveBeenCalled();
			expect([session.revoked, binding.revoked]).toEqual([false, false]);
			expect(host.quarantined).toBe(false);
			expect(sessions[0].revoke).not.toHaveBeenCalled();
			expect(sessions[0].close).not.toHaveBeenCalled();
			expect(runtime.close).not.toHaveBeenCalled();
			operation.terminal.resolve();
			await expect(running).rejects.toMatchObject({ code: "cancelled", message: "cancelled" });
			cancel();
			expect(operation.cancel).toHaveBeenCalledTimes(1);
			await expect(tools[0].execute()).resolves.toMatchObject({ details: { id: 1 } });
			expect(factory).toHaveBeenCalledTimes(1);
			expect(runtime.openSession).toHaveBeenCalledTimes(1);
			await expect(contender.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_busy" });
			await binding.close();
			await expect(contender.run(() => completed("next owner"))).resolves.toBe("next owner");
			await host.close();
		},
	);

	it("caches reentrant close before a dispatcher returns its handle and waits for terminal acknowledgement", async () => {
		const { host, sessions, runtime } = fixture();
		const session = host.openSession();
		const operation = pendingOperation<string>();
		const entered = deferred<void>();
		const closeCalls: Promise<void>[] = [];
		const running = session.run((native) => {
			native.revoke.mockImplementation(() => closeCalls.push(session.close()));
			closeCalls.push(session.close());
			entered.resolve();
			return operation.call;
		});
		await entered.promise;
		expect(closeCalls).toHaveLength(2);
		expect(closeCalls[0]).toBe(closeCalls[1]);
		expect(session.close()).toBe(closeCalls[0]);
		expect(operation.cancel).toHaveBeenCalledTimes(1);
		const settled = vi.fn();
		void running.then(settled, settled);
		operation.result.resolve("confirmed");
		await operation.result.promise;
		await expect(host.openSession().run(() => completed("forbidden"))).rejects.toMatchObject({
			code: "desktop_busy",
		});
		expect(settled).not.toHaveBeenCalled();
		expect(sessions[0].close).not.toHaveBeenCalled();
		operation.terminal.resolve();
		await expect(running).resolves.toBe("confirmed");
		await closeCalls[0];
		expect(sessions[0].close).toHaveBeenCalledTimes(1);
		expect(runtime.close).not.toHaveBeenCalled();
		await host.close();
	});

	it("does not release an owner or close native after result rejection while terminal remains pending", async () => {
		const { host, runtime, sessions } = fixture();
		const session = host.openSession();
		const contender = host.openSession();
		const entered = deferred<void>();
		const operation = pendingOperation<string>();
		const running = session.run(() => {
			entered.resolve();
			return operation.call;
		});
		const settled = vi.fn();
		void running.then(settled, settled);
		await entered.promise;
		operation.result.reject(new Error("SDK FUTURE SETTLED, NOT NATIVE TERMINAL"));
		await operation.result.promise.catch(() => {});
		await expect(session.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_busy" });
		const closing = session.close();
		await expect(contender.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_busy" });
		expect(settled).not.toHaveBeenCalled();
		expect(sessions[0].close).not.toHaveBeenCalled();
		expect(runtime.close).not.toHaveBeenCalled();
		operation.terminal.resolve();
		await expect(running).rejects.toMatchObject({ code: "cancelled", message: "cancelled" });
		await closing;
		await expect(contender.run(() => completed("next owner"))).resolves.toBe("next owner");
		await host.close();
	});
});

describe("Computer ancestor revocation and binding generations", () => {
	it("closes every descendant gate before native revoke, abort listeners or cancel can reenter", async () => {
		const { host, runtime, sessions } = fixture();
		const parent = host.openSession();
		const child = parent.fork();
		const sibling = parent.fork();
		const grandchild = child.fork();
		const tree = [parent, child, sibling, grandchild];
		const entered = deferred<void>();
		const operation = pendingOperation<string>();
		const snapshots: Array<{ callback: string; revoked: boolean[] }> = [];
		const reentries: Promise<unknown>[] = [];
		const forbidden = vi.fn(() => completed("forbidden"));
		const capture = (callback: string) => {
			snapshots.push({ callback, revoked: tree.map((session) => session.revoked) });
			reentries.push(sibling.run(forbidden));
		};
		operation.cancel.mockImplementation(() => capture("cancel"));
		const running = grandchild.run((_native, signal) => {
			for (const native of sessions) native.revoke.mockImplementation(() => capture(`revoke:${native.id}`));
			signal.addEventListener("abort", () => capture("abort"), { once: true });
			entered.resolve();
			return operation.call;
		});
		await entered.promise;
		parent.revoke();
		expect(snapshots.map((entry) => entry.callback)).toEqual(["revoke:1", "revoke:2", "revoke:3", "abort", "cancel"]);
		for (const snapshot of snapshots) expect(snapshot.revoked).toEqual([true, true, true, true]);
		for (const reentry of reentries) await expect(reentry).rejects.toMatchObject({ code: "session_revoked" });
		expect(forbidden).not.toHaveBeenCalled();
		expect(() => child.fork()).toThrow("session_revoked");
		expect(() => child.renew()).toThrow("session_revoked");
		operation.result.resolve("already delivered");
		operation.terminal.resolve();
		await expect(running).resolves.toBe("already delivered");
		await parent.close();
		for (const native of sessions) expect(native.close).toHaveBeenCalledTimes(1);
		expect(runtime.close).not.toHaveBeenCalled();
		await host.close();
	});

	it("closes only a child subtree, preserving its parent, sibling and shared runtime", async () => {
		const { host, runtime, sessions } = fixture();
		const parent = host.openSession();
		const child = parent.fork();
		const grandchild = child.fork();
		const sibling = parent.fork();
		await grandchild.run(() => completed("grandchild"));
		const order: number[] = [];
		for (const native of sessions) native.close.mockImplementation(async () => void order.push(native.id));
		await child.close();
		expect([parent.revoked, sibling.revoked, child.revoked, grandchild.revoked]).toEqual([false, false, true, true]);
		expect(order).toEqual([3, 2]);
		expect(sessions[0].close).not.toHaveBeenCalled();
		expect(runtime.close).not.toHaveBeenCalled();
		await expect(sibling.run((native) => completed(native.parent?.id))).resolves.toBe(1);
		expect(runtime.openSession.mock.calls.map(([native]) => native?.id)).toEqual([undefined, 1, 2, 1]);
		await host.close();
		expect(runtime.close).toHaveBeenCalledTimes(1);
	});

	it("rebuilds child and renewed tool closures on the same scheduler without reviving old generations", async () => {
		const { host, scheduler, factory, sessions } = fixture();
		const tools = vi.fn(createTools);
		const root = createComputerSessionBinding(host.openSession(), tools);
		const child = root.fork();
		expect(root.tools).not.toBe(tools.mock.results[0].value);
		expect(Object.isFrozen(root.tools)).toBe(true);
		expect(child.tools[0]).not.toBe(root.tools[0]);
		expect(factory).not.toHaveBeenCalled();
		await expect(tools.mock.results[1].value[0].execute()).resolves.toMatchObject({ details: { id: 2 } });
		root.revoke();
		expect([root.revoked, child.revoked]).toEqual([true, true]);
		expect(() => child.renew()).toThrow("session_revoked");
		const renewed = root.renew();
		const newChild = renewed.fork();
		for (const binding of [root, child, renewed, newChild]) expect(binding.scheduler).toBe(scheduler);
		expect(renewed.tools[0]).not.toBe(root.tools[0]);
		expect(newChild.tools[0]).not.toBe(child.tools[0]);
		expect(new Set(tools.mock.calls.map(([session]) => session)).size).toBe(4);
		for (const index of [0, 1]) {
			await expect(tools.mock.results[index].value[0].execute()).rejects.toMatchObject({ code: "session_revoked" });
		}
		await root.close();
		await expect(tools.mock.results[3].value[0].execute()).resolves.toMatchObject({ details: { id: 4 } });
		expect(sessions[3].parent).toBe(sessions[2]);
		expect(sessions[3].parent).not.toBe(sessions[0]);
		expect([root.revoked, child.revoked, renewed.revoked, newChild.revoked]).toEqual([true, true, false, false]);
		await host.close();
	});

	it("rejects duplicate tool names and missing, shared or foreign desktop resources", async () => {
		const { host, factory } = fixture();
		const session = host.openSession();
		expect(() =>
			createComputerSessionBinding(session, (capability) => [
				...createTools(capability),
				...createTools(capability),
			]),
		).toThrow("Duplicate Computer binding tool");
		for (const executionResource of [
			undefined,
			{ key: "desktop:host-fixture", mode: "shared" as const },
			{ key: "desktop:other", mode: "exclusive" as const },
		]) {
			expect(() =>
				createComputerSessionBinding(session, (capability) => [
					{ ...createTools(capability)[0], executionResource },
				]),
			).toThrow("Computer binding tools require the host's exclusive desktop resource");
		}
		expect(factory).not.toHaveBeenCalled();
		await host.close();
	});
});

describe("Computer sticky quarantine", () => {
	it("rejects run and close on terminal failure even when result stays permanently pending", async () => {
		const { host, factory, runtime, sessions } = fixture();
		const session = host.openSession();
		const contender = host.openSession();
		const operation = pendingOperation<string>();
		const entered = deferred<void>();
		const running = session.run(() => {
			entered.resolve();
			return operation.call;
		});
		const release = vi.spyOn(host, "release");
		const resultSettled = vi.fn();
		void operation.result.promise.then(resultSettled, resultSettled);
		await entered.promise;
		// Deliberately never settle result: it cannot be required to report failed terminal acknowledgement.
		operation.terminal.reject(new Error("PRIVATE-TERMINAL-FAILURE"));
		await expect(running).rejects.toMatchObject({ code: "desktop_quarantined", message: "desktop_quarantined" });
		await expect(contender.run(() => completed("forbidden"))).rejects.toMatchObject({
			code: "desktop_quarantined",
		});
		expect(host.quarantined).toBe(true);
		expect([session.revoked, contender.revoked]).toEqual([true, true]);
		expect(operation.cancel).toHaveBeenCalledTimes(1);
		const closing = host.close();
		expect(host.close()).toBe(closing);
		await expect(closing).rejects.toMatchObject({ code: "desktop_quarantined" });
		await expect(session.close()).rejects.toMatchObject({ code: "desktop_quarantined" });
		expect(resultSettled).not.toHaveBeenCalled();
		expect(() => host.openSession()).toThrow();
		expect(release).not.toHaveBeenCalled();
		expect(sessions[0].close).not.toHaveBeenCalled();
		expect(runtime.close).not.toHaveBeenCalled();
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("retains native ownership when dispatch throws after potentially submitting work", async () => {
		const { host, factory, runtime, sessions } = fixture();
		const session = host.openSession();
		const other = host.openSession();
		const release = vi.spyOn(host, "release");
		const dispatch = vi.fn((): ComputerNativeOperation<string> => {
			throw new Error("PRIVATE-DISPATCH-FAILURE");
		});
		await expect(session.run(dispatch)).rejects.toMatchObject({
			code: "desktop_quarantined",
			message: "desktop_quarantined",
		});
		expect(host.quarantined).toBe(true);
		expect([session.revoked, other.revoked]).toEqual([true, true]);
		await expect(other.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_quarantined" });
		const closing = host.close();
		expect(host.close()).toBe(closing);
		await expect(closing).rejects.toMatchObject({ code: "desktop_quarantined" });
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();
		expect(sessions[0].close).not.toHaveBeenCalled();
		expect(runtime.close).not.toHaveBeenCalled();
	});

	it.each(["cancel", "revoke"] as const)(
		"quarantines throwing native %s without releasing or shutting down",
		async (failure) => {
			const { host, runtime, sessions } = fixture();
			const session = host.openSession();
			const other = host.openSession();
			const operation = pendingOperation<string>();
			const entered = deferred<void>();
			const running = session.run((native) => {
				const failing = failure === "cancel" ? operation.cancel : native.revoke;
				failing.mockImplementation(() => {
					throw new Error("PRIVATE-CANCEL-FAILURE");
				});
				entered.resolve();
				return operation.call;
			});
			await entered.promise;
			session.revoke();
			expect(host.quarantined).toBe(true);
			expect([session.revoked, other.revoked]).toEqual([true, true]);
			expect(operation.cancel).toHaveBeenCalledTimes(1);
			operation.result.resolve("uncertain");
			operation.terminal.resolve();
			await expect(running).rejects.toMatchObject({ code: "desktop_quarantined" });
			await expect(host.close()).rejects.toMatchObject({ code: "desktop_quarantined" });
			expect(sessions[0].close).not.toHaveBeenCalled();
			expect(runtime.close).not.toHaveBeenCalled();
		},
	);

	it("caches session close failure and never releases its owner or closes the runtime", async () => {
		const { host, runtime, sessions } = fixture();
		const session = host.openSession();
		const other = host.openSession();
		await session.run(() => completed("finished"));
		sessions[0].close.mockRejectedValue(new Error("PRIVATE-CLOSE-FAILURE"));
		const release = vi.spyOn(host, "release");
		const closing = session.close();
		expect(session.close()).toBe(closing);
		await expect(closing).rejects.toMatchObject({ code: "desktop_quarantined", message: "desktop_quarantined" });
		await expect(session.close()).rejects.toMatchObject({ code: "desktop_quarantined" });
		expect(host.quarantined).toBe(true);
		expect(other.revoked).toBe(true);
		await expect(other.run(() => completed("forbidden"))).rejects.toMatchObject({ code: "desktop_quarantined" });
		await expect(host.close()).rejects.toMatchObject({ code: "desktop_quarantined" });
		expect(release).not.toHaveBeenCalled();
		expect(sessions[0].close).toHaveBeenCalledTimes(1);
		expect(runtime.close).not.toHaveBeenCalled();
	});

	it("caches runtime close failure without constructing or closing a replacement", async () => {
		const { host, runtime, factory } = fixture();
		await host.openSession().run(() => completed("finished"));
		runtime.close.mockRejectedValue(new Error("PRIVATE-RUNTIME-CLOSE-FAILURE"));
		const closing = host.close();
		expect(host.close()).toBe(closing);
		await expect(closing).rejects.toMatchObject({ code: "desktop_quarantined", message: "desktop_quarantined" });
		await expect(host.close()).rejects.toMatchObject({ code: "desktop_quarantined" });
		expect(host.quarantined).toBe(true);
		await expect(host.native()).resolves.toBe(runtime);
		expect(() => host.openSession()).toThrow();
		expect(runtime.close).toHaveBeenCalledTimes(1);
		expect(factory).toHaveBeenCalledTimes(1);
	});
});
