import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/core/extensions/index.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createMcpExtension } from "../../../src/extensions/mcp/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("MCP migration: direct SDK session shutdown", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	const releases: Array<() => void> = [];

	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		for (const session of sessions.splice(0)) await session.shutdown();
		for (const h of harnesses.splice(0)) {
			await h.session.shutdown();
			h.cleanup();
		}
	});

	async function sdkSession(factory: (pi: ExtensionAPI, agentDir: string) => ReturnType<ExtensionFactory>) {
		const h = await createHarness({ tools: [], settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		const extensionsResult = await createTestExtensionsResult([(pi) => factory(pi, h.tempDir)], h.tempDir);
		const { session } = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			model: h.getModel(),
			modelRuntime: h.session.modelRuntime,
			settingsManager: h.settingsManager,
			sessionManager: SessionManager.inMemory(h.tempDir),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			noTools: "builtin",
		});
		sessions.push(session);
		return { h, session };
	}

	it("aborts the run, drains an asynchronous disposer, and emits shutdown exactly once", async () => {
		const started = deferred();
		const disposing = deferred();
		const disposed = deferred();
		releases.push(disposed.resolve);
		const order: string[] = [];
		const { h, session } = await sdkSession((pi) => {
			pi.registerTool({
				name: "wait_until_abort",
				label: "Wait",
				description: "Wait until the fake run is cancelled",
				parameters: Type.Object({}),
				contract: { sideEffects: "none" },
				execute: async (_id, _args, signal) => {
					started.resolve();
					await new Promise<void>((resolve) => {
						if (signal?.aborted) resolve();
						else signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					order.push("tool drained");
					return { content: [{ type: "text", text: "stopped" }], details: {} };
				},
			});
			pi.on("session_shutdown", async (event, ctx) => {
				expect(ctx.isIdle()).toBe(true);
				expect(event.reason).toBe("quit");
				expect(pi.getActiveTools()).toContain("wait_until_abort");
				order.push("shutdown started");
				disposing.resolve();
				await disposed.promise;
				order.push("disposer drained");
			});
		});
		h.setResponses([fauxAssistantMessage(fauxToolCall("wait_until_abort", {}), { stopReason: "toolUse" })]);
		const prompt = session.prompt("start fake wait");
		await started.promise;
		let completed = false;
		const shutdown = session.shutdown().then((report) => {
			completed = true;
			return report;
		});
		const repeated = session.shutdown();
		await vi.waitFor(() => expect(order).toContain("shutdown started"));
		session.dispose();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(completed).toBe(false);
		expect(order).toEqual(["tool drained", "shutdown started"]);
		disposed.resolve();
		await prompt;
		expect((await shutdown).complete).toBe(true);
		await repeated;
		await session.shutdown();
		expect(order).toEqual(["tool drained", "shutdown started", "disposer drained"]);
		expect(() => session.extensionRunner.createContext().isIdle()).toThrow("stale");
	});

	it("allows a shutdown hook to await reentrant shutdown without releasing unrelated callers early", async () => {
		const disposing = deferred();
		const disposed = deferred();
		releases.push(disposed.resolve);
		let session: AgentSession;
		let calls = 0;
		({ session } = await sdkSession((pi) => {
			pi.on("session_shutdown", async () => {
				calls++;
				const reentrant = await session.shutdown();
				expect(reentrant.complete).toBe(false);
				expect(reentrant.remainingResources).toContain("extensions");
				disposing.resolve();
				await disposed.promise;
			});
		}));
		const shutdown = session.shutdown();
		await vi.waitFor(() => expect(calls).toBe(1));
		await disposing.promise;
		let secondCompleted = false;
		const repeated = session.shutdown().then(() => {
			secondCompleted = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(secondCompleted).toBe(false);
		disposed.resolve();
		await shutdown;
		await repeated;
		expect(calls).toBe(1);
	});

	it("acknowledges externally initiated callback shutdown while outside callers await its full drain", async () => {
		const entered = deferred();
		const gate = deferred();
		const releaseOnFailure = deferred();
		releases.push(gate.resolve, releaseOnFailure.resolve);
		let session: AgentSession;
		let calls = 0;
		let acknowledged = false;
		({ session } = await sdkSession((pi) => {
			pi.on("session_shutdown", async (event) => {
				calls++;
				expect(event.reason).toBe("fork");
				entered.resolve();
				// The escape only releases the faulty baseline during afterEach; it never
				// satisfies the acknowledgement assertion or lets a good run skip the gate.
				await Promise.race([
					session.shutdown().then((report) => {
						expect(report.complete).toBe(false);
						expect(report.remainingResources).toContain("extensions");
						acknowledged = true;
					}),
					releaseOnFailure.promise,
				]);
				if (acknowledged) await gate.promise;
			});
		}));
		const event = session.extensionRunner.emit({ type: "session_shutdown", reason: "fork" });
		await entered.promise;
		let completed = false;
		const outside = session.shutdown().then((report) => {
			completed = true;
			return report;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(acknowledged).toBe(true);
		expect(completed).toBe(false);
		gate.resolve();
		await event;
		expect((await outside).complete).toBe(true);
		await session.shutdown();
		expect(calls).toBe(1);
	});

	it("does not treat another runner's callback as reentry into this session", async () => {
		const entered = deferred();
		const gate = deferred();
		releases.push(gate.resolve);
		const other = await sdkSession((pi) => {
			pi.on("session_shutdown", async () => {
				entered.resolve();
				await gate.promise;
			});
		});
		let otherCompleted = false;
		const { session } = await sdkSession((pi) => {
			pi.on("session_shutdown", async () => {
				const report = await other.session.shutdown();
				expect(report.complete).toBe(true);
				otherCompleted = true;
			});
		});
		const event = session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await entered.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(otherCompleted).toBe(false);
		gate.resolve();
		await event;
		expect(otherCompleted).toBe(true);
		await session.shutdown();
	});

	it("handles a reentrantly scheduled cleanup rejection and preserves it for outside callers", async () => {
		let session: AgentSession;
		let acknowledged = false;
		({ session } = await sdkSession((pi) => {
			pi.on("session_shutdown", async () => {
				const report = await session.shutdown();
				expect(report.complete).toBe(false);
				acknowledged = true;
			});
		}));
		const tasks = session.backgroundTasks;
		if (!tasks) throw new Error("Missing SDK background manager");
		vi.spyOn(tasks, "shutdown").mockRejectedValue(new Error("failed background drain"));
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(acknowledged).toBe(true);
		sessions.splice(sessions.indexOf(session), 1);
		await expect(session.shutdown()).rejects.toThrow("failed background drain");
	});

	it("closes the real in-memory MCP connection on direct SDK dispose", async () => {
		const pair = createInMemoryTransportPair();
		const closed = vi.fn();
		pair.server.onClose(closed);
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			const request = message as JsonRpcRequest;
			const result =
				request.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "fake", version: "1" },
						}
					: request.method === "tools/list"
						? {
								tools: [
									{
										name: "read",
										description: "Fake MCP read",
										inputSchema: { type: "object", properties: {} },
									},
								],
							}
						: {};
			void pair.server.send({ jsonrpc: "2.0", id: request.id, result });
		});
		await pair.server.start();
		const { session } = await sdkSession((pi, agentDir) =>
			createMcpExtension({
				agentDir,
				loadConfig: () => ({
					servers: [{ name: "fake", config: { command: "unused", exposure: "direct" }, source: "test" }],
					errors: [],
				}),
				createTransport: () => pair.client,
			})(pi),
		);
		await session.bindExtensions({ mode: "rpc" });
		await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("mcp__fake__read"));
		session.dispose();
		await session.shutdown();
		expect(closed).toHaveBeenCalledOnce();
		await session.shutdown();
		expect(closed).toHaveBeenCalledOnce();
		await pair.server.close();
	});

	it("shares a previously emitted runtime shutdown event without changing its reason", async () => {
		const reasons: string[] = [];
		const { session } = await sdkSession((pi) => {
			pi.on("session_shutdown", (event) => {
				reasons.push(event.reason);
			});
		});
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "fork" });
		await session.shutdown();
		expect(reasons).toEqual(["fork"]);
	});
});
