import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { launchChrome, until } from "./chrome.mjs";

// No model or personal applications. CDP is setup/readback/close only.
assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [output, bundle, fixturePath, bridgePath, mode = "background"] = process.argv.slice(2);
assert.ok([output, bundle, fixturePath, bridgePath].every((path) => path && isAbsolute(path)));
assert.ok(["background", "foreground"].includes(mode));
mkdirSync(output, { mode: 0o700 });
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(join(output, "probe.mjs"), readFileSync(new URL(import.meta.url)));
const { createComputerFeature } = createRequire(import.meta.url)(bridgePath);
const server = createServer((_request, response) => {
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.end(
		'<!doctype html><title>Owned background fill guard</title><label>Owned name<input id="name" aria-label="Owned name"></label>',
	);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const deadline = setTimeout(stop, 60_000);
const events = [],
	calls = [];
let chrome, fixture, lines, fixtureExit, feature, failure, value, other, cleanup;
let sequence = 0;
const rows = (result) => result.content[0].text.split("\n").slice(1).filter(Boolean).map(JSON.parse);
async function call(request) {
	const id = `background-fill-${++sequence}`;
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
	calls.push({ request, details: result.details });
	return result;
}
async function select(title) {
	const windows = rows(await call({ op: "discover", title }));
	assert.equal(windows.length, 1);
	return call({ op: "select", ref: windows[0].ref, observe: true });
}
async function activate(view) {
	const result = await call({
		op: "segment",
		ref: view.details.observationRef,
		actions: [{ op: "window", action: "activate" }],
		expected: { kind: "window_focused" },
	});
	assert.equal(result.details.status, "confirmed");
}
try {
	chrome = await launchChrome(
		bundle,
		mkdtempSync("/private/tmp/epi-background-fill-"),
		`http://127.0.0.1:${server.address().port}/`,
	);
	fixture = spawn(fixturePath, ["unicode-edit"], { stdio: ["pipe", "pipe", "inherit"] });
	fixtureExit = new Promise((resolve) => fixture.once("exit", (code, signal) => resolve({ code, signal })));
	lines = createInterface({ input: fixture.stdout });
	lines.on("line", (line) => events.push(JSON.parse(line)));
	await until(() => events.some((event) => event.event === "ready"));
	feature = createComputerFeature();
	await activate(await select("easy-pi-owned-general-main"));
	let view = await select("Owned background fill guard");
	// Chrome initializes its web accessibility subtree asynchronously. No input retry.
	await until(async () => {
		view = await call({ op: "observe" });
		return rows(view).some((row) => row.label === "Owned name" && row.role === "AXTextField");
	}, 3000);
	if (mode === "foreground") {
		await activate(view);
		view = await call({ op: "observe" });
	}
	assert.equal(
		await chrome.evaluate("document.hasFocus()"),
		mode === "foreground",
		"control must establish the requested focus state",
	);
	const field = rows(view).find((row) => row.label === "Owned name" && row.role === "AXTextField");
	assert.ok(field?.ref);
	const text = "test café 你好";
	const result = await call({
		op: "segment",
		ref: view.details.observationRef,
		actions: [{ op: "fill", target: { ref: field.ref }, text }],
		expected: { kind: "value", target: { selector: { role: "AXTextField", label: "Owned name" } }, value: text },
	});
	assert.equal(result.details.actions[0]?.dispatch, "dispatched");
	await until(async () => {
		value = await chrome.evaluate('document.getElementById("name").value');
		return value === text;
	}, 1500);
	fixture.stdin.write("state final\n");
	other = await until(() => events.find((event) => event.event === "state" && event.id === "final"));
	assert.equal(other.body, "original", "the owned other window must remain untouched");
	const fresh = await call({ op: "observe" });
	assert.equal(rows(fresh).find((row) => row.label === "Owned name" && row.role === "AXTextField")?.value, text);
	if (result.details.status === "needs_observation")
		await call({ op: "reconcile", ref: fresh.details.observationRef, previousEffect: "observed" });
} catch (error) {
	failure = `${String(error)}${error?.inner?.reason ? `: ${error.inner.reason}` : ""}`;
} finally {
	cleanup = { native: false, fixture: false, chrome: false };
	try {
		await feature?.close();
		cleanup.native = true;
	} catch (error) {
		failure ??= String(error);
	}
	// Unknown native drain must not destroy its potential input targets.
	if (cleanup.native && fixture) {
		fixture.stdin.end("quit\n");
		cleanup.fixture = (await fixtureExit).code === 0;
		lines.close();
	}
	if (cleanup.native && chrome) {
		try {
			const closed = await chrome.close();
			cleanup.chrome = closed.code === 0 && closed.processGroupDrained;
		} catch (error) {
			failure ??= String(error);
		}
	}
	await new Promise((resolve) => server.close(resolve));
	clearTimeout(deadline);
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
}
const lease = readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8").trim();
const passed =
	!failure &&
	!controller.signal.aborted &&
	Object.values(cleanup).every(Boolean) &&
	lease.startsWith("pi-computer-desktop-v1 C ");
const report = {
	mode,
	passed,
	failure,
	value,
	other,
	calls,
	cleanup,
	lease,
	bridgeSha256: sha(bridgePath),
	fixtureSha256: sha(fixturePath),
};
writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;
