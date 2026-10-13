// Offline acceptance for WF08 (docs/web_fetch/WEB_FETCH_REMEDIATION_PLAN.md 5.5, O04) plus the pure
// units the structure contract rests on: the format renderer, the cleaned-offset mapping, link
// classification and the bounded page block list. The tool itself is loaded through the real
// Pi/Jiti loader, exactly like a session loads it, and the browser/CDP boundary is mocked.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { stripVTControlCharacters } from "node:util";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	capturedBlocks,
	cleanOffsetMap,
	codePointLength,
	linkVerdict,
	renderMarkdown,
} from "../src/content-format.ts";
import { mockBrowser } from "./browser-mock.mjs";

assert.equal(process.env.PI_WEB_SEARCH_OFFLINE, "1", "Use node test/run.mjs; do not run this file in your normal environment.");
assert.match(homedir(), /^\/tmp\/pi-web-search-offline-[^/]+\/home$/);
assert.equal(process.env.EASY_PI_CODING_AGENT_DIR, join(homedir(), ".epi", "agent"));

// A format or link decision must never be able to reach the network or spawn a process.
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

const PAGE_URL = "https://page.public.org/article";
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/;
const MAX_PAGE_BLOCKS = 128;

let loaded;
try {
	const { loadExtensions } = await import(pathToFileURL(process.env.PI_EXTENSION_LOADER).href);
	loaded = await loadExtensions([process.env.PI_WEB_SEARCH_EXTENSION], process.cwd());
} catch (error) {
	throw new Error(`The real Pi/Jiti loader must load this extension: ${error.message}`);
}
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0].tools.get("web_fetch").definition;
const owner = { sessionManager: {} };
const call = (params, ctx = owner) => tool.execute("wf08-contract", params, undefined, undefined, ctx);
const dataOf = (result) => result.structuredContent;
const cleaned = (value) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

afterEach(() => {
	assert.deepEqual(unexpectedIO, [], "No unmocked network or subprocess call is allowed");
});

/**
 * A capture with many blocks, many links, a table, a code block and one block that straddles a
 * page boundary. Every offset is built the way the scanner builds it: code points joined by '\n'.
 */
function maximalCapture() {
	const rows = [];
	const push = (text, extra = {}) => {
		const start = rows.length ? rows.at(-1).end + 1 : 0;
		rows.push({ text, start, end: start + codePointLength(text), ...extra });
	};
	// The long block sits first, so a small page ends inside it and both pages report it. The table
	// and the code block follow immediately, so they stay inside the bounded reporting window.
	const span = `SPAN_${"y".repeat(800)}`;
	push(span, { type: "other" });
	push("T_HEAD_A", { type: "table", table: 1, row: 0, cell: 0, header: true });
	push("T_HEAD_B", { type: "table", table: 1, row: 0, cell: 1, header: true });
	push("T_CELL_A1", { type: "table", table: 1, row: 1, cell: 0, header: false });
	push("T_CELL_B1", { type: "table", table: 1, row: 1, cell: 1, header: false });
	push("CODE_LINE_ONE\n    CODE_INDENTED", { type: "code" });
	for (let index = 0; index < 130; index++) {
		const links = [
			{ start: 6, end: 9, href: `https://page.public.org/link/${index}/a` },
			{ start: 10, end: 13, href: "javascript:void(0)" },
		];
		push(`P${String(index).padStart(3, "0")}_${"x".repeat(30)}`, { links });
	}
	for (let index = 130; index < 220; index++) push(`Q${String(index).padStart(3, "0")}_${"z".repeat(30)}`);
	const text = rows.map((row) => row.text).join("\n");
	const blocks = rows.map((row) => {
		const block = { type: row.type ?? "paragraph", start: row.start, end: row.end };
		if (row.header !== undefined) block.header = row.header;
		if (row.table !== undefined) {
			block.table = row.table;
			block.row = row.row;
			block.cell = row.cell;
		}
		if (row.links) block.links = row.links.map((link) => ({ ...link, start: row.start + link.start, end: row.start + link.end }));
		return block;
	});
	return { text, blocks, spanStart: rows.find((row) => row.text === span).start };
}

function pageOf(text, blocks, offset, maxChars) {
	const chars = Array.from(text);
	const page = chars.slice(offset, offset + maxChars).join("");
	const end = offset + Array.from(page).length;
	return { text: page, end, total: chars.length, next: end < chars.length ? end : null };
}

test("O04: a maximal capture is paginated across a structure boundary with bounded metadata", async (t) => {
	const fixture = maximalCapture();
	const mock = mockBrowser(t, {
		snapshots: [{ url: PAGE_URL, title: "Maximal", text: fixture.text, structure: fixture.blocks }],
	});
	// (A) One page that holds the whole capture: the block list stays bounded and says so.
	const wide = await call({ url: PAGE_URL, max_chars: 16000 });
	const wideData = dataOf(wide);
	assert.equal(wideData.text, fixture.text);
	assert.equal(wideData.next_offset, null);
	assert.equal(wideData.total_chars, fixture.text.length);
	assert.equal(wideData.format, "text");
	assert.ok(Buffer.byteLength(wideData.text) <= 16000, "the page stays inside the byte bound");
	assert.equal(Object.keys(wideData).length, 22, "structuredContent keeps exactly its declared fields");
	const list = wide.details.blocks;
	assert.equal(list.format, "text");
	assert.equal(list.page_offset, 0);
	assert.ok(list.total > 130, `the capture has many blocks: ${list.total}`);
	assert.equal(list.listed, MAX_PAGE_BLOCKS, "the reported block list is bounded");
	assert.equal(list.truncated, true, "a bounded block list is disclosed");
	assert.equal(list.page_end, fixture.text.length);
	for (const item of list.items) {
		assert.ok(item.start >= list.page_offset && item.end <= list.page_end, `${item.id} stays inside the page`);
		assert.ok(item.end > item.start);
		assert.equal(item.frame, 0);
		assert.equal(item.frame_url, PAGE_URL);
		assert.match(item.id, /^f\d+b\d+$/);
	}
	const links = list.items.flatMap((item) => item.links ?? []);
	assert.ok(links.length > 0 && links.length <= 128, `reported links are bounded: ${links.length}`);
	const wideChars = Array.from(wideData.text);
	assert.equal(wideChars.slice(list.items[0].start, list.items[0].end).join("").startsWith("SPAN_"), true, "the first block is the long one");
	// The table keeps row/cell/header and the code block keeps its type.
	const table = list.items.filter((item) => item.type === "table");
	assert.deepEqual(table.map((item) => [item.row, item.cell, item.header]), [
		[0, 0, true],
		[0, 1, true],
		[1, 0, false],
		[1, 1, false],
	]);
	for (const item of table) assert.equal(item.type, "table");
	const code = list.items.find((item) => item.type === "code");
	assert.ok(code, "the code block is reported");
	assert.ok(wideChars.slice(code.start, code.end).join("").includes("CODE_INDENTED"));

	// (B) A small page that ends inside the long first block, plus its continuation.
	const maxChars = 400;
	const first = await call({ url: PAGE_URL, max_chars: maxChars });
	const data = dataOf(first);
	const expected = pageOf(fixture.text, fixture.blocks, 0, maxChars);
	assert.equal(data.text, expected.text);
	assert.equal(data.offset, 0);
	assert.equal(data.next_offset, expected.next);
	assert.equal(data.total_chars, fixture.text.length, "the capture length is stable across pages");
	const firstList = first.details.blocks;
	const spanItem = firstList.items.find((item) => Array.from(data.text).slice(item.start, item.end).join("").startsWith("SPAN_"));
	assert.ok(spanItem, "the straddling block is reported on this page");
	assert.equal(spanItem.partial, true, "a block that continues past the page is marked partial");
	assert.equal(spanItem.end, firstList.page_end);
	assert.equal(spanItem.start, firstList.page_offset);
	const second = await call({ snapshot_id: data.snapshot_id, offset: data.next_offset, max_chars: maxChars });
	const secondData = dataOf(second);
	assert.equal(secondData.format, "text", "a continuation without format keeps the capture's format");
	assert.equal(secondData.total_chars, data.total_chars, "the capture length is stable across pages");
	assert.equal(secondData.captured_at, data.captured_at);
	assert.equal(secondData.pagination_consistent, true);
	assert.equal(data.text + secondData.text, fixture.text.slice(0, maxChars * 2), "the two pages reassemble the capture");
	const secondList = second.details.blocks;
	const continued = secondList.items.find((item) => item.id === spanItem.id);
	assert.ok(continued, "the straddling block continues on the next page");
	assert.equal(
		secondData.text.slice(0, continued.end - secondList.page_offset),
		fixture.text.slice(secondList.page_offset, continued.end),
		"the same block text continues after the page boundary",
	);
	assert.equal(continued.start, secondList.page_offset, "the continuation is clipped to its own page");
	assert.equal(continued.partial, true);
	assert.equal(continued.id, spanItem.id, "a block keeps its stable id across pages");
	assert.equal(mock.calls.length, 2, "one browser per explicit url capture, none for the continuation");
	assert.equal(mock.commands.filter((command) => command.method === "Page.navigate").length, 2);
});

test("O04: a continuation keeps format, provenance and the capture-time metadata", async (t) => {
	const fixture = maximalCapture();
	const mock = mockBrowser(t, {
		snapshots: [{ url: PAGE_URL, title: "Maximal", text: fixture.text, structure: fixture.blocks, ambiguities: ["structure_truncated"] }],
	});
	const capture = await call({ url: PAGE_URL, format: "markdown", max_chars: 400 });
	const data = dataOf(capture);
	assert.equal(data.format, "markdown");
	assert.equal(typeof data.snapshot_id, "string");
	assert.ok(data.text.startsWith("SPAN_"), "markdown starts with the same capture");
	assert.deepEqual(data.ambiguities, ["structure_truncated"], "the sampling caveat is disclosed, not hidden");
	assert.deepEqual(data.incomplete_reasons, [], "a structure budget caveat is never a coverage reason");
	assert.equal(data.scan_complete, true, "a structure budget caveat never degrades coverage");
	assert.ok(
		capture.details.warnings.some((warning) => /Scan ambiguity \(structure_truncated\)/.test(warning)),
		"the caveat is explained in the warnings",
	);
	// The markdown structure of this page is reported with markdown offsets.
	const markdownChars = Array.from(data.text);
	const list = capture.details.blocks;
	assert.equal(list.format, "markdown");
	assert.equal(list.page_end, Array.from(data.text).length);
	for (const item of list.items) {
		assert.ok(item.start >= list.page_offset && item.end <= list.page_end);
		assert.ok(markdownChars.slice(item.start, item.end).join("").length > 0, "every item maps to markdown text");
	}
	// The continuation: same format, same provenance, capture-time counters instead of zeros.
	const continuation = await call({ snapshot_id: data.snapshot_id, offset: data.next_offset, max_chars: 400 });
	const contData = dataOf(continuation);
	assert.equal(contData.format, "markdown");
	assert.equal(contData.offset, data.next_offset);
	assert.equal(contData.total_chars, data.total_chars);
	assert.equal(contData.captured_at, data.captured_at);
	assert.deepEqual(contData.ambiguities, ["structure_truncated"], "stored caveats stay visible");
	assert.equal(contData.frames_read, data.frames_read, "a continuation reports the capture-time frame count");
	assert.equal(contData.scroll_steps, data.scroll_steps);
	assert.equal(contData.blocked_requests, data.blocked_requests);
	assert.equal(contData.dns_mode, data.dns_mode);
	assert.equal(continuation.details.stabilized, true, "the capture-time settled state travels with the snapshot");
	assert.match(continuation.content[0].text, /Capture-time scan \(counted during that capture, not by this memory read\)/);
	assert.match(continuation.content[0].text, /short-term memory snapshot, markdown/);
	assert.equal(continuation.details.frames.length, 1, "per-frame provenance is reported on a continuation too");
	assert.equal(continuation.details.frames[0].url, PAGE_URL);
	assert.equal(continuation.details.frames[0].role, "main");
	assert.equal(continuation.details.blocks.format, "markdown");
	assert.ok(continuation.details.blocks.items.length > 0, "the continuation page reports its own blocks");
	assert.equal(mock.calls.length, 1, "the continuation did not start a browser");
	assert.equal(mock.servers.length, 1);
	assert.equal(mock.commands.filter((command) => command.method === "Page.navigate").length, 1);
	// Asking for the other format is refused with a stable code, and again does no work.
	await assert.rejects(call({ snapshot_id: data.snapshot_id, format: "text" }), (error) => {
		assert.equal(error.code, "format-mismatch");
		assert.match(error.message, /captured as markdown/);
		return true;
	});
	assert.equal(mock.calls.length, 1);
	assert.equal(mock.commands.filter((command) => command.method === "Page.navigate").length, 1);
});

test("O04: link targets are classified without ever being requested", async (t) => {
	const fixture = maximalCapture();
	const mock = mockBrowser(t, {
		snapshots: [{ url: PAGE_URL, title: "Links", text: fixture.text, structure: fixture.blocks }],
	});
	const capture = await call({ url: PAGE_URL, format: "markdown", max_chars: 4000 });
	const data = dataOf(capture);
	const links = capture.details.blocks.items.flatMap((item) => item.links ?? []);
	assert.ok(links.length > 20, `the page reports its links: ${links.length}`);
	assert.ok(links.some((link) => link.allowed === true && link.href.startsWith("https://page.public.org/link/")));
	const refused = links.filter((link) => link.allowed === false);
	assert.ok(refused.length > 10, "dangerous targets are reported as not callable");
	for (const link of refused) {
		assert.equal(link.href, "javascript:void(0)");
		assert.ok(link.note && link.note.length > 0);
	}
	assert.doesNotMatch(data.text, /\]\(javascript:/i, "no callable javascript link is emitted");
	assert.doesNotMatch(data.text, /javascript:/i, "the markdown body never contains a javascript target");
	// The command stream shows no navigation or network work beyond the page that was requested.
	const navigations = mock.commands.filter((command) => command.method === "Page.navigate");
	assert.deepEqual(navigations.map((command) => command.params.url), [PAGE_URL]);
	assert.equal(JSON.stringify(mock.commands).includes("javascript:"), false, "no CDP command carries a link target");
	assert.equal(JSON.stringify(mock.commands).includes("/link/"), false, "no link target was ever requested");
	assert.equal(mock.servers.length, 1);
});

test("O04: content_status never changes coverage, and both mock pages stay settled", async (t) => {
	const text = "A short public page with a paragraph of readable text.";
	const plain = mockBrowser(t, { snapshots: [{ url: PAGE_URL, title: "Plain", text }] });
	const plainResult = await call({ url: PAGE_URL });
	assert.equal(dataOf(plainResult).content_status, "content");
	assert.equal(dataOf(plainResult).scan_complete, true);
	assert.deepEqual(dataOf(plainResult).incomplete_reasons, []);
	assert.equal(plain.commands.filter((command) => command.method === "Page.navigate").length, 1);
	// The same capture text with a visible password form. The classification differs; the coverage
	// difference comes only from the scanner's own pre-existing password_form observation, and the
	// classification itself adds no reason.
	const password = mockBrowser(t, { snapshots: [{ url: PAGE_URL, title: "Password", text, passwordForm: true }] });
	const passwordResult = await call({ url: PAGE_URL });
	assert.equal(dataOf(passwordResult).content_status, "possible_login");
	assert.deepEqual(dataOf(passwordResult).incomplete_reasons, ["password_form"], "only the scanner's own form caveat");
	assert.equal(dataOf(passwordResult).scan_complete, false);
	assert.equal(dataOf(passwordResult).capture_truncated, dataOf(plainResult).capture_truncated);
	assert.equal(dataOf(passwordResult).next_offset, dataOf(plainResult).next_offset, "pagination is untouched");
	assert.equal(dataOf(passwordResult).total_chars, dataOf(plainResult).total_chars);
	assert.equal(dataOf(passwordResult).text, dataOf(plainResult).text, "the captured text is untouched");
	// Challenge text with little content is a hint, never a coverage verdict.
	const challenge = mockBrowser(t, { snapshots: [{ url: PAGE_URL, title: "Challenge", text: "Just a moment..." }] });
	const challengeResult = await call({ url: PAGE_URL });
	assert.equal(dataOf(challengeResult).content_status, "possible_challenge");
	assert.equal(dataOf(challengeResult).scan_complete, true);
	assert.deepEqual(dataOf(challengeResult).incomplete_reasons, []);
	// A long article that merely quotes a challenge phrase stays content.
	const article = mockBrowser(t, { snapshots: [{ url: PAGE_URL, title: "Article", text: `${"word ".repeat(400)}just a moment of your time` }] });
	const articleResult = await call({ url: PAGE_URL });
	assert.equal(dataOf(articleResult).content_status, "content", "challenge evidence must require little content");
	// A login wall without a password box is never a possible login, whatever the buttons say.
	const wall = mockBrowser(t, { snapshots: [{ url: PAGE_URL, title: "Wall", text: "Log In or Sign Up to continue reading this document." }] });
	const wallResult = await call({ url: PAGE_URL });
	assert.equal(dataOf(wallResult).content_status, "content");
	assert.equal(dataOf(wallResult).scan_complete, true);
	assert.equal(
		wallResult.details.warnings.some((warning) => /may be behind a login page/.test(warning)),
		false,
		"a button alone is not login evidence",
	);
});

test("WF08: the markdown renderer keeps the page's own block semantics", () => {
	const spec = [
		["heading", "Title", { level: 1 }],
		["paragraph", "Intro text", {}],
		["list-item", "one", { ordered: false, depth: 1, ordinal: 1 }],
		["list-item", "two", { ordered: false, depth: 1, ordinal: 2 }],
		["list-item", "nested", { ordered: false, depth: 2, ordinal: 1 }],
		["list-item", "three", { ordered: true, depth: 1, ordinal: 3 }],
		["paragraph", "code:", {}],
		["code", "    keep this indentation", {}],
		["table", "a", { table: 1, row: 0, cell: 0, header: true }],
		["table", "b", { table: 1, row: 0, cell: 1, header: true }],
		["table", "c", { table: 1, row: 1, cell: 0 }],
		["table", "d", { table: 1, row: 1, cell: 1 }],
		["paragraph", "# not a heading", {}],
	];
	const blocks = [];
	const parts = [];
	let cursor = 0;
	for (const [type, value, extra] of spec) {
		if (parts.length) {
			parts.push("\n");
			cursor += 1;
		}
		const start = cursor;
		cursor += Array.from(value).length;
		blocks.push({ type, start, end: cursor, ...extra });
		parts.push(value);
	}
	const text = parts.join("");
	const rendered = renderMarkdown(text, blocks);
	assert.equal(
		rendered.text,
		[
			"# Title",
			"Intro text",
			"- one",
			"- two",
			"  - nested",
			"3. three",
			"code:",
			"```",
			"    keep this indentation",
			"```",
			"| a | b |",
			"| --- | --- |",
			"| c | d |",
			"\\# not a heading",
		].join("\n"),
	);
	const chars = Array.from(rendered.text);
	for (const block of rendered.blocks) assert.ok(chars.slice(block.start, block.end).join("").length > 0, `block ${block.type} maps onto the markdown text`);
	const heading = rendered.blocks.find((block) => block.type === "heading");
	assert.equal(chars.slice(heading.start, heading.end).join(""), "# Title");
	const nested = rendered.blocks.find((block) => block.depth === 2);
	assert.equal(chars.slice(nested.start, nested.end).join(""), "  - nested");
	const header = rendered.blocks.find((block) => block.header === true);
	assert.equal(chars.slice(header.start, header.end).join(""), "a");
	assert.equal(headinglessParagraph(), "Just text");
	// A container (frame) block whose boundaries coincide with decorated blocks maps onto exactly
	// its rendered range, decoration of the first and last inner block included.
	const framed = renderMarkdown("Lead\nTitle\nitem", [
		{ type: "paragraph", start: 0, end: 4, frame: 0 },
		{ type: "frame", start: 5, end: 15, frame: 0, id: "f0frame" },
		{ type: "heading", start: 5, end: 10, level: 1, frame: 0 },
		{ type: "list-item", start: 11, end: 15, ordered: false, depth: 1, ordinal: 1, frame: 0 },
	]);
	assert.equal(framed.text, "Lead\n# Title\n- item");
	const frame = framed.blocks.find((block) => block.type === "frame");
	assert.ok(frame, "the frame block stays in the markdown structure");
	assert.equal(
		Array.from(framed.text).slice(frame.start, frame.end).join(""),
		"# Title\n- item",
		"a frame block covers exactly its own rendered content",
	);
	// A fence longer than any run of backticks keeps the code block intact.
	const ticks = renderMarkdown("```", [{ type: "code", start: 0, end: 3 }]);
	assert.equal(ticks.text, "````\n```\n````");
});

function headinglessParagraph() {
	return renderMarkdown("Just text", [{ type: "paragraph", start: 0, end: 9 }]).text;
}

test("WF08: structure offsets are remapped onto the cleaned text that pagination uses", () => {
	const raw = "\u001b[31mHe\u0000ading\u001b[0m\nbody\u007f text";
	const cleanedText = cleaned(raw);
	assert.ok(cleanedText.length < raw.length, "the fixture must actually lose characters");
	const map = cleanOffsetMap(raw, cleanedText);
	assert.equal(map.changed, true);
	assert.equal(map.map(0), 0);
	assert.equal(cleanedText, "Heading\nbody text");
	// Every offset of a block that survives cleaning still points at that block's own text.
	const rendered = renderMarkdown(cleanedText, [
		{ type: "heading", start: map.map(0), end: map.map(7), level: 1 },
		{ type: "paragraph", start: map.map(8), end: map.map(17) },
	]);
	assert.equal(rendered.text, "# Heading\nbody text");
	const identity = cleanOffsetMap("same", "same");
	assert.equal(identity.changed, false);
	assert.equal(identity.map(3), 3);
	// Control characters never survive into the reported text.
	assert.doesNotMatch(cleanedText, CONTROLS);
});

test("WF08: link classification is a policy check, not a request", () => {
	for (const href of ["https://page.public.org/a", "http://page.public.org/a?x=1#hash", "https://page.public.org/#anchor"]) {
		assert.deepEqual(linkVerdict(href), { allowed: true }, href);
	}
	const refused = [
		"javascript:void(0)",
		"data:text/html,<b>x</b>",
		"file:///etc/passwd",
		"mailto:someone@page.public.org",
		"https://user:pw@page.public.org/a",
		"https://page.public.org:8443/a",
		"http://127.0.0.1/a",
		"http://localhost/a",
		"",
	];
	for (const href of refused) {
		const verdict = linkVerdict(href);
		assert.equal(verdict.allowed, false, href);
		assert.equal(verdict.note.includes("pw"), false, "a reason never echoes the target");
	}
});

test("WF08: the page block list is bounded and clipped to the page", () => {
	const text = `alpha\n${"b".repeat(400)}\nomega`;
	const blocks = [
		{ type: "paragraph", start: 0, end: 5, frame: 0 },
		{ type: "paragraph", start: 6, end: 406, frame: 0 },
		{ type: "paragraph", start: 407, end: 412, frame: 0 },
	];
	const list = capturedBlocks({
		format: "text",
		total: codePointLength(text),
		blocks,
		frameUrls: ["https://page.public.org/a"],
		pageStart: 3,
		pageEnd: 100,
	});
	assert.deepEqual(
		list.items.map((item) => [item.start, item.end, item.partial]),
		[
			[3, 5, true],
			[6, 100, true],
		],
		"blocks are clipped to the page and marked partial when they continue",
	);
	assert.equal(list.total, 3);
	assert.equal(list.truncated, false);
	assert.equal(list.items.every((item) => item.frame_url === "https://page.public.org/a"), true);
	const many = Array.from({ length: 400 }, (_, index) => ({
		type: "paragraph",
		start: index * 2,
		end: index * 2 + 1,
		frame: 0,
		id: `f0b${index}`,
	}));
	const bounded = capturedBlocks({ format: "text", total: 1000, blocks: many, frameUrls: [], pageStart: 0, pageEnd: 1000 });
	assert.equal(bounded.listed, MAX_PAGE_BLOCKS, "the page block list is bounded");
	assert.equal(bounded.truncated, true, "a bounded list says so");
	assert.equal(bounded.total, many.length);
});
