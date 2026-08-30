import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRequest } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypeScriptCodeIndexProvider } from "../src/core/tools/typescript-code-index-provider.ts";

function request(root: string, mode: SearchRequest["mode"], query: string): SearchRequest {
	return {
		query,
		kind: "text",
		path: root,
		case: "sensitive",
		regex: false,
		mode,
		context: 0,
		limit: 20,
		ranking: "fast",
		honorIgnore: true,
		includeHidden: false,
		followSymlinks: false,
	};
}

describe("TypeScriptCodeIndexProvider", () => {
	let cwd: string;
	let provider: TypeScriptCodeIndexProvider;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-ts-code-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(
			join(cwd, "src", "service.ts"),
			`${[
				"export function helper(value: number) { return value + 1; }",
				"export class Alpha {",
				"  timeout = 10;",
				"  configure() {",
				"    this.timeout = helper(this.timeout);",
				"    return this.timeout;",
				"  }",
				"}",
				"export class Beta { configure() { return 0; } }",
			].join("\n")}\n`,
		);
		writeFileSync(join(cwd, ".gitignore"), "generated/\n");
		mkdirSync(join(cwd, "generated"), { recursive: true });
		writeFileSync(join(cwd, "generated", "ignored.ts"), "export function helper() { return 99; }\n");
		provider = new TypeScriptCodeIndexProvider();
	});

	afterEach(async () => {
		await provider.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("separates definitions, calls, assignments, and references with AST ranges", async () => {
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		const definition = await provider.search(request(cwd, "symbol_definition", "Alpha.configure"), context);
		expect(definition).toMatchObject({ complete: true, approximate: false, partial: false, matchedCount: 1 });
		expect(definition.hits[0]).toMatchObject({
			kind: "text",
			path: "src/service.ts",
			line: 4,
			endLine: 7,
			matchKind: "definition",
			enclosingSymbol: "Alpha.configure",
			nodeKind: "MethodDeclaration",
			nodeId: expect.stringMatching(/^tsn_/),
		});

		const calls = await provider.search(request(cwd, "call", "helper"), context);
		expect(calls.hits).toHaveLength(1);
		expect(calls.hits[0]).toMatchObject({ line: 5, matchKind: "call", enclosingSymbol: "Alpha.configure" });

		const assignments = await provider.search(request(cwd, "assignment", "timeout"), context);
		expect(assignments.hits.map((hit) => (hit.kind === "text" ? hit.line : 0))).toEqual([3, 5]);
		expect(assignments.hits.every((hit) => hit.kind === "text" && hit.matchKind === "assignment")).toBe(true);

		const references = await provider.search(request(cwd, "symbol_reference", "Alpha.timeout"), context);
		expect(references.hits.map((hit) => (hit.kind === "text" ? hit.line : 0))).toEqual([5, 5, 6]);
	});

	it("reuses one candidate catalog until the indexed source changes", async () => {
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		await provider.search(request(cwd, "symbol_definition", "Alpha.configure"), context);
		await provider.search(request(cwd, "call", "helper"), context);
		expect(provider.getDiagnostics()).toMatchObject({ candidateCatalogBuilds: 1 });

		writeFileSync(join(cwd, "src", "service.ts"), "export function changed() { return 1; }\n");
		await provider.search(request(cwd, "symbol_definition", "changed"), context);
		expect(provider.getDiagnostics()).toMatchObject({ candidateCatalogBuilds: 2 });
	});

	it("resolves aliases across files and verifies implementation, string, and comment modes", async () => {
		writeFileSync(
			join(cwd, "src", "dep.ts"),
			"export function reconcile(value: string): string;\nexport function reconcile(value: string) { return value; }\n",
		);
		writeFileSync(
			join(cwd, "src", "consumer.ts"),
			'import { reconcile as runReconcile } from "./dep.js";\nconst marker = "billing pipeline"; // settlement workflow\nexport const output = runReconcile(marker);\n',
		);
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		const calls = await provider.search(request(cwd, "call", "reconcile"), context);
		expect(calls.hits).toHaveLength(1);
		expect(calls.hits[0]).toMatchObject({ path: "src/consumer.ts", line: 3, matchKind: "call" });

		const references = await provider.search(request(cwd, "symbol_reference", "reconcile"), context);
		expect(references.hits.some((hit) => hit.path === "src/consumer.ts")).toBe(true);
		const implementation = await provider.search(request(cwd, "implementation", "reconcile"), context);
		expect(implementation.hits).toHaveLength(1);
		expect(implementation.hits[0]).toMatchObject({ path: "src/dep.ts", line: 2, matchKind: "implementation" });
		const literal = await provider.search(request(cwd, "string_literal", "billing pipeline"), context);
		expect(literal.hits[0]).toMatchObject({ path: "src/consumer.ts", line: 2, matchKind: "string_literal" });
		const comment = await provider.search(request(cwd, "comment", "settlement workflow"), context);
		expect(comment.hits[0]).toMatchObject({
			path: "src/consumer.ts",
			line: 2,
			matchKind: "comment",
			nodeKind: "CommentTrivia",
		});
	});

	it("returns only checker-related implementations for qualified interface methods", async () => {
		writeFileSync(
			join(cwd, "src", "implementations.ts"),
			[
				"export interface Runner { execute(): number; }",
				"export class RealRunner implements Runner { execute() { return 1; } }",
				"export class Unrelated { execute() { return 2; } }",
			].join("\n"),
		);
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		const implementation = await provider.search(request(cwd, "implementation", "Runner.execute"), context);
		expect(implementation.hits).toHaveLength(1);
		expect(implementation.hits[0]).toMatchObject({
			path: "src/implementations.ts",
			line: 2,
			matchKind: "implementation",
			enclosingSymbol: "RealRunner.execute",
		});
	});

	it("returns concrete implementations of abstract methods without same-name false positives", async () => {
		writeFileSync(
			join(cwd, "src", "abstract-implementations.ts"),
			[
				"export abstract class BaseRunner { abstract execute(): number; }",
				"export class ConcreteRunner extends BaseRunner { execute() { return 1; } }",
				"export class UnrelatedRunner { execute() { return 2; } }",
			].join("\n"),
		);
		const implementation = await provider.search(request(cwd, "implementation", "BaseRunner.execute"), {
			workspaceRoot: cwd,
			scopeId: "ts-index",
		});
		expect(implementation.hits).toHaveLength(1);
		expect(implementation.hits[0]).toMatchObject({
			path: "src/abstract-implementations.ts",
			line: 2,
			matchKind: "implementation",
			enclosingSymbol: "ConcreteRunner.execute",
		});
	});

	it("resolves qualified symbols and opaque AST node IDs for bounded Read", async () => {
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		const definition = await provider.search(request(cwd, "symbol_definition", "Alpha.configure"), context);
		const hit = definition.hits[0];
		if (!hit || hit.kind !== "text" || !hit.nodeId) throw new Error("missing structured hit");

		await expect(
			provider.resolve({ path: join(cwd, "src", "service.ts"), mode: "symbol_body", symbol: "configure" }),
		).rejects.toMatchObject({ code: "invalid" });
		expect(
			await provider.resolve({
				path: join(cwd, "src", "service.ts"),
				mode: "symbol_body",
				symbol: "Alpha.configure",
			}),
		).toMatchObject({ startLine: 4, endLine: 7, symbol: "Alpha.configure", nodeKind: "MethodDeclaration" });
		expect(
			await provider.resolve({ path: join(cwd, "src", "service.ts"), mode: "ast_node", nodeId: hit.nodeId }),
		).toMatchObject({ startLine: 4, endLine: 7, nodeKind: "MethodDeclaration" });
	});

	it("materializes node handles only when a paged hit is returned", async () => {
		const declarations = Array.from(
			{ length: 1_100 },
			(_, index) => `export function repeated(): number { return ${index}; }`,
		).join("\n");
		const targetPath = join(cwd, "src", "many-declarations.ts");
		writeFileSync(targetPath, declarations);
		const first = await provider.search(
			{ ...request(cwd, "symbol_definition", "repeated"), limit: 2_000 },
			{ workspaceRoot: cwd, scopeId: "ts-index" },
		);
		expect(first.hits).toHaveLength(1_000);
		expect(first.nextCursor).toBeTypeOf("string");
		const hit = first.hits[0];
		if (!hit || hit.kind !== "text" || !hit.nodeId) throw new Error("missing structured node handle");
		expect(await provider.resolve({ path: targetPath, mode: "ast_node", nodeId: hit.nodeId })).toMatchObject({
			startLine: 1,
			nodeKind: "FunctionDeclaration",
		});
	});

	it("applies deterministic production and preferred-path ranking priors", async () => {
		mkdirSync(join(cwd, "tests"), { recursive: true });
		writeFileSync(join(cwd, "src", "preferred.ts"), "export function locateTarget() { return 1; }\n");
		writeFileSync(join(cwd, "tests", "other.ts"), "export function locateTarget() { return 2; }\n");
		const ranked = await provider.search(
			{
				...request(cwd, "symbol_definition", "locateTarget"),
				ranking: "task",
				preferredPaths: ["src/**"],
			},
			{ workspaceRoot: cwd, scopeId: "ts-index" },
		);
		expect(ranked.hits.map((hit) => hit.path)).toEqual(["src/preferred.ts", "tests/other.ts"]);
		expect(ranked.hits[0]).toMatchObject({
			fileClass: "production",
			rankReasons: expect.arrayContaining(["production_source", "preferred_path"]),
		});
	});

	it("honors ignore/include/exclude scope and discloses scan quotas", async () => {
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		const ignored = await provider.search(request(cwd, "symbol_definition", "helper"), context);
		expect(ignored.matchedCount).toBe(1);
		expect(ignored.hits).toHaveLength(1);

		const excluded = await provider.search(
			{ ...request(cwd, "symbol_definition", "helper"), exclude: ["src/**"] },
			context,
		);
		expect(excluded).toMatchObject({ hits: [], complete: true, partial: false, matchedCount: 0 });

		await provider.close();
		provider = new TypeScriptCodeIndexProvider({ maxFiles: 1, maxSourceBytes: 1024 * 1024 });
		writeFileSync(join(cwd, "src", "second.ts"), "export const second = 2;\n");
		const limited = await provider.search(request(cwd, "symbol_definition", "helper"), context);
		expect(limited).toMatchObject({ complete: false, partial: true });
		expect(limited.skipped).toEqual(
			expect.arrayContaining([expect.objectContaining({ reason: "INDEX_FILE_LIMIT" })]),
		);
	});

	it("distinguishes byte-limit coverage and invalidates cached coverage metadata", async () => {
		await provider.close();
		provider = new TypeScriptCodeIndexProvider({ maxFiles: 100, maxSourceBytes: 20 });
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		const first = await provider.search(request(cwd, "symbol_definition", "helper"), context);
		expect(first.skipped).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "src/service.ts", reason: "INDEX_BYTE_LIMIT" })]),
		);
		expect(first.skipped).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ reason: "INDEX_FILE_LIMIT" })]),
		);
		expect(provider.getDiagnostics()).toMatchObject({ candidateCatalogBuilds: 1 });

		writeFileSync(join(cwd, "src", "another-large.ts"), "export const anotherLargeValue = 123456789;\n");
		const second = await provider.search(request(cwd, "symbol_definition", "helper"), context);
		expect(second.skipped).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "src/another-large.ts", reason: "INDEX_BYTE_LIMIT" }),
				expect.objectContaining({ path: "src/service.ts", reason: "INDEX_BYTE_LIMIT" }),
			]),
		);
		expect(provider.getDiagnostics()).toMatchObject({ candidateCatalogBuilds: 2 });
	});

	it("fails closed for unsupported languages and honors cancellation", async () => {
		writeFileSync(join(cwd, "module.py"), "def configure():\n    return 1\n");
		await expect(
			provider.search(request(join(cwd, "module.py"), "symbol_definition", "configure"), {
				workspaceRoot: cwd,
				scopeId: "ts-index",
			}),
		).rejects.toMatchObject({ code: "unsupported" });
		const controller = new AbortController();
		controller.abort();
		await expect(
			provider.search(
				request(cwd, "symbol_definition", "configure"),
				{
					workspaceRoot: cwd,
					scopeId: "ts-index",
				},
				controller.signal,
			),
		).rejects.toMatchObject({ code: "unavailable" });
	});

	it("binds continuation cursors to the originating structured request", async () => {
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		const firstRequest = { ...request(cwd, "assignment", "timeout"), limit: 1 };
		const first = await provider.search(firstRequest, context);
		expect(first.nextCursor).toBeTypeOf("string");
		await expect(
			provider.search(
				{
					...firstRequest,
					query: "different",
					cursor: first.nextCursor,
					expectedGeneration: first.generation,
				},
				context,
			),
		).rejects.toMatchObject({ code: "stale_cursor" });
	});

	it("invalidates continuation cursors after the indexed source changes", async () => {
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		const first = await provider.search({ ...request(cwd, "assignment", "timeout"), limit: 1 }, context);
		expect(first.nextCursor).toBeTypeOf("string");
		writeFileSync(
			join(cwd, "src", "service.ts"),
			"export class Alpha { timeout = 11; configure() { this.timeout = 12; return this.timeout; } }\n",
		);
		await expect(
			provider.search(
				{
					...request(cwd, "assignment", "timeout"),
					limit: 1,
					cursor: first.nextCursor,
					expectedGeneration: first.generation,
				},
				context,
			),
		).rejects.toMatchObject({ code: "stale_cursor" });
	});

	it("invalidates node handles after the source file changes", async () => {
		const context = { workspaceRoot: cwd, scopeId: "ts-index" };
		const definition = await provider.search(request(cwd, "symbol_definition", "Alpha.configure"), context);
		const hit = definition.hits[0];
		if (!hit || hit.kind !== "text" || !hit.nodeId) throw new Error("missing structured hit");
		writeFileSync(join(cwd, "src", "service.ts"), "export class Alpha { configure() { return 2; } }\n");
		await expect(
			provider.resolve({ path: join(cwd, "src", "service.ts"), mode: "ast_node", nodeId: hit.nodeId }),
		).rejects.toMatchObject({ code: "stale_cursor" });
	});
});
