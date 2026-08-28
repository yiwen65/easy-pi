import { symlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
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

	it("sorts and pages directory entries while preserving symlink kind", async () => {
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		getOrThrow(await env.writeFile("b.txt", "b"));
		getOrThrow(await env.writeFile("a.txt", "a"));
		await symlink("a.txt", `${cwd}/link`);
		const result = await createReadV2Tool().execute("id", { path: ".", limit: 3 }, undefined, undefined, { env });
		expect(result.content[0]).toMatchObject({ text: "a.txt\tfile\nb.txt\tfile\nlink\tsymlink" });
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
		expect(result.details.kind).toBe("image");
	});

	it("rejects unsupported binary files", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("data.bin", Uint8Array.from([0xff, 0xfe, 0xfd])));
		await expect(
			createReadV2Tool().execute("id", { path: "data.bin" }, undefined, undefined, { env }),
		).rejects.toMatchObject({ code: "UNSUPPORTED_BINARY_FILE" });
	});
});
