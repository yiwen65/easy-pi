// Offline post-build acceptance: compiled modules only, synthetic data/credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "../packages/ai/dist/index.js";
import { ModelRuntime } from "../packages/coding-agent/dist/core/model-runtime.js";
import { createAgentSession } from "../packages/coding-agent/dist/core/sdk.js";
import { SessionManager } from "../packages/coding-agent/dist/core/session-manager.js";
import { SettingsManager } from "../packages/coding-agent/dist/core/settings-manager.js";
import * as native from "../packages/coding-agent/node_modules/@easy-pi/subagent/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const product = join(root, "packages/coding-agent");
const modules = ["index", "collaboration-contract", "collaboration-controller", "collaboration-mailbox", "collaboration-store", "context-fork", "session-host"].sort();
const expected = modules.flatMap((name) => [".js", ".js.map", ".d.ts", ".d.ts.map"].map((extension) => name + extension)).sort();
for (const directory of [join(root, "packages/subagent/dist"), join(product, "node_modules/@easy-pi/subagent/dist")]) {
	assert.deepEqual(readdirSync(directory).sort(), expected);
}
assert.equal(typeof native.CollaborationController, "function");
assert.equal(native.RunLedger, undefined);
assert.equal(native.createSubagentExtension, undefined);
assert.throws(() => native.parseCollaborationArguments("spawn_agent", { task_name: "legacy", message: "obsolete" }), { code: "invalid_arguments" });
assert.deepEqual(native.validateDelegationResult("unstructured retained output", "completed"), { contract: "invalid", acceptance: "not_reviewed" });
assert.equal(existsSync(join(product, "dist/extensions/product-launcher.js")), false);
const require = createRequire(join(product, "dist/cli.js"));
for (const name of ["extension", "ledger", "process-runner", "dag-orchestrator", "worktree", "child-protocol-extension"]) {
	assert.throws(() => require.resolve(`@easy-pi/subagent/${name}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
}
const metadata = JSON.parse(readFileSync(join(product, "node_modules/@easy-pi/subagent/package.json"), "utf8"));
assert.deepEqual(Object.keys(metadata.exports).sort(), [".", ...modules.filter((name) => name !== "index").map((name) => `./${name}`)].sort());

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "epi-compiled-native-")));
let session;
try {
	const agentDir = join(cwd, "agent");
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	const faux = fauxProvider({ provider: "compiled-native-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	({ session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off", sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) }));
	await session.bindExtensions({ mode: "rpc" });
	for (const name of ["spawn_agent", "send_message", "followup_task", "wait_agent", "interrupt_agent", "list_agents"]) assert(session.getActiveToolNames().includes(name));
	assert(!session.getActiveToolNames().includes("subagent"));
	let rootTurns = 0;
	let childCalls = 0;
	let childFinished;
	const finished = new Promise((resolve) => { childFinished = resolve; });
	faux.setResponses(Array.from({ length: 12 }, () => (context) => {
		if (context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Current runtime delegation. You are child /root/worker;"))) {
			childCalls++;
			childFinished();
			return fauxAssistantMessage("compiled child completed");
		}
		return rootTurns++ === 0
			? fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "worker", delegation: { version: 1, task: { relationship: "continue", objective: "offline smoke", scope: "synthetic data only", material: [], deliverables: ["Acknowledgement"], acceptance: ["No file changes"] }, context: { mode: "isolated" }, capabilities: { tools: "inherit" } } }), { stopReason: "toolUse" })
			: fauxAssistantMessage("compiled root completed");
	}));
	await session.prompt("delegate synthetic work");
	let deadline;
	try { await Promise.race([finished, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Compiled child did not start")), 10000); })]); }
	finally { clearTimeout(deadline); }
	assert.equal(childCalls, 1);
	assert(session.state.messages.some((message) => message.role === "toolResult" && message.toolName === "spawn_agent" && !message.isError));
	assert.equal(existsSync(join(agentDir, "subagent/state.sqlite")), false);
	assert.equal(existsSync(join(agentDir, "auth.json")), false);
	const env = { ...process.env, EASY_PI_CODING_AGENT_DIR: agentDir };
	for (const flag of ["--help", "--version"]) {
		assert(execFileSync(process.execPath, [join(product, "dist/cli.js"), flag], { cwd, env, encoding: "utf8", timeout: 15000 }).trim());
	}
	// npm's actual packing rules, without installation, lifecycle scripts or publication.
	for (const directory of [join(root, "packages/subagent"), product]) {
		const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], { cwd: directory, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 }));
		const prefix = directory === product ? "node_modules/@easy-pi/subagent/dist/" : "dist/";
		assert.deepEqual(pack.files.filter((file) => file.path.startsWith(prefix)).map((file) => file.path.slice(prefix.length)).sort(), expected);
		assert(!pack.files.some((file) => file.path.includes("native-subagent-cutover") || file.path.endsWith("product-launcher.js")));
	}
	console.log("Compiled native spawn, tool catalog, retired exports, CLI metadata and both npm pack inventories passed (offline).");
} finally {
	if (session) {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
	rmSync(cwd, { recursive: true, force: true });
}
