import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import { getMcpToolExposure, loadMcpConfig, updateMcpServerConfig } from "../src/extensions/mcp/config.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), "mcp-adapter-cli-"));
	dirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	const lines: string[] = [];
	return {
		agentDir,
		cwd,
		log: (line: string) => {
			lines.push(line);
		},
		error: (line: string) => {
			lines.push(line);
		},
		lines,
	};
}

describe("MCP config and shell commands", () => {
	it("adds/removes both scopes without executing configuration, preserving unrelated content", async () => {
		const options = setup();
		const path = join(options.agentDir, "mcp.json");
		writeFileSync(
			path,
			JSON.stringify({ unrelated: 17, mcpServers: { keep: { command: "unused", enabled: false } } }),
		);
		expect(await runMcpCommand(["add", "docs", "--env", "KEY=fake", "--", "unused", "--remote-flag"], options)).toBe(
			0,
		);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			unrelated: 17,
			mcpServers: {
				keep: { command: "unused", enabled: false },
				docs: { command: "unused", args: ["--remote-flag"], env: { KEY: "fake" } },
			},
		});
		expect(
			await runMcpCommand(
				["add", "local", "-l", "--url", "https://example.test/mcp", "--exposure", "direct"],
				options,
			),
		).toBe(0);
		expect(await runMcpCommand(["remove", "local", "-l"], options)).toBe(0);
		expect(await runMcpCommand(["remove", "docs"], options)).toBe(0);
		expect(await runMcpCommand(["remove", "docs"], options)).toBe(1);
	});
	it("accepts codemode but rejects unsupported exposure aliases/provider auth/CIMD", async () => {
		const options = setup();
		writeFileSync(
			join(options.agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					code: { command: "unused", exposure: "codemode" },
					alias: { command: "unused", exposure: "codemode-deferred" },
					provider: { url: "https://example.test/mcp", auth: { provider: "radius" } },
					cimd: { url: "https://example.test/mcp", oauth: { clientRegistration: "cimd" } },
				},
			}),
		);
		const loaded = loadMcpConfig({ ...options, projectTrusted: false });
		expect(loaded.servers.map((server) => server.name)).toEqual(["code"]);
		expect(loaded.errors).toHaveLength(3);
		expect(
			await runMcpCommand(["add", "legacy", "--url", "https://example.test/mcp", "--exposure", "codemode"], options),
		).toBe(0);
		writeFileSync(
			join(options.agentDir, "mcp.json"),
			JSON.stringify({ autoEnableCodemode: true, mcpServers: { docs: { command: "unused" } } }),
		);
		expect(loadMcpConfig({ ...options, projectTrusted: false })).toMatchObject({
			autoEnableCodemode: true,
			servers: [expect.objectContaining({ name: "docs" })],
			errors: [],
		});
	});
	it("keeps project overrides narrow and uses codemode as the removable default", () => {
		const options = setup();
		const global = join(options.agentDir, "mcp.json");
		const project = join(options.cwd, CONFIG_DIR_NAME, "mcp.json");
		writeFileSync(
			global,
			JSON.stringify({ mcpServers: { docs: { command: "unused", env: { KEY: "fake" }, exposure: "direct" } } }),
		);
		writeFileSync(project, JSON.stringify({ mcpServers: { docs: { enabled: false, args: ["unsafe"] } } }));
		expect(loadMcpConfig({ ...options, projectTrusted: true }).errors[0]).toContain(
			"only set enabled, exposure, toolExposure",
		);
		writeFileSync(project, JSON.stringify({ mcpServers: { docs: { enabled: false, exposure: "codemode" } } }));
		const loaded = loadMcpConfig({ ...options, projectTrusted: true });
		expect(loaded.servers[0].config).toEqual({
			command: "unused",
			env: { KEY: "fake" },
			exposure: "codemode",
			enabled: false,
		});
		updateMcpServerConfig(project, "docs", { enabled: true, exposure: "codemode" });
		expect(JSON.parse(readFileSync(project, "utf8")).mcpServers.docs).toEqual({
			enabled: true,
			exposure: "codemode",
		});
		updateMcpServerConfig(global, "docs", { exposure: "codemode" });
		expect(JSON.parse(readFileSync(global, "utf8")).mcpServers.docs.exposure).toBeUndefined();
		expect(
			getMcpToolExposure(
				{ command: "unused", toolExposure: { "get_*": "deferred", get_me: "direct", "*delete*": "hidden" } },
				"get_me",
			),
		).toBe("direct");
	});
	it("lists only trusted projects, honors host/session overrides, and drains transports", async () => {
		const options = setup();
		writeFileSync(
			join(options.cwd, CONFIG_DIR_NAME, "mcp.json"),
			JSON.stringify({ mcpServers: { project: { command: "unused" } } }),
		);
		const opened: string[] = [];
		let closed = 0;
		const createTransport = (entry: { name: string }) => {
			opened.push(entry.name);
			const pair = createInMemoryTransportPair();
			pair.client.onClose(() => {
				closed++;
			});
			pair.server.onMessage((message) => {
				if (!("id" in message) || !("method" in message)) return;
				void pair.server.send({
					jsonrpc: "2.0",
					id: message.id,
					result:
						message.method === "initialize"
							? {
									protocolVersion: LATEST_PROTOCOL_VERSION,
									capabilities: { tools: {} },
									serverInfo: { name: "fake", version: "1" },
								}
							: { tools: [] },
				});
			});
			void pair.server.start();
			return pair.client;
		};
		new ProjectTrustStore(options.agentDir).set(options.cwd, false);
		expect(await runMcpCommand(["list", "--json"], { ...options, createTransport })).toBe(0);
		expect(opened).toEqual([]);
		expect(options.lines.join("\n")).toContain("not trusted");
		expect(await runMcpCommand(["list"], { ...options, createTransport, projectTrusted: true })).toBe(0);
		expect(opened).toEqual(["project"]);
		expect(closed).toBe(1);
	});
	it("logs out isolated credentials without connecting a server", async () => {
		const options = setup();
		writeFileSync(
			join(options.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { docs: { url: "https://example.test/mcp" } } }),
		);
		expect(
			await runMcpCommand(["logout", "docs"], {
				...options,
				createTransport: () => {
					throw new Error("must not connect");
				},
			}),
		).toBe(0);
		expect(options.lines[0]).toContain("No stored credentials");
	});
});
