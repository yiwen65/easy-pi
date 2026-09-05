import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import type {
	SearchCapabilities,
	SearchExecutionContext,
	SearchPage,
	SearchProvider,
	SearchRequest,
} from "../../src/harness/tools/search-provider.ts";
import { createSearchV2Tool } from "../../src/harness/tools/search-v2.ts";
import { ToolStateLedger } from "../../src/harness/tools/tool-state.ts";
import { createTempDir } from "./session-test-utils.ts";

class FakeProvider implements SearchProvider {
	readonly id = "fake";
	readonly capabilities: SearchCapabilities = {
		textLiteral: true,
		textRegex: true,
		context: true,
		fuzzyFiles: true,
		glob: true,
		stableCursor: true,
		globalRanking: true,
		scopeFilters: true,
		wordBoundary: true,
	};
	requests: SearchRequest[] = [];
	contexts: SearchExecutionContext[] = [];
	private readonly pages: SearchPage[];

	constructor(...pages: SearchPage[]) {
		this.pages = pages;
	}
	async search(request: SearchRequest, context: SearchExecutionContext) {
		this.requests.push(request);
		this.contexts.push(context);
		return this.pages.shift() ?? { hits: [], complete: true, approximate: false, partial: false };
	}
	async close() {}
}

function context(provider: SearchProvider, cwd = createTempDir(), scopeId = "session-1") {
	return { env: new NodeExecutionEnv({ cwd }), searchProvider: provider, search: { scopeId } };
}

describe("v2 search", () => {
	it("advertises structured selector constraints in the model-visible schema", () => {
		const parameters = createSearchV2Tool().parameters as unknown as {
			properties: Record<string, { description?: string }>;
		};
		expect(parameters.properties.mode?.description).toContain("do not combine with queryTemplate");
		expect(parameters.properties.queryTemplate?.description).toContain("do not combine with mode");
		expect(parameters.properties.targetKind?.description).toContain("omit for semantic candidates");
		expect(parameters.properties.context?.description).toContain("structured/semantic modes require 0");
		expect(parameters.properties.ranking?.description).toContain("file or structured search");
	});

	it("forwards structured literal smart-case requests and preserves hit ranges", async () => {
		const provider = new FakeProvider({
			hits: [
				{
					kind: "text",
					path: "src/a.ts",
					line: 2,
					column: 4,
					text: "xx a[b].c",
					ranges: [[3, 9]],
					before: [{ line: 1, text: "before" }],
				},
			],
			complete: true,
			approximate: false,
			partial: false,
		});
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: "a[b].c", fileGlob: "*.ts", context: 1 },
			undefined,
			undefined,
			context(provider),
		);
		expect(provider.requests[0]).toMatchObject({
			query: "a[b].c",
			kind: "text",
			regex: false,
			case: "smart",
			context: 1,
			fileGlob: "*.ts",
		});
		expect(result.details.hits[0]).toMatchObject({ ranges: [[3, 9]], column: 4 });
		expect(result.details.locators[0]).toMatchObject({
			locatorId: expect.stringMatching(/^loc_/),
			path: "src/a.ts",
			startLine: 2,
			startColumn: 4,
			match: "a[b].c",
		});
		expect(result.content[0]).toMatchObject({
			text: expect.stringMatching(/^src\/a\.ts\n {2}loc_[^\t]+\t2:4\ttext\t"a\[b\]\.c"\tpreview="xx a\[b\]\.c"$/),
		});
		expect(result.details.groups).toEqual([{ path: "src/a.ts", locatorIds: [result.details.locators[0].locatorId] }]);
		expect((result.content[0] as { text: string }).text).not.toContain("before");
	});

	it("groups same-file locators without repeating paths", async () => {
		const provider = new FakeProvider({
			hits: [
				{ kind: "text", path: "src/a.ts", line: 1, column: 1, text: "target", ranges: [[0, 6]] },
				{ kind: "text", path: "src/a.ts", line: 4, column: 3, text: "  target", ranges: [[2, 8]] },
				{ kind: "text", path: "src/b.ts", line: 2, column: 1, text: "target", ranges: [[0, 6]] },
			],
			complete: true,
			approximate: false,
			partial: false,
		});
		const result = await createSearchV2Tool().execute(
			"grouped",
			{ query: "target" },
			undefined,
			undefined,
			context(provider),
		);
		expect(result.details.groups).toEqual([
			{ path: "src/a.ts", locatorIds: result.details.locators.slice(0, 2).map((locator) => locator.locatorId) },
			{ path: "src/b.ts", locatorIds: [result.details.locators[2].locatorId] },
		]);
		const text = (result.content[0] as { text: string }).text;
		expect(text.match(/src\/a\.ts/g)).toHaveLength(1);
		expect(text.match(/src\/b\.ts/g)).toHaveLength(1);
	});

	it("binds opaque cursors to the request, provider, generation, and session scope", async () => {
		const provider = new FakeProvider(
			{
				hits: [{ kind: "file", path: "a.ts" }],
				nextCursor: "provider-secret-offset",
				complete: true,
				approximate: false,
				partial: false,
				generation: "generation-1",
			},
			{
				hits: [{ kind: "file", path: "b.ts" }],
				complete: true,
				approximate: false,
				partial: false,
				generation: "generation-1",
			},
		);
		const tool = createSearchV2Tool();
		const executionContext = context(provider);
		const first = await tool.execute(
			"first",
			{ query: "ts", kind: "files", limit: 1 },
			undefined,
			undefined,
			executionContext,
		);
		expect(first.details.nextCursor).toMatch(/^s2-/);
		expect(first.details.nextCursor).not.toContain("provider-secret-offset");
		const second = await tool.execute(
			"second",
			{ query: "ts", kind: "files", limit: 1, cursor: first.details.nextCursor },
			undefined,
			undefined,
			executionContext,
		);
		expect(second.details.hits).toEqual([{ kind: "file", path: "b.ts" }]);
		expect(provider.requests[1]).toMatchObject({
			cursor: "provider-secret-offset",
			expectedGeneration: "generation-1",
		});
		await expect(
			tool.execute(
				"mismatch",
				{ query: "different", kind: "files", limit: 1, cursor: first.details.nextCursor },
				undefined,
				undefined,
				executionContext,
			),
		).rejects.toMatchObject({ code: "STALE_CURSOR" });
	});

	it("keeps approximate and partial results as normal structured results", async () => {
		const provider = new FakeProvider({
			hits: [{ kind: "file", path: "src/auth.ts", score: 10 }],
			complete: false,
			approximate: true,
			partial: true,
		});
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: "auth", kind: "files" },
			undefined,
			undefined,
			context(provider),
		);
		expect(result.details).toMatchObject({
			status: "partial",
			complete: false,
			approximate: true,
			partial: true,
		});
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("[partial: coverage incomplete; approximate ranking.]"),
		});
	});

	it("labels positive incomplete coverage even without approximation or truncation notices", async () => {
		const provider = new FakeProvider({
			hits: [{ kind: "text", path: "a.ts", line: 1, column: 1, text: "target", ranges: [[0, 6]] }],
			complete: false,
			approximate: false,
			partial: true,
		});
		const result = await createSearchV2Tool().execute(
			"partial",
			{ query: "target" },
			undefined,
			undefined,
			context(provider),
		);
		expect(result.details.status).toBe("partial");
		expect(result.details.locators).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("[partial: coverage incomplete.]") });
	});

	it("dispatches verified structured modes and preserves provider metadata", async () => {
		const provider = new FakeProvider({
			hits: [
				{
					kind: "text",
					path: "src/service.ts",
					line: 4,
					endLine: 6,
					column: 17,
					endColumn: 26,
					text: "export function configure() {",
					ranges: [[16, 25]],
					matchKind: "definition",
					enclosingSymbol: "configure",
					nodeKind: "FunctionDeclaration",
					rankReasons: ["exact_symbol", "definition_match"],
				},
			],
			complete: true,
			approximate: false,
			partial: false,
			generation: "ts-1",
		});
		provider.capabilities.structuredModes = ["symbol_definition"];
		provider.capabilities.taskRanking = true;
		const result = await createSearchV2Tool().execute(
			"structured",
			{ query: "configure", mode: "symbol_definition", targetKind: "definition" },
			undefined,
			undefined,
			{ ...context(provider), structuredSearchProvider: provider },
		);
		expect(provider.requests[0]).toMatchObject({
			query: "configure",
			kind: "text",
			mode: "symbol_definition",
			targetKind: "definition",
			regex: false,
			context: 0,
			ranking: "task",
		});
		expect(result.details).toMatchObject({ mode: "symbol_definition", targetKind: "definition" });
		expect(result.details.locators[0]).toMatchObject({
			startLine: 4,
			endLine: 6,
			startColumn: 17,
			endColumn: 26,
			matchKind: "definition",
			enclosingSymbol: "configure",
			nodeKind: "FunctionDeclaration",
			rankReasons: ["exact_symbol", "definition_match"],
		});
		expect((result.content[0] as { text: string }).text).toContain(
			'preview="export function configure() {"\tsymbol="configure"\tnode="FunctionDeclaration"',
		);
	});

	it("routes semantic query templates with task ranking and path priors", async () => {
		const provider = new FakeProvider({
			hits: [
				{
					kind: "text",
					path: "src/billing/reconcile.ts",
					line: 8,
					column: 17,
					text: "export function settleInvoice() {",
					ranges: [[16, 29]],
					matchKind: "semantic_candidate",
					score: 0.98,
					rankReasons: ["semantic_similarity", "preferred_path"],
				},
			],
			complete: true,
			approximate: true,
			partial: false,
		});
		provider.capabilities.structuredModes = ["semantic_candidate"];
		provider.capabilities.taskRanking = true;
		const result = await createSearchV2Tool().execute(
			"semantic",
			{
				query: "payment reconciliation",
				queryTemplate: "concept",
				preferredPaths: ["src/billing/**"],
			},
			undefined,
			undefined,
			{ ...context(provider), semanticSearchProvider: provider },
		);
		expect(provider.requests[0]).toMatchObject({
			kind: "text",
			mode: "semantic_candidate",
			targetKind: undefined,
			context: 0,
			queryTemplate: "concept",
			ranking: "task",
			preferredPaths: ["src/billing/**"],
		});
		expect(result.details).toMatchObject({ mode: "semantic_candidate", queryTemplate: "concept", approximate: true });
		expect(result.details.locators[0]).toMatchObject({
			matchKind: "semantic_candidate",
			rankReasons: ["semantic_similarity", "preferred_path"],
		});
	});

	it("fails closed for unsupported structured search modes", async () => {
		const provider = new FakeProvider();
		await expect(
			createSearchV2Tool().execute(
				"id",
				{ query: "configure", mode: "symbol_definition" },
				undefined,
				undefined,
				context(provider),
			),
		).rejects.toMatchObject({
			code: "SYMBOL_INDEX_UNAVAILABLE",
			details: { fallbackAllowed: true, recovery: { kind: "use_text_fallback" } },
		});
		await expect(
			createSearchV2Tool().execute(
				"target-kind",
				{ query: "configure", targetKind: "definition" },
				undefined,
				undefined,
				context(provider),
			),
		).rejects.toMatchObject({ code: "SYMBOL_INDEX_UNAVAILABLE" });
		expect(provider.requests).toHaveLength(0);
	});

	it("forwards scope and traversal controls", async () => {
		const provider = new FakeProvider({ hits: [], complete: true, approximate: false, partial: false });
		await createSearchV2Tool().execute(
			"id",
			{
				query: "target",
				include: ["src/**/*.ts"],
				exclude: ["**/*.test.ts"],
				honorIgnore: false,
				includeHidden: true,
				followSymlinks: true,
				wordBoundary: true,
			},
			undefined,
			undefined,
			context(provider),
		);
		expect(provider.requests[0]).toMatchObject({
			include: ["src/**/*.ts"],
			exclude: ["**/*.test.ts"],
			honorIgnore: false,
			includeHidden: true,
			followSymlinks: true,
			wordBoundary: true,
		});
	});

	it("deduplicates and enforces per-file and matched-file budgets", async () => {
		const first = {
			kind: "text" as const,
			path: "a.ts",
			line: 1,
			column: 1,
			text: "x",
			ranges: [[0, 1]] as Array<[number, number]>,
		};
		const provider = new FakeProvider({
			hits: [first, { ...first }, { ...first, line: 2 }, { ...first, line: 3 }, { ...first, path: "b.ts" }],
			complete: true,
			approximate: false,
			partial: false,
			matchedCount: 5,
			matchedCountRelation: "exact",
		});
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: "x", maxResultsPerFile: 2, maxFiles: 1 },
			undefined,
			undefined,
			context(provider),
		);
		expect(result.details.locators).toHaveLength(2);
		expect(result.details.coverage).toMatchObject({
			returnedCount: 2,
			matchedCount: 5,
			matchedCountRelation: "exact",
			truncated: true,
			truncatedBy: "max_files",
		});
		expect(result.details.status).toBe("overflow");
	});

	it("keeps preview-bearing model-visible output inside the byte budget", async () => {
		const provider = new FakeProvider({
			hits: [
				{
					kind: "text",
					path: "generated.ts",
					line: 1,
					column: 161,
					text: `${"界".repeat(160)}target${"😀".repeat(160)}`,
					ranges: [[160, 166]],
				},
			],
			complete: true,
			approximate: false,
			partial: false,
		});
		const toolState = new ToolStateLedger();
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: "target", maxOutputBytes: 128 },
			undefined,
			undefined,
			{ ...context(provider), toolState },
		);
		expect(toolState.getEvidence().locators).toEqual([]);
		const text = (result.content[0] as { text: string }).text;
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(128);
		expect(result.details.coverage).toMatchObject({
			returnedCount: 0,
			truncated: true,
			truncatedBy: "max_output_bytes",
		});
		expect(text).toContain("max_output_bytes");
	});

	it("keeps long file paths inside the model-visible byte budget", async () => {
		const provider = new FakeProvider({
			hits: [{ kind: "file", path: `${"long/".repeat(80)}target.ts` }],
			complete: true,
			approximate: false,
			partial: false,
		});
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: "target", kind: "files", maxOutputBytes: 128 },
			undefined,
			undefined,
			context(provider),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(128);
		expect(result.details.coverage).toMatchObject({ returnedCount: 0, truncatedBy: "max_output_bytes" });
		expect(text).toContain("max_output_bytes");
	});

	it("distinguishes complete zero results from incomplete zero results", async () => {
		const complete = await createSearchV2Tool().execute(
			"complete",
			{ query: "missing" },
			undefined,
			undefined,
			context(new FakeProvider({ hits: [], complete: true, approximate: false, partial: false })),
		);
		expect(complete.details.status).toBe("complete");
		expect(complete.content[0]).toMatchObject({ text: expect.stringContaining("NO_MATCH_COMPLETE") });

		const incomplete = await createSearchV2Tool().execute(
			"incomplete",
			{ query: "missing" },
			undefined,
			undefined,
			context(new FakeProvider({ hits: [], complete: false, approximate: false, partial: true })),
		);
		expect(incomplete.details.status).toBe("partial");
		expect(incomplete.content[0]).toMatchObject({ text: expect.stringContaining("SEARCH_INCOMPLETE") });
	});

	it("shows discriminating escaped previews for identical matches", async () => {
		const provider = new FakeProvider({
			hits: [
				{ kind: "text", path: "src/a.ts", line: 1, column: 7, text: "alpha TARGET one", ranges: [[6, 12]] },
				{ kind: "text", path: "src/a.ts", line: 2, column: 6, text: "beta TARGET two", ranges: [[5, 11]] },
			],
			complete: true,
			approximate: false,
			partial: false,
		});
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: "TARGET" },
			undefined,
			undefined,
			context(provider),
		);
		const output = (result.content[0] as { text: string }).text;
		expect(output).toContain('preview="alpha TARGET one"');
		expect(output).toContain('preview="beta TARGET two"');
	});

	it("bounds long regex ranges and safely renders Unicode and control characters", async () => {
		const longMatch = `x${"😀".repeat(180)}\n\t\u0000END`;
		const controls = 'const 名 = "😀\n\t\u0000";';
		const provider = new FakeProvider({
			hits: [
				{
					kind: "text",
					path: "generated.ts",
					line: 9,
					column: 1,
					text: `${longMatch} trailing`,
					ranges: [[0, longMatch.length]],
				},
				{
					kind: "text",
					path: "controls.ts",
					line: 1,
					column: 1,
					text: controls,
					ranges: [[0, controls.length]],
					enclosingSymbol: "name\n\t\u0000",
					nodeKind: 'String"Literal',
				},
			],
			complete: true,
			approximate: false,
			partial: false,
		});
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: ".*", mode: "regex" },
			undefined,
			undefined,
			context(provider),
		);
		const locator = result.details.locators[0];
		expect(locator.preview?.length).toBeLessThanOrEqual(320);
		expect(locator.preview?.endsWith("\ud83d")).toBe(false);
		expect(locator.match?.length).toBeLessThanOrEqual(200);
		expect(locator.match?.endsWith("\ud83d")).toBe(false);
		expect(locator.suffixOmitted).toBe(true);
		const output = (result.content[0] as { text: string }).text;
		expect(output).toContain("preview (suffix omitted)=");
		expect(output).toContain('preview="const 名 = \\"😀\\n\\t\\u0000\\";"');
		expect(output).toContain(`symbol=${JSON.stringify("name\n\t\u0000")}`);
		expect(output).toContain(`node=${JSON.stringify('String"Literal')}`);
		expect(output).not.toContain("\n\t\u0000");
	});

	it("centers bounded previews on short matches in long lines", async () => {
		const text = `${"a".repeat(1_000)}TARGET${"b".repeat(1_000)}`;
		const provider = new FakeProvider({
			hits: [{ kind: "text", path: "generated.ts", line: 9, column: 1_001, text, ranges: [[1_000, 1_006]] }],
			complete: true,
			approximate: false,
			partial: false,
		});
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: "TARGET" },
			undefined,
			undefined,
			context(provider),
		);
		expect(result.details.locators[0]).toMatchObject({
			match: "TARGET",
			preview: expect.stringContaining("TARGET"),
			prefixOmitted: true,
			suffixOmitted: true,
		});
		expect(result.details.locators[0].preview?.length).toBeLessThanOrEqual(320);
		expect((result.content[0] as { text: string }).text).toContain("preview (prefix omitted, suffix omitted)=");
	});

	it("rejects cursors outside their session scope", async () => {
		const provider = new FakeProvider({
			hits: [{ kind: "file", path: "a.ts" }],
			nextCursor: "private",
			complete: true,
			approximate: false,
			partial: false,
			generation: "g1",
		});
		const tool = createSearchV2Tool();
		const cwd = createTempDir();
		const first = await tool.execute(
			"first",
			{ query: "a", kind: "files" },
			undefined,
			undefined,
			context(provider, cwd, "scope-a"),
		);
		await expect(
			tool.execute(
				"second",
				{ query: "a", kind: "files", cursor: first.details.nextCursor },
				undefined,
				undefined,
				context(provider, cwd, "scope-b"),
			),
		).rejects.toMatchObject({ code: "STALE_CURSOR" });
	});

	it("rejects invalid combinations and unsupported capabilities before provider execution", async () => {
		const provider = new FakeProvider();
		provider.capabilities.context = false;
		const tool = createSearchV2Tool();
		await expect(
			tool.execute("id", { query: "x", kind: "glob", regex: true }, undefined, undefined, context(provider)),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			tool.execute(
				"template-regex-conflict",
				{ query: "x", queryTemplate: "definition", regex: true },
				undefined,
				undefined,
				context(provider),
			),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			tool.execute(
				"target-kind-conflict",
				{ query: "x", mode: "symbol_definition", targetKind: "assignment" },
				undefined,
				undefined,
				{ ...context(provider), structuredSearchProvider: provider },
			),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			tool.execute("id", { query: "x", context: 1 }, undefined, undefined, context(provider)),
		).rejects.toMatchObject({
			code: "SEARCH_CAPABILITY_UNSUPPORTED",
		});
		expect(provider.requests).toHaveLength(0);
	});

	it("enforces ranking, scope, and continuation capabilities for structured providers", async () => {
		const provider = new FakeProvider({
			hits: [],
			complete: true,
			approximate: false,
			partial: false,
		});
		provider.capabilities.structuredModes = ["symbol_definition"];
		const tool = createSearchV2Tool();
		await expect(
			tool.execute("task-ranking", { query: "x", mode: "symbol_definition" }, undefined, undefined, {
				...context(provider),
				structuredSearchProvider: provider,
			}),
		).rejects.toMatchObject({ code: "SEARCH_CAPABILITY_UNSUPPORTED" });
		provider.capabilities.taskRanking = true;
		provider.capabilities.scopeFilters = false;
		await expect(
			tool.execute(
				"scope-filter",
				{ query: "x", mode: "symbol_definition", include: ["src/**"] },
				undefined,
				undefined,
				{ ...context(provider), structuredSearchProvider: provider },
			),
		).rejects.toMatchObject({ code: "SEARCH_CAPABILITY_UNSUPPORTED" });
		expect(provider.requests).toHaveLength(0);

		const cursorProvider = new FakeProvider({
			hits: [{ kind: "file", path: "a.ts" }],
			nextCursor: "private-cursor",
			complete: true,
			approximate: false,
			partial: false,
			generation: "g1",
		});
		const cursorTool = createSearchV2Tool();
		const cursorContext = context(cursorProvider);
		const first = await cursorTool.execute(
			"cursor-first",
			{ query: "a", kind: "files" },
			undefined,
			undefined,
			cursorContext,
		);
		cursorProvider.capabilities.stableCursor = false;
		await expect(
			cursorTool.execute(
				"cursor-second",
				{ query: "a", kind: "files", cursor: first.details.nextCursor },
				undefined,
				undefined,
				cursorContext,
			),
		).rejects.toMatchObject({ code: "SEARCH_CAPABILITY_UNSUPPORTED" });
	});
});
