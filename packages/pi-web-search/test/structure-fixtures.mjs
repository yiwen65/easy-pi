// Fixtures for the O01-O03 structure/link/content-quality acceptance (docs/web_fetch/WEB_FETCH_REMEDIATION_PLAN.md 5.5).
// Everything is served over loopback by the isolated browser harness; no fixture needs the public
// network, a credential, a disabled security policy or a second host beyond the two declared ones.
export const marker = (prefix, index) => `${prefix}_${String(index).padStart(3, "0")}_汉字😀`;
export const markers = (prefix, count) => Array.from({ length: count }, (_, index) => marker(prefix, index));

const shell = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Structure fixture</title>${head}<style>
body { margin: 12px; font: 16px/20px monospace; } p, li, td, th, h1, h2, h3 { margin: 4px 0; }
iframe { display: block; width: 90%; height: 160px; border: 0; }
</style></head><body>${body}</body></html>`;

/** Filler paragraphs, so the structure block list of a page has to respect its own bound. */
const filler = (prefix, count) => markers(prefix, count).map((value) => `<p>${value}</p>`).join("");

export function fixturePage(path) {
	switch (path) {
		// O01: headings, nested lists, a code block with indentation and a table, plus a link block.
		case "/o01-structure":
			return shell(`
<h1>O01_HEADING_ONE</h1>
<p>O01_INTRO with <b>inline</b> text and a <a href="/o01-inline">O01_INLINE_LINK</a> inside a paragraph.</p>
<a href="/o01-block-link" title="O01 block title" style="display:block">O01_BLOCK_LINK</a>
<h2>O01_HEADING_TWO</h2>
<h3>O01_HEADING_THREE</h3>
<ul>
	<li>O01_ITEM_ALPHA</li>
	<li>O01_ITEM_BETA
		<ul>
			<li>O01_NESTED_ALPHA</li>
			<li>O01_NESTED_BETA</li>
		</ul>
	</li>
	<li>O01_ITEM_GAMMA</li>
</ul>
<ol start="3">
	<li>O01_ORDERED_THREE</li>
	<li>O01_ORDERED_FOUR</li>
</ol>
<p>O01_CODE_LEAD</p>
<pre>O01_CODE_LINE_ONE
O01_CODE_LINE_TWO
    O01_CODE_INDENTED</pre>
<table>
	<thead><tr><th>O01_HEAD_A</th><th>O01_HEAD_B</th></tr></thead>
	<tbody>
		<tr><td>O01_CELL_A1</td><td>O01_CELL_B1</td></tr>
		<tr><td>O01_CELL_A2</td><td>O01_CELL_B2</td></tr>
	</tbody>
</table>
<p># O01_HASH_PARAGRAPH</p>
<p>O01_END</p>`);

		// O02: the same link text in the main document and in an embedded frame, relative targets,
		// a base href, a hash anchor, and dangerous or credentialed targets.
		case "/o02-links-main":
			return shell(`
<p>O02_MAIN_START</p>
<base href="/o02-base/">
<a href="relative-target">O02_SAME_TEXT</a>
<a href="#o02-anchor">O02_HASH_LINK</a>
<a href="javascript:window.close()">O02_SAME_TEXT</a>
<a href="data:text/html,<b>O02_DATA</b>">O02_DATA_LINK</a>
<a href="file:///etc/passwd">O02_FILE_LINK</a>
<a href="https://user:secret@page.public.org/o02-credential">O02_CREDENTIAL_LINK</a>
<a href="https://page.public.org:8443/o02-port">O02_PORT_LINK</a>
<a href="mailto:o02@public.org">O02_MAILTO_LINK</a>
<iframe src="/o02-links-frame"></iframe>
<p id="o02-anchor">O02_ANCHOR_TARGET</p>
<p>O02_MAIN_END</p>`);
		case "/o02-links-frame":
			return shell(`
<p>O02_FRAME_START</p>
<base href="/o02-frame-base/">
<a href="frame-relative">O02_SAME_TEXT</a>
<a href="javascript:void(0)">O02_FRAME_SAME_TEXT</a>
<a href="https://frame.public.net/o02-frame-absolute">O02_FRAME_ABSOLUTE</a>
<p>O02_FRAME_END</p>`);
		case "/o02-base/relative-target":
			return shell("<p>O02_BASE_RELATIVE_TARGET</p>");
		case "/o02-frame-base/frame-relative":
			return shell("<p>O02_FRAME_RELATIVE_TARGET</p>");

		// O03: the four content-quality cases, each a separate capture.
		case "/o03-article-with-password":
			return shell(`${filler("O03_ARTICLE", 24)}
<p>O03_ARTICLE_END</p>
<form action="/o03-login" method="post"><input type="text" name="user"><input type="password" name="secret"><button>Log In</button></form>`);
		case "/o03-login-wall":
			return shell(`
<h1>Sign in to continue</h1>
<p>Log In or Sign Up to read the rest of this page. Only members can view this document.</p>
<button>Log In</button>`);
		case "/o03-challenge":
			return shell(`
<h1>Just a moment...</h1>
<p>Verify you are human. Checking your browser before accessing the site.</p>`);
		case "/o03-plain-article":
			return shell(`<h1>O03_PLAIN_TITLE</h1>${filler("O03_PLAIN", 12)}<p>O03_PLAIN_END</p>`);
		case "/o03-short-login":
			return shell(`<form action="/o03-short-login" method="post"><input type="password" name="secret"><button>Log In</button></form>`);

		// O04: far more text blocks than the per-frame structure budget, without losing any text.
		case "/o04-budget":
			// A non-scrolling document keeps this fixture fast: the point is the block budget, not the
			// scroll budget, and off-screen text is captured either way.
			return shell(`${filler("BUDGET", 4200)}<p>O04_BUDGET_END</p>`, "<style>html { overflow-y: hidden; }</style>");

		default:
			return undefined;
	}
}
