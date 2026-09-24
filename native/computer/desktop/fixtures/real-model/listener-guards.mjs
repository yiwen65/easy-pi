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
	"span",
	"div",
	"dialog",
	"no-handler",
	"other-event",
	"removed-handler",
	"removed-node",
	"hidden",
	"visibility-hidden",
	"transparent",
	"inert",
	"disabled",
	"dialog-outside",
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
		const tag = scenario === "div" ? "div" : "span";
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		response.end(`<!doctype html><title>Owned listener guard</title><${tag} id="target">Tempor</${tag}><dialog id="dialog">Owned dialog</dialog><script>
const scenario=${JSON.stringify(scenario)}, t=document.getElementById('target'), d=document.getElementById('dialog');
let clicks=0, phase='ready'; const handler=()=>clicks++;
if(scenario!=='no-handler')t.addEventListener(scenario==='other-event'?'pointerdown':'click',handler);
if(scenario==='dialog'){d.append(t);d.showModal()}
if(scenario==='dialog-outside')d.showModal();
async function poll(){const cmd=await(await fetch('/state',{method:'POST',body:JSON.stringify({clicks,phase})})).json();
 if(cmd && phase==='ready'){
  if(cmd==='removed-handler')t.removeEventListener('click',handler);
  if(cmd==='removed-node')t.remove();
  if(cmd==='hidden')t.style.display='none';
  if(cmd==='visibility-hidden')t.style.visibility='hidden';
  if(cmd==='transparent')t.style.opacity='0';
  if(cmd==='inert')t.inert=true;
  if(cmd==='disabled')t.setAttribute('aria-disabled','true');
  phase='changed';
 }setTimeout(poll,30)}poll();</script>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const manifest = join(output, `${scenario}.yaml`);
	writeFileSync(
		manifest,
		`version: 3\nexpires_after: 10m\nidle_timeout: 3m\nresources:\n  browser:\n    profiles: [{kind: isolated}]\n    origins: ["about:blank", "${origin}"]\nallow:\n  tools: [browser_prepare, get_browser_state, browser_navigate, browser_click, browser_type]\n`,
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
			launch(op);
			const [result, receipt] = await Promise.all([outcome, terminal]);
			appendFileSync(
				join(output, "trace.jsonl"),
				`${encode({ scenario, name, result, receipt, elapsedMs: performance.now() - started })}\n`,
			);
			if (result.error) throw result.error;
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
		const target = rows.find((row) => row.role === "generic" && row.label === "Tempor");
		const positive = ["span", "div", "dialog"].includes(scenario);
		const staticNegative = ["no-handler", "other-event", "dialog-outside"].includes(scenario);
		if (staticNegative) assert.ok(!target?.actions?.includes("press"));
		else assert.ok(target?.actions?.includes("press"), "visible generic element needs proved click capability");
		if (!positive && !staticNegative) {
			command = scenario;
			await until(() => state?.phase === "changed");
		}
		if (positive) {
			const result = await call("click", (op) => op.startClick(target.elementToken));
			assert.ok(sdk.ComputerResult.Action.instanceOf(result));
			assert.equal(result.inner.value.effect, sdk.ActionEffect.Unverifiable);
			await until(() => state?.clicks === 1);
		} else if (target) {
			await assert.rejects(
				call("refused", (op) => op.startClick(target.elementToken)),
				(error) =>
					sdk.ComputerError.Refused.instanceOf(error) &&
					["browser_input_unavailable", "browser_node_stale", "browser_input_unconfirmed"].includes(
						error.inner.reason,
					),
			);
		}
		const prior = polls;
		await until(() => polls >= prior + 2);
		assert.equal(state.clicks, positive ? 1 : 0);
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
