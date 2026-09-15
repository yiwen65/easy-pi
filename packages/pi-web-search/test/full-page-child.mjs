import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns/promises";
import { existsSync, readdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { after, afterEach, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { fixturePage, markers } from "./full-page-fixtures.mjs";

assert.equal(process.env.PI_FULL_PAGE_BROWSER_TEST, "1", "Use test/full-page.mjs for isolated, explicit browser tests.");
assert.deepEqual(Object.keys(process.env).filter(name => /KEY|TOKEN|SECRET|AUTH|PROXY|^NODE_(OPTIONS|PATH)$/.test(name)), []);
const env = process.env;
const browsers = [], sockets = [], unexpected = [];
const hosts = new Set(["page.public.org", "frame.public.net", "leaf.public.edu"]);
const { TCP } = process.binding("tcp_wrap");
const tcpConnect = TCP.prototype.connect, tcpConnect6 = TCP.prototype.connect6;
const spawn = childProcess.spawn, lookup = dns.lookup, connect = net.connect;
let keyReads = 0, publicAttempts = 0, serverPort;
const server = http.createServer((request, response) => {
	if (request.method !== "GET") { unexpected.push("non-GET action"); response.writeHead(405); response.end(); return; }
	const html = fixturePage(new URL(request.url, "http://page.public.org").pathname);
	response.writeHead(request.url === "/hidden-auth" ? 403 : html ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" }); response.end(html ?? "Not found");
});
const serverSockets = new Set();
server.on("connection", socket => { serverSockets.add(socket); socket.once("close", () => serverSockets.delete(socket)); });

// The production guard still sees a complete all-public DNS snapshot. Only this
// test process maps the already-approved native TCP attempt to its own fixture.
// All non-fixture hostnames resolve to a blocked address; no external TCP is made.
dns.lookup = async host => [{ address: hosts.has(host) ? "8.8.8.8" : "127.0.0.1", family: 4 }];
TCP.prototype.connect = function(request, address, port) {
	assert.equal(address, "8.8.8.8", "Unexpected external or unvetted connection");
	assert.equal(port, 80); publicAttempts++;
	return tcpConnect.call(this, request, "127.0.0.1", serverPort);
};
TCP.prototype.connect6 = () => { unexpected.push("IPv6 connection"); throw new Error("No external IPv6 in fixtures"); };
net.connect = options => { const socket = connect(options); sockets.push(socket); return socket; };
childProcess.spawn = (file, args, options) => {
	assert.ok(args.includes("--remote-debugging-pipe"));
	assert.ok(!args.includes("--no-sandbox") && !args.includes("--ignore-certificate-errors"));
	assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);
	// HTTP fixtures must stay HTTP; this changes only the test browser's optional
	// HTTPS upgrade heuristic, not the proxy, sandbox or TLS validation policy.
	const flags = args.map(arg => arg.startsWith("--disable-features=") ? `${arg},HttpsUpgrades` : arg);
	const child = spawn(file, flags, options); browsers.push({ child, root: options.cwd }); return child;
};
globalThis.fetch = () => { unexpected.push("Node fetch"); throw new Error("No Node fetch or paid service in fixtures"); };
process.env = new Proxy(env, { get(target, key) {
	if (key === "TAVILY_API_KEY") { keyReads++; throw new Error("No credential access in browser fixtures"); }
	return Reflect.get(target, key);
} });
const { readPage } = await import(pathToFileURL(env.PI_WEB_FETCH_BROWSER_MODULE).href);

before(async () => {
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); serverPort = server.address().port;
});
afterEach(() => {
	assert.equal(keyReads, 0); assert.deepEqual(unexpected, []);
	assert.ok(browsers.every(({ child, root }) => !existsSync(root) && (child.exitCode !== null || child.signalCode !== null)));
	assert.ok(sockets.every(socket => socket.destroyed));
	assert.deepEqual(readdirSync(env.TMPDIR).filter(name => name.startsWith("pi-web-fetch-")), []);
});
after(async () => {
	process.env = env; dns.lookup = lookup; childProcess.spawn = spawn; net.connect = connect;
	TCP.prototype.connect = tcpConnect; TCP.prototype.connect6 = tcpConnect6;
	for (const socket of serverSockets) socket.destroy();
	await new Promise(resolve => server.close(resolve));
	assert.ok(publicAttempts > 0);
});
const read = path => readPage(`http://page.public.org${path}`);
const assertMarkers = (page, prefix, count) => {
	assert.deepEqual(page.text.match(new RegExp(`${prefix}_\\d{3}_汉字😀`, "gu")), markers(prefix, count));
};

test("static long text keeps Unicode and inline text and expands all named details without clicking", async () => {
	const page = await read("/static");
	assertMarkers(page, "S", 80);
	assert.ok(page.text.includes("inline content."));
	assert.ok(page.text.includes("EXPANDED_ONE") && page.text.includes("EXPANDED_TWO"));
	assert.ok(page.text.includes("STATIC_START") && page.text.includes("STATIC_END"));
	assert.equal(page.scanComplete, true);
});
for (const [path, prefix] of [["/virtual", "V"], ["/recycled", "R"], ["/hidden-axis", "H"]]) {
	test(`${path}: every virtual item is retained in order, including identical paragraphs`, async () => {
		const page = await read(path);
		assertMarkers(page, prefix, 36);
		assert.equal(page.text.match(/LEGAL_REPEAT/g)?.length, 36);
		assert.equal(page.scanComplete, true);
	});
}
test("two-axis virtualization scans each horizontal band rather than only the right edge", async () => {
	const page = await read("/grid");
	assertMarkers(page, "G", 36);
	assert.equal(page.scanComplete, true);
});
test("caller cancellation during an actual scroll scan closes browser, proxy and profile", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("SENSITIVE_ABORT_REASON")), 5500);
	try {
		await assert.rejects(readPage("http://page.public.org/infinite", controller.signal), error => {
			assert.equal(error.message, "Web request cancelled.");
			return true;
		});
	} finally { clearTimeout(timer); }
});
test("lazy loading and nested scrollers reach all content before the outer scroller moves away", async () => {
	const page = await read("/lazy");
	assertMarkers(page, "L", 32);
	assert.ok(page.text.includes("OUTER_START") && page.text.includes("OUTER_END"));
	assert.equal(page.scanComplete, true);
});
test("same-origin, OOPIF, nested and srcdoc frames are read; hidden authentication frames are excluded", async () => {
	const page = await read("/frames");
	for (const value of ["FRAME_PARENT_START", "FRAME_PARENT_END", "FRAME_SAME_TEXT", "FRAME_CROSS_TEXT", "FRAME_CROSS_END", "FRAME_NESTED_TEXT", "SRCDOC_TEXT"]) assert.ok(page.text.includes(value), value);
	assert.ok(!page.text.includes("HIDDEN_AUTH_SHOULD_NOT_APPEAR"));
	assert.equal(page.scanComplete, true);
	assert.ok(page.framesRead >= 5);
});
for (const path of ["/navigate", "/frame-navigation"]) {
	test(`${path}: document replacement cannot mix previous main or embedded content into the result`, async () => {
		const page = await read(path);
		assertMarkers(page, "S", 80);
		assert.ok(!/OBSOLETE|FRAME_SAME_TEXT/.test(page.text));
		assert.equal(page.scanComplete, true);
		assert.equal(page.url, "http://page.public.org/static");
	});
}
test("a visible policy-blocked iframe makes the parent capture explicitly incomplete", async () => {
	const page = await read("/blocked-frame");
	assert.ok(page.text.includes("VISIBLE_PARENT_TEXT") && page.text.includes("PARENT_END"));
	assert.equal(page.scanComplete, false);
	assert.ok(page.incompleteReasons.length > 0);
});
test("the aggregate text budget returns bounded partial content, never a false full-page success", async () => {
	const page = await read("/large");
	assert.ok(Array.from(page.text).length <= 262144);
	assert.equal(page.captureTruncated, true);
	assert.equal(page.scanComplete, false);
});
test("infinite scrolling stops at a bounded budget and reports partial capture", async () => {
	const page = await read("/infinite");
	assert.ok(page.text.includes("INFINITE_START"));
	assert.equal(page.scanComplete, false);
	assert.ok(page.incompleteReasons.some(reason => /limit|timeout/.test(reason)));
});
