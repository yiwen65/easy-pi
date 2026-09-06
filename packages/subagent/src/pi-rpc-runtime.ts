import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
	ChildAgentRuntime,
	ChildAgentRuntimeEvent,
	ChildAgentRuntimeEventListener,
	ChildAgentRuntimeFactory,
	ChildAgentRuntimeMetadata,
	ChildAgentRuntimeState,
	ChildAgentRuntimeWaitOptions,
	ChildStreamingBehavior,
} from "./child-agent-runtime.ts";

const DEFAULT_LIMITS = {
	requestTimeoutMs: 15_000,
	shutdownTimeoutMs: 1_000,
	maxLineBytes: 1024 * 1024,
	maxStdoutBytes: 16 * 1024 * 1024,
	maxStderrBytes: 32 * 1024,
} as const;
const STDOUT_ALLOWANCE_REFILL_MS = 1_000;

function isSemanticProgressEvent(payload: Readonly<Record<string, unknown>>): boolean {
	if (
		["agent_start", "message_start", "message_end", "tool_execution_start", "tool_execution_end"].includes(
			String(payload.type),
		)
	) {
		return true;
	}
	if (payload.type !== "message_update") return false;
	const update = payload.assistantMessageEvent;
	if (!update || typeof update !== "object" || Array.isArray(update)) return false;
	const event = update as Record<string, unknown>;
	return (
		["text_delta", "thinking_delta"].includes(String(event.type)) &&
		typeof event.delta === "string" &&
		event.delta.length > 0
	);
}

const RESERVED_PI_ARGS = new Set([
	"--mode",
	"--json-profile",
	"--session",
	"--session-dir",
	"--no-session",
	"--print",
	"-p",
]);
const EXTENSION_UI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const EXTENSION_UI_FIRE_AND_FORGET_METHODS = new Set([
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
]);

export type PiRpcRuntimeErrorCode =
	| "closed"
	| "command_error"
	| "process_error"
	| "protocol_error"
	| "timeout"
	| "transport_limit";

export class PiRpcRuntimeError extends Error {
	readonly code: PiRpcRuntimeErrorCode;

	constructor(code: PiRpcRuntimeErrorCode, message: string) {
		super(message);
		this.name = "PiRpcRuntimeError";
		this.code = code;
	}
}

export interface PiRpcInvocation {
	command: string;
	/** Arguments before controller-owned Pi arguments, for packaged entrypoints. */
	prefixArgs?: readonly string[];
}

export interface PiRpcProcess {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	readonly pid?: number;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface PiRpcProcessOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: false;
	detached: boolean;
	stdio: ["pipe", "pipe", "pipe"];
	windowsHide: true;
}

export type PiRpcSpawnProcess = (
	command: string,
	args: readonly string[],
	options: PiRpcProcessOptions,
) => PiRpcProcess;

export interface PiRpcRuntimeLimits {
	requestTimeoutMs: number;
	shutdownTimeoutMs: number;
	maxLineBytes: number;
	/** Maximum immediate stdout burst, replenished at this many bytes per second. */
	maxStdoutBytes: number;
	maxStderrBytes: number;
}

interface PiRpcRuntimeBaseOptions {
	invocation: PiRpcInvocation;
	/** Trusted controller-owned Pi flags. RPC/session/print flags are rejected. */
	piArgs?: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	runtimeGeneration: number;
	limits?: Partial<PiRpcRuntimeLimits>;
	/** Test seam; production callers should leave this unset. */
	spawnProcess?: PiRpcSpawnProcess;
}

export interface SpawnPiRpcRuntimeOptions extends PiRpcRuntimeBaseOptions {
	/** Dedicated storage directory for this task, never shared with the parent Pi. */
	sessionDir: string;
}

export interface ConnectPiRpcRuntimeOptions extends PiRpcRuntimeBaseOptions {
	/** Existing task-owned session file used to cold-restart a child generation. */
	sessionFile: string;
}

interface RpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

interface PendingRequest {
	command: string;
	resolve(value: Record<string, unknown>): void;
	reject(error: PiRpcRuntimeError): void;
	timer: ReturnType<typeof setTimeout>;
}

interface SettledWaiter {
	afterSeq: number;
	resolve(event: ChildAgentRuntimeEvent): void;
	reject(error: PiRpcRuntimeError): void;
	timeoutMs?: number;
	timer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function validateText(value: string, name: string): void {
	if (!value || /[\0\r\n]/.test(value)) throw new Error(`${name} must be non-empty and contain no record delimiters`);
}

function validateMessage(value: string, name: string): void {
	if (!value || value.includes("\0")) throw new Error(`${name} must be non-empty and contain no NUL byte`);
}

function runtimeLimits(overrides: Partial<PiRpcRuntimeLimits> | undefined): PiRpcRuntimeLimits {
	const limits = { ...DEFAULT_LIMITS, ...overrides };
	for (const [name, value] of Object.entries(limits)) validatePositiveInteger(value, name);
	return limits;
}

function validatePiArgs(args: readonly string[]): void {
	for (const value of args) {
		if (/[\0\r\n]/.test(value)) throw new Error("Pi arguments cannot contain record delimiters");
		if (RESERVED_PI_ARGS.has(value) || [...RESERVED_PI_ARGS].some((name) => value.startsWith(`${name}=`))) {
			throw new Error(`Pi argument is owned by the RPC runtime: ${value}`);
		}
	}
}

function defaultSpawnProcess(command: string, args: readonly string[], options: PiRpcProcessOptions): PiRpcProcess {
	return spawn(command, [...args], options) as ChildProcessWithoutNullStreams;
}

function stateFromResponse(value: Record<string, unknown>): Omit<
	ChildAgentRuntimeState,
	keyof ChildAgentRuntimeMetadata
> & {
	sessionId: string;
	sessionFile?: string;
} {
	const data = value.data;
	if (
		!isRecord(data) ||
		typeof data.sessionId !== "string" ||
		!data.sessionId ||
		(data.sessionFile !== undefined && typeof data.sessionFile !== "string") ||
		data.sessionFile === "" ||
		typeof data.thinkingLevel !== "string" ||
		typeof data.isStreaming !== "boolean" ||
		typeof data.isCompacting !== "boolean" ||
		typeof data.pendingMessageCount !== "number" ||
		!Number.isSafeInteger(data.pendingMessageCount) ||
		data.pendingMessageCount < 0
	) {
		throw new PiRpcRuntimeError("protocol_error", "get_state returned malformed session state");
	}
	return {
		sessionId: data.sessionId,
		...(data.sessionFile === undefined ? {} : { sessionFile: data.sessionFile }),
		model: data.model === undefined ? null : data.model,
		thinkingLevel: data.thinkingLevel,
		isStreaming: data.isStreaming,
		isCompacting: data.isCompacting,
		pendingMessageCount: data.pendingMessageCount,
	};
}

export class PiRpcChildRuntime implements ChildAgentRuntime {
	private readonly child: PiRpcProcess;
	private readonly limits: PiRpcRuntimeLimits;
	private readonly generation: number;
	private readonly listeners = new Set<ChildAgentRuntimeEventListener>();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly settledWaiters = new Set<SettledWaiter>();
	private readonly exitPromise: Promise<void>;
	private resolveExit: () => void = () => {};
	private requestCounter = 0;
	private stdoutAllowance: number;
	private stdoutAllowanceUpdatedAt: number;
	private stderrBytes = 0;
	private stdoutBuffer = Buffer.alloc(0);
	private stderrText = "";
	private eventSeq = 0;
	private latestSettled?: ChildAgentRuntimeEvent;
	private sessionId = "";
	private sessionFile?: string;
	private terminalError?: PiRpcRuntimeError;
	private isClosing = false;
	private isClosed = false;

	private constructor(child: PiRpcProcess, generation: number, limits: PiRpcRuntimeLimits) {
		this.child = child;
		this.generation = generation;
		this.limits = limits;
		this.stdoutAllowance = limits.maxStdoutBytes;
		this.stdoutAllowanceUpdatedAt = Date.now();
		this.exitPromise = new Promise<void>((resolve) => {
			this.resolveExit = resolve;
		});
		this.attachProcessHandlers();
	}

	static async spawn(options: SpawnPiRpcRuntimeOptions): Promise<PiRpcChildRuntime> {
		validateText(options.sessionDir, "sessionDir");
		return await PiRpcChildRuntime.launch(options, ["--session-dir", options.sessionDir]);
	}

	static async connect(options: ConnectPiRpcRuntimeOptions): Promise<PiRpcChildRuntime> {
		validateText(options.sessionFile, "sessionFile");
		return await PiRpcChildRuntime.launch(options, ["--session", options.sessionFile]);
	}

	private static async launch(
		options: PiRpcRuntimeBaseOptions,
		sessionArgs: readonly string[],
	): Promise<PiRpcChildRuntime> {
		validateText(options.invocation.command, "invocation command");
		validatePositiveInteger(options.runtimeGeneration, "runtimeGeneration");
		validatePiArgs(options.invocation.prefixArgs ?? []);
		validatePiArgs(options.piArgs ?? []);
		const limits = runtimeLimits(options.limits);
		const args = [
			...(options.invocation.prefixArgs ?? []),
			...(options.piArgs ?? []),
			"--mode",
			"rpc",
			...sessionArgs,
		];
		const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		let child: PiRpcProcess;
		try {
			child = spawnProcess(options.invocation.command, args, {
				cwd: options.cwd,
				env: { ...options.env },
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new PiRpcRuntimeError("process_error", `Failed to spawn child Pi RPC process: ${message}`);
		}

		const runtime = new PiRpcChildRuntime(child, options.runtimeGeneration, limits);
		try {
			await runtime.getState();
			return runtime;
		} catch (error) {
			await runtime.shutdown();
			throw error;
		}
	}

	get metadata(): ChildAgentRuntimeMetadata {
		return {
			sessionId: this.sessionId,
			...(this.sessionFile === undefined ? {} : { sessionFile: this.sessionFile }),
			runtimeGeneration: this.generation,
			lastEventSeq: this.eventSeq,
		};
	}

	get closed(): boolean {
		return this.isClosed;
	}

	async prompt(message: string, streamingBehavior?: ChildStreamingBehavior): Promise<void> {
		validateMessage(message, "prompt message");
		await this.sendCommand({
			type: "prompt",
			message,
			...(streamingBehavior === undefined ? {} : { streamingBehavior }),
		});
	}

	async steer(message: string): Promise<void> {
		validateMessage(message, "steering message");
		await this.sendCommand({ type: "steer", message });
	}

	async followUp(message: string): Promise<void> {
		validateMessage(message, "follow-up message");
		await this.sendCommand({ type: "follow_up", message });
	}

	async abort(): Promise<void> {
		await this.sendCommand({ type: "abort" });
	}

	async getState(): Promise<ChildAgentRuntimeState> {
		const response = await this.sendCommand({ type: "get_state" });
		let state: ReturnType<typeof stateFromResponse>;
		try {
			state = stateFromResponse(response);
		} catch (error) {
			const normalized =
				error instanceof PiRpcRuntimeError
					? error
					: new PiRpcRuntimeError("protocol_error", "get_state returned malformed session state");
			this.fail(normalized);
			throw normalized;
		}
		this.sessionId = state.sessionId;
		this.sessionFile = state.sessionFile;
		return {
			...state,
			runtimeGeneration: this.generation,
			lastEventSeq: this.eventSeq,
		};
	}

	onEvent(listener: ChildAgentRuntimeEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	waitForSettled(options: ChildAgentRuntimeWaitOptions = {}): Promise<ChildAgentRuntimeEvent> {
		const afterSeq = options.afterSeq ?? this.eventSeq;
		if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
			return Promise.reject(new PiRpcRuntimeError("protocol_error", "afterSeq must be a non-negative integer"));
		}
		if (this.latestSettled && this.latestSettled.seq > afterSeq) return Promise.resolve(this.latestSettled);
		if (this.terminalError) return Promise.reject(this.terminalError);
		if (this.isClosed) return Promise.reject(new PiRpcRuntimeError("closed", "Child Pi RPC runtime is closed"));

		return new Promise<ChildAgentRuntimeEvent>((resolve, reject) => {
			if (options.timeoutMs !== undefined) validatePositiveInteger(options.timeoutMs, "settled timeoutMs");
			const waiter: SettledWaiter = {
				afterSeq,
				resolve,
				reject,
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				...(options.signal === undefined ? {} : { signal: options.signal }),
			};
			this.settledWaiters.add(waiter);
			this.resetSettledWaiterTimeout(waiter);
			if (options.signal) {
				waiter.onAbort = () => {
					this.removeWaiter(waiter);
					reject(new PiRpcRuntimeError("closed", "Waiting for agent_settled was aborted"));
				};
				if (options.signal.aborted) {
					waiter.onAbort();
					return;
				}
				options.signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
		});
	}

	async shutdown(): Promise<void> {
		if (this.isClosed) return;
		if (!this.isClosing && !this.terminalError) {
			try {
				await this.sendCommand(
					{ type: "abort" },
					Math.min(this.limits.requestTimeoutMs, this.limits.shutdownTimeoutMs),
				);
			} catch {
				// Shutdown remains best-effort after a rejected/late abort response.
			}
		}
		this.isClosing = true;
		try {
			this.child.stdin.end();
		} catch {
			this.terminate("SIGTERM");
		}
		if (await this.waitForExit(this.limits.shutdownTimeoutMs)) return;
		this.terminate("SIGTERM");
		if (await this.waitForExit(this.limits.shutdownTimeoutMs)) return;
		this.terminate("SIGKILL");
		this.close(new PiRpcRuntimeError("closed", "Child Pi RPC runtime was shut down"));
	}

	private async sendCommand(
		command: RpcCommand,
		requestTimeoutMs = this.limits.requestTimeoutMs,
	): Promise<Record<string, unknown>> {
		if (this.terminalError) throw this.terminalError;
		if (this.isClosing || this.isClosed) throw new PiRpcRuntimeError("closed", "Child Pi RPC runtime is closed");
		const id = `rpc-${this.generation}-${++this.requestCounter}`;
		const record = { ...command, id };
		let serialized: string;
		try {
			serialized = `${JSON.stringify(record)}\n`;
		} catch {
			throw new PiRpcRuntimeError("protocol_error", `Unable to serialize RPC command: ${command.type}`);
		}
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new PiRpcRuntimeError(
					"timeout",
					`Timed out waiting for ${command.type} response after ${requestTimeoutMs}ms`,
				);
				this.fail(error);
			}, requestTimeoutMs);
			timer.unref();
			this.pending.set(id, { command: command.type, resolve, reject, timer });
			try {
				this.child.stdin.write(serialized, "utf8", (error) => {
					if (!error) return;
					this.fail(
						new PiRpcRuntimeError("process_error", `Failed to write ${command.type} command: ${error.message}`),
					);
				});
			} catch (error) {
				this.fail(
					new PiRpcRuntimeError(
						"process_error",
						`Failed to write ${command.type} command: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
		});
	}

	private attachProcessHandlers(): void {
		this.child.stdout.on("data", (chunk: Buffer | string) => {
			try {
				this.consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			} catch (error) {
				const normalized =
					error instanceof PiRpcRuntimeError
						? error
						: new PiRpcRuntimeError("protocol_error", error instanceof Error ? error.message : String(error));
				this.fail(normalized);
			}
		});
		this.child.stderr.on("data", (chunk: Buffer | string) => {
			try {
				this.consumeStderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			} catch (error) {
				this.fail(
					error instanceof PiRpcRuntimeError
						? error
						: new PiRpcRuntimeError("transport_limit", error instanceof Error ? error.message : String(error)),
				);
			}
		});
		const streamError = (source: string) => (error: Error) => {
			this.fail(new PiRpcRuntimeError("process_error", `Child Pi RPC ${source} failed: ${error.message}`));
		};
		this.child.stdin.on("error", streamError("stdin"));
		this.child.stdout.on("error", streamError("stdout"));
		this.child.stderr.on("error", streamError("stderr"));
		this.child.on("error", (error) => {
			const failure = new PiRpcRuntimeError("process_error", `Child Pi RPC process failed: ${error.message}`);
			this.fail(failure);
			this.close(failure);
		});
		this.child.on("exit", (code, signal) => {
			if (this.isClosing) {
				this.close(new PiRpcRuntimeError("closed", "Child Pi RPC runtime exited"));
				return;
			}
			if (this.terminalError) {
				this.close(this.terminalError);
				return;
			}
			const stderr = this.stderrText.trim();
			const suffix = stderr ? `: ${stderr}` : "";
			const failure = new PiRpcRuntimeError(
				"process_error",
				`Child Pi RPC process exited unexpectedly (code=${String(code)}, signal=${String(signal)})${suffix}`,
			);
			this.fail(failure);
			this.close(failure);
		});
	}

	private consumeStdout(chunk: Buffer): void {
		if (this.terminalError || this.isClosed) return;
		const now = Date.now();
		const elapsedMs = Math.max(0, now - this.stdoutAllowanceUpdatedAt);
		this.stdoutAllowanceUpdatedAt = now;
		this.stdoutAllowance = Math.min(
			this.limits.maxStdoutBytes,
			this.stdoutAllowance + (elapsedMs * this.limits.maxStdoutBytes) / STDOUT_ALLOWANCE_REFILL_MS,
		);
		if (chunk.byteLength > this.stdoutAllowance) {
			throw new PiRpcRuntimeError(
				"transport_limit",
				`Child Pi RPC exceeded stdout burst limit (${this.limits.maxStdoutBytes} bytes per second)`,
			);
		}
		this.stdoutAllowance -= chunk.byteLength;
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
		let newline = this.stdoutBuffer.indexOf(0x0a);
		while (newline !== -1) {
			if (newline > this.limits.maxLineBytes) {
				throw new PiRpcRuntimeError(
					"transport_limit",
					`Child Pi RPC exceeded line limit (${this.limits.maxLineBytes} bytes)`,
				);
			}
			let line = this.stdoutBuffer.subarray(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
			if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
			this.processLine(line);
			newline = this.stdoutBuffer.indexOf(0x0a);
		}
		if (this.stdoutBuffer.byteLength > this.limits.maxLineBytes) {
			throw new PiRpcRuntimeError(
				"transport_limit",
				`Child Pi RPC exceeded line limit (${this.limits.maxLineBytes} bytes)`,
			);
		}
	}

	private consumeStderr(chunk: Buffer): void {
		if (this.terminalError || this.isClosed) return;
		this.stderrBytes += chunk.byteLength;
		if (this.stderrBytes > this.limits.maxStderrBytes) {
			throw new PiRpcRuntimeError(
				"transport_limit",
				`Child Pi RPC exceeded stderr limit (${this.limits.maxStderrBytes} bytes)`,
			);
		}
		this.stderrText += chunk.toString("utf8");
	}

	private processLine(line: Buffer): void {
		if (line.byteLength === 0)
			throw new PiRpcRuntimeError("protocol_error", "Child Pi RPC emitted an empty JSONL record");
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new PiRpcRuntimeError("protocol_error", `Child Pi RPC emitted malformed JSON: ${message}`);
		}
		if (!isRecord(value) || typeof value.type !== "string") {
			throw new PiRpcRuntimeError("protocol_error", "Child Pi RPC record must be an object with a string type");
		}
		if (value.type === "response") {
			this.processResponse(value);
			return;
		}
		this.publishEvent(value);
	}

	private processResponse(response: Record<string, unknown>): void {
		if (
			typeof response.id !== "string" ||
			typeof response.command !== "string" ||
			typeof response.success !== "boolean"
		) {
			throw new PiRpcRuntimeError("protocol_error", "Child Pi RPC emitted a malformed correlated response");
		}
		const pending = this.pending.get(response.id);
		if (!pending)
			throw new PiRpcRuntimeError("protocol_error", `Child Pi RPC responded with unknown id: ${response.id}`);
		if (pending.command !== response.command) {
			throw new PiRpcRuntimeError(
				"protocol_error",
				`Child Pi RPC response command mismatch for ${response.id}: expected ${pending.command}, got ${response.command}`,
			);
		}
		this.pending.delete(response.id);
		clearTimeout(pending.timer);
		if (!response.success) {
			pending.reject(
				new PiRpcRuntimeError(
					"command_error",
					typeof response.error === "string" ? response.error : `${response.command} command failed`,
				),
			);
			return;
		}
		pending.resolve(response);
	}

	private publishEvent(payload: Record<string, unknown>): void {
		const extensionUiResponse = this.extensionUiResponse(payload);
		const event: ChildAgentRuntimeEvent = {
			seq: ++this.eventSeq,
			runtimeGeneration: this.generation,
			payload,
		};
		if (payload.type === "agent_settled") {
			this.latestSettled = event;
			for (const waiter of [...this.settledWaiters]) {
				if (event.seq <= waiter.afterSeq) continue;
				this.removeWaiter(waiter);
				waiter.resolve(event);
			}
		} else if (isSemanticProgressEvent(payload)) {
			for (const waiter of this.settledWaiters) {
				if (event.seq > waiter.afterSeq) this.resetSettledWaiterTimeout(waiter);
			}
		}
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Observer failures are outside the child protocol and cannot crash the parent.
			}
		}
		if (extensionUiResponse) this.writeUncorrelated(extensionUiResponse);
	}

	private extensionUiResponse(payload: Record<string, unknown>): Record<string, unknown> | undefined {
		if (payload.type !== "extension_ui_request") return undefined;
		if (typeof payload.id !== "string" || !payload.id || /[\0\r\n]/.test(payload.id)) {
			throw new PiRpcRuntimeError("protocol_error", "Child Pi RPC emitted a malformed extension UI request id");
		}
		if (typeof payload.method !== "string") {
			throw new PiRpcRuntimeError("protocol_error", "Child Pi RPC emitted an extension UI request without a method");
		}
		if (EXTENSION_UI_FIRE_AND_FORGET_METHODS.has(payload.method)) return undefined;
		if (!EXTENSION_UI_DIALOG_METHODS.has(payload.method)) {
			throw new PiRpcRuntimeError(
				"protocol_error",
				`Child Pi RPC emitted an unsupported extension UI method: ${payload.method}`,
			);
		}
		return { type: "extension_ui_response", id: payload.id, cancelled: true };
	}

	private writeUncorrelated(record: Record<string, unknown>): void {
		let serialized: string;
		try {
			serialized = `${JSON.stringify(record)}\n`;
		} catch {
			throw new PiRpcRuntimeError("protocol_error", "Unable to serialize extension UI response");
		}
		try {
			this.child.stdin.write(serialized, "utf8", (error) => {
				if (!error) return;
				this.fail(
					new PiRpcRuntimeError("process_error", `Failed to write extension UI response: ${error.message}`),
				);
			});
		} catch (error) {
			throw new PiRpcRuntimeError(
				"process_error",
				`Failed to write extension UI response: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private resetSettledWaiterTimeout(waiter: SettledWaiter): void {
		if (waiter.timeoutMs === undefined) return;
		if (waiter.timer) clearTimeout(waiter.timer);
		waiter.timer = setTimeout(() => {
			this.removeWaiter(waiter);
			waiter.reject(
				new PiRpcRuntimeError(
					"timeout",
					`Timed out waiting for agent_settled after ${waiter.timeoutMs}ms of child inactivity`,
				),
			);
		}, waiter.timeoutMs);
		waiter.timer.unref();
	}

	private removeWaiter(waiter: SettledWaiter): void {
		this.settledWaiters.delete(waiter);
		if (waiter.timer) clearTimeout(waiter.timer);
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}

	private fail(error: PiRpcRuntimeError): void {
		if (this.terminalError || this.isClosed) return;
		this.terminalError = error;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of [...this.settledWaiters]) {
			this.removeWaiter(waiter);
			waiter.reject(error);
		}
		this.terminate("SIGTERM");
	}

	private close(error: PiRpcRuntimeError): void {
		if (this.isClosed) return;
		this.isClosed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of [...this.settledWaiters]) {
			this.removeWaiter(waiter);
			waiter.reject(error);
		}
		this.resolveExit();
	}

	private terminate(signal: NodeJS.Signals): void {
		if (this.isClosed) return;
		if (process.platform !== "win32" && this.child.pid !== undefined) {
			try {
				process.kill(-this.child.pid, signal);
				return;
			} catch {
				// Fall back to direct child signaling when no process group exists.
			}
		}
		try {
			this.child.kill(signal);
		} catch {
			// Exit/error handlers remain authoritative.
		}
	}

	private async waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.isClosed) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
			timer.unref();
		});
		const exited = this.exitPromise.then(() => true);
		const result = await Promise.race([exited, timeout]);
		if (timer) clearTimeout(timer);
		return result;
	}
}

export const piRpcChildRuntimeFactory: ChildAgentRuntimeFactory<SpawnPiRpcRuntimeOptions, ConnectPiRpcRuntimeOptions> =
	{
		spawn: PiRpcChildRuntime.spawn,
		connect: PiRpcChildRuntime.connect,
	};
