import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { AgentToolError } from "@earendil-works/pi-agent-core";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getToolErrorOutcome } from "../../agent/src/tool-outcome.ts";
import type { ToolExposure, ToolInfo } from "../src/core/extensions/types.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { truncateMiddle, writeMcpOutputFile } from "../src/extensions/mcp/output.ts";
import { createMcpResourceToolDefinitions, type McpResourceServer } from "../src/extensions/mcp/resources.ts";
import {
	convertMcpResult,
	createMcpToolDefinition,
	createMcpToolName,
	MCP_OUTPUT_MAX_BYTES,
} from "../src/extensions/mcp/tools.ts";
import {
	Bm25Ranker,
	createToolSearchDocument,
	createToolSearchToolDefinition,
	tokenize,
} from "../src/extensions/tool-search/tool.ts";

function definition(call: () => Promise<CallToolResult>) {
	return createMcpToolDefinition({
		server: "docs",
		tool: { name: "search", inputSchema: {}, annotations: { readOnlyHint: true, idempotentHint: true } },
		name: "mcp__docs__search",
		namespace: { name: "mcp__docs" },
		exposure: "deferred",
		timeoutMs: 50,
		getClient: async () => ({ callTool: call }),
	});
}

describe("MCP result adapter", () => {
	it("uses provider-safe stable collision names", () => {
		expect(createMcpToolName("my-server", "get.item/v2")).toBe("mcp__my_server__get_item_v2");
		const long = createMcpToolName("server", "x".repeat(100));
		expect(long).toHaveLength(64);
		expect(createMcpToolName("server", `${"x".repeat(100)}y`)).not.toBe(long);
		expect(createMcpToolName("s", "a-b", () => true)).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/);
	});

	it("bounds UTF-8 text including wrapper and saves full output without raw result details", async () => {
		const full = `${"é😀".repeat(12000)}end`;
		const saved: (string | Uint8Array)[] = [];
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const result = await convertMcpResult(
			"docs",
			"search",
			{
				content: [{ type: "text", text: full }, image],
				structuredContent: { private: "ignored" },
				_meta: { trace: "ignored" },
			},
			{
				saveOutput: async (value) => {
					saved.push(value);
					return "/tmp/full.txt";
				},
			},
		);
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type !== "text") throw new Error("expected text");
		expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_BYTES);
		expect(text.text).not.toContain("\uFFFD");
		expect(text.text).toContain("chars truncated");
		expect(text.text).toContain("end\n\n[Full output: /tmp/full.txt");
		expect(result.content[1]).toEqual(image);
		expect(result.details).toEqual({ server: "docs", tool: "search", fullOutputPath: "/tmp/full.txt" });
		expect(Object.keys(result)).toEqual(["content", "details", "structuredContent"]);
		expect(result.structuredContent).toEqual({
			content: [{ type: "text", text: full }, image],
			structuredContent: { private: "ignored" },
		});
		expect(result.structuredContent).not.toHaveProperty("_meta");
		expect(saved).toEqual([full]);
	});

	it.each([false, true])(
		"strips every protocol metadata position while preserving business data (isError=%s)",
		async (isError) => {
			const raw: CallToolResult = {
				content: [
					{ type: "text", text: "public text", _meta: { private: "text" } },
					{ type: "image", data: "AAAA", mimeType: "image/png", _meta: { private: "image" } },
					{ type: "audio", data: "", mimeType: "audio/wav", _meta: { private: "audio" } },
					{ type: "resource_link", uri: "docs://link", name: "link", _meta: { private: "link" } },
					{
						type: "resource",
						resource: { uri: "docs://text", text: "public resource", _meta: { private: "text resource" } },
						_meta: { private: "embedded" },
					},
					{
						type: "resource",
						resource: {
							uri: "docs://image",
							blob: "AAAA",
							mimeType: "image/png",
							_meta: { private: "blob resource" },
						},
						_meta: { private: "embedded" },
					},
				],
				structuredContent: { _meta: { business: "ordinary application field" } },
				isError,
				_meta: { private: "result" },
			};
			let publicResult: CallToolResult;
			try {
				publicResult = (await convertMcpResult("docs", "search", raw)).structuredContent as CallToolResult;
				if (isError) throw new Error("Expected a confirmed MCP failure");
			} catch (error) {
				if (!isError || !(error instanceof AgentToolError)) throw error;
				expect(error.executionOutcome).toBe("confirmed");
				publicResult = error.structuredContent as CallToolResult;
			}
			expect(publicResult).not.toHaveProperty("_meta");
			for (const block of publicResult.content) {
				expect(block).not.toHaveProperty("_meta");
				if (block.type === "resource") expect(block.resource).not.toHaveProperty("_meta");
			}
			expect(publicResult.structuredContent).toEqual(raw.structuredContent);
			expect(publicResult.content).toEqual([
				{ type: "text", text: "public text" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "audio", data: "", mimeType: "audio/wav" },
				{ type: "resource_link", uri: "docs://link", name: "link" },
				{ type: "resource", resource: { uri: "docs://text", text: "public resource" } },
				{ type: "resource", resource: { uri: "docs://image", blob: "AAAA", mimeType: "image/png" } },
			]);
			expect(raw.content[0]._meta).toEqual({ private: "text" });
		},
	);

	it("reports explicit MCP errors as confirmed and keeps bounded diagnostics", async () => {
		const work = convertMcpResult(
			"docs",
			"search",
			{ content: [{ type: "text", text: "no".repeat(15000) }], isError: true },
			{ saveOutput: async () => "/tmp/error.txt" },
		);
		await expect(work).rejects.toBeInstanceOf(AgentToolError);
		try {
			await work;
		} catch (error) {
			if (!(error instanceof AgentToolError)) throw error;
			expect(error.executionOutcome).toBe("confirmed");
			expect(getToolErrorOutcome(error, "mcp__docs__search", {}, { contract: { sideEffects: "external" } })).toBe(
				"confirmed",
			);
			expect(error.structuredContent).toEqual({
				content: [{ type: "text", text: "no".repeat(15000) }],
				isError: true,
			});
			expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_BYTES);
			expect(error.details).toEqual({ server: "docs", tool: "search", fullOutputPath: "/tmp/error.txt" });
		}
		await expect(convertMcpResult("docs", "search", { content: [], isError: true })).rejects.toThrow(
			"MCP tool docs/search returned an error",
		);
	});

	it.each([false, true])("preserves explicit unknown-effect metadata even when isError=%s", async (isError) => {
		const raw: CallToolResult = {
			content: [{ type: "text", text: "Interrupted; inspect state before retrying" }],
			structuredContent: { partial: true },
			isError,
			_meta: { "io.easy-pi/execution-outcome": "unknown", private: "not public" },
		};
		const tool = wrapToolDefinition(definition(async () => raw));
		expect(tool.contract).toEqual({ sideEffects: "external" });
		const work = tool.execute("id", {});
		await expect(work).rejects.toMatchObject({
			executionOutcome: "unknown",
			structuredContent: {
				content: raw.content,
				structuredContent: raw.structuredContent,
				isError,
			},
		});
		try {
			await work;
		} catch (error) {
			if (!(error instanceof AgentToolError)) throw error;
			expect(getToolErrorOutcome(error, tool.name, {}, tool)).toBe("unknown");
			expect(error.structuredContent).not.toHaveProperty("_meta");
		}
	});

	it.each(["not_started", "confirmed", false, { outcome: "unknown" }])(
		"never treats remote outcome metadata %j as proof of no dispatch",
		async (marker) => {
			await expect(
				convertMcpResult("desktop", "click", {
					content: [{ type: "text", text: "STALE_REF" }],
					isError: true,
					_meta: { "io.easy-pi/execution-outcome": marker },
				}),
			).rejects.toMatchObject({ executionOutcome: "confirmed" });
		},
	);

	it("never promotes remote annotations into retry or certainty guarantees", async () => {
		const timeout = new Error("sent then timed out");
		const tool = definition(async () => {
			throw timeout;
		});
		expect(tool.contract).toEqual({ sideEffects: "external" });
		expect(tool.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
		expect(tool.outputSchema).toMatchObject({ type: "object", required: ["content"] });
		await expect(wrapToolDefinition(tool).execute("id", {})).rejects.toMatchObject({
			name: "AgentToolError",
			cause: timeout,
			executionOutcome: "unknown",
		});
		const before = {
			...tool,
			...createMcpToolDefinition({
				server: "docs",
				tool: { name: "x", inputSchema: {} },
				name: "x",
				namespace: { name: "docs" },
				exposure: "direct",
				timeoutMs: 50,
				getClient: async () => {
					throw new Error("disabled");
				},
			}),
		};
		await expect(wrapToolDefinition(before).execute("id", {})).rejects.toMatchObject({
			executionOutcome: "not_started",
		});
	});

	it("writes private output references and omits control metadata", async () => {
		const path = await writeMcpOutputFile("complete", ".txt");
		try {
			expect(await readFile(path, "utf8")).toBe("complete");
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(dirname(path), { recursive: true, force: true });
		}
		expect(truncateMiddle("é".repeat(2000), 999).content).not.toContain("\uFFFD");
		const result = await convertMcpResult(
			"docs",
			"x",
			{
				content: [
					{ type: "resource_link", uri: "docs://guide", name: "guide" },
					{ type: "audio", mimeType: "audio/wav", data: "" },
				],
			},
			{ readableResources: true },
		);
		expect(result.content).toEqual([
			{ type: "text", text: '[Resource docs://guide "guide". Read it with read_mcp_resource (server "docs")]' },
			{ type: "text", text: "[audio audio/wav omitted]" },
		]);
	});
});

function info(name: string, exposure: ToolExposure): ToolInfo {
	return {
		name,
		description: "Search issues",
		exposure,
		parameters: Type.Object({}),
		sourceInfo: { path: "test", source: "builtin", scope: "temporary", origin: "top-level" },
	};
}

describe("deferred BM25 discovery", () => {
	it("stems plurals and ranks namespace and schema terms", () => {
		expect(tokenize("listIssues for the GitHub_repo")).toEqual(["list", "issue", "git", "hub", "repo"]);
		const document = createToolSearchDocument(
			{
				...info("x", "deferred"),
				parameters: Type.Object({ project: Type.String({ description: "Kubernetes cluster" }) }),
			},
			{ name: "docs", description: "Deployments" },
		);
		expect(new Bm25Ranker().rank("kubernetes deployment", [document], 1)[0].name).toBe("x");
	});
	it("only additively activates inactive deferred tools from the host view", async () => {
		let active = ["read", "already"];
		const tool = createToolSearchToolDefinition({
			tools: {
				getActiveTools: () => active,
				getAllTools: () => [
					info("hidden", "hidden"),
					info("model", "model-only"),
					info("direct", "direct"),
					info("already", "deferred"),
					info("load", "deferred"),
				],
				setActiveTools: (names) => {
					active = names;
				},
			},
		});
		const result = await wrapToolDefinition(tool).execute("id", { query: "issues" });
		expect(result.details.loaded).toEqual(["load"]);
		expect(active).toEqual(["read", "already", "load"]);
		await expect(wrapToolDefinition(tool).execute("id", { query: "issues", limit: 100 })).rejects.toThrow("1 to 50");
	});
});

describe("MCP resource adapter", () => {
	it("filters App resources/icons/meta and enforces runtime server reach", async () => {
		const resources = [
			{ uri: "docs://a", name: "a", _meta: { private: true }, icons: [{ src: "x" }] },
			{ uri: "ui://view", name: "app" },
		];
		const server: McpResourceServer = {
			name: "docs",
			timeoutMs: 100,
			resourcesPage: async () => ({ resources, nextCursor: "next" }),
			resourceTemplatesPage: async () => ({ resourceTemplates: [] }),
			allResources: async () => resources,
			allResourceTemplates: async () => [],
			readResource: async (uri) => ({ contents: [{ uri, text: "read" }] }),
		};
		let available: McpResourceServer[] = [server];
		const tools = createMcpResourceToolDefinitions({ exposure: "deferred", servers: () => available });
		const result = await wrapToolDefinition(tools[0]).execute("id", { server: "docs" });
		expect(result.content).toEqual([
			{
				type: "text",
				text: '{"server":"docs","resources":[{"server":"docs","uri":"docs://a","name":"a"}],"nextCursor":"next"}',
			},
		]);
		expect(result.details).toEqual({ server: "docs", tool: "list_mcp_resources" });
		available = [];
		await expect(wrapToolDefinition(tools[2]).execute("id", { server: "docs", uri: "docs://a" })).rejects.toThrow(
			"has no resources",
		);
	});
});
