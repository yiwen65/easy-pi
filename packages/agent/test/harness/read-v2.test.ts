import { symlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { ExecutionEnvReadProvider, type ResourceReader } from "../../src/harness/tools/read-provider.ts";
import { createReadV2Tool } from "../../src/harness/tools/read-v2.ts";
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
		expect(env.binaryReads).toBe(0);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("two") });
		expect(result.details.nextOffset).toBe(3);
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
