import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { until } from "./chrome.mjs";

assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [work, packageRoot, bundle] = process.argv.slice(2);
assert.ok([work, packageRoot, bundle].every((p) => p && isAbsolute(p)));
mkdirSync(work, { mode: 0o700 });
writeFileSync(join(work, "fixture.mjs"), readFileSync(new URL(import.meta.url)));
const { createComputerFeature } = createRequire(import.meta.url)(join(packageRoot, "bridge.js"));
const rows = (r) =>
	r.content.flatMap((p) =>
		p.type === "text"
			? p.text
					.split("\n")
					.filter((l) => l.startsWith("{"))
					.map(JSON.parse)
			: [],
	);
const results = [];
for (const kind of ["ready", "timeout", "cancel", "foreign", "alert"]) {
	const output = join(work, `guard-${kind}`);
	mkdirSync(output);
	let clicks = 0,
		feature;
	const foreign = createServer((_q, s) => s.end("<!doctype html><p>Ready</p>"));
	await new Promise((r) => foreign.listen(0, "127.0.0.1", r));
	const effect =
		kind === "ready"
			? "document.getElementById('state').textContent='Ready'"
			: kind === "foreign"
				? `location.href='http://127.0.0.1:${foreign.address().port}/'`
				: kind === "alert"
					? "alert('Owned wait guard')"
					: "void 0";
	const server = createServer((q, s) => {
		if (q.url === "/clicked") {
			clicks++;
			s.end("ok");
			return;
		}
		s.setHeader("content-type", "text/html; charset=utf-8");
		s.end(
			`<!doctype html><title>Owned wait guard</title><p id="state">Idle</p><button onclick="fetch('/clicked',{method:'POST'});this.remove();document.getElementById('state').textContent='Pending';setTimeout(()=>{${effect}},120)">Start</button>`,
		);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const manifest = join(output, "capabilities.yaml");
	writeFileSync(
		manifest,
		`version: 3\nexpires_after: 10m\nidle_timeout: 3m\nresources:\n  browser:\n    profiles: [{kind: isolated}]\n    origins: ["about:blank", "${origin}"]\nallow:\n  tools: [browser_prepare, get_browser_state, browser_navigate, browser_click, browser_type]\n`,
	);
	let timer;
	try {
		feature = createComputerFeature({ browserBundlePath: bundle, manifestPath: manifest });
		let seq = 0;
		const call = async (input, signal) => {
			const id = `g${++seq}`;
			const deadline = AbortSignal.timeout(15_000);
			let result;
			try {
				result = await feature.binding.tools[0].execute(
					id,
					input,
					signal ? AbortSignal.any([signal, deadline]) : deadline,
				);
			} catch (error) {
				appendFileSync(
					join(output, "trace.jsonl"),
					`${JSON.stringify({ input, error: error.details ?? error.name })}\n`,
				);
				throw error;
			}
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
		};
		const seen = await call({ request: { op: "prepare", url: origin }, observeAfter: true });
		const target = rows(seen).find((r) => r.role === "button" && r.label === "Start");
		assert.ok(target);
		const request = { op: "click", ref: seen.details.observationRef, target: target.ref };
		const controller = new AbortController();
		if (kind === "cancel") timer = setTimeout(() => controller.abort(), 250);
		const start = performance.now();
		let result, error;
		try {
			result = await call({ request, observeAfter: true, waitForText: "Ready" }, controller.signal);
		} catch (e) {
			error = e;
		}
		clearTimeout(timer);
		const elapsedMs = performance.now() - start;
		await until(() => clicks === 1);
		if (kind === "ready") {
			assert.ok(result);
			assert.ok(rows(result).some((r) => r.label === "Ready"));
		} else {
			assert.ok(error);
			assert.equal(error.details?.status, "action_submitted");
			assert.equal(typeof error.details.observationError, "string");
			assert.equal(error.details?.observationRef, undefined);
			if (kind === "timeout") assert.equal(error.details.observationError, "observation_condition_timeout");
			if (kind === "cancel") assert.equal(error.details.observationError, "cancelled");
			await assert.rejects(call({ request }), /current model view/);
		}
		assert.equal(clicks, 1);
		results.push({ kind, passed: true, elapsedMs, clicks, error: error?.details });
	} finally {
		clearTimeout(timer);
		await feature?.close();
		await new Promise((r) => server.close(r));
		await new Promise((r) => foreign.close(r));
		const lease = readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8").trim();
		assert.match(lease, /^pi-computer-desktop-v1 C /);
		console.log(JSON.stringify({ kind, lease, result: results.at(-1)?.kind === kind ? results.at(-1) : undefined }));
		writeFileSync(join(work, "guards.json"), `${JSON.stringify(results, null, 2)}\n`);
	}
}
