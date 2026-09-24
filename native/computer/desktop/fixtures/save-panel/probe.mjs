import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const [fixturePath, bridgePath, mode] = process.argv.slice(2);
assert.equal(process.env.ALLOW_GUI_TESTS, "true", "Explicit owned-fixture GUI opt-in required");
assert.ok(fixturePath && bridgePath && isAbsolute(fixturePath) && isAbsolute(bridgePath));
const { createComputerFeature } = await import(pathToFileURL(bridgePath).href);
const directory = mkdtempSync("/tmp/easy-pi-owned-saved-");
assert.ok(mode === undefined || ["broken-synthetic", "working-synthetic"].includes(mode));
const fixture = spawn(fixturePath, [directory, ...(mode ? [mode] : [])], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: fixture.stdout });
const events = [];
lines.on("line", (line) => {
	console.log("FIXTURE", line);
	events.push(JSON.parse(line));
});
const exit = new Promise((resolve) => fixture.on("exit", (code, signal) => resolve({ code, signal })));
async function event(name) {
	const until = Date.now() + 10000;
	while (Date.now() < until) {
		const found = events.find((r) => r.event === name);
		if (found) return found;
		if (fixture.exitCode !== null) throw Error("fixture exited");
		await new Promise((r) => setTimeout(r, 20));
	}
	throw Error(`missing fixture event ${name}`);
}
let feature;
let seq = 0;
async function call(request) {
	const id = `save-${++seq}`;
	const result = await feature.binding.tools[0].execute(id, { request }, undefined, undefined, {});
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
	console.log(
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
const rows = (r) => r.content[0].text.split("\n").slice(1).filter(Boolean).map(JSON.parse);
try {
	await event("ready");
	feature = createComputerFeature();
	const parents = rows(await call({ op: "discover", title: "easy-pi-owned-save-document" }));
	assert.equal(parents.length, 1);
	const parent = await call({ op: "select", ref: parents[0].ref, observe: true });
	if (mode) {
		const field = rows(parent).find((r) => r.identifier === "reopened-body");
		assert.ok(field?.ref);
		const result = await call({
			op: "segment",
			ref: parent.details.observationRef,
			actions: [{ op: "fill", target: { ref: field.ref }, text: "replacement only" }],
			expected: { kind: "value", target: { selector: { identifier: "reopened-body" } }, value: "replacement only" },
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
		console.log("SYNTHETIC_SELECTION_PASS", mode);
	} else {
		if (parent.details.status === "observed")
			assert.ok(
				!rows(parent).some((r) => r.identifier === "saveAsNameTextField"),
				"parent must not acquire its child sheet",
			);
		else assert.ok(["native_refused", "refused"].includes(parent.details.status), JSON.stringify(parent.details));
		const windows = rows(await call({ op: "discover", title: "easy-pi-owned-save-panel" }));
		assert.equal(windows.length, 1);
		const before = await call({ op: "select", ref: windows[0].ref, observe: true });
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
		const doc = await call({ op: "select", ref: docs[0].ref, observe: true });
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
		console.log("SAVE_REOPEN_PASS", JSON.stringify({ name, bytes: Buffer.byteLength(reopened.body), directory }));
	}
} finally {
	await feature?.close();
	console.log("LEASE", readFileSync(join(userInfo().homedir, ".pi-computer-desktop-v1/desktop.lock"), "utf8").trim());
	fixture.stdin.end("quit\n");
	console.log("EXIT", await exit);
	lines.close();
}
