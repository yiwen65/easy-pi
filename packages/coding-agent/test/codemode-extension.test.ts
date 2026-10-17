import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type AgentTool, type AgentToolCallOutcome, AgentToolError } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext, ToolLoadout } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { executeCodemode, readCodemodeStore } from "../src/extensions/codemode/execute.ts";
import { CodemodeOutputPreview } from "../src/extensions/codemode/output.ts";
import {
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeToolOptions,
	codemodeSchema,
	createCodemodeDescription,
	createCodemodeTool,
	createCodemodeToolDefinition,
} from "../src/extensions/codemode/tool.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const temporaryPaths = new Set<string>();
afterEach(() => {
	for (const path of temporaryPaths) rmSync(dirname(path), { recursive: true, force: true });
	temporaryPaths.clear();
});

function tool(name: string, outputSchema?: AgentTool["outputSchema"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		outputSchema,
		execute: async () => {
			throw new Error("The extension must not invoke handlers directly");
		},
	};
}

function context(
	tools: AgentTool[],
	execute: (
		name: string,
		args: unknown,
		signal: AbortSignal | undefined,
	) => Promise<Omit<AgentToolCallOutcome, "toolCall">>,
) {
	let count = 0;
	const manager = SessionManager.inMemory();
	const ctx = {
		tools,
		sessionManager: manager,
		executeTool: async (name: string, args: unknown, options?: { signal?: AbortSignal }) => ({
			toolCall: { type: "toolCall", id: `parent/${++count}`, name, arguments: args },
			...(await execute(name, args, options?.signal)),
		}),
		waitForNestedTools: async () => "confirmed",
	} as unknown as ExtensionToolContext;
	return { ctx, manager };
}

function known(text: string, structuredContent?: unknown): Omit<AgentToolCallOutcome, "toolCall"> {
	return {
		result: { content: [{ type: "text", text }], details: {}, structuredContent },
		isError: false,
		executionOutcome: "confirmed",
	};
}

function outputText(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

async function failure(
	code: string,
	ctx?: ExtensionToolContext,
	appendEntry: NonNullable<CodemodeToolOptions["appendEntry"]> = vi.fn(),
) {
	try {
		await executeCodemode("parent", { code }, undefined, undefined, ctx, { appendEntry });
		throw new Error("Expected codemode failure");
	} catch (error) {
		expect(error).toBeInstanceOf(AgentToolError);
		if (!(error instanceof AgentToolError)) throw error;
		return error;
	}
}

describe("local codemode extension", () => {
	it("executes plain scripts and separates text/return items from console output", async () => {
		const result = await createCodemodeTool().execute("plain", {
			code: 'text("one"); console.log("log"); return { value: 2 };',
		});
		expect(result.content[0]).toEqual({ type: "text", text: expect.stringMatching(/^Script completed\nWall time/) });
		expect(result.content[1]).toEqual({
			type: "text",
			text: '==> text 1/2 <==\none\n==> text 2/2 <==\n{"value":2}\n<console_output>\nlog\n</console_output>',
		});
		expect(result.details).toEqual({ calls: [] });
	});

	it("reports invalid options as provably not started", async () => {
		const error = await failure('// @options: {"unknown": 1}\nreturn 1;');
		expect(error.executionOutcome).toBe("not_started");
		expect(error.message).toContain("only supports");
	});

	it("preserves partial output for script errors with known execution certainty", async () => {
		const error = await failure('text("partial"); console.log("log"); throw new Error("boom");');
		expect(error.executionOutcome).toBe("confirmed");
		expect(error.message).toContain("Script failed");
		expect(error.message).toContain("partial");
		expect(error.message).toContain("<console_output>\nlog");
		expect(error.message).toContain("boom");
		expect(error.message).toContain("No tool calls were made.");
	});

	it("enforces explicit timeouts without invoking host tools", async () => {
		const error = await failure('// @options: {"timeout_ms": 150}\nwhile (true) {}');
		expect(error.executionOutcome).toBe("confirmed");
		expect(error.message).toContain("Script timed out");
	});

	it("does not inject host or model runtime globals", async () => {
		const result = await createCodemodeTool().execute("plain", {
			code: "return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof models];",
		});
		expect(result.content[1]).toEqual({
			type: "text",
			text: '["undefined","undefined","undefined","undefined","undefined"]',
		});
	});

	it("calls only ctx.executeTool and passes text or explicit structured content to scripts", async () => {
		const { ctx } = context([tool("echo"), tool("stats", Type.Object({ n: Type.Integer() }))], async (name) =>
			name === "stats" ? known("summary", { n: 2 }) : known("echo"),
		);
		const result = await executeCodemode(
			"parent",
			{
				code: "return await Promise.all([tools.echo({}), tools.stats({})]);",
			},
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[1]).toEqual({ type: "text", text: '["echo",{"n":2}]' });
		expect(result.details.calls.map((call) => [call.name, call.status, call.executionOutcome])).toEqual([
			["echo", "ok", "confirmed"],
			["stats", "ok", "confirmed"],
		]);
		expect(result.details.calls.map((call) => call.id)).toEqual(["parent/1", "parent/2"]);
	});

	it("allows handling a confirmed structured MCP error but not an unknown result", async () => {
		const schema = Type.Object({ isError: Type.Boolean() });
		const { ctx } = context([tool("mcp", schema)], async () => ({
			result: {
				content: [{ type: "text", text: "remote error" }],
				details: {},
				structuredContent: { isError: true },
			},
			isError: true,
			executionOutcome: "confirmed",
		}));
		const result = await executeCodemode(
			"parent",
			{ code: "return (await tools.mcp({})).isError;" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[1]).toEqual({ type: "text", text: "true" });
	});

	it("rejects a blocked structured result instead of treating its presentation as an executed value", async () => {
		const { ctx } = context([tool("blocked", Type.Object({ ok: Type.Boolean() }))], async () => ({
			...known("blocked before dispatch", { ok: true }),
			isError: true,
			executionOutcome: "not_started",
		}));
		const result = await executeCodemode(
			"parent",
			{ code: 'try { await tools.blocked({}); return "wrong"; } catch (e) { return e.message; }' },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[1]).toEqual({ type: "text", text: "blocked before dispatch" });
	});

	it("finds tools and namespaces with script identifiers and validates search limits", async () => {
		const nested = tool("mcp__dev-radius__lookup");
		const { ctx } = context([nested], async () => known("unused"));
		const result = await executeCodemode(
			"parent",
			{
				code: 'const ns = await describeNamespace("dev_radius"); const matches = await searchTools("lookup", { limit: 2, namespace: "dev-radius" }); const description = await describeTool("mcp__dev_radius__lookup"); let invalid; try { await searchTools("lookup", {limit: 51}); } catch (e) { invalid = e.message; } return { ns, names: matches.map(m => m.name), hasDescription: description.includes("lookup description"), invalid };',
			},
			undefined,
			undefined,
			ctx,
			{
				getToolNamespace: () => ({
					name: "mcp__dev-radius",
					description: "Development",
					instructions: "Use lookup",
				}),
			},
		);
		const block = result.content[1];
		if (block.type !== "text") throw new Error("No text output");
		expect(JSON.parse(block.text)).toEqual({
			ns: {
				name: "mcp__dev-radius",
				description: "Development",
				instructions: "Use lookup",
				tools: ["mcp__dev_radius__lookup"],
			},
			names: ["mcp__dev_radius__lookup"],
			hasDescription: true,
			invalid: "searchTools() limit must be an integer from 1 to 50",
		});
	});

	it("poisons parent success and store even when the script catches an unknown nested failure", async () => {
		const { ctx } = context([tool("effect", Type.Object({ ok: Type.Boolean() }))], async () => ({
			...known("connection lost", { ok: true }),
			isError: false,
			executionOutcome: "unknown",
		}));
		const append = vi.fn();
		const error = await failure(
			'try { await tools.effect({}); } catch {} store("x", 1); return "caught";',
			ctx,
			append,
		);
		expect(error.executionOutcome).toBe("unknown");
		expect(error.message).toContain("unknown outcome");
		expect(append).not.toHaveBeenCalled();
	});

	it("consults the core drain barrier before committing store", async () => {
		const { ctx } = context([], async () => known("unused"));
		ctx.waitForNestedTools = async () => "unknown";
		const append = vi.fn();
		const error = await failure('store("x", 1); return "done";', ctx, append);
		expect(error.executionOutcome).toBe("unknown");
		expect(append).not.toHaveBeenCalled();
	});

	it("drains unawaited host work after VM cancellation and never commits its writes", async () => {
		let started!: () => void;
		const starting = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let signal: AbortSignal | undefined;
		const { ctx } = context([tool("effect")], async (_name, _args, callSignal) => {
			signal = callSignal;
			started();
			await gate;
			return known("confirmed effect");
		});
		const append = vi.fn();
		let settled = false;
		const running = failure('tools.effect({}); store("x", 1); return "done";', ctx, append).then((error) => {
			settled = true;
			return error;
		});
		await starting;
		await vi.waitFor(() => expect(signal?.aborted).toBe(true));
		expect(settled).toBe(false);
		expect(append).not.toHaveBeenCalled();
		release();
		const error = await running;
		expect(error.executionOutcome).toBe("confirmed");
		expect(error.message).toContain("still running");
		expect(append).not.toHaveBeenCalled();
	});

	it("uses live metadata and refuses a previously catalogued tool after revocation", async () => {
		const target = tool("secret");
		const { ctx } = context([tool("revoke"), target], async (name) => {
			if (name === "revoke") {
				Object.defineProperty(ctx, "tools", { value: [tool("revoke")], configurable: true });
				return known("revoked");
			}
			throw new Error("Revoked tool must not reach the host seam");
		});
		const result = await executeCodemode(
			"parent",
			{
				code: 'await tools.revoke({}); const description = await describeTool("secret"); const search = await searchTools("secret"); let denied; try { await tools.secret({}); } catch (e) { denied = e.message; } return { absent: description === undefined, search, denied };',
			},
			undefined,
			undefined,
			ctx,
		);
		const text = result.content[1];
		if (text.type !== "text") throw new Error("No text output");
		expect(JSON.parse(text.text)).toEqual({
			absent: true,
			search: [],
			denied: 'Tool "secret" is no longer callable',
		});
	});

	it("persists only successful branch store writes, deletion, and excludes sibling branches", async () => {
		const { ctx, manager } = context([], async () => known("unused"));
		const start = manager.appendCustomEntry("anchor");
		const appendEntry = (type: string, data: unknown) => {
			manager.appendCustomEntry(type, data);
		};
		const run = () =>
			executeCodemode(
				"parent",
				{ code: 'const n = (load("n") ?? 0) + 1; store("n", n); return n;' },
				undefined,
				undefined,
				ctx,
				{ appendEntry },
			);
		expect((await run()).content[1]).toEqual({ type: "text", text: "1" });
		expect((await run()).content[1]).toEqual({ type: "text", text: "2" });
		manager.branch(start);
		expect((await run()).content[1]).toEqual({ type: "text", text: "1" });
		await executeCodemode("parent", { code: 'store("n", undefined);' }, undefined, undefined, ctx, { appendEntry });
		expect(readCodemodeStore(manager.getBranch())).toEqual({});
		await failure('store("n", 10); throw new Error("boom");', ctx, appendEntry);
		expect(readCodemodeStore(manager.getBranch())).toEqual({});
	});

	it("discards store when an unexpected branch move occurs during a host call", async () => {
		const { ctx, manager } = context([tool("move")], async () => {
			manager.branch(anchor);
			return known("moved");
		});
		const anchor = manager.appendCustomEntry("anchor");
		manager.appendCustomEntry("after-anchor");
		const append = vi.fn();
		const error = await failure('await tools.move({}); store("x", 1);', ctx, append);
		expect(error.message).toContain("branch changed");
		expect(append).not.toHaveBeenCalled();
	});

	it("spills truncated text privately while preserving images and paths", async () => {
		const result = await executeCodemode(
			"parent",
			{
				code: `// @options: {"max_output_tokens": 30}\nfor (let n = 0; n < 100; n++) text("row " + n); image("data:image/png;base64,${png}");`,
			},
			undefined,
			undefined,
			undefined,
		);
		const fullPath = result.details.fullOutputPath;
		if (!fullPath) throw new Error("Missing full output path");
		temporaryPaths.add(fullPath);
		expect(readFileSync(fullPath, "utf8")).toContain("row 50");
		expect(statSync(fullPath).mode & 0o777).toBe(0o600);
		const text = outputText(result.content);
		expect(text).toContain("Warning: truncated output");
		expect(text).toContain("row 0");
		expect(text).toContain("row 99");
		expect(text).not.toContain("row 50");
		const imagePath = /\[Image saved to (\S+\.png)/.exec(text)?.[1];
		if (!imagePath) throw new Error("Missing image output path");
		temporaryPaths.add(imagePath);
		expect(readFileSync(imagePath).toString("base64")).toBe(png);
		expect(statSync(imagePath).mode & 0o777).toBe(0o600);
		expect(result.content.at(-1)).toEqual({ type: "image", data: png, mimeType: "image/png" });
	});

	it("bounds display calls and argument previews without changing executed calls", async () => {
		let count = 0;
		const { ctx } = context([tool("echo")], async () => {
			count++;
			return known("ok");
		});
		const result = await executeCodemode(
			"parent",
			{ code: 'for (let n = 0; n < 300; n++) await tools.echo({ value: "界".repeat(1000) });' },
			undefined,
			undefined,
			ctx,
		);
		expect(count).toBe(300);
		expect(result.details.calls).toHaveLength(256);
		expect(result.details.omittedCalls).toBe(44);
		expect(result.details.calls.reduce((total, call) => total + Buffer.byteLength(call.args), 0)).toBeLessThanOrEqual(
			32_768,
		);
	});

	it("bounds real VM host dispatch beyond the display cap without committing store", async () => {
		let dispatched = 0;
		const { ctx } = context([tool("echo")], async () => {
			dispatched++;
			return known("ok");
		});
		const drain = vi.fn(async () => "confirmed" as const);
		ctx.waitForNestedTools = drain;
		const append = vi.fn();
		const error = await failure(
			'store("uncommitted", true); for (let n = 0; n < 2048; n++) await tools.echo({});',
			ctx,
			append,
		).finally(() => console.log(`product host calls: dispatched=${dispatched}`));
		expect(dispatched).toBe(1024);
		expect(error.message).toContain("host calls");
		expect(error.executionOutcome).toBe("confirmed");
		expect(error.details).toMatchObject({ calls: expect.any(Array), omittedCalls: 768 });
		expect(drain).toHaveBeenCalledOnce();
		expect(append).not.toHaveBeenCalled();
	});

	it("drains a quota-cancelled effect and preserves its unknown outcome", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let signal: AbortSignal | undefined;
		const { ctx } = context([tool("effect")], async (_name, _args, callSignal) => {
			signal = callSignal;
			await gate;
			return { ...known("interrupted effect"), executionOutcome: "unknown" };
		});
		const append = vi.fn();
		let settled = false;
		const running = failure(
			'tools.effect({}); store("uncommitted", true); for (let n = 0; n < 1024; n++) await describeTool("effect");',
			ctx,
			append,
		).then((error) => {
			settled = true;
			return error;
		});
		await vi.waitFor(() => expect(signal?.aborted).toBe(true));
		expect(settled).toBe(false);
		expect(append).not.toHaveBeenCalled();
		release();
		const error = await running;
		expect(error.executionOutcome).toBe("unknown");
		expect(error.message).toContain("host calls");
		expect(error.details).toMatchObject({ calls: [{ name: "effect", executionOutcome: "unknown" }] });
		expect(append).not.toHaveBeenCalled();
	});

	it("does not persist oversized deletion mutations", async () => {
		const append = vi.fn();
		const error = await failure(
			'store("kept", 1); store("x".repeat(1048577), undefined);',
			undefined,
			append,
		).finally(() =>
			console.log(
				`product store commits=${append.mock.calls.length}, bytes=${Buffer.byteLength(JSON.stringify(append.mock.calls))}`,
			),
		);
		expect(error.message).toContain("RangeError");
		expect(append).not.toHaveBeenCalled();
	});

	it("ignores malformed store entries and keeps prototype-shaped keys as own data", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: [], delete: [] });
		manager.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: { a: 1 }, delete: "bad" });
		manager.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, {
			set: JSON.parse('{"__proto__":{"value":1},"constructor":2}'),
			delete: [],
		});
		const store = readCodemodeStore(manager.getBranch());
		expect(Object.keys(store)).toEqual(["__proto__", "constructor"]);
		expect(Object.getPrototypeOf(store)).toBe(Object.prototype);
	});
});

describe("codemode catalog/loadout", () => {
	it("puts balanced selection guidance in both system prompt and tool description", () => {
		const definition = createCodemodeToolDefinition();
		const prompt = buildSystemPrompt({
			cwd: "/test",
			selectedTools: ["codemode"],
			toolSnippets: { codemode: definition.promptSnippet! },
			promptGuidelines: definition.promptGuidelines,
		});
		for (const text of [
			"batch independent calls, chain deterministic steps, or filter large tool output",
			"Prefer a direct tool for a single simple call when it is declared",
			"split execution when the next step needs model judgment",
		]) {
			expect(prompt).toContain(text);
			expect(definition.description).toContain(text);
		}
	});

	it.each(["on", "only"] as const)("keeps safety boundaries in %s mode even with no catalog budget", (mode) => {
		const direct = tool("read");
		const codemode = createCodemodeTool();
		const definition = createCodemodeToolDefinition({ getMode: () => mode, getInlineBudget: () => 0 });
		const changes = definition.prepareLoadout?.({
			declared: [direct, codemode],
			callable: [direct],
			registered: [direct, codemode],
			getExposure: (name) => (name === "codemode" ? "model-only" : "direct"),
			getNamespace: () => undefined,
			getPromptGuidelines: () => [],
		});
		const description = changes?.descriptions?.codemode;
		for (const text of [
			"Parallelize only independent read-only calls",
			"keep dependent steps and writes ordered",
			"Promise.allSettled()",
			"Await calls that matter; do not fire-and-forget writes",
			"their effects are not undone",
			"inspect external state before retrying; do not repeat unresolved effects",
			"Scripts can call only currently authorized tools",
			"the VM does not isolate effects of Bash or MCP tools",
			"branch-local JSON values",
			"failures, cancellation or unknown outcomes discard them",
		])
			expect(description).toContain(text);
		expect(description).not.toContain("### `read`");
		expect(changes?.hiddenDeclarations).toEqual(mode === "only" ? ["read"] : []);
	});

	it("changes declaration visibility for only mode without changing the callable list", () => {
		const direct = tool("read");
		const deferred = tool("mcp__docs__search");
		const codemode = createCodemodeTool();
		const loadout: ToolLoadout = {
			declared: [direct, codemode],
			callable: [direct, deferred],
			registered: [direct, deferred, codemode],
			getExposure: (name) => (name === deferred.name ? "deferred" : name === "codemode" ? "model-only" : "direct"),
			getNamespace: () => undefined,
			getPromptGuidelines: (name) => (name === "read" ? ["Use read for files"] : []),
		};
		const on = createCodemodeToolDefinition().prepareLoadout?.(loadout);
		expect(on?.hiddenDeclarations).toEqual([]);
		expect(on?.descriptions?.read).toContain("tools.read(args)");
		expect(on?.descriptions?.codemode).not.toContain("### `read`");
		const only = createCodemodeToolDefinition({ getMode: () => "only" }).prepareLoadout?.(loadout);
		expect(only?.hiddenDeclarations).toEqual(["read"]);
		expect(only?.descriptions?.codemode).toContain("### `read`");
		expect(only?.descriptions?.codemode).toContain("- Use read for files");
		expect(only?.descriptions?.codemode).not.toContain("### `mcp__docs__search`");
		expect(loadout.callable).toEqual([direct, deferred]);
	});

	it("keeps grammar input, unsafe parent contract, and no nested codemode declaration", () => {
		const definition = createCodemodeToolDefinition();
		expect(definition.parameters).toBe(codemodeSchema);
		expect(definition.exposure).toBe("model-only");
		expect(definition.defaultActive).toBe(false);
		expect(definition.orchestratesTools).toBe(true);
		expect(definition.contract).toEqual({ sideEffects: "external" });
		expect(definition.executionResource).toBeUndefined();
		expect(definition.constrainedSampling).toMatchObject({ type: "grammar" });
		expect(createCodemodeDescription([createCodemodeTool(), tool("echo")])).not.toContain("### `codemode`");
		expect(createCodemodeDescription([tool("echo")], { inlineBudget: 0 })).not.toContain("### `echo`");
	});

	it("preview limits wrapped rows and respects narrow widths", () => {
		const preview = new CodemodeOutputPreview("a".repeat(500), 3, (hidden) => `${hidden} hidden`);
		const rows = preview.render(12);
		expect(rows.length).toBeLessThanOrEqual(5);
		expect(rows.every((row) => visibleWidth(row) <= 12)).toBe(true);
		expect(rows.join("\n")).toContain("hidden");
	});
});
