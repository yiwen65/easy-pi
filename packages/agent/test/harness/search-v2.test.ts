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

function context(provider: SearchProvider, cwd = createTempDir()) {
	return { env: new NodeExecutionEnv({ cwd }), searchProvider: provider, search: { scopeId: "session-1" } };
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
		expect(result.content[0]).toMatchObject({ text: "src/a.ts-1- before\nsrc/a.ts:2:4: xx a[b].c" });
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
		expect(result.details).toMatchObject({ complete: false, approximate: true, partial: true });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("not a strict global top N") });
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
