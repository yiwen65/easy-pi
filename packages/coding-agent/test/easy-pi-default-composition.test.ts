import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { CollaborationResults } from "@easy-pi/subagent/collaboration-contract";
import { afterEach, expect, test, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBuiltInExtensions } from "../src/extensions/index.ts";
import { collaborationToolSchemas } from "../src/extensions/pi-collaboration-context.ts";
import { spawnArgs } from "./collaboration-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
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
				"web_search",
				"web_fetch",
				"read",
				"bash",
				"edit",
				"write",
			]),
		);
		for (const name of ["web_search", "web_fetch"]) {
			const tools = session.getAllTools().filter((tool) => tool.name === name);
			expect(tools).toHaveLength(1);
			expect(tools[0].sourceInfo.path).toBe("<inline:web-search>");
			expect(session.systemPrompt).toContain(`- ${name}:`);
		}
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
		for (const name of ["web_search", "web_fetch"]) {
			const owners = loaded.extensions.filter((extension) => extension.tools.has(name));
			expect(owners).toHaveLength(1);
			expect(owners[0].path).toBe("<inline:web-search>");
		}
		expect(loaded.extensions.some((extension) => extension.tools.has("subagent"))).toBe(false);
		expect(existsSync(join(agentDir, "teams"))).toBe(false);
		expect(existsSync(join(agentDir, "subagent", "state.sqlite"))).toBe(false);
	}
});

for (const options of [
	{ excludeTools: ["web_search", "web_fetch"] },
	{ tools: ["read"] },
	{ noTools: "all" as const },
]) {
	test(`product web tools respect explicit tool filters: ${JSON.stringify(options)}`, async () => {
		const cwd = root();
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager: SessionManager.inMemory(cwd),
			...options,
		});
		try {
			await session.bindExtensions({ mode: "rpc" });
			await session.reload();
			for (const name of ["web_search", "web_fetch"]) {
				expect(session.getActiveToolNames()).not.toContain(name);
				expect(session.systemPrompt).not.toContain(`- ${name}:`);
			}
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});
}

test("a host-owned ResourceLoader does not get product web tools injected", async () => {
	const cwd = root();
	const agentDir = join(cwd, "agent");
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true });
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		expect(extensionsResult.errors).toEqual([]);
		expect(extensionsResult.extensions).toEqual([]);
		expect(session.getAllTools().some((tool) => ["web_search", "web_fetch"].includes(tool.name))).toBe(false);
	} finally {
		session.dispose();
	}
});

test.each([
	{ label: "defaults", options: {}, web: true },
	{ label: "excluded web tools", options: { excludeTools: ["web_search", "web_fetch"] }, web: false },
	{ label: "explicit allowlist", options: { tools: ["read", "spawn_agent", "list_agents"] }, web: false },
])("native preserve keeps parent schemas and prompt with $label", async ({ options, web }) => {
	const cwd = realpathSync(root());
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "builtin-preserve-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Preserving tool schemas must not start web requests");
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		...options,
	});
	try {
		await session.bindExtensions({ mode: "rpc" });
		expect(faux.state.callCount).toBe(0);
		const requests: Context[] = [];
		faux.setResponses(
			Array.from({ length: 2 }, () => (context) => {
				requests.push({
					systemPrompt: context.systemPrompt,
					messages: structuredClone(context.messages),
					tools: collaborationToolSchemas(context.tools),
				});
				return fauxAssistantMessage("done");
			}),
		);
		await session.prompt("Capture the default parent prefix");
		const spawn = session.agent.state.tools.find((tool) => tool.name === "spawn_agent")!;
		await spawn.execute(
			"spawn-preserved",
			spawnArgs("preserved", "inspect", { mode: "fork", turns: "all", prefix: "preserve" }),
		);
		const list = session.agent.state.tools.find((tool) => tool.name === "list_agents")!;
		await vi.waitFor(async () => {
			const result = await list.execute("list-preserved", {});
			expect((result.details as CollaborationResults["list_agents"]).agents[0]?.status).toBe("completed");
		});
		expect(requests).toHaveLength(2);
		const [parent, child] = requests;
		expect(child.systemPrompt).toBe(parent.systemPrompt);
		expect(child.tools).toEqual(parent.tools);
		expect(child.messages.slice(0, parent.messages.length)).toEqual(parent.messages);
		for (const name of ["web_search", "web_fetch"]) {
			expect(child.tools?.filter((tool) => tool.name === name)).toHaveLength(web ? 1 : 0);
			expect(child.systemPrompt?.includes(`- ${name}:`)).toBe(web);
		}
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

test("default-session tool loop executes web tools without an external extension", async () => {
	const cwd = root();
	const agentDir = join(cwd, "agent");
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "builtin-web-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	vi.stubEnv("TAVILY_API_KEY", "tvly-offline-only-not-a-real-key");
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		expect(url).toBe("https://api.tavily.com/search");
		return Response.json({
			results: [{ title: "Public docs", url: "https://docs.python.org/3/", content: "Offline excerpt" }],
		});
	});
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
	});
	try {
		expect(extensionsResult.errors).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
		await session.bindExtensions({ mode: "rpc" });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "public docs" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("web_fetch", { url: "http://localhost/" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Offline tool loop complete"),
		]);
		await session.prompt("Exercise the built-in web tools offline");
		const results = session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => [message.toolName, message.isError])).toEqual([
			["web_search", false],
			["web_fetch", true],
		]);
		expect(JSON.stringify(results[0])).toContain("Offline excerpt");
		expect(JSON.stringify(results[1])).toContain("Only public HTTP(S)");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(existsSync(join(agentDir, "extensions"))).toBe(false);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
