import type { StructureBlock } from "./content-format.ts";
import { MAX_FRAME_BLOCKS, MAX_FRAME_LINKS, STRUCTURE_TRUNCATED } from "./content-format.ts";

export const MAX_CAPTURE_CHARS = 262_144;

export interface PageSample {
	url: string;
	title: string;
	text: string;
	ready: boolean;
	passwordForm: boolean;
	captureTruncated: boolean;
	/** Content revision: the value stays stable while the captured text stays stable. */
	revision: number;
	contentRevision: number;
	layoutRevision: number;
	pending: boolean;
	busy: boolean;
	incompleteReasons: string[];
	/**
	 * Disclosures that do not make the capture incomplete, e.g. `identity_ambiguous`
	 * for a recycling container whose items carry no logical key. They are kept out of
	 * `incompleteReasons` so a legitimate position-keyed virtual list still completes.
	 */
	ambiguities: string[];
	/**
	 * WF08 structure of exactly this sample's `text`: code point offsets into `text`, the same
	 * offsets pagination uses. Bounded per frame; a budget overflow only adds the
	 * `structure_truncated` caveat and never changes the text or the coverage status.
	 */
	structure?: StructureBlock[];
}

/**
 * Collector answer. `serialized` is true when this pass rebuilt the full text, and
 * `unchanged` means the rebuilt text is byte-identical to the last one, so `text` may
 * be empty and the driver must keep the copy it already holds (WF07 sampling path).
 */
export interface PageProbe extends PageSample {
	unchanged: boolean;
	serialized: boolean;
}

// Executed only in a CDP isolated world. Keep this as JavaScript source: the
// product is Node-only, and TS/Jiti function-toString output is not browser code.
// The page cannot access this world's collector; only its DOM is shared.
export const SAMPLE_PAGE = `(() => {
	const key = '__easyPiFullPageScan1';
	if (!globalThis[key]) {
		const limit = ${MAX_CAPTURE_CHARS}, maxNodes = 50000, maxRecords = 12000, maxContainers = 24, maxRetained = 2000,
			maxBlocks = ${MAX_FRAME_BLOCKS}, maxLinks = ${MAX_FRAME_LINKS}, maxGroupLinks = 64;
		const keyAttrs = ['data-line-num', 'data-row-key', 'data-item-id', 'data-index', 'aria-rowindex', 'aria-posinset', 'data-node-uid'];
		const regions = [], byElement = new WeakMap(), nodeIds = new WeakMap(), expanded = new WeakSet(), tableIds = new WeakMap();
		const reasons = new Set(), ambiguities = new Set();
		let contentRevision = 0, layoutRevision = 0, chars = 0, records = 0, nextNode = 0, nextRegion = 0, detailsCount = 0, truncated = false, sampleNo = 0;
		// WF08 structure budget: counts are per collector (one frame) and per sample. Exceeding a
		// budget only stops collecting structure; the text and its coverage status stay untouched.
		let structuredBlocks = 0, structureLinks = 0, tableSeq = 0;
		// The text is only rebuilt when every input the serialization reads changed. The
		// digest covers exactly those inputs, so an equal digest proves the same bytes.
		let lastDigest = null, serialized = false;
		// One pass must not resolve the same computed style or layout box twice.
		let styles = new WeakMap(), rects = new WeakMap();
		const parent = el => el.parentElement;
		const rule = el => { let style = styles.get(el); if (style === undefined) { style = getComputedStyle(el); styles.set(el, style); } return style; };
		const rectOf = el => { let rect = rects.get(el); if (rect === undefined) { rect = el.getBoundingClientRect(); rects.set(el, rect); } return rect; };
		const depth = el => { let n = 0; while ((el = parent(el))) n++; return n; };
		const boxed = el => el.getClientRects().length > 0 && rule(el).visibility !== 'hidden';
		const position = (rect, region) => {
			if (!region || region.root) return { y: rect.top + (document.scrollingElement?.scrollTop ?? 0), x: rect.left + (document.scrollingElement?.scrollLeft ?? 0) };
			const origin = rectOf(region.el);
			return { y: rect.top - origin.top + region.el.scrollTop, x: rect.left - origin.left + region.el.scrollLeft };
		};
		const regionFor = el => { for (let node = el; node; node = parent(node)) { const r = byElement.get(node); if (r) return r; } return regions[0]; };
		const addRegion = el => {
			if (byElement.has(el)) return;
			if (regions.length >= maxContainers) { reasons.add('container_limit'); return; }
			const root = el === document.scrollingElement;
			const region = { el, root, id: ++nextRegion, depth: depth(el), entries: new Map(), retained: 0, reset: el.scrollTop !== 0 || el.scrollLeft !== 0, right: true, parent: null, x: 0, y: 0, width: 0, height: 0, overflowX: false, overflowY: false, scrollX: true, scrollY: true, virtual: false };
			byElement.set(el, region); regions.push(region); layoutRevision++;
			el.style.setProperty('scroll-behavior', 'auto', 'important');
			el.style.setProperty('scroll-snap-type', 'none', 'important');
		};
		const horizontalEnd = r => !r.scrollX || (r.right ? r.el.scrollLeft + r.el.clientWidth >= r.el.scrollWidth - 2 : r.el.scrollLeft <= 2);
		const atEnd = r => (!r.scrollY || r.el.scrollTop + r.el.clientHeight >= r.el.scrollHeight - 2) && horizontalEnd(r);
		const active = () => regions.filter(r => r.el.isConnected && boxed(r.el));
		const median = list => { if (!list.length) return 0; const sorted = list.slice().sort((a, b) => a - b); return sorted[sorted.length >> 1]; };
		const cpLen = value => { let pairs = 0; for (let at = 0; at < value.length; at++) { const code = value.charCodeAt(at); if (code >= 0xd800 && code <= 0xdbff && at + 1 < value.length) { const next = value.charCodeAt(at + 1); if (next >= 0xdc00 && next <= 0xdfff) { pairs++; at++; } } } return value.length - pairs; };
		const bounded = (value, max) => (typeof value === 'string' && value.length > max ? value.slice(0, max) : typeof value === 'string' ? value : '');
		const listInfo = li => {
			let depth = 0, ordered = false, ordinal = 1;
			for (let node = parent(li); node; node = parent(node)) {
				const tag = node.tagName;
				if (tag !== 'UL' && tag !== 'OL') continue;
				depth++;
				if (depth > 1) continue;
				ordered = tag === 'OL';
				let index = 1;
				for (let sibling = li.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === 'LI') index++;
				const value = Number(li.getAttribute('value')), start = Number(node.getAttribute('start'));
				ordinal = Number.isInteger(value) && value > 0 ? value : Number.isInteger(start) && start > 0 ? start + index - 1 : index;
			}
			return { depth: Math.max(1, depth), ordered, ordinal: Math.max(1, ordinal) };
		};
		const tableInfo = cell => {
			let row = parent(cell);
			while (row && row.tagName !== 'TR') row = parent(row);
			if (!row) return null;
			let table = parent(row);
			while (table && table.tagName !== 'TABLE') table = parent(table);
			if (!table) return null;
			let index = tableIds.get(table);
			if (index === undefined) { index = ++tableSeq; tableIds.set(table, index); }
			// rowIndex/cellIndex are the browser's own view of the row/cell relationship.
			return { table: index, row: Math.max(0, row.rowIndex || 0), cell: Math.max(0, cell.cellIndex || 0), header: cell.tagName === 'TH' || !!cell.closest('thead') };
		};
		// Nearest ancestor of each kind wins; kinds are then ranked so a table cell or a heading is
		// never demoted by an inline wrapper that happens to sit between it and the text.
		const kindOf = (el, region) => {
			const chain = [];
			for (let node = el; node && node !== region.el; node = parent(node)) chain.push(node);
			const info = { type: 'other', level: 0, ordered: false, depth: 0, ordinal: 0, header: false, table: 0, row: 0, cell: 0 };
			for (const node of chain) { const tag = node.tagName; if (tag === 'TD' || tag === 'TH') { const cell = tableInfo(node); if (!cell) continue; info.type = 'table'; info.table = cell.table; info.row = cell.row; info.cell = cell.cell; info.header = cell.header; return info; } }
			for (const node of chain) { const tag = node.tagName; if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') { info.type = 'heading'; info.level = Number(tag.charAt(1)); return info; } }
			for (const node of chain) { const tag = node.tagName; if (tag === 'PRE' || tag === 'CODE') { info.type = 'code'; return info; } }
			for (const node of chain) { if (node.tagName === 'LI') { const list = listInfo(node); info.type = 'list-item'; info.ordered = list.ordered; info.depth = list.depth; info.ordinal = list.ordinal; return info; } }
			for (const node of chain) { if (node.tagName === 'A' && node.getAttribute('href') !== null) { info.type = 'link'; return info; } }
			for (const node of chain) { if (node.tagName === 'P') { info.type = 'paragraph'; return info; } }
			return info;
		};
		const empty = () => ({ url: location.href, title: document.title, text: '', ready: false, revision: contentRevision, contentRevision, layoutRevision, pending: true, busy: true, passwordForm: false, captureTruncated: false, incompleteReasons: [], ambiguities: [], structure: [], unchanged: false, serialized: false });
		const sample = full => {
			sampleNo++;
			styles = new WeakMap(); rects = new WeakMap();
			if (!document.body || !document.scrollingElement) return empty();
			addRegion(document.scrollingElement);
			// Every DOM write of this sample (details expansion, registered container styles)
			// happens before the geometry and text measurements below.
			const elements = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
			let node = document.body;
			do { elements.push(node); if (elements.length >= maxNodes) { reasons.add('node_limit'); break; } } while ((node = walker.nextNode()));
			const containers = [], expand = [];
			for (const el of elements) {
				const shown = boxed(el);
				if (el.shadowRoot && shown) reasons.add('shadow_dom');
				if (!shown) continue;
				if (el.tagName === 'DETAILS' && !el.open) {
					if (expanded.has(el)) reasons.add('collapsed_content');
					else if (detailsCount >= 128) reasons.add('details_limit');
					else { expanded.add(el); detailsCount++; expand.push(el); }
				}
				const style = rule(el);
				if (el.clientHeight > 0 && el.clientWidth > 0 &&
					((/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2) || (/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2))) containers.push(el);
			}
			for (const el of expand) { el.removeAttribute('name'); el.open = true; contentRevision++; }
			for (const el of containers) addRegion(el);
			for (const r of active()) {
				const style = rule(r.el);
				// scrollWidth may exceed the viewport on a deliberately hidden axis.
				// Some editors reset that axis after every scroll; it is not a scan path.
				r.scrollX = r.root ? !/hidden|clip/.test(style.overflowX) : /auto|scroll/.test(style.overflowX);
				r.scrollY = r.root ? !/hidden|clip/.test(style.overflowY) : /auto|scroll/.test(style.overflowY);
				r.overflowX = r.el.scrollWidth > r.el.clientWidth + 2;
				r.overflowY = r.el.scrollHeight > r.el.clientHeight + 2;
				if (!r.root) { r.parent = regionFor(parent(r.el)); Object.assign(r, position(rectOf(r.el), r.parent)); }
				if (r.width !== r.el.scrollWidth || r.height !== r.el.scrollHeight) { r.width = r.el.scrollWidth; r.height = r.el.scrollHeight; layoutRevision++; }
			}
			const isHidden = el => {
				for (let node = el; node; node = parent(node)) {
					const style = rule(node);
					// display:none, opacity:0 and content-visibility:hidden cannot be re-enabled
					// by a descendant, unlike visibility.
					if (style.display === 'none' || style.opacity === '0' || style.getPropertyValue('content-visibility') === 'hidden') return true;
				}
				return false;
			};
			const groups = [], segments = new Map();
			let current, visited = 0;
			const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
			while ((node = textWalker.nextNode())) {
				if (++visited > maxNodes) { reasons.add('node_limit'); break; }
				const br = node.nodeType === 1 && node.tagName === 'BR';
				if (node.nodeType !== 3 && !br) continue;
				const owner = node.parentElement;
				if (!owner || owner.closest('script,style,noscript,template,textarea,select') || isHidden(owner)) continue;
				const ownerStyle = rule(owner);
				// visibility is inherited but re-enableable, so only the text owner decides.
				if (ownerStyle.visibility === 'hidden' || ownerStyle.visibility === 'collapse') continue;
				const range = document.createRange();
				range.selectNode(node);
				// A range measures laid-out text even when its owner has no box (display:contents).
				if (!range.getClientRects().length) continue;
				let el = owner;
				while (parent(el) && /^(inline|contents)$/.test(rule(el).display)) el = parent(el);
				const pre = /pre|break-spaces/.test(rule(el).whiteSpace);
				const value = br ? '\\n' : pre ? node.data : node.data.replace(/[\\t\\r\\n ]+/g, ' ');
				if (!value) continue;
				if (!current || current.el !== el) {
					const segment = segments.get(el) ?? 0; segments.set(el, segment + 1);
					const style = rule(el);
					current = { el, segment, pre, raw: '', rect: range.getBoundingClientRect(), region: regionFor(owner), positioned: /^(absolute|fixed)$/.test(style.position) || style.transform !== 'none', kind: null, links: null, cp: 0 };
					groups.push(current);
				}
				current.raw += value;
				// Link targets are read from the DOM only (document.baseURI already applied); nothing
				// here resolves, requests or navigates. A bounded number of anchors is recorded per block.
				const length = cpLen(value);
				const anchor = owner.closest('a[href]');
				if (anchor) {
					const existing = current.links ? current.links.get(anchor) : undefined;
					if (existing) existing.end = current.cp + length;
					else if (structureLinks >= maxLinks || (current.links && current.links.size >= maxGroupLinks)) ambiguities.add('${STRUCTURE_TRUNCATED}');
					else {
						if (!current.links) current.links = new Map();
						current.links.set(anchor, { href: bounded(anchor.href, 2048), title: bounded(anchor.getAttribute('title'), 256), start: current.cp, end: current.cp + length });
						structureLinks++;
					}
				}
				current.cp += length;
			}
			// A container that recycles absolutely positioned children cannot be told apart
			// from one that deletes them by its DOM children alone, so the implied item count
			// decides whether container-relative positions are a safe fallback identity.
			const shapes = new Map();
			for (const r of regions) shapes.set(r, { count: 0, heights: [], widths: [] });
			for (const group of groups) {
				if (!group.positioned) continue;
				const shape = shapes.get(group.region);
				if (!shape) continue;
				shape.count++;
				if (group.rect.height > 0) shape.heights.push(group.rect.height);
				if (group.rect.width > 0) shape.widths.push(group.rect.width);
			}
			for (const r of regions) {
				const shape = shapes.get(r), height = median(shape.heights), width = median(shape.widths);
				const rows = r.overflowY && height ? Math.max(1, Math.round(r.height / height)) : 1;
				const cols = r.overflowX && width ? Math.max(1, Math.round(r.width / width)) : 1;
				r.virtual = shape.count >= 2 && rows * cols >= Math.max(8, shape.count * 2);
			}
			const keyCounts = new Map();
			const identity = (group, point) => {
				const el = group.el, region = group.region, segment = group.segment;
				let sticky = false;
				for (let node = el; node && node !== region.el; node = parent(node)) if (/^(fixed|sticky)$/.test(rule(node).position)) sticky = true;
				const parts = []; let anchor;
				for (let node = el; node && node !== region.el; node = parent(node)) {
					for (const name of keyAttrs) {
						const value = node.getAttribute(name);
						if (value !== null) { parts.push(name + '=' + value.slice(0, 256)); anchor ??= node; }
					}
					const record = node.getAttribute('data-record-id') ?? node.getAttribute('data-block-id');
					if (record !== null) { parts.push('record=' + record.slice(0, 256)); anchor ??= node; break; }
				}
				if (anchor) {
					const path = []; for (let node = el; node !== anchor && parent(node); node = parent(node)) path.push(Array.prototype.indexOf.call(parent(node).children, node));
					const base = 'id:' + parts.reverse().join('/') + ':' + path.reverse().join('.') + ':' + segment;
					// Page ids are not unique by contract: identical key strings stay separate
					// blocks, disambiguated by their document-order ordinal, which is stable for
					// a stable document instead of alternating with the sample.
					const ordinal = keyCounts.get(base) ?? 0;
					keyCounts.set(base, ordinal + 1);
					return { key: ordinal ? base + '#' + ordinal : base, kind: 'key', sticky };
				}
				if (region.virtual && group.positioned) {
					// The page recycles these nodes for different items, so node identity would
					// overwrite several items into one. Container-relative position is retained
					// while the container exists, and the reuse itself is disclosed.
					ambiguities.add('identity_ambiguous');
					return { key: 'vpos:' + Math.round(point.y * 2) + ':' + Math.round(point.x * 2) + ':' + segment, kind: 'vpos', sticky };
				}
				if (!nodeIds.has(el)) nodeIds.set(el, ++nextNode);
				return { key: 'node:' + region.id + ':' + (sticky ? 'sticky:' : '') + nodeIds.get(el) + ':' + segment, kind: 'node', sticky };
			};
			// Map one block's anchor spans from raw offsets onto the trimmed/pre-normalized block text.
			const linkSpans = (group, textLength) => {
				const spans = group.links ? [...group.links.values()] : [];
				if (!spans.length) return undefined;
				let lead = 0;
				if (!group.pre) {
					let at = 0;
					while (at < group.raw.length) { const code = group.raw.codePointAt(at); const char = String.fromCodePoint(code); if (!/\\s/.test(char)) break; lead++; at += char.length; }
				}
				const boundaries = [...new Set(spans.flatMap(span => [span.start, span.end]))].sort((a, b) => a - b);
				// '\\r\\n' collapses to one character in pre text, so raw offsets shift by the pairs before them.
				const dropped = new Map();
				let rawCp = 0, at = 0, removed = 0;
				for (const boundary of boundaries) {
					while (rawCp < boundary && at < group.raw.length) {
						const code = group.raw.codePointAt(at);
						if (code === 13 && group.raw.charCodeAt(at + 1) === 10) removed++;
						at += code > 0xffff ? 2 : 1;
						rawCp++;
					}
					dropped.set(boundary, removed);
				}
				const clamp = value => Math.max(0, Math.min(value - (dropped.get(value) ?? removed) - lead, textLength));
				const mapped = [];
				for (const span of spans) {
					const start = clamp(span.start), end = clamp(span.end);
					if (end <= start) continue;
					const link = { start, end, href: span.href };
					if (span.title) link.title = span.title;
					mapped.push(link);
				}
				return mapped.length ? mapped : undefined;
			};
			const groupStructure = (group, textLength) => {
				const kind = group.kind ?? (group.kind = kindOf(group.el, group.region));
				// Offsets are relative to this block's own text; the serializer shifts them into the text
				// of the frame, so a block always covers exactly the text of its entry.
				const block = { type: kind.type, start: 0, end: textLength };
				if (kind.type === 'heading') block.level = kind.level;
				else if (kind.type === 'list-item') { block.ordered = kind.ordered; block.depth = kind.depth; block.ordinal = kind.ordinal; }
				else if (kind.type === 'table') { block.table = kind.table; block.row = kind.row; block.cell = kind.cell; block.header = kind.header; }
				const links = linkSpans(group, textLength);
				if (links) block.links = links;
				return block;
			};
			let complete = true;
			for (const group of groups) {
				if (!group.raw.trim() || !group.region) continue;
				let text = group.pre ? group.raw.replace(/\\r\\n?/g, '\\n') : group.raw.trim();
				const point = position(group.rect, group.region);
				const id = identity(group, point);
				const entries = group.region.entries;
				const previous = entries.get(id.key);
				if (!previous && records >= maxRecords) { reasons.add('block_limit'); complete = false; break; }
				if (!previous && id.kind === 'vpos' && group.region.retained >= maxRetained) { reasons.add('block_limit'); complete = false; break; }
				let length = Array.from(text).length;
				const available = limit - chars + (previous?.length ?? 0);
				if (length > available) { text = Array.from(text).slice(0, Math.max(0, available)).join(''); length = Array.from(text).length; truncated = true; reasons.add('capture_limit'); }
				if (!previous) { contentRevision++; chars += length; records++; if (id.kind === 'vpos') group.region.retained++; }
				else {
					if (previous.text !== text) { contentRevision++; chars += length - previous.length; }
					if (Math.abs(previous.x - point.x) > 0.5 || Math.abs(previous.y - point.y) > 0.5) layoutRevision++;
				}
				// Structure is additive and bounded per frame: once the budget is spent, the remaining
				// blocks keep their text but carry no structure, and that is disclosed as a caveat.
				let structure = previous?.structure;
				if (structure) structure = groupStructure(group, length);
				else if (structuredBlocks < maxBlocks) { structure = groupStructure(group, length); structuredBlocks++; }
				else ambiguities.add('${STRUCTURE_TRUNCATED}');
				entries.set(id.key, { text, length, x: id.sticky && previous ? previous.x : point.x, y: id.sticky && previous ? previous.y : point.y, order: previous?.order ?? records, kind: id.kind, seen: sampleNo, structure });
				if (truncated) { complete = false; break; }
			}
			if (complete) {
				// A removed or hidden block disappears; a retained logical key (explicit key or
				// container-relative position) survives recycling while its container exists.
				for (const r of regions) {
					if (!r.el.isConnected) {
						for (const entry of r.entries.values()) { chars -= entry.length; records--; if (entry.kind === 'vpos') r.retained--; }
						r.entries.clear();
						continue;
					}
					for (const [id, entry] of r.entries) {
						if (entry.kind !== 'node' || entry.seen === sampleNo) continue;
						chars -= entry.length; records--; r.entries.delete(id); contentRevision++;
					}
				}
			}
			// Text and structure are built in one pass, so block offsets are the code point offsets of
			// exactly the text that pagination slices. Ordering and separators are unchanged.
			const serialize = r => {
				const items = [...r.entries.values()].map(entry => ({ x: entry.x, y: entry.y, order: entry.order, text: entry.text, chars: entry.length, blocks: entry.structure ? [entry.structure] : [] }));
				for (const child of regions) if (child.parent === r) { const inner = serialize(child); items.push({ x: child.x, y: child.y, order: -child.id, text: inner.text, chars: inner.chars, blocks: inner.blocks }); }
				const list = items.sort((a, b) => a.y - b.y || a.x - b.x || a.order - b.order).filter(item => item.text);
				let text = '', chars = 0;
				const blocks = [];
				for (const item of list) {
					if (text) { text += '\\n'; chars++; }
					const start = chars;
					text += item.text;
					chars += item.chars;
					// A scroll container contributes its own nested text as one item, so its blocks move
					// with it; a plain entry contributes the single block it carries.
					for (const inner of item.blocks) {
						const block = { ...inner, start: start + inner.start, end: start + inner.end };
						if (inner.links) block.links = inner.links.map(link => ({ ...link, start: start + link.start, end: start + link.end }));
						blocks.push(block);
					}
				}
				return { text, chars, blocks };
			};
			// Digest of every value the serialization reads, so an unchanged fingerprint
			// proves the text is byte-identical without joining or sorting it again.
			const fingerprint = () => {
				let h1 = 0x811c9dc5, h2 = 0x01000193;
				const fold = value => {
					if (typeof value !== 'string') value = ':' + value + ':';
					for (let at = 0; at < value.length; at++) {
						const code = value.charCodeAt(at);
						h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
						h2 = Math.imul(h2 + code, 2246822519) >>> 0;
						h2 = (h2 ^ (h2 >>> 15)) >>> 0;
					}
				};
				const visit = region => {
					fold(region.id); fold(region.parent ? region.parent.id : 0); fold(region.x); fold(region.y);
					for (const entry of region.entries.values()) {
						fold(entry.text); fold(entry.x); fold(entry.y); fold(entry.order); fold(entry.kind);
						// Structure is part of the fingerprint: a heading level or a link target can change
						// while the visible text stays identical.
						const block = entry.structure;
						if (block) {
							fold(block.type); fold(block.level ?? 0); fold(block.ordered ? 1 : 0); fold(block.depth ?? 0); fold(block.ordinal ?? 0);
							fold(block.header ? 1 : 0); fold(block.table ?? 0); fold(block.row ?? 0); fold(block.cell ?? 0);
							if (block.links) for (const link of block.links) { fold(link.href); fold(link.title ?? ''); fold(link.start); fold(link.end); }
						}
					}
					for (const child of regions) if (child.parent === region) { fold(child.id); fold(child.x); fold(child.y); visit(child); }
				};
				visit(regions[0]);
				return h1 + ':' + h2;
			};
			const fingerprinted = fingerprint();
			serialized = full || fingerprinted !== lastDigest;
			let text = '', structure = [];
			if (serialized) {
				const built = serialize(regions[0]);
				text = built.text;
				if (built.chars > limit) { text = Array.from(text).slice(0, limit).join(''); truncated = true; reasons.add('capture_limit'); }
				const textLength = cpLen(text);
				for (const block of built.blocks) {
					const start = Math.min(block.start, textLength), end = Math.min(block.end, textLength);
					if (end <= start) continue;
					structure.push(start === block.start && end === block.end ? block : { ...block, start, end });
				}
				lastDigest = fingerprinted;
			}
			return { url: location.href, title: document.title.slice(0, 512), text: serialized ? text : '', ready: document.readyState === 'complete', revision: contentRevision, contentRevision, layoutRevision,
				pending: active().some(r => r.reset || !atEnd(r)), busy: elements.some(el => el.getAttribute('aria-busy') === 'true' && boxed(el)),
				passwordForm: elements.some(el => el.tagName === 'INPUT' && el.type === 'password' && boxed(el)),
				captureTruncated: truncated, incompleteReasons: [...reasons], ambiguities: [...ambiguities], structure: serialized ? structure : [], unchanged: !serialized, serialized };
		};
		const advance = () => {
			const list = active().sort((a,b) => b.depth - a.depth || a.id - b.id);
			for (const r of list) {
				if (!r.reset && atEnd(r)) continue;
				const el = r.el, top = el.scrollTop, left = el.scrollLeft;
				if (r.reset) { r.reset = false; r.right = true; el.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }
				else if (!horizontalEnd(r)) el.scrollTo({ top, left: left + (r.right ? 1 : -1) * Math.max(1, el.clientWidth * 0.7), behavior: 'instant' });
				else { r.right = !r.right; el.scrollTo({ top: top + Math.max(1, el.clientHeight * 0.7), left, behavior: 'instant' }); }
				if (el.scrollTop !== top || el.scrollLeft !== left) return { moved: true };
				if (!atEnd(r)) { reasons.add('scroll_stalled'); return { moved: false, stalled: true }; }
			}
			return { moved: false };
		};
		globalThis[key] = { sample, advance };
	}
	return globalThis[key].sample(true);
})()`;

/** Status-only answer: no text is rebuilt while the collector's own fingerprint is unchanged. */
export const LIGHT_SAMPLE_PAGE = "globalThis.__easyPiFullPageScan1.sample(false)";

export const ADVANCE_PAGE = "globalThis.__easyPiFullPageScan1.advance()";
