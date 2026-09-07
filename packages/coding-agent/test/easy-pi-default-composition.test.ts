import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, test } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createBuiltInExtensions } from "../src/extensions/index.ts";
import { resolveEasyPiInvocation } from "../src/extensions/product-launcher.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
	const path = mkdtempSync(join(tmpdir(), "easy-pi-defaults-"));
	roots.push(path);
	return path;
}

test("SDK defaults include product tools without opening a task ledger", async () => {
	const cwd = root();
	const agentDir = join(cwd, "private-agent");
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		expect(extensionsResult.errors).toEqual([]);
		await session.bindExtensions({ mode: "rpc" });
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining([
				"spawn_agent",
				"send_message",
				"followup_task",
				"wait_agent",
				"interrupt_agent",
				"list_agents",
				"request_user_input",
				"read",
				"bash",
				"edit",
				"write",
			]),
		);
		expect(session.getActiveToolNames()).not.toContain("subagent");
		expect(existsSync(join(agentDir, "subagent", "state.sqlite"))).toBe(false);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

test("CLI factory set survives external-discovery disablement and reload without duplication", async () => {
	const cwd = root();
	const agentDir = join(cwd, "private-agent");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		extensionFactories: createBuiltInExtensions(agentDir),
	});
	for (let count = 0; count < 2; count++) {
		await loader.reload();
		const loaded = loader.getExtensions();
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions.filter((extension) => extension.commands.has("agents"))).toHaveLength(1);
		expect(loaded.extensions.some((extension) => extension.tools.has("subagent"))).toBe(false);
		expect(existsSync(join(agentDir, "teams"))).toBe(false);
		expect(existsSync(join(agentDir, "subagent", "state.sqlite"))).toBe(false);
	}
});

test("child launcher targets this product rather than the embedding script", () => {
	const original = process.argv;
	try {
		process.argv = [process.execPath, "/tmp/unrelated-app.js"];
		const invocation = resolveEasyPiInvocation();
		expect(invocation.command).toBe(process.execPath);
		expect(invocation.args?.at(-1)).toMatch(/coding-agent\/src\/cli\.ts$/);
		expect(invocation.args).not.toContain("/tmp/unrelated-app.js");
	} finally {
		process.argv = original;
	}
});
