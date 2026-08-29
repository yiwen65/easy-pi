import { symlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	ExecutionEnvReadProvider,
	type ResourceReader,
	type SymbolReadProvider,
} from "../../src/harness/tools/read-provider.ts";
import { createReadV2Tool } from "../../src/harness/tools/read-v2.ts";
import { fileVersion, ToolStateLedger } from "../../src/harness/tools/tool-state.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

class TrackingEnv extends NodeExecutionEnv {
	binaryReads = 0;
	override async readBinaryFile(path: string, signal?: AbortSignal) {
		this.binaryReads++;
		return super.readBinaryFile(path, signal);
	}
}

describe("v2 read", () => {
	it("makes path and locator input branches schema-exclusive", () => {
		const parameters = createReadV2Tool().parameters as unknown as {
			anyOf: Array<{ required?: string[]; properties: Record<string, unknown> }>;
		};
		const pathBranch = parameters.anyOf.find((branch) => branch.required?.includes("path"));
		const locatorBranch = parameters.anyOf.find((branch) => branch.required?.includes("locatorId"));
		expect(pathBranch?.properties).not.toHaveProperty("locatorId");
		expect(locatorBranch?.properties).not.toHaveProperty("path");
	});

	it("uses bounded text reads and exposes line continuation", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("file.txt", "one\ntwo\nthree\n"));
		const result = await createReadV2Tool().execute(
			"id",
			{ path: "file.txt", offset: 2, limit: 1 },
			undefined,
			undefined,
			{ env },
		);
		expect(env.binaryReads).toBe(1);
		expect(result.content[0]).toMatchObject({
			text: expect.stringMatching(
				/^\[view_id=view_[^ ]+ snapshot_id=snap_[^ ]+ file_hash=sha256:[a-f0-9]{64}\]\n2\ttwo/,
			),
		});
		expect(result.details).toMatchObject({
			range: [2, 2],
			viewId: expect.stringMatching(/^view_/),
			fileHash: expect.stringMatching(/^sha256:/),
			editable: true,
			nextOffset: 3,
		});
	});

	it("reads a locator into a bounded versioned view", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("file.txt", "one\ntwo\ntarget\nfour\nfive\n"));
		const info = getOrThrow(await env.fileInfo("file.txt"));
		const toolState = new ToolStateLedger();
		const locator = toolState.addLocator({
			scopeId: env.cwd,
			snapshotId: "snap_search",
			path: info.path,
			kind: "text",
			startLine: 3,
			endLine: 3,
			startColumn: 1,
			endColumn: 7,
			match: "target",
			fileVersion: fileVersion(info),
		});
		const result = await createReadV2Tool().execute(
			"id",
			{ locatorId: locator.id, beforeLines: 1, afterLines: 1, maxBytes: 1024 },
			undefined,
			undefined,
			{ env, toolState },
		);
		expect(result.details).toMatchObject({
			locatorId: locator.id,
			snapshotId: "snap_search",
			range: [2, 4],
			lines: ["two", "target", "four"],
			hasMoreBefore: true,
		});
		expect((result.content[0] as { text: string }).text).toContain("3\ttarget");
		expect(toolState.getView(result.details.viewId ?? "", env.cwd)).toMatchObject({
			locatorId: locator.id,
			range: [2, 4],
			editable: true,
		});
	});

	it("resolves a JS/TS symbol body into a bounded versioned view", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(
			await env.writeFile(
				"service.ts",
				"const before = true;\nexport function configure() {\n  return 42;\n}\nconst after = true;\n",
			),
		);
		const symbolReadProvider: SymbolReadProvider = {
			id: "symbols",
			languages: ["javascript", "typescript"],
			resolve: async (request) => ({
				path: request.path,
				startLine: 2,
				endLine: 4,
				symbol: "configure",
				nodeKind: "FunctionDeclaration",
				generation: "ts-1",
			}),
			close: async () => {},
		};
		const result = await createReadV2Tool().execute(
			"symbol",
			{ path: "service.ts", mode: "symbol_body", symbol: "configure", maxLines: 10, maxBytes: 1024 },
			undefined,
			undefined,
			{ env, symbolReadProvider },
		);
		expect(result.details).toMatchObject({
			range: [2, 4],
			symbol: "configure",
			nodeKind: "FunctionDeclaration",
			symbolGeneration: "ts-1",
			lines: ["export function configure() {", "  return 42;", "}"],
			editable: true,
		});
		expect((result.content[0] as { text: string }).text).toContain("2\texport function configure()");
	});

	it("uses a locator byte offset to expose a match in an overlong line", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const text = `${"a".repeat(2_000)}TARGET${"b".repeat(2_000)}\n`;
		getOrThrow(await env.writeFile("generated.txt", text));
		const info = getOrThrow(await env.fileInfo("generated.txt"));
		const toolState = new ToolStateLedger();
		const locator = toolState.addLocator({
			scopeId: env.cwd,
			snapshotId: "snap_search",
			path: info.path,
			kind: "text",
			startLine: 1,
			endLine: 1,
			startColumn: 2_001,
			endColumn: 2_007,
			byteOffset: 2_000,
			lineLengthBytes: 4_006,
			match: "TARGET",
			fileVersion: fileVersion(info),
		});
		const result = await createReadV2Tool().execute(
			"id",
			{ locatorId: locator.id, maxBytes: 512 },
			undefined,
			undefined,
			{ env, toolState },
		);
		const output = (result.content[0] as { text: string }).text;
		expect(output).toContain("@byte:2000\tTARGET");
		expect(output).not.toContain("a".repeat(100));
		expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(512);
	});

	it("rejects stale and cross-scope locators", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("file.txt", "target\n"));
		const info = getOrThrow(await env.fileInfo("file.txt"));
		const toolState = new ToolStateLedger();
		const locator = toolState.addLocator({
			scopeId: "scope-a",
			snapshotId: "snap_search",
			path: info.path,
			kind: "text",
			startLine: 1,
			fileVersion: fileVersion(info),
		});
		await expect(
			createReadV2Tool().execute("scope", { locatorId: locator.id }, undefined, undefined, {
				env,
				toolState,
				read: { scopeId: "scope-b" },
			}),
		).rejects.toMatchObject({ code: "STALE_LOCATOR" });

		getOrThrow(await env.writeFile("file.txt", "changed target\n"));
		await expect(
			createReadV2Tool().execute("stale", { locatorId: locator.id }, undefined, undefined, {
				env,
				toolState,
				read: { scopeId: "scope-a" },
			}),
		).rejects.toMatchObject({ code: "STALE_LOCATOR" });
	});

	it("enforces byte and token output budgets with numbered content", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("long.txt", `${"x".repeat(2_000)}\nsecond\n`));
		const result = await createReadV2Tool().execute(
			"id",
			{ path: "long.txt", maxBytes: 512, maxOutputTokens: 128 },
			undefined,
			undefined,
			{ env },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(512);
		expect(text).toContain("1\t");
		expect(result.details).toMatchObject({
			outputBytes: expect.any(Number),
			estimatedOutputTokens: expect.any(Number),
			truncation: { reason: "bytes" },
		});
	});

	it("labels byte-offset fragments without inventing line numbers", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("bytes.txt", "prefix TARGET suffix\n"));
		const result = await createReadV2Tool().execute(
			"id",
			{ path: "bytes.txt", byteOffset: 7, maxBytes: 512 },
			undefined,
			undefined,
			{ env },
		);
		expect((result.content[0] as { text: string }).text).toContain("@byte:7\tTARGET suffix");
		expect(result.details.byteRange?.[0]).toBe(7);
	});

	it("returns stable directory cursors and page-only metadata", async () => {
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		getOrThrow(await env.writeFile("b.txt", "b"));
		getOrThrow(await env.writeFile("a.txt", "a"));
		await symlink("a.txt", `${cwd}/link`);
		const tool = createReadV2Tool();
		const context = { env, read: { scopeId: "session-1" } };
		const first = await tool.execute("first", { path: ".", limit: 2 }, undefined, undefined, context);
		expect(first.details.entries).toMatchObject([
			{ name: "a.txt", kind: "file", size: 1 },
			{ name: "b.txt", kind: "file", size: 1 },
		]);
		expect(first.details.nextCursor).toMatch(/^r2-/);
		getOrThrow(await env.writeFile("aa-new.txt", "new"));
		const second = await tool.execute(
			"second",
			{ path: ".", limit: 2, cursor: first.details.nextCursor },
			undefined,
			undefined,
			context,
		);
		expect(second.details.entries).toMatchObject([{ name: "link", kind: "symlink" }]);
		expect(second.details.stable).toBe(true);
	});

	it("keeps oversized files bounded and marks views without a safe full-file hash as non-editable", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("huge.txt", `first\n${"x".repeat(5 * 1024 * 1024)}\n`));
		env.binaryReads = 0;
		const result = await createReadV2Tool().execute(
			"id",
			{ path: "huge.txt", maxLines: 1, maxBytes: 512 },
			undefined,
			undefined,
			{ env },
		);
		expect(env.binaryReads).toBe(0);
		expect(result.details).toMatchObject({ editable: false, fileHash: undefined, range: [1, 1] });
		expect((result.content[0] as { text: string }).text).toContain("editable=false");
	});

	it("reports out-of-range text offsets without misclassifying the file as binary", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("short.txt", "one\ntwo\n"));
		await expect(
			createReadV2Tool().execute("id", { path: "short.txt", offset: 99 }, undefined, undefined, { env }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(env.binaryReads).toBe(0);
	});

	it("returns capability errors without loading oversized files on old backends", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("large.txt", "x".repeat(60 * 1024)));
		Object.defineProperty(env, "readTextRange", { value: undefined });
		await expect(
			createReadV2Tool().execute("id", { path: "large.txt" }, undefined, undefined, { env }),
		).rejects.toMatchObject({ code: "RANGE_READ_UNSUPPORTED" });
		expect(env.binaryReads).toBe(0);
	});

	it("rejects eager compatibility listing above its declared directory limit", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		for (const name of ["a", "b", "c"]) getOrThrow(await env.writeFile(name, name));
		const readProvider = new ExecutionEnvReadProvider(env, { maxDirectoryEntries: 2 });
		await expect(
			createReadV2Tool().execute("id", { path: "." }, undefined, undefined, { env, readProvider }),
		).rejects.toMatchObject({ code: "DIRECTORY_TOO_LARGE" });
	});

	it("reads configured non-filesystem resources before workspace path resolution", async () => {
		const reader: ResourceReader = {
			id: "docs",
			canRead: (resource) => resource.startsWith("docs://"),
			read: async (resource) => ({
				content: [{ type: "text", text: `resource ${resource}` }],
				mediaType: "text/plain",
				size: 12,
			}),
			close: async () => {},
		};
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const result = await createReadV2Tool().execute("id", { path: "docs://guide" }, undefined, undefined, {
			env,
			resourceReaders: [reader],
		});
		expect(result.content[0]).toMatchObject({ text: "resource docs://guide" });
		expect(result.details).toMatchObject({ kind: "resource", mediaType: "text/plain", size: 12 });
	});

	it("returns a supported image attachment", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const png = Uint8Array.from(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		getOrThrow(await env.writeFile("image.bin", png));
		const result = await createReadV2Tool().execute("id", { path: "image.bin" }, undefined, undefined, { env });
		expect(result.content.some((part) => part.type === "image")).toBe(true);
		expect(result.details).toMatchObject({ kind: "image", mediaType: "image/png", size: png.byteLength });
	});

	it("rejects unsupported binary files", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("data.bin", Uint8Array.from([0xff, 0xfe, 0xfd])));
		await expect(
			createReadV2Tool().execute("id", { path: "data.bin" }, undefined, undefined, { env }),
		).rejects.toMatchObject({ code: "UNSUPPORTED_BINARY_FILE" });
	});
});
