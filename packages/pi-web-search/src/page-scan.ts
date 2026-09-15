export const MAX_CAPTURE_CHARS = 262_144;

export interface PageSample {
	url: string;
	title: string;
	text: string;
	ready: boolean;
	passwordForm: boolean;
	captureTruncated: boolean;
	revision: number;
	pending: boolean;
	busy: boolean;
	incompleteReasons: string[];
}

// Executed only in a CDP isolated world. Keep this as JavaScript source: the
// product is Node-only, and TS/Jiti function-toString output is not browser code.
// The page cannot access this world's collector; only its DOM is shared.
export const SAMPLE_PAGE = `(() => {
	const key = '__easyPiFullPageScan1';
	if (!globalThis[key]) {
		const limit = ${MAX_CAPTURE_CHARS}, maxNodes = 50000, maxRecords = 12000, maxContainers = 24;
		const regions = [], byElement = new WeakMap(), nodeIds = new WeakMap(), expanded = new WeakSet();
		const reasons = new Set();
		let revision = 0, chars = 0, records = 0, nextNode = 0, detailsCount = 0, truncated = false;
		const parent = el => el.parentElement;
		const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
		const depth = el => { let n = 0; while ((el = parent(el))) n++; return n; };
		const position = (rect, region) => {
			if (!region || region.root) return { y: rect.top + (document.scrollingElement?.scrollTop ?? 0), x: rect.left + (document.scrollingElement?.scrollLeft ?? 0) };
			const origin = region.el.getBoundingClientRect();
			return { y: rect.top - origin.top + region.el.scrollTop, x: rect.left - origin.left + region.el.scrollLeft };
		};
		const regionFor = el => { for (let node = el; node; node = parent(node)) { const r = byElement.get(node); if (r) return r; } return regions[0]; };
		const addRegion = el => {
			if (byElement.has(el)) return;
			if (regions.length >= maxContainers) { reasons.add('container_limit'); return; }
			const root = el === document.scrollingElement;
			const region = { el, root, id: regions.length, depth: depth(el), entries: new Map(), reset: el.scrollTop !== 0 || el.scrollLeft !== 0, right: true, parent: null, x: 0, y: 0, width: 0, height: 0 };
			byElement.set(el, region); regions.push(region); revision++;
			el.style.setProperty('scroll-behavior', 'auto', 'important');
			el.style.setProperty('scroll-snap-type', 'none', 'important');
		};
		const horizontalEnd = r => !r.scrollX || (r.right ? r.el.scrollLeft + r.el.clientWidth >= r.el.scrollWidth - 2 : r.el.scrollLeft <= 2);
		const atEnd = r => (!r.scrollY || r.el.scrollTop + r.el.clientHeight >= r.el.scrollHeight - 2) && horizontalEnd(r);
		const active = () => regions.filter(r => r.el.isConnected && visible(r.el));
		const identity = (el, region, segment, point) => {
			let sticky = false;
			for (let node = el; node && node !== region.el; node = parent(node)) if (/^(fixed|sticky)$/.test(getComputedStyle(node).position)) sticky = true;
			const parts = []; let anchor;
			for (let node = el; node && node !== region.el; node = parent(node)) {
				for (const name of ['data-line-num', 'data-row-key', 'data-item-id', 'data-index', 'aria-rowindex', 'aria-posinset', 'data-node-uid']) {
					const value = node.getAttribute(name);
					if (value !== null) { parts.push(name + '=' + value.slice(0, 256)); anchor ??= node; }
				}
				const record = node.getAttribute('data-record-id') ?? node.getAttribute('data-block-id');
				if (record !== null) { parts.push('record=' + record.slice(0, 256)); anchor ??= node; break; }
			}
			if (anchor) {
				const path = []; for (let node = el; node !== anchor && parent(node); node = parent(node)) path.push(Array.prototype.indexOf.call(parent(node).children, node));
				return { key: 'id:' + parts.reverse().join('/') + ':' + path.reverse().join('.') + ':' + segment, sticky };
			}
			if (sticky) { if (!nodeIds.has(el)) nodeIds.set(el, ++nextNode); return { key: 'sticky:' + nodeIds.get(el) + ':' + segment, sticky }; }
			// Logical container coordinates survive node replacement/reuse. Text is
			// deliberately NOT the key: two equal paragraphs at different positions
			// are separate content, not duplicates to discard.
			return { key: 'pos:' + Math.round(point.y * 2) + ':' + Math.round(point.x * 2) + ':' + segment, sticky };
		};
		const sample = () => {
			if (!document.body || !document.scrollingElement) return { url: location.href, title: document.title, text: '', ready: false, revision, pending: true, busy: true, passwordForm: false, captureTruncated: false, incompleteReasons: [] };
			addRegion(document.scrollingElement);
			const elements = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
			let node = document.body;
			do { elements.push(node); if (elements.length >= maxNodes) { reasons.add('node_limit'); break; } } while ((node = walker.nextNode()));
			for (const el of elements) {
				if (!visible(el)) continue;
				if (el.shadowRoot) reasons.add('shadow_dom');
				if (el.tagName === 'DETAILS' && !el.open) {
					if (expanded.has(el)) reasons.add('collapsed_content');
					else if (detailsCount >= 128) reasons.add('details_limit');
					else { el.removeAttribute('name'); el.open = true; expanded.add(el); detailsCount++; revision++; }
				}
				const style = getComputedStyle(el);
				if (el.clientHeight > 0 && el.clientWidth > 0 &&
					((/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2) || (/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2))) addRegion(el);
			}
			for (const r of active()) {
				const style = getComputedStyle(r.el);
				// scrollWidth may exceed the viewport on a deliberately hidden axis.
				// Some editors reset that axis after every scroll; it is not a scan path.
				r.scrollX = r.root ? !/hidden|clip/.test(style.overflowX) : /auto|scroll/.test(style.overflowX);
				r.scrollY = r.root ? !/hidden|clip/.test(style.overflowY) : /auto|scroll/.test(style.overflowY);
				if (!r.root) { r.parent = regionFor(parent(r.el)); Object.assign(r, position(r.el.getBoundingClientRect(), r.parent)); }
				if (r.width !== r.el.scrollWidth || r.height !== r.el.scrollHeight) { r.width = r.el.scrollWidth; r.height = r.el.scrollHeight; revision++; }
			}
			const groups = [], segments = new Map(), textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
			let current, visited = 0;
			while ((node = textWalker.nextNode())) {
				if (++visited > maxNodes) { reasons.add('node_limit'); break; }
				const br = node.nodeType === 1 && node.tagName === 'BR';
				if (node.nodeType !== 3 && !br) continue;
				const owner = node.parentElement;
				if (!owner || owner.closest('script,style,noscript,template,textarea,select') || !visible(owner)) continue;
				let el = owner;
				while (parent(el) && /^(inline|contents)$/.test(getComputedStyle(el).display)) el = parent(el);
				const pre = /pre|break-spaces/.test(getComputedStyle(el).whiteSpace);
				const value = br ? '\\n' : pre ? node.data : node.data.replace(/[\\t\\r\\n ]+/g, ' ');
				if (!value) continue;
				if (!current || current.el !== el) {
					const segment = segments.get(el) ?? 0; segments.set(el, segment + 1);
					const range = document.createRange(); range.selectNode(node);
					current = { el, segment, pre, raw: '', rect: range.getBoundingClientRect(), region: regionFor(owner) }; groups.push(current);
				}
				current.raw += value;
			}
			for (const group of groups) {
				if (!group.raw.trim() || !group.region) continue;
				let text = group.pre ? group.raw.replace(/\\r\\n?/g, '\\n') : group.raw.trim();
				const point = position(group.rect, group.region), id = identity(group.el, group.region, group.segment, point);
				const old = group.region.entries.get(id.key);
				if (!old && records >= maxRecords) { reasons.add('block_limit'); break; }
				let length = Array.from(text).length;
				const available = limit - chars + (old?.length ?? 0);
				if (length > available) { text = Array.from(text).slice(0, Math.max(0, available)).join(''); length = Array.from(text).length; truncated = true; reasons.add('capture_limit'); }
				if (old?.text !== text) revision++;
				chars += length - (old?.length ?? 0); if (!old) records++;
				group.region.entries.set(id.key, { text, length, x: id.sticky && old ? old.x : point.x, y: id.sticky && old ? old.y : point.y, order: old?.order ?? records });
				if (truncated) break;
			}
			const serialize = r => {
				const entries = [...r.entries.values()];
				for (const child of regions) if (child.parent === r) entries.push({ x: child.x, y: child.y, order: -child.id, text: serialize(child) });
				return entries.sort((a,b) => a.y - b.y || a.x - b.x || a.order - b.order).map(entry => entry.text).filter(Boolean).join('\\n');
			};
			let text = serialize(regions[0]);
			if (Array.from(text).length > limit) { text = Array.from(text).slice(0, limit).join(''); truncated = true; reasons.add('capture_limit'); }
			return { url: location.href, title: document.title.slice(0, 512), text, ready: document.readyState === 'complete', revision,
				pending: active().some(r => r.reset || !atEnd(r)), busy: elements.some(el => el.getAttribute('aria-busy') === 'true' && visible(el)),
				passwordForm: elements.some(el => el.tagName === 'INPUT' && el.type === 'password' && visible(el)),
				captureTruncated: truncated, incompleteReasons: [...reasons] };
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
	return globalThis[key].sample();
})()`;

export const ADVANCE_PAGE = "globalThis.__easyPiFullPageScan1.advance()";
