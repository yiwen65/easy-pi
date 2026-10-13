// Fixtures for the WF01 frame/lifecycle regression group (F01-F05).
// Every page is served from the loopback fixture server; hosts that are not
// registered in the child file resolve to a blocked address on purpose, so the
// real public-network guard runs for the "visible rejected frame" case.
const shell = (body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Frame fixture</title><style>
body { margin: 12px; font: 16px/20px monospace; }
p { margin: 4px 0; }
iframe { display: block; width: 90%; height: 220px; border: 0; }
.feed { height: 240px; width: 520px; overflow: auto; position: relative; border: 1px solid; scroll-behavior: smooth; }
</style></head><body>${body}<script>${script}</script></body></html>`;

const feed = (height = 1200) => `<div class="feed"><div style="height:${height}px"></div></div>`;

// The scanner is the only thing that scrolls the page, so the first real scroll
// of `.feed` proves that the collector already finished a read pass: scrolling
// happens only after the parent observed its children. Reset scrolls (top 0) are
// ignored, and the handler fires at most once.
const onFirstScroll = (body) => `{
	const feed = document.querySelector('.feed');
	let fired = false;
	feed.addEventListener('scroll', () => {
		if (fired || feed.scrollTop <= 0) return;
		fired = true;
		${body}
	});
}`;

// Parent-side marker so a test can prove the page-side trigger really ran, even
// when the defect under test is that the frame's captured text never updates.
const triggerMarker = (name) => `const marker = document.createElement('p');
	marker.textContent = '${name}';
	document.body.append(marker);`;

const runawayContainers = Array.from(
	{ length: 26 },
	(_, index) => `<div style="height:40px;overflow:auto"><div style="height:200px">RUNAWAY_EXTRA_${index}</div></div>`,
).join("");

let f04StatusRequests = 0;

export function fixturePage(path) {
	switch (path) {
		// F01: a frame that exhausts its own budget must not stop its siblings or
		// the rest of the main document.
		case "/f01-main":
			return shell(
				`<p>F01_MAIN_START</p><iframe src="/f01-runaway"></iframe><iframe src="/f01-sibling"></iframe>` +
					`<p>MAIN_TAIL_ONE</p><p>MAIN_TAIL_TWO</p><p>MAIN_TAIL_THREE</p><p>F01_MAIN_END</p>`,
			);
		case "/f01-runaway":
			return shell(
				`<p>RUNAWAY_START</p><div class="feed" id="feed"></div>${runawayContainers}`,
				`
	const feed = document.querySelector('#feed');
	let count = 0;
	function append() { for (let end = count + 8; count < end; count++) { const row = document.createElement('p'); row.textContent = 'RUNAWAY_ITEM ' + count; feed.append(row); } }
	feed.addEventListener('scroll', () => { if (feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 5) append(); });
	append();
`,
			);
		case "/f01-sibling":
			return shell("<p>SIBLING_ALPHA</p><p>SIBLING_BETA</p>");

		// F02: a completed frame whose DOM changes later, without any URL or loader
		// change, must not keep presenting its first sample as the final value.
		case "/f02-main":
			return shell(
				`<p>F02_MAIN_START</p><iframe id="late-frame" src="/f02-child"></iframe>${feed()}<p>F02_MAIN_END</p>`,
				onFirstScroll(`const doc = document.getElementById('late-frame').contentDocument;
		doc.getElementById('late').textContent = 'FRAME_LATE_UPDATE';
		${triggerMarker("F02_TRIGGER_FIRED")}`),
			);
		case "/f02-child":
			return shell('<p id="early">FRAME_EARLY_TEXT</p><p id="late">FRAME_PRE_UPDATE</p>');

		// F03: a frame that is really removed, replaced by a different one.
		case "/f03-main":
			return shell(
				`<p>F03_MAIN_START</p><iframe id="swap" src="/f03-a"></iframe>${feed()}<p>F03_MAIN_END</p>`,
				onFirstScroll(`const removed = document.getElementById('swap');
		const replacement = document.createElement('iframe');
		replacement.src = '/f03-b';
		removed.replaceWith(replacement);
		${triggerMarker("F03_TRIGGER_FIRED")}`),
			);
		case "/f03-a":
			return shell("<p>FRAME_A_TEXT</p>");
		case "/f03-b":
			return shell("<p>FRAME_B_TEXT</p>");

		// F04a: a cross-origin frame that reloads with the same URL must replace its
		// samples instead of mixing both document generations.
		case "/f04-reload-main":
			return shell(
				`<p>F04_RELOAD_MAIN_START</p><iframe src="http://frame.public.net/f04-reload-frame"></iframe><p>F04_RELOAD_MAIN_END</p>`,
				`
	addEventListener('message', (event) => {
		if (event.data !== 'F04A_RELOADED') return;
		${triggerMarker("F04A_RELOAD_OBSERVED")}
	});
`,
			);
		case "/f04-reload-frame":
			return shell(
				'<p id="generation">GEN1_TEXT</p>' + feed(900),
				`
	if (sessionStorage.getItem('reloaded')) {
		document.getElementById('generation').textContent = 'GEN2_TEXT';
		parent.postMessage('F04A_RELOADED', '*');
	}
	const feed = document.querySelector('.feed');
	feed.addEventListener('scroll', () => {
		if (feed.scrollTop <= 0 || sessionStorage.getItem('reloaded')) return;
		sessionStorage.setItem('reloaded', '1');
		location.reload();
	});
`,
			);

		// F04b: the current document of a frame decides its status; a 403 that
		// replaces a readable document must not leave the old text as if it were
		// still current.
		case "/f04-status-main":
			return shell(
				`<p>F04_STATUS_MAIN_START</p><iframe id="status-frame" src="/f04-status"></iframe>${feed()}<p>F04_STATUS_MAIN_END</p>`,
				onFirstScroll(
					`document.getElementById('status-frame').contentWindow.location.reload();\n\t\t${triggerMarker("F04_TRIGGER_FIRED")}`,
				),
			);
		case "/f04-status":
			f04StatusRequests++;
			return f04StatusRequests === 1
				? shell("<p>F04_OK_TEXT</p>")
				: { html: shell("<p>F04_DENIED_TEXT</p>"), status: 403 };

		// F04c: main-document navigation after frames were read.
		case "/f04-nav-main":
			return shell(
				`<p>F04_NAV_MAIN_START</p><iframe src="http://frame.public.net/f04-nav-frame"></iframe>${feed()}<p>F04_NAV_MAIN_END</p>`,
				onFirstScroll("location.replace('/f04-nav-target');"),
			);
		case "/f04-nav-frame":
			return shell("<p>F04_NAV_FRAME_TEXT</p>");
		case "/f04-nav-target":
			return shell("<p>F04_TARGET_TEXT</p>");

		// F05: hidden authentication frame, visible frame rejected by the public
		// network guard, and a late frame inserted after the first pass.
		case "/f05-main":
			return shell(
				`<p>F05_MAIN_START</p><iframe style="display:none" src="/f05-hidden"></iframe>` +
					`<iframe src="http://restricted.public.net/denied"></iframe>${feed()}<p>F05_MAIN_END</p>`,
				onFirstScroll(`const late = document.createElement('iframe');
		late.src = '/f05-late';
		document.querySelector('.feed').before(late);
		${triggerMarker("F05_TRIGGER_FIRED")}`),
			);
		case "/f05-hidden":
			return { html: shell('<p>F05_HIDDEN_TEXT</p><input type="password">'), status: 403 };
		case "/f05-late":
			return shell("<p>FRAME_LATE_TEXT</p>");

		default:
			return undefined;
	}
}
