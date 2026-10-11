import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBuiltInExtensions } from "../src/extensions/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-migration/owned-stdio-server.mjs", import.meta.url));
const userFixture = fileURLToPath(new URL("./fixtures/mcp-migration/user-extension.ts", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "epi-mcp-loader-")));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const agentDir = join(directory, "agent");
	const cwd = join(directory, "project");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await mkdir(cwd);
	await copyFile(userFixture, join(agentDir, "extensions", "user-probe.ts"));
	const auditPath = join(directory, "audit.jsonl");
	await writeFile(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				docs: { command: process.execPath, args: [fixture, auditPath, "docs"], exposure: "direct" },
			},
		}),
	);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "mcp-loader-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		subagentEnabled: false,
	});
	const audit = async () =>
		readFile(auditPath, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
	async function session(options: { resourceLoader?: DefaultResourceLoader; noMcp?: boolean } = {}) {
		const result = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			thinkingLevel: "off",
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			...options,
		});
		cleanups.push(async () => {
			await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await result.session.shutdown();
		});
		await result.session.bindExtensions({ mode: "rpc" });
		return result.session;
	}
	function loader(factories: InlineExtension[] = createBuiltInExtensions(agentDir, { collaboration: false })) {
		return new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: factories,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
	}
	async function checkUser(session: AgentSession) {
		expect(session.extensionRunner.getCommand("mcp_user_probe")).toBeDefined();
		await session.prompt("/mcp_user_probe");
		expect(session.sessionManager.getEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "custom", customType: "mcp-loader-user-probe", data: { called: true } }),
			]),
		);
		expect(faux.state.callCount).toBe(0);
	}
	return { agentDir, cwd, settingsManager, audit, session, loader, faux, checkUser };
}

describe("MCP product extension loading", () => {
	it("names replaceable MCP/tool-search built-ins and starts no transport during factory discovery", async () => {
		const f = await setup();
		const factories = createBuiltInExtensions(f.agentDir, { collaboration: false });
		for (const name of ["mcp", "tool-search"]) {
			expect(factories).toContainEqual(expect.objectContaining({ name, builtin: true, replaceable: true }));
		}
		const loader = f.loader(factories);
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual(
			expect.arrayContaining([
				"<inline:mcp>",
				"<inline:tool-search>",
				join(f.agentDir, "extensions", "user-probe.ts"),
			]),
		);
		expect(await f.audit()).toBe("");
		const native = await f.session({ resourceLoader: loader });
		await vi.waitFor(() => expect(native.getActiveToolNames()).toContain("mcp__docs__echo"));
		expect((await f.audit()).split("\n").filter((line) => line.includes('"event":"start"'))).toHaveLength(1);
		expect(native.extensionRunner.getCommand("mcp")).toBeDefined();
		await f.checkUser(native);
	});

	it("--no-mcp excludes built-in MCP/discovery without dropping existing user extensions", async () => {
		const f = await setup();
		const args = parseArgs(["--no-mcp"]);
		expect(args.noMcp).toBe(true);
		expect(args.diagnostics).toEqual([]);
		const loader = f.loader(createBuiltInExtensions(f.agentDir, { collaboration: false, mcp: !args.noMcp }));
		await loader.reload();
		const native = await f.session({ resourceLoader: loader });
		expect(
			loader
				.getExtensions()
				.extensions.some(
					(extension) => extension.path === "<inline:mcp>" || extension.path === "<inline:tool-search>",
				),
		).toBe(false);
		expect(native.extensionRunner.getCommand("mcp")).toBeUndefined();
		expect(native.getToolDefinition("tool_search")).toBeUndefined();
		await f.checkUser(native);
		expect(await f.audit()).toBe("");
	});

	it("SDK noMcp applies to the default loader while preserving discovered user extensions", async () => {
		const f = await setup();
		const native = await f.session({ noMcp: true });
		expect(native.resourceLoader.getExtensions().errors).toEqual([]);
		expect(
			native.resourceLoader
				.getExtensions()
				.extensions.some(
					(extension) => extension.path === "<inline:mcp>" || extension.path === "<inline:tool-search>",
				),
		).toBe(false);
		expect(native.getAllTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
		await f.checkUser(native);
		expect(await f.audit()).toBe("");
	});

	it("-builtin:mcp suppresses connections but keeps unrelated extensions and tool-search", async () => {
		const f = await setup();
		f.settingsManager.setExtensionPaths(["-builtin:mcp"]);
		const loader = f.loader();
		await loader.reload();
		const native = await f.session({ resourceLoader: loader });
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions.some((extension) => extension.path === "<inline:mcp>")).toBe(false);
		expect(loader.getExtensions().extensions.some((extension) => extension.path === "<inline:tool-search>")).toBe(
			true,
		);
		expect(native.extensionRunner.getCommand("mcp")).toBeUndefined();
		await f.checkUser(native);
		expect(await f.audit()).toBe("");
	});

	it("an additional /mcp command replaces the built-in without opening its configured server", async () => {
		const f = await setup();
		let replacements = 0;
		const loader = f.loader([
			...createBuiltInExtensions(f.agentDir, { collaboration: false }),
			{
				name: "user-mcp",
				factory: (pi) => {
					pi.registerCommand("mcp", {
						description: "User MCP replacement",
						handler: async () => {
							replacements++;
						},
					});
				},
			},
		]);
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions.some((extension) => extension.path === "<inline:mcp>")).toBe(false);
		expect(loader.getExtensions().extensions.some((extension) => extension.path === "<inline:user-mcp>")).toBe(true);
		const native = await f.session({ resourceLoader: loader });
		expect(native.extensionRunner.getCommand("mcp")?.description).toBe("User MCP replacement");
		await native.prompt("/mcp");
		expect(replacements).toBe(1);
		await f.checkUser(native);
		expect(await f.audit()).toBe("");
	});
});
