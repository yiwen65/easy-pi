import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [output, sdkRoot, expectedSha, renderer, bundle, only] = process.argv.slice(2);
assert.ok([output, sdkRoot, renderer, bundle].every((p) => p && isAbsolute(p)));
assert.match(expectedSha, /^[a-f0-9]{64}$/);
const sha = createHash("sha256")
	.update(readFileSync(join(sdkRoot, "node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib")))
	.digest("hex");
assert.equal(sha, expectedSha);
const sdk = createRequire(import.meta.url)(join(sdkRoot, "dist/computer.js"));
mkdirSync(output, { mode: 0o700 });
writeFileSync(join(output, "fixture.mjs"), readFileSync(new URL(import.meta.url)));
const encode = (v) => JSON.stringify(v, (_, item) => (typeof item === "bigint" ? String(item) : item));
const scenarios = [
	"page",
	"nested",
	"dialog",
	"hidden",
	"transparent",
	"inert",
	"removed-node",
	"dialog-after",
	"stale-observation",
	"preabort",
];
if (only) assert.ok(scenarios.includes(only));
const samples = [];
async function until(predicate) {
	const end = performance.now() + 3000;
	while (!predicate()) {
		assert.ok(performance.now() < end, "fixture handshake deadline");
		await delay(20);
	}
}
for (const scenario of only ? [only] : scenarios) {
	let state,
		command = "",
		host,
		session,
		failure;
	let polls = 0,
		cleanup = false;
	const operations = [],
		started = performance.now();
	const server = createServer((request, response) => {
		if (request.url === "/state") {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
				if (body.length > 4096) request.destroy();
			});
			request.on("end", () => {
				state = JSON.parse(body);
				polls++;
				response.end(JSON.stringify(command));
			});
			return;
		}

		response.setHeader("Content-Type", "text/html; charset=utf-8");
		response.end(`<!doctype html><title>Owned scroll guard</title><div id="container" style="height:200px"><div style="height:1800px"></div><button id="target">Scroll target</button></div><dialog id="dialog" style="height:250px;width:400px"></dialog><script>
const scenario=${JSON.stringify(scenario)}, t=document.getElementById('target'), c=document.getElementById('container'), d=document.getElementById('dialog');
let clicks=0, inputs=0, phase='ready'; t.onclick=()=>clicks++; document.addEventListener('input',()=>inputs++);
if(scenario==='nested')c.style.overflow='auto';
if(scenario==='dialog'){d.append(c);d.showModal();d.scrollTop=0;c.scrollTop=0}
window.scrollTo(0,0);
async function poll(){const rect=t.getBoundingClientRect(), clip=scenario==='nested'?c.getBoundingClientRect():scenario==='dialog'?d.getBoundingClientRect():{top:0,bottom:innerHeight};const cmd=await(await fetch('/state',{method:'POST',body:JSON.stringify({clicks,inputs,phase,focus:document.activeElement.id,y:scrollY,nested:c.scrollTop,dialog:d.scrollTop,top:rect.top,bottom:rect.bottom,visible:rect.top>=Math.max(0,clip.top)&&rect.bottom<=Math.min(innerHeight,clip.bottom)})})).json();
 if(cmd && phase==='ready'){
  if(cmd==='hidden')t.style.display='none';
  if(cmd==='transparent')t.style.opacity='0';
  if(cmd==='inert')t.inert=true;
  if(cmd==='removed-node')t.remove();
  if(cmd==='dialog-after')d.showModal();
  phase='changed';
 }setTimeout(poll,30)}poll();</script>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const manifest = join(output, `${scenario}.yaml`);
	writeFileSync(
		manifest,
		`version: 3\nexpires_after: 10m\nidle_timeout: 3m\nresources:\n  browser:\n    profiles: [{kind: isolated}]\n    origins: ["about:blank", "${origin}"]\nallow:\n  tools: [browser_prepare, get_browser_state, browser_navigate, browser_click, browser_type, browser_scroll_into_view]\n`,
	);
	async function call(name, launch) {
		const started = performance.now();
		const op = session.newOperation();
		operations.push(op);
		const outcome = op.result().then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		const terminal = op.terminal(),
			timer = setTimeout(() => op.cancel(), 15000);
		try {
			let startError;
			try {
				launch(op);
			} catch (error) {
				startError = error;
				op.cancel();
			}
			const [result, receipt] = await Promise.all([outcome, terminal]);
			if (name === "refused" && ["preabort", "stale-observation"].includes(scenario))
				assert.equal(receipt.inputCommitted, false);
			appendFileSync(
				join(output, "trace.jsonl"),
				`${encode({ scenario, name, result, receipt, elapsedMs: performance.now() - started })}\n`,
			);
			if (result.error) throw result.error;
			if (startError) throw startError;
			return result.value;
		} finally {
			clearTimeout(timer);
		}
	}
	try {
		host = sdk.ComputerHost.createWithRenderer(
			{
				claudeCodeCompatibility: false,
				authorization: {
					allowedModes: [sdk.SessionPermissionMode.Bounded],
					compatibilityMode: sdk.SessionPermissionMode.Bounded,
					compatibilityCapabilityManifestPath: manifest,
					unrestrictedAcknowledged: false,
					maxSessionTtlSeconds: 600n,
					maxIdleTtlSeconds: 180n,
				},
			},
			new sdk.ComputerRendererConfig.Required({ helperPath: renderer }),
		);
		session = host.openBrowserSession(
			bundle,
			realpathSync(mkdtempSync("/private/tmp/epi-computer-browser-")),
			undefined,
		);
		await call("prepare", (op) => op.startPrepare());
		await call("navigate", (op) => op.startNavigate(origin));
		await until(() => state?.phase === "ready");
		const observed = await call("observe", (op) => op.startObserve(512, 32));
		const rows = observed.inner.value.elements;
		const target = rows.find((row) => row.role === "button" && row.label === "Scroll target");
		assert.ok(target?.actions?.includes("scroll_into_view"), "fresh target must expose bounded scroll");
		const positive = ["page", "nested", "dialog"].includes(scenario);
		if (["hidden", "transparent", "inert", "removed-node", "dialog-after"].includes(scenario)) {
			command = scenario;
			await until(() => state?.phase === "changed");
		}
		if (scenario === "stale-observation") await call("replace-observation", (op) => op.startObserve(512, 32));
		const baseline = { y: state.y, nested: state.nested, dialog: state.dialog };
		assert.deepEqual(baseline, { y: 0, nested: 0, dialog: 0 });
		const focus = state.focus;
		if (positive) {
			const result = await call("scroll", (op) => op.startScrollIntoView(target.elementToken));
			assert.ok(sdk.ComputerResult.Action.instanceOf(result));
			assert.equal(result.inner.value.effect, sdk.ActionEffect.Unverifiable);
			await until(() => state?.visible && (state.y > 0 || state.nested > 0 || state.dialog > 0));
		} else {
			await assert.rejects(
				call("refused", (op) => {
					if (scenario === "preabort") op.cancel();
					op.startScrollIntoView(target.elementToken);
				}),
				(error) => sdk.ComputerError.Refused.instanceOf(error) || sdk.ComputerError.Cancelled.instanceOf(error),
			);
		}
		const prior = polls;
		await until(() => polls >= prior + 2);
		assert.equal(state.clicks, 0);
		assert.equal(state.inputs, 0);
		assert.equal(state.focus, focus);
		if (!positive) assert.deepEqual({ y: state.y, nested: state.nested, dialog: state.dialog }, baseline);
		appendFileSync(join(output, "geometry.jsonl"), `${JSON.stringify({ scenario, baseline, state })}\n`);
	} catch (error) {
		failure = String(error);
	} finally {
		if (host) {
			try {
				host.revoke();
				await host.close();
				for (const op of operations) op.uniffiDestroy();
				session?.uniffiDestroy();
				host.uniffiDestroy();
				assert.match(
					readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8"),
					/^pi-computer-desktop-v1 C /,
				);
				cleanup = true;
			} catch (error) {
				failure = String(error);
			}
		}
		await new Promise((resolve) => server.close(resolve));
	}
	const sample = { scenario, passed: !failure, cleanup, ms: performance.now() - started, failure, sha };
	samples.push(sample);
	writeFileSync(join(output, "results.json"), JSON.stringify(samples, null, 2));
	console.log(JSON.stringify(sample));
	if (!cleanup || failure) {
		process.exitCode = 1;
		break;
	}
}
