import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadDesktopSdk } from "../../loader.ts";

assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [output, sdkDirectory, renderer, bundle] = process.argv.slice(2);
assert.ok([output, sdkDirectory, renderer, bundle].every((value) => value && isAbsolute(value)));
mkdirSync(output, { mode: 0o700 });
writeFileSync(join(output, "select-guards.mjs"), readFileSync(new URL(import.meta.url)));
const sdk = loadDesktopSdk(sdkDirectory);
const scenarios = [
	"single",
	"listbox",
	"unicode",
	"duplicate-values",
	"dialog",
	"disabled-option",
	"disabled-group",
	"disabled-select",
	"multiple",
	"moved",
	"label-changed",
	"value-changed",
	"parent-disabled",
	"parent-multiple",
	"removed",
];
const positive = new Set(["single", "listbox", "unicode", "duplicate-values", "dialog"]);
const staticRefused = new Set(["disabled-option", "disabled-group", "disabled-select", "multiple"]);
const samples = [];
const encode = (value) => JSON.stringify(value, (_, item) => (typeof item === "bigint" ? String(item) : item));
async function until(predicate) {
	const deadline = performance.now() + 5000;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, "fixture handshake timeout");
		await delay(20);
	}
}
for (const scenario of scenarios) {
	let state,
		command = "",
		polls = 0;
	const label = scenario === "unicode" ? "专业版 你好 café" : "Pro";
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
		response.end(`<!doctype html><meta charset="utf-8"><title>Owned select fixture</title><dialog id="dialog"></dialog><main id="main">
<label>Plan <select id="plan" ${scenario === "listbox" ? 'size="3"' : ""} ${scenario === "multiple" ? "multiple" : ""} ${scenario === "disabled-select" ? "disabled" : ""}>
<option value="free">Free</option><optgroup label="Paid" ${scenario === "disabled-group" ? "disabled" : ""}><option id="target" value="${scenario === "duplicate-values" ? "free" : "pro"}" ${scenario === "disabled-option" ? "disabled" : ""}>${label}</option></optgroup></select></label>
<label>Other <select id="other"><option>Free</option><option>Pro</option></select></label></main>
<script>
const scenario=${JSON.stringify(scenario)}, plan=document.getElementById('plan'), other=document.getElementById('other'), target=document.getElementById('target');
let inputs=0,changes=0,phase='ready';document.addEventListener('input',()=>inputs++);document.addEventListener('change',()=>changes++);
if(scenario==='dialog'){const d=document.getElementById('dialog');d.append(document.getElementById('main'));d.showModal()}
async function poll(){
 const command=await (await fetch('/state',{method:'POST',body:JSON.stringify({phase,inputs,changes,index:plan.selectedIndex,value:plan.value,otherIndex:other.selectedIndex})})).json();
 if(command && phase!=='changed'){
  if(command==='moved') other.append(target);
  if(command==='label-changed') target.label='Changed';
  if(command==='value-changed') target.value='changed';
  if(command==='parent-disabled') plan.disabled=true;
  if(command==='parent-multiple') plan.multiple=true;
  if(command==='removed') target.remove();
  phase='changed';
 }
 setTimeout(poll,30);
}poll();</script>`);
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
	const operations = [],
		start = performance.now();
	const run = async (name, launch) => {
		const operation = session.newOperation();
		operations.push(operation);
		const result = operation.result().then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		const terminal = operation.terminal(),
			timer = setTimeout(() => operation.cancel(), 15000);
		try {
			launch(operation);
			const [outcome, receipt] = await Promise.all([result, terminal]);
			appendFileSync(join(output, "trace.jsonl"), `${encode({ scenario, name, outcome, receipt })}\n`);
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
		const observed = await run("observe", (op) => op.startObserve(512, 32));
		assert.ok(sdk.ComputerResult.Observation.instanceOf(observed));
		const matches = observed.inner.value.elements.filter(
			(row) => row.role === "option" && row.label === label && row.valueDescription === "Plan ",
		);
		assert.equal(matches.length, 1, "exact option/menu context required");
		const option = matches[0];
		if (staticRefused.has(scenario)) assert.ok(!option.actions?.includes("select_option"));
		else assert.ok(option.actions?.includes("select_option"));
		if (!positive.has(scenario) && !staticRefused.has(scenario)) {
			command = scenario;
			await until(() => state?.phase === "changed");
		}
		if (positive.has(scenario)) {
			const result = await run("select", (op) => op.startClick(option.elementToken));
			assert.ok(sdk.ComputerResult.Action.instanceOf(result));
			assert.equal(result.inner.value.effect, sdk.ActionEffect.Confirmed);
			assert.ok(result.inner.value.evidence?.some((item) => item.kind === sdk.ActionEvidenceKind.ValueReadback));
			await until(() => state?.changes === 1);
			assert.deepEqual(
				{ index: state.index, value: state.value, otherIndex: state.otherIndex, inputs: state.inputs },
				{ index: 1, value: scenario === "duplicate-values" ? "free" : "pro", otherIndex: 0, inputs: 1 },
			);
		} else {
			await assert.rejects(
				run("select-refused", (op) => op.startClick(option.elementToken)),
				(error) =>
					sdk.ComputerError.Refused.instanceOf(error) &&
					["browser_input_unavailable", "browser_node_stale", "browser_input_unconfirmed"].includes(
						error.inner.reason,
					),
			);
			const after = polls;
			await until(() => polls >= after + 2);
			assert.equal(state.inputs, 0);
			assert.equal(state.changes, 0);
			assert.equal(state.otherIndex, 0);
		}
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
	"select qualification failed; all samples retained",
);
