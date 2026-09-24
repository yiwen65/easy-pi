import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadDesktopSdk } from "../../loader.ts";

// Deterministic native qualification, not a model benchmark. No personal profile.
assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [output, sdkDirectory, renderer, bundle] = process.argv.slice(2);
assert.ok([output, sdkDirectory, renderer, bundle].every((value) => value && isAbsolute(value)));
mkdirSync(output, { mode: 0o700 });
writeFileSync(join(output, "dialog-guards.mjs"), readFileSync(new URL(import.meta.url)));
const sdk = loadDesktopSdk(sdkDirectory);
const scenarios = [
	"positive",
	"outside",
	"aria",
	"multiple",
	"subframe",
	"appeared",
	"moved",
	"closed",
	"replaced",
	"second",
	"native-alert",
];
const samples = [];
const encode = (value) => JSON.stringify(value, (_, item) => (typeof item === "bigint" ? String(item) : item));
async function until(predicate) {
	const deadline = performance.now() + 5000;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, "fixture handshake deadline exceeded");
		await delay(20);
	}
}
for (const scenario of scenarios) {
	let state,
		command = "",
		polls = 0;
	const server = createServer((request, response) => {
		if (request.url === "/state" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
				if (body.length > 4096) request.destroy();
			});
			request.on("end", () => {
				state = JSON.parse(body);
				polls++;
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify(command));
			});
			return;
		}
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		response.end(`<!doctype html><meta charset="utf-8"><title>Owned dialog guard fixture</title>
<button id="background">Background</button><dialog id="dialog"><label>Comment <input id="comment"></label><button id="confirm">Confirm</button></dialog><dialog id="other">Other</dialog>
<script>
const scenario=${JSON.stringify(scenario)}, dialog=document.getElementById('dialog'), other=document.getElementById('other');
let writes=0,phase='ready',receipt=null;
document.addEventListener('input',()=>writes++);
document.getElementById('background').onclick=()=>writes++;
document.getElementById('confirm').onclick=()=>{writes++;receipt=document.getElementById('comment').value};
if(scenario==='aria'){const d=document.createElement('div');d.setAttribute('role','dialog');d.textContent='ARIA only';document.body.append(d)}
else if(!['appeared','native-alert','subframe'].includes(scenario)) dialog.show();
if(scenario==='multiple') other.show();
async function poll(){
 const command=await (await fetch('/state',{method:'POST',body:JSON.stringify({writes,phase,receipt})})).json();
 if(command && phase!=='changed'){
  if(command==='appeared') dialog.showModal();
  if(command==='moved') document.body.append(document.getElementById('confirm'));
  if(command==='closed') dialog.close();
  if(command==='replaced'){const clone=dialog.cloneNode(true);dialog.replaceWith(clone)}
  if(command==='second') other.show();
  if(command==='subframe') document.body.append(document.createElement('iframe'));
  phase='changed';
  if(command==='native-alert'){
   await fetch('/state',{method:'POST',body:JSON.stringify({writes,phase,receipt})});
   alert('Native alert must remain refused');
  }
 }
 setTimeout(poll,30);
}
poll();
</script>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const manifest = join(output, `${scenario}.yaml`);
	writeFileSync(
		manifest,
		`version: 3\nexpires_after: 10m\nidle_timeout: 3m\nresources:\n  browser:\n    profiles: [{kind: isolated}]\n    origins: ["about:blank", "${origin}"]\nallow:\n  tools: [browser_prepare, get_browser_state, browser_navigate, browser_click, browser_type]\n`,
	);
	let host,
		session,
		failure,
		cleanup = false;
	const operations = [];
	const start = performance.now();
	const run = async (name, launch) => {
		const operation = session.newOperation();
		operations.push(operation);
		const result = operation.result().then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		const terminal = operation.terminal();
		const timer = setTimeout(() => operation.cancel(), 15000);
		try {
			launch(operation);
			const [outcome, receipt] = await Promise.all([result, terminal]);
			appendFileSync(join(output, "trace.jsonl"), `${encode({ scenario, name, outcome, receipt })}\n`);
			if (name === "observe-refused") assert.equal(receipt.inputCommitted, false);
			if (outcome.error) throw outcome.error;
			return outcome.value;
		} finally {
			clearTimeout(timer);
		}
	};
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
		await run("prepare", (op) => op.startPrepare());
		await run("navigate", (op) => op.startNavigate(origin));
		await until(() => state?.phase === "ready");
		if (["subframe", "native-alert"].includes(scenario)) {
			command = scenario;
			await until(() => state?.phase === "changed");
		}
		if (scenario === "native-alert") await delay(300);
		if (["aria", "multiple", "subframe", "native-alert"].includes(scenario)) {
			await assert.rejects(
				run("observe-refused", (op) => op.startObserve(512, 32)),
				(error) =>
					sdk.ComputerError.Refused.instanceOf(error) &&
					// Live page attestation precedes observe; its provider deliberately
					// projects target/frame/native-window failures to this outer code.
					(["native-alert", "subframe"].includes(scenario)
						? error.inner.reason === "authorization_host_failed"
						: error.inner.reason === "unexpected_modal_surface"),
			);
		} else {
			const observed = await run("observe", (op) => op.startObserve(512, 32));
			assert.ok(sdk.ComputerResult.Observation.instanceOf(observed));
			const view = observed.inner.value;
			const label = ["outside", "appeared"].includes(scenario) ? "Background" : "Confirm";
			const target = view.elements.find((row) => row.role === "button" && row.label === label);
			assert.ok(target?.elementToken, "exact target missing");
			if (scenario === "positive") {
				const field = view.elements.find((row) => row.role === "textbox" && row.label?.trim() === "Comment");
				const plan = await run("fill", (op) =>
					op.startPlan({
						snapshotId: view.snapshotId,
						steps: [
							new sdk.ComputerStep.Fill({
								target: new sdk.ComputerAddress.Ref({ token: field.elementToken }),
								text: "approved 你好",
							}),
						],
					}),
				);
				assert.ok(sdk.ComputerResult.Plan.instanceOf(plan));
				assert.equal(plan.inner.value.status, sdk.ComputerPlanStatus.Completed);
				const fresh = await run("observe-after-fill", (op) => op.startObserve(512, 32));
				await run("confirm", (op) =>
					op.startClick(fresh.inner.value.elements.find((row) => row.label === "Confirm").elementToken),
				);
				await until(() => state?.receipt === "approved 你好");
			} else {
				if (scenario === "outside") assert.equal(target.enabled, false);
				else {
					command = scenario;
					await until(() => state?.phase === "changed");
				}
				await assert.rejects(
					run("click-refused", (op) => op.startClick(target.elementToken)),
					(error) =>
						sdk.ComputerError.Refused.instanceOf(error) &&
						error.inner.reason ===
							(scenario === "outside" ? "browser_input_unavailable" : "browser_input_unconfirmed"),
				);
				const after = polls;
				await until(() => polls >= after + 2);
				assert.equal(state.writes, 0, "refused action mutated the page");
			}
		}
		if (scenario !== "positive") assert.equal(state.writes, 0);
	} catch (error) {
		failure = String(error);
	} finally {
		if (host)
			try {
				host.revoke();
				await host.close();
				for (const operation of operations) operation.uniffiDestroy();
				session?.uniffiDestroy();
				host.uniffiDestroy();
				cleanup = /^pi-computer-desktop-v1 C /.test(
					readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8"),
				);
			} catch (error) {
				failure ??= `close unproved: ${String(error)}`;
			}
		await new Promise((resolve) => server.close(resolve));
	}
	const sample = { scenario, passed: !failure && cleanup, failure, cleanup, state, ms: performance.now() - start };
	samples.push(sample);
	writeFileSync(join(output, "results.json"), encode(samples));
	console.log(encode(sample));
	if (!cleanup) break;
}
assert.equal(samples.length, scenarios.length);
assert.ok(
	samples.every((sample) => sample.passed),
	"dialog qualification failed; retain all samples",
);
