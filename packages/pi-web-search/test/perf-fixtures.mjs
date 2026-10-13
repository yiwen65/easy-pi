// Fixtures for the WF07 performance group (docs/web_fetch/WEB_FETCH_REMEDIATION_PLAN.md WF07).
// Everything here is served over loopback by the isolated browser harness; no fixture
// needs the public network, a credential or a disabled security policy.
const shell = (body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Perf fixture</title><style>
body { margin: 12px; font: 16px/20px monospace; }
p { margin: 4px 0; }
.feed { height: 240px; width: 520px; overflow: auto; position: relative; border: 1px solid; }
</style></head><body>${body}<script>${script}</script></body></html>`;

export const marker = (prefix, index) => `${prefix}_${String(index).padStart(3, "0")}_汉字😀`;
export const markers = (prefix, count) => Array.from({ length: count }, (_, index) => marker(prefix, index));

const feed = (height = 1200) => `<div class="feed"><div style="height:${height}px"></div></div>`;

// The collector's own scrolling is the only repeated page-observable side effect: it
// never scrolls before the driver has sampled the page at least once, so a mutation
// made on the first real scroll deterministically lands mid-scan. Reset scrolls (top 0)
// are ignored, the handler fires at most once, and nothing here waits on a timer.
const onFirstScroll = (body) => `
{
	const feed = document.querySelector('.feed');
	let fired = false;
	feed.addEventListener('scroll', () => {
		if (fired || feed.scrollTop <= 0) return;
		fired = true;
		${body}
	});
}`;

// Parent-side evidence that the fixture trigger really ran, even when the captured text
// is the thing under test.
const triggerMarker = (name) => `const marker = document.createElement('p');
	marker.textContent = '${name}';
	document.body.append(marker);`;

export function fixturePage(path) {
	switch (path) {
		// M01: a static page that never changes. Polled repeatedly, it must not rebuild or
		// transfer its whole text on every poll.
		case "/m01-static":
			return shell(
				`<p>M01_STATIC_START</p>${markers("M", 200)
					.map((value, index) => `<p data-record-id="m01-${index}">${value} inline content.</p>`)
					.join("")}<p>M01_STATIC_END</p>`,
			);

		// M02a: text that appears late, after a sample was already taken.
		case "/m02-late":
			return shell(
				`<p>M02_LATE_START</p>${feed()}<p>M02_LATE_TAIL</p>`,
				onFirstScroll(`const first = document.createElement('p');
		first.textContent = 'M02_LATE_ONE';
		feed.before(first);
		new MutationObserver((_records, observer) => {
			observer.disconnect();
			const second = document.createElement('p');
			second.textContent = 'M02_LATE_TWO';
			feed.before(second);
		}).observe(document.body, { childList: true });
		${triggerMarker("M02_LATE_TRIGGER_FIRED")}`),
			);

		// M02b: a font reflow that moves existing text without changing it.
		case "/m02-reflow":
			return shell(
				`<p>M02_REFLOW_START</p><p>REFLOW_ALPHA</p><div style="height:40px"></div><p>REFLOW_BETA</p><div style="height:24px"></div><p>REFLOW_GAMMA</p>${feed()}<p>M02_REFLOW_TAIL</p>`,
				onFirstScroll(`document.body.style.fontSize = '28px';
		${triggerMarker("M02_REFLOW_APPLIED")}`),
			);

		// M02c: a same-document hash route change that replaces the visible content.
		case "/m02-hash":
			return shell(
				`<p>M02_HASH_START</p><p id="m02-route1">M02_ROUTE1_TEXT</p>${feed()}<p id="m02-route2" hidden>M02_ROUTE2_TEXT</p><p>M02_HASH_TAIL</p>`,
				onFirstScroll(`location.hash = '#m02-route-2';`) +
					`
	addEventListener('hashchange', () => {
		document.getElementById('m02-route1')?.remove();
		document.getElementById('m02-route2').hidden = false;
		${triggerMarker("M02_HASH_ROUTED")}
	});`,
			);

		// M02d: a counter that keeps changing for as long as the page is open.
		case "/m02-counter":
			return shell(
				`<p>M02_COUNTER_START</p><p id="m02-counter">M02_COUNT 0</p><p>M02_COUNTER_MIDDLE</p>${feed(600)}<p>M02_COUNTER_END</p>`,
				`let count = 0;
	setInterval(() => { count++; document.getElementById('m02-counter').textContent = 'M02_COUNT ' + count; }, 150);`,
			);

		default:
			return undefined;
	}
}
