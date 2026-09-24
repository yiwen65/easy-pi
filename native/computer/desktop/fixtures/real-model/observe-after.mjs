import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [output, packageRoot, bundle] = process.argv.slice(2);
assert.ok([output, packageRoot, bundle].every((p) => p && isAbsolute(p)));
mkdirSync(output, { mode: 0o700 });
writeFileSync(join(output, "qualification.mjs"), readFileSync(new URL(import.meta.url)));
const { createComputerFeature } = createRequire(import.meta.url)(join(packageRoot, "bridge.js"));
let oracle, feature;
const server = createServer((request, response) => {
	if (request.url === "/receipt") {
		let body = "";
		request.on("data", (b) => {
			body += b;
		});
		request.on("end", () => {
			oracle = JSON.parse(body);
			response.end("ok");
		});
		return;
	}
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.end(
		`<!doctype html><title>Owned combined observation</title><label>Name <input id="name"></label><label>Plan <select id="plan"><option>Free</option><option>Pro</option></select></label><button id="save">Save</button><p id="receipt"></p><script>document.querySelector('#save').onclick=()=>{const r={name:document.querySelector('#name').value,plan:document.querySelector('#plan').value};document.querySelector('#receipt').textContent='Saved '+JSON.stringify(r);fetch('/receipt',{method:'POST',body:JSON.stringify(r)})}</script>`,
	);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const manifest = join(output, "capabilities.yaml");
writeFileSync(
	manifest,
	`version: 3\nexpires_after: 10m\nidle_timeout: 3m\nresources:\n  browser:\n    profiles: [{kind: isolated}]\n    origins: ["about:blank", "${origin}"]\nallow:\n  tools: [browser_prepare, get_browser_state, browser_navigate, browser_click, browser_type]\n`,
);
try {
	feature = createComputerFeature({ browserBundlePath: bundle, manifestPath: manifest });
	const tool = feature.binding.tools[0];
	let sequence = 0;
	const call = async (input) => {
		const id = `c${++sequence}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15000);
		try {
			const result = await tool.execute(id, input, controller.signal);
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
	const row = (result, role, label) =>
		result.content
			.flatMap((p) =>
				p.type === "text"
					? p.text
							.split("\n")
							.filter((s) => s.startsWith("{"))
							.map((s) => JSON.parse(s))
					: [],
			)
			.find((r) => r.role === role && r.label?.trim() === label);
	await call({ request: { op: "prepare" } });
	let result = await call({ request: { op: "navigate", url: origin }, observeAfter: true });
	assert.equal(result.details.status, "navigation_submitted");
	assert.ok(result.details.observationRef);
	result = await call({
		request: {
			op: "execute",
			ref: result.details.observationRef,
			steps: [{ op: "fill", target: { ref: row(result, "textbox", "Name").ref }, text: "组合 café 你好" }],
		},
		observeAfter: true,
	});
	assert.equal(result.details.status, "completed");
	assert.equal(row(result, "textbox", "Name").value, "组合 café 你好");
	result = await call({
		request: { op: "select_option", ref: result.details.observationRef, target: row(result, "option", "Pro").ref },
		observeAfter: true,
	});
	assert.equal(result.details.status, "action_submitted");
	result = await call({
		request: { op: "click", ref: result.details.observationRef, target: row(result, "button", "Save").ref },
		observeAfter: true,
	});
	assert.equal(result.details.status, "action_submitted");
	assert.match(JSON.stringify(result.content), /Saved/);
	const deadline = performance.now() + 2000;
	while (!oracle && performance.now() < deadline) await delay(20);
	assert.deepEqual(oracle, { name: "组合 café 你好", plan: "Pro" });
	result = await call({ request: { op: "observe", text: "saved" } });
	assert.equal(result.details.status, "observed");
	assert.ok(result.details.filteredOut > 0);
	assert.match(JSON.stringify(result.content), /Saved/);
	assert.equal(row(result, "textbox", "Name"), undefined);
	console.log(JSON.stringify({ passed: true, calls: sequence, oracle }));
} finally {
	await feature?.close();
	await new Promise((resolve) => server.close(resolve));
	const lease = readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8");
	assert.match(lease, /^pi-computer-desktop-v1 C /);
	console.log(JSON.stringify({ closed: true, lease: lease.trim() }));
}
