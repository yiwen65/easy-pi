import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { V2ToolError } from "../../src/harness/tools/v2-errors.ts";
import { resolveWorkspacePath, type WorkspacePolicy } from "../../src/harness/tools/workspace-policy.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

function restrictivePolicy(root: string, followSymlinks = false): WorkspacePolicy {
	return {
		roots: [root],
		allowOutsideWorkspaceRead: false,
		allowOutsideWorkspaceWrite: false,
		followSymlinks,
	};
}

describe("v2 foundations", () => {
	it("keeps legacy readTextLines behavior", async () => {
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		getOrThrow(await env.writeFile("lines.txt", "one\ntwo\nthree\n"));

		expect(getOrThrow(await env.readTextLines("lines.txt", { maxLines: 2 }))).toEqual(["one", "two"]);
	});

	it("reads a bounded line range without returning skipped lines", async () => {
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		getOrThrow(await env.writeFile("lines.txt", "one\ntwo\nthree\nfour\nfive\n"));

		const result = getOrThrow(await env.readTextRange("lines.txt", { startLine: 3, maxLines: 2, maxBytes: 1024 }));

		expect(result).toMatchObject({
			lines: ["three", "four"],
			startLine: 3,
			endLine: 4,
			eof: false,
			partialLine: false,
			nextLine: 5,
		});
	});

	it("continues a byte-truncated UTF-8 line without corrupting code points", async () => {
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		getOrThrow(await env.writeFile("unicode.txt", "🙂abc\nnext\n"));

		const first = getOrThrow(await env.readTextRange("unicode.txt", { maxLines: 10, maxBytes: 5 }));
		expect(first.lines).toEqual(["🙂a"]);
		expect(first).toMatchObject({ partialLine: true, nextByte: 5, eof: false });

		const second = getOrThrow(
			await env.readTextRange("unicode.txt", { startByte: first.nextByte, maxLines: 1, maxBytes: 1024 }),
		);
		expect(second.lines).toEqual(["bc"]);
		expect(second.nextLine).toBe(2);
	});

	it("rejects invalid UTF-8 in a bounded text range", async () => {
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		getOrThrow(await env.writeFile("binary.dat", Uint8Array.from([0xff, 0xfe, 0xfd])));

		const result = await env.readTextRange("binary.dat", { maxBytes: 1024 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid");
	});

	it("allows compatibility paths and rejects outside paths under an explicit policy", async () => {
		const root = createTempDir();
		const outside = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await writeFile(join(outside, "outside.txt"), "outside");

		await expect(resolveWorkspacePath(env, join(outside, "outside.txt"), "read")).resolves.toMatchObject({
			absolutePath: join(outside, "outside.txt"),
		});
		await expect(
			resolveWorkspacePath(env, join(outside, "outside.txt"), "read", restrictivePolicy(root, true)),
		).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
	});

	it("reapplies roots to followed symlinks and rejects symlinks when disabled", async () => {
		const root = createTempDir();
		const outside = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await mkdir(join(root, "inside"));
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(root, "inside", "link"), "dir");
		const addressed = join(root, "inside", "link", "secret.txt");

		await expect(resolveWorkspacePath(env, addressed, "read", restrictivePolicy(root))).rejects.toMatchObject({
			code: "SYMLINK_ESCAPE",
		});
		await expect(resolveWorkspacePath(env, addressed, "read", restrictivePolicy(root, true))).rejects.toMatchObject({
			code: "OUTSIDE_WORKSPACE",
		});
	});

	it("preserves stable error code, details, and actionable content", () => {
		const error = new V2ToolError("INVALID_INPUT", "Choose a non-empty query.", { field: "query" });
		expect(error.code).toBe("INVALID_INPUT");
		expect(error.details).toEqual({ field: "query" });
		expect(error.message).toContain("INVALID_INPUT\n\nChoose a non-empty query.");
	});
});
