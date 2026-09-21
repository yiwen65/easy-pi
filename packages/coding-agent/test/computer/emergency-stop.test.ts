import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerStopSignal, createComputerSessionBinding, withComputerStop } from "../../src/core/computer/binding.ts";
import { ComputerHost, type ComputerNativeOperation } from "../../src/core/computer/host.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
async function fixture(stopped = false) {
	const stop = new ComputerStopSignal();
	const native = { revoke: vi.fn(), close: vi.fn(async () => {}) };
	const host = new ComputerHost({
		desktopId: "emergency-fixture",
		createRuntime: () => ({ openSession: () => native, close: async () => {} }),
	});
	cleanups.push(() => host.close());
	const dispatch = vi.fn<() => ComputerNativeOperation<string>>(() => ({
		result: Promise.resolve("fulfilled"),
		terminal: Promise.resolve(),
		cancel: vi.fn(),
	}));
	const binding = withComputerStop(
		createComputerSessionBinding(host.openSession(), (capability) => [
			{
				name: "computer",
				label: "Computer",
				description: "Mock ownership only",
				parameters: Type.Object({}),
				executionResource: { key: "desktop:emergency-fixture", mode: "exclusive" },
				execute: async (_id, _args, signal) => ({
					content: [{ type: "text", text: await capability.run(dispatch, signal) }],
					details: { delivered: true },
				}),
			},
		]),
		stop,
	);
	if (stopped) stop.update({ status: "emergency_stopped" });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "computer-stop-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const create = async (computer = binding) => {
		const { session } = await createAgentSession({
			computer,
			modelRuntime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
			}),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(() => session.shutdown());
		return session;
	};
	return { stop, native, host, binding, dispatch, faux, create, session: await create() };
}

describe("host-lifetime Computer stop", () => {
	it("latches independently, isolates listeners, shares across fork/renew, and unsubscribes", async () => {
		const f = await fixture();
		const child = f.binding.fork();
		const renew = f.binding.renew();
		const removed = vi.fn();
		f.stop.subscribe(removed)();
		f.stop.subscribe(() => {
			throw new Error("observer");
		});
		const observed = vi.fn();
		renew.subscribeStop?.(observed);
		f.stop.update({ status: "failed", code: "helper_eof" });
		f.stop.update({ status: "ready", pid: 1, windowId: 2 });
		expect(f.binding.rendererHealth).toEqual({ status: "failed", code: "helper_eof" });
		expect([f.binding.revoked, child.revoked, renew.revoked]).toEqual([true, true, true]);
		expect(removed).not.toHaveBeenCalled();
		expect(observed).toHaveBeenCalledTimes(1);
		expect(() => child.fork()).toThrow("stopped");
		expect(() => renew.renew()).toThrow("stopped");
		const late = vi.fn();
		child.subscribeStop?.(late);
		expect(late).toHaveBeenCalledWith({ status: "failed", code: "helper_eof" });
		await child.close();
		await renew.close();
	});

	it.each(["emergency_stopped", "failed"] as const)(
		"%s aborts the original active tool but preserves fulfilled result and waits for terminal",
		async (status) => {
			const f = await fixture();
			const entered = deferred();
			const terminal = deferred();
			const cancel = vi.fn();
			f.dispatch.mockImplementation(() => {
				entered.resolve();
				return { result: Promise.resolve("fulfilled"), terminal: terminal.promise, cancel };
			});
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("computer", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("must not retry"),
			]);
			const run = f.session.prompt("computer");
			await entered.promise;
			f.stop.update(status === "failed" ? { status, code: "helper_eof" } : { status });
			expect(f.session.agent.signal?.aborted).toBe(true);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(f.host.scheduler.runningCount).toBe(1);
			expect(f.session.getActiveToolNames()).not.toContain("computer");
			terminal.resolve();
			await run;
			const result = f.session.messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({
				isError: false,
				details: { delivered: true },
				content: [{ type: "text", text: "fulfilled" }],
			});
			expect(f.dispatch).toHaveBeenCalledTimes(1);
			expect(f.faux.getPendingResponseCount()).toBe(1);
			expect(f.host.scheduler.runningCount).toBe(0);
		},
	);

	it("stops a model-only stream and the forked AgentSession without a new loop", async () => {
		const f = await fixture();
		const child = await f.create(f.binding.fork());
		const entered = deferred();
		const reply = deferred<ReturnType<typeof fauxAssistantMessage>>();
		f.faux.setResponses([
			async () => {
				entered.resolve();
				return reply.promise;
			},
		]);
		const run = child.prompt("model-only");
		await entered.promise;
		f.stop.update({ status: "emergency_stopped" });
		expect(child.agent.signal?.aborted).toBe(true);
		expect(f.session.computer?.revoked).toBe(true);
		reply.resolve(fauxAssistantMessage("late reply"));
		await run;
		expect(f.dispatch).not.toHaveBeenCalled();
		await expect(child.prompt("retry")).rejects.toThrow(/stopped|replaced/);
	});

	it("already-latched stop blocks startup and replacement renewal", async () => {
		const f = await fixture(true);
		expect(f.session.getActiveToolNames()).not.toContain("computer");
		expect(f.session.revokeComputerForReplacement()()).toBeUndefined();
		await expect(f.session.prompt("start")).rejects.toThrow("stopped");
		expect(f.dispatch).not.toHaveBeenCalled();
	});

	it("stop during replacement drain invalidates the generation guard and reload never reauthorizes", async () => {
		const f = await fixture();
		const renew = f.session.revokeComputerForReplacement();
		f.stop.update({ status: "emergency_stopped" });
		expect(renew()).toBeUndefined();
		await f.session.reload();
		expect(f.session.computer?.revoked).toBe(true);
		expect(f.session.getActiveToolNames()).not.toContain("computer");
	});

	it("lost result never makes stop a terminal proof or triggers replay", async () => {
		const f = await fixture();
		const entered = deferred();
		const result = deferred<string>();
		const terminal = deferred();
		f.dispatch.mockImplementation(() => {
			entered.resolve();
			return { result: result.promise, terminal: terminal.promise, cancel: vi.fn() };
		});
		f.faux.setResponses([fauxAssistantMessage(fauxToolCall("computer", {}), { stopReason: "toolUse" })]);
		const run = f.session.prompt("computer");
		await entered.promise;
		f.stop.update({ status: "emergency_stopped" });
		expect(f.host.scheduler.runningCount).toBe(1);
		result.reject(new Error("lost foreign result"));
		terminal.resolve();
		await run;
		expect(f.dispatch).toHaveBeenCalledTimes(1);
		expect(f.session.messages.find((message) => message.role === "toolResult")).toMatchObject({ isError: true });
	});

	it("disposed AgentSession removes its stop listener", async () => {
		const f = await fixture();
		const renew = f.session.revokeComputerForReplacement();
		const abort = vi.spyOn(f.session.agent, "abort");
		await f.session.shutdown();
		const count = abort.mock.calls.length;
		f.stop.update({ status: "emergency_stopped" });
		expect(abort).toHaveBeenCalledTimes(count);
		expect(renew()).toBeUndefined();
	});

	it("a throwing revoke hook cannot leave the original model stream running", async () => {
		const f = await fixture();
		const broken = await f.create({
			...f.binding,
			get revoked() {
				return f.binding.revoked;
			},
			revoke() {
				throw new Error("broken observer");
			},
		});
		const entered = deferred();
		const reply = deferred<ReturnType<typeof fauxAssistantMessage>>();
		f.faux.setResponses([
			async () => {
				entered.resolve();
				return reply.promise;
			},
		]);
		const run = broken.prompt("model-only");
		await entered.promise;
		f.stop.update({ status: "emergency_stopped" });
		expect(broken.agent.signal?.aborted).toBe(true);
		reply.resolve(fauxAssistantMessage("late reply"));
		await run;
	});

	it("stop aborts in-progress compaction without restoring authority or continuing a turn", async () => {
		const f = await fixture();
		f.faux.setResponses([fauxAssistantMessage("Historical explanation. ".repeat(500))]);
		await f.session.prompt("Prepare history");
		const entered = deferred();
		const reply = deferred<ReturnType<typeof fauxAssistantMessage>>();
		f.faux.setResponses([
			async () => {
				entered.resolve();
				return reply.promise;
			},
		]);
		const compacting = f.session.compact();
		const rejected = expect(compacting).rejects.toThrow(/cancel|abort/i);
		await entered.promise;
		f.stop.update({ status: "emergency_stopped" });
		reply.resolve(
			fauxAssistantMessage("## Conversation timeline\nHistory.\n## Current continuation point\nStopped."),
		);
		await rejected;
		expect(f.session.computer?.revoked).toBe(true);
		expect(f.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(f.dispatch).not.toHaveBeenCalled();
	});
});
