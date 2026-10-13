import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns/promises";
import { existsSync, readdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { after, afterEach } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * Shared isolation harness for real-Chromium fixture tests.
 *
 * Every child file that uses it must be started through its wrapper
 * (`test/full-page.mjs --child=<file>`, which sets PI_FULL_PAGE_BROWSER_TEST and
 * PI_WEB_FETCH_BROWSER_MODULE). The harness keeps production policies intact:
 * the proxy, sandbox flags, TLS validation and the public-network guard all run
 * for real. Only the already-approved native TCP attempt is re-pointed at a
 * loopback fixture server, and only for the hosts the caller lists.
 */
export async function setupBrowserFixtures({ fixturePage, hosts }) {
	const env = process.env;
	assert.equal(env.PI_FULL_PAGE_BROWSER_TEST, "1", "Use a test/full-page*.mjs wrapper for isolated browser tests.");
	assert.deepEqual(
		Object.keys(env).filter((name) => /KEY|TOKEN|SECRET|AUTH|PROXY|^NODE_(OPTIONS|PATH)$/.test(name)),
		[],
		"The runner must not inherit credentials or runtime hooks",
	);
	const fixtureHosts = new Set(hosts);
	const browsers = [];
	const sockets = [];
	const unexpected = [];
	const { TCP } = process.binding("tcp_wrap");
	const tcpConnect = TCP.prototype.connect;
	const tcpConnect6 = TCP.prototype.connect6;
	const spawn = childProcess.spawn;
	const lookup = dns.lookup;
	const connect = net.connect;
	const serverSockets = new Set();
	const stats = { keyReads: 0, publicAttempts: 0, unexpected };
	let serverPort;

	const server = http.createServer((request, response) => {
		if (request.method !== "GET") {
			unexpected.push("non-GET action");
			response.writeHead(405);
			response.end();
			return;
		}
		const path = new URL(request.url, "http://fixture.invalid").pathname;
		const fixture = fixturePage(path);
		const html = typeof fixture === "string" ? fixture : fixture?.html;
		const status = typeof fixture === "string" ? 200 : (fixture?.status ?? (html ? 200 : 404));
		response.writeHead(status, { "Content-Type": fixture?.type ?? "text/html; charset=utf-8" });
		response.end(html ?? "Not found");
	});
	server.on("connection", (socket) => {
		serverSockets.add(socket);
		socket.once("close", () => serverSockets.delete(socket));
	});

	// The production guard still sees a complete all-public DNS snapshot. Only this
	// test process maps the already-approved native TCP attempt to its own fixture.
	// All other hostnames resolve to a blocked address; no external TCP is made.
	dns.lookup = async (host) => [{ address: fixtureHosts.has(host) ? "8.8.8.8" : "127.0.0.1", family: 4 }];
	TCP.prototype.connect = function (request, address, port) {
		assert.equal(address, "8.8.8.8", "Unexpected external or unvetted connection");
		assert.equal(port, 80);
		stats.publicAttempts++;
		return tcpConnect.call(this, request, "127.0.0.1", serverPort);
	};
	TCP.prototype.connect6 = () => {
		unexpected.push("IPv6 connection");
		throw new Error("No external IPv6 in fixtures");
	};
	net.connect = (options) => {
		const socket = connect(options);
		sockets.push(socket);
		return socket;
	};
	childProcess.spawn = (file, args, options) => {
		assert.ok(args.includes("--remote-debugging-pipe"));
		assert.ok(args.every((arg) => arg !== "--no-sandbox" && arg !== "--ignore-certificate-errors"));
		assert.deepEqual(Object.keys(options.env).sort(), [
			"HOME",
			"LANG",
			"PATH",
			"TMPDIR",
			"XDG_CACHE_HOME",
			"XDG_CONFIG_HOME",
		]);
		// HTTP fixtures must stay HTTP; this changes only the test browser's optional
		// HTTPS upgrade heuristic, not the proxy, sandbox or TLS validation policy.
		const flags = args.map((arg) =>
			arg.startsWith("--disable-features=") ? `${arg},HttpsUpgrades` : arg,
		);
		const child = spawn(file, flags, options);
		browsers.push({ child, root: options.cwd });
		return child;
	};
	globalThis.fetch = () => {
		unexpected.push("Node fetch");
		throw new Error("No Node fetch or paid service in fixtures");
	};
	process.env = new Proxy(env, {
		get(target, key) {
			if (key === "TAVILY_API_KEY") {
				stats.keyReads++;
				throw new Error("No credential access in browser fixtures");
			}
			return Reflect.get(target, key);
		},
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	serverPort = server.address().port;

	afterEach(() => {
		assert.equal(stats.keyReads, 0);
		assert.deepEqual(unexpected, []);
		assert.ok(
			browsers.every(
				({ child, root }) => !existsSync(root) && (child.exitCode !== null || child.signalCode !== null),
			),
		);
		assert.ok(sockets.every((socket) => socket.destroyed));
		assert.deepEqual(
			readdirSync(env.TMPDIR).filter((name) => name.startsWith("pi-web-fetch-")),
			[],
		);
	});
	after(async () => {
		process.env = env;
		dns.lookup = lookup;
		childProcess.spawn = spawn;
		net.connect = connect;
		TCP.prototype.connect = tcpConnect;
		TCP.prototype.connect6 = tcpConnect6;
		for (const socket of serverSockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	});

	const { readPage } = await import(pathToFileURL(env.PI_WEB_FETCH_BROWSER_MODULE).href);
	return { readPage, stats, browsers };
}
