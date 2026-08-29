import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRequest } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FffSearchProvider } from "../src/core/tools/fff-search-provider.ts";

function request(overrides: Partial<SearchRequest>): SearchRequest {
	return {
		kind: "files",
		query: "authservice",
		path: ".",
		case: "smart",
		regex: false,
		context: 0,
		limit: 20,
		ranking: "fast",
		...overrides,
	};
}

describe("FffSearchProvider", () => {
	let cwd: string;
	let provider: FffSearchProvider;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-fff-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(
			join(cwd, "src", "AuthenticationService.ts"),
			"const before = true;\nexport const authMarker = true;\nconst after = true;\n",
		);
		writeFileSync(join(cwd, "src", "other.ts"), "export const other = true;\n");
		provider = new FffSearchProvider(new NodeExecutionEnv({ cwd }));
	});

	afterEach(async () => {
		await provider.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("uses the native index for typo-resistant file search", async () => {
		const page = await provider.search(request({ query: "authneticationservice", path: cwd }), {
			workspaceRoot: cwd,
			scopeId: "fff-test",
		});
		expect(page.hits[0]).toMatchObject({
			kind: "file",
			path: "src/AuthenticationService.ts",
			pathKind: "file",
		});
		expect(page.generation).toMatch(/^fff-/);
		expect(page.approximate).toBe(false);
	});

	it("uses native grep for text, context, and Unicode-safe columns", async () => {
		await provider.close();
		writeFileSync(join(cwd, "src", "unicode.ts"), "const café = '值'; // TARGET_UNICODE\n");
		provider = new FffSearchProvider(new NodeExecutionEnv({ cwd }));
		const page = await provider.search(request({ kind: "text", query: "authMarker", path: cwd, context: 1 }), {
			workspaceRoot: cwd,
			scopeId: "fff-test",
		});
		expect(page.generation).toMatch(/^fff-/);
		expect(page.hits).toMatchObject([
			{
				kind: "text",
				path: "src/AuthenticationService.ts",
				line: 2,
				column: 14,
				text: "export const authMarker = true;",
				before: [{ line: 1, text: "const before = true;" }],
				after: [{ line: 3, text: "const after = true;" }],
			},
		]);

		const unicode = await provider.search(request({ kind: "text", query: "TARGET_UNICODE", path: cwd }), {
			workspaceRoot: cwd,
			scopeId: "fff-test",
		});
		expect(unicode.hits[0]).toMatchObject({ kind: "text", column: 22 });
	});

	it("falls back when native grep truncates away long-line match coordinates", async () => {
		await provider.close();
		writeFileSync(join(cwd, "src", "long.ts"), `${"x".repeat(16_000)}LONG_LINE_TARGET${"y".repeat(8_000)}\n`);
		provider = new FffSearchProvider(new NodeExecutionEnv({ cwd }));
		const page = await provider.search(request({ kind: "text", query: "LONG_LINE_TARGET", path: cwd }), {
			workspaceRoot: cwd,
			scopeId: "fff-test",
		});
		expect(page.generation).toMatch(/^local-/);
		expect(page.hits[0]).toMatchObject({
			kind: "text",
			path: "src/long.ts",
			line: 1,
			column: 16_001,
			byteOffset: 16_000,
			ranges: [[16_000, 16_016]],
		});
	});

	it("uses native glob search with bounded continuation", async () => {
		const first = await provider.search(request({ kind: "glob", query: "src/**/*.ts", path: cwd, limit: 1 }), {
			workspaceRoot: cwd,
			scopeId: "fff-test",
		});
		expect(first.generation).toMatch(/^fff-/);
		expect(first.nextCursor).toMatch(/^fff:/);
		const second = await provider.search(
			request({
				kind: "glob",
				query: "src/**/*.ts",
				path: cwd,
				limit: 1,
				cursor: first.nextCursor,
				expectedGeneration: first.generation,
			}),
			{ workspaceRoot: cwd, scopeId: "fff-test" },
		);
		expect([...first.hits, ...second.hits].map((hit) => hit.path).sort()).toEqual([
			"src/AuthenticationService.ts",
			"src/other.ts",
		]);
	});

	it("continues native file and text pages with generation-bound cursors", async () => {
		await provider.close();
		for (let index = 0; index < 5; index++) {
			writeFileSync(join(cwd, "src", `auth-service-${index}.ts`), `export const authMarker${index} = true;\n`);
		}
		provider = new FffSearchProvider(new NodeExecutionEnv({ cwd }));
		const firstFiles = await provider.search(
			request({ query: "authservice", path: cwd, limit: 2, ranking: "global" }),
			{ workspaceRoot: cwd, scopeId: "fff-test" },
		);
		expect(firstFiles.hits).toHaveLength(2);
		expect(firstFiles.nextCursor).toMatch(/^fff:/);
		await expect(
			provider.search(
				request({
					query: "authservice",
					path: cwd,
					limit: 2,
					ranking: "global",
					cursor: firstFiles.nextCursor,
					expectedGeneration: "wrong-generation",
				}),
				{ workspaceRoot: cwd, scopeId: "fff-test" },
			),
		).rejects.toMatchObject({ code: "stale_cursor" });
		const secondFiles = await provider.search(
			request({
				query: "authservice",
				path: cwd,
				limit: 2,
				ranking: "global",
				cursor: firstFiles.nextCursor,
				expectedGeneration: firstFiles.generation,
			}),
			{ workspaceRoot: cwd, scopeId: "fff-test" },
		);
		expect(secondFiles.hits).toHaveLength(2);
		expect(new Set([...firstFiles.hits, ...secondFiles.hits].map((hit) => hit.path)).size).toBe(4);

		const firstText = await provider.search(request({ kind: "text", query: "authMarker", path: cwd, limit: 2 }), {
			workspaceRoot: cwd,
			scopeId: "fff-test",
		});
		expect(firstText.nextCursor).toMatch(/^fff:/);
		const secondText = await provider.search(
			request({
				kind: "text",
				query: "authMarker",
				path: cwd,
				limit: 2,
				cursor: firstText.nextCursor,
				expectedGeneration: firstText.generation,
			}),
			{ workspaceRoot: cwd, scopeId: "fff-test" },
		);
		expect(secondText.hits).toHaveLength(2);
	});

	it("rejects an invalid native regex instead of accepting FFF literal fallback", async () => {
		await expect(
			provider.search(request({ kind: "text", query: "(", path: cwd, regex: true }), {
				workspaceRoot: cwd,
				scopeId: "fff-test",
			}),
		).rejects.toMatchObject({ code: "invalid_regex" });
	});

	it("falls back for exact case and fileGlob semantics that FFF cannot represent", async () => {
		const exactCase = await provider.search(
			request({ kind: "text", query: "authMarker", path: cwd, case: "sensitive" }),
			{ workspaceRoot: cwd, scopeId: "fff-test" },
		);
		expect(exactCase.generation).toMatch(/^local-/);
		expect(exactCase.hits).toHaveLength(1);

		const filtered = await provider.search(
			request({ kind: "files", query: "auth", path: cwd, fileGlob: "src/*.ts" }),
			{ workspaceRoot: cwd, scopeId: "fff-test" },
		);
		expect(filtered.generation).toMatch(/^local-/);
		expect(filtered.hits[0]).toMatchObject({ path: "src/AuthenticationService.ts" });
	});
});
