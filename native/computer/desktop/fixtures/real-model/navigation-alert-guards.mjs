import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadDesktopSdk } from "../../loader.ts";

// Native-owned Chrome only. No model, personal profile, prompt dismissal or retry.
assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [output, sdkDirectory, renderer, bundle] = process.argv.slice(2);
assert.ok([output, sdkDirectory, renderer, bundle].every((value) => value && isAbsolute(value)));
mkdirSync(output, { mode: 0o700 });
writeFileSync(join(output, "navigation-alert-guards.mjs"), readFileSync(new URL(import.meta.url)));
const sdk = loadDesktopSdk(sdkDirectory);
const timings = [-1, 0, 10, 100, 0, 10, 100];
const samples = [];
const encode = (value) => JSON.stringify(value, (_, item) => (typeof item === "bigint" ? String(item) : item));
for (const [index, alertMs] of timings.entries()) {
	let phase = "not-opened";
	const server = createServer((request, response) => {
		if (request.url === "/opened" || request.url === "/returned") {
			phase = request.url.slice(1);
			response.end("ok");
			return;
		}
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		response.end(`<!doctype html><title>Owned navigation alert fixture</title><p>Ready</p><script>
        ${alertMs < 0 ? "" : `setTimeout(()=>{navigator.sendBeacon('/opened');alert('Owned test prompt');navigator.sendBeacon('/returned')},${alertMs})`}
        </script>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const manifest = join(output, `${index}.yaml`);
	writeFileSync(
		manifest,
		`version: 3\nexpires_after: 10m\nidle_timeout: 3m\nresources:\n  browser:\n    profiles: [{kind: isolated}]\n    origins: ["about:blank", "${origin}"]\nallow:\n  tools: [browser_prepare, get_browser_state, browser_navigate, browser_click, browser_type]\n`,
	);
	const operations = [],
		events = [];
	let host,
		session,
		failure,
		cleanup = false,
		checkedPhase;
	const run = async (name, launch) => {
		const operation = session.newOperation();
		operations.push(operation);
		const started = performance.now();
		const result = operation.result().then(
			(value) => ({ value }),
			(error) => ({ error: String(error), reason: error?.inner?.reason }),
		);
		const terminal = operation.terminal();
		let cancelled = false;
		const timer = setTimeout(() => {
			cancelled = true;
			operation.cancel();
		}, 15000);
		try {
			launch(operation);
			const [outcome, receipt] = await Promise.all([result, terminal]);
			const event = { name, ms: performance.now() - started, cancelled, outcome, receipt };
			events.push(event);
			appendFileSync(join(output, "trace.jsonl"), `${encode({ index, alertMs, ...event })}\n`);
			return event;
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
		const prepare = await run("prepare", (op) => op.startPrepare());
		assert.ok(prepare.outcome.value, "prepare failed");
		const navigate = await run("navigate", (op) => op.startNavigate(origin));
		assert.ok(!navigate.cancelled && navigate.ms < 3000, "navigation was not bounded");
		if (navigate.outcome.value) {
			await delay(500);
			const observe = await run("observe", (op) => op.startObserve(512, 32));
			assert.ok(!observe.cancelled && observe.ms < 3000, "observation was not bounded");
			if (alertMs < 0) assert.ok(observe.outcome.value);
			else assert.equal(observe.outcome.reason, "authorization_host_failed");
			assert.equal(observe.receipt.inputCommitted, false);
		} else {
			assert.ok(alertMs >= 0);
			assert.equal(navigate.outcome.reason, "unexpected_modal_surface");
		}
		if (alertMs >= 0) {
			const deadline = performance.now() + 2000;
			while (phase === "not-opened" && performance.now() < deadline) await delay(20);
			assert.equal(phase, "opened", "prompt never opened or was silently dismissed");
		}
		checkedPhase = phase;
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
				failure ??= `close unproved: ${error}`;
			}
		await new Promise((resolve) => server.close(resolve));
	}
	const sample = { index, alertMs, passed: !failure && cleanup, failure, cleanup, checkedPhase, events };
	samples.push(sample);
	writeFileSync(join(output, "results.json"), encode(samples));
	console.log(
		encode({
			index,
			alertMs,
			passed: sample.passed,
			failure,
			cleanup,
			checkedPhase,
			times: events.map(({ name, ms }) => ({ name, ms })),
		}),
	);
	if (!cleanup) break;
}
assert.equal(samples.length, timings.length);
assert.ok(
	samples.every((sample) => sample.passed),
	"navigation alert qualification failed; retain all samples",
);
