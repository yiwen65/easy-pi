import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const [fixturePath, bridgePath, requestedMode, strategy = "combined"] = process.argv.slice(2);
const mode = requestedMode === "save" ? undefined : requestedMode;
assert.ok(["combined", "split"].includes(strategy));
const benchmark = process.env.COMPUTER_BENCHMARK === "true";
const buffered = [];
function log(...args) {
	if (benchmark) buffered.push(args);
	else console.log(...args);
}
assert.equal(process.env.ALLOW_GUI_TESTS, "true", "Explicit owned-fixture GUI opt-in required");
assert.ok(fixturePath && bridgePath && isAbsolute(fixturePath) && isAbsolute(bridgePath));
const loadStart = performance.now();
const { createComputerFeature } = createRequire(import.meta.url)(bridgePath);
const loadMs = performance.now() - loadStart;
const fixtureStart = performance.now();
const directory = mkdtempSync("/tmp/easy-pi-owned-saved-");
assert.ok(mode === undefined || ["broken-synthetic", "working-synthetic", "image-synthetic"].includes(mode));
const fixture = spawn(fixturePath, [directory, ...(mode ? [mode] : [])], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: fixture.stdout });
const events = [];
lines.on("line", (line) => {
	log("FIXTURE", line);
	events.push(JSON.parse(line));
});
const exit = new Promise((resolve) => fixture.on("exit", (code, signal) => resolve({ code, signal })));
async function event(name) {
	const found = events.find((row) => row.event === name);
	if (found) return found;
	if (fixture.exitCode !== null) throw Error("fixture exited");
	return new Promise((resolve, reject) => {
		const finish = (error, value) => {
			clearTimeout(timer);
			lines.off("line", onLine);
			fixture.off("exit", onExit);
			if (error) reject(error);
			else resolve(value);
		};
		const onLine = () => {
			const value = events.find((row) => row.event === name);
			if (value) finish(undefined, value);
		};
		const onExit = () => finish(Error("fixture exited"));
		const timer = setTimeout(() => finish(Error(`missing fixture event ${name}`)), 10000);
		lines.on("line", onLine);
		fixture.on("exit", onExit);
	});
}
let feature;
let seq = 0;
let taskStart;
let taskEnd;
let failure;
const calls = [];
const controller = new AbortController();
const stop = () => controller.abort(new Error("E2E stopped"));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const deadline = setTimeout(stop, 60_000);
deadline.unref();
async function call(request) {
	const id = `save-${++seq}`;
	const started = performance.now();
	let result;
	try {
		result = await feature.binding.tools[0].execute(id, { request }, controller.signal, undefined, {});
	} catch (error) {
		calls.push({ op: request.op, ms: performance.now() - started, status: "thrown", code: error.details?.code });
		throw error;
	}
	calls.push({
		op: request.op,
		ms: performance.now() - started,
		status: result.details?.status,
		nativeMs: result.details?.elapsedMs,
	});
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
	log(
		"RESULT",
		JSON.stringify({
			request,
			details: result.details,
			text: result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n"),
		}),
	);
	return result;
}
async function select(ref) {
	if (strategy === "combined") return call({ op: "select", ref, observe: true });
	await call({ op: "select", ref });
	return call({ op: "observe" });
}
const rows = (r) => r.content[0].text.split("\n").slice(1).filter(Boolean).map(JSON.parse);
try {
	const ready = await event("ready");
	taskStart = performance.now();
	feature = createComputerFeature();
	if (mode || !benchmark) {
		const parents = rows(await call({ op: "discover", title: "easy-pi-owned-save-document" }));
		assert.equal(parents.length, 1);
		const parent =
			mode === "image-synthetic"
				? await call({ op: "select", ref: parents[0].ref, observe: "image" })
				: await select(parents[0].ref);
		if (mode === "image-synthetic") {
			assert.ok(parent.content.some((row) => row.type === "image"));
			assert.ok(parent.details.imageRef);
			assert.equal(parent.details.selected, true);
			const result = await call({
				op: "segment",
				ref: parent.details.imageRef,
				actions: [{ op: "key", key: "Tab" }],
				expected: { kind: "visual", description: "A single tab appended in the owned editor" },
			});
			assert.equal(result.details.actions[0]?.dispatch, "dispatched");
			fixture.stdin.write("state\n");
			const state = await event("state");
			assert.equal(state.body, `${ready.body}\t`);
			const fresh = await call({ op: "observe" });
			assert.equal(rows(fresh).find((row) => row.identifier === "reopened-body")?.value, state.body);
			log("IMAGE_SELECT_INPUT_PASS");
		} else if (mode) {
			const field = rows(parent).find((r) => r.identifier === "reopened-body");
			assert.ok(field?.ref);
			const result = await call({
				op: "segment",
				ref: parent.details.observationRef,
				actions: [{ op: "fill", target: { ref: field.ref }, text: "replacement only" }],
				expected: {
					kind: "value",
					target: { selector: { identifier: "reopened-body" } },
					value: "replacement only",
				},
			});
			fixture.stdin.write("state\n");
			const state = await event("state");
			if (mode === "broken-synthetic") {
				assert.equal(state.body, field.value);
				assert.ok(
					result.details.actions.some((row) => row.code === "replacement_selection_unproved"),
					JSON.stringify(result.details),
				);
			} else {
				assert.equal(state.body, "replacement only");
				assert.ok(["confirmed", "needs_observation"].includes(result.details.status));
				assert.equal(result.details.actions[0].action.route, "synthetic_events");
				const fresh = await call({ op: "observe" });
				assert.equal(rows(fresh).find((r) => r.identifier === "reopened-body")?.value, "replacement only");
			}
			log("SYNTHETIC_SELECTION_PASS", mode);
		} else {
			if (parent.details.status === "observed")
				assert.ok(
					!rows(parent).some((r) => r.identifier === "saveAsNameTextField"),
					"parent must not acquire its child sheet",
				);
			else assert.ok(["native_refused", "refused"].includes(parent.details.status), JSON.stringify(parent.details));
		}
	}
	if (!mode) {
		const windows = rows(await call({ op: "discover", title: "easy-pi-owned-save-panel" }));
		assert.equal(windows.length, 1);
		const before = await select(windows[0].ref);
		const field = rows(before).find((r) => r.identifier === "saveAsNameTextField");
		assert.ok(field?.ref, "filename is visible and granted");
		const name = "替换 filename.md";
		const filled = await call({
			op: "segment",
			ref: before.details.observationRef,
			actions: [{ op: "fill", target: { ref: field.ref }, text: name }],
			expected: { kind: "value", target: { selector: { identifier: "saveAsNameTextField" } }, value: name },
		});
		assert.equal(filled.details.status, "confirmed");
		if (!benchmark)
			await assert.rejects(
				call({
					op: "segment",
					ref: before.details.observationRef,
					actions: [{ op: "fill", target: { ref: field.ref }, text: "MUST NOT APPEND" }],
					expected: { kind: "visual", description: "Must refuse consumed observation" },
				}),
				(error) => error.details?.code === "stale_observation",
			);
		const after = await call({ op: "observe" });
		assert.equal(rows(after).find((r) => r.identifier === "saveAsNameTextField")?.value, name);
		fixture.stdin.write("state\n");
		const original = await event("state");
		assert.equal(original.name, name);
		await call({
			op: "segment",
			ref: after.details.observationRef,
			actions: [{ op: "key", key: "Return" }],
			expected: { kind: "visual", description: "Owned test document saved and panel closed" },
		});
		const saved = await event("saved");
		assert.equal(saved.name, name);
		assert.equal(saved.path, `${directory}/${name}`);
		// Retire the old panel's uncertain visual effect only after actual evidence.
		const catalog = await call({ op: "discover", title: "easy-pi-owned-save-document" });
		const docs = rows(catalog);
		assert.equal(docs.length, 1);
		const doc = await select(docs[0].ref);
		await call({
			op: "segment",
			ref: doc.details.observationRef,
			actions: [{ op: "key", key: "o", modifiers: ["command"] }],
			expected: { kind: "visual", description: "Owned saved document reopened" },
		});
		const reopened = await event("reopened");
		assert.equal(reopened.body, original.body);
		const view = await call({ op: "observe" });
		assert.equal(rows(view).find((r) => r.identifier === "reopened-body")?.value, reopened.body);
		assert.equal(readFileSync(saved.path, "utf8"), reopened.body);
		log("SAVE_REOPEN_PASS", JSON.stringify({ name, bytes: Buffer.byteLength(reopened.body), directory }));
	}
	taskEnd = performance.now();
} catch (error) {
	failure = { message: error.message, code: error.details?.code };
	throw error;
} finally {
	const closeStart = performance.now();
	let closed = false;
	let fixtureExit;
	try {
		await feature?.close();
		closed = true;
	} finally {
		fixture.stdin.end("quit\n");
		fixtureExit = await exit;
		lines.close();
		clearTimeout(deadline);
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		const closeMs = performance.now() - closeStart;
		for (const args of buffered) console.log(...args);
		console.log(
			"E2E_SAMPLE",
			JSON.stringify({
				scenario: mode ?? "save",
				strategy,
				passed: taskEnd !== undefined && !controller.signal.aborted && closed && fixtureExit.code === 0,
				failure,
				loadMs,
				setupMs: taskStart === undefined ? null : taskStart - fixtureStart,
				taskMs: taskEnd === undefined ? null : loadMs + taskEnd - taskStart,
				attemptMs: loadMs + (taskEnd ?? closeStart) - (taskStart ?? closeStart),
				closeMs,
				closed,
				fixtureExit,
				calls,
				directory,
				lease: readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8").trim(),
			}),
		);
	}
}
