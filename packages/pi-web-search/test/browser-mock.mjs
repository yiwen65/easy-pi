import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import timers from "node:timers/promises";

/** Mock only OS/CDP boundaries; the actual loaded tool and browser logic execute. */
export function mockBrowser(t, options = {}) {
	const calls = [];
	const commands = [];
	const servers = [];
	const processes = [];
	let clock = Date.now();
	const previous = process.env.PI_WEB_FETCH_BROWSER;
	process.env.PI_WEB_FETCH_BROWSER = process.execPath;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_WEB_FETCH_BROWSER;
		else process.env.PI_WEB_FETCH_BROWSER = previous;
	});
	t.mock.method(Date, "now", () => clock);
	t.mock.method(timers, "setTimeout", async (ms, _value, settings) => {
		settings?.signal?.throwIfAborted();
		clock += ms;
		await new Promise(resolve => setImmediate(resolve));
		settings?.signal?.throwIfAborted();
	});
	syncBuiltinESMExports();
	t.mock.method(http, "createServer", handler => {
		const server = new EventEmitter();
		server.handler = handler;
		server.closed = false;
		server.listen = (_port, host, callback) => { assert.equal(host, "127.0.0.1"); queueMicrotask(callback); return server; };
		server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 31234 });
		server.close = callback => { server.closed = true; queueMicrotask(() => callback?.()); return server; };
		servers.push(server);
		return server;
	});
	t.mock.method(childProcess, "spawn", (executable, args, settings) => {
		const child = new EventEmitter();
		child.exitCode = null;
		child.signalCode = null;
		child.pid = options.spawnError ? undefined : 999000 + processes.length;
		child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
		calls.push({ executable, args, settings });
		processes.push(child);
		let buffer = "";
		let sample = 0;
		child.stdio[3].on("data", chunk => {
			buffer += chunk.toString();
			let end;
			while ((end = buffer.indexOf("\0")) >= 0) {
				const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
				commands.push(command);
				options.onCommand?.(command, child);
				if (options.hangOn === command.method) continue;
				if (options.invalidProtocol && command.method === "Browser.getVersion") {
					queueMicrotask(() => child.stdio[4].write("{bad json}\0")); continue;
				}
				let result = {};
				if (command.method === "Target.createTarget") result = { targetId: "target" };
				if (command.method === "Target.attachToTarget") result = { sessionId: "session" };
				if (command.method === "Page.navigate") result = { frameId: "main", ...(options.navigationError ? { errorText: options.navigationError } : {}) };
				if (command.method === "Page.createIsolatedWorld") result = { executionContextId: 1 };
				if (command.method === "Page.getFrameTree") result = { frameTree: { frame: { id: "main", url: options.url ?? "https://docs.python.org/3/", loaderId: "document" } } };
				if (command.method === "Runtime.evaluate") {
					const snapshots = options.snapshots ?? [{ url: options.url ?? "https://docs.python.org/3/", title: "Python docs", text: options.text ?? "# Public page\n\nAnonymous rendered content." }];
					const snapshot = snapshots[Math.min(sample++, snapshots.length - 1)];
					result = { result: { value: { ready: true, captureTruncated: false, passwordForm: false, revision: 0, pending: false, busy: false, incompleteReasons: [], ...snapshot } } };
					if (command.params.expression === "globalThis.__easyPiFullPageScan1.advance()") result = { result: { value: { moved: true } } };
				}
				queueMicrotask(() => {
					if (options.failOn === command.method) child.stdio[4].write(JSON.stringify({ id: command.id, error: { code: -32000, message: "synthetic-sensitive-protocol-error" } }) + "\0");
					else child.stdio[4].write(JSON.stringify({ id: command.id, result }) + "\0");
					if (command.method === "Page.navigate") child.stdio[4].write(JSON.stringify({ method: "Network.responseReceived", sessionId: "session", params: { type: "Document", frameId: "main", response: { status: options.status ?? 200 } } }) + "\0");
					if (command.method === "Browser.close" && !options.ignoreClose) {
						child.exitCode = 0; child.emit("exit", 0, null);
					}
				});
			}
		});
		if (options.spawnError) queueMicrotask(() => child.emit("error", new Error("synthetic-sensitive-spawn-error")));
		return child;
	});
	t.mock.method(process, "kill", (pid, signal) => {
		const child = processes.find(item => item.pid === -pid);
		assert.ok(child, "Only an owned browser process group may be killed");
		if (signal !== "SIGTERM" || !options.ignoreTerm) {
			child.signalCode = signal; child.emit("exit", null, signal);
		}
		return true;
	});
	t.after(() => {
		assert.ok(servers.every(server => server.closed), "All proxy listeners must close");
		assert.ok(processes.every(child => !child.pid || child.exitCode !== null || child.signalCode !== null), "All fake browsers must exit");
	});
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	return { calls, commands, servers, processes };
}
