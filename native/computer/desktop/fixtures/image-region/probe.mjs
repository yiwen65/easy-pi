import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

assert.equal(process.env.ALLOW_GUI_TESTS, "true");
const [fixturePath, bridgePath, mode, output] = process.argv.slice(2);
assert.ok(
	[
		"distant",
		"replace",
		"move",
		"cover",
		"transparent-cover",
		"reorder-cover",
		"scroll-distant",
		"scroll-replace",
		"scroll-move",
	].includes(mode),
);
assert.ok([fixturePath, bridgePath, output].every((path) => path && isAbsolute(path)));
mkdirSync(output);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fixture = spawn(fixturePath, [mode], { stdio: ["pipe", "pipe", "inherit"] });
const exited = new Promise((resolve) => fixture.once("exit", (code, signal) => resolve({ code, signal })));
const events = [];
const calls = [];
const lines = createInterface({ input: fixture.stdout });
lines.on("line", (line) => events.push(JSON.parse(line)));
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const timer = setTimeout(stop, 60000);
async function event(name) {
	const started = Date.now();
	while (Date.now() - started < 5000) {
		const index = events.findIndex((x) => x.event === name);
		if (index >= 0) return events.splice(index, 1)[0];
		if (controller.signal.aborted) throw new Error("aborted");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`fixture event timeout ${name}`);
}
let feature,
	action,
	oracle,
	failure,
	closed = false,
	fixtureExit;
let sequence = 0;
async function call(request) {
	const id = `region-${++sequence}`;
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
		ms: performance.now() - started,
		request,
		details: result.details,
		text: result.content.filter((x) => x.type === "text").map((x) => x.text),
	});
	return result;
}
try {
	await event("ready");
	const { createComputerFeature } = createRequire(import.meta.url)(bridgePath);
	feature = createComputerFeature();
	const inventory = await call({ op: "discover", title: "easy-pi-owned-region-guard" });
	const rows = inventory.content[0].text.split("\n").slice(1).filter(Boolean).map(JSON.parse);
	assert.equal(rows.length, 1);
	const view = await call({ op: "select", ref: rows[0].ref, observe: "image" });
	if (mode.startsWith("scroll-")) {
		fixture.stdin.write("state\n");
		assert.equal((await event("state")).scrollY, 500);
	}
	fixture.stdin.write("mutate\n");
	await event("mutated");
	action = await call({
		op: "segment",
		ref: view.details.imageRef,
		actions: [
			mode.startsWith("scroll-")
				? { op: "scroll", point: { ref: view.details.imageRef, x: 160, y: 226 }, deltaX: 0, deltaY: 5 }
				: { op: "click", point: { ref: view.details.imageRef, x: 160, y: 226 } },
		],
		expected: {
			kind: "visual",
			description: "Owned target receives the requested input; changed targets must not receive input",
		},
	});
	fixture.stdin.write("state\n");
	oracle = await event("state");
	if (mode === "scroll-distant") {
		assert.notEqual(oracle.scrollY, 500);
		assert.equal(action.details.actions[0]?.dispatch, "dispatched");
	} else if (mode === "distant") {
		assert.equal(oracle.clicks, 1);
		assert.equal(oracle.covered, 0);
		assert.equal(action.details.actions[0]?.dispatch, "dispatched");
	} else {
		assert.equal(oracle.clicks, 0);
		assert.equal(oracle.covered, 0);
		assert.equal(action.details.actions[0]?.dispatch, "not_dispatched");
		assert.equal(action.details.actions[0]?.code, "stale_image_observation");
		assert.equal(action.details.terminal.inputCommitted, false);
		if (mode.startsWith("scroll-")) {
			assert.equal(oracle.scrollY, 500);
			assert.equal(oracle.retiredScrollY, 500);
		}
	}
} catch (error) {
	failure = `${String(error)}${error?.inner?.reason ? `: ${error.inner.reason}` : ""}`;
} finally {
	try {
		await feature?.close();
		closed = true;
	} catch (error) {
		failure ??= String(error);
	}
	if (closed) {
		fixture.stdin.end("quit\n");
		fixtureExit = await exited;
		lines.close();
	}
	clearTimeout(timer);
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
}
const lease = readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8").trim();
const passed =
	!failure &&
	!controller.signal.aborted &&
	closed &&
	fixtureExit?.code === 0 &&
	lease.startsWith("pi-computer-desktop-v1 C ");
const report = {
	mode,
	passed,
	failure,
	closed,
	fixtureExit,
	lease,
	oracle,
	calls,
	bridgeSha256: sha(bridgePath),
	nativeSha256: sha(
		join(dirname(bridgePath), "sdk/node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib"),
	),
	fixtureSha256: sha(fixturePath),
	probeSha256: sha(new URL(import.meta.url)),
};
writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;
