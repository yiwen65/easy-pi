import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { mockBrowser } from "./browser-mock.mjs";

assert.equal(process.env.PI_WEB_SEARCH_OFFLINE, "1", "Use node test/run.mjs; do not run this file in your normal environment.");
assert.match(homedir(), /^\/tmp\/pi-web-search-offline-[^/]+\/home$/);
assert.equal(process.env.EASY_PI_CODING_AGENT_DIR, join(homedir(), ".epi", "agent"));
assert.equal(process.env.PI_CODING_AGENT_DIR, process.env.EASY_PI_CODING_AGENT_DIR);

// These guards exist before even importing Pi, whose loader imports provider modules.
// Tests replace fetch with a local responder only; restoring mocks restores denial.
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

const FAKE_KEY = "tvly-offline-only-not-a-real-key";
const PROVIDER_SECRET = `synthetic-provider-private-data:${FAKE_KEY}`;
const PAGE_URL = "https://docs.python.org/3/";
const MAX_RESPONSE_BYTES = 1_048_576;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/;

// A missing key alone would not prove the extension deferred reading it. Trap the
// synthetic environment during real module loading and factory registration too.
const isolatedEnv = process.env;
assert.deepEqual(Object.keys(isolatedEnv).filter((name) =>
	/KEY|TOKEN|CREDENTIAL|SECRET|AUTH|PROXY|^NODE_(OPTIONS|PATH)$/.test(name)), [], "The runner must not inherit credentials or runtime hooks");
assert.equal(isolatedEnv.TAVILY_API_KEY, undefined);
let startupKeyReads = 0;
process.env = new Proxy(isolatedEnv, {
	get(target, key) {
		if (key === "TAVILY_API_KEY") {
			startupKeyReads++;
			throw new Error("TAVILY_API_KEY must not be read during extension loading");
		}
		return Reflect.get(target, key);
	},
});
let loaded;
try {
	const { loadExtensions } = await import(pathToFileURL(isolatedEnv.PI_EXTENSION_LOADER).href);
	loaded = await loadExtensions([isolatedEnv.PI_WEB_SEARCH_EXTENSION], process.cwd());
} finally {
	process.env = isolatedEnv;
}
assert.deepEqual(loaded.errors, [], "The actual Pi/Jiti loader must load this extension");
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
const tools = new Map([...extension.tools].map(([name, tool]) => [name, tool.definition]));

beforeEach(() => { process.env.TAVILY_API_KEY = FAKE_KEY; });
afterEach(() => {
	delete process.env.TAVILY_API_KEY;
	assert.deepEqual(unexpectedIO, [], "No unmocked network or subprocess calls are allowed, including during startup");
});

// Invoke registered native execute functions, not an exported factory or a mock API.
// Pi marks thrown execute errors as failed tools; do not expect an isError return.
function execute(name, params, signal) {
	return tools.get(name).execute("offline-call", params, signal, undefined, {});
}
function text(result) {
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0].type, "text");
	return result.content[0].text;
}
function timestamp(result) {
	const value = result.details.retrievedAt;
	assert.equal(new Date(value).toISOString(), value);
	assert.ok(Math.abs(Date.now() - Date.parse(value)) < 10_000);
	assert.ok(text(result).includes(`Retrieved: ${value}`));
}
async function rejectsSafe(promise, expected, label) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof Error, label);
		assert.match(error.message, expected, label);
		for (const secret of [FAKE_KEY, PROVIDER_SECRET]) {
			assert.equal(String(error.stack).includes(secret), false, "Errors must not echo provider or credential data");
		}
		assert.equal(error.cause, undefined);
		return true;
	});
}
function mockFetch(t, responder, expectedCalls = 1) {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url, options) => {
		calls.push({ url, options });
		return responder(url, options);
	});
	t.after(() => {
		assert.equal(calls.length, expectedCalls, "Exactly one request per execution; no retries, fallback, or cached pages");
		for (const { url, options } of calls) {
			assert.equal(url, "https://api.tavily.com/search");
			assert.equal(options.method, "POST");
			assert.equal(options.redirect, "error", "Never follow redirects with credentials");
			assert.ok(options.signal instanceof AbortSignal);
			assert.equal(options.body.includes(FAKE_KEY), false);
		}
	});
	return calls;
}
function requestContract(call, endpoint, body, key = FAKE_KEY) {
	assert.equal(call.url, `https://api.tavily.com/${endpoint}`);
	assert.deepEqual(Object.keys(call.options).sort(), ["body", "headers", "method", "redirect", "signal"]);
	assert.deepEqual(call.options.headers, { "Content-Type": "application/json", Authorization: `Bearer ${key}` });
	assert.deepEqual(JSON.parse(call.options.body), body);
}
function source(overrides = {}) {
	return { title: "Python docs", url: PAGE_URL, content: "A short source excerpt.", ...overrides };
}
const operations = [
	["web_search", { query: "public information" }, "search"],
];

test("real Pi loader registers exactly two tools without a key, key reads, or startup I/O", () => {
	assert.equal(startupKeyReads, 0);
	assert.equal(extension.path, isolatedEnv.PI_WEB_SEARCH_EXTENSION);
	assert.deepEqual([...tools.keys()].sort(), ["web_fetch", "web_search"]);
	for (const collection of ["handlers", "commands", "flags", "shortcuts", "messageRenderers", "entryRenderers"]) {
		assert.equal(extension[collection].size, 0);
	}
	assert.deepEqual(loaded.runtime.pendingProviderRegistrations, []);
	assert.deepEqual(loaded.runtime.pendingNativeProviderRegistrations, []);
	for (const [name, fields, required] of [
		["web_search", ["limit", "query"], ["query"]],
		["web_fetch", ["max_chars", "offset", "url"], ["url"]],
	]) {
		const tool = tools.get(name);
		assert.equal(tool.parameters.additionalProperties, false);
		assert.deepEqual(Object.keys(tool.parameters.properties).sort(), fields);
		assert.deepEqual(tool.parameters.required, required);
		assert.ok(tool.promptSnippet);
		assert.ok(tool.promptGuidelines.length);
	}
});

test("native loader can still discover the source entry through a directory symlink", async () => {
	const directory = join(isolatedEnv.EASY_PI_CODING_AGENT_DIR, "extensions");
	mkdirSync(directory);
	symlinkSync(dirname(isolatedEnv.PI_WEB_SEARCH_EXTENSION), join(directory, "web-search"), "dir");
	const { discoverAndLoadExtensions } = await import(pathToFileURL(isolatedEnv.PI_EXTENSION_LOADER).href);
	const discovered = await discoverAndLoadExtensions([], process.cwd(), isolatedEnv.EASY_PI_CODING_AGENT_DIR);
	assert.deepEqual(discovered.errors, []);
	assert.equal(discovered.extensions.length, 1);
	assert.equal(discovered.extensions[0].path, join(directory, "web-search", "index.ts"));
	assert.deepEqual([...discovered.extensions[0].tools.keys()].sort(), ["web_fetch", "web_search"]);
});

test("missing, empty, and whitespace-only keys throw setup guidance without making a request", async () => {
	for (const key of [undefined, "", " \n\t "]) {
		if (key === undefined) delete process.env.TAVILY_API_KEY;
		else process.env.TAVILY_API_KEY = key;
		for (const [name, params] of operations) {
			await rejectsSafe(execute(name, params), /TAVILY_API_KEY is not configured\..*restart easy-pi\..*Do not paste the key into chat/);
		}
	}
});

test("Basic Search has an exact request contract and attributed, cleaned excerpts, not an answer", async (t) => {
	const calls = mockFetch(t, () => Response.json({
		results: [source({
			title: "\x1b[31mPython\x1b[0m\x00 docs",
			url: "HTTPS://DOCS.PYTHON.ORG:443/3/../3/",
			content: "\x1b]8;;https://docs.python.org\x07Read docs\x1b]8;;\x07\x7f\nShort excerpt.",
			raw_content: "FULL_PAGE_NOT_REQUESTED",
		})],
		answer: "GENERATED_ANSWER_NOT_REQUESTED",
		usage: { credits: 1 },
	}));
	const result = await execute("web_search", { query: " \x1b[32mPython docs\x1b[0m\x00 \n" });
	requestContract(calls[0], "search", {
		query: "Python docs", search_depth: "basic", max_results: 5, chunks_per_source: 1,
		include_answer: false, include_raw_content: false, auto_parameters: false, include_usage: true,
	});
	assert.deepEqual(result.details.sources, [{
		title: "Python docs", url: PAGE_URL, snippet: "Read docs\nShort excerpt.", truncated: false,
	}]);
	assert.equal(result.details.provider, "tavily");
	assert.equal(result.details.query, "Python docs");
	assert.equal(result.details.omitted, 0);
	assert.equal(result.details.credits, 1);
	assert.match(text(result), /UNTRUSTED WEB SEARCH EXCERPTS \(not full-page content\)/);
	assert.ok(text(result).includes(`URL: ${PAGE_URL}`));
	assert.doesNotMatch(text(result), CONTROLS);
	assert.doesNotMatch(JSON.stringify(result), /FULL_PAGE_NOT_REQUESTED|GENERATED_ANSWER_NOT_REQUESTED/);
	timestamp(result);
});

test("keys are read at execution, trimmed in the header, and never placed in request bodies", async (t) => {
	const calls = mockFetch(t, () => Response.json({ results: [] }), 2);
	for (const key of [FAKE_KEY, `${FAKE_KEY}-rotated`]) {
		process.env.TAVILY_API_KEY = ` \t${key}\n `;
		await execute("web_search", { query: "public" });
		assert.equal(calls.at(-1).options.headers.Authorization, `Bearer ${key}`);
		assert.equal(calls.at(-1).options.body.includes(key), false);
	}
});

test("search respects limit 1/default 5/10, the 512-character query boundary, and omission accounting", async (t) => {
	const calls = mockFetch(t, () => Response.json({ results: Array.from({ length: 12 }, () => source()) }), 3);
	for (const limit of [1, undefined, 10]) {
		const result = await execute("web_search", { query: "q".repeat(512), limit });
		const expected = limit ?? 5;
		assert.equal(JSON.parse(calls.at(-1).options.body).max_results, expected);
		assert.equal(result.details.sources.length, expected);
		assert.equal(result.details.omitted, 12 - expected);
		assert.match(text(result), new RegExp(`Omitted ${12 - expected} invalid or over-limit results`));
	}
});

test("a genuinely empty search succeeds; partial invalid rows are omitted and renumbered", async (t) => {
	let response = { results: [] };
	mockFetch(t, () => Response.json(response), 2);
	const empty = await execute("web_search", { query: "nothing" });
	assert.deepEqual(empty.details.sources, []);
	assert.equal(empty.details.omitted, 0);
	assert.match(text(empty), /No search results\./);
	response = { results: [null, source({ url: "http://127.0.0.1/" }), source({ title: undefined }), source({ content: 3 }), source()] };
	const partial = await execute("web_search", { query: "some" });
	assert.equal(partial.details.sources.length, 2);
	assert.equal(partial.details.sources[0].title, PAGE_URL);
	assert.equal(partial.details.omitted, 3);
	assert.match(text(partial), /\[1\].*\nURL:/);
	assert.match(text(partial), /\[2\].*\nURL:/);
	assert.doesNotMatch(text(partial), /No search results|127\.0\.0\.1/);
});

test("malformed envelopes and all-invalid search rows never masquerade as empty success", async (t) => {
	const envelopes = [null, [], "bad", {}, { results: null }, { results: {} }];
	const invalidRows = [null, [], {}, source({ content: null }), source({ url: "https://user:pass@docs.python.org/" }), source({ url: "http://service.local/" })];
	let response;
	mockFetch(t, () => Response.json(response), envelopes.length * operations.length + invalidRows.length);
	for (response of envelopes) {
		for (const [name, params] of operations) {
			await rejectsSafe(execute(name, params), /invalid result envelope/);
		}
	}
	for (const row of invalidRows) {
		response = { results: [row] };
		await rejectsSafe(execute("web_search", { query: "public" }), /no valid public sources.*not treated as an empty search/);
	}
});

test("search caps total text at 20 KB and titles/excerpts by UTF-8 bytes without splitting Unicode", async (t) => {
	const url = `https://docs.python.org/${"p".repeat(1950)}`;
	mockFetch(t, () => Response.json({ results: Array.from({ length: 10 }, () => source({
		url, title: `\x1b[31m${"😀".repeat(1000)}\x1b[0m`, content: `\x00${"中😀".repeat(3000)}\x7f`,
	})) }));
	const result = await execute("web_search", { query: "😀".repeat(256), limit: 10 });
	assert.ok(Buffer.byteLength(text(result)) <= 20_000);
	assert.ok(result.details.sources.length > 0 && result.details.sources.length < 10);
	assert.equal(result.details.omitted, 10 - result.details.sources.length);
	for (const row of result.details.sources) {
		assert.equal(row.title, "😀".repeat(64));
		assert.ok(Buffer.byteLength(row.snippet) <= 1200);
		assert.ok(Buffer.byteLength(row.snippet) >= 1197);
		assert.equal(row.truncated, true);
		assert.ok(row.snippet.isWellFormed());
		assert.doesNotMatch(row.snippet + row.title, CONTROLS);
	}
	assert.match(text(result), /excerpt truncated; use web_fetch/);
	assert.match(text(result), /Omitted \d+ invalid or over-limit results/);
	assert.ok(text(result).isWellFormed());
	assert.doesNotMatch(text(result), CONTROLS);
});

test("invalid queries and numeric paging/limit parameters fail before fetch", async () => {
	for (const query of [undefined, null, 3, [], "", " \t\n", "q".repeat(513), "\x1b[31m\x1b[0m\x00"]) {
		await rejectsSafe(execute("web_search", { query }), /query must contain/, `query ${JSON.stringify(query)}`);
	}
	for (const limit of [null, "5", 0, -1, 11, 1.5, NaN, Infinity]) {
		await rejectsSafe(execute("web_search", { query: "valid", limit }), /limit must be an integer between 1 and 10/);
	}
	for (const offset of [null, "1", -1, 1.5, 1_048_577, NaN, Infinity]) {
		await rejectsSafe(execute("web_fetch", { url: PAGE_URL, offset }), /offset must be an integer between 0 and 1048576/);
	}
	for (const max_chars of [null, "1", -1, 0, 1.5, 16001, NaN, Infinity]) {
		await rejectsSafe(execute("web_fetch", { url: PAGE_URL, max_chars }), /max_chars must be an integer between 1 and 16000/);
	}
});

test("extract rejects non-public, credential-bearing, IP-literal, malformed and oversized URLs before fetch", async () => {
	const urls = [
		undefined, null, 1, {}, "", "/relative", "//docs.python.org/", "not a URL",
		"file:///etc/passwd", "ftp://docs.python.org/", "data:text/plain,hello", "javascript:alert(1)",
		"http://localhost/", "http://LOCALHOST./", "https://sub.localhost/", "http://intranet/",
		"http://service.local/", "http://service.internal/", "http://service.invalid/", "http://service.test/",
		"http://service.example/", "http://service.onion/", "http://home.arpa/", "http://host.home.arpa/",
		"http://127.0.0.1/", "http://127.0.0.1./", "http://10.0.0.1/", "http://192.168.1.1/",
		"http://169.254.169.254/", "http://8.8.8.8/", "http://0.0.0.0/", "http://2130706433/",
		"http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://[::1]/",
		"http://[fc00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "https://[2001:4860:4860::8888]/",
		`https://user:${FAKE_KEY}@docs.python.org/`, "https://user%3Apass@docs.python.org/",
		`${PAGE_URL}${"p".repeat(2048)}`, `${PAGE_URL}${"😀".repeat(200)}`,
	];
	for (const url of urls) {
		await rejectsSafe(execute("web_fetch", { url }), /public HTTP\(S\)|2048 bytes/);
	}
});

for (const [name, params, endpoint] of operations) {
	test(`${name}: HTTP auth, quota, server errors and redirects are sanitized, cancelled, and never retried`, async (t) => {
		const statuses = [401, 403, 429, 500, 502, 503, 307];
		let status;
		let cancelled = 0;
		mockFetch(t, () => new Response(new ReadableStream({
			start(controller) { controller.enqueue(Buffer.from(PROVIDER_SECRET)); },
			cancel() { cancelled++; },
		}), { status, headers: { "x-provider-secret": PROVIDER_SECRET, "retry-after": "0", location: PAGE_URL } }), statuses.length);
		for (status of statuses) {
			const advice = [401, 403].includes(status) ? "Check TAVILY_API_KEY and account access" :
				status === 429 ? "Rate limit or quota reached; retry later" : "No automatic retry or fallback was made";
			await rejectsSafe(execute(name, params), new RegExp(`Tavily ${endpoint} failed \\(HTTP ${status}\\)\\. ${advice}`));
		}
		assert.equal(cancelled, statuses.length, "Error response bodies are discarded, not echoed or parsed");
	});

	test(`${name}: transport, redirect, and stream errors hide sensitive causes and do not retry`, async (t) => {
		let failure;
		const failures = [
			() => { throw new TypeError(PROVIDER_SECRET); },
			() => { throw new TypeError("fetch failed", { cause: new Error(`unexpected redirect ${PROVIDER_SECRET}`) }); },
			() => new Response(new ReadableStream({ start(controller) { controller.error(new Error(PROVIDER_SECRET)); } })),
		];
		mockFetch(t, () => failure(), failures.length);
		for (failure of failures) {
			await rejectsSafe(execute(name, params), /network request failed.*no automatic retry was made/);
		}
	});

	test(`${name}: invalid JSON, invalid UTF-8, and absent bodies fail explicitly`, async (t) => {
		const responses = [new Response(PROVIDER_SECRET), new Response('{"results":['), new Response(Buffer.from([0xc3, 0x28])), new Response(null)];
		mockFetch(t, () => responses.shift(), responses.length);
		for (let i = 0; i < 3; i++) await rejectsSafe(execute(name, params), /returned invalid JSON/);
		await rejectsSafe(execute(name, params), /returned an empty response/);
	});

	test(`${name}: pre-aborted calls make neither requests nor deadlines`, async (t) => {
		const deadline = t.mock.method(AbortSignal, "timeout", denyIO("deadline for pre-aborted call"));
		await rejectsSafe(execute(name, params, AbortSignal.abort(new Error(PROVIDER_SECRET))), /Web request cancelled/);
		assert.equal(deadline.mock.callCount(), 0);
	});
}

test("declared responses over 1 MiB are cancelled without reading; an exact-limit JSON response is accepted", async (t) => {
	let cancelled = 0;
	let pulls = 0;
	const tooLarge = new Response(new ReadableStream({
		pull() { pulls++; }, cancel() { cancelled++; },
	}, { highWaterMark: 0 }), { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } });
	const base = JSON.stringify({ results: [], padding: "" });
	const exact = new Response(JSON.stringify({ results: [], padding: "x".repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(base)) }), {
		headers: { "content-length": String(MAX_RESPONSE_BYTES) },
	});
	const responses = [tooLarge, exact];
	mockFetch(t, () => responses.shift(), 2);
	await rejectsSafe(execute("web_search", { query: "public" }), /exceeds the 1 MiB limit/);
	assert.equal(cancelled, 1);
	assert.equal(pulls, 0);
	assert.match(text(await execute("web_search", { query: "public" })), /No search results/);
});

for (const declaredLength of [undefined, "1"]) {
	test(`stream limit is enforced with ${declaredLength ? "a lying" : "no"} Content-Length, then cancelled and unlocked`, async (t) => {
		let pulls = 0;
		let cancelled = 0;
		const response = new Response(new ReadableStream({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array(pulls <= 2 ? MAX_RESPONSE_BYTES / 2 : 1));
			},
			cancel() { cancelled++; },
		}, { highWaterMark: 0 }), { headers: declaredLength ? { "content-length": declaredLength } : {} });
		mockFetch(t, () => response);
		await rejectsSafe(execute("web_search", { query: "public" }), /exceeds the 1 MiB limit/);
		assert.equal(pulls, 3);
		assert.equal(cancelled, 1);
		assert.equal(response.body.locked, false);
	});
}

// A controlled signal tests the actual deadline wiring without a 20-second sleep.
for (const [name, params] of operations) {
	for (const stage of ["fetch", "body"]) {
		for (const reason of ["caller abort", "deadline"]) {
			test(`${name}: ${reason} interrupts pending ${stage} with a safe native error`, async (t) => {
				const caller = new AbortController();
				const deadline = new AbortController();
				const timeout = t.mock.method(AbortSignal, "timeout", (ms) => {
					assert.equal(ms, 20_000);
					return deadline.signal;
				});
				const reached = Promise.withResolvers();
				let response;
				const calls = mockFetch(t, (_url, { signal }) => {
					if (stage === "fetch") {
						return new Promise((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(signal.reason), { once: true });
							reached.resolve();
						});
					}
					response = new Response(new ReadableStream({
						start(controller) {
							signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
						},
						pull() { reached.resolve(); },
					}, { highWaterMark: 0 }));
					return response;
				});
				const pending = execute(name, params, caller.signal);
				await reached.promise;
				(reason === "deadline" ? deadline : caller).abort(new Error(PROVIDER_SECRET));
				await rejectsSafe(pending, reason === "deadline" ? /timed out after 20 seconds/ : /Web request cancelled/);
				assert.equal(timeout.mock.callCount(), 1);
				assert.equal(calls[0].options.signal.aborted, true);
				assert.equal(caller.signal.aborted, reason !== "deadline");
				if (response) assert.equal(response.body.locked, false);
			});
		}
	}
}

test("web_fetch is independent of Tavily credentials and reports a missing browser", async () => {
	delete process.env.TAVILY_API_KEY;
	process.env.PI_WEB_FETCH_BROWSER = "/nonexistent/pi-web-fetch-browser";
	try {
		await rejectsSafe(execute("web_fetch", { url: PAGE_URL }), /Chrome\/Chromium.*unavailable/);
	} finally {
		delete process.env.PI_WEB_FETCH_BROWSER;
	}
});

test("web_fetch uses a fresh browser with no Tavily key access or ambient credentials, and returns attributed text", async (t) => {
	const mock = mockBrowser(t);
	delete process.env.TAVILY_API_KEY;
	const env = process.env;
	let keyReads = 0;
	process.env = new Proxy(env, { get(target, key) {
		if (key === "TAVILY_API_KEY") { keyReads++; throw new Error("Do not access Tavily for web_fetch"); }
		return Reflect.get(target, key);
	} });
	let result;
	try { result = await execute("web_fetch", { url: "HTTP://DOCS.PYTHON.ORG:80/3/../3/" }); }
	finally { process.env = env; }
	assert.equal(keyReads, 0);
	assert.equal(mock.calls.length, 1);
	const { args, settings } = mock.calls[0];
	assert.equal(settings.detached, true);
	assert.deepEqual(settings.stdio, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
	assert.notEqual(settings.env.HOME, homedir());
	assert.deepEqual(Object.keys(settings.env).sort(), ["HOME", "LANG", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);
	for (const required of ["--headless=new", "--remote-debugging-pipe", "--proxy-bypass-list=<-loopback>", "--disable-quic", "--use-mock-keychain", "--password-store=basic"]) assert.ok(args.includes(required), `Missing required browser argument ${required}`);
	assert.equal(args.some(arg => /no-sandbox|ignore-certificate-errors|remote-debugging-port/.test(arg)), false);
	// Without these two, browser egress would never reach network.ts: the guard proxy and its
	// DNS pinning would be dead code while every other assertion still passed.
	assert.ok(args.includes("--proxy-server=http://127.0.0.1:31234"), "Browser egress must be forced through the per-read loopback guard proxy");
	assert.ok(args.includes("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"), "Browser-side DNS must fail so no address is reached without guard approval");
	// The profile, HOME and TMPDIR must all be the throwaway root that cleanup removes.
	assert.equal(args.find(arg => arg.startsWith("--user-data-dir=")), `--user-data-dir=${join(settings.cwd, "profile")}`);
	assert.equal(settings.env.HOME, join(settings.cwd, "home"));
	assert.equal(settings.env.TMPDIR, join(settings.cwd, "tmp"));
	assert.equal(existsSync(settings.cwd), false, "Temporary profile/home must be removed after reading");
	assert.equal(mock.commands.find(command => command.method === "Page.navigate").params.url, "http://docs.python.org/3/");
	assert.equal(mock.commands.find(command => command.method === "Browser.setDownloadBehavior").params.behavior, "deny");
	assert.equal(result.details.provider, "browser");
	assert.equal(result.details.title, "Python docs");
	assert.equal(result.details.url, PAGE_URL);
	assert.equal(result.details.credits, undefined);
	assert.equal(result.details.next_offset, null);
	assert.equal(result.details.stabilized, true);
	assert.match(text(result), /UNTRUSTED RENDERED WEB CONTENT \(anonymous browser, plain text\)/);
	assert.ok(text(result).includes(`Requested URL: http://docs.python.org/3/\nSource URL: ${PAGE_URL}`));
	assert.match(text(result), /Bounded text scan/);
	assert.equal(result.details.scan_complete, true);
	assert.deepEqual(result.details.incomplete_reasons, []);
	assert.equal(result.details.frames_read, 1);
	const attach = mock.commands.find(command => command.method === "Target.setAutoAttach");
	assert.deepEqual(attach.params, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }, { exclude: true }] });
	assert.ok(mock.commands.filter(command => command.method === "Page.createIsolatedWorld").every(command => !command.params.grantUniveralAccess && !command.params.grantUniversalAccess));
	assert.ok(text(result).endsWith("\n\n# Public page\n\nAnonymous rendered content."));
	timestamp(result);
});

test("anonymous guest page waits for visible text without treating a Log In button as access denial", async (t) => {
	mockBrowser(t, { snapshots: [
		{ url: PAGE_URL, title: "Docs", text: "", ready: false },
		{ url: PAGE_URL, title: "Docker 环境部署 SOP", text: "Public access\nDocker 环境部署 SOP\n部署步骤\nLog In or Sign Up" },
	] });
	const result = await execute("web_fetch", { url: PAGE_URL });
	assert.match(text(result), /Docker 环境部署 SOP/);
	assert.match(text(result), /Public access/);
	assert.equal(result.details.stabilized, true);
});

test("initial about:blank is a navigation transition, not an invalid destination", async (t) => {
	mockBrowser(t, { snapshots: [
		{ url: "about:blank", title: "", text: "", ready: false },
		{ url: PAGE_URL, title: "Public page", text: "Loaded public content" },
	] });
	const result = await execute("web_fetch", { url: PAGE_URL });
	assert.ok(text(result).endsWith("\n\nLoaded public content"));
});

test("browser text defaults to 8000 characters and accepts a 2048-byte URL", async (t) => {
	const url = PAGE_URL + "p".repeat(2048 - PAGE_URL.length);
	mockBrowser(t, { text: "a".repeat(8001), url });
	const result = await execute("web_fetch", { url });
	assert.equal(result.details.next_offset, 8000);
	assert.equal(result.details.total_chars, 8001);
	assert.equal(result.details.truncated, true);
	assert.ok(text(result).endsWith(`\n\n${"a".repeat(8000)}`));
	assert.match(text(result), /offset=8000; this reloads the page/);
});

test("rendered-text pagination uses cleaned Unicode indices and creates a new browser per call", async (t) => {
	const mock = mockBrowser(t, { text: "\x1b[31mA😀\x1b[0me\u0301中\x00𐐀Z\x7f" });
	let offset = 0;
	for (const [index, page] of ["A😀e", "\u0301中𐐀", "Z"].entries()) {
		const result = await execute("web_fetch", { url: PAGE_URL, offset, max_chars: 3 });
		assert.equal(result.details.offset, index * 3);
		assert.equal(result.details.total_chars, 7);
		assert.equal(result.details.next_offset, index < 2 ? offset + 3 : null);
		assert.equal(result.details.truncated, index < 2);
		assert.ok(text(result).endsWith(`\n\n${page}`));
		assert.ok(text(result).isWellFormed());
		assert.doesNotMatch(text(result), CONTROLS);
		offset = result.details.next_offset;
	}
	assert.equal(mock.calls.length, 3);
	assert.equal(new Set(mock.calls.map(call => call.settings.cwd)).size, 3);
});

test("browser pages stop at 16000 UTF-8 bytes without splitting emoji", async (t) => {
	mockBrowser(t, { text: `x${"😀".repeat(4000)}end` });
	const first = await execute("web_fetch", { url: PAGE_URL, max_chars: 16000 });
	const page = text(first).split("\n\n")[1];
	assert.equal(page, `x${"😀".repeat(3999)}`);
	assert.equal(Buffer.byteLength(page), 15997);
	assert.equal(first.details.next_offset, 4000);
	const last = await execute("web_fetch", { url: PAGE_URL, offset: first.details.next_offset, max_chars: 16000 });
	assert.ok(text(last).endsWith("\n\n😀end"));
	assert.equal(last.details.next_offset, null);
});

for (const [label, options, expected] of [
	["HTTP denial", { status: 403 }, /HTTP 403/],
	["HTTP server error", { status: 503 }, /HTTP 503/],
	["empty page", { text: " \n\t" }, /No visible webpage text/],
	["unsafe final URL", { url: "http://127.0.0.1/" }, /Only public HTTP\(S\)/],
	["oversized snapshot", { text: "x".repeat(262145) }, /invalid or oversized page text/],
	["spawn failure", { spawnError: true }, /could not be started|connection.*closed/],
	["protocol failure", { failOn: "Page.enable" }, /protocol command failed/],
	["bad protocol JSON", { invalidProtocol: true }, /invalid protocol data/],
	["navigation failure", { navigationError: PROVIDER_SECRET }, /Could not load the webpage/],
]) {
	test(`web_fetch safely reports ${label} and cleans temporary resources`, async (t) => {
		const mock = mockBrowser(t, options);
		await rejectsSafe(execute("web_fetch", { url: PAGE_URL }), expected);
		assert.ok(mock.calls.every(call => !existsSync(call.settings.cwd)));
	});
}

for (const code of ["net::ERR_TUNNEL_CONNECTION_FAILED", "net::ERR_NAME_NOT_RESOLVED", "net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_CONNECTION_TIMED_OUT"]) {
	test(`navigation diagnostics preserve ${code} without blaming the public-network guard`, async (t) => {
		const mock = mockBrowser(t, { navigationError: code });
		await rejectsSafe(execute("web_fetch", { url: PAGE_URL }), new RegExp(`Could not load the webpage \\(${code}\\)`));
		assert.ok(mock.calls.every(call => !existsSync(call.settings.cwd)));
	});
}

for (const errorText of [PROVIDER_SECRET, `net::ERR_FAILED ${PROVIDER_SECRET}`, `net::ERR_${"A".repeat(65)}`, { message: PROVIDER_SECRET }]) {
	test(`navigation diagnostics redact unrecognized protocol error text (${typeof errorText}, ${JSON.stringify(errorText).length})`, async (t) => {
		mockBrowser(t, { navigationError: errorText });
		await rejectsSafe(execute("web_fetch", { url: PAGE_URL }), /navigation reason unavailable/);
	});
}

test("navigation diagnostics report guard rejections as separate, potentially unrelated observations", async (t) => {
	const mock = mockBrowser(t, { navigationError: "net::ERR_TUNNEL_CONNECTION_FAILED", onCommand(command) {
		if (command.method === "Page.navigate") {
			mock.servers[0].handler({ url: "http://127.0.0.1/" }, { writeHead() {}, end() {} });
		}
	} });
	await rejectsSafe(execute("web_fetch", { url: PAGE_URL }), /Public-network guard rejected 1 request\(s\); these may be unrelated to navigation/);
});

test("capture bounds and password-form warnings are explicit rather than a false complete-document claim", async (t) => {
	mockBrowser(t, { snapshots: [{ url: PAGE_URL, title: "Page", text: "Captured text", captureTruncated: true, passwordForm: true }] });
	const result = await execute("web_fetch", { url: PAGE_URL });
	assert.equal(result.details.capture_truncated, true);
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.next_offset, null);
	assert.equal(result.details.scan_complete, false);
	assert.ok(result.details.incomplete_reasons.includes("capture_limit"));
	assert.match(text(result), /Scan: INCOMPLETE/);
	assert.match(text(result), /additional text was not retained/);
	assert.match(text(result), /password form/);
});

test("offset beyond captured text fails explicitly", async (t) => {
	mockBrowser(t, { text: "A😀" });
	for (const offset of [2, MAX_RESPONSE_BYTES]) await rejectsSafe(execute("web_fetch", { url: PAGE_URL, offset }), /offset is beyond.*\(2 characters\)/);
});

test("web_fetch refuses nonstandard ports before starting a browser", async () => {
	await rejectsSafe(execute("web_fetch", { url: "https://docs.python.org:8443/" }), /standard HTTP\/HTTPS ports/);
});

test("web_fetch pre-abort does not create a browser or deadline", async (t) => {
	const timer = t.mock.method(AbortSignal, "timeout", denyIO("deadline for pre-aborted browser read"));
	await rejectsSafe(execute("web_fetch", { url: PAGE_URL }, AbortSignal.abort(new Error(PROVIDER_SECRET))), /Web request cancelled/);
	assert.equal(timer.mock.callCount(), 0);
});

for (const reason of ["caller", "deadline"]) {
	test(`web_fetch ${reason} abort closes the owned browser/proxy and hides the abort reason`, async (t) => {
		const caller = new AbortController();
		const deadline = new AbortController();
		t.mock.method(AbortSignal, "timeout", ms => { assert.equal(ms, 90000); return deadline.signal; });
		const mock = mockBrowser(t, { onCommand(command) {
			if (command.method === "Runtime.evaluate") (reason === "caller" ? caller : deadline).abort(new Error(PROVIDER_SECRET));
		} });
		await rejectsSafe(execute("web_fetch", { url: PAGE_URL }, caller.signal), reason === "caller" ? /Web request cancelled/ : /timed out after 90 seconds/);
		assert.ok(mock.calls.every(call => !existsSync(call.settings.cwd)));
	});
}

for (const reason of ["caller", "deadline"]) {
	test(`web_fetch ${reason} during scrolling preserves partial content only for its own deadline`, async (t) => {
		const caller = new AbortController(), deadline = new AbortController();
		t.mock.method(AbortSignal, "timeout", ms => { assert.equal(ms, 90000); return deadline.signal; });
		const mock = mockBrowser(t, {
			snapshots: [{ url: PAGE_URL, title: "Long page", text: "CAPTURED_BEFORE_TIMEOUT", pending: true }],
			onCommand(command) {
				if (command.method === "Runtime.evaluate" && command.params.expression.endsWith(".advance()")) (reason === "caller" ? caller : deadline).abort(new Error(PROVIDER_SECRET));
			},
		});
		const pending = execute("web_fetch", { url: PAGE_URL }, caller.signal);
		if (reason === "caller") await rejectsSafe(pending, /Web request cancelled/);
		else {
			const result = await pending;
			assert.ok(text(result).endsWith("\n\nCAPTURED_BEFORE_TIMEOUT"));
			assert.equal(result.details.scan_complete, false);
			assert.equal(result.details.next_offset, null);
			assert.equal(result.details.capture_truncated, false);
			assert.ok(result.details.incomplete_reasons.includes("timeout"));
			assert.match(text(result), /Scan: INCOMPLETE/);
			assert.doesNotMatch(JSON.stringify(result), /synthetic-provider-private-data/);
		}
		assert.ok(mock.calls.every(call => !existsSync(call.settings.cwd)));
	});
}

test("incomplete scanning is distinct from output pagination, including at the captured end", async (t) => {
	mockBrowser(t, { snapshots: [{ url: PAGE_URL, title: "Partial", text: "abcde", incompleteReasons: ["frame_unavailable"] }] });
	for (const [offset, next, truncated] of [[0, 2, true], [4, null, false]]) {
		const result = await execute("web_fetch", { url: PAGE_URL, offset, max_chars: 2 });
		assert.equal(result.details.next_offset, next);
		assert.equal(result.details.truncated, truncated);
		assert.equal(result.details.scan_complete, false);
		assert.deepEqual(result.details.incomplete_reasons, ["frame_unavailable"]);
		assert.match(text(result), /Scan incomplete: frame_unavailable/);
	}
});

test("an unresponsive close escalates only against the owned browser process group", async (t) => {
	const mock = mockBrowser(t, { ignoreClose: true, ignoreTerm: true });
	await execute("web_fetch", { url: PAGE_URL });
	assert.equal(mock.processes[0].signalCode, "SIGKILL");
	assert.ok(mock.calls.every(call => !existsSync(call.settings.cwd)));
});

test("usage credits are optional, numeric and nonnegative; missing usage is not fabricated", async (t) => {
	const usages = [undefined, null, {}, { credits: "1" }, { credits: -1 }, { credits: null }, { credits: 0.5 }];
	let usage;
	mockFetch(t, () => Response.json({ results: [], usage }), usages.length);
	for (usage of usages) {
		const result = await execute("web_search", { query: "public" });
		assert.equal(result.details.credits, usage?.credits === 0.5 ? 0.5 : undefined);
	}
});
