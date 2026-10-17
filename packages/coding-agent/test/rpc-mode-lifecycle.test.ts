import { PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, ExtensionBindings, PromptOptions } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../src/core/task-recovery.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import * as shell from "../src/utils/shell.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const io = vi.hoisted(() => ({
	lines: [] as string[],
	flush: vi.fn(async () => {}),
	backpressure: vi.fn(async () => {}),
}));
vi.mock("../src/core/output-guard.ts", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => io.lines.push(line),
	flushRawStdout: io.flush,
	waitForRawStdoutBackpressure: io.backpressure,
}));
vi.mock("../src/modes/interactive/theme/theme.ts", () => ({ theme: {} }));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createSession(onBind?: (bindings: ExtensionBindings) => Promise<void>) {
	let bindings: ExtensionBindings | undefined;
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		isIdle: true,
		isStreaming: false,
		isCompacting: false,
		messages: [],
		pendingMessageCount: 0,
		sessionId: "test-session",
		sessionManager: { getLeafId: () => "leaf" },
		agent: { subscribe: vi.fn((_listener: () => Promise<void>) => vi.fn()) },
		subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return vi.fn(() => {
				listeners.delete(listener);
			});
		}),
		bindExtensions: vi.fn(async (value: ExtensionBindings) => {
			bindings = value;
			await onBind?.(value);
		}),
		prompt: vi.fn(async (_text: string, options?: PromptOptions) => {
			options?.preflightResult?.(true);
		}),
		abort: vi.fn(async () => {}),
	};
	return {
		session,
		bindings: () => bindings!,
		emit: (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		},
	};
}

function createHost(initial = createSession()) {
	let rebind: (() => Promise<void>) | undefined;
	const host = {
		session: initial.session,
		setRebindSession: vi.fn((callback: () => Promise<void>) => {
			rebind = callback;
		}),
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "selected" })),
		dispose: vi.fn(async () => {}),
	};
	return { host, initial, rebind: () => rebind!() };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const records = () => io.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
let input: PassThrough;
let signals: Map<NodeJS.Signals, NodeJS.SignalsListener[]>;
const harnesses: Harness[] = [];

beforeEach(() => {
	io.lines.length = 0;
	io.flush.mockReset().mockResolvedValue();
	io.backpressure.mockReset().mockResolvedValue();
	input = new PassThrough();
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
	vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	vi.spyOn(shell, "killTrackedDetachedChildren").mockImplementation(() => {});
	signals = new Map((["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [signal, process.listeners(signal)]));
});

afterEach(async () => {
	input.end();
	await tick();
	input.destroy();
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
	for (const [signal, previous] of signals) {
		for (const listener of process.listeners(signal)) {
			if (!previous.includes(listener)) process.off(signal, listener);
		}
	}
	vi.restoreAllMocks();
});

async function start(host: ReturnType<typeof createHost>["host"] | AgentSessionRuntime) {
	void runRpcMode(host as unknown as AgentSessionRuntime);
	await tick();
}

function send(command: object) {
	input.write(`${JSON.stringify(command)}\n`);
}

describe("RPC startup and replacement lifecycle", () => {
	it("round-trips a real startup hook dialog and streams automatic faux task recovery", async () => {
		const manager = SessionManager.inMemory();
		const journal = new TaskRecoveryJournal(manager);
		const user = { role: "user" as const, content: "recover this task", timestamp: 1 };
		journal.start([user]);
		manager.appendMessage(user, journal.state!.promptEntryIds[0]);
		let confirmed = false;
		let discoveries = 0;
		const harness = await createHarness({
			sessionManager: manager,
			hfCompaction: { mode: "off" },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						confirmed = await ctx.ui.confirm("Recovery", "Continue?");
					});
					pi.on("resources_discover", async () => {
						discoveries++;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("recovered")]);
		const host = { ...createHost().host, session: harness.session } as unknown as AgentSessionRuntime;
		await start(host);
		const request = records().find((record) => record.type === "extension_ui_request")!;
		expect(request).toMatchObject({ method: "confirm" });
		send({ type: "extension_ui_response", id: request.id, confirmed: true });
		await vi.waitFor(() => expect(records()).toContainEqual({ type: "agent_settled" }));
		expect(confirmed).toBe(true);
		expect(discoveries).toBe(1);
		expect(records()).toContainEqual({ type: "agent_start" });
		expect(records()).toContainEqual(
			expect.objectContaining({
				type: "message_end",
				message: expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "recovered" }] }),
			}),
		);
	});

	it("reads startup dialog responses while gating ordinary commands until binding finishes", async () => {
		const finishBinding = deferred();
		let confirmed: boolean | undefined;
		const initial = createSession(async ({ uiContext }) => {
			confirmed = await uiContext!.confirm("Startup", "Continue?");
			await finishBinding.promise;
		});
		const { host } = createHost(initial);
		await start(host);
		try {
			expect(input.listenerCount("data")).toBe(1);
			const request = records().find((record) => record.type === "extension_ui_request")!;
			send({ id: "queued", type: "prompt", message: "Wait for startup" });
			send({ type: "extension_ui_response", id: request.id, confirmed: true });
			await tick();
			expect(confirmed).toBe(true);
			expect(initial.session.prompt).not.toHaveBeenCalled();
			finishBinding.resolve();
			await tick();
			expect(initial.session.prompt).toHaveBeenCalledTimes(1);
			expect(records()).toContainEqual({ id: "queued", type: "response", command: "prompt", success: true });
		} finally {
			finishBinding.resolve();
		}
	});

	it("captures startup recovery events and backpressure, and accepts abort before binding settles", async () => {
		const recovery = deferred();
		const initial = createSession(async () => {
			initial.emit({ type: "agent_start" });
			await recovery.promise;
			initial.emit({ type: "agent_settled" });
		});
		initial.session.abort.mockImplementation(async () => {
			recovery.resolve();
		});
		const { host } = createHost(initial);
		await start(host);
		try {
			expect(records()).toContainEqual({ type: "agent_start" });
			expect(initial.session.agent.subscribe).toHaveBeenCalledTimes(1);
			await initial.session.agent.subscribe.mock.calls[0]?.[0]?.();
			expect(io.backpressure).toHaveBeenCalled();
			send({ id: "abort-startup", type: "abort" });
			await tick();
			expect(initial.session.abort).toHaveBeenCalledTimes(1);
			expect(records()).toContainEqual({ type: "agent_settled" });
			expect(records()).toContainEqual({ id: "abort-startup", type: "response", command: "abort", success: true });
		} finally {
			recovery.resolve();
			await tick();
		}
	});

	it.each(["new_session", "switch_session", "fork", "clone"] as const)(
		"binds %s replacement once through the host callback",
		async (type) => {
			const { host, initial, rebind } = createHost();
			const replacement = createSession();
			const replace = async () => {
				host.session = replacement.session;
				await rebind();
				return { cancelled: false, selectedText: "selected" };
			};
			host.newSession.mockImplementation(replace);
			host.switchSession.mockImplementation(replace);
			host.fork.mockImplementation(replace);
			await start(host);
			send({ id: "replace", type, sessionPath: "session.jsonl", entryId: "entry" });
			await tick();
			expect(initial.session.bindExtensions).toHaveBeenCalledTimes(1);
			expect(replacement.session.bindExtensions).toHaveBeenCalledTimes(1);
			expect(initial.session.subscribe.mock.results[0]?.value).toHaveBeenCalledTimes(1);
			io.lines.length = 0;
			initial.emit({ type: "agent_start" });
			replacement.emit({ type: "agent_start" });
			expect(records()).toEqual([{ type: "agent_start" }]);
		},
	);

	it("gates ordinary commands during replacement binding but keeps its dialog responsive", async () => {
		const { host, initial, rebind } = createHost();
		const replacement = createSession(async ({ uiContext }) => {
			await uiContext!.confirm("Replacement", "Continue?");
		});
		host.newSession.mockImplementation(async () => {
			host.session = replacement.session;
			await rebind();
			return { cancelled: false };
		});
		await start(host);
		send({ id: "replace", type: "new_session" });
		await tick();
		send({ id: "prompt", type: "prompt", message: "new session only" });
		await tick();
		expect(initial.session.prompt).not.toHaveBeenCalled();
		expect(replacement.session.prompt).not.toHaveBeenCalled();
		const request = records().find((record) => record.type === "extension_ui_request")!;
		send({ type: "extension_ui_response", id: request.id, confirmed: true });
		await tick();
		expect(replacement.session.bindExtensions).toHaveBeenCalledTimes(1);
		expect(replacement.session.prompt).toHaveBeenCalledTimes(1);
	});

	it("removes installed transport and event subscriptions when startup binding fails", async () => {
		const { host, initial } = createHost(
			createSession(async () => {
				throw new Error("Startup failed");
			}),
		);
		await expect(runRpcMode(host as unknown as AgentSessionRuntime)).rejects.toThrow("Startup failed");
		expect(input.listenerCount("data")).toBe(0);
		expect(input.listenerCount("end")).toBe(0);
		expect(initial.session.subscribe.mock.results[0]?.value).toHaveBeenCalledTimes(1);
		expect(initial.session.agent.subscribe.mock.results[0]?.value).toHaveBeenCalledTimes(1);
		for (const [signal, previous] of signals) expect(process.listeners(signal)).toEqual(previous);
	});

	it("does not rebind a cancelled replacement", async () => {
		const { host, initial } = createHost();
		await start(host);
		send({ id: "cancelled", type: "new_session" });
		await tick();
		expect(initial.session.bindExtensions).toHaveBeenCalledTimes(1);
		expect(records()).toContainEqual({
			id: "cancelled",
			type: "response",
			command: "new_session",
			success: true,
			data: { cancelled: true },
		});
	});

	it("installs signal shutdown before a blocked startup hook", async () => {
		const binding = deferred();
		const { host } = createHost(createSession(() => binding.promise));
		await start(host);
		try {
			const handler = process.listeners("SIGINT").find((listener) => !signals.get("SIGINT")!.includes(listener));
			expect(handler).toBeDefined();
			handler?.("SIGINT");
			await tick();
			expect(host.dispose).toHaveBeenCalledTimes(1);
			expect(process.exit).toHaveBeenCalledWith(130);
		} finally {
			binding.resolve();
			await tick();
		}
	});
});

describe("RPC deferred extension shutdown", () => {
	it.each(
		(["success", "failure"] as const).flatMap((outcome) =>
			(["none", "prompt handler", "prompt backpressure", "command backpressure"] as const).map((blocker) => ({
				outcome,
				blocker,
			})),
		),
	)(
		"finishes standalone compaction $outcome with $blocker blocking shutdown and no later input",
		async ({ outcome, blocker }) => {
			const compactionStarted = deferred();
			const finishCompaction = deferred();
			const compactionFinished = deferred();
			const releaseBlocker = deferred();
			const completed = vi.fn();
			const failed = vi.fn();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } },
				hfCompaction: {
					mode: "full_pipeline",
					complete: async () => {
						compactionStarted.resolve();
						await finishCompaction.promise;
						if (outcome === "failure") throw new Error("offline compaction failure");
						return { text: "Compact offline handoff", stopReason: "stop" };
					},
				},
				extensionFactories: [
					(pi) => {
						pi.registerCommand("compact-and-quit", {
							handler: async (_args, ctx) => {
								ctx.compact({
									onComplete: (result) => {
										completed(result);
										compactionFinished.resolve();
									},
									onError: (error) => {
										failed(error);
										compactionFinished.resolve();
									},
								});
								ctx.shutdown();
								if (blocker === "prompt handler") await releaseBlocker.promise;
							},
						});
					},
				],
			});
			harnesses.push(harness);
			harness.sessionManager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("old answer ".repeat(500)));
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const compactingAtDisposal: boolean[] = [];
			const dispose = vi.fn(async () => {
				compactingAtDisposal.push(harness.session.isCompacting);
				await harness.session.shutdown();
			});
			const host = { ...createHost().host, session: harness.session, dispose } as unknown as AgentSessionRuntime;
			await start(host);
			try {
				if (blocker === "prompt backpressure") io.backpressure.mockImplementation(() => releaseBlocker.promise);
				send({ id: "compact-and-quit", type: "prompt", message: "/compact-and-quit" });
				await compactionStarted.promise;
				await tick();
				if (blocker === "command backpressure") {
					io.backpressure.mockImplementation(() => releaseBlocker.promise);
					send({ id: "pending-command", type: "get_state" });
					await tick();
					expect(records()).toContainEqual(expect.objectContaining({ id: "pending-command", success: true }));
				}
				expect(harness.session.isCompacting).toBe(true);
				expect(harness.session.isIdle).toBe(true);
				expect(input.listenerCount("data")).toBe(1);
				expect(dispose).not.toHaveBeenCalled();
				if (blocker !== "prompt handler") {
					expect(records()).toContainEqual({
						id: "compact-and-quit",
						type: "response",
						command: "prompt",
						success: true,
					});
				}

				// Stdin stays open. Only the already accepted work is allowed to complete.
				finishCompaction.resolve();
				await compactionFinished.promise;
				await tick();
				expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
				expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
				expect(completed).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
				expect(failed).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
				if (outcome === "success") {
					expect(completed).toHaveBeenCalledWith(
						expect.objectContaining({ summary: expect.stringContaining("Compact offline handoff") }),
					);
				} else {
					expect(failed).toHaveBeenCalledWith(
						expect.objectContaining({ message: expect.stringContaining("offline compaction failure") }),
					);
				}
				expect(harness.session.isCompacting).toBe(false);
				if (blocker !== "none") {
					expect(dispose).not.toHaveBeenCalled();
					releaseBlocker.resolve();
					await tick();
				}
				expect(dispose).toHaveBeenCalledTimes(1);
				expect(compactingAtDisposal).toEqual([false]);
				expect(io.flush).toHaveBeenCalledTimes(1);
				expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
				expect(input.listenerCount("data")).toBe(0);
				expect(input.writableEnded).toBe(false);
			} finally {
				finishCompaction.resolve();
				releaseBlocker.resolve();
				await compactionFinished.promise;
				await tick();
			}
		},
	);

	it("lets a blocked faux tool requesting shutdown finish through its final assistant response", async () => {
		const toolStarted = deferred();
		const toolDone = deferred();
		const aborted = vi.fn();
		const harness = await createHarness({
			hfCompaction: { mode: "off" },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "finish_before_shutdown",
						label: "finish",
						description: "Offline lifecycle fixture",
						parameters: Type.Object({}),
						async execute(_id, _args, signal, _onUpdate, ctx) {
							signal?.addEventListener("abort", aborted, { once: true });
							ctx.shutdown();
							toolStarted.resolve();
							await toolDone.promise;
							return { content: [{ type: "text", text: "finished" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("finish_before_shutdown", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("final response"),
		]);
		const dispose = vi.fn(async () => {
			await harness.session.shutdown();
		});
		const host = { ...createHost().host, session: harness.session, dispose } as unknown as AgentSessionRuntime;
		await start(host);
		try {
			send({ id: "work", type: "prompt", message: "finish the tool" });
			await toolStarted.promise;
			send({ id: "poll", type: "get_state" });
			await tick();
			expect(dispose).not.toHaveBeenCalled();
			expect(aborted).not.toHaveBeenCalled();
			toolDone.resolve();
			await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
			expect(records()).toContainEqual({ type: "agent_settled" });
			expect(records()).toContainEqual(
				expect.objectContaining({
					type: "message_end",
					message: expect.objectContaining({ content: [{ type: "text", text: "final response" }] }),
				}),
			);
			expect(process.exit).toHaveBeenCalledWith(0);
		} finally {
			toolDone.resolve();
		}
	});

	it("does not dispose active or queued work when get_state is polled", async () => {
		const { host, initial } = createHost();
		await start(host);
		initial.session.isIdle = false;
		initial.session.isStreaming = true;
		initial.bindings().shutdownHandler?.();
		send({ id: "poll", type: "get_state" });
		await tick();
		expect(records()).toContainEqual(expect.objectContaining({ id: "poll", success: true }));
		expect(host.dispose).not.toHaveBeenCalled();
		initial.emit({ type: "agent_end", messages: [], willRetry: false });
		await tick();
		expect(host.dispose).not.toHaveBeenCalled();
		initial.session.isIdle = true;
		initial.session.isStreaming = false;
		initial.emit({ type: "agent_settled" });
		await tick();
		expect(host.dispose).toHaveBeenCalledTimes(1);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it("waits for the initiating extension command and its response backpressure before disposing", async () => {
		const commandDone = deferred();
		const drained = deferred();
		const { host, initial } = createHost();
		initial.session.prompt.mockImplementation(async (_message, options) => {
			initial.bindings().shutdownHandler?.();
			await commandDone.promise;
			options?.preflightResult?.(true);
		});
		await start(host);
		try {
			send({ id: "quit", type: "prompt", message: "/quit" });
			await tick();
			expect(host.dispose).not.toHaveBeenCalled();
			io.backpressure.mockImplementation(() => drained.promise);
			commandDone.resolve();
			await tick();
			expect(records()).toContainEqual({ id: "quit", type: "response", command: "prompt", success: true });
			expect(host.dispose).not.toHaveBeenCalled();
			drained.resolve();
			await tick();
			expect(host.dispose).toHaveBeenCalledTimes(1);
			expect(io.flush).toHaveBeenCalledTimes(1);
			expect(process.exit).toHaveBeenCalledWith(0);
		} finally {
			commandDone.resolve();
			drained.resolve();
			await tick();
		}
	});

	it("flushes a rejected shutdown-initiating prompt before disposing", async () => {
		const { host, initial } = createHost();
		initial.session.prompt.mockImplementation(async () => {
			initial.bindings().shutdownHandler?.();
			throw new Error("command failed");
		});
		await start(host);
		send({ id: "failed", type: "prompt", message: "/quit" });
		await tick();
		expect(records()).toContainEqual({
			id: "failed",
			type: "response",
			command: "prompt",
			success: false,
			error: "command failed",
		});
		expect(host.dispose).toHaveBeenCalledTimes(1);
		expect(io.flush).toHaveBeenCalledTimes(1);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it("keeps external signals immediate while work is active", async () => {
		const { host, initial } = createHost();
		await start(host);
		initial.session.isIdle = false;
		const handler = process.listeners("SIGTERM").find((listener) => !signals.get("SIGTERM")!.includes(listener));
		handler?.("SIGTERM");
		await tick();
		expect(host.dispose).toHaveBeenCalledTimes(1);
		expect(process.exit).toHaveBeenCalledWith(143);
	});
});
