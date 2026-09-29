import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { launchChrome } from "../real-model/chrome.mjs";

assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [bridge, bundle, output, mode] = process.argv.slice(2);
assert.ok([bridge, bundle, output].every((path) => path && isAbsolute(path)));
assert.ok(
	[
		"link",
		"button",
		"radio",
		"replace-text",
		"move-text",
		"replace-parent",
		"cover",
		"nested-control",
		"button-replace-text",
		"button-move-text",
		"button-replace-parent",
		"button-cover",
		"button-add-text",
	].includes(mode),
);
mkdirSync(output, { mode: 0o700 });
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const buttonCase = mode === "button" || mode.startsWith("button-");
const mutation = mode.startsWith("button-") ? mode.slice(7) : mode;
const role = buttonCase ? "AXButton" : mode === "radio" ? "AXRadioButton" : "AXLink";
const tag = buttonCase ? "button" : "a";
const html = `<!doctype html><title>Owned target child regression</title>
<style>body{margin:0}#target{position:absolute;left:20px;top:100px;width:120px;height:40px;display:flex;align-items:center;justify-content:center}#clock{position:absolute;left:240px;top:100px}</style>
<${tag} id="target" href="#" ${mode === "radio" ? 'role="radio" aria-checked="false"' : ""} ${mutation === "add-text" ? 'aria-label="Tempor"' : ""}>${mutation === "add-text" ? "" : mode === "nested-control" ? '<span id="child" role="button">Tempor</span>' : "Tempor"}</${tag}><span id="clock">0</span>
<script>window.clicks=0;window.covered=0;
target.onclick=e=>{e.preventDefault();window.clicks++};
${mode === "nested-control" ? "child.onclick=e=>{e.stopPropagation();e.preventDefault();window.covered++};" : ""}
setInterval(()=>clock.textContent=Date.now(),100);</script>`;
const server = createServer((_request, response) => {
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { createComputerFeature } = createRequire(import.meta.url)(bridge);
let chrome, feature, failure, oracle, chromeExit, action;
let closed = false;
const calls = [];
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const timer = setTimeout(stop, 30000);
async function call(request) {
	const id = `child-${calls.length + 1}`;
	const started = performance.now();
	const result = await feature.binding.tools[0].execute(id, { request }, controller.signal, undefined, {});
	feature.binding.observeContext(true, [
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "computer",
			content: result.content,
			isError: false,
			timestamp: Date.now(),
		},
	]);
	calls.push({
		request,
		ms: performance.now() - started,
		details: result.details,
		text: result.content.filter((part) => part.type === "text"),
	});
	return result;
}
try {
	chrome = await launchChrome(bundle, join(output, "profile"), `http://127.0.0.1:${server.address().port}/`);
	feature = createComputerFeature();
	const inventory = await call({
		op: "discover",
		title: "Owned target child regression",
		app: "Google Chrome for Testing",
	});
	const windows = inventory.content[0].text.split("\n").slice(1).filter(Boolean).map(JSON.parse);
	assert.equal(windows.length, 1);
	let view = await call({ op: "select", ref: windows[0].ref, observe: true });
	let target;
	// Fixture readiness only: Chrome exposes its web AX subtree asynchronously.
	// Never retry an input or change the page to make the target appear.
	for (let i = 0; i < 20; i++) {
		const rows = view.content[0].text.split("\n").slice(1).filter(Boolean).map(JSON.parse);
		const matches = rows.filter((row) => row.role === role && row.label === "Tempor");
		if (matches.length === 1) {
			target = matches[0];
			break;
		}
		if (controller.signal.aborted) throw new Error("aborted");
		await new Promise((resolve) => setTimeout(resolve, 100));
		view = await call({ op: "observe", text: "Tempor" });
	}
	assert.ok(target, "A unique observed target is required");
	const mutations = {
		"add-text": "target.append(document.createTextNode('Tempor'))",
		"replace-text": "target.replaceChildren(document.createTextNode('Tempor'))",
		"move-text": "target.style.boxSizing='border-box';target.style.paddingLeft='8px'",
		"replace-parent":
			"const fresh=target.cloneNode(true);fresh.onclick=e=>{e.preventDefault();window.clicks++};target.replaceWith(fresh)",
		cover: "const cover=document.createElement('button');cover.textContent='Covered';cover.style='position:absolute;left:20px;top:100px;width:120px;height:40px;z-index:10';cover.onclick=()=>window.covered++;document.body.append(cover)",
	};
	if (mutations[mutation]) {
		await chrome.evaluate(`${mutations[mutation]};true`);
		// Freeze the mutated fixture for the negative control, not production input.
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	action = await call({
		op: "segment",
		ref: view.details.observationRef,
		actions: [{ op: "click", target: { ref: target.ref } }],
		expected: {
			kind: "visual",
			description: "The original owned control receives one click; changed or covered targets receive none",
		},
	});
	oracle = await chrome.evaluate("({clicks:window.clicks,covered:window.covered})");
	assert.equal(oracle.covered, 0);
	if (["link", "button", "radio"].includes(mode)) {
		assert.equal(oracle.clicks, 1);
		assert.equal(action.details.actions[0]?.dispatch, "dispatched");
	} else {
		assert.equal(oracle.clicks, 0);
		assert.equal(action.details.actions[0]?.dispatch, "not_dispatched");
		assert.equal(action.details.terminal.inputCommitted, false);
		assert.equal(
			action.details.actions[0]?.code,
			["move-text", "replace-parent"].includes(mutation) ? "stale_session_observation" : "pointer_hit_changed",
		);
	}
} catch (error) {
	failure = String(error);
} finally {
	try {
		await feature?.close();
		closed = true;
	} catch (error) {
		failure ??= String(error);
	}
	if (closed && chrome) {
		try {
			chromeExit = await chrome.close();
		} catch (error) {
			failure ??= String(error);
		}
	}
	clearTimeout(timer);
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	await new Promise((resolve) => server.close(resolve));
}
const lease = readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8").trim();
const passed =
	!failure &&
	!controller.signal.aborted &&
	closed &&
	chromeExit?.processGroupDrained &&
	lease.startsWith("pi-computer-desktop-v1 C ");
const report = {
	mode,
	passed,
	failure,
	oracle,
	closed,
	chromeExit,
	lease,
	calls,
	bridgeSha256: sha(bridge),
	nativeSha256: sha(join(dirname(bridge), "sdk/node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib")),
	probeSha256: sha(new URL(import.meta.url)),
};
writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;
