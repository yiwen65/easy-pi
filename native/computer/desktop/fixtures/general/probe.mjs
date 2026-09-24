import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { protectionScenarios, scenarios } from "./scenarios.mjs";

const [fixturePath, bridgePath, scenario] = process.argv.slice(2);
assert.equal(process.env.ALLOW_GUI_TESTS, "true");
assert.ok([fixturePath, bridgePath].every((path) => path && isAbsolute(path)));
assert.ok(scenarios.includes(scenario));
const loadStart = performance.now();
const { createComputerFeature } = createRequire(import.meta.url)(bridgePath);
const loadMs = performance.now() - loadStart;
const setupStart = performance.now();
const fixture = spawn(fixturePath, [scenario], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: fixture.stdout });
const events = [];
lines.on("line", (line) => events.push(JSON.parse(line)));
const exit = new Promise((resolve) => fixture.on("exit", (code, signal) => resolve({ code, signal })));
async function event(predicate) {
	const until = performance.now() + 10_000;
	while (performance.now() < until) {
		const found = events.find(predicate);
		if (found) return found;
		assert.equal(fixture.exitCode, null, "fixture exited before readback");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw Error("fixture readback deadline exceeded");
}
let stateSeq = 0;
async function state() {
	const id = String(++stateSeq);
	fixture.stdin.write(`state ${id}\n`);
	return event((row) => row.event === "state" && row.id === id);
}
let feature;
let seq = 0;
let taskStart;
let taskEnd;
let failure;
const calls = [];
const log = [];
const controller = new AbortController();
const stop = () => controller.abort(new Error("general E2E stopped"));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const deadline = setTimeout(stop, 60_000);
deadline.unref();
async function call(request, signal = controller.signal) {
	const id = `general-${++seq}`;
	const started = performance.now();
	try {
		const result = await feature.binding.tools[0].execute(id, { request }, signal, undefined, {});
		calls.push({ op: request.op, ms: performance.now() - started, status: result.details?.status });
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
		log.push({
			request,
			details: result.details,
			text: result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n"),
		});
		return result;
	} catch (error) {
		calls.push({ op: request.op, ms: performance.now() - started, status: "thrown", code: error.details?.code });
		log.push({ request, error: error.message, code: error.details?.code });
		throw error;
	}
}
const rows = (result) => result.content[0].text.split("\n").slice(1).filter(Boolean).map(JSON.parse);
async function select(title = "main", observe = true) {
	const windows = rows(await call({ op: "discover", title: `easy-pi-owned-general-${title}` }));
	assert.equal(windows.length, 1);
	return call({ op: "select", ref: windows[0].ref, observe });
}
async function fill(view, text, identifier = "general-editor") {
	const field = rows(view).find((row) => row.identifier === identifier);
	assert.ok(field?.ref, `missing ${identifier}`);
	const result = await call({
		op: "segment",
		ref: view.details.observationRef,
		actions: [{ op: "fill", target: { ref: field.ref }, text }],
		expected: { kind: "value", target: { selector: { identifier } }, value: text },
	});
	assert.ok(["confirmed", "needs_observation"].includes(result.details.status), JSON.stringify(result.details));
	assert.equal(result.details.actions[0]?.dispatch, "dispatched");
	const fresh = await call({ op: "observe" });
	assert.equal(rows(fresh).find((row) => row.identifier === identifier)?.value, text);
	const actual = await state();
	assert.equal(identifier === "other-editor" ? actual.other : actual.body, text);
	log.push({ oracle: actual });
	if (result.details.status === "needs_observation") {
		await call({ op: "reconcile", ref: fresh.details.observationRef, previousEffect: "observed" });
	}
}
const visual = { kind: "visual", description: "Owned fixture event state must match requested action" };
try {
	await event((row) => row.event === "ready");
	taskStart = performance.now();
	feature = createComputerFeature();
	if (scenario === "pointer-cancel") {
		const view = await select("main", "image");
		const point = {
			ref: view.details.imageRef,
			x: Math.floor(view.details.width / 4),
			y: Math.floor(view.details.height / 2),
		};
		const abort = new AbortController();
		const pending = call(
			{
				op: "segment",
				ref: point.ref,
				actions: [
					{
						op: "drag",
						from: point,
						to: { ...point, x: Math.floor((view.details.width * 3) / 4) },
						durationMs: 3000,
					},
					{ op: "click", point },
				],
				expected: visual,
			},
			abort.signal,
		).then(
			(result) => ({ result }),
			(error) => ({ error }),
		);
		await event((row) => row.event === "drag-started");
		abort.abort();
		const outcome = await pending;
		assert.ok("result" in outcome, JSON.stringify(outcome));
		assert.equal(outcome.result.details.terminal?.inputCommitted, true);
		assert.equal(outcome.result.details.terminal?.cancelled, true);
		assert.equal(outcome.result.details.status, "cancelled");
		assert.equal(outcome.result.details.attemptedActions, 1);
		assert.equal(outcome.result.details.firstUnfinishedAction, 0);
		assert.equal(outcome.result.details.actions[0].dispatch, "unknown");
		await event((row) => row.event === "pointer-released" && row.count === 1);
		const actual = await state();
		assert.equal(actual.clicks, 1, "follow-up click must not execute");
		assert.equal(actual.releases, 1, "cancel must release the owned mouse button");
		assert.ok(actual.drags > 0 && actual.lastX < 400, "abort occurred before the drag endpoint");
		log.push({ oracle: actual });
		await feature.close();
		feature = createComputerFeature();
		const fresh = await select("main", "image");
		await call({
			op: "segment",
			ref: fresh.details.imageRef,
			actions: [
				{
					op: "click",
					point: {
						ref: fresh.details.imageRef,
						x: Math.floor(fresh.details.width / 4),
						y: Math.floor(fresh.details.height / 2),
					},
				},
			],
			expected: visual,
		});
		await event((row) => row.event === "pointer-released" && row.count === 2);
		const restarted = await state();
		assert.equal(restarted.clicks, 2);
		assert.equal(restarted.releases, 2);
		assert.equal(restarted.drags, actual.drags, "closed drag must not continue in the new session");
		log.push({ restartOracle: restarted });
	} else if (scenario.startsWith("pointer-")) {
		const view = await select("main", "image");
		const png = Buffer.from(view.content.find((row) => row.type === "image").data, "base64");
		assert.equal(png.toString("ascii", 1, 4), "PNG");
		const width = png.readUInt32BE(16),
			height = png.readUInt32BE(20);
		const point = { ref: view.details.imageRef, x: Math.floor(width / 4), y: Math.floor(height / 2) };
		const action =
			scenario === "pointer-click"
				? { op: "click", point }
				: scenario === "pointer-scroll"
					? { op: "scroll", point, deltaX: 0, deltaY: 5 }
					: { op: "drag", from: point, to: { ...point, x: Math.floor((width * 3) / 4) }, durationMs: 200 };
		await call({ op: "segment", ref: view.details.imageRef, actions: [action], expected: visual });
		const actual = await state();
		if (scenario === "pointer-click") assert.equal(actual.clicks, 1);
		if (scenario === "pointer-scroll") assert.ok(actual.scrolls > 0);
		if (scenario === "pointer-drag") {
			assert.equal(actual.clicks, 1);
			assert.ok(actual.drags > 0);
			assert.ok(actual.lastX > 400);
		}
		log.push({ oracle: actual });
	} else if (scenario === "web-form") {
		const view = await select("main", "image");
		const text = "网页 Unicode café 你好";
		// The fixture autofocuses its empty field. No DOM/API mutation is used by the driver.
		await call({
			op: "segment",
			ref: view.details.imageRef,
			actions: [
				{ op: "type_text", text },
				{ op: "key", key: "Return" },
			],
			expected: visual,
		});
		const actual = await state();
		assert.equal(actual.webError, "");
		assert.equal(actual.webValue, text);
		assert.equal(actual.submitted, text);
		log.push({ oracle: actual });
	} else if (scenario === "stale-reference" || scenario === "stale-image") {
		const image = scenario === "stale-image";
		const view = await select("main", image ? "image" : true);
		await call({ op: "observe" });
		await assert.rejects(
			call({
				op: "segment",
				ref: image ? view.details.imageRef : view.details.observationRef,
				actions: [{ op: "type_text", text: "MUST NOT TYPE" }],
				expected: visual,
			}),
			(error) => error.details?.code === "stale_observation",
		);
		assert.equal((await state()).body, "original");
		await fill(await call({ op: "observe" }), "fresh reference works");
		assert.equal((await state()).body, "fresh reference works");
	} else if (scenario === "cancel-restart") {
		const view = await select();
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(
			call(
				{
					op: "segment",
					ref: view.details.observationRef,
					actions: [{ op: "type_text", text: "MUST NOT TYPE" }],
					expected: visual,
				},
				aborted.signal,
			),
			(error) => error.details?.code === "cancelled_before_dispatch",
		);
		assert.equal((await state()).body, "original");
		await feature.close();
		feature = createComputerFeature();
		await fill(await select(), "new session works");
		assert.equal((await state()).body, "new session works");
	} else if (scenario === "native-batch" || scenario === "mixed-batch") {
		const view = await select();
		const first = rows(view).find((row) => row.identifier === "general-editor");
		assert.ok(first?.ref);
		const second = { op: "fill", target: { selector: { identifier: "other-editor" } }, text: "second β" };
		const expected = { kind: "value", target: second.target, value: second.text };
		const result = await call({
			op: "segment",
			ref: view.details.observationRef,
			actions: [{ op: "fill", target: { ref: first.ref }, text: "first café 你好" }, second],
			expected,
		});
		const actual = await state();
		assert.equal(actual.body, "first café 你好");
		log.push({ oracle: actual });
		if (scenario === "native-batch") {
			assert.equal(result.details.status, "confirmed");
			assert.equal(result.details.actions.length, 2);
			assert.ok(
				result.details.actions.every(
					(row) => row.dispatch === "dispatched" && row.action.route === "accessibility",
				),
			);
			assert.equal(actual.other, second.text);
		} else {
			assert.equal(result.details.firstUnfinishedAction, 1);
			assert.equal(result.details.actions[0].dispatch, "dispatched");
			assert.equal(result.details.actions[0].action.route, "synthetic_events");
			assert.equal(result.details.actions[1].dispatch, "not_dispatched");
			assert.equal(result.details.actions[1].code, "segment_boundary_required");
			assert.equal(actual.other, "untouched");
			const evidence = result.content.find((row) => row.type === "text" && row.text.startsWith("Observation ref:"));
			assert.ok(evidence);
			const next = rows({ content: [evidence] }).find((row) => row.identifier === "other-editor");
			assert.ok(next?.ref);
			const target = { ref: next.ref };
			const recovered = await call({
				op: "segment",
				ref: result.details.evidence.observationRef,
				previousEffect: "observed",
				actions: [{ ...second, target }],
				expected: { ...expected, target },
			});
			assert.equal(recovered.details.status, "confirmed");
			assert.equal(recovered.details.actions.length, 1);
			assert.equal(recovered.details.actions[0].dispatch, "dispatched");
			const final = await state();
			assert.equal(final.body, actual.body, "later fill must preserve the first field");
			assert.equal(final.other, second.text);
			log.push({ recoveryOracle: final });
		}
	} else {
		let view = await select();
		const count = scenario === "continuous-edit" ? 10 : 1;
		for (let index = 0; index < count; index++) {
			const text = `第 ${index} 轮 café é 🧪\nsecond line\tend`;
			await fill(view, text);
			assert.equal((await state()).body, text);
			if (index + 1 < count) view = await call({ op: "observe" });
		}
		if (scenario === "window-switch") {
			await fill(await select("second"), "second only", "other-editor");
			await fill(await select(), "returned to first");
			const actual = await state();
			assert.equal(actual.body, "returned to first");
			assert.equal(actual.other, "second only");
		}
	}
	taskEnd = performance.now();
} catch (error) {
	failure = { message: error.message, code: error.details?.code };
	process.exitCode = 1;
} finally {
	const closeStart = performance.now();
	let closed = false;
	try {
		await feature?.close();
		closed = true;
	} finally {
		fixture.stdin.end("quit\n");
		const fixtureExit = await exit;
		lines.close();
		clearTimeout(deadline);
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		for (const row of log) console.log("RESULT", JSON.stringify(row));
		console.log(
			"E2E_SAMPLE",
			JSON.stringify({
				scenario,
				strategy: "combined",
				category: protectionScenarios.has(scenario) ? "protection" : "functional",
				passed: taskEnd !== undefined && !controller.signal.aborted && closed && fixtureExit.code === 0,
				failure,
				loadMs,
				setupMs: (taskStart ?? closeStart) - setupStart,
				taskMs: taskEnd === undefined ? null : loadMs + taskEnd - taskStart,
				attemptMs: loadMs + (taskEnd ?? closeStart) - (taskStart ?? closeStart),
				closeMs: performance.now() - closeStart,
				closed,
				fixtureExit,
				calls,
				lease: readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8").trim(),
			}),
		);
	}
}
