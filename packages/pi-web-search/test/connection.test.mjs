import assert from "node:assert/strict";
import callbackDns from "node:dns";
import dns from "node:dns/promises";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import net from "node:net";
import { Duplex, PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import timers from "node:timers/promises";

assert.equal(process.env.PI_WEB_SEARCH_OFFLINE, "1", "Use test/run.mjs for an isolated environment.");
// Exercise Node's real address-selection and HTTP state machines, but replace
// the native TCP boundary: no socket connects, listens, resolves or reads on the OS.
const { TCP } = process.binding("tcp_wrap");
const refused = process.binding("uv").UV_ECONNREFUSED;
const deny = () => { throw new Error("Unexpected real I/O in connection tests"); };
TCP.prototype.connect = deny;
TCP.prototype.connect6 = deny;
net.Server.prototype.listen = deny;
callbackDns.lookup = deny;
dns.lookup = deny;
const realConnect = net.connect;
const realRequest = http.request;
const { startPublicProxy } = await import("../src/network.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));
const bad = { address: "8.8.8.8", family: 4 };
const good = { address: "1.1.1.1", family: 4 };

class Client extends Duplex {
	writes = [];
	_read() {}
	_write(chunk, _encoding, done) { this.writes.push(chunk.toString()); done(); }
	setTimeout(ms, callback) { this.timeout = { ms, callback }; return this; }
}
class Response extends Writable {
	status = 0;
	headersSent = false;
	text = "";
	writeHead(status) { this.status = status; this.headersSent = true; return this; }
	_write(chunk, _encoding, done) { this.text += chunk.toString(); done(); }
}
async function fixture(t, { mode = "refused", addresses = [bad, good] } = {}) {
	const controller = new AbortController();
	const attempts = [], timeouts = [], sockets = [], writes = [];
	let requests = 0;
	const server = new EventEmitter();
	server.listen = (_port, host, done) => { assert.equal(host, "127.0.0.1"); queueMicrotask(done); };
	server.address = () => ({ port: 30123 });
	server.close = done => { queueMicrotask(done); };
	t.mock.method(http, "createServer", handler => { server.handler = handler; return server; });
	const lookup = t.mock.method(dns, "lookup", async () => addresses);
	for (const method of ["connect", "connect6"]) t.mock.method(TCP.prototype, method, function(request, address, port) {
		assert.ok(addresses.some(item => item.address === address), "Every actual attempt must be in the vetted snapshot");
		assert.ok([80, 443].includes(port));
		attempts.push(address);
		if (address === bad.address || mode === "all-refused") return mode === "blackhole" ? 0 : refused;
		queueMicrotask(() => request.oncomplete(0, this, request, true, true));
		return 0;
	});
	const open = options => {
		const socket = realConnect(options);
		sockets.push(socket);
		socket.on("connectionAttemptTimeout", address => timeouts.push(address));
		socket._read = () => {};
		socket._writev = null;
		let responded = false;
		socket._write = (chunk, encoding, done) => {
			if (socket.connecting) { socket.once("connect", () => socket._write(chunk, encoding, done)); return; }
			writes.push(chunk.toString()); done();
			if (mode === "reset-after-write") { socket.destroy(new Error("injected-after-write")); return; }
			if (options.port === 80 && writes.join("").endsWith("body") && !responded) {
				responded = true;
				queueMicrotask(() => {
					socket.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
					socket.push(null);
				});
			}
		};
		return socket;
	};
	t.mock.method(net, "connect", open);
	// Pre-fix HTTP used an Agent; keep the bad baseline equally isolated.
	t.mock.method(http.Agent.prototype, "createConnection", open);
	t.mock.method(http, "request", (...args) => { requests++; return realRequest(...args); });
	const proxy = await startPublicProxy(controller.signal);
	t.after(async () => { await proxy.close(); assert.ok(sockets.every(socket => socket.destroyed)); });
	return { controller, proxy, attempts, timeouts, sockets, writes, lookup, requests: () => requests,
		start(protocol) {
			const client = new Client(); server.emit("connection", client);
			if (protocol === "CONNECT") {
				server.emit("connect", { url: "docs.python.org:443" }, client, Buffer.from("tunnel-head"));
				return { client, success: () => client.writes.join("").includes("200 Connection Established") };
			}
			const request = new PassThrough();
			request.url = "http://docs.python.org/page"; request.method = "POST";
			request.headers = { host: "docs.python.org", "content-length": "4" };
			const response = new Response();
			client.once("close", () => response.destroy());
			server.handler(request, response); request.end("body");
			return { client, response, success: () => response.status === 200 && response.text === "ok" };
		},
	};
}

for (const protocol of ["CONNECT", "HTTP"]) {
	test(`${protocol}: healthy first address is used without extra attempts`, async t => {
		const f = await fixture(t, { addresses: [good, bad] });
		const result = f.start(protocol); await flush();
		assert.equal(result.success(), true);
		assert.deepEqual(f.attempts, [good.address]);
	});
	test(`${protocol}: a private answer anywhere in the snapshot rejects all TCP attempts`, async t => {
		const f = await fixture(t, { addresses: [bad, good, { address: "127.0.0.1", family: 4 }] });
		const result = f.start(protocol); await flush();
		assert.deepEqual(f.attempts, []);
		assert.equal(f.proxy.blockedRequests, 1);
		if (protocol === "CONNECT") assert.match(result.client.writes.join(""), /403 Forbidden/);
		else assert.equal(result.response.status, 403);
	});
	for (const mode of ["refused", "blackhole"]) test(`${protocol}: ${mode} first IPv4 falls through to healthy vetted IPv4 before sending data`, async t => {
		const f = await fixture(t, { mode });
		const result = f.start(protocol);
		await timers.setTimeout(mode === "blackhole" ? 350 : 20);
		assert.equal(result.success(), true, "An unreachable primary must not strand the healthy DNS candidate");
		assert.deepEqual(f.attempts, [bad.address, good.address]);
		assert.equal(f.lookup.mock.callCount(), 1);
		if (mode === "blackhole") assert.deepEqual(f.timeouts, [bad.address]);
		assert.equal(f.proxy.blockedRequests, 0, "Transport failures are not policy rejections");
		if (protocol === "HTTP") {
			assert.equal(f.requests(), 1, "Select a connection, never replay an HTTP request");
			assert.equal(f.writes.join("").match(/POST \/page/g)?.length, 1);
			assert.ok(f.writes.join("").endsWith("body"));
		} else assert.equal(f.writes.join(""), "tunnel-head");
	});
	test(`${protocol}: all approved candidates fail once with no DNS refresh or application data`, async t => {
		const f = await fixture(t, { mode: "all-refused" });
		const result = f.start(protocol);
		await once(protocol === "CONNECT" ? result.client : result.response, protocol === "CONNECT" ? "close" : "finish");
		assert.deepEqual(f.attempts, [bad.address, good.address]);
		assert.equal(f.lookup.mock.callCount(), 1);
		assert.equal(f.proxy.blockedRequests, 0);
		assert.deepEqual(f.writes, []);
		if (protocol === "CONNECT") assert.equal(result.client.destroyed, true);
		else assert.equal(result.response.status, 502);
	});
	test(`${protocol}: cancellation stops pending address selection and cannot launch a later attempt`, async t => {
		const f = await fixture(t, { mode: "blackhole" });
		const result = f.start(protocol); await flush();
		assert.deepEqual(f.attempts, [bad.address]);
		f.controller.abort(); await timers.setTimeout(350);
		assert.deepEqual(f.attempts, [bad.address]);
		assert.equal(result.client.destroyed, true);
		assert.ok(f.sockets.every(socket => socket.destroyed));
		assert.deepEqual(f.writes, []);
	});
}

test("CONNECT: failed IPv4 can use vetted IPv6; IPv6-only snapshots work too", async t => {
	const v6 = { address: "2606:4700:4700::1111", family: 6 };
	const f = await fixture(t, { addresses: [v6, bad] });
	const result = f.start("CONNECT"); await flush();
	assert.equal(result.success(), true);
	assert.deepEqual(f.attempts, [bad.address, v6.address]);
	await f.proxy.close();
	const other = await fixture(t, { addresses: [v6] });
	const onlyV6 = other.start("CONNECT"); await flush();
	assert.equal(onlyV6.success(), true);
	assert.deepEqual(other.attempts, [v6.address]);
});

test("HTTP: failure after sending application data never replays the request on another IP", async t => {
	const f = await fixture(t, { mode: "reset-after-write", addresses: [good, bad] });
	const result = f.start("HTTP");
	await once(result.response, "finish");
	assert.equal(result.response.status, 502);
	assert.equal(f.requests(), 1);
	assert.deepEqual(f.attempts, [good.address]);
	assert.equal(f.writes.join("").match(/POST \/page/g)?.length, 1);
});

test("CONNECT: client idle deadline closes a stalled final candidate", async t => {
	const f = await fixture(t, { mode: "blackhole", addresses: [bad] });
	const result = f.start("CONNECT"); await flush();
	assert.equal(result.client.timeout.ms, 15_000);
	result.client.timeout.callback(); await flush();
	assert.ok(result.client.destroyed && f.sockets.every(socket => socket.destroyed));
	assert.deepEqual(f.attempts, [bad.address]);
});
