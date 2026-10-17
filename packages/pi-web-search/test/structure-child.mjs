// O01-O03 acceptance for WF08 (docs/web_fetch/WEB_FETCH_REMEDIATION_PLAN.md 5.5): structure and
// markdown, link provenance, and content quality. Real Chromium against loopback fixtures through
// the shared isolated harness; the tool itself is loaded through the real Pi/Jiti loader, so the
// assertions exercise the shipped code path (schema, format contract, rendering, output).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { setupBrowserFixtures } from "./browser-harness.mjs";
import { fixturePage } from "./structure-fixtures.mjs";
import { snapshotHost } from "./session-host.mjs";

const { readPage, stats } = await setupBrowserFixtures({
	fixturePage,
	hosts: ["page.public.org", "frame.public.net"],
});
after(() => assert.ok(stats.publicAttempts > 0));

const { loadExtensions } = await import(
	new URL("../../coding-agent/dist/core/extensions/loader.js", import.meta.url).href
);
const loaded = await loadExtensions([fileURLToPath(new URL("../src/index.ts", import.meta.url))], process.cwd());
assert.deepEqual(loaded.errors, [], "the real loader must load this extension");
const tool = loaded.extensions[0].tools.get("web_fetch").definition;
/** One real session/branch anchor per host. */
const owner = snapshotHost();
const clean = (value) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const call = (params) => tool.execute("structure-call", params, undefined, undefined, owner);
const dataOf = (result) => result.structuredContent;
const url = (path) => `http://page.public.org${path}`;

/** Find one reported block by a marker in its own text, and read that text back from the page. */
function blocksOf(result) {
	const body = dataOf(result).text;
	const chars = Array.from(body);
	return {
		body,
		list: result.details.blocks,
		slice: (item) => chars.slice(item.start, item.end).join(""),
		withMarker: (marker) => {
			const found = result.details.blocks.items.find((item) => chars.slice(item.start, item.end).join("").includes(marker));
			assert.ok(found, `the block list must report a block containing ${marker}`);
			return found;
		},
	};
}

test("O01: text mode does not regress, and markdown keeps the page's own structure", async () => {
	const path = "/o01-structure";
	const plain = await readPage(url(path));
	const textPage = await call({ url: url(path), max_chars: 16000 });
	const text = dataOf(textPage);
	assert.equal(text.format, "text", "text remains the default format");
	assert.equal(text.text, clean(plain.text), "text mode must stay byte-identical to the plain capture");
	assert.equal(text.total_chars, Array.from(clean(plain.text)).length, "offsets still count cleaned code points");
	assert.equal(text.next_offset, null);

	const md = await call({ url: url(path), format: "markdown", max_chars: 16000 });
	const mdData = dataOf(md);
	assert.equal(mdData.format, "markdown");
	const blocks = blocksOf(md);
	const body = blocks.body;

	// Headings keep exactly the levels the DOM used, and nothing invents a level.
	assert.match(body, /^# O01_HEADING_ONE$/m);
	assert.match(body, /^## O01_HEADING_TWO$/m);
	assert.match(body, /^### O01_HEADING_THREE$/m);
	assert.doesNotMatch(body, /^# O01_HEADING_TWO/m, "a level must not be promoted");
	// Lists keep their nesting and their own numbers.
	assert.match(body, /^- O01_ITEM_ALPHA$/m);
	assert.match(body, /^- O01_ITEM_BETA$/m);
	assert.match(body, /^ {2}- O01_NESTED_ALPHA$/m);
	assert.match(body, /^ {2}- O01_NESTED_BETA$/m);
	assert.match(body, /^3\. O01_ORDERED_THREE$/m);
	assert.match(body, /^4\. O01_ORDERED_FOUR$/m);
	// A code block stays one fenced block with its indentation intact.
	const fenced = /```\n([\s\S]*?)\n```/.exec(body);
	assert.ok(fenced, `a code fence must exist:\n${body}`);
	assert.equal(fenced[1], "O01_CODE_LINE_ONE\nO01_CODE_LINE_TWO\n    O01_CODE_INDENTED");
	// A table keeps row/cell relationships, with a header separator only because the DOM used th.
	assert.match(body, /^\| O01_HEAD_A \| O01_HEAD_B \|$/m);
	assert.match(body, /^\| --- \| --- \|$/m);
	assert.match(body, /^\| O01_CELL_A1 \| O01_CELL_B1 \|$/m);
	assert.match(body, /^\| O01_CELL_A2 \| O01_CELL_B2 \|$/m);
	// No invented semantics: a paragraph whose text starts with '#' stays a paragraph.
	assert.match(body, /^\\# O01_HASH_PARAGRAPH$/m);
	// An inline link becomes a markdown link, and the block that is a link keeps its target and title.
	assert.match(body, /O01_INTRO with inline text and a \[O01_INLINE_LINK\]\(http:\/\/page\.public\.org\/o01-inline\) inside a paragraph\./);
	assert.match(body, /^\[O01_BLOCK_LINK\]\(http:\/\/page\.public\.org\/o01-block-link\)$/m);

	// Nothing the plain capture showed may be lost in markdown.
	for (const value of [
		"O01_HEADING_ONE",
		"O01_INTRO",
		"O01_INLINE_LINK",
		"O01_BLOCK_LINK",
		"O01_HEADING_THREE",
		"O01_ITEM_ALPHA",
		"O01_ITEM_BETA",
		"O01_NESTED_ALPHA",
		"O01_NESTED_BETA",
		"O01_ITEM_GAMMA",
		"O01_ORDERED_THREE",
		"O01_ORDERED_FOUR",
		"O01_CODE_LEAD",
		"O01_CODE_INDENTED",
		"O01_HEAD_A",
		"O01_CELL_B2",
		"O01_HASH_PARAGRAPH",
		"O01_END",
	])
		assert.ok(body.includes(value), `markdown must keep ${value}`);

	// Provenance: every reported block maps to its frame and carries its type and range.
	const list = blocks.list;
	assert.equal(list.format, "markdown");
	assert.equal(list.truncated, false);
	assert.equal(list.page_offset, 0);
	assert.equal(list.page_end, mdData.total_chars);
	assert.equal(list.total, list.listed);
	// Per-frame provenance is reported next to the block list (WF06 left it out of the structured views).
	assert.equal(md.details.frames.length, 1);
	assert.equal(md.details.frames[0].role, "main");
	assert.equal(md.details.frames[0].url, url(path));
	assert.equal(md.details.frames[0].status, "complete");
	for (const item of list.items) {
		assert.equal(item.frame, 0);
		assert.equal(item.frame_url, url(path));
		assert.ok(item.start >= list.page_offset && item.end <= list.page_end, `${item.id} stays inside the page`);
		assert.ok(item.end > item.start);
		assert.match(item.id, /^f\d+b\d+$/);
	}
	const heading = blocks.withMarker("O01_HEADING_TWO");
	assert.equal(heading.type, "heading");
	assert.equal(heading.level, 2);
	assert.equal(heading.frame_url, url(path));
	assert.equal(blocks.slice(heading), "## O01_HEADING_TWO");
	const nested = blocks.withMarker("O01_NESTED_BETA");
	assert.equal(nested.type, "list-item");
	assert.equal(nested.depth, 2);
	assert.equal(nested.ordered, false);
	const ordered = blocks.withMarker("O01_ORDERED_FOUR");
	assert.equal(ordered.type, "list-item");
	assert.equal(ordered.ordered, true);
	assert.equal(ordered.ordinal, 4);
	const code = blocks.withMarker("O01_CODE_INDENTED");
	assert.equal(code.type, "code");
	assert.ok(blocks.slice(code).startsWith("```\n"), "the code block includes its fence");
	const header = blocks.withMarker("O01_HEAD_B");
	assert.equal(header.type, "table");
	assert.equal(header.header, true);
	assert.equal(header.row, 0);
	assert.equal(header.cell, 1);
	const cell = blocks.withMarker("O01_CELL_A2");
	assert.equal(cell.type, "table");
	assert.equal(cell.header, false);
	assert.equal(cell.row, 2);
	assert.equal(cell.cell, 0);
	const link = blocks.withMarker("O01_BLOCK_LINK");
	assert.equal(link.type, "link");
	assert.equal(link.links.length, 1);
	assert.equal(link.links[0].allowed, true);
	assert.equal(link.links[0].href, url("/o01-block-link"));
	assert.equal(link.links[0].title, "O01 block title");
	assert.equal(blocks.slice(link), `[O01_BLOCK_LINK](${url("/o01-block-link")})`);
	// A continuation of the markdown capture keeps the format and reports the same structure.
	const mdOwner = snapshotHost();
	const stored = await tool.execute("structure-md", { url: url(path), format: "markdown", max_chars: 30 }, undefined, undefined, mdOwner);
	const snapshotId = dataOf(stored).snapshot_id;
	assert.equal(typeof snapshotId, "string");
	const first = dataOf(stored).text;
	const continuation = await tool.execute(
		"structure-md-cont",
		{ snapshot_id: snapshotId, offset: dataOf(stored).next_offset, max_chars: 30 },
		undefined,
		undefined,
		mdOwner,
	);
	const wide = await tool.execute("structure-md-wide", { snapshot_id: snapshotId, offset: 0, max_chars: 60 }, undefined, undefined, mdOwner);
	const continued = dataOf(continuation);
	assert.equal(continued.format, "markdown", "a continuation without format keeps the capture's format");
	assert.equal(continued.captured_at, dataOf(stored).captured_at);
	assert.equal(continued.total_chars, dataOf(stored).total_chars, "the capture length is stable");
	assert.equal(first + continued.text, dataOf(wide).text, "consecutive pages reassemble inside one capture");
	assert.equal(continuation.details.blocks.format, "markdown");
	assert.equal(continuation.details.frames[0].url, url(path), "frame provenance survives the snapshot");
	assert.equal(continuation.details.frames[0].status, "complete");
	assert.equal([...continuation.details.blocks.items, ...wide.details.blocks.items].every((item) => item.frame_url === url(path)), true);
	// A continuation that asks for the other format is refused with a stable code, and does no work.
	const mismatch = await tool.execute("structure-md-bad", { snapshot_id: snapshotId, format: "text" }, undefined, undefined, mdOwner).then(
		() => undefined,
		(error) => error,
	);
	assert.ok(mismatch, "a different format must be refused");
	assert.equal(mismatch.code, "format-mismatch");
	assert.match(mismatch.message, /captured as markdown/);
});

test("O02: links resolve against each frame's own base, and no target is ever callable when unsafe", async () => {
	const path = "/o02-links-main";
	const md = await call({ url: url(path), format: "markdown", max_chars: 16000 });
	const data = dataOf(md);
	const body = data.text;
	const frames = md.details.frames;
	assert.equal(frames.length, 2, "one provenance entry per frame");
	const embedded = frames.find((frame) => frame.role === "embedded");
	const main = frames.find((frame) => frame.role === "main");
	assert.equal(embedded.url, url("/o02-links-frame"));
	assert.equal(main.url, url(path));
	assert.equal(md.details.url, url(path), "the final URL is still the requested document");
	assert.equal(data.url, url(path));
	assert.ok(body.includes("[Embedded frame text]"), "the embedded frame keeps its marker");

	const items = md.details.blocks.items;
	const linksOf = (frame) =>
		items
			.filter((item) => item.frame === frame.index)
			.flatMap((item) => item.links ?? [])
			.map((link) => ({ ...link, text: Array.from(body).slice(link.start, link.end).join("") }));
	const mainLinks = linksOf(main);
	const frameLinks = linksOf(embedded);
	assert.ok(mainLinks.length >= 6, `the main document must report its links: ${JSON.stringify(mainLinks)}`);
	assert.ok(frameLinks.length >= 3, `the embedded frame must report its links: ${JSON.stringify(frameLinks)}`);
	// The same link text exists in both frames; the reported source stays per frame.
	assert.ok(mainLinks.some((link) => link.text.includes("O02_SAME_TEXT")), "the main frame's link text");
	assert.ok(frameLinks.some((link) => link.text.includes("O02_SAME_TEXT")), "the embedded frame's identical link text");
	const relative = mainLinks.find((link) => link.text.includes("O02_SAME_TEXT") && link.href.includes("/o02-base/"));
	assert.ok(relative, "the base href must be honoured for the main document");
	assert.equal(relative.href, url("/o02-base/relative-target"), "relative targets resolve against document.baseURI");
	assert.equal(relative.allowed, true);
	const frameRelative = frameLinks.find((link) => link.href.includes("/o02-frame-base/"));
	assert.ok(frameRelative, "the embedded frame's own base href must be honoured");
	assert.equal(frameRelative.href, url("/o02-frame-base/frame-relative"));
	assert.equal(frameRelative.allowed, true);
	// A same-page hash anchor stays usable.
	const hash = mainLinks.find((link) => link.text.includes("O02_HASH_LINK"));
	assert.equal(hash.href, url("/o02-base/#o02-anchor"));
	assert.equal(hash.allowed, true);
	// Dangerous, credentialed and non-public targets are reported but never callable.
	const refused = [
		["javascript:window.close()", "O02_SAME_TEXT"],
		["javascript:void(0)", "O02_FRAME_SAME_TEXT"],
		["data:text/html,<b>O02_DATA</b>", "O02_DATA_LINK"],
		["file:///etc/passwd", "O02_FILE_LINK"],
		["mailto:o02@public.org", "O02_MAILTO_LINK"],
		["https://page.public.org:8443/o02-port", "O02_PORT_LINK"],
	];
	for (const [href, marker] of refused) {
		const link = [...mainLinks, ...frameLinks].find((entry) => entry.href === href);
		assert.ok(link, `the target ${href} must still be reported as a link span`);
		assert.equal(link.allowed, false, `${href} must not be callable`);
		assert.ok(link.text.includes(marker), `${href} must keep the page's link text ${marker}`);
		assert.ok(link.note && link.note.length <= 240, `${href} must carry a bounded reason`);
		assert.ok(body.includes(marker), `${marker} must stay as text in the markdown body`);
	}
	// A credentialed target is reported without its credentials, and never as a link.
	const credential = [...mainLinks, ...frameLinks].find((entry) => entry.text.includes("O02_CREDENTIAL_LINK"));
	assert.equal(credential.allowed, false);
	// The scheme, host and path survive; the page-supplied user:password part does not.
	assert.equal(credential.href, "https://page.public.org/o02-credential", "page-supplied credentials must not be copied");
	assert.equal(credential.note.includes("secret"), false);
	const rendered = JSON.stringify(md.details) + body + md.content[0].text;
	assert.equal(rendered.includes("secret"), false, "no credential may appear anywhere in the result");
	for (const pattern of [/\]\(javascript:/i, /\]\(data:/i, /\]\(file:/i, /\]\(mailto:/i, /\]:8443\//, /\]\(https:\/\/[^)]*@/i])
		assert.doesNotMatch(body, pattern, `the markdown body must not contain a callable ${pattern}`);
	// No automatic navigation or crawl: no new frame appeared and the manifest is unchanged.
	assert.equal(frames.length, 2, "reading links must not create a frame for a target");
	assert.deepEqual(
		md.details.frames.map((frame) => frame.url).sort(),
		[url("/o02-links-frame"), url(path)].sort(),
	);
	for (const target of ["/o02-base/relative-target", "/o02-frame-base/frame-relative", "/o02-credential", "/o02-port"]) {
		assert.equal(md.details.frames.some((frame) => frame.url.endsWith(target)), false, `${target} must not be visited`);
	}
	assert.equal(md.details.blocks.items.some((item) => item.frame_url.endsWith("/o02-port")), false);
	// The allowed targets really are ordinary public pages, so the reported URL resolves normally.
	const target = await call({ url: url("/o02-base/relative-target"), max_chars: 200 });
	assert.match(dataOf(target).text, /O02_BASE_RELATIVE_TARGET/);
});

test("O03: content_status is conservative, evidence-based and never changes coverage", async () => {
	// expected coverage is the scanner's own result: a visible password form already makes a capture
	// non-settled (a pre-WF08 rule), and content_status never adds or removes a coverage reason.
	const cases = [
		["/o03-plain-article", "content", true],
		["/o03-login-wall", "content", true],
		["/o03-challenge", "possible_challenge", true],
		["/o03-short-login", "possible_login", false],
		["/o03-article-with-password", "content", false],
	];
	for (const [path, expected, settled] of cases) {
		const result = await call({ url: url(path), max_chars: 4000 });
		const data = dataOf(result);
		assert.equal(data.content_status, expected, `${path} must be ${expected}:\n${data.text.slice(0, 200)}`);
		assert.equal(result.details.content_status, expected);
		assert.equal(data.scan_complete, settled, `${path} must keep the coverage the scan produced`);
		if (settled) assert.deepEqual(data.incomplete_reasons, [], `${path} must not carry coverage reasons`);
		else assert.deepEqual(data.incomplete_reasons, ["password_form"], `${path} keeps only the scanner's own form caveat`);
		assert.equal(data.capture_truncated, false);
		if (expected !== "possible_login") assert.notEqual(data.content_status, "possible_login");
	}
	// Coverage and classification are independent: for the same page, the tool reports exactly what
	// the raw scanner reports, and the classification is derived from the text without feeding back.
	const raw = await readPage(url("/o03-article-with-password"));
	const article = await call({ url: url("/o03-article-with-password"), max_chars: 4000 });
	assert.equal(raw.passwordForm, true, "the scanner did see the password form");
	assert.equal(dataOf(article).scan_complete, raw.scanComplete);
	assert.deepEqual(dataOf(article).incomplete_reasons, raw.incompleteReasons);
	assert.ok(dataOf(article).text.length > 400, "the article is longer than the short-capture bound");
	assert.equal(dataOf(article).content_status, "content", "one password box next to a full article stays content");
	assert.ok(article.details.warnings.some((warning) => /password form/.test(warning)), "the form itself is still disclosed");
	// A login wall without a password box is not login evidence, even when it says "Log In".
	const wall = await call({ url: url("/o03-login-wall"), max_chars: 4000 });
	assert.match(dataOf(wall).text, /Log In or Sign Up/);
	assert.equal(dataOf(wall).content_status, "content");
	assert.equal(
		wall.details.warnings.some((warning) => /may be behind a login page/.test(warning)),
		false,
		"a button alone must not produce a login warning",
	);
	// One password box next to a full article stays content, with the form only as a warning.
	const challenge = await call({ url: url("/o03-challenge"), max_chars: 4000 });
	assert.equal(dataOf(challenge).content_status, "possible_challenge");
	assert.ok(challenge.details.warnings.some((warning) => /challenge or verification text/.test(warning)));
	assert.equal(dataOf(challenge).scan_complete, true, "a challenge hint must not claim a coverage gap");
});

test("O04: a page with more blocks than the structure budget keeps its text and coverage", async () => {
	const path = "/o04-budget";
	// The raw scanner first: the structure budget must bound the structure only, never the text.
	const raw = await readPage(url(path));
	assert.equal(raw.scanComplete, true, "the page settles inside its budget");
	assert.deepEqual(raw.incompleteReasons, [], "a structure budget is not a coverage reason");
	assert.ok(raw.ambiguities.includes("structure_truncated"), `the per-frame budget must be disclosed: ${JSON.stringify(raw.ambiguities)}`);
	const rawBlocks = raw.blocks ?? [];
	assert.equal(rawBlocks.length, 4000, "the per-frame structure budget bounds the block list");
	assert.equal((raw.text.match(/BUDGET_\d+/g) ?? []).length, 4200, "every captured block is still in the text");
	assert.ok(raw.text.endsWith("O04_BUDGET_END"));
	assert.equal(rawBlocks[0].type, "paragraph");
	assert.equal(rawBlocks.slice(1).every((block, index) => rawBlocks[index].start < block.start), true, "blocks stay in document order");

	// The tool reports the same capture, its own page, and the same caveat without degrading coverage.
	const result = await call({ url: url(path), max_chars: 16000 });
	const data = dataOf(result);
	assert.equal(data.total_chars, Array.from(raw.text).length, "the capture length is unchanged");
	assert.ok(Array.from(data.text).length <= 16000, "the page is bounded by max_chars");
	assert.ok(Buffer.byteLength(data.text) <= 16000, "the page is bounded by the 16000 UTF-8 byte limit");
	assert.equal(data.scan_complete, true, "coverage is not degraded by the structure budget");
	assert.deepEqual(data.incomplete_reasons, []);
	assert.ok(data.ambiguities.includes("structure_truncated"));
	assert.match(result.content[0].text, /structure_truncated/);
	assert.match(result.content[0].text, /captured text itself is complete/);
	const list = result.details.blocks;
	assert.equal(list.truncated, true, "the reporting list says it is bounded");
	assert.equal(list.listed, 128, "the page block list is bounded");
	assert.ok(list.total > list.listed, `the capture has more blocks than this page reports: ${list.total}`);
	const pageChars = Array.from(data.text);
	for (const item of list.items) {
		assert.ok(item.start >= list.page_offset && item.end <= list.page_end);
		assert.ok(pageChars.slice(item.start - list.page_offset, item.end - list.page_offset).join("").startsWith("BUDGET_"), `${item.id} maps onto page text`);
	}
});
