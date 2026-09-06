import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	PiRpcChildRuntime,
	type PiRpcProcess,
	type PiRpcProcessOptions,
	type PiRpcRuntimeError,
	type PiRpcSpawnProcess,
} from "../src/pi-rpc-runtime.ts";

interface CapturedInvocation {
	command: string;
	args: readonly string[];
	options: PiRpcProcessOptions;
}

class FakeRpcProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly killSignals: NodeJS.Signals[] = [];
	onCommand?: (command: Record<string, unknown>) => void;
	private inputBuffer = "";
	private exited = false;

	constructor(sessionFile = "/sessions/task/session.jsonl") {
		super();
		this.stdin = new Writable({
			write: (chunk: Buffer | string, _encoding, callback) => {
				this.inputBuffer += chunk.toString();
				let newline = this.inputBuffer.indexOf("\n");
				while (newline !== -1) {
					const line = this.inputBuffer.slice(0, newline);
					this.inputBuffer = this.inputBuffer.slice(newline + 1);
					const command = JSON.parse(line) as Record<string, unknown>;
					if (this.onCommand) this.onCommand(command);
					else this.respondDefault(command, sessionFile);
					newline = this.inputBuffer.indexOf("\n");
				}
				callback();
			},
			final: (callback) => {
				queueMicrotask(() => this.emitExit(0, null));
				callback();
			},
		});
	}

	respond(command: Record<string, unknown>, data?: unknown): void {
		this.writeRecord({
			type: "response",
			id: command.id,
			command: command.type,
			success: true,
			...(data === undefined ? {} : { data }),
		});
	}

	respondDefault(command: Record<string, unknown>, sessionFile = "/sessions/task/session.jsonl"): void {
		if (command.type === "get_state") {
			this.respond(command, {
				model: { provider: "fake", id: "fake/model" },
				thinkingLevel: "medium",
				isStreaming: false,
				isCompacting: false,
				sessionFile,
				sessionId: "session-1",
				pendingMessageCount: 0,
			});
			return;
		}
		this.respond(command);
	}

	writeRecord(record: Record<string, unknown>): void {
		this.stdout.write(`${JSON.stringify(record)}\n`);
	}

	emitExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exited) return;
		this.exited = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killSignals.push(signal);
		this.emitExit(null, signal);
		return true;
	}
}

function fakeSpawner(fake: FakeRpcProcess, captured: CapturedInvocation[]): PiRpcSpawnProcess {
	return (command, args, options) => {
		captured.push({ command, args: [...args], options });
		return fake as unknown as PiRpcProcess;
	};
}

async function spawnRuntime(
	fake: FakeRpcProcess,
	captured: CapturedInvocation[] = [],
	limits: {
		requestTimeoutMs?: number;
		shutdownTimeoutMs?: number;
		maxLineBytes?: number;
		maxStdoutBytes?: number;
	} = {},
): Promise<PiRpcChildRuntime> {
	return await PiRpcChildRuntime.spawn({
		invocation: { command: "fake-pi", prefixArgs: ["entrypoint.mjs"] },
		piArgs: ["--provider", "fake", "--model", "fake/model"],
		cwd: "/snapshot",
		env: { LANG: "C.UTF-8" },
		runtimeGeneration: 3,
		sessionDir: "/sessions/task",
		limits: { shutdownTimeoutMs: 10, ...limits },
		spawnProcess: fakeSpawner(fake, captured),
	});
}

describe("PiRpcChildRuntime", () => {
	it("rejects JSON-only profile flags before launching RPC mode", async () => {
		const fake = new FakeRpcProcess();
		await expect(
			PiRpcChildRuntime.spawn({
				invocation: { command: "fake-pi" },
				piArgs: ["--json-profile", "compact"],
				cwd: "/snapshot",
				env: {},
				runtimeGeneration: 1,
				sessionDir: "/sessions/task",
				spawnProcess: fakeSpawner(fake, []),
			}),
		).rejects.toThrow("Pi argument is owned by the RPC runtime: --json-profile");
	});

	it("spawns isolated RPC mode, correlates commands, and publishes ordered events", async () => {
		const fake = new FakeRpcProcess();
		const captured: CapturedInvocation[] = [];
		const runtime = await spawnRuntime(fake, captured);
		const observed: number[] = [];
		runtime.onEvent(() => {
			throw new Error("observer failure must remain isolated");
		});
		runtime.onEvent((event) => observed.push(event.seq));
		fake.onCommand = (command) => {
			fake.respondDefault(command);
			if (command.type !== "prompt") return;
			fake.writeRecord({ type: "turn_start" });
			fake.writeRecord({ type: "agent_settled" });
		};

		const settled = runtime.waitForSettled({ afterSeq: 0, timeoutMs: 100 });
		await runtime.prompt("first line\nsecond line");
		expect((await settled).seq).toBe(2);
		expect(observed).toEqual([1, 2]);
		expect(runtime.metadata).toEqual({
			sessionId: "session-1",
			sessionFile: "/sessions/task/session.jsonl",
			runtimeGeneration: 3,
			lastEventSeq: 2,
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]?.args).toEqual([
			"entrypoint.mjs",
			"--provider",
			"fake",
			"--model",
			"fake/model",
			"--mode",
			"rpc",
			"--session-dir",
			"/sessions/task",
		]);
		expect(captured[0]?.args).not.toContain("--no-session");
		expect(captured[0]?.args).not.toContain("--no-extensions");
		expect(captured[0]?.options).toMatchObject({ cwd: "/snapshot", shell: false, windowsHide: true });
		await runtime.shutdown();
		expect(runtime.closed).toBe(true);
	});

	it("cancels blocking extension UI dialogs without responding to fire-and-forget UI events", async () => {
		const fake = new FakeRpcProcess();
		const runtime = await spawnRuntime(fake);
		const commands: Record<string, unknown>[] = [];
		fake.onCommand = (command) => {
			commands.push(command);
			if (command.type === "extension_ui_response") {
				if (commands.filter((item) => item.type === "extension_ui_response").length === 4) {
					fake.writeRecord({ type: "agent_settled" });
				}
				return;
			}
			fake.respondDefault(command);
			if (command.type !== "prompt") return;
			for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
				fake.writeRecord({ type: "extension_ui_request", id: `fire-${method}`, method });
			}
			for (const method of ["select", "confirm", "input", "editor"]) {
				fake.writeRecord({ type: "extension_ui_request", id: `dialog-${method}`, method });
			}
		};

		const settled = runtime.waitForSettled({ afterSeq: 0, timeoutMs: 100 });
		await runtime.prompt("trigger headless extension dialogs");
		await expect(settled).resolves.toMatchObject({ payload: { type: "agent_settled" } });
		expect(commands.filter((command) => command.type === "extension_ui_response")).toEqual(
			["select", "confirm", "input", "editor"].map((method) => ({
				type: "extension_ui_response",
				id: `dialog-${method}`,
				cancelled: true,
			})),
		);
		await runtime.shutdown();
	});

	it.each([
		["missing id", { type: "extension_ui_request", method: "select" }, "malformed extension UI request id"],
		[
			"unknown method",
			{ type: "extension_ui_request", id: "dialog-unknown", method: "futureDialog" },
			"unsupported extension UI method",
		],
	])("fails closed on a %s instead of waiting for inactivity", async (_name, event, message) => {
		const fake = new FakeRpcProcess();
		const runtime = await spawnRuntime(fake);
		fake.onCommand = (command) => {
			fake.respondDefault(command);
			if (command.type === "prompt") fake.writeRecord(event as Record<string, unknown>);
		};

		const settled = runtime.waitForSettled({ afterSeq: 0, timeoutMs: 100 });
		await runtime.prompt("emit malformed extension UI");
		await expect(settled).rejects.toMatchObject({
			code: "protocol_error",
			message: expect.stringContaining(message),
		});
	});

	it("resets the settled inactivity timeout only for semantic runtime progress", async () => {
		const fake = new FakeRpcProcess();
		const runtime = await spawnRuntime(fake);
		fake.onCommand = (command) => {
			fake.respondDefault(command);
			if (command.type !== "prompt") return;
			setTimeout(
				() =>
					fake.writeRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } }),
				40,
			);
			setTimeout(() => fake.writeRecord({ type: "tool_execution_start", toolCallId: "one" }), 80);
			setTimeout(() => fake.writeRecord({ type: "tool_execution_end", toolCallId: "one" }), 120);
			setTimeout(() => fake.writeRecord({ type: "agent_settled" }), 160);
		};

		const settled = runtime.waitForSettled({ afterSeq: 0, timeoutMs: 100 });
		await runtime.prompt("run beyond one elapsed timeout");
		await expect(settled).resolves.toMatchObject({ seq: 4, payload: { type: "agent_settled" } });
		await runtime.shutdown();
	});

	it("does not let noisy status events keep a settled waiter alive", async () => {
		const fake = new FakeRpcProcess();
		const runtime = await spawnRuntime(fake);
		fake.onCommand = (command) => {
			fake.respondDefault(command);
			if (command.type !== "prompt") return;
			setTimeout(() => fake.writeRecord({ type: "message_update", step: 1 }), 30);
			setTimeout(() => fake.writeRecord({ type: "extension_ui_request", id: "status", method: "setStatus" }), 60);
			setTimeout(() => fake.writeRecord({ type: "message_update", step: 2 }), 90);
		};

		const settled = runtime.waitForSettled({ afterSeq: 0, timeoutMs: 80 });
		await runtime.prompt("emit noise without progress");
		await expect(settled).rejects.toMatchObject({ code: "timeout" });
		await runtime.shutdown();
	});

	it("still times out when no runtime event arrives", async () => {
		const fake = new FakeRpcProcess();
		const runtime = await spawnRuntime(fake);
		fake.onCommand = (command) => {
			fake.respondDefault(command);
		};

		await expect(runtime.waitForSettled({ afterSeq: 0, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
		await runtime.shutdown();
	});

	it("connects a new process generation to an existing session file", async () => {
		const fake = new FakeRpcProcess("/sessions/task/existing.jsonl");
		const captured: CapturedInvocation[] = [];
		const runtime = await PiRpcChildRuntime.connect({
			invocation: { command: "fake-pi" },
			cwd: "/snapshot",
			env: {},
			runtimeGeneration: 4,
			sessionFile: "/sessions/task/existing.jsonl",
			limits: { shutdownTimeoutMs: 10 },
			spawnProcess: fakeSpawner(fake, captured),
		});

		expect(captured[0]?.args).toEqual(["--mode", "rpc", "--session", "/sessions/task/existing.jsonl"]);
		expect(runtime.metadata.runtimeGeneration).toBe(4);
		expect(runtime.metadata.sessionFile).toBe("/sessions/task/existing.jsonl");
		await runtime.shutdown();
	});

	it("correlates concurrent steering and follow-up responses by request id", async () => {
		const fake = new FakeRpcProcess();
		const runtime = await spawnRuntime(fake);
		const commands: Record<string, unknown>[] = [];
		fake.onCommand = (command) => {
			if (command.type === "abort") {
				fake.respond(command);
				return;
			}
			commands.push(command);
			if (commands.length !== 2) return;
			fake.respond(commands[1] as Record<string, unknown>);
			fake.respond(commands[0] as Record<string, unknown>);
		};

		await Promise.all([runtime.steer("change direction"), runtime.followUp("then summarize")]);
		expect(commands.map((command) => command.type)).toEqual(["steer", "follow_up"]);
		await runtime.shutdown();
	});

	it("contains child crashes and rejects pending work with bounded stderr diagnostics", async () => {
		const fake = new FakeRpcProcess();
		const runtime = await spawnRuntime(fake);
		fake.onCommand = (command) => {
			if (command.type !== "prompt") return;
			fake.stderr.write("provider exploded");
			fake.emitExit(17, null);
		};

		await expect(runtime.prompt("run")).rejects.toMatchObject({
			code: "process_error",
			message: expect.stringContaining("provider exploded"),
		});
		expect(runtime.closed).toBe(true);
	});

	it("allows a long valid stream to exceed one stdout burst across time windows", async () => {
		const fake = new FakeRpcProcess();
		const runtime = await spawnRuntime(fake, [], { maxLineBytes: 1024, maxStdoutBytes: 1024 });
		fake.onCommand = (command) => {
			fake.respondDefault(command);
			if (command.type !== "prompt") return;
			for (let index = 0; index < 8; index++) fake.writeRecord({ type: "message_update", step: index });
			setTimeout(() => {
				for (let index = 8; index < 24; index++) fake.writeRecord({ type: "message_update", step: index });
				fake.writeRecord({ type: "agent_settled" });
			}, 1_050);
		};

		const settled = runtime.waitForSettled({ afterSeq: 0, timeoutMs: 1_500 });
		await runtime.prompt("run beyond one stdout window");
		await expect(settled).resolves.toMatchObject({ payload: { type: "agent_settled" } });
		await runtime.shutdown();
	});

	it("fails closed on oversized records, rapid stdout floods, and request timeouts", async () => {
		const oversizedFake = new FakeRpcProcess();
		const oversized = await spawnRuntime(oversizedFake, [], { maxLineBytes: 1024 });
		oversizedFake.onCommand = (command) => {
			if (command.type === "prompt") oversizedFake.stdout.write("x".repeat(1025));
		};
		await expect(oversized.prompt("run")).rejects.toMatchObject({ code: "transport_limit" });

		const floodFake = new FakeRpcProcess();
		const flood = await spawnRuntime(floodFake, [], { maxLineBytes: 1024, maxStdoutBytes: 1024 });
		floodFake.onCommand = (command) => {
			if (command.type !== "prompt") return;
			for (let index = 0; index < 64; index++) floodFake.writeRecord({ type: "message_update", step: index });
		};
		await expect(flood.prompt("flood")).rejects.toMatchObject({ code: "transport_limit" });

		const timeoutFake = new FakeRpcProcess();
		const timed = await spawnRuntime(timeoutFake, [], { requestTimeoutMs: 10 });
		timeoutFake.onCommand = () => {};
		await expect(timed.prompt("run")).rejects.toEqual(
			expect.objectContaining<Partial<PiRpcRuntimeError>>({ code: "timeout" }),
		);
	});
});
