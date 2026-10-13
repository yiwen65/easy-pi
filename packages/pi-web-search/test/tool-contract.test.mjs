import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, test } from "node:test";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { mockBrowser } from "./browser-mock.mjs";

assert.equal(process.env.PI_WEB_SEARCH_OFFLINE, "1", "Use node test/run.mjs; do not run this file in your normal environment.");
assert.match(homedir(), /^\/tmp\/pi-web-search-offline-[^/]+\/home$/);
assert.equal(process.env.EASY_PI_CODING_AGENT_DIR, join(homedir(), ".epi", "agent"));

// Same isolation guard as offline.test.mjs: this file may not reach the network or spawn a process
// outside the browser mock. A snapshot continuation must not even attempt either one.
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

const PAGE_URL = "https://docs.python.org/3/";
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/;
const FETCH_KEYS = [
	"text", "requestedUrl", "url", "title", "snapshot_id", "captured_at", "offset", "next_offset",
	"total_chars", "pagination_consistent", "scan_complete", "capture_truncated", "truncated",
	"incomplete_reasons", "ambiguities", "content_status", "warnings", "frames_read", "scroll_steps",
	"dns_mode", "blocked_requests", "format",
];

// Load the extension through the actual Pi/Jiti loader, exactly like a real session does.
let startupKeyReads = 0;
const isolatedEnv = process.env;
assert.equal(isolatedEnv.TAVILY_API_KEY, undefined);
process.env = new Proxy(isolatedEnv, {
	get(target, key) {
		if (key === "TAVILY_API_KEY") {
			startupKeyReads++;
			throw new Error("TAVILY_API_KEY must not be read while loading or running web_fetch");
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
const tools = new Map([...loaded.extensions[0].tools].map(([name, tool]) => [name, tool.definition]));
const fetchTool = tools.get("web_fetch");

afterEach(() => {
	assert.deepEqual(unexpectedIO, [], "No unmocked network or subprocess call is allowed");
});

/** Call the registered native execute, the same entry the host pipeline uses. */
function execute(params, { signal, ctx = {} } = {}) {
	return fetchTool.execute("contract-call", params, signal, undefined, ctx);
}
function text(result) {
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0].type, "text");
	return result.content[0].text;
}
async function failure(promise) {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof Error, "tools must reject with an Error");
		assert.equal(error.cause, undefined, "a refusal must not carry a cause");
		return error;
	}
	throw new Error("Expected the call to fail, but it resolved");
}
/** One owner object per capture: the store is keyed on this object and must be stable across calls. */
function host() {
	return { sessionManager: {} };
}
function cleaned(value) {
	return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
function characters(value) {
	return Array.from(value);
}
function expectPageShownInContent(result) {
	const page = result.structuredContent.text;
	assert.ok(text(result).endsWith(`\n\n${page}`), "content must end with exactly the page structuredContent carries");
	return page;
}

test("P01: one capture serves four snapshot pages, from one browser spawn, one proxy and one navigation", async (t) => {
	const capture = "0123456789abcdefghijKLMNOPQRSTuvwxyzABCD";
	const options = { snapshots: [{ url: PAGE_URL, title: "Stable capture", text: capture }] };
	const mock = mockBrowser(t, options);
	const owner = host();
	const first = await execute({ url: PAGE_URL, max_chars: 10 }, { ctx: owner });
	const data = first.structuredContent;
	assert.equal(data.text, "0123456789");
	assert.equal(data.offset, 0);
	assert.equal(data.next_offset, 10);
	assert.equal(data.total_chars, 40);
	assert.equal(data.pagination_consistent, true);
	assert.equal(typeof data.snapshot_id, "string");
	assert.equal(data.url, PAGE_URL);
	assert.equal(data.title, "Stable capture");
	assert.equal(first.details.snapshot_id, data.snapshot_id);
	assert.equal(first.details.provider, "browser");
	expectPageShownInContent(first);
	// The live page changes after the capture; the stored capture must not follow it.
	options.snapshots = [{ url: PAGE_URL, title: "Changed page", text: "REPLACED CONTENT" }];
	const commandsAfterCapture = mock.commands.length;
	const pages = [data.text];
	let offset = data.next_offset;
	let page;
	for (const index of [1, 2, 3]) {
		page = await execute({ snapshot_id: data.snapshot_id, offset, max_chars: 10 }, { ctx: owner });
		assert.equal(expectPageShownInContent(page), capture.slice(index * 10, (index + 1) * 10));
		assert.equal(page.structuredContent.total_chars, 40, "the capture length is stable across pages");
		assert.equal(page.structuredContent.offset, index * 10);
		assert.equal(page.structuredContent.captured_at, data.captured_at);
		assert.equal(page.structuredContent.title, "Stable capture");
		assert.equal(page.structuredContent.url, PAGE_URL);
		assert.equal(page.structuredContent.snapshot_id, data.snapshot_id);
		assert.equal(page.structuredContent.pagination_consistent, true);
		assert.equal(page.structuredContent.pagination_consistent, page.details.pagination_consistent);
		assert.equal(page.details.provider, "snapshot");
		assert.equal(page.details.stabilized, null, "a memory read must not claim a settled page scan");
		assert.match(text(page), /short-term memory snapshot/);
		assert.doesNotMatch(text(page), /REPLACED CONTENT/);
		if (index < 3) assert.ok(page.structuredContent.next_offset > page.structuredContent.offset, "the cursor advances");
		pages.push(page.structuredContent.text);
		offset = page.structuredContent.next_offset;
	}
	assert.equal(offset, null, "the last page reports the end of the capture");
	assert.match(text(page), /End of captured text/);
	assert.equal(pages.join(""), capture, "the four pages reassemble to the original capture");
	assert.equal(mock.calls.length, 1, "exactly one browser was spawned for all four pages");
	assert.equal(mock.servers.length, 1, "exactly one guard proxy server was started");
	assert.equal(mock.commands.filter((command) => command.method === "Page.navigate").length, 1, "exactly one navigation");
	assert.equal(mock.commands.length, commandsAfterCapture, "continuation calls send no CDP commands at all");
});

test("P02: Chinese, emoji, ZWJ and control characters keep exact code-point offsets and reassemble", async (t) => {
	const messy = "\x1b[31m中😀\x1b[0m\x00a\u200d👩‍👩‍👦Z\u007f\u0301";
	const clean = cleaned(messy);
	const cleanChars = characters(clean);
	assert.ok(cleanChars.length > 6 && cleanChars.some((char) => char.codePointAt(0) > 0xffff), "fixture must span astral planes");
	const mock = mockBrowser(t, { text: messy });
	const owner = host();
	const capture = await execute({ url: PAGE_URL, max_chars: 3 }, { ctx: owner });
	const first = capture.structuredContent;
	assert.equal(first.total_chars, cleanChars.length);
	assert.equal(first.text, cleanChars.slice(0, 3).join(""));
	assert.doesNotMatch(text(capture), CONTROLS, "control characters are removed from the visible page too");
	const pages = [first.text];
	let offset = first.next_offset;
	let page = capture;
	while (offset !== null) {
		page = await execute({ snapshot_id: first.snapshot_id, offset, max_chars: 3 }, { ctx: owner });
		const data = page.structuredContent;
		assert.equal(data.offset, offset);
		assert.equal(data.text, cleanChars.slice(offset, offset + 3).join(""), "offsets index cleaned code points");
		assert.ok(characters(data.text).length <= 3, "the page stays within max_chars code points");
		assert.ok(Buffer.byteLength(data.text) <= 16000, "the page stays within 16000 UTF-8 bytes");
		assert.ok(data.text.isWellFormed(), "no surrogate pair is split");
		assert.equal(data.total_chars, first.total_chars, "total_chars is stable across pages");
		expectPageShownInContent(page);
		pages.push(data.text);
		offset = data.next_offset;
	}
	assert.equal(pages.join(""), clean, "all pages reassemble to the cleaned snapshot text");
	assert.equal(mock.calls.length, 1, "one capture served every page");
});

test("P02: a page stops at 16000 UTF-8 bytes without splitting an emoji or changing total_chars", async (t) => {
	const capture = `x${"😀".repeat(4000)}end`;
	const mock = mockBrowser(t, { text: capture });
	const owner = host();
	const first = await execute({ url: PAGE_URL, max_chars: 16000 }, { ctx: owner });
	const data = first.structuredContent;
	assert.equal(data.text, `x${"😀".repeat(3999)}`);
	assert.equal(Buffer.byteLength(data.text), 15997, "the byte bound, not only max_chars, caps the page");
	assert.equal(characters(data.text).length, 4000);
	assert.equal(data.total_chars, 4004);
	assert.equal(data.next_offset, 4000);
	assert.ok(data.text.isWellFormed());
	const last = await execute({ snapshot_id: data.snapshot_id, offset: data.next_offset, max_chars: 16000 }, { ctx: owner });
	assert.equal(last.structuredContent.text, "😀end");
	assert.equal(last.structuredContent.total_chars, 4004, "total_chars is stable across pages");
	assert.equal(last.structuredContent.next_offset, null);
	assert.equal(data.text + last.structuredContent.text, capture, "both pages reassemble to the capture");
	assert.equal(mock.calls.length, 1, "the continuation must not start a browser");
	assert.equal(mock.servers.length, 1);
});

test("P03: offset 0, exactly at the end, beyond the end, negative, fractional and NaN follow the contract", async (t) => {
	const mock = mockBrowser(t, { text: "abcde" });
	const owner = host();
	const capture = await execute({ url: PAGE_URL, max_chars: 3 }, { ctx: owner });
	const data = capture.structuredContent;
	assert.equal(data.text, "abc");
	assert.equal(data.offset, 0);
	assert.equal(data.next_offset, 3);
	assert.equal(data.total_chars, 5);
	assert.ok(data.next_offset > data.offset, "the cursor advances while text remains");
	const restart = await execute({ snapshot_id: data.snapshot_id, offset: 0, max_chars: 3 }, { ctx: owner });
	assert.equal(restart.structuredContent.text, "abc", "offset 0 restarts the same stored capture");
	assert.equal(restart.structuredContent.snapshot_id, data.snapshot_id);
	// exactly the end: an explicit empty page, not an error and not a silent blank success
	const eof = await execute({ snapshot_id: data.snapshot_id, offset: 5 }, { ctx: owner });
	assert.equal(eof.structuredContent.text, "");
	assert.equal(eof.structuredContent.next_offset, null);
	assert.equal(eof.structuredContent.total_chars, 5);
	assert.equal(eof.structuredContent.truncated, false);
	assert.equal(eof.details.next_offset, null);
	assert.match(text(eof), /End of captured text/);
	assert.ok(text(eof).endsWith("\n\n"));
	// beyond the end: still an error, before any browser, proxy or snapshot work
	const before = { spawns: mock.calls.length, servers: mock.servers.length, commands: mock.commands.length };
	const beyond = await failure(execute({ snapshot_id: data.snapshot_id, offset: 6 }, { ctx: owner }));
	assert.match(beyond.message, /offset is beyond the extracted content \(5 characters\)/);
	assert.equal(beyond.code, "invalid-arguments");
	for (const offset of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_048_577, "2", null, {}]) {
		for (const request of [{ snapshot_id: data.snapshot_id }, { url: PAGE_URL }]) {
			const error = await failure(execute({ ...request, offset }, { ctx: owner }));
			assert.match(error.message, /offset must be an integer between 0 and 1048576/, `offset ${String(offset)}`);
			assert.equal(error.code, "invalid-arguments");
		}
	}
	const badMaxChars = await failure(execute({ url: PAGE_URL, max_chars: 16001 }, { ctx: owner }));
	assert.match(badMaxChars.message, /max_chars must be an integer between 1 and 16000/);
	assert.equal(mock.calls.length, before.spawns, "no invalid offset or max_chars started a browser");
	assert.equal(mock.servers.length, before.servers, "no invalid value started a proxy");
	assert.equal(mock.commands.length, before.commands, "no invalid value issued a CDP command");
	// invalid requests touched no stored state: the original page still reads
	const again = await execute({ snapshot_id: data.snapshot_id, max_chars: 3 }, { ctx: owner });
	assert.equal(again.structuredContent.text, "abc");
	assert.equal(again.structuredContent.snapshot_id, data.snapshot_id);
	// a url capture that starts at an offset is a new capture, not a continuation of an earlier page
	const atEnd = await execute({ url: PAGE_URL, offset: 5 }, { ctx: owner });
	assert.equal(atEnd.structuredContent.text, "", "a url capture at exactly the end is an empty end page too");
	assert.equal(atEnd.structuredContent.next_offset, null);
	const shifted = await execute({ url: PAGE_URL, offset: 2, max_chars: 3 }, { ctx: owner });
	assert.equal(shifted.structuredContent.text, "cde");
	assert.equal(shifted.structuredContent.pagination_consistent, false, "a url capture past 0 is not the same capture");
	assert.match(text(shifted), /pagination_consistent=false/);
	assert.match(text(shifted), /snapshot_id/);
	assert.equal(mock.calls.length, before.spawns + 2, "every url capture starts its own one-off browser");
});

test("P04: bad combinations, unknown fields and unknown handles are rejected before any external work", async (t) => {
	const mock = mockBrowser(t, { text: "hello" });
	const owner = host();
	const capture = await execute({ url: PAGE_URL }, { ctx: owner });
	const data = capture.structuredContent;
	assert.equal(typeof data.snapshot_id, "string");
	const before = { spawns: mock.calls.length, servers: mock.servers.length, commands: mock.commands.length };
	const rejections = [
		[{ url: PAGE_URL, snapshot_id: data.snapshot_id }, /exactly one of url/],
		[{}, /exactly one of url/],
		[{ offset: 1 }, /exactly one of url/],
		[{ max_chars: 8 }, /exactly one of url/],
		[{ url: PAGE_URL, format: "markdown" }, /Unknown web_fetch parameter "format"/],
		[{ snapshot_id: data.snapshot_id, format: "text" }, /Unknown web_fetch parameter "format"/],
		[{ snapshot_id: data.snapshot_id, offset: 1.5 }, /offset must be an integer between 0 and 1048576/],
		[{ snapshot_id: data.snapshot_id, max_chars: 0 }, /max_chars must be an integer between 1 and 16000/],
		[{ snapshot_id: "x".repeat(129) }, /snapshot_id must be a 1 to 128 character opaque handle/],
		[{ snapshot_id: "https://docs.python.org/3/" }, /snapshot_id must be a 1 to 128 character opaque handle/],
		[{ snapshot_id: "../etc/passwd" }, /snapshot_id must be a 1 to 128 character opaque handle/],
		[{ snapshot_id: 42 }, /snapshot_id must be a 1 to 128 character opaque handle/],
		[{ snapshot_id: "" }, /snapshot_id must be a 1 to 128 character opaque handle/],
		[{ snapshot_id: "unknown-handle" }, /not available to this session/],
	];
	for (const [params, expected] of rejections) {
		const error = await failure(execute(params, { ctx: owner }));
		assert.match(error.message, expected, JSON.stringify(params));
		assert.ok(["invalid-arguments", "snapshot-unavailable"].includes(error.code), `code for ${JSON.stringify(params)}`);
	}
	// Unknown, expired and other-owner handles are one indistinguishable refusal: no existence probe.
	const unknown = await failure(execute({ snapshot_id: "unknown-handle" }, { ctx: owner }));
	const foreign = await failure(execute({ snapshot_id: data.snapshot_id }, { ctx: host() }));
	assert.equal(unknown.code, "snapshot-unavailable");
	assert.equal(foreign.code, unknown.code);
	assert.equal(foreign.message, unknown.message, "a real handle of another session must look exactly like an unknown one");
	assert.equal(foreign.message.includes(data.snapshot_id), false, "the refusal must not echo the handle");
	assert.equal(foreign.message.includes("docs.python.org"), false);
	assert.equal(mock.calls.length, before.spawns, "no rejection started a browser");
	assert.equal(mock.servers.length, before.servers, "no rejection started a proxy");
	assert.equal(mock.commands.length, before.commands, "no rejection issued a CDP command");
	// The refusal never falls back to a fresh capture, and the owner's snapshot stays readable.
	const stillThere = await execute({ snapshot_id: data.snapshot_id }, { ctx: owner });
	assert.equal(stillThere.structuredContent.text, "hello");
	assert.equal(stillThere.details.snapshot_id, data.snapshot_id);
});

test("P04: a host without snapshot storage or with snapshots disabled returns no fabricated handle", async (t) => {
	const mock = mockBrowser(t, { text: "no store page" });
	assert.equal(typeof fetchTool.outputSchema, "object");
	const withoutOwner = await execute({ url: PAGE_URL }, { ctx: {} });
	assert.equal(withoutOwner.structuredContent.snapshot_id, null);
	assert.equal(withoutOwner.details.snapshot_id, null);
	assert.match(text(withoutOwner), /No snapshot was kept for this capture/);
	assert.equal(withoutOwner.structuredContent.pagination_consistent, true);
	const refused = await failure(execute({ snapshot_id: "0123456789abcdef0123456789abcdef" }, { ctx: {} }));
	assert.equal(refused.code, "snapshot-unavailable");
	assert.equal(mock.calls.length, 1, "a refused continuation must not re-fetch");
	const owner = host();
	const stored = await execute({ url: PAGE_URL }, { ctx: owner });
	assert.equal(typeof stored.structuredContent.snapshot_id, "string");
	const previous = process.env.PI_WEB_FETCH_SNAPSHOTS;
	try {
		process.env.PI_WEB_FETCH_SNAPSHOTS = "0";
		const disabled = await execute({ url: PAGE_URL }, { ctx: owner });
		assert.equal(disabled.structuredContent.snapshot_id, null, "a disabled host must not publish a handle");
		assert.match(text(disabled), /No snapshot was kept for this capture/);
		const gone = await failure(execute({ snapshot_id: stored.structuredContent.snapshot_id }, { ctx: owner }));
		assert.equal(gone.code, "snapshot-unavailable", "a disabled store must not fall back to a fresh capture");
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_FETCH_SNAPSHOTS;
		else process.env.PI_WEB_FETCH_SNAPSHOTS = previous;
	}
	assert.equal(mock.calls.length, 3, "only the three explicit url captures started a browser");
});

test("P05: the loaded tool declares outputSchema, and content, structuredContent and details agree", async (t) => {
	const source = "P05 page: 中文 😀 text";
	const mock = mockBrowser(t, { text: source });
	const clean = cleaned(source);
	const tool = fetchTool;
	assert.deepEqual(tool.contract, { readOnly: true }, "the tool stays read-only");
	assert.ok(tool.outputSchema, "a script only receives structuredContent when outputSchema is declared");
	assert.equal(tool.outputSchema.type, "object");
	assert.equal(tool.outputSchema.additionalProperties, false);
	assert.deepEqual(Object.keys(tool.outputSchema.properties).sort(), [...FETCH_KEYS].sort());
	assert.ok(Array.isArray(tool.outputSchema.required), "every declared field is required, so a script can rely on it");
	assert.deepEqual([...tool.outputSchema.required].sort(), [...FETCH_KEYS].sort());
	const owner = host();
	const capture = await execute({ url: PAGE_URL, max_chars: 6 }, { ctx: owner });
	const data = capture.structuredContent;
	const details = capture.details;
	assert.deepEqual(Object.keys(data).sort(), [...FETCH_KEYS].sort(), "structuredContent carries exactly the declared fields");
	for (const value of Object.values(data)) assert.notEqual(value, undefined, "no declared field may be undefined");
	const shared = Object.keys(data).filter((key) => key !== "text" && key in details);
	assert.ok(shared.length >= 20, `details must mirror the machine fields: ${shared.length}`);
	for (const key of shared) assert.deepEqual(details[key], data[key], `details.${key} must equal structuredContent.${key}`);
	assert.equal(details.retrievedAt, data.captured_at, "retrievedAt is the capture time of this page");
	assert.equal(details.provider, "browser");
	assert.equal(details.stabilized, true);
	assert.equal(details.format, undefined, "format belongs to the snapshot contract, not to details");
	for (const key of [
		"provider", "requestedUrl", "url", "title", "retrievedAt", "offset", "next_offset", "total_chars",
		"truncated", "capture_truncated", "scan_complete", "incomplete_reasons", "frames_read", "scroll_steps",
		"stabilized", "blocked_requests", "dns_mode", "warnings", "snapshot_id", "captured_at",
		"pagination_consistent", "content_status", "ambiguities",
	]) {
		assert.ok(key in details, `details must keep the ${key} key`);
	}
	const page = expectPageShownInContent(capture);
	assert.equal(page, characters(clean).slice(0, 6).join(""));
	assert.equal(data.total_chars, characters(clean).length);
	assert.equal(data.next_offset, 6);
	assert.equal(data.truncated, true);
	assert.deepEqual(data.ambiguities, [], "the mock page has no sampling caveat");
	assert.equal(data.content_status, "content");
	assert.match(text(capture), /UNTRUSTED RENDERED WEB CONTENT \(anonymous browser, plain text\)/);
	assert.ok(text(capture).includes(`Requested URL: ${data.requestedUrl}`));
	assert.ok(text(capture).includes(`Source URL: ${data.url}`));
	assert.ok(text(capture).includes(`Continuation: web_fetch({snapshot_id: "${data.snapshot_id}", offset: 6})`));
	// The same guarantees hold for a continuation page of the same capture.
	const next = await execute({ snapshot_id: data.snapshot_id, offset: data.next_offset, max_chars: 6 }, { ctx: owner });
	const nextData = next.structuredContent;
	for (const key of Object.keys(nextData).filter((key) => key !== "text" && key in next.details)) {
		assert.deepEqual(next.details[key], nextData[key], `continuation details.${key} must equal structuredContent.${key}`);
	}
	assert.equal(nextData.captured_at, data.captured_at);
	assert.equal(nextData.total_chars, data.total_chars);
	assert.equal(nextData.text, characters(clean).slice(6, 12).join(""));
	expectPageShownInContent(next);
	assert.equal(next.details.provider, "snapshot");
	assert.match(text(next), /UNTRUSTED RENDERED WEB CONTENT \(short-term memory snapshot, plain text\)/);
	assert.equal(data.text + nextData.text, characters(clean).slice(0, 12).join(""));
	assert.equal(mock.calls.length, 1, "the continuation read one capture, not a new page");
});

test("P05: a real codemode script receives structuredContent instead of English text", async (t) => {
	const source = "Codemode😀 page";
	const mock = mockBrowser(t, { text: source });
	const distRoot = new URL("../../coding-agent/dist/", import.meta.url);
	const { wrapToolDefinition } = await import(pathToFileURL(join(distRoot.pathname, "core/tools/tool-definition-wrapper.js")).href);
	const { executeCodemode } = await import(pathToFileURL(join(distRoot.pathname, "extensions/codemode/execute.js")).href);
	const owner = host();
	const agentTool = wrapToolDefinition(fetchTool, () => owner);
	const nested = [];
	const ctx = {
		sessionManager: { getLeafId: () => null, getBranch: () => [] },
		tools: [agentTool],
		executeTool: async (name, args, options) => {
			nested.push(name);
			const result = await fetchTool.execute(`${name}-nested`, args, options?.signal, undefined, owner);
			return { toolCall: { id: `${name}-nested`, name }, result, isError: false, executionOutcome: "confirmed" };
		},
		waitForNestedTools: async () => "confirmed",
	};
	const code = [
		`const page = await tools.web_fetch(${JSON.stringify({ url: PAGE_URL, max_chars: 5 })});`,
		`if (typeof page !== "object" || page === null) throw new Error("web_fetch did not return structuredContent");`,
		`return JSON.stringify({`,
		`  text: page.text,`,
		`  next: page.next_offset,`,
		`  total: page.total_chars,`,
		`  handle: typeof page.snapshot_id,`,
		`  status: page.content_status,`,
		`  captured: typeof page.captured_at === "string" && page.captured_at.length > 0,`,
		`});`,
	].join("\n");
	const outcome = await executeCodemode("wf06-codemode", { code }, undefined, undefined, ctx);
	const output = outcome.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	assert.match(output, /Script completed/, `the script must run for real: ${output}`);
	const clean = cleaned(source);
	const expected = {
		text: characters(clean).slice(0, 5).join(""),
		next: 5,
		total: characters(clean).length,
		handle: "string",
		status: "content",
		captured: true,
	};
	assert.ok(output.includes(JSON.stringify(expected)), `the script must read structuredContent directly: ${output}`);
	assert.deepEqual(nested, ["web_fetch"], "exactly one nested web_fetch call");
	assert.equal(mock.calls.length, 1, "the nested call performed exactly one capture");
	assert.equal(mock.commands.filter((command) => command.method === "Page.navigate").length, 1);
});
