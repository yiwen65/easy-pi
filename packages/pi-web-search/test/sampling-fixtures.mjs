// Fixtures for the C01-C09 sampling regressions (docs/web_fetch/WEB_FETCH_REMEDIATION_PLAN.md 5.1).
// Everything here is served over loopback by the isolated browser harness; no
// fixture needs the public network, a credential or a disabled security policy.
export const marker = (prefix, index) => `${prefix}_${String(index).padStart(3, "0")}_汉字😀`;
export const markers = (prefix, count) => Array.from({ length: count }, (_, index) => marker(prefix, index));

const shell = (body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Sampling fixture</title><style>
body { margin: 12px; font: 16px/20px monospace; } p { margin: 4px 0; }
.feed { height: 240px; width: 520px; overflow: auto; position: relative; border: 1px solid; }
.row { margin: 0; white-space: pre-wrap; }
.virtual .row { position: absolute; left: 0; width: 500px; }
</style></head><body>${body}<script>${script}</script></body></html>`;

// The isolated-world collector has two page-observable side effects on a sampling
// pass: it expands <details> elements and it marks every registered scroll
// container with inline scroll-behavior/scroll-snap styles. Either one proves that
// a pass already ran, so a fixture can mutate the DOM deterministically instead of
// guessing with a timer. `applied` keeps the mutation single-shot.
const armOnce = (mutate) => `
const trigger = document.getElementById('sample-trigger');
let applied = false;
function apply() {
	if (applied) return;
	applied = true;
	${mutate}
	const marker = document.createElement('p');
	marker.id = 'phase-applied';
	marker.textContent = 'PHASE_APPLIED';
	document.body.append(marker);
}
trigger.addEventListener('toggle', apply);
for (const feed of document.querySelectorAll('.feed'))
	new MutationObserver(apply).observe(feed, { attributes: true, attributeFilter: ['style'] });
`;

// C05: recycled absolutely-positioned slots that carry an explicit logical key.
// The key, not the node and not the pixels, defines the item identity.
const keyedVirtualList = (prefix, count) => `
<p>${prefix}_START</p>
<div class="feed virtual" id="feed"><div id="pad" style="height:${count * 48}px"></div><div id="rows"></div></div>
<p>${prefix}_END</p>
<script>
const feed = document.getElementById('feed'), rows = document.getElementById('rows'), count = ${count};
const slots = Array.from({ length: 8 }, () => Object.assign(document.createElement('div'), { className: 'row' }));
function render() {
	const start = Math.max(0, Math.min(count - 8, Math.floor(feed.scrollTop / 48)));
	for (let slot = 0; slot < 8; slot++) {
		const index = start + slot, el = slots[slot];
		if (index >= count) { el.remove(); continue; }
		el.dataset.lineNum = String(index);
		el.style.top = (index * 48) + 'px';
		el.textContent = '${prefix}_' + String(index).padStart(3, '0') + '_汉字😀\\nLEGAL_REPEAT';
		rows.append(el);
	}
}
feed.addEventListener('scroll', render);
render();
</script>`;

// C06: recycled slots with per-item dynamic heights and no logical key. Node
// identity alone would overwrite several items into one, so a safe implementation
// must keep the observed items and disclose that the container's identity is
// ambiguous.
const unkeyedVirtualList = (prefix, count) => `
<p>${prefix}_START</p>
<div class="feed virtual" id="feed"><div id="pad"></div><div id="rows"></div></div>
<p>${prefix}_END</p>
<script>
const feed = document.getElementById('feed'), pad = document.getElementById('pad'), rows = document.getElementById('rows');
const count = ${count}, height = index => 32 + (index % 5) * 13;
const offsets = [];
let total = 0;
for (let index = 0; index < count; index++) { offsets.push(total); total += height(index) + 8; }
pad.style.height = total + 'px';
const slots = Array.from({ length: 6 }, () => Object.assign(document.createElement('div'), { className: 'row' }));
function render() {
	const start = Math.max(0, Math.min(count - slots.length, Math.floor(feed.scrollTop / 60)));
	for (let slot = 0; slot < slots.length; slot++) {
		const index = start + slot, el = slots[slot];
		if (index >= count) { el.remove(); continue; }
		el.style.top = offsets[index] + 'px';
		el.style.height = height(index) + 'px';
		el.textContent = '${prefix}_' + String(index).padStart(3, '0') + '_汉字😀';
		rows.append(el);
	}
}
feed.addEventListener('scroll', render);
render();
</script>`;

export function fixturePage(path) {
	switch (path) {
		case "/c01":
			return shell(
				`<p>C01_TOP</p><div id="spacer" style="height:20px"></div><p>ALPHA</p><p>BETA</p><p>C01_TAIL</p><details id="sample-trigger"><summary>arm</summary><p>C01_ARMED</p></details>`,
				armOnce("document.getElementById('spacer').style.height = '157px';"),
			);
		case "/c02":
			return shell("<p>REPEAT_ME</p><div style=\"height:40px\"></div><p>REPEAT_ME</p><p>C02_END</p>");
		case "/c03":
			return shell(
				`<p id="target">OLD_VALUE</p><p>C03_TAIL</p><details id="sample-trigger"><summary>arm</summary><p>C03_ARMED</p></details>`,
				armOnce("document.getElementById('target').textContent = 'NEW_VALUE';"),
			);
		case "/c04":
			return shell(
				`<p>C04_BEFORE_1</p><p>C04_BEFORE_2</p><p id="target">DELETE_ME</p><p>C04_AFTER_1</p><p>C04_AFTER_2</p><p>C04_AFTER_3</p><p>C04_TAIL</p><details id="sample-trigger"><summary>arm</summary><p>C04_ARMED</p></details>`,
				armOnce("document.getElementById('target').remove();"),
			);
		case "/c05":
			return shell(keyedVirtualList("V", 36));
		case "/c06":
			return shell(unkeyedVirtualList("M", 24));
		case "/c07":
			return shell(
				`<div id="contents" style="display:contents">CONTENTS_DIRECT_TEXT <span>nested <b>inline</b> tail</span></div><p>AFTER_CONTENTS</p><pre id="pre">PRE_LINE_1
PRE_LINE_2
  PRE_INDENT</pre><p>C07_END</p>`,
			);
		case "/c08":
			return shell(
				`<p>VISIBLE_MAIN</p><div style="opacity:0"><p>HIDDEN_OPACITY_TEXT</p></div><div style="display:none"><p>HIDDEN_DISPLAY_TEXT</p></div><div style="visibility:hidden"><p style="visibility:visible">VISIBLE_OVERRIDE_TEXT</p></div><div style="height:2400px"></div><p>BELOW_FOLD_TEXT</p><p>C08_END</p>`,
			);
		case "/c09":
			return shell(
				`<div class="virtual" style="position:relative;height:200px"><div id="dup-a" data-row-key="dup-1" style="position:absolute;top:0;left:0">DUP_SAME</div><div id="dup-b" data-row-key="dup-1" style="position:absolute;top:0;left:0">DUP_SAME</div><div id="dup-c" data-row-key="dup-1" style="position:absolute;top:80px;left:0">DUP_SAME</div></div><p id="c09-tail">C09_TAIL</p><details id="sample-trigger"><summary>arm</summary><p>EXPANDED_ONE</p></details><p>C09_END</p>`,
				armOnce("document.body.style.fontSize = '28px';"),
			);
		case "/c09-thrash":
			return shell(
				`<div class="virtual" style="position:relative;height:200px"><div data-row-key="dup-1" style="position:absolute;top:0;left:0">DUP_A</div><div data-row-key="dup-1" style="position:absolute;top:40px;left:0">DUP_B</div><div data-row-key="dup-1" style="position:absolute;top:80px;left:0">DUP_C</div></div><p>C09B_BETWEEN</p><details id="sample-trigger"><summary>arm</summary><p>EXPANDED_ONE</p></details><p>C09B_END</p>`,
				armOnce(""),
			);
		default:
			return undefined;
	}
}
