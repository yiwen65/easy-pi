import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRequest } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSearchProviderV2 } from "../src/core/tools/local-search-provider-v2.ts";

function request(overrides: Partial<SearchRequest>): SearchRequest {
	return {
		kind: "text",
		query: "value",
		path: ".",
		case: "smart",
		regex: false,
		context: 0,
		limit: 20,
		ranking: "fast",
		...overrides,
	};
}

describe("LocalSearchProviderV2", () => {
	let cwd: string;
	let provider: LocalSearchProviderV2;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-v2-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "literal:a.ts"), "before\nconst value = 'a+b';\nafter\n");
		writeFileSync(join(cwd, "src", "AuthService.ts"), "export class AuthService {}\n");
		writeFileSync(join(cwd, "src", "héllo.ts"), "const unicode = '✓';\n");
		writeFileSync(join(cwd, "src", "line\nbreak.ts"), "const newlinePath = true;\n");
		provider = new LocalSearchProviderV2(new NodeExecutionEnv({ cwd }));
	});

	afterEach(async () => {
		await provider.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("parses direct rg JSON into structured literal hits, ranges, and context", async () => {
		const page = await provider.search(
			request({ query: "a+b", path: cwd, case: "sensitive", context: 1, fileGlob: "*.ts" }),
			{ workspaceRoot: cwd, scopeId: "test" },
		);
		expect(page).toMatchObject({ complete: true, approximate: false, partial: false });
		expect(page.hits).toEqual([
			{
				kind: "text",
				path: "src/literal:a.ts",
				line: 2,
				column: 16,
				text: "const value = 'a+b';",
				ranges: [[15, 18]],
				before: [{ line: 1, text: "before" }],
				after: [{ line: 3, text: "after" }],
			},
		]);
	});

	it("supports regex and explicit case modes", async () => {
		const insensitive = await provider.search(request({ query: "authservice", path: cwd, case: "insensitive" }), {
			workspaceRoot: cwd,
			scopeId: "test",
		});
		expect(insensitive.hits).toHaveLength(1);
		const regex = await provider.search(request({ query: "unicode\\s*=", path: cwd, regex: true }), {
			workspaceRoot: cwd,
			scopeId: "test",
		});
		expect(regex.hits).toMatchObject([{ path: "src/héllo.ts", line: 1 }]);
	});

	it("uses NUL-delimited fd output for fuzzy files and deterministic globs", async () => {
		const files = await provider.search(request({ kind: "files", query: "authsvc", path: cwd, ranking: "global" }), {
			workspaceRoot: cwd,
			scopeId: "test",
		});
		expect(files).toMatchObject({ complete: true, approximate: false, partial: false });
		expect(files.hits[0]).toMatchObject({ path: "src/AuthService.ts", pathKind: "file" });

		const glob = await provider.search(request({ kind: "glob", query: "src/**/*.ts", path: cwd }), {
			workspaceRoot: cwd,
			scopeId: "test",
		});
		expect(glob.hits.map((hit) => hit.path)).toEqual([
			"src/AuthService.ts",
			"src/héllo.ts",
			"src/line\nbreak.ts",
			"src/literal:a.ts",
		]);
	});

	it("honors cancellation before spawning a backend", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			provider.search(
				request({ query: "a+b", path: cwd }),
				{ workspaceRoot: cwd, scopeId: "test" },
				controller.signal,
			),
		).rejects.toMatchObject({ message: "Search aborted." });
	});

	it("continues from a stable provider snapshot", async () => {
		const first = await provider.search(request({ kind: "glob", query: "src/**/*.ts", path: cwd, limit: 2 }), {
			workspaceRoot: cwd,
			scopeId: "test",
		});
		expect(first.nextCursor).toBeDefined();
		const second = await provider.search(
			request({
				kind: "glob",
				query: "src/**/*.ts",
				path: cwd,
				limit: 2,
				cursor: first.nextCursor,
				expectedGeneration: first.generation,
			}),
			{ workspaceRoot: cwd, scopeId: "test" },
		);
		expect([...first.hits, ...second.hits].map((hit) => hit.path)).toEqual([
			"src/AuthService.ts",
			"src/héllo.ts",
			"src/line\nbreak.ts",
			"src/literal:a.ts",
		]);
	});
});
