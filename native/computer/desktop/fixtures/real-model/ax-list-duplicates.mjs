import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { until } from "./chrome.mjs";

assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [output, packageRoot, miniRoot, bundle, start = "split"] = process.argv.slice(2);
assert.ok([output, packageRoot, miniRoot, bundle].every((p) => p && isAbsolute(p)));
assert.ok(["split", "combined"].includes(start));
mkdirSync(output);
writeFileSync(join(output, "fixture.mjs"), readFileSync(new URL(import.meta.url)));
const base = join(miniRoot, "miniwob/html/core/jquery-ui");
const html = `<!doctype html><title>Owned tab activation</title><script src="/jquery.js"></script><script src="/ui.js"></script>
<div id="tabs"><ul><li id="first"><a href="#p1">First</a></li><li id="second"><a id="link" href="#p2">Second</a></li></ul><div id="p1">Panel One</div><div id="p2">Panel Two</div></div>
<button role="tab" id="direct" aria-selected="false">Direct</button><div id="delegate"><div role="tab" id="delegated" tabindex="0" aria-selected="false">Delegated</div></div><script>
$('#tabs').tabs();let clicks=[];document.getElementById('direct').onclick=e=>e.currentTarget.setAttribute('aria-selected','true');document.getElementById('delegate').onclick=e=>{if(e.target.id==='delegated')e.target.setAttribute('aria-selected','true')};
function report(){fetch('/receipt',{method:'POST',body:JSON.stringify({selected:document.getElementById('second').getAttribute('aria-selected'),direct:document.getElementById('direct').getAttribute('aria-selected'),delegated:document.getElementById('delegated').getAttribute('aria-selected'),clicks})})};document.addEventListener('click',e=>{clicks.push(e.target.id);report()});report();</script>`;
const files = { "/jquery.js": "external/jquery/jquery.js", "/ui.js": "jquery-ui.min.js" };
let oracle, feature;
const server = createServer((req, res) => {
	if (req.url === "/receipt") {
		let body = "";
		req.on("data", (b) => {
			body += b;
			if (body.length > 4096) req.destroy();
		});
		req.on("end", () => {
			oracle = JSON.parse(body);
			res.end("ok");
		});
	} else if (files[req.url]) res.end(readFileSync(join(base, files[req.url])));
	else {
		res.setHeader("content-type", "text/html");
		res.end(html);
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const manifest = join(output, "capabilities.yaml");
writeFileSync(
	manifest,
	`version: 3\nexpires_after: 10m\nidle_timeout: 3m\nresources:\n  browser:\n    profiles: [{kind: isolated}]\n    origins: ["about:blank", "${origin}"]\nallow:\n  tools: [browser_prepare, get_browser_state, browser_navigate, browser_click, browser_type]\n`,
);
const rows = (r) =>
	r.content.flatMap((p) =>
		p.type === "text"
			? p.text
					.split("\n")
					.filter((s) => s.startsWith("{"))
					.map(JSON.parse)
			: [],
	);
const row = (r, role, label) => rows(r).find((v) => v.role === role && v.label === label);
try {
	const { createComputerFeature } = createRequire(import.meta.url)(join(packageRoot, "bridge.js"));
	feature = createComputerFeature({ browserBundlePath: bundle, manifestPath: manifest });
	let sequence = 0;
	const call = async (input) => {
		const id = `t${++sequence}`,
			c = new AbortController(),
			timer = setTimeout(() => c.abort(), 15000);
		try {
			const result = await feature.binding.tools[0].execute(id, input, c.signal);
			appendFileSync(join(output, "trace.jsonl"), `${JSON.stringify({ input, result })}\n`);
			feature.binding.observeContext(false, [
				{
					role: "toolResult",
					toolCallId: id,
					toolName: "computer",
					content: result.content,
					isError: false,
					timestamp: Date.now(),
				},
			]);
			return result;
		} finally {
			clearTimeout(timer);
		}
	};
	if (start === "split") await call({ request: { op: "prepare" } });
	let seen = await call({
		request: { op: start === "split" ? "navigate" : "prepare", url: origin },
		observeAfter: true,
	});
	assert.deepEqual(row(seen, "link", "Second").tab, { label: "Second", selected: false });
	for (const [role, label, id] of [
		["link", "Second", "link"],
		["tab", "Direct", "direct"],
		["tab", "Delegated", "delegated"],
	]) {
		const target = row(seen, role, label);
		assert.ok(target.actions.includes("press"));
		seen = await call({
			request: { op: "click", ref: seen.details.observationRef, target: target.ref },
			observeAfter: true,
		});
		await until(() => oracle?.clicks.includes(id));
		assert.equal(row(seen, role, label).selected ?? row(seen, role, label).tab?.selected, true);
	}
	assert.deepEqual(oracle, {
		selected: "true",
		direct: "true",
		delegated: "true",
		clicks: ["link", "direct", "delegated"],
	});
	console.log(JSON.stringify({ passed: true, calls: sequence, oracle }));
} finally {
	await feature?.close();
	await new Promise((r) => server.close(r));
	const lease = readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8");
	assert.match(lease, /^pi-computer-desktop-v1 C /);
	console.log(JSON.stringify({ closed: true, lease: lease.trim() }));
}
