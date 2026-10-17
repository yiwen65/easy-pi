import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

type Command = { id: string; type: string };
let client: RpcClient;
let child: EventEmitter & {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	exitCode: null;
	signalCode: null;
};
let commands: Command[];

beforeEach(async () => {
	vi.useFakeTimers();
	commands = [];
	child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
	});
	child.stdin.on("data", (chunk: Buffer) => {
		commands.push(JSON.parse(chunk.toString()) as Command);
	});
	vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
	client = new RpcClient();
	const starting = client.start();
	await vi.advanceTimersByTimeAsync(100);
	await starting;
});

afterEach(() => {
	child.stdin.destroy();
	child.stdout.destroy();
	child.stderr.destroy();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function respond(success: boolean) {
	const command = commands.at(-1)!;
	child.stdout.write(
		`${JSON.stringify({ id: command.id, type: "response", command: command.type, success, error: success ? undefined : `Rejected ${command.type}`, data: success ? { sessionId: "test" } : undefined })}\n`,
	);
}

describe("RpcClient failed responses", () => {
	it.each([
		["prompt", (c: RpcClient) => c.prompt("hello")],
		["steer", (c: RpcClient) => c.steer("hello")],
		["follow_up", (c: RpcClient) => c.followUp("hello")],
		["abort", (c: RpcClient) => c.abort()],
		["set_thinking_level", (c: RpcClient) => c.setThinkingLevel("high")],
		["set_steering_mode", (c: RpcClient) => c.setSteeringMode("all")],
		["set_follow_up_mode", (c: RpcClient) => c.setFollowUpMode("all")],
		["set_auto_compaction", (c: RpcClient) => c.setAutoCompaction(false)],
		["set_auto_retry", (c: RpcClient) => c.setAutoRetry(false)],
		["abort_retry", (c: RpcClient) => c.abortRetry()],
		["abort_bash", (c: RpcClient) => c.abortBash()],
		["set_session_name", (c: RpcClient) => c.setSessionName("")],
	] as const)("rejects failed %s responses with the server error", async (type, invoke) => {
		const result = invoke(client);
		const assertion = expect(result).rejects.toThrow(`Rejected ${type}`);
		respond(false);
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects promptAndWait immediately and removes its collector on prompt failure", async () => {
		const onEvent = vi.spyOn(client, "onEvent");
		let outcome: unknown;
		void client.promptAndWait("hello").then(
			(events) => {
				outcome = events;
			},
			(error: unknown) => {
				outcome = error;
			},
		);
		const unsubscribe = onEvent.mock.results[0]?.value as () => void;
		respond(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(outcome).toEqual(new Error("Rejected prompt"));
		expect(vi.getTimerCount()).toBe(0);
		// Cancellation has removed the subscription, not just stopped its timer.
		expect((client as unknown as { eventListeners: unknown[] }).eventListeners).toHaveLength(0);
		unsubscribe();
	});

	it("collects synchronous success events even when they arrive before the prompt response", async () => {
		const result = client.promptAndWait("hello");
		child.stdout.write('{"type":"agent_start"}\n{"type":"agent_settled"}\n');
		respond(true);
		await expect(result).resolves.toEqual([{ type: "agent_start" }, { type: "agent_settled" }]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps successful void and data responses working", async () => {
		const prompt = client.prompt("hello");
		respond(true);
		await expect(prompt).resolves.toBeUndefined();
		const state = client.getState();
		respond(true);
		await expect(state).resolves.toEqual({ sessionId: "test" });
		expect(vi.getTimerCount()).toBe(0);
	});
});
