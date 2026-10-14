import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { commandArgs, createServer, resultFromOutput } from "./server.mjs";

async function connect(execute) {
	const server = createServer({ binary: "/fake/agent-desktop", session: "test-session", execute });
	const client = new Client({ name: "test", version: "1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, close: () => client.close() };
}

const success = { stdout: JSON.stringify({ ok: true, data: {} }) };

test("MCP exposes seven tools and validates refs, unknown arguments and batch commands", async () => {
	let calls = 0;
	const { client, close } = await connect(async () => { calls++; return success; });
	try {
		assert.equal((await client.listTools()).tools.length, 7);
		for (const [name, args] of [
			["desktop_click", { ref_id: "@e1" }],
			["desktop_press", { combo: "return" }],
			["desktop_status", { force: true }],
			["desktop_type", { ref_id: "@sabc:e1", text: "中".repeat(30000) }],
			["desktop_batch", { actions: Array.from({ length: 2 }, () => ({ command: "type", args: { ref_id: "@sabc:e1", text: "x".repeat(40000) } })) }],
			["desktop_batch", { actions: [{ command: "session", args: {} }] }],
			["desktop_batch", { actions: [{ command: "press", args: { combo: "return", app: "Finder", force: true } }] }],
		]) {
			assert.equal((await client.callTool({ name, arguments: args })).isError, true);
		}
		assert.equal(calls, 0);
	} finally { await close(); }
});

test("argv uses one namespace, headless defaults and literal text with no shell", async () => {
	const invocations = [];
	const { client, close } = await connect(async (...args) => { invocations.push(args); return success; });
	try {
		await client.callTool({ name: "desktop_type", arguments: { ref_id: "@sabc:e1", text: "--force $(touch /tmp/nope)" } });
		await client.callTool({ name: "desktop_click", arguments: { ref_id: "@sabc:e1", headed: true } });
		await client.callTool({ name: "desktop_batch", arguments: { actions: [{ command: "click", args: { ref_id: "@sabc:e1" } }] } });
		assert.deepEqual(invocations[0][1], ["--session", "test-session", "type", "--", "@sabc:e1", "--force $(touch /tmp/nope)"]);
		assert.equal(invocations[0][2].shell, false);
		assert.deepEqual(invocations[1][1], ["--session", "test-session", "--headed", "click", "@sabc:e1"]);
		assert.ok(invocations[2][1].includes("--stop-on-error"));
		assert.deepEqual(commandArgs("snapshot", { app: "Finder", interactive_only: true, compact: false, max_depth: 3 }), ["snapshot", "--app", "Finder", "--interactive-only", "--max-depth", "3"]);
	} finally { await close(); }
});

test("batch child failures are MCP errors even when top-level ok is true", () => {
	assert.equal(resultFromOutput(JSON.stringify({ ok: true, data: { results: [{ ok: false }] } })).isError, true);
	assert.throws(() => resultFromOutput("not json"));
});

test("preserves CLI errors and never retries an uncertain timeout", async () => {
	let calls = 0;
	const { client, close } = await connect(async () => {
		calls++;
		if (calls === 1) throw Object.assign(new Error("exit"), { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "STALE_REF" } }) });
		throw Object.assign(new Error("timed out"), { killed: true, code: "ETIMEDOUT" });
	});
	try {
		const stale = await client.callTool({ name: "desktop_click", arguments: { ref_id: "@sabc:e1" } });
		assert.equal(stale.structuredContent.error.code, "STALE_REF");
		const timeout = await client.callTool({ name: "desktop_click", arguments: { ref_id: "@sabc:e1" } });
		assert.equal(timeout.isError, true);
		assert.match(timeout.content[0].text, /unknown; observe before retrying/);
		assert.equal(calls, 2);
	} finally { await close(); }
});

test("concurrent requests are serialized", async () => {
	const gate = new PassThrough();
	let active = 0;
	let peak = 0;
	const { client, close } = await connect(async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((done) => gate.once("data", done));
		active--;
		return success;
	});
	try {
		const first = client.callTool({ name: "desktop_status", arguments: {} });
		const second = client.callTool({ name: "desktop_status", arguments: {} });
		await new Promise((done) => setImmediate(done));
		gate.write("done");
		await first;
		await new Promise((done) => setImmediate(done));
		gate.write("done");
		await second;
		assert.equal(peak, 1);
	} finally { await close(); }
});
