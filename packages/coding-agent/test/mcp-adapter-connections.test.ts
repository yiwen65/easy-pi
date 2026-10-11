import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type JsonRpcMessage,
	LATEST_PROTOCOL_VERSION,
	McpAuthRequiredError,
	McpHttpError,
	McpSessionExpiredError,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { describe, expect, it, vi } from "vitest";
import { getToolErrorOutcome } from "../../agent/src/tool-outcome.ts";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
	McpServerLog,
} from "../src/extensions/mcp/runtime.ts";
import { createMcpToolDefinition } from "../src/extensions/mcp/tools.ts";

// Lifecycle/security regressions reused from fixed upstream e37cdc420669e48b4df4bbce0fb2617fc3c71328.
describe("MCP connections", () => {
	const servers: InMemoryTransport[] = [];

	/** In-memory server that answers initialize, tools/list, and tools/call with "ok". */
	function createTransport(options: { expireFirstCall?: boolean; methods?: string[]; noTools?: boolean } = {}) {
		const pair = createInMemoryTransportPair();
		servers.push(pair.server);
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			options.methods?.push(message.method);
			const response: JsonRpcMessage =
				message.method === "initialize"
					? {
							jsonrpc: "2.0",
							id: message.id,
							result: {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: options.noTools ? { prompts: {} } : { tools: {} },
								serverInfo: { name: "fake", version: "1.0.0" },
							},
						}
					: message.method === "tools/list"
						? options.noTools
							? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
							: { jsonrpc: "2.0", id: message.id, result: { tools: [] } }
						: message.method === "resources/read"
							? { jsonrpc: "2.0", id: message.id, result: { contents: [{ uri: "docs://a", text: "ok" }] } }
							: { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } };
			queueMicrotask(() => void pair.server.send(response));
		});
		void pair.server.start();
		if (options.expireFirstCall) {
			const send = pair.client.send.bind(pair.client);
			// Simulates the HTTP transport's 404 for a session the server no longer knows.
			pair.client.send = async (message: JsonRpcMessage) => {
				if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
				return send(message);
			};
		}
		return pair.client;
	}

	function connect(
		entry: McpServerEntry,
		transports: (() => ReturnType<typeof createTransport>)[],
		log?: McpServerLog,
	) {
		let opened = 0;
		const connection = new McpServerConnection({
			entry,
			cwd: process.cwd(),
			createTransport: () => transports[opened++](),
			credentials: new McpOAuthCredentialStore("/unused", new InMemoryAuthStorageBackend()),
			log,
			onTools: () => {},
		});
		return { connection, opened: () => opened };
	}

	it("classifies a proven sent call that loses its response as unknown, without retry", async () => {
		const pair = createInMemoryTransportPair();
		let calls = 0;
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			if (message.method === "tools/call") {
				calls++;
				void pair.server.close();
				return;
			}
			void pair.server.send({
				jsonrpc: "2.0",
				id: message.id,
				result:
					message.method === "initialize"
						? {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: { tools: {} },
								serverInfo: { name: "fake", version: "1" },
							}
						: { tools: [{ name: "echo", inputSchema: {} }] },
			});
		});
		void pair.server.start();
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => pair.client,
		]);
		const tool = createMcpToolDefinition({
			server: "fake",
			tool: { name: "echo", inputSchema: {} },
			name: "mcp__fake__echo",
			namespace: { name: "mcp__fake" },
			exposure: "direct",
			timeoutMs: 100,
			getClient: async () => connection,
		});
		try {
			await connection.getClient();
			const work = tool.execute("id", {}, undefined, undefined, {} as ExtensionContext);
			await expect(work).rejects.toMatchObject({ executionOutcome: "unknown" });
			try {
				await work;
			} catch (error) {
				expect(getToolErrorOutcome(error, tool.name, {})).toBe("unknown");
			}
			expect(calls).toBe(1);
			expect(opened()).toBe(1);
		} finally {
			await connection.close();
		}
	});

	it("starts a new session and retries once when the session expired", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ expireFirstCall: true }),
			() => createTransport(),
		]);
		const results = await Promise.all([connection.callTool("echo", {}, {}), connection.callTool("echo", {}, {})]);
		expect(results).toEqual([
			{ content: [{ type: "text", text: "ok" }] },
			{ content: [{ type: "text", text: "ok" }] },
		]);
		expect(opened()).toBe(2);
		await connection.close();
	});

	it("owns expired clients until cleanup and closes every transport at shutdown", async () => {
		const expired = createTransport({ expireFirstCall: true });
		const fresh = createTransport();
		const closeExpired = vi.fn();
		expired.onClose(closeExpired);
		const closeFresh = vi.fn();
		fresh.onClose(closeFresh);
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => expired,
			() => fresh,
		]);
		await connection.callTool("echo", {}, {});
		await connection.close();
		expect(closeExpired).toHaveBeenCalledTimes(1);
		expect(closeFresh).toHaveBeenCalledTimes(1);
	});

	it("releases idle expired sessions instead of accumulating retained transports", async () => {
		const closed: ReturnType<typeof vi.fn>[] = [];
		const connection = new McpServerConnection({
			entry: { name: "fake", config: { command: "unused" }, source: "test" },
			cwd: process.cwd(),
			credentials: new McpOAuthCredentialStore("/unused", new InMemoryAuthStorageBackend()),
			onTools: () => {},
			createTransport: () => {
				const client = createTransport();
				const close = vi.fn();
				client.onClose(close);
				closed.push(close);
				const send = client.send.bind(client);
				let calls = 0;
				client.send = async (message) => {
					if ("method" in message && message.method === "tools/call" && ++calls > 1)
						throw new McpSessionExpiredError("gone");
					return send(message);
				};
				return client;
			},
		});
		try {
			for (let index = 0; index < 5; index++) {
				await connection.callTool("echo", {}, {});
				expect(closed).toHaveLength(index + 1);
				for (const close of closed.slice(0, -1)) expect(close).toHaveBeenCalledTimes(1);
				expect(closed.at(-1)).not.toHaveBeenCalled();
			}
		} finally {
			await connection.close();
		}
		for (const close of closed) expect(close).toHaveBeenCalledTimes(1);
	});

	it.each(["finish", "shutdown"])(
		"retains an unrelated old-session call while a sibling retries after expiry (%s)",
		async (completion) => {
			const pair = createInMemoryTransportPair();
			let listed = 0;
			let answerHold!: () => Promise<void>;
			let holdStarted!: () => void;
			const holding = new Promise<void>((resolve) => {
				holdStarted = resolve;
			});
			pair.server.onMessage((message) => {
				if (!("id" in message) || !("method" in message)) return;
				if (message.method === "tools/call") {
					answerHold = () =>
						pair.server.send({
							jsonrpc: "2.0",
							id: message.id,
							result: { content: [{ type: "text", text: "held call completed" }] },
						});
					holdStarted();
					return;
				}
				if (message.method === "tools/list") listed++;
				void pair.server.send({
					jsonrpc: "2.0",
					id: message.id,
					result:
						message.method === "initialize"
							? {
									protocolVersion: LATEST_PROTOCOL_VERSION,
									capabilities: { tools: {} },
									serverInfo: { name: "fake", version: "1" },
								}
							: { tools: [] },
				});
			});
			void pair.server.start();
			const send = pair.client.send.bind(pair.client);
			pair.client.send = async (message) => {
				if (
					"method" in message &&
					message.method === "tools/call" &&
					(message.params as { name?: string } | undefined)?.name === "expire"
				)
					throw new McpSessionExpiredError("gone");
				return send(message);
			};
			const closeOld = vi.fn();
			pair.client.onClose(closeOld);
			const fresh = createTransport();
			const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
				() => pair.client,
				() => fresh,
			]);
			try {
				const held = connection.callTool("hold", {}, {});
				void held.catch(() => undefined);
				await holding;
				expect(await connection.callTool("expire", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
				expect(closeOld).not.toHaveBeenCalled();
				await pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(listed).toBe(1);
				if (completion === "finish") {
					await answerHold();
					expect(await held).toEqual({ content: [{ type: "text", text: "held call completed" }] });
				} else {
					const failed = held.catch((error) => error);
					await connection.close();
					expect(getToolErrorOutcome(await failed, "hold", {})).toBe("unknown");
				}
				expect(closeOld).toHaveBeenCalledTimes(1);
			} finally {
				await connection.close();
			}
		},
	);

	it("repeated close calls wait for the same underlying transport cleanup", async () => {
		const client = createTransport();
		let releaseClose!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		let started!: () => void;
		const closing = new Promise<void>((resolve) => {
			started = resolve;
		});
		const close = client.close.bind(client);
		client.close = async () => {
			started();
			await gate;
			await close();
		};
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [() => client]);
		await connection.getClient();
		const first = connection.close();
		await closing;
		let secondSettled = false;
		const second = connection.close().then(() => {
			secondSettled = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(secondSettled).toBe(false);
		} finally {
			releaseClose();
			await Promise.all([first, second]);
		}
	});

	it.skipIf(process.platform === "win32")(
		"expands ~ in the command, arguments, and cwd of stdio servers",
		async () => {
			const home = mkdtempSync(join(tmpdir(), "pi-mcp-home-"));
			const previousHome = process.env.HOME;
			process.env.HOME = home;
			mkdirSync(join(home, "work"));
			// Answers every tool call with its working directory.
			writeFileSync(
				join(home, "server.mjs"),
				`import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (!("id" in message)) continue;
	const result = message.method === "initialize"
		? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cwd", version: "1" } }
		: message.method === "tools/list"
			? { tools: [{ name: "cwd", inputSchema: { type: "object" } }] }
			: { content: [{ type: "text", text: process.cwd() }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}`,
			);
			const connection = new McpServerConnection({
				entry: {
					name: "home",
					config: { command: process.execPath, args: ["~/server.mjs"], cwd: "~/work" },
					source: "test",
				},
				cwd: tmpdir(),
				createTransport: createDefaultTransport,
				credentials: new McpOAuthCredentialStore("/unused", new InMemoryAuthStorageBackend()),
				onTools: () => {},
			});
			try {
				const result = await connection.callTool("cwd", {}, {});
				expect(realpathSync((result.content[0] as { text: string }).text)).toBe(realpathSync(join(home, "work")));
			} finally {
				await connection.close();
				process.env.HOME = previousHome;
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	it("connects to servers without the tools capability without listing tools", async () => {
		const methods: string[] = [];
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ noTools: true, methods }),
		]);
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(connection.tools).toEqual([]);
		expect(methods).toEqual(["initialize"]);
		await connection.close();
	});

	it("marks a dropped connection and reconnects on the next call", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport(),
			() => createTransport(),
		]);
		await connection.getClient();
		await servers.at(-1)?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(connection.state).toBe("disconnected");
		expect(connection.error).toBe("Connection closed");
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(connection.state).toBe("connected");
		expect(opened()).toBe(2);
		await connection.close();
	});

	it("retries HTTP connections that fail with a transient error", async () => {
		const { connection, opened } = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(503, "MCP HTTP request failed with status 503");
					};
					return transport;
				},
				() => createTransport(),
			],
		);
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(opened()).toBe(2);
		await connection.close();

		const failing = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(400, "MCP HTTP request failed with status 400: bad");
					};
					return transport;
				},
			],
		);
		await expect(failing.connection.getClient()).rejects.toThrow("status 400: bad");
		expect(failing.connection.state).toBe("failed");
		expect(failing.opened()).toBe(1);
	});

	// #10249
	it("closes a connection that is still initializing before close returns", async () => {
		const pair = createInMemoryTransportPair();
		// The server receives initialize but never answers it.
		const initializing = new Promise<void>((resolve) => {
			pair.server.onMessage(() => resolve());
		});
		void pair.server.start();
		let transportClosed = false;
		pair.client.onClose(() => {
			transportClosed = true;
		});
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => pair.client,
		]);
		let failure: unknown;
		void connection.getClient().catch((error) => {
			failure = error;
		});
		await initializing;
		await connection.close();
		expect(transportClosed).toBe(true);
		expect(String(failure)).toContain("failed to connect");
	});

	// #10249
	it("stops waiting to retry a connection when closed", async () => {
		const { connection } = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(503, "MCP HTTP request failed with status 503");
					};
					return transport;
				},
			],
		);
		let failure: unknown;
		void connection.getClient().catch((error) => {
			failure = error;
		});
		// The first attempt failed; the retry is 250ms away.
		await new Promise((resolve) => setTimeout(resolve, 10));
		await connection.close();
		expect(String(failure)).toContain("status 503");
	});

	it("retries resource reads, but not tool calls, after a transient HTTP error", async () => {
		const transport = createTransport();
		const send = transport.send.bind(transport);
		const failed = new Set<string>();
		// The first read and the first call fail with 502.
		transport.send = async (message) => {
			const method = "method" in message ? message.method : "";
			if ((method === "resources/read" || method === "tools/call") && !failed.has(method)) {
				failed.add(method);
				throw new McpHttpError(502, "MCP HTTP request failed with status 502");
			}
			return send(message);
		};
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => transport,
		]);
		expect(await connection.readResource("docs://a", {})).toEqual({ contents: [{ uri: "docs://a", text: "ok" }] });
		await expect(connection.callTool("echo", {}, {})).rejects.toThrow("status 502");
		await connection.close();
	});

	it("asks OAuth servers that keep rejecting requests for a new sign-in", async () => {
		const { connection } = connect({ name: "fake", config: { url: "http://unused.invalid" }, source: "test" }, [
			() => {
				const transport = createTransport();
				transport.send = async () => {
					throw new McpAuthRequiredError(new Response(null, { status: 401 }));
				};
				return transport;
			},
		]);
		await expect(connection.getClient()).rejects.toThrow('MCP server "fake" requires sign-in. Run /mcp to sign in.');
		expect(connection.state).toBe("needs-auth");
		await connection.close();
	});

	it("appends server log messages to the log file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-log-"));
		try {
			const path = join(dir, "mcp.log");
			const { connection } = connect(
				{ name: "fake", config: { command: "unused" }, source: "test" },
				[() => createTransport()],
				new McpServerLog(path),
			);
			await connection.getClient();
			const server = servers.at(-1);
			await server?.send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "warning", logger: "db", data: "slow\nquery" },
			});
			await server?.send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "error", data: { code: 7 } },
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			const lines = readFileSync(path, "utf8").replace(/^\S+ /gm, "");
			expect(lines).toBe('[fake] warning db: slow\n    query\n[fake] error {"code":7}\n');
			await connection.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves the OAuth client secret lazily", async () => {
		const { connection } = connect(
			{
				name: "fake",
				config: { url: "http://unused.invalid", oauth: { clientSecret: "!exit 1" } },
				source: "test",
			},
			[() => createTransport()],
		);
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(() => connection.oauthSettings()).toThrow("oauth.clientSecret");
		await connection.close();
	});
});
