import { EventEmitter, once } from "node:events";
import type { Socket } from "node:net";
import { encodeServerMessage, type ServerHelloError, ServerMessageDecoder } from "@earendil-works/pi-protocol";
import { expect, test, vi } from "vitest";
import { UnixByteConnection } from "../src/transports/unix/listener.ts";

class ControlledSocket extends EventEmitter {
	destroyed = false;
	writable = true;
	writableLength = 0;
	ended = false;
	finalChunk?: Uint8Array;
	readonly chunks: Uint8Array[] = [];
	private writeCallback?: (error?: Error | null) => void;

	write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
		this.writableLength = 1;
		this.writeCallback = callback;
		this.chunks.push(chunk.slice());
		this.emit("write");
		return false;
	}

	end(chunk?: Uint8Array): this {
		this.ended = true;
		this.finalChunk = chunk?.slice();
		if (chunk) this.chunks.push(chunk.slice());
		this.emit("end");
		return this;
	}

	destroy(): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		this.writable = false;
		this.emit("close");
		return this;
	}

	completeWrite(): void {
		const callback = this.writeCallback;
		if (!callback) throw new Error("No pending write");
		this.writeCallback = undefined;
		this.writableLength = 0;
		callback(null);
	}
}

test.each([false, true])("drains all admitted sends before close (first write started: %s)", async (started) => {
	for (let attempt = 0; attempt < 10; attempt++) {
		const socket = new ControlledSocket();
		const connection = new UnixByteConnection(socket as unknown as Socket, 1_000, 64 * 1024);
		const firstStarted = once(socket, "write");
		const first = connection.send(new Uint8Array([1]));
		const second = connection.send(new Uint8Array([2]));
		const settled = Promise.allSettled([first, second]);
		if (started) await firstStarted;
		const closing = connection.close(new Uint8Array([3]));
		try {
			await expect(connection.send(new Uint8Array([4]))).rejects.toThrow("closed");
			await Promise.race([firstStarted, first]);
			const secondStarted = once(socket, "write");
			socket.completeWrite();
			await first;
			await Promise.race([secondStarted, second]);
			const ended = once(socket, "end");
			socket.completeWrite();
			await second;
			await ended;
			expect(socket.chunks.map((chunk) => [...chunk])).toEqual([[1], [2], [3]]);
		} finally {
			socket.destroy();
			connection.markClosed();
			await closing;
			await settled;
		}
	}
});

test("bounds graceful drain by the close timeout", async () => {
	vi.useFakeTimers();
	const socket = new ControlledSocket();
	const connection = new UnixByteConnection(socket as unknown as Socket, 1_000, 64 * 1024);
	try {
		const started = once(socket, "write");
		const first = connection.send(new Uint8Array([1]));
		const second = connection.send(new Uint8Array([2]));
		const settled = Promise.allSettled([first, second]);
		await started;
		const closing = connection.close(new Uint8Array([3]));
		await vi.advanceTimersByTimeAsync(1_000);
		await closing;
		expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(connection.closed).toBe(true);
		expect(socket.chunks.map((chunk) => [...chunk])).toEqual([[1]]);
	} finally {
		socket.destroy();
		vi.useRealTimers();
	}
});

test("queues a final protocol error behind pending output before closing", async () => {
	const socket = new ControlledSocket();
	const connection = new UnixByteConnection(socket as unknown as Socket, 1_000, 64 * 1024);
	const pendingWrite = connection.send(new Uint8Array([1, 2, 3]));
	await vi.waitFor(() => expect(socket.writableLength).toBe(1));
	const finalMessage: ServerHelloError = {
		type: "hello_error",
		error: { code: "invalid_request", message: "Protocol violation" },
	};
	const closing = connection.close(encodeServerMessage(finalMessage));

	expect(socket.ended).toBe(false);
	expect(socket.destroyed).toBe(false);

	socket.completeWrite();
	await pendingWrite;
	await vi.waitFor(() => expect(socket.ended).toBe(true));
	expect(new ServerMessageDecoder().push(socket.finalChunk!)).toEqual([finalMessage]);

	connection.markClosed();
	await closing;
});
