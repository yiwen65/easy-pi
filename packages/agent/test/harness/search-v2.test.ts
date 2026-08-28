import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import type { SearchProvider, SearchRequest } from "../../src/harness/tools/search-provider.ts";
import { compareFileSearchCandidates, createSearchV2Tool } from "../../src/harness/tools/search-v2.ts";
import { createTempDir } from "./session-test-utils.ts";

class FakeProvider implements SearchProvider {
	request?: SearchRequest;
	private readonly result: Awaited<ReturnType<SearchProvider["search"]>>;

	constructor(result: Awaited<ReturnType<SearchProvider["search"]>>) {
		this.result = result;
	}
	async search(request: SearchRequest) {
		this.request = request;
		return this.result;
	}
	async cleanup() {}
}

function context(provider: SearchProvider) {
	return { env: new NodeExecutionEnv({ cwd: createTempDir() }), searchProvider: provider };
}

describe("v2 search", () => {
	it("forwards literal smart-case requests and formats text matches", async () => {
		const provider = new FakeProvider({
			candidates: [{ kind: "text", path: "src/a.ts", line: 2, text: "a[b].c" }],
			truncated: false,
		});
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: "a[b].c" },
			undefined,
			undefined,
			context(provider),
		);
		expect(provider.request).toMatchObject({ query: "a[b].c", regex: false, caseSensitive: false });
		expect(result.content[0]).toMatchObject({ text: "src/a.ts:2: a[b].c" });
	});

	it("ranks exact basename, basename prefix, basename contains, segment prefix, then path contains", () => {
		const paths = ["src/x-auth/file.ts", "src/my-auth.ts", "src/auth/file.ts", "src/auth-service.ts", "src/auth"];
		expect(paths.sort((a, b) => compareFileSearchCandidates(a, b, "auth", false))).toEqual([
			"src/auth",
			"src/auth-service.ts",
			"src/my-auth.ts",
			"src/auth/file.ts",
			"src/x-auth/file.ts",
		]);
	});

	it("rejects empty and invalid regex inputs", async () => {
		const tool = createSearchV2Tool();
		const provider = new FakeProvider({ candidates: [], truncated: false });
		await expect(tool.execute("id", { query: "" }, undefined, undefined, context(provider))).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		await expect(
			tool.execute("id", { query: "[", regex: true }, undefined, undefined, context(provider)),
		).rejects.toMatchObject({ code: "INVALID_REGEX" });
	});

	it("labels provider truncation as bounded rather than global top N", async () => {
		const provider = new FakeProvider({ candidates: [{ kind: "file", path: "src/auth.ts" }], truncated: true });
		const result = await createSearchV2Tool().execute(
			"id",
			{ query: "auth", kind: "files" },
			undefined,
			undefined,
			context(provider),
		);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("not a global top N") });
		expect(result.details.truncated).toBe(true);
	});
});
