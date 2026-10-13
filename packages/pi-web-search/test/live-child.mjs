import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns/promises";
import { isFakeIpAddress, isPublicAddress } from "../src/network.ts";
import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";

assert.equal(process.env.PI_WEB_FETCH_LIVE, "1", "Use test/live.mjs, not a normal user environment.");
assert.deepEqual(Object.keys(process.env).filter(name => /KEY|TOKEN|SECRET|AUTH|PROXY|^NODE_(OPTIONS|PATH)$/.test(name)), []);
const env = process.env;
let keyReads = 0;
let fetchCalls = 0;
let connections = 0;
const browsers = [];
const snapshots = new Map();
const dialledModes = new Set();
const sockets = [];
const originalSpawn = childProcess.spawn;
const originalConnect = net.connect;
const originalLookup = dns.lookup;
dns.lookup = async (host, options) => {
	assert.equal(options.all, true);
	assert.equal(snapshots.has(host), false, "Each host must use one DNS snapshot per read");
	const addresses = await originalLookup(host, options);
	snapshots.set(host, addresses);
	return addresses;
};
childProcess.spawn = (file, args, options) => {
	assert.ok(args.includes("--remote-debugging-pipe"));
	assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);
	const child = originalSpawn(file, args, options);
	browsers.push({ child, root: options.cwd });
	return child;
};
net.connect = options => {
	assert.equal(typeof options.lookup, "function");
	assert.equal(options.autoSelectFamily, true);
	const approved = snapshots.get(options.host);
	assert.ok(approved?.length, "Every dialled host must come from the read's own vetted DNS snapshot");
	// The read either pins public addresses or, on a machine whose local DNS client answers in
	// fake-ip mode, dials those 198.18.0.0/15 addresses and lets that client route them. Never a
	// mixed snapshot, and the result must report exactly the mode that was dialled.
	const fakeIp = approved.filter(({ address }) => isFakeIpAddress(address));
	const publicIp = approved.filter(({ address }) => isPublicAddress(address));
	assert.ok(
		fakeIp.length === approved.length || publicIp.length === approved.length,
		`A DNS snapshot must be all public or all fake-ip, got ${JSON.stringify(approved)}`,
	);
	dialledModes.add(fakeIp.length === approved.length ? "local_fake_ip_client" : "pinned_public_ip");
	const socket = originalConnect(options);
	sockets.push(socket);
	socket.on("connectionAttempt", (address, port, family) => {
		assert.ok(approved.some(item => item.address === address && item.family === family), "Every actual TCP attempt must be in the vetted DNS snapshot");
		assert.ok([80, 443].includes(port));
		connections++;
	});
	return socket;
};
globalThis.fetch = () => { fetchCalls++; throw new Error("Node fetch/Tavily is forbidden in this live browser-only check."); };
process.env = new Proxy(env, { get(target, key) {
	if (key === "TAVILY_API_KEY") { keyReads++; throw new Error("web_fetch must not read Tavily credentials"); }
	return Reflect.get(target, key);
} });
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
const started = performance.now();
try {
	const { loadExtensions } = await import(pathToFileURL(env.PI_EXTENSION_LOADER).href);
	const loaded = await loadExtensions([env.PI_WEB_SEARCH_EXTENSION], process.cwd());
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const tool = loaded.extensions[0].tools.get("web_fetch").definition;
	const result = await tool.execute("live-public-page", { url: process.argv[2] }, controller.signal, undefined, {});
	const text = result.content[0].text;
	if (process.argv[3]) assert.ok(text.includes(process.argv[3]), "Expected visible page text was not returned");
	assert.equal(result.details.provider, "browser");
	// A live run must report the mode it really dialled, so a silent policy change cannot pass.
	assert.equal(result.details.dns_mode === "local_fake_ip_client", dialledModes.has("local_fake_ip_client"));
	assert.ok(dialledModes.size >= 1, "The live check must dial at least one vetted address");
	assert.equal(keyReads, 0); assert.equal(fetchCalls, 0);
	assert.ok(connections > 0);
	assert.ok(sockets.every(socket => socket.destroyed));
	assert.equal(browsers.length, 1);
	assert.ok(browsers.every(({ child, root }) => !existsSync(root) && (child.exitCode !== null || child.signalCode !== null)));
	assert.deepEqual(readdirSync(env.TMPDIR).filter(name => name.startsWith("pi-web-fetch-")), []);
	console.log(JSON.stringify({
		passed: true, elapsedMs: Math.round(performance.now() - started), entry: env.PI_WEB_SEARCH_EXTENSION,
		details: result.details, contentPreview: text.slice(0, 1800),
		browserCount: browsers.length, publicTcpConnections: connections, keyReads, tavilyOrNodeFetchCalls: fetchCalls, temporaryProfilesRemoved: true,
	}, null, 2));
} finally {
	process.env = env;
	childProcess.spawn = originalSpawn;
	net.connect = originalConnect;
	dns.lookup = originalLookup;
}
