import { describe, expect, it } from "vitest";
import type { McpExposure, McpStdioServerConfig } from "../src/extensions/mcp/config.ts";
import { MAX_SERVERS_SECTION_CHARS, type McpServerListing, renderServersSection } from "../src/extensions/mcp/index.ts";
import { createToolSearchToolDefinition } from "../src/extensions/tool-search/tool.ts";

function server(name: string, config: Partial<McpStdioServerConfig> = {}): McpServerListing {
	return { entry: { name, config: { command: "unused", ...config }, source: "test" } };
}

describe("MCP discovery prompt routing", () => {
	it("offers both deferred routes without requiring an unavailable tool_search", () => {
		const section = renderServersSection([server("docs")]);
		expect(section).toContain("mcp__docs (deferred)");
		expect(section).toContain("use `tool_search` when available to load declarations for direct calls");
		expect(section).toContain(
			"authorized codemode scripts with `searchTools` and `describeTool`, without prior `tool_search`",
		);
		expect(section).toContain("Use only routes and tools authorized in this session.");
		expect(section).not.toContain("Load the tools of `tool_search` servers with `tool_search`");
	});

	it("does not offer direct discovery for script-only servers", () => {
		const section = renderServersSection([server("scripts", { exposure: "codemode" })]);
		expect(section).toContain("mcp__scripts (codemode)");
		expect(section).toContain("Tools marked `codemode` are called only from authorized codemode scripts.");
		expect(section).not.toContain("tool_search");
		expect(section).not.toContain("For `deferred` tools");
	});

	it("preserves distinct exposure labels for mixed server namespaces", () => {
		const section = renderServersSection([
			server("scripts", { exposure: "codemode" }),
			server("mixed", { exposure: "direct", toolExposure: { search: "deferred", write: "codemode" } }),
			server("docs", { exposure: "deferred" }),
		]);
		expect(section).toContain("mcp__docs (deferred)");
		expect(section).toContain("mcp__mixed (deferred, codemode)");
		expect(section).toContain("mcp__scripts (codemode)");
		expect(section).toContain("For `deferred` tools");
		expect(section).toContain("Tools marked `codemode` are called only");
	});

	it.each(["hidden", "direct"] as const)("does not advertise an entirely %s server", (exposure: McpExposure) => {
		expect(renderServersSection([server("private", { exposure })])).toBeUndefined();
	});

	it("omits disabled servers while preserving authorized per-tool exposure overrides", () => {
		const section = renderServersSection([
			server("disabled", { exposure: "codemode", enabled: false }),
			server("overridden", { exposure: "hidden", toolExposure: { search: "deferred" } }),
		]);
		expect(section).not.toContain("disabled");
		expect(section).toContain("mcp__overridden (deferred)");
		expect(section).not.toContain("Tools marked `codemode`");
	});

	it("keeps bounded listings and omissions on the authorized routes", () => {
		const section = renderServersSection(
			Array.from({ length: 200 }, (_, index) =>
				server(`server-${index}`, {
					exposure: "codemode",
					description: "Description ".repeat(100),
				}),
			),
		)!;
		expect(section.length).toBeLessThanOrEqual(MAX_SERVERS_SECTION_CHARS);
		expect(section).toContain("more servers; find their authorized tools through the routes above");
		expect(section).not.toContain("tool_search");
	});

	it("keeps tool_search direct loading separate from script discovery and authorization", () => {
		const description = createToolSearchToolDefinition().description;
		expect(description).toContain("load their declarations before calling them directly");
		expect(description).toContain("discover schemas with `searchTools` and `describeTool`");
		expect(description).toContain("call deferred tools without prior `tool_search`");
		expect(description).toContain(
			"Tools with `codemode` exposure are callable only from authorized scripts, not loaded by `tool_search`",
		);
		expect(description).toContain("Discovery never grants tool access.");
		expect(description).not.toContain("always discovered");
	});
});
