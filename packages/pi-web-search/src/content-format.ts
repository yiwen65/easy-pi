/**
 * WF08: the bounded structure model and the format renderer.
 *
 * The scanner keeps producing exactly the block text it produced before; this module only
 * adds a minimal type set on top of that same capture (`heading`, `paragraph`, `list-item`,
 * `code`, `table`, `link`, `frame`, `other`), renders the same capture as markdown when the
 * caller asked for it, and maps blocks and links onto the page that is actually returned.
 *
 * Nothing in here navigates, resolves DNS, fetches or crawls: a link target is classified
 * against the same public-read policy a capture uses and is only ever written out as text.
 */
import { publicTarget, WebError } from "./network.ts";

/** Minimal block type set. Only what the DOM showed is recorded: no level or emphasis is invented. */
export type StructureType = "heading" | "paragraph" | "list-item" | "code" | "table" | "link" | "frame" | "other";

export const STRUCTURE_TYPES: readonly StructureType[] = [
	"heading",
	"paragraph",
	"list-item",
	"code",
	"table",
	"link",
	"frame",
	"other",
];

/** Link span measured by the frame that owns the block. `allowed` is filled in when it is emitted. */
export interface StructureLinkSpan {
	/** Code point offsets into the text the block belongs to (frame text first, capture text later). */
	start: number;
	end: number;
	/** Href as that frame resolved it against document.baseURI, bounded and control-character free. */
	href: string;
	title?: string;
	/** True only when the target passed the public-read policy; filled by linkVerdict(). */
	allowed?: boolean;
	/** Bounded reason code when the target is not callable; never the raw page text. */
	note?: string;
}

export interface StructureBlock {
	type: StructureType;
	/** Code point offsets into the text this block describes (its frame's, then the capture's). */
	start: number;
	end: number;
	/** Heading level 1..6, exactly the h1..h6 the DOM used. */
	level?: number;
	/** List marker kind taken from the nearest ul/ol ancestor. */
	ordered?: boolean;
	/** 1-based list nesting depth (number of ul/ol ancestors), never invented by the renderer. */
	depth?: number;
	/** The li's own number as the DOM expressed it (ol start / li value / position). */
	ordinal?: number;
	/** True for th cells or cells inside thead. */
	header?: boolean;
	/** Table identity inside its frame, used to group cells back into rows. */
	table?: number;
	row?: number;
	cell?: number;
	links?: StructureLinkSpan[];
	/** Index into the capture's frame provenance list; set when a frame's blocks are merged. */
	frame?: number;
	/** Stable local block id, fixed for the capture and preserved across formats. */
	id?: string;
}

/** Per-frame structure budget (WF08 requirement 1). Exceeding it is a caveat, never a coverage gap. */
export const MAX_FRAME_BLOCKS = 4000;
export const MAX_FRAME_LINKS = 2000;
/** Aggregate budget for one capture, so 24 frames cannot multiply the first budget by 24. */
export const MAX_CAPTURE_BLOCKS = 8000;
/** Stable caveat code: disclosed through `ambiguities`, never through `incompleteReasons`. */
export const STRUCTURE_TRUNCATED = "structure_truncated";

/** Bounded output budget for the block list of one returned page. */
export const MAX_PAGE_BLOCKS = 128;
export const MAX_PAGE_LINKS = 128;
const MAX_HREF_CHARS = 512;
const MAX_TITLE_CHARS = 256;
const MAX_FRAME_URL_CHARS = 300;

export interface LinkVerdict {
	allowed: boolean;
	note?: string;
}

/**
 * A link is callable (markdown syntax) only when its target passes the same public-read policy a
 * capture uses: http(s), a public domain, no credentials and a standard port. `javascript:`,
 * `data:`, `file:`, credentialed and other non-public targets stay plain text plus a bounded
 * reason code. This classifies text only - it never resolves, navigates or fetches the target.
 */
export function linkVerdict(href: string): LinkVerdict {
	if (typeof href !== "string" || !href.trim()) return { allowed: false, note: "empty link target" };
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href.trim())?.[1]?.toLowerCase();
	if (scheme !== "http" && scheme !== "https")
		return { allowed: false, note: `not a public HTTP(S) target (${scheme ?? "relative"})` };
	try {
		publicTarget(href);
	} catch (error) {
		if (error instanceof WebError) return { allowed: false, note: error.message.slice(0, 120) };
		return { allowed: false, note: "target refused by the public-read policy" };
	}
	return { allowed: true };
}

/** Code points, not UTF-16 units: every offset in this tool counts code points. */
export function codePointLength(value: string): number {
	let pairs = 0;
	for (let at = 0; at < value.length; at++) {
		const code = value.charCodeAt(at);
		if (code >= 0xd800 && code <= 0xdbff && at + 1 < value.length) {
			const next = value.charCodeAt(at + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				pairs++;
				at++;
			}
		}
	}
	return value.length - pairs;
}

export interface CleanOffsetMap {
	/** True when cleanText() removed characters, so raw and cleaned offsets differ. */
	readonly changed: boolean;
	/** Map a code point offset in the raw text onto the cleaned text. */
	map(offset: number): number;
}

/**
 * cleanText() drops ANSI escape sequences and control characters, which shortens the capture.
 * Structure offsets are measured on the raw capture, so they are remapped onto the cleaned text
 * that pagination actually uses: the removed runs are collected once (deletion-only transform, so
 * a greedy subsequence match is exact) and every offset is shifted by the removed count before it.
 */
export function cleanOffsetMap(raw: string, cleaned: string): CleanOffsetMap {
	if (raw === cleaned)
		return {
			changed: false,
			map: (offset) => offset,
		};
	const rawChars = Array.from(raw);
	const cleanChars = Array.from(cleaned);
	const removed: Array<{ at: number; count: number }> = [];
	for (let index = 0, kept = 0; index < rawChars.length; index++) {
		if (kept < cleanChars.length && rawChars[index] === cleanChars[kept]) {
			kept++;
			continue;
		}
		const last = removed[removed.length - 1];
		if (last && last.at + last.count === index) last.count++;
		else removed.push({ at: index, count: 1 });
	}
	if (!removed.length) return { changed: false, map: (offset) => offset };
	return {
		changed: true,
		map(offset) {
			let dropped = 0;
			for (const run of removed) {
				if (run.at >= offset) break;
				dropped += Math.min(run.count, offset - run.at);
			}
			return offset - dropped;
		},
	};
}

/** One block as it is reported for the returned page: capture-local offsets and frame provenance. */
export interface RenderedBlock {
	id: string;
	type: StructureType;
	start: number;
	end: number;
	frame: number;
	frame_url: string;
	level?: number;
	ordered?: boolean;
	depth?: number;
	ordinal?: number;
	header?: boolean;
	row?: number;
	cell?: number;
	/** True when the block continues past the page that is being reported. */
	partial?: boolean;
	links?: StructureLinkSpan[];
}

export interface FrameProvenance {
	index: number;
	role: "main" | "embedded";
	url: string;
	status: string;
	reasons: string[];
}

/** What a script or the UI needs to locate a block: page range plus a bounded block list. */
export interface CapturedBlocks {
	format: "text" | "markdown";
	page_offset: number;
	page_end: number;
	total: number;
	listed: number;
	truncated: boolean;
	items: RenderedBlock[];
}

export interface BlockListInput {
	format: "text" | "markdown";
	/** Code point length of the whole capture text of that format; block offsets use the same space. */
	total: number;
	blocks: readonly StructureBlock[];
	/** Source frame URL per frame index; the same list the response reports as details.frames. */
	frameUrls: readonly string[];
	pageStart: number;
	pageEnd: number;
}

function clipUrl(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : value.slice(0, maxChars);
}

/** A reported link target: bounded, and never a copy of page-supplied credentials. */
export function displayTarget(href: string): string {
	try {
		const url = new URL(href);
		if (url.username || url.password) {
			url.username = "";
			url.password = "";
			return clipUrl(url.href, MAX_HREF_CHARS);
		}
		return clipUrl(href, MAX_HREF_CHARS);
	} catch {
		return clipUrl(href, MAX_HREF_CHARS);
	}
}

function linkSpan(span: StructureLinkSpan): StructureLinkSpan {
	const verdict = span.allowed === undefined ? linkVerdict(span.href) : { allowed: span.allowed, note: span.note };
	const link: StructureLinkSpan = {
		start: span.start,
		end: span.end,
		href: displayTarget(span.href),
		allowed: verdict.allowed === true,
	};
	if (span.title) link.title = clipUrl(span.title, MAX_TITLE_CHARS);
	if (verdict.allowed !== true && verdict.note) link.note = verdict.note;
	return link;
}

/**
 * The current output page only: the blocks whose range intersects this page, mapped to their source
 * frame URL, with a stable local block id, the block type and its code point range in this page's
 * text. Offsets are absolute in the capture text of this format (the same space as offset and
 * next_offset), so `page_offset` locates the page inside them. The list is bounded, and truncation
 * is reported instead of silently dropping blocks.
 */
export function capturedBlocks(input: BlockListInput): CapturedBlocks {
	const total = Math.max(0, input.total);
	const pageEnd = Math.max(input.pageStart, Math.min(input.pageEnd, total));
	const items: RenderedBlock[] = [];
	let links = 0;
	let truncated = false;
	const ordered = [...input.blocks].sort((a, b) => a.start - b.start || a.end - b.end);
	for (const block of ordered) {
		// A block that ends exactly where the page starts is not part of this page.
		if (block.end <= input.pageStart || block.start >= pageEnd) continue;
		// Only a block that belongs to this page can push the list over its bound.
		if (items.length >= MAX_PAGE_BLOCKS) {
			truncated = true;
			break;
		}
		const frameIndex = block.frame ?? input.frameUrls.length - 1;
		const item: RenderedBlock = {
			id: block.id ?? `b${items.length}`,
			type: block.type,
			start: Math.max(block.start, input.pageStart),
			end: Math.min(block.end, pageEnd),
			frame: frameIndex,
			frame_url: clipUrl(input.frameUrls[frameIndex] ?? "", MAX_FRAME_URL_CHARS),
		};
		if (block.start < input.pageStart || block.end > pageEnd) item.partial = true;
		if (block.level !== undefined) item.level = block.level;
		if (block.ordered !== undefined) item.ordered = block.ordered;
		if (block.depth !== undefined) item.depth = block.depth;
		if (block.ordinal !== undefined) item.ordinal = block.ordinal;
		if (block.header !== undefined) item.header = block.header;
		if (block.row !== undefined) item.row = block.row;
		if (block.cell !== undefined) item.cell = block.cell;
		if (block.links?.length) {
			const seen: StructureLinkSpan[] = [];
			for (const span of block.links) {
				if (span.end <= input.pageStart || span.start >= pageEnd) continue;
				if (links >= MAX_PAGE_LINKS) {
					truncated = true;
					break;
				}
				// Link text/title are page data: control characters must never reach the output.
				seen.push(linkSpan(span));
				links++;
			}
			if (seen.length) item.links = seen;
		}
		items.push(item);
	}
	return {
		format: input.format,
		page_offset: input.pageStart,
		page_end: pageEnd,
		total: ordered.length,
		listed: items.length,
		truncated,
		items,
	};
}

interface RenderedPart {
	text: string;
	link?: StructureLinkSpan;
}

/** Split one block into plain and link pieces; spans are clamped, sorted and never overlapped. */
function blockParts(block: StructureBlock, chars: readonly string[]): RenderedPart[] {
	const parts: RenderedPart[] = [];
	let at = block.start;
	for (const span of [...(block.links ?? [])].sort((a, b) => a.start - b.start || a.end - b.end)) {
		const from = Math.max(block.start, Math.min(span.start, block.end));
		const to = Math.max(from, Math.min(span.end, block.end));
		if (from < at || from >= to) continue;
		if (from > at) parts.push({ text: chars.slice(at, from).join("") });
		const verdict = linkVerdict(span.href);
		const piece: StructureLinkSpan = { start: 0, end: 0, href: span.href, allowed: verdict.allowed };
		if (span.title) piece.title = span.title;
		if (!verdict.allowed && verdict.note) piece.note = verdict.note;
		parts.push({ text: chars.slice(from, to).join(""), link: piece });
		at = to;
	}
	if (at < block.end) parts.push({ text: chars.slice(at, block.end).join("") });
	return parts;
}

/** Markdown destinations keep parentheses, spaces and angle brackets escaped so the link stays one token. */
function markdownTarget(href: string): string {
	return href.replace(/[()\s<>]/g, (char) => encodeURIComponent(char));
}

interface Assembled {
	text: string;
	chars: number;
	links: StructureLinkSpan[];
}

function assemble(prefix: string, parts: readonly RenderedPart[], suffix = ""): Assembled {
	let text = prefix;
	let chars = codePointLength(prefix);
	const links: StructureLinkSpan[] = [];
	for (const part of parts) {
		if (!part.link) {
			text += part.text;
			chars += codePointLength(part.text);
			continue;
		}
		const span: StructureLinkSpan = {
			start: chars,
			end: 0,
			href: displayTarget(part.link.href),
			allowed: part.link.allowed === true,
		};
		if (part.link.title) span.title = part.link.title;
		if (!span.allowed && part.link.note) span.note = part.link.note;
		const rendered = span.allowed ? `[${part.text}](${markdownTarget(part.link.href)})` : part.text;
		text += rendered;
		chars += codePointLength(rendered);
		span.end = chars;
		links.push(span);
	}
	text += suffix;
	return { text, chars, links };
}

/** Only markers that would otherwise turn plain text into structure the DOM never had. */
const BLOCK_MARKER = /^([ \t]*)(#{1,6}[ \t]|[-+*][ \t]|\d{1,9}[.)][ \t]|>)/;

function escapePlainLine(line: string): string {
	const match = BLOCK_MARKER.exec(line);
	if (!match) return line;
	const indent = match[1] ?? "";
	const marker = match[2] ?? "";
	return `${indent}\\${marker}${line.slice(indent.length + marker.length)}`;
}

/** A fence longer than the longest backtick run inside the block, so the code stays one block. */
function codeFence(value: string): string {
	let longest = 0;
	for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0]?.length ?? 0);
	return "`".repeat(Math.max(3, longest + 1));
}

function cellText(chars: readonly string[], block: StructureBlock): Assembled {
	const assembled = assemble("", blockParts(block, chars));
	return { ...assembled, text: assembled.text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|") };
}

interface Boundary {
	in: number;
	out: number;
}

/**
 * Render the captured text of one format as markdown from the same capture and structure.
 * Text between blocks is copied verbatim, so nothing the scanner did not read can appear.
 * Offsets of the returned blocks are recomputed for the markdown text.
 */
export function renderMarkdown(
	text: string,
	blocks: readonly StructureBlock[],
): { text: string; blocks: StructureBlock[] } {
	const chars = Array.from(text);
	const leaves = blocks
		.filter((block) => block.type !== "frame")
		.map((block) => ({
			...block,
			start: Math.max(0, Math.min(block.start, chars.length)),
			end: Math.max(0, Math.min(block.end, chars.length)),
		}))
		.filter((block) => block.start < block.end)
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const rows = new Map<string, StructureBlock[]>();
	for (const block of leaves) {
		if (block.type !== "table" || block.table === undefined || block.row === undefined) continue;
		const key = `${block.table}:${block.row}`;
		const group = rows.get(key);
		if (group) group.push(block);
		else rows.set(key, [block]);
	}
	const emitted = new Set<StructureBlock>();
	const separators = new Set<number>();
	const output: string[] = [];
	const boundaries: Boundary[] = [{ in: 0, out: 0 }];
	const rendered = new Map<StructureBlock, StructureBlock>();
	let cursor = 0;
	let charsOut = 0;
	const push = (value: string): number => {
		if (value) {
			output.push(value);
			charsOut += codePointLength(value);
		}
		return charsOut;
	};
	// A boundary records where one input position sits in the rendered text. For a decorated block
	// that is its rendered start (the prefix included) and its rendered end, never "wherever the
	// cursor happens to be", so a container block that shares a boundary maps to the same place.
	const mark = (position: number, outPosition: number): void => {
		boundaries.push({ in: position, out: outPosition });
	};
	let index = 0;
	while (index < leaves.length) {
		const block = leaves[index]!;
		index++;
		if (emitted.has(block) || block.start < cursor) continue; // consumed inside a table row
		push(chars.slice(cursor, block.start).join(""));
		const startOut = charsOut;
		if (block.type === "table" && block.table !== undefined && block.row !== undefined) {
			const group = rows.get(`${block.table}:${block.row}`) ?? [block];
			const contiguous = group.every((cell, at) => at === 0 || cell.start >= group[at - 1]!.end);
			const separated = group.every(
				(cell, at) => at === 0 || /^\s*$/.test(chars.slice(group[at - 1]!.end, cell.start).join("")),
			);
			if (group.length > 1 && contiguous && separated) {
				push("| ");
				for (const [at, cell] of group.entries()) {
					const textOfCell = cellText(chars, cell);
					const cellStart = charsOut;
					push(textOfCell.text);
					// Both ends of a cell are exact mapping points, so a frame whose text ends at a cell
					// still maps to the right position in the rendered row.
					boundaries.push({ in: cell.start, out: cellStart }, { in: cell.end, out: charsOut });
					// Link spans are measured inside the rendered cell, so they move to where it landed.
					const cellLinks = textOfCell.links.map((link) => ({
						...link,
						start: cellStart + link.start,
						end: cellStart + link.end,
					}));
					rendered.set(cell, { ...cell, start: cellStart, end: charsOut, links: cellLinks });
					emitted.add(cell);
					push(at === group.length - 1 ? " |" : " | ");
				}
				const header = group.every((cell) => cell.header === true);
				if (header && !separators.has(block.table)) {
					push(`\n${group.map(() => "| --- ").join("")}|`);
					separators.add(block.table);
				}
				cursor = group[group.length - 1]!.end;
				mark(block.start, startOut);
				mark(cursor, charsOut);
				// The group was consumed as one row; `index` already passed this cell.
				index += group.length - 1;
				continue;
			}
		}
		const parts = blockParts(block, chars);
		let body: Assembled;
		switch (block.type) {
			case "heading": {
				const level = Math.max(1, Math.min(6, Math.round(block.level ?? 1)));
				body = assemble(`${"#".repeat(level)} `, parts);
				break;
			}
			case "list-item": {
				const depth = Math.max(1, block.depth ?? 1);
				const marker = block.ordered === true ? `${Math.max(1, Math.round(block.ordinal ?? 1))}. ` : "- ";
				body = assemble(`${"  ".repeat(depth - 1)}${marker}`, parts);
				break;
			}
			case "code": {
				const fence = codeFence(
					blockParts(block, chars)
						.map((part) => part.text)
						.join(""),
				);
				body = assemble(`${fence}\n`, parts, `\n${fence}`);
				break;
			}
			// link, paragraph, other (and any future type the renderer does not decorate yet) stay
			// plain: no prefix, no emphasis, only the minimal escape that keeps the DOM's semantics.
			default:
				body = assemble("", parts);
				body = { ...body, text: escapePlainLine(body.text) };
				break;
		}
		push(body.text);
		// Link spans are measured inside the rendered block, so they move to where the block landed.
		const movedLinks = body.links.map((link) => ({
			...link,
			start: startOut + link.start,
			end: startOut + link.end,
		}));
		rendered.set(block, { ...block, start: startOut, end: charsOut, links: movedLinks });
		emitted.add(block);
		cursor = block.end;
		mark(block.start, startOut);
		mark(cursor, charsOut);
	}
	push(chars.slice(cursor).join(""));
	mark(chars.length, charsOut);
	// Several boundaries can share one input position (a row and its first cell, a container and its
	// first block). The earliest rendered position is the one that contains the input position, so
	// the map keeps the smallest output offset per input offset and is walked in ascending order.
	const points = new Map<number, number>();
	for (const boundary of boundaries) {
		const existing = points.get(boundary.in);
		if (existing === undefined || boundary.out < existing) points.set(boundary.in, boundary.out);
	}
	const orderedPoints = [...points].map(([at, out]) => ({ in: at, out })).sort((a, b) => a.in - b.in);
	const locate = (position: number): number => {
		let found = orderedPoints[0]!;
		for (const point of orderedPoints) {
			if (point.in > position) break;
			found = point;
		}
		return found.out + Math.max(0, position - found.in);
	};
	const outBlocks: StructureBlock[] = [];
	for (const block of leaves) {
		const mapped = rendered.get(block);
		if (mapped) {
			outBlocks.push(mapped);
			continue;
		}
		outBlocks.push({ ...block, start: locate(block.start), end: locate(block.end) });
	}
	for (const block of blocks) {
		if (block.type !== "frame") continue;
		outBlocks.push({ ...block, start: locate(block.start), end: locate(block.end) });
	}
	return { text: output.join(""), blocks: outBlocks };
}
