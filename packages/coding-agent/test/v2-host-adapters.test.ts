import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EditOperations } from "../src/core/tools/edit.ts";
import type { FindOperations } from "../src/core/tools/find.ts";
import { MemoryExecutionEnv } from "../src/core/tools/memory-execution-env.ts";
import {
	NativeEditOperationsMutationBackend,
	NativeFindOperationsSearchProvider,
	NativeReadOperationsProvider,
} from "../src/core/tools/native-operations-v2-adapters.ts";
import type { ReadOperations } from "../src/core/tools/read.ts";
import { SshExecutionEnv } from "../src/core/tools/ssh-execution-env.ts";
import { createV2ToolRuntime, V2_TOOL_NAMES } from "../src/core/tools/tool-profile.ts";

function executionContext() {
	return {} as Parameters<ReturnType<typeof createV2ToolRuntime>["definitions"]["read"]["execute"]>[4];
}

describe("v2 host adapters", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-v2-host-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("keeps all four model schemas identical for local, Memory, and SSH execution environments", async () => {
		const memory = new MemoryExecutionEnv({ files: { "sample.txt": "hello\n" } });
		const sshDelegate = new MemoryExecutionEnv({ cwd: "/remote", files: { "sample.txt": "hello\n" } });
		const ssh = new SshExecutionEnv({ cwd: "/remote", operations: sshDelegate });
		const runtimes = [
			createV2ToolRuntime(cwd),
			createV2ToolRuntime(memory.cwd, { executionEnv: memory }),
			createV2ToolRuntime(ssh.cwd, { executionEnv: ssh }),
		];
		try {
			for (const name of V2_TOOL_NAMES) {
				const schemas = runtimes.map((runtime) => runtime.definitions[name].parameters);
				expect(schemas[1]).toEqual(schemas[0]);
				expect(schemas[2]).toEqual(schemas[0]);
			}
			const remoteRead = await runtimes[2].definitions.read.execute(
				"ssh-read",
				{ path: "sample.txt" },
				undefined,
				undefined,
				executionContext(),
			);
			expect(remoteRead.content[0]).toMatchObject({ text: expect.stringContaining("1\thello") });
		} finally {
			await Promise.all(runtimes.map((runtime) => runtime.close()));
			await memory.cleanup();
			await ssh.cleanup();
		}
	});

	it("runs structured search, read, and edit against the Memory reference host", async () => {
		const environments: MemoryExecutionEnv[] = [];
		const runtime = createV2ToolRuntime("/workspace", {
			executionEnv: () => {
				const env = new MemoryExecutionEnv({ files: { "src/sample.txt": "first\nsecond\n" } });
				environments.push(env);
				return env;
			},
		});
		try {
			const search = await runtime.definitions.search.execute(
				"search",
				{ query: "sample", kind: "files" },
				undefined,
				undefined,
				executionContext(),
			);
			expect(search.details).toMatchObject({ hits: [{ kind: "file", path: "src/sample.txt" }] });

			const read = await runtime.definitions.read.execute(
				"read",
				{ path: "src/sample.txt" },
				undefined,
				undefined,
				executionContext(),
			);
			expect(read.content[0]).toMatchObject({ text: expect.stringContaining("1\tfirst\n2\tsecond") });

			await runtime.definitions.edit.execute(
				"edit",
				{
					operations: [
						{
							kind: "update",
							path: "src/sample.txt",
							oldText: "second",
							newText: "changed",
							viewId: read.details.viewId,
							expectedFileHash: read.details.fileHash,
							range: { startLine: 2, endLine: 2 },
						},
					],
				},
				undefined,
				undefined,
				executionContext(),
			);
			expect(await environments[0].readTextFile("src/sample.txt")).toMatchObject({
				ok: true,
				value: "first\nchanged\n",
			});
		} finally {
			await runtime.close();
		}
		expect(environments[0].isCleanedUp).toBe(true);
	});

	it("declares native Operations degradation instead of claiming unsupported search or range features", async () => {
		const findOperations: FindOperations = {
			exists: () => true,
			glob: () => ["src/a.ts", "src/b.ts"],
		};
		const search = new NativeFindOperationsSearchProvider(findOperations);
		expect(search.capabilities).toMatchObject({
			textLiteral: false,
			fuzzyFiles: false,
			glob: true,
			globalRanking: false,
		});
		await expect(
			search.search(
				{
					query: "value",
					kind: "text",
					path: "/workspace",
					case: "smart",
					regex: false,
					context: 0,
					limit: 20,
					ranking: "fast",
				},
				{ workspaceRoot: "/workspace", scopeId: "test" },
			),
		).rejects.toMatchObject({ code: "unsupported" });

		const files = new Map([["/workspace/a.txt", Buffer.from("small\n")]]);
		const readOperations: ReadOperations = {
			access: async (path) => {
				if (!files.has(path)) throw new Error("missing");
			},
			readFile: async (path) => {
				const value = files.get(path);
				if (!value) throw new Error("missing");
				return value;
			},
		};
		const read = new NativeReadOperationsProvider({ read: readOperations });
		expect(read.capabilities).toEqual({
			textRange: false,
			directoryPage: false,
			stableDirectoryCursor: false,
			binary: true,
		});
		await expect(read.readText("/workspace/a.txt", { startLine: 2 })).rejects.toMatchObject({
			code: "range_unsupported",
		});
	});

	it("adapts legacy EditOperations as an update-only backend with stale checks", async () => {
		const files = new Map([["/workspace/a.txt", Buffer.from("before")]]);
		const operations: EditOperations = {
			access: async (path) => {
				if (!files.has(path)) throw new Error("missing");
			},
			readFile: async (path) => {
				const value = files.get(path);
				if (!value) throw new Error("missing");
				return value;
			},
			writeFile: async (path, content) => {
				files.set(path, Buffer.from(content));
			},
		};
		const backend = new NativeEditOperationsMutationBackend(operations);
		const hash = await globalThis.crypto.subtle.digest("SHA-256", Buffer.from("before"));
		const contentHash = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const limits = { maxOperations: 2, maxFiles: 2, maxFileBytes: 100, maxTotalBytes: 100 };
		await backend.commit({
			observations: [{ path: "/workspace/a.txt", exists: true, size: 6, contentHash }],
			operations: [{ kind: "update", path: "/workspace/a.txt", content: "after" }],
			limits,
		});
		expect(files.get("/workspace/a.txt")?.toString()).toBe("after");
		await expect(
			backend.commit({
				observations: [{ path: "/workspace/new.txt", exists: false, size: 0 }],
				operations: [{ kind: "create", path: "/workspace/new.txt", content: "new" }],
				limits,
			}),
		).rejects.toMatchObject({ code: "EDIT_ROLLED_BACK" });
	});
});
