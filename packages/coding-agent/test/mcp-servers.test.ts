import { describe, expect, it, vi } from "vitest";
import {
	createToolNameMatcher,
	getMcpToolExposure,
	isLoopbackRedirectUri,
	isMcpToolName,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	type McpServerConfig,
	McpServerRegistry,
	mcpNamespace,
	READ_MCP_RESOURCE_TOOL,
	validateMcpServerConfig,
} from "../src/core/mcp-servers.ts";

describe("MCP server configuration", () => {
	it.each([
		{ command: "node", args: ["server.mjs"], env: { TOKEN: "configured-token" }, cwd: "./tools" },
		{ type: "stdio", command: "server", enabled: false, timeout: 2.5 },
		{ url: "https://example.test/mcp", headers: { Authorization: "Bearer configured-token" } },
		{ type: "http", url: "http://localhost:9000/mcp", exposure: "direct" },
		{ type: "streamable-http", url: "https://example.test/mcp", exposure: "hidden" },
		{ command: "node", exposure: "codemode", toolExposure: { search: "codemode" } },
	])("accepts stdio and Streamable HTTP entries: %j", (config) => {
		expect(validateMcpServerConfig("docs", config)).toEqual(config);
	});

	it("defaults exposure to codemode and does not mutate validated configuration", () => {
		const raw: McpServerConfig = { command: "node", args: ["server.mjs"], toolExposure: { search: "direct" } };
		const validated = validateMcpServerConfig("docs", raw);
		if (typeof validated === "string") throw new Error(validated);
		expect(getMcpToolExposure(validated, "other")).toBe("codemode");
		expect(validated).not.toBe(raw);
		raw.toolExposure!.search = "hidden";
		if ("command" in raw) raw.args!.push("changed");
		expect(validated.toolExposure).toEqual({ search: "direct" });
		expect("command" in validated && validated.args).toEqual(["server.mjs"]);
	});

	it.each([
		["bad name", { command: "node" }, "invalid server name"],
		["", { command: "node" }, "invalid server name"],
		["docs", null, "must be an object"],
		["docs", [], "must be an object"],
		["docs", { args: [] }, 'needs either "command"'],
		["docs", { command: "node", url: "https://example.test/mcp" }, "specify either command or url, not both"],
		["docs", { command: " " }, "command must be a non-empty string"],
		["docs", { command: "node", args: [1] }, "args must be an array of strings"],
		["docs", { command: "node", env: { TOKEN: 1 } }, "env must map names to strings"],
		["docs", { command: "node", cwd: 1 }, "cwd must be a string"],
		["docs", { command: "node", enabled: "no" }, "enabled must be a boolean"],
		["docs", { command: "node", description: false }, "description must be a string"],
		["docs", { command: "node", timeout: 0 }, "timeout must be a positive number"],
		["docs", { command: "node", timeout: Infinity }, "timeout must be a positive number"],
		["docs", { command: "node", timeout: NaN }, "timeout must be a positive number"],
		["docs", { type: "sse", url: "https://example.test/mcp" }, "legacy SSE transport is not supported"],
		["docs", { url: "example.test/mcp" }, "url must be an http or https URL"],
		["docs", { url: "file:///tmp/server" }, "url must be an http or https URL"],
		["docs", { url: "https://example.test/mcp", headers: { X: false } }, "headers must map names to strings"],
		["docs", { command: "node", toolExposure: [] }, "toolExposure must map tool names to exposures"],
	])("rejects invalid entries: %s %j", (name, raw, message) => {
		expect(validateMcpServerConfig(name as string, raw)).toEqual(expect.stringContaining(message as string));
	});

	it.each(["codemode-deferred", "model-only", "invalid"])(
		"rejects unsupported MCP exposure %s rather than translating it",
		(exposure) => {
			expect(validateMcpServerConfig("docs", { command: "node", exposure })).toContain("exposure must be one of");
			expect(validateMcpServerConfig("docs", { command: "node", toolExposure: { search: exposure } })).toContain(
				'toolExposure "search" must be one of',
			);
		},
	);

	it.each([true, false])("rejects explicit autoEnableCodemode=%s", (autoEnableCodemode) => {
		expect(validateMcpServerConfig("docs", { command: "node", autoEnableCodemode })).toContain(
			"autoEnableCodemode is not supported",
		);
	});

	it("rejects provider-token auth and CIMD, but accepts OAuth DCR", () => {
		expect(
			validateMcpServerConfig("docs", { url: "https://example.test/mcp", auth: { provider: "openai" } }),
		).toContain("auth.provider is not supported");
		expect(
			validateMcpServerConfig("docs", { url: "https://example.test/mcp", oauth: { clientRegistration: "cimd" } }),
		).toContain("CIMD is not supported");
		// Unsupported auth settings cannot slip through a stdio entry either.
		expect(validateMcpServerConfig("docs", { command: "node", oauth: { clientRegistration: "cimd" } })).toContain(
			"CIMD is not supported",
		);
		const config = {
			url: "https://example.test/mcp",
			oauth: {
				clientRegistration: "dcr",
				clientName: "Easy Pi",
				callbackUrl: "http://127.0.0.1:8080/callback",
				callbackPort: 8080,
				scope: "read write",
				authServerMetadataUrl: "https://idp.example.test/metadata",
			},
		};
		expect(validateMcpServerConfig("docs", config)).toEqual(config);
		expect(
			validateMcpServerConfig("docs", { url: config.url, oauth: { clientId: "id", clientSecret: "secret" } }),
		).toEqual({
			url: config.url,
			oauth: { clientId: "id", clientSecret: "secret" },
		});
	});

	it.each([
		[null, "oauth must be an object"],
		[{ clientId: 1 }, "oauth.clientId must be a string"],
		[{ clientSecret: false }, "oauth.clientSecret must be a string"],
		[{ callbackPort: 0 }, "oauth.callbackPort must be a port number"],
		[{ callbackPort: 65536 }, "oauth.callbackPort must be a port number"],
		[{ callbackPort: 1.2 }, "oauth.callbackPort must be a port number"],
		[{ callbackUrl: "https://example.test/callback" }, "oauth.callbackUrl must be an http URI"],
		[{ callbackUrl: "http://localhost:8080/cb", callbackPort: 9000 }, "name different ports"],
		[{ scope: [] }, "oauth.scope must be a string"],
		[{ clientName: " " }, "oauth.clientName must be a non-empty string"],
		[{ clientRegistration: "auto" }, 'oauth.clientRegistration must be "dcr"'],
		[
			{ authServerMetadataUrl: "http://idp.example.test/metadata" },
			"oauth.authServerMetadataUrl must be an https URL",
		],
	])("validates OAuth fields: %j", (oauth, message) => {
		expect(validateMcpServerConfig("docs", { url: "https://example.test/mcp", oauth })).toEqual(
			expect.stringContaining(message as string),
		);
	});

	it("resolves exact overrides before ordered patterns, treating only * as special", () => {
		const config: McpServerConfig = {
			command: "node",
			exposure: "deferred",
			toolExposure: { "get_*": "direct", get_me: "hidden", "*delete*": "hidden" },
		};
		expect(getMcpToolExposure(config, "get_me")).toBe("hidden");
		expect(getMcpToolExposure(config, "get_delete_hint")).toBe("direct");
		expect(getMcpToolExposure(config, "delete_repo")).toBe("hidden");
		expect(getMcpToolExposure(config, "list")).toBe("deferred");
		expect(getMcpToolExposure({ command: "node", toolExposure: { "get_file.*": "direct" } }, "get_file_x")).toBe(
			"codemode",
		);
		expect(getMcpToolExposure({ command: "node", toolExposure: { "get_file.*": "direct" } }, "get_file.json")).toBe(
			"direct",
		);
		expect(getMcpToolExposure({ command: "node" }, "constructor")).toBe("codemode");
	});

	it.each([
		["http://localhost/callback", true],
		["http://127.0.0.1:8000/cb", true],
		["http://[::1]/callback", true],
		["http://localhost.evil.test/callback", false],
		["http://localhost/callback?code=1", false],
		["http://localhost/callback#fragment", false],
		["http://user:password@localhost/callback", false],
		["https://localhost/callback", false],
		["not a URL", false],
	])("checks callback URI %s", (url, expected) => {
		expect(isLoopbackRedirectUri(url)).toBe(expected);
	});

	it("exposes namespace, pattern matching, and shared resource tool helpers", () => {
		expect(mcpNamespace("my-docs")).toBe("mcp__my_docs");
		const matches = createToolNameMatcher(["read", "mcp__docs__*", "literal.*"]);
		expect(matches("read")).toBe(true);
		expect(matches("reader")).toBe(false);
		expect(matches("mcp__docs__search")).toBe(true);
		expect(matches("literal.json")).toBe(true);
		expect(matches("literalXjson")).toBe(false);
		for (const name of [
			"mcp__docs__search",
			LIST_MCP_RESOURCES_TOOL,
			LIST_MCP_RESOURCE_TEMPLATES_TOOL,
			READ_MCP_RESOURCE_TOOL,
		]) {
			expect(isMcpToolName(name)).toBe(true);
		}
		expect(isMcpToolName("read")).toBe(false);
	});
});

describe("MCP server registry", () => {
	it("enforces ownership and namespace uniqueness, without emitting on rejected changes", () => {
		const registry = new McpServerRegistry();
		const changed = vi.fn();
		registry.setChangeListener(changed);
		registry.register({ name: "my-docs", config: { command: "node" }, extensionPath: "owner" });
		registry.register({ name: "my-docs", config: { url: "https://example.test/mcp" }, extensionPath: "owner" });
		expect(changed).toHaveBeenCalledTimes(2);
		expect(() => registry.register({ name: "my-docs", config: { command: "evil" }, extensionPath: "other" })).toThrow(
			'already registered by extension "owner"',
		);
		expect(() => registry.register({ name: "my_docs", config: { command: "node" }, extensionPath: "owner" })).toThrow(
			'conflicts with registered server "my-docs"',
		);
		registry.unregister("my-docs", "other");
		registry.unregister("missing", "owner");
		expect(changed).toHaveBeenCalledTimes(2);
		expect(registry.list()).toHaveLength(1);
		registry.unregister("my-docs", "owner");
		expect(changed).toHaveBeenCalledTimes(3);
		expect(registry.list()).toEqual([]);
	});

	it("stores and returns detached snapshots in registration order", () => {
		const registry = new McpServerRegistry();
		const config: McpServerConfig = { command: "node", args: ["server.mjs"] };
		registry.register({ name: "one", config, extensionPath: "owner" });
		config.args!.push("mutated");
		registry.register({ name: "two", config: { command: "node" }, extensionPath: "owner" });
		registry.register({ name: "one", config: { command: "node", args: ["original"] }, extensionPath: "owner" });
		const snapshot = registry.list();
		if ("command" in snapshot[0].config) snapshot[0].config.args!.push("changed");
		const single = registry.get("one")!;
		single.extensionPath = "other";
		expect(registry.list().map((server) => server.name)).toEqual(["one", "two"]);
		expect(registry.get("one")).toEqual({
			name: "one",
			config: { command: "node", args: ["original"] },
			extensionPath: "owner",
		});
		expect(registry.get("missing")).toBeUndefined();
	});
});
