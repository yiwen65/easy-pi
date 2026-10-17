import { EventEmitter } from "node:events";
import process from "node:process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION, McpClient, StdioTransport } from "../src/index.ts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("cross-spawn", () => ({ default: spawn }));
let cleanup: (() => Promise<void>) | undefined;

function mockChild(groupAlive = false) {
	const child = Object.assign(new EventEmitter(), {
		pid: 123_456_789,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	});
	spawn.mockReturnValue(child);
	const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		expect(pid).toBe(-child.pid);
		if (!groupAlive) throw Object.assign(new Error("group gone"), { code: "ESRCH" });
		if (signal === "SIGKILL") groupAlive = false;
		return true;
	});
	const exit = () => {
		child.exitCode = 0;
		child.emit("exit", 0, null);
	};
	const transport = new StdioTransport({ command: "mock-mcp-server", closeTimeoutMs: 50 });
	cleanup = async () => {
		// Always retire the mocked group before restoring process.kill, including on assertion failures.
		groupAlive = false;
		exit();
		const closed = transport.close().catch(() => {});
		child.emit("close", 0, null);
		await vi.advanceTimersByTimeAsync(1_100);
		await closed;
	};
	return { child, transport, kill, exit };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe.skipIf(process.platform === "win32")("stdio exit and output ordering", () => {
	it.each([0, 10, 80])("drains final stdout before closing after %i ms of queued I/O", async (delay) => {
		const { child, transport, kill, exit } = mockChild();
		const events: string[] = [];
		transport.onMessage(() => events.push("message"));
		transport.onClose(() => events.push("close"));
		const started = transport.start();
		child.emit("spawn");
		await started;
		try {
			exit();
			const first = transport.close();
			const second = transport.close();
			expect(first).toBe(second);
			let settled = false;
			void first.then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(delay);
			expect.soft(events).toEqual([]);
			expect.soft(settled).toBe(false);
			child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } })}\n`);
			child.emit("close", 0, null);
			await vi.advanceTimersByTimeAsync(10);
			await Promise.all([first, second]);
			expect(events).toEqual(["message", "close"]);
			// Once ESRCH proves this group gone, no subsequent probe or signal may reuse its identity.
			expect(kill.mock.calls).toEqual([[-child.pid, 0]]);
			expect(child.kill).not.toHaveBeenCalled();
		} finally {
			child.emit("close", 0, null);
			await vi.advanceTimersByTimeAsync(10);
			await transport.close();
		}
	});

	it.each([0, 10, 80])("resolves a pending client request with the final response after %i ms", async (delay) => {
		const { child, transport, exit } = mockChild();
		const requests: JsonRpcRequest[] = [];
		child.stdin.on("data", (chunk: Buffer) => {
			const message = JSON.parse(chunk.toString()) as JsonRpcRequest;
			requests.push(message);
			if (message.method === "initialize") {
				child.stdout.write(
					`${JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: {},
							serverInfo: { name: "mock", version: "1" },
						},
					})}\n`,
				);
			}
		});
		const client = new McpClient({ name: "test", version: "1" });
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		const connected = client.connect(transport);
		child.emit("spawn");
		await connected;
		try {
			const result = { content: [{ type: "text", text: "final result" }] };
			const pending = client.callTool("last").catch((error: unknown) => error);
			const request = requests.find((message) => message.method === "tools/call");
			expect(request).toBeDefined();
			exit();
			await vi.advanceTimersByTimeAsync(delay);
			child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request?.id, result })}\n`);
			child.emit("close", 0, null);
			await vi.advanceTimersByTimeAsync(10);
			expect(await pending).toEqual(result);
			expect(errors).toEqual([]);
			expect(client.connectionState).toBe("closed");
		} finally {
			child.emit("close", 0, null);
			await vi.advanceTimersByTimeAsync(10);
			await client.close();
		}
	});

	it("keeps shared cleanup pending after stdio closes until the surviving group is killed", async () => {
		const { child, transport, kill, exit } = mockChild(true);
		const started = transport.start();
		child.emit("spawn");
		await started;
		exit();
		const first = transport.close();
		const second = transport.close();
		expect(first).toBe(second);
		let settled = false;
		void second.then(() => {
			settled = true;
		});
		child.emit("close", 0, null);
		await vi.advanceTimersByTimeAsync(40);
		expect(settled).toBe(false);
		expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-child.pid, "SIGTERM"]]);
		await vi.advanceTimersByTimeAsync(20);
		await Promise.all([first, second]);
		expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
			[-child.pid, "SIGTERM"],
			[-child.pid, "SIGKILL"],
		]);
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("bounds the wait for stdio close even when the leader and group are already gone", async () => {
		const { child, transport, kill, exit } = mockChild();
		const closed = vi.fn();
		transport.onClose(closed);
		const started = transport.start();
		child.emit("spawn");
		await started;
		exit();
		const cleanup = transport.close().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(1_100);
		expect(await cleanup).toMatchObject({ message: "MCP stdio streams did not close after process exit" });
		expect(closed).toHaveBeenCalledTimes(1);
		expect(kill.mock.calls).toEqual([[-child.pid, 0]]);
		expect(child.kill).not.toHaveBeenCalled();
		expect(child.listenerCount("close")).toBe(1);
		child.emit("close", 0, null);
		expect(closed).toHaveBeenCalledTimes(1);
	});
});
