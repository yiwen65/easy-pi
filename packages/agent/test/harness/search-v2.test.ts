import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import type {
	SearchExecutionContext,
	SearchPage,
	SearchProvider,
	SearchRequest,
} from "../../src/harness/tools/search-provider.ts";
import { createSearchV2Tool } from "../../src/harness/tools/search-v2.ts";
import { createTempDir } from "./session-test-utils.ts";

class FakeProvider implements SearchProvider {
	readonly id = "fake";
	readonly capabilities = {
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
			text: expect.stringMatching(/^loc_[^\t]+\tsrc\/a\.ts:2:4\ttext\t"a\[b\]\.c"$/),
		});
		expect((result.content[0] as { text: string }).text).not.toContain("before");
		expect((result.content[0] as { text: string }).text).not.toContain("xx ");
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
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("[partial: approximate ranking.]") });
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

	it("keeps model-visible output inside the byte budget", async () => {
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
		expect(result.details.coverage).toMatchObject({
			returnedCount: 0,
			truncated: true,
			truncatedBy: "max_output_bytes",
		});
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

	it("centers bounded previews on matches in long lines", async () => {
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
		expect((result.content[0] as { text: string }).text).not.toContain("a".repeat(100));
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
			tool.execute("id", { query: "x", context: 1 }, undefined, undefined, context(provider)),
		).rejects.toMatchObject({
			code: "SEARCH_CAPABILITY_UNSUPPORTED",
		});
		expect(provider.requests).toHaveLength(0);
	});
});
