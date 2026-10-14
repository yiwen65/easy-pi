// Opt-in only: opens a temporary native test app and sends input to it.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.env.AGENT_DESKTOP_E2E !== "1" || process.platform !== "darwin") {
	throw new Error("Requires macOS and explicit AGENT_DESKTOP_E2E=1 (real desktop input)");
}
const config = JSON.parse(readFileSync(join(homedir(), ".epi/agent/mcp.json"), "utf8")).mcpServers.agent_desktop;
assert.ok(config?.command && config.env?.AGENT_DESKTOP_BIN, "Registered agent_desktop server required");
const directory = mkdtempSync(join(tmpdir(), "epi-desktop-e2e-"));
const name = `EasyPiE2E-${process.pid}`;
const bundle = join(directory, `${name}.app`);
let fixture;
const client = new Client({ name: "easy-pi-desktop-e2e", version: "1" });
function nodes(node) { return [node, ...(node.children ?? []).flatMap(nodes)]; }
async function call(tool, args) {
	const result = await client.callTool({ name: tool, arguments: args });
	assert.ok(!result.isError, `${tool}: ${JSON.stringify(result.structuredContent ?? result.content)}`);
	assert.equal(result.structuredContent.ok, true);
	return result.structuredContent.data;
}
async function snapshot() {
	return call("desktop_snapshot", { app: name, interactive_only: false, compact: false });
}
function target(data, identifier) {
	const matches = nodes(data.tree).filter((node) => node.native_id?.value === identifier);
	assert.equal(matches.length, 1, `Expected exact target ${identifier}`);
	assert.ok(matches[0].ref_id);
	return matches[0].ref_id;
}
function containsValue(data, expected) {
	assert.ok(nodes(data.tree).some((node) => node.value === expected || node.name === expected), `Missing live UI value: ${expected}`);
}
try {
	mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
	writeFileSync(join(bundle, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleIdentifier</key><string>dev.easy-pi.desktop-e2e.${process.pid}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
	execFileSync("swiftc", [join(dirname(fileURLToPath(import.meta.url)), "Fixture.swift"), "-o", join(bundle, "Contents/MacOS", name)], { stdio: "inherit", timeout: 60000 });
	fixture = spawn(join(bundle, "Contents/MacOS", name), [], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise((resolve, reject) => {
		let output = "";
		function finish(error) {
			clearTimeout(timer);
			fixture.removeListener("error", finish);
			fixture.removeListener("exit", exited);
			fixture.stdout.removeListener("data", received);
			if (error) reject(error); else resolve();
		}
		function exited(code) { finish(new Error(`Fixture exited before readiness: ${code}`)); }
		function received(chunk) { output += chunk; if (output.includes("READY")) finish(); }
		const timer = setTimeout(() => finish(new Error("Fixture launch timeout")), 10000);
		fixture.once("error", finish);
		fixture.once("exit", exited);
		fixture.stdout.on("data", received);
	});
	await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env }, stderr: "inherit" }));
	assert.equal((await client.listTools()).tools.length, 7);
	const status = await call("desktop_status", {});
	assert.equal(status.permissions.accessibility.state, "granted");
	const apps = await call("desktop_list_apps", { app: name });
	assert.ok(apps.apps.some((app) => app.pid === fixture.pid));
	let data = await snapshot();
	assert.equal(data.complete, true);
	console.log(`PASS: registered MCP, status, list_apps, snapshot (fixture PID ${fixture.pid})`);
	await call("desktop_click", { ref_id: target(data, "e2e-increment") });
	data = await snapshot();
	containsValue(data, "Clicks: 1");
	console.log("PASS: headless click -> live UI Clicks: 1");
	await call("desktop_type", { ref_id: target(data, "e2e-input"), text: "MCP E2E 中文 42" });
	data = await snapshot();
	containsValue(data, "MCP E2E 中文 42");
	console.log("PASS: headless type -> live UI Unicode text");
	await call("desktop_press", { app: name, combo: "cmd+shift+e" });
	// Read-only observation may wait for the app's event loop, never replay the shortcut.
	for (let attempt = 0; attempt < 10; attempt++) {
		data = await snapshot();
		if (nodes(data.tree).some((node) => node.value === "Shortcut: 1" || node.name === "Shortcut: 1")) break;
		await delay(100);
	}
	containsValue(data, "Shortcut: 1");
	console.log("PASS: press -> real app menu action Shortcut: 1");
	const batch = await call("desktop_batch", { actions: [
		{ command: "click", args: { ref_id: target(data, "e2e-increment") } },
		{ command: "snapshot", args: { app: name, interactive_only: false } },
	] });
	assert.equal(batch.completed_entries, 2);
	assert.ok(batch.results.every((entry) => entry.ok));
	containsValue(batch.results[1].data, "Clicks: 2");
	console.log("PASS: native batch click + snapshot -> live UI Clicks: 2");
	console.log("PASS: all seven registered MCP tools verified against native UI");
} finally {
	try {
		if (fixture?.pid && fixture.exitCode === null && fixture.signalCode === null) {
			await new Promise((resolve) => {
				const timer = setTimeout(() => fixture.kill("SIGKILL"), 3000);
				fixture.once("exit", () => { clearTimeout(timer); resolve(); });
				fixture.kill("SIGTERM");
			});
		}
	} finally {
		try { await client.close(); }
		finally { rmSync(directory, { recursive: true, force: true }); }
	}
}
