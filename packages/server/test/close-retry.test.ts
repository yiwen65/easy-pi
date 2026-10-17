import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import type { ByteConnectionHandler } from "../src/connection.ts";
import { PiServer } from "../src/index.ts";
import { Deferred, ProtocolTestClient, TestServerService } from "../src/testing/index.ts";

function connectMemory(server: PiServer): ProtocolTestClient {
	let handler: ByteConnectionHandler;
	let closed = false;
	const client = new ProtocolTestClient({
		async send(chunk) {
			handler.onData(chunk);
		},
		async sendFragmented(chunk, splitAt) {
			handler.onData(chunk.subarray(0, splitAt));
			handler.onData(chunk.subarray(splitAt));
		},
		async close() {
			closed = true;
			client.markClosed();
			handler.onClose();
		},
	});
	handler = server.accept({
		get closed() {
			return closed;
		},
		async send(chunk) {
			client.receive(chunk);
		},
		close() {
			closed = true;
			client.markClosed();
		},
	});
	return client;
}

test("retries failed public shutdown after the owner settles and shares concurrent attempts", async () => {
	for (let schedule = 0; schedule < 10; schedule++) {
		const service = new TestServerService();
		service.seed("retained-owner");
		const core = new PiServer(service, { listeners: [] });
		await core.start();
		const client = connectMemory(core);
		await client.hello();
		expect(await client.request({ command: "attach", sessionId: "retained-owner" })).toMatchObject({ ok: true });
		const runtime = service.latestRuntime("retained-owner");
		const originalDispose = runtime.dispose.bind(runtime);
		const setThinking = vi.spyOn(runtime, "setThinking");
		expect(
			await client.request({ command: "set_thinking", sessionId: "retained-owner", thinkingLevel: "high" }),
		).toMatchObject({ ok: true });
		const firstEntered = new Deferred<void>();
		const firstRelease = new Deferred<void>();
		const retryEntered = new Deferred<void>();
		const retryRelease = new Deferred<void>();
		const failure = new Error("physical effect still running; ownership retained");
		let attempts = 0;
		vi.spyOn(runtime, "dispose").mockImplementation(async () => {
			attempts++;
			if (attempts === 1) {
				firstEntered.resolve(undefined);
				await firstRelease.promise;
				throw failure;
			}
			retryEntered.resolve(undefined);
			await retryRelease.promise;
			await originalDispose();
		});
		const first = core.close();
		const joinedFirst = core.close();
		const firstResults = Promise.allSettled([first, joinedFirst]);
		try {
			await firstEntered.promise;
			expect(attempts).toBe(1);
			firstRelease.resolve(undefined);
			expect(await firstResults).toEqual([
				{ status: "rejected", reason: failure },
				{ status: "rejected", reason: failure },
			]);
			expect(service.locked.has("retained-owner")).toBe(true);
			expect(runtime.disposeCount).toBe(0);

			await expect(core.start()).rejects.toThrow();
			const refused = connectMemory(core);
			expect(refused.closed).toBe(true);
			await refused.sendMessage({ type: "request", id: "not-admitted", request: { command: "create" } });
			await client.sendMessage({
				type: "request",
				id: "not-replayed",
				request: { command: "set_thinking", sessionId: "retained-owner", thinkingLevel: "off" },
			});
			expect(service.lastCreatedId).toBeUndefined();
			expect(setThinking).toHaveBeenCalledTimes(1);

			const retry = core.close();
			const joinedRetry = core.close();
			const retries = Promise.all([retry, joinedRetry]);
			await Promise.race([retryEntered.promise, retries]);
			expect(attempts).toBe(2);
			expect(service.locked.has("retained-owner")).toBe(true);
			retryRelease.resolve(undefined);
			await retries;
			expect(service.locked.has("retained-owner")).toBe(false);
			expect(runtime.disposeCount).toBe(1);
			expect(service.runtimes.get("retained-owner")).toHaveLength(1);
			await expect(first).rejects.toBe(failure);
			await core.close();
			expect(attempts).toBe(2);
			expect(setThinking).toHaveBeenCalledTimes(1);
			expect(connectMemory(core).closed).toBe(true);
			await expect(core.start()).rejects.toThrow();
		} finally {
			firstRelease.resolve(undefined);
			retryRelease.resolve(undefined);
			await firstResults;
			await client.close();
			if (service.locked.has("retained-owner")) await originalDispose();
		}
	}
});

test.each([false, true])(
	"drains listener cleanup before exposing a retryable failure (synchronous throw: %s)",
	async (synchronous) => {
		const failure = new Error("listener close failed");
		const slowEntered = new Deferred<void>();
		const slowRelease = new Deferred<void>();
		let fail = true;
		const failedClose = vi.fn(() => {
			if (!fail) return Promise.resolve();
			if (synchronous) throw failure;
			return Promise.reject(failure);
		});
		const slowClose = vi.fn(async () => {
			slowEntered.resolve(undefined);
			await slowRelease.promise;
		});
		const core = new PiServer(new TestServerService(), {
			listeners: [
				{ start: async () => {}, close: failedClose },
				{ start: async () => {}, close: slowClose },
			],
		});
		await core.start();
		let finished = false;
		const closing = core.close();
		const joined = core.close();
		const results = Promise.allSettled([closing, joined]).then((result) => {
			finished = true;
			return result;
		});
		try {
			await Promise.race([slowEntered.promise, results]);
			// An event-loop checkpoint drains the rejection microtasks without releasing the slow close gate.
			await setImmediate();
			expect(slowClose).toHaveBeenCalledTimes(1);
			expect(failedClose).toHaveBeenCalledTimes(1);
			expect(finished).toBe(false);
			slowRelease.resolve(undefined);
			expect(await results).toEqual([
				{ status: "rejected", reason: failure },
				{ status: "rejected", reason: failure },
			]);
			fail = false;
			await Promise.all([core.close(), core.close()]);
			expect(failedClose).toHaveBeenCalledTimes(2);
			expect(slowClose).toHaveBeenCalledTimes(2);
			await core.close();
			expect(failedClose).toHaveBeenCalledTimes(2);
		} finally {
			slowRelease.resolve(undefined);
			await results;
		}
	},
);
