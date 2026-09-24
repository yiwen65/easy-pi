import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { connect, launchChrome, until } from "./chrome.mjs";

assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [output, packageRoot, bundle] = process.argv.slice(2);
assert.ok([output, packageRoot, bundle].every((p) => p && isAbsolute(p)));
mkdirSync(output, { mode: 0o700 });
writeFileSync(join(output, "fixture.mjs"), readFileSync(new URL(import.meta.url)));
const html = `<!doctype html><title>Owned selection state</title>
<div role="tablist"><button role="tab" aria-selected="true" id="one">First</button><button role="tab" aria-selected="false" id="two">Second</button></div>
<button id="plain">Ordinary</button><label>Plan <select id="plan"><option>Free</option><option>Pro</option></select></label>
<p id="receipt">Panel First</p><script>
let clicks=0;const one=document.getElementById('one'),two=document.getElementById('two'),plan=document.getElementById('plan');
function report(){fetch('/receipt',{method:'POST',body:JSON.stringify({first:one.getAttribute('aria-selected'),second:two.getAttribute('aria-selected'),plan:plan.value,clicks})})}
for(const tab of [one,two])tab.onclick=()=>{clicks++;one.setAttribute('aria-selected',String(tab===one));two.setAttribute('aria-selected',String(tab===two));document.getElementById('receipt').textContent='Panel '+tab.textContent;report()};
plan.onchange=report;report();</script>`;
let oracle, feature, chrome, page;
const server = createServer((request, response) => {
	if (request.url === "/receipt") {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
			if (body.length > 4096) request.destroy();
		});
		request.on("end", () => {
			oracle = JSON.parse(body);
			response.end("ok");
		});
	} else {
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		response.end(html);
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const rows = (result) =>
	result.content.flatMap((part) =>
		part.type === "text"
			? part.text
					.split("\n")
					.filter((line) => line.startsWith("{"))
					.map((line) => JSON.parse(line))
			: [],
	);
const find = (result, role, label) => rows(result).find((row) => row.role === role && row.label === label);
try {
	// Privileged read-only fixture oracle, never available to the agent.
	const profile = join(output, "raw-profile");
	mkdirSync(profile, { mode: 0o700 });
	chrome = await launchChrome(bundle, profile, `${origin}/`);
	const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
	const target = (await chrome.targets()).find((row) => row.url === `${origin}/`);
	assert.ok(target);
	page = await connect(`ws://127.0.0.1:${port}/devtools/page/${target.targetId}`);
	const raw = await page.call("Accessibility.getFullAXTree");
	writeFileSync(join(output, "raw-ax.json"), JSON.stringify(raw, null, 2));
	const selected = (label) =>
		raw.nodes
			.find((node) => node.role.value === "tab" && node.name.value === label)
			?.properties.find((p) => p.name === "selected")?.value.value;
	assert.equal(selected("First"), true);
	assert.equal(selected("Second"), false);
	page.close();
	page = undefined;
	console.log(JSON.stringify({ rawAX: { first: true, second: false }, closed: await chrome.close() }));
	chrome = undefined;
	oracle = undefined;
	const manifest = join(output, "capabilities.yaml");
	writeFileSync(
		manifest,
		`version: 3\nexpires_after: 10m\nidle_timeout: 3m\nresources:\n  browser:\n    profiles: [{kind: isolated}]\n    origins: ["about:blank", "${origin}"]\nallow:\n  tools: [browser_prepare, get_browser_state, browser_navigate, browser_click, browser_type]\n`,
	);
	const { createComputerFeature } = createRequire(import.meta.url)(join(packageRoot, "bridge.js"));
	feature = createComputerFeature({ browserBundlePath: bundle, manifestPath: manifest });
	let sequence = 0;
	const call = async (input) => {
		const id = `s${++sequence}`,
			controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15000);
		try {
			const result = await feature.binding.tools[0].execute(id, input, controller.signal);
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
	await call({ request: { op: "prepare" } });
	let result = await call({ request: { op: "navigate", url: `${origin}/` }, observeAfter: true });
	assert.equal(find(result, "tab", "First")?.selected, true);
	assert.equal(find(result, "tab", "Second")?.selected, false);
	assert.equal(find(result, "button", "Ordinary")?.selected, undefined);
	result = await call({
		request: { op: "click", ref: result.details.observationRef, target: find(result, "tab", "Second").ref },
		observeAfter: true,
	});
	assert.equal(find(result, "tab", "First")?.selected, false);
	assert.equal(find(result, "tab", "Second")?.selected, true);
	await until(() => oracle?.clicks === 1 && oracle.second === "true");
	assert.equal(find(result, "option", "Free")?.selected, true);
	assert.equal(find(result, "option", "Pro")?.selected, false);
	result = await call({
		request: { op: "select_option", ref: result.details.observationRef, target: find(result, "option", "Pro").ref },
		observeAfter: true,
	});
	assert.equal(find(result, "option", "Free")?.selected, false);
	assert.equal(find(result, "option", "Pro")?.selected, true);
	await until(() => oracle?.plan === "Pro");
	assert.deepEqual(oracle, { first: "false", second: "true", plan: "Pro", clicks: 1 });
	console.log(JSON.stringify({ passed: true, calls: sequence, oracle }));
} finally {
	page?.close();
	if (chrome) console.log(JSON.stringify({ rawClosed: await chrome.close() }));
	await feature?.close();
	await new Promise((resolve) => server.close(resolve));
	const lease = readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8");
	assert.match(lease, /^pi-computer-desktop-v1 C /);
	console.log(JSON.stringify({ closed: true, lease: lease.trim() }));
}
