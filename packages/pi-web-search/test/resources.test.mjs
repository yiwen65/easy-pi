import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, test } from "node:test";
import tls from "node:tls";
import { mockBrowser } from "./browser-mock.mjs";

assert.equal(process.env.PI_WEB_SEARCH_OFFLINE, "1", "Use node test/run.mjs; do not run this file in your normal environment.");
assert.match(homedir(), /^\/tmp\/pi-web-search-offline-[^/]+\/home$/);
assert.equal(process.env.EASY_PI_CODING_AGENT_DIR, join(homedir(), ".epi", "agent"));
assert.equal(process.env.PI_CODING_AGENT_DIR, process.env.EASY_PI_CODING_AGENT_DIR);

// The same isolation guard as offline.test.mjs: a real socket, DNS, TLS, datagram or
// subprocess call fails the test instead of escaping the sandbox. Mocking only replaces
// the OS/CDP boundary, so the production cancellation, cleanup and metric code all runs.
const unexpectedIO = [];
function denyIO(kind) {
	return () => {
		unexpectedIO.push(kind);
		throw new Error(`OFFLINE: unexpected ${kind}`);
	};
}
globalThis.fetch = denyIO("fetch");
net.Socket.prototype.connect = denyIO("socket connection");
net.Server.prototype.listen = denyIO("server listener");
dns.lookup = denyIO("DNS lookup");
tls.connect = denyIO("TLS connection");
dgram.Socket.prototype.send = denyIO("datagram send");
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
	childProcess[method] = denyIO(`child_process.${method}`);
}
syncBuiltinESMExports();

const { readPage, webFetchSlotStats } = await import("../src/browser.ts");

const PAGE_URL = "https://page.public.org/docs";

const profileDirs = () => readdirSync(process.env.TMPDIR).filter((name) => name.startsWith("pi-web-fetch-"));
const signalsSent = (mock) => mock.kills.filter((entry) => entry.signal !== 0);
const probes = (mock) => mock.kills.filter((entry) => entry.signal === 0);
const isSampleExpression = (expression) =>
	typeof expression === "string" &&
	expression.includes("__easyPiFullPageScan1") &&
	!expression.endsWith(".advance()");

/** The cap override is launcher configuration; it must never leak into another test. */
function setConcurrency(t, value) {
	const previous = process.env.PI_WEB_FETCH_CONCURRENCY;
	if (value === undefined) delete process.env.PI_WEB_FETCH_CONCURRENCY;
	else process.env.PI_WEB_FETCH_CONCURRENCY = value;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_WEB_FETCH_CONCURRENCY;
		else process.env.PI_WEB_FETCH_CONCURRENCY = previous;
	});
}

async function until(predicate, label) {
	for (let attempt = 0; attempt < 2000; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(`Timed out waiting for ${label}`);
}

/** Await an outcome without letting a rejection escape the test body. */
async function captured(promise) {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, error };
	}
}

/** A rejected read must not leave a process, slot, listener or temporary profile behind. */
function assertNoLeftovers(mock, label) {
	const stats = webFetchSlotStats();
	assert.equal(stats.running, 0, `${label}: the browser slot must be released`);
	assert.equal(stats.queued, 0, `${label}: no waiter may be left queued`);
	assert.deepEqual(profileDirs(), [], `${label}: the temporary profile must be removed`);
	assert.ok(
		mock.servers.every((server) => server.closed),
		`${label}: the proxy listener must be closed`,
	);
	assert.ok(
		mock.processes.every((child) => !child.pid || child.exitCode !== null || child.signalCode !== null),
		`${label}: the browser process must be gone`,
	);
}

/** Every read stops at Page.navigate until the test answers it, which keeps concurrency observable. */
function navigateGate(t, options = {}) {
	const entries = [];
	const mock = mockBrowser(t, {
		...options,
		hangOn: "Page.navigate",
		onCommand(command, child) {
			if (command.method === "Page.navigate") entries.push({ command, child });
			options.onCommand?.(command, child);
		},
	});
	return { mock, entries };
}

function respondNavigate(entry) {
	entry.child.stdio[4].write(`${JSON.stringify({ id: entry.command.id, result: { frameId: "main" } })}\0`);
}

/** A socket stub for tunnel bytes: accepts writes and never echoes data back. */
class TunnelSocket extends Duplex {
	writes = [];
	#read = 0;
	#written = 0;
	_read() {}
	_write(chunk, _encoding, done) {
		this.writes.push(chunk.toString());
		done();
	}
	setTimeout() {
		return this;
	}
	report(bytesRead, bytesWritten) {
		this.#read = bytesRead;
		this.#written = bytesWritten;
		return this;
	}
	get bytesRead() {
		return this.#read;
	}
	get bytesWritten() {
		return this.#written;
	}
}

afterEach(() => {
	assert.deepEqual(unexpectedIO, [], "No unmocked network or subprocess calls are allowed");
});

test("R01: a pre-aborted read rejects cancelled without a browser, proxy, deadline or directory", async (t) => {
	const timeout = t.mock.method(AbortSignal, "timeout", denyIO("deadline for a pre-aborted read"));
	const mock = mockBrowser(t);
	const outcome = await captured(readPage(PAGE_URL, AbortSignal.abort(new Error("synthetic-abort-reason"))));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error.code, "cancelled");
	assert.equal(outcome.error.message, "Web request cancelled.");
	assert.equal(timeout.mock.callCount(), 0, "A pre-aborted read must not start a deadline");
	assert.deepEqual(mock.calls, [], "No browser may be spawned");
	assert.deepEqual(mock.servers, [], "No proxy may be started");
	assert.deepEqual(webFetchSlotStats(), { running: 0, queued: 0, maxObserved: 0, limit: 2 });
	assertNoLeftovers(mock, "pre-abort");
});

test("R01/R04: a read cancelled while queued for a slot rejects cancelled, spawns nothing, and the freed slot serves the next read", async (t) => {
	setConcurrency(t, "1");
	const { mock, entries } = navigateGate(t);
	const first = readPage(PAGE_URL);
	await until(() => entries.length === 1, "the first read to hold the only slot and reach navigation");
	assert.equal(webFetchSlotStats().running, 1);
	const controller = new AbortController();
	const queued = readPage(PAGE_URL, controller.signal);
	await until(() => webFetchSlotStats().queued === 1, "the second read to queue for a slot");
	assert.equal(mock.calls.length, 1, "A read waiting for a slot must not create a browser");
	controller.abort(new Error("synthetic-abort-reason"));
	const rejected = await captured(queued);
	assert.equal(rejected.ok, false, "A cancelled queued read must never resolve");
	assert.equal(rejected.error.code, "cancelled");
	assert.equal(rejected.error.message, "Web request cancelled.");
	await until(() => webFetchSlotStats().queued === 0, "the cancelled waiter to free its place");
	assert.equal(webFetchSlotStats().running, 1, "Freeing a queued place must not disturb the running read");
	assert.equal(mock.calls.length, 1);
	respondNavigate(entries[0]);
	const firstPage = await first;
	assert.equal(firstPage.metrics.browsers, 1);
	assert.equal(firstPage.metrics.queued, false);
	// The released slot must serve the next waiter instead of leaving the queue deadlocked.
	const third = readPage(PAGE_URL);
	await until(() => entries.length === 2, "the next read to take the freed slot");
	assert.equal(webFetchSlotStats().running, 1);
	respondNavigate(entries[1]);
	const thirdPage = await third;
	assert.equal(thirdPage.metrics.queued, false);
	assert.equal(mock.calls.length, 2, "The cancelled waiter must never have spawned a browser");
	assert.equal(webFetchSlotStats().running, 0);
	assertNoLeftovers(mock, "queued cancel");
});

test("R01: cancellation during browser startup rejects cancelled and leaves no browser work", async (t) => {
	const controller = new AbortController();
	const mock = mockBrowser(t, {
		onCommand(command) {
			if (command.method === "Browser.getVersion") controller.abort(new Error("synthetic-abort-reason"));
		},
	});
	const outcome = await captured(readPage(PAGE_URL, controller.signal));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error.code, "cancelled");
	assert.equal(mock.calls.length, 1, "The browser was already spawned when the cancellation arrived");
	assert.deepEqual(profileDirs(), []);
	assert.deepEqual(signalsSent(mock), [{ pid: -mock.processes[0].pid, signal: "SIGTERM" }]);
	assert.equal(mock.processes[0].signalCode, "SIGTERM");
	assertNoLeftovers(mock, "startup cancel");
});

test("R01: cancellation during navigation rejects cancelled without returning partial content", async (t) => {
	const controller = new AbortController();
	const mock = mockBrowser(t, {
		onCommand(command) {
			if (command.method === "Page.navigate") controller.abort(new Error("synthetic-abort-reason"));
		},
	});
	const outcome = await captured(readPage(PAGE_URL, controller.signal));
	assert.equal(outcome.ok, false, "A cancelled navigation must not resolve with page content");
	assert.equal(outcome.error.code, "cancelled");
	assertNoLeftovers(mock, "navigation cancel");
});

test("R01: cancellation during sampling rejects cancelled and removes the temporary profile", async (t) => {
	const controller = new AbortController();
	let samples = 0;
	const mock = mockBrowser(t, {
		onCommand(command) {
			if (command.method !== "Runtime.evaluate" || !isSampleExpression(command.params.expression)) return;
			samples++;
			controller.abort(new Error("synthetic-abort-reason"));
		},
	});
	const outcome = await captured(readPage(PAGE_URL, controller.signal));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error.code, "cancelled");
	assert.equal(samples, 1, "The cancellation must land on the first evaluated page sample");
	assertNoLeftovers(mock, "sampling cancel");
});

test("R01: cancellation during the end verification pass rejects cancelled and leaves no work behind", async (t) => {
	const controller = new AbortController();
	let frameTrees = 0;
	let samples = 0;
	const mock = mockBrowser(t, {
		onCommand(command) {
			if (command.method === "Page.getFrameTree") {
				// The main scan walks the frame tree once; the second walk is the bounded
				// end re-verification of frames that already settled.
				if (++frameTrees === 2) controller.abort(new Error("synthetic-abort-reason"));
				return;
			}
			if (command.method === "Runtime.evaluate" && isSampleExpression(command.params.expression)) samples++;
		},
	});
	const outcome = await captured(readPage(PAGE_URL, controller.signal));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error.code, "cancelled");
	assert.equal(frameTrees, 2, "The cancellation must land on the end verification pass");
	assert.ok(samples >= 5, `Sampling must have run before the end verification pass (saw ${samples})`);
	assertNoLeftovers(mock, "end verification cancel");
});

test("R01: cancellation during cleanup still cleans up, rejects cancelled and never reports success", async (t) => {
	const controller = new AbortController();
	let samples = 0;
	const mock = mockBrowser(t, {
		onCommand(command) {
			if (command.method === "Runtime.evaluate" && isSampleExpression(command.params.expression)) samples++;
			if (command.method === "Browser.close") controller.abort(new Error("synthetic-abort-reason"));
		},
	});
	const outcome = await captured(readPage(PAGE_URL, controller.signal));
	assert.equal(outcome.ok, false, "A read cancelled while cleaning up must not return its content");
	assert.equal(outcome.error.code, "cancelled");
	assert.ok(samples > 0, "The page had already been scanned before the cleanup cancellation");
	assert.equal(mock.commands.some((command) => command.method === "Browser.close"), true);
	assertNoLeftovers(mock, "cleanup cancel");
});

test("R02: a surviving owned group after the main child exited fails cleanup, keeps the profile and sends no signal", async (t) => {
	const mock = mockBrowser(t, { groupSurvives: true });
	const outcome = await captured(readPage(PAGE_URL));
	assert.equal(outcome.ok, false, "An unconfirmed process group must never look like a successful read");
	assert.equal(outcome.error.code, "cleanup-failed");
	assert.equal(mock.processes[0].exitCode, 0, "The fake browser's main child exited normally");
	const preserved = profileDirs();
	assert.equal(preserved.length, 1, "The directory of an unconfirmed browser must be preserved");
	assert.deepEqual(signalsSent(mock), [], "An exited main child must never be signalled again (pid reuse)");
	assert.deepEqual(signalsSent(mock), [], "An exited main child must never be signalled again (pid reuse)");
	assert.ok(
		probes(mock).length > 0 && probes(mock).every((entry) => entry.pid === -mock.processes[0].pid),
		"Only the owned group may be probed for liveness",
	);
	assert.equal(webFetchSlotStats().running, 0, "The slot must be released even when cleanup fails");
	// The product preserved the directory; the test removes it after asserting that fact.
	rmSync(join(process.env.TMPDIR, preserved[0]), { recursive: true, force: true });
	assert.deepEqual(profileDirs(), []);
});

test("R02: an unresponsive browser is escalated SIGTERM then SIGKILL only against its own process group", async (t) => {
	const mock = mockBrowser(t, { ignoreClose: true, ignoreTerm: true });
	const page = await readPage(PAGE_URL);
	assert.equal(page.metrics.browsers, 1);
	const pid = mock.processes[0].pid;
	assert.deepEqual(
		signalsSent(mock),
		[
			{ pid: -pid, signal: "SIGTERM" },
			{ pid: -pid, signal: "SIGKILL" },
		],
		"Escalation must be bounded, ordered and addressed to the owned group only",
	);
	assert.equal(mock.processes[0].signalCode, "SIGKILL");
	assert.deepEqual(profileDirs(), [], "A confirmed exit removes the temporary profile");
});

test("R02: a spawn failure signals nothing, removes the profile and releases the slot", async (t) => {
	const mock = mockBrowser(t, { spawnError: true });
	const outcome = await captured(readPage(PAGE_URL));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error.code, "protocol-failed");
	assert.match(outcome.error.message, /could not be started|connection is closed/);
	assert.equal(mock.calls.length, 1);
	assert.deepEqual(mock.kills, [], "There is no owned process to signal after a spawn failure");
	assertNoLeftovers(mock, "spawn failure");
});

test("R03: a CDP message split across chunks is reassembled and the read completes", async (t) => {
	const mock = mockBrowser(t, { splitResponse: "Page.navigate" });
	const page = await readPage(PAGE_URL);
	assert.ok(page.text.includes("Anonymous rendered content"));
	assert.equal(page.scanComplete, true);
	assert.ok(page.metrics.cdpBytesIn > 0);
	assert.ok(page.metrics.samples >= 1);
	assert.deepEqual(profileDirs(), []);
	assert.equal(mock.processes[0].exitCode, 0);
});

test("R03: several NUL-terminated messages in one chunk are all handled", async (t) => {
	const mock = mockBrowser(t, { batchedResponse: "Page.enable" });
	const page = await readPage(PAGE_URL);
	assert.ok(page.text.includes("Anonymous rendered content"));
	assert.equal(page.scanComplete, true);
	assert.ok(page.metrics.cdpBytesIn > 0 && page.metrics.cdpBytesOut > 0);
	assert.equal(mock.processes[0].exitCode, 0);
	assert.deepEqual(profileDirs(), []);
});

test("R03: malformed CDP JSON rejects every pending call with protocol-failed and cleans up", async (t) => {
	const mock = mockBrowser(t, { invalidProtocol: true });
	const outcome = await captured(readPage(PAGE_URL));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error.code, "protocol-failed");
	assert.match(outcome.error.message, /invalid protocol data/);
	assertNoLeftovers(mock, "malformed protocol data");
});

test("R03: an oversized unterminated CDP frame rejects pending calls with protocol-failed and cleans up", async (t) => {
	const mock = mockBrowser(t, { oversizedResponse: "Page.enable" });
	const outcome = await captured(readPage(PAGE_URL));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error.code, "protocol-failed");
	assert.match(outcome.error.message, /4 MiB protocol limit/);
	assertNoLeftovers(mock, "oversized protocol frame");
});

for (const [option, when, expected] of [
	["endInputOn", "ends", /connection closed/],
	["errorInputOn", "errors", /connection failed/],
]) {
	test(`R03: a CDP input pipe that ${when} rejects pending calls with protocol-failed and cleans up`, async (t) => {
		const mock = mockBrowser(t, { [option]: "Page.navigate" });
		const outcome = await captured(readPage(PAGE_URL));
		assert.equal(outcome.ok, false, `A pipe that ${when} must not resolve the read`);
		assert.equal(outcome.error.code, "protocol-failed");
		assert.match(outcome.error.message, expected);
		assertNoLeftovers(mock, `CDP pipe that ${when}`);
	});
}

test("R03: a per-command protocol timeout rejects pending calls with read-timeout and cleans up", async (t) => {
	// Only the timer is shortened here: the product keeps its own 90-second budget, which
	// the assertion below proves was passed unchanged.
	t.mock.method(globalThis, "setTimeout", (callback, ms) => {
		assert.equal(ms, 90_000);
		setImmediate(() => callback());
		return { timer: ms };
	});
	const mock = mockBrowser(t, { hangOn: "Browser.getVersion" });
	const outcome = await captured(readPage(PAGE_URL));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error.code, "read-timeout");
	assert.match(outcome.error.message, /protocol command timed out/);
	assert.deepEqual(signalsSent(mock), [], "The timed-out browser still closed cleanly");
	assertNoLeftovers(mock, "per-command timeout");
});

test("R04: concurrent reads never exceed the default cap of 2 and a queued read creates nothing", async (t) => {
	setConcurrency(t, undefined);
	const { mock, entries } = navigateGate(t);
	const reads = [readPage(PAGE_URL), readPage(PAGE_URL)];
	await until(() => entries.length === 2, "two reads to hold the two default slots");
	assert.deepEqual(webFetchSlotStats(), { running: 2, queued: 0, maxObserved: 2, limit: 2 });
	const third = readPage(PAGE_URL);
	await until(() => webFetchSlotStats().queued === 1, "the third read to queue");
	assert.equal(mock.calls.length, 2, "A queued read must not create a browser before it owns a slot");
	assert.deepEqual(webFetchSlotStats(), { running: 2, queued: 1, maxObserved: 2, limit: 2 });
	respondNavigate(entries[0]);
	await until(() => entries.length === 3, "the freed slot to serve the queued read");
	assert.equal(webFetchSlotStats().running, 2, "A released slot serves exactly one waiter");
	respondNavigate(entries[1]);
	respondNavigate(entries[2]);
	const pages = await Promise.all([...reads, third]);
	assert.deepEqual(
		pages.map((page) => page.metrics.queued),
		[false, false, true],
		"Only the third read waited for a slot",
	);
	assert.equal(mock.calls.length, 3);
	assert.deepEqual(webFetchSlotStats().running, 0);
	assert.equal(webFetchSlotStats().maxObserved, 2, "The process-wide peak is the configured cap");
	assertNoLeftovers(mock, "default concurrency");
});

test("R04: missing or invalid PI_WEB_FETCH_CONCURRENCY falls back to the cap of 2", async (t) => {
	for (const value of [undefined, "", " ", "0", "9", "-1", "2.5", "two", "0x2", "1 2", "٣", "10"]) {
		setConcurrency(t, value);
		assert.equal(webFetchSlotStats().limit, 2, `PI_WEB_FETCH_CONCURRENCY=${JSON.stringify(value)} must fall back to 2`);
	}
	for (const value of ["1", "2", "8"]) {
		setConcurrency(t, value);
		assert.equal(webFetchSlotStats().limit, Number(value), "A valid launcher value is honoured");
	}
});

test("R04: PI_WEB_FETCH_CONCURRENCY=1 caps concurrency and no call argument can raise it", async (t) => {
	setConcurrency(t, "1");
	const { mock, entries } = navigateGate(t);
	const first = readPage(PAGE_URL);
	await until(() => entries.length === 1, "the first read to take the only slot");
	// An extra argument models any caller-supplied option; only the launcher environment counts.
	const second = readPage(PAGE_URL, undefined, { concurrency: 8, limit: 8 });
	const third = readPage(PAGE_URL, undefined, { concurrency: 8, limit: 8 });
	await until(() => webFetchSlotStats().running === 1 && webFetchSlotStats().queued === 2, "two reads to queue behind the cap of 1");
	assert.equal(mock.calls.length, 1, "The cap of 1 must allow exactly one browser");
	assert.equal(webFetchSlotStats().limit, 1);
	respondNavigate(entries[0]);
	await until(() => entries.length === 2, "the first queued read to take the freed slot");
	respondNavigate(entries[1]);
	await until(() => entries.length === 3, "the second queued read to take the freed slot");
	respondNavigate(entries[2]);
	const pages = await Promise.all([first, second, third]);
	assert.deepEqual(
		pages.map((page) => page.metrics.queued),
		[false, true, true],
		"Both followers waited for the single slot",
	);
	assert.equal(mock.calls.length, 3);
	assert.equal(webFetchSlotStats().running, 0);
	assertNoLeftovers(mock, "cap of one");
});

test("R04: read metrics are numbers only, bounded, and never contain page text or URL query/hash", async (t) => {
	const text = "PAGE_SECRET_TEXT_do_not_leak";
	const url = "https://page.public.org/docs?token=QUERY_SECRET#FRAGMENT_SECRET";
	const mock = mockBrowser(t, {
		url,
		text,
		onCommand(command, child) {
			if (command.method !== "Page.enable") return;
			// A refused request exercises the proxy counters without touching the network.
			mock.servers[0].handler({ url: "http://127.0.0.1/" }, { writeHead() {}, end() {} });
			assert.ok(child.pid);
		},
	});
	const page = await readPage(url);
	assert.deepEqual(Object.keys(page.metrics).sort(), [
		"browsers",
		"cdpBytesIn",
		"cdpBytesOut",
		"cleanupMs",
		"elapsedMs",
		"navigateMs",
		"proxyBytes",
		"proxyRequests",
		"queued",
		"samples",
		"scanMs",
		"startupMs",
	]);
	assert.equal(typeof page.metrics.queued, "boolean");
	for (const [name, value] of Object.entries(page.metrics)) {
		if (name === "queued") continue;
		assert.equal(typeof value, "number", name);
		assert.ok(Number.isFinite(value), `${name} must be finite, saw ${value}`);
		assert.ok(value >= 0, `${name} must not be negative, saw ${value}`);
	}
	assert.equal(page.metrics.browsers, 1);
	assert.equal(page.metrics.queued, false);
	assert.ok(page.metrics.samples >= 1 && page.metrics.samples <= 1000, `saw ${page.metrics.samples} samples`);
	assert.ok(page.metrics.cdpBytesIn > 0 && page.metrics.cdpBytesOut > 0);
	assert.ok(page.metrics.proxyBytes >= 0);
	assert.equal(page.metrics.proxyRequests, 1);
	assert.equal(page.blockedRequests, 1);
	for (const phase of ["startupMs", "navigateMs", "scanMs", "cleanupMs"])
		assert.ok(page.metrics[phase] <= page.metrics.elapsedMs, `${phase} must fit inside elapsedMs`);
	assert.ok(page.metrics.elapsedMs > 0 && page.metrics.elapsedMs < 30_000, `saw ${page.metrics.elapsedMs}ms`);
	const serialized = JSON.stringify(page.metrics);
	for (const secret of [text, url, "QUERY_SECRET", "FRAGMENT_SECRET", "page.public.org", "token"])
		assert.equal(serialized.includes(secret), false, `Metrics must not contain ${secret}`);
	assert.equal(mock.servers[0].closed, true);
});

test("R04: proxyRequests and proxyBytes meter a CONNECT tunnel without changing the pinned policy", async (t) => {
	const upstream = new TunnelSocket().report(120, 340);
	let pinned;
	t.mock.method(dns, "lookup", async (host) => {
		assert.equal(host, "page.public.org");
		return [{ address: "93.184.216.34", family: 4 }];
	});
	t.mock.method(net, "connect", (options) => {
		assert.equal(options.host, "page.public.org");
		assert.equal(options.port, 443);
		options.lookup(options.host, { all: true }, (_error, addresses) => {
			pinned = addresses;
		});
		queueMicrotask(() => upstream.emit("connect"));
		return upstream;
	});
	const client = new TunnelSocket();
	const mock = mockBrowser(t, {
		onCommand(command) {
			if (command.method !== "Page.enable") return;
			mock.servers[0].emit("connect", { url: "page.public.org:443" }, client, Buffer.alloc(0));
		},
	});
	const page = await readPage(PAGE_URL);
	assert.deepEqual(pinned, [{ address: "93.184.216.34", family: 4 }], "The tunnel must use the vetted snapshot, not a new lookup");
	assert.match(client.writes.join(""), /200 Connection Established/);
	assert.equal(page.metrics.proxyRequests, 1);
	assert.ok(
		page.metrics.proxyBytes >= 460,
		`Relayed transfer bytes must be metered (saw ${page.metrics.proxyBytes})`,
	);
	assert.equal(page.blockedRequests, 0, "An allowed tunnel is not a refusal");
	assert.equal(mock.servers[0].closed, true);
});
