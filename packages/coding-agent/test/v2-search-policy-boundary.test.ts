import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSearchV2Tool,
	type SearchPage,
	type SearchProvider,
	type SearchRequest,
	type SearchV2Details,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FffSearchProvider } from "../src/core/tools/fff-search-provider.ts";
import { LocalSearchProviderV2 } from "../src/core/tools/local-search-provider-v2.ts";
import { createV2ToolRuntime } from "../src/core/tools/tool-profile.ts";
import { TypeScriptCodeIndexProvider } from "../src/core/tools/typescript-code-index-provider.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(linkName = "linked") {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-search-policy-")));
	roots.push(base);
	const cwd = join(base, "workspace");
	const outside = join(base, "outside");
	mkdirSync(cwd);
	mkdirSync(outside);
	writeFileSync(join(outside, "sentinel.txt"), "FORBIDDEN_SENTINEL\n");
	writeFileSync(join(outside, "sentinel.ts"), "export const FORBIDDEN_SENTINEL = true;\n");
	symlinkSync(outside, join(cwd, linkName));
	return { cwd, outside };
}
function policy(cwd: string, followSymlinks: boolean) {
	return { roots: [cwd], allowOutsideWorkspaceRead: false, allowOutsideWorkspaceWrite: false, followSymlinks };
}
function request(path: string, overrides: Partial<SearchRequest> = {}): SearchRequest {
	return {
		path,
		kind: "text",
		query: "FORBIDDEN_SENTINEL",
		case: "smart",
		regex: false,
		context: 0,
		limit: 20,
		ranking: "fast",
		followSymlinks: true,
		...overrides,
	};
}

describe("Search workspace policy boundary", () => {
	it.each([false, true])("denies descendant escape with policy followSymlinks=%s", async (followSymlinks) => {
		const { cwd } = fixture();
		const provider = new FffSearchProvider(new NodeExecutionEnv({ cwd }));
		const searchSpy = vi.spyOn(provider, "search");
		const runtime = createV2ToolRuntime(cwd, {
			searchProvider: provider,
			workspacePolicy: policy(cwd, followSymlinks),
		});
		try {
			const { search, read } = runtime.definitions;
			const context = {} as Parameters<typeof search.execute>[4];
			await expect(
				read.execute("read", { path: "linked/sentinel.txt" }, undefined, undefined, context),
			).rejects.toMatchObject({ code: followSymlinks ? "OUTSIDE_WORKSPACE" : "SYMLINK_ESCAPE" });
			const found = await search.execute(
				"search",
				{ query: "FORBIDDEN_SENTINEL", followSymlinks: true },
				undefined,
				undefined,
				context,
			);
			const details = found.details as SearchV2Details;
			// The native backend did not return the forbidden text even before the tool's emitted-hit check.
			expect(((await searchSpy.mock.results[0].value) as SearchPage).hits).toEqual([]);
			expect(details.hits).toEqual([]);
			expect(details.complete).toBe(false);
			expect(details.coverage.matchedCountRelation).toBe("unknown");
			expect(details.coverage.skipped.length).toBeGreaterThan(0);
			expect(JSON.stringify(found.content)).not.toContain("FORBIDDEN_SENTINEL");
			expect(JSON.stringify(found.content)).not.toContain("NO_MATCH_COMPLETE");
		} finally {
			await runtime.close();
			await provider.close();
		}
	});

	it.each([false, true])(
		"preserves ordinary files and permitted internal links (follow=%s)",
		async (followSymlinks) => {
			const { cwd } = fixture();
			mkdirSync(join(cwd, "src"));
			writeFileSync(join(cwd, "src", "allowed.txt"), "ALLOWED_SENTINEL\n");
			symlinkSync(join(cwd, "src"), join(cwd, "internal"));
			const runtime = createV2ToolRuntime(cwd, { workspacePolicy: policy(cwd, followSymlinks) });
			try {
				const { search } = runtime.definitions;
				const found = await search.execute(
					"search",
					{ query: "ALLOWED_SENTINEL", followSymlinks: true },
					undefined,
					undefined,
					{} as Parameters<typeof search.execute>[4],
				);
				const paths = (found.details as SearchV2Details).hits.map((hit) => hit.path);
				expect(paths).toContain("src/allowed.txt");
				expect(paths.includes("internal/allowed.txt")).toBe(followSymlinks);
			} finally {
				await runtime.close();
			}
		},
	);

	it.each(["linked", "link[1]*?{x}", "link\\name"])(
		"prunes denied paths before rg/fd traversal: %s",
		async (linkName) => {
			const { cwd } = fixture(linkName);
			const provider = new LocalSearchProviderV2(new NodeExecutionEnv({ cwd }));
			const checked: string[] = [];
			const checkPath = async (candidate: string) => {
				checked.push(candidate);
				return candidate !== join(cwd, linkName);
			};
			try {
				for (const kind of ["text", "files", "glob"] as const) {
					const result = await provider.search(
						request(cwd, {
							kind,
							query: kind === "text" ? "FORBIDDEN_SENTINEL" : kind === "glob" ? "**/*.txt" : "sentinel",
							checkPath,
						}),
						{ workspaceRoot: cwd, scopeId: "test" },
					);
					expect(result.hits).toEqual([]);
					expect(result.complete).toBe(false);
					expect(result.skipped?.length).toBeGreaterThan(0);
				}
				expect(checked).not.toContain(join(cwd, linkName, "sentinel.txt"));
			} finally {
				await provider.close();
			}
		},
	);

	it("checks normal FFF requests without requiring followSymlinks=true", async () => {
		const { cwd, outside } = fixture();
		symlinkSync(join(outside, "sentinel.txt"), join(cwd, "file-link.txt"));
		const runtime = createV2ToolRuntime(cwd, { workspacePolicy: policy(cwd, false) });
		try {
			const { search } = runtime.definitions;
			const found = await search.execute(
				"search",
				{ query: "FORBIDDEN_SENTINEL" },
				undefined,
				undefined,
				{} as Parameters<typeof search.execute>[4],
			);
			expect((found.details as SearchV2Details).hits).toEqual([]);
			expect((found.details as SearchV2Details).coverage.skipped.length).toBeGreaterThan(0);
		} finally {
			await runtime.close();
		}
	});

	it("guards structured source and semantic document indexing without embedding calls", async () => {
		const { cwd, outside } = fixture();
		writeFileSync(join(outside, "ignore-rules"), "safe.ts\n");
		symlinkSync(join(outside, "ignore-rules"), join(cwd, ".gitignore"));
		writeFileSync(join(cwd, "safe.ts"), "export const safe = true;\n");
		const provider = new TypeScriptCodeIndexProvider();
		const checkPath = vi.fn(
			async (candidate: string) => candidate !== join(cwd, ".gitignore") && candidate !== join(cwd, "linked"),
		);
		try {
			const result = await provider.search(request(cwd, { mode: "symbol_definition", checkPath }), {
				workspaceRoot: cwd,
				scopeId: "test",
			});
			expect(result.hits).toEqual([]);
			expect(result.complete).toBe(false);
			const documents = await provider.listSemanticDocuments(request(cwd, { checkPath }));
			expect(documents.documents.map((document) => document.symbol)).toContain("safe");
			expect(checkPath).toHaveBeenCalledWith(join(cwd, ".gitignore"));
			expect(checkPath).toHaveBeenCalledWith(join(cwd, "safe.ts"));
		} finally {
			await provider.close();
		}
	});

	it("rechecks emitted hits from providers before creating locators", async () => {
		const { cwd } = fixture();
		const env = new NodeExecutionEnv({ cwd });
		const provider: SearchProvider = {
			id: "untrusted-hits",
			capabilities: {
				textLiteral: true,
				textRegex: false,
				context: false,
				fuzzyFiles: false,
				glob: false,
				stableCursor: false,
				globalRanking: false,
			},
			async search() {
				return {
					hits: [
						{
							kind: "text",
							path: "linked/sentinel.txt",
							line: 1,
							column: 1,
							text: "FORBIDDEN_SENTINEL",
							ranges: [[0, 18]],
						},
					],
					complete: true,
					partial: false,
					approximate: false,
				};
			},
			async close() {},
		};
		const tool = createSearchV2Tool();
		const found = await tool.execute("search", { query: "sentinel" }, undefined, undefined, {
			env,
			searchProvider: provider,
			workspacePolicy: policy(cwd, true),
		});
		expect(found.details?.hits).toEqual([]);
		expect(found.details?.locators).toEqual([]);
		expect(found.details?.complete).toBe(false);
	});
});
