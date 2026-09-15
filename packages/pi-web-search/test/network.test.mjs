import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { Duplex, PassThrough, Writable } from "node:stream";
import { test } from "node:test";

assert.equal(process.env.PI_WEB_SEARCH_OFFLINE, "1", "Use test/run.mjs for an isolated environment.");
const deny = () => { throw new Error("Unexpected real I/O in offline network tests"); };
dns.lookup = deny;
net.connect = deny;
net.Server.prototype.listen = deny;
http.request = deny;
const { isPublicAddress, publicTarget, resolvePublicHost, startPublicProxy } = await import("../src/network.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));

class Socket extends Duplex {
	writes = [];
	_read() {}
	_write(chunk, _encoding, done) { this.writes.push(chunk.toString()); done(); }
	setTimeout(ms, callback) { this.timeout = { ms, callback }; return this; }
}
class Response extends Writable {
	status = 0;
	headersSent = false;
	text = "";
	writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this; }
	_write(chunk, _encoding, done) { this.text += chunk.toString(); done(); }
}
async function proxyFixture(t, signal = new AbortController().signal) {
	const server = new EventEmitter();
	server.listen = (_port, host, callback) => { assert.equal(host, "127.0.0.1"); queueMicrotask(callback); return server; };
	server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 30123 });
	server.close = callback => { server.closed = true; queueMicrotask(() => callback?.()); return server; };
	t.mock.method(http, "createServer", handler => { server.handler = handler; return server; });
	const proxy = await startPublicProxy(signal);
	t.after(() => proxy.close());
	return { proxy, server, connect(authority, head = Buffer.alloc(0)) {
		const client = new Socket(); server.emit("connection", client);
		server.emit("connect", { url: authority }, client, head);
		return client;
	} };
}

test("IP policy excludes private, loopback, metadata, reserved, mapped and transitional ranges", () => {
	for (const address of [
		"", "not-an-ip", "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
		"192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
		"::", "::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1",
	]) assert.equal(isPublicAddress(address), false, address);
	for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "112.45.32.12", "172.32.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
		assert.equal(isPublicAddress(address), true, address);
	}
});

test("public target accepts only HTTP(S) domains and standard ports", () => {
	for (const url of ["https://docs.python.org:443/", "http://docs.python.org:80/", "https://例子.com/path"]) assert.ok(publicTarget(url));
	for (const url of ["http://localhost/", "https://a.internal/", "http://127.1/", "https://[::1]/", "https://user:pass@docs.python.org/", "file:///etc/passwd", "https://docs.python.org:8443/", "http://docs.python.org:443/"]) {
		assert.throws(() => publicTarget(url));
	}
});

test("DNS accepts all-public records, prefers IPv4, and retains every approved connection target", async (t) => {
	const lookup = t.mock.method(dns, "lookup", async (host, options) => {
		assert.equal(host, "docs.python.org"); assert.deepEqual(options, { all: true, verbatim: true });
		return [{ address: "2606:4700:4700::1111", family: 6 }, { address: "93.184.216.34", family: 4 }];
	});
	assert.deepEqual(await resolvePublicHost("docs.python.org"), [
		{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 },
	]);
	assert.equal(lookup.mock.callCount(), 1);
});

test("DNS rejects empty answers and any mixed public/private answer without echoing errors", async (t) => {
	let result = [];
	t.mock.method(dns, "lookup", async () => result);
	for (const records of [[], [{ address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }]]) {
		result = records;
		await assert.rejects(resolvePublicHost("docs.python.org"), /private or reserved addresses/);
	}
	t.mock.method(dns, "lookup", async () => { throw new Error("SENSITIVE_DNS_CAUSE"); });
	await assert.rejects(resolvePublicHost("docs.python.org"), error => error.message === "Public webpage DNS lookup failed." && !error.cause);
});

test("CONNECT pins public DNS to TCP and reuses only the approved snapshot within the read", async (t) => {
	const fixture = await proxyFixture(t);
	const approved = [{ address: "93.184.216.34", family: 4 }, { address: "1.1.1.1", family: 4 }];
	let answer = approved;
	const lookup = t.mock.method(dns, "lookup", async () => answer);
	const upstreams = [];
	const connect = t.mock.method(net, "connect", options => {
		assert.equal(options.host, "docs.python.org"); assert.equal(options.port, 443);
		assert.equal(options.family, undefined); assert.equal(options.autoSelectFamily, true);
		assert.equal(options.autoSelectFamilyAttemptTimeout, 250);
		const socket = new Socket(); upstreams.push(socket);
		options.lookup(options.host, { all: true }, (error, addresses) => {
			assert.equal(error, null); assert.deepEqual(addresses, approved);
			socket.emit("connect");
		});
		return socket;
	});
	const first = fixture.connect("docs.python.org:443", Buffer.from("tunnel-head"));
	await flush();
	answer = [{ address: "127.0.0.1", family: 4 }];
	const second = fixture.connect("docs.python.org:443");
	await flush();
	assert.equal(lookup.mock.callCount(), 1, "Cached snapshot cannot be rebound through a second DNS lookup");
	assert.equal(connect.mock.callCount(), 2);
	assert.match(first.writes.join(""), /200 Connection Established/);
	assert.match(second.writes.join(""), /200 Connection Established/);
	assert.equal(upstreams[0].writes.join(""), "tunnel-head");
	await fixture.proxy.close();
	assert.ok(first.destroyed && second.destroyed && upstreams.every(socket => socket.destroyed));
	assert.equal(fixture.server.closed, true);
});

test("CONNECT refuses local literals, nonstandard ports, malformed authority, and private DNS before TCP", async (t) => {
	const fixture = await proxyFixture(t);
	t.mock.method(dns, "lookup", async () => [{ address: "169.254.169.254", family: 4 }]);
	const connect = t.mock.method(net, "connect", deny);
	for (const authority of ["127.0.0.1:443", "[::1]:443", "docs.python.org:8080", "docs.python.org:443/extra", "user:pass@docs.python.org:443", "docs.python.org:443"]) {
		const client = fixture.connect(authority); await flush(); assert.match(client.writes.join(""), /403 Forbidden/);
	}
	assert.equal(connect.mock.callCount(), 0);
	assert.equal(fixture.proxy.blockedRequests, 6);
});

test("HTTP forwarding pins DNS, preserves the real Host, and removes proxy credentials", async (t) => {
	const fixture = await proxyFixture(t);
	t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
	const connect = t.mock.method(net, "connect", options => {
		assert.equal(options.host, "docs.python.org"); assert.equal(options.port, 80);
		assert.equal(options.autoSelectFamily, true); assert.equal(options.autoSelectFamilyAttemptTimeout, 250);
		options.lookup(options.host, { all: true }, (error, addresses) => {
			assert.equal(error, null); assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
		});
		return new Socket();
	});
	const outgoing = t.mock.method(http, "request", (options, callback) => {
		assert.equal(options.hostname, "docs.python.org"); assert.equal(options.port, 80); assert.equal(options.agent, undefined);
		const socket = options.createConnection();
		assert.equal(options.path, "/page?q=public"); assert.equal(options.headers.host, "docs.python.org");
		assert.equal(options.headers["proxy-authorization"], undefined); assert.equal(options.headers["proxy-connection"], undefined);
		const request = new PassThrough();
		queueMicrotask(() => {
			request.emit("socket", socket);
			const response = new PassThrough(); response.statusCode = 200; response.headers = { "content-type": "text/plain" };
			callback(response); response.end("public text");
		});
		return request;
	});
	const request = new PassThrough();
	request.url = "http://docs.python.org/page?q=public"; request.method = "GET";
	request.headers = { host: "forged.internal", "proxy-authorization": "PRIVATE_PROXY_TOKEN", "proxy-connection": "keep-alive" };
	const response = new Response();
	fixture.server.handler(request, response); request.end(); await flush();
	assert.equal(outgoing.mock.callCount(), 1); assert.equal(connect.mock.callCount(), 1);
	assert.equal(response.status, 200); assert.equal(response.text, "public text");
});

test("HTTP private-DNS and relative proxy requests are rejected without forwarding", async (t) => {
	const fixture = await proxyFixture(t);
	t.mock.method(dns, "lookup", async () => [{ address: "10.0.0.1", family: 4 }]);
	const outgoing = t.mock.method(http, "request", deny);
	for (const url of ["/relative", "http://docs.python.org/"]) {
		const request = new PassThrough(); request.url = url; request.headers = {};
		const response = new Response(); fixture.server.handler(request, response); request.end(); await flush();
		assert.equal(response.status, 403); assert.match(response.text, /public-network policy/);
	}
	assert.equal(outgoing.mock.callCount(), 0);
});

test("cancellation closes clients immediately and prevents late DNS from opening connections", async (t) => {
	const controller = new AbortController();
	const fixture = await proxyFixture(t, controller.signal);
	const answer = Promise.withResolvers();
	t.mock.method(dns, "lookup", () => answer.promise);
	const connect = t.mock.method(net, "connect", deny);
	const client = fixture.connect("docs.python.org:443");
	controller.abort(); await flush();
	assert.equal(client.destroyed, true); assert.equal(fixture.server.closed, true);
	answer.resolve([{ address: "93.184.216.34", family: 4 }]); await flush();
	assert.equal(connect.mock.callCount(), 0);
	await fixture.proxy.close();
});

test("a pre-aborted proxy does not create a listener", async (t) => {
	const create = t.mock.method(http, "createServer", deny);
	await assert.rejects(startPublicProxy(AbortSignal.abort()));
	assert.equal(create.mock.callCount(), 0);
});
