import { chmod, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createEditV2Tool } from "../../src/harness/tools/edit-v2.ts";
import {
	type EditPlan,
	ExecutionEnvMutationBackend,
	type MutationBackend,
} from "../../src/harness/tools/mutation-core.ts";
import { err, FileError, getOrThrow, type Result } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

class TrackingEnv extends NodeExecutionEnv {
	mutations = 0;
	failContent?: string;
	override async writeFile(
		path: string,
		content: string | Uint8Array,
		signal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		this.mutations++;
		if (content === this.failContent) return err(new FileError("unknown", "injected write failure", path));
		return super.writeFile(path, content, signal);
	}
	override async createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }) {
		this.mutations++;
		return super.createDir(path, options);
	}
	override async renameFile(source: string, destination: string, signal?: AbortSignal) {
		this.mutations++;
		return super.renameFile(source, destination, signal);
	}
	override async remove(path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }) {
		this.mutations++;
		return super.remove(path, options);
	}
	writeExternal(path: string, content: string | Uint8Array, signal?: AbortSignal) {
		return super.writeFile(path, content, signal);
	}
}

class StaleBeforeCommitBackend implements MutationBackend {
	readonly id = "stale-before-commit";
	readonly capabilities;
	private readonly env: TrackingEnv;
	private readonly inner: ExecutionEnvMutationBackend;
	private readonly path: string;

	constructor(env: TrackingEnv, path: string) {
		this.env = env;
		this.path = path;
		this.inner = new ExecutionEnvMutationBackend(env);
		this.capabilities = this.inner.capabilities;
	}

	async commit(plan: EditPlan, signal?: AbortSignal) {
		getOrThrow(await this.env.writeExternal(this.path, "external change", signal));
		this.env.mutations = 0;
		return this.inner.commit(plan, signal);
	}

	async close(): Promise<void> {}
}

describe("v2 edit", () => {
	it("applies ordered create, update, move, update, and delete operations", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		env.mutations = 0;
		const result = await createEditV2Tool().execute(
			"id",
			{
				operations: [
					{ kind: "create", path: "a.txt", content: "one" },
					{ kind: "update", path: "a.txt", oldText: "one", newText: "two" },
					{ kind: "move", path: "a.txt", to: "b.txt" },
					{ kind: "update", path: "b.txt", oldText: "two", newText: "three" },
				],
			},
			undefined,
			undefined,
			{ env },
		);
		expect(getOrThrow(await env.readTextFile("b.txt"))).toBe("three");
		expect(getOrThrow(await env.exists("a.txt"))).toBe(false);
		expect(result.details.operations).toHaveLength(4);
	});

	it("creates missing destination parents for create and move", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("source.txt", "source"));
		env.mutations = 0;
		await createEditV2Tool().execute(
			"id",
			{
				operations: [
					{ kind: "create", path: "created/nested/file.txt", content: "created" },
					{ kind: "move", path: "source.txt", to: "moved/nested/source.txt" },
				],
			},
			undefined,
			undefined,
			{ env },
		);
		expect(getOrThrow(await env.readTextFile("created/nested/file.txt"))).toBe("created");
		expect(getOrThrow(await env.readTextFile("moved/nested/source.txt"))).toBe("source");
	});

	it("performs zero mutations when prevalidation fails", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "same same"));
		env.mutations = 0;
		await expect(
			createEditV2Tool().execute(
				"id",
				{
					operations: [
						{ kind: "create", path: "new/parent/file.txt", content: "new" },
						{ kind: "update", path: "a.txt", oldText: "same", newText: "x" },
					],
				},
				undefined,
				undefined,
				{ env },
			),
		).rejects.toMatchObject({ code: "EDIT_CONTEXT_AMBIGUOUS" });
		expect(env.mutations).toBe(0);
	});

	it("never overwrites an existing create destination", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "old"));
		env.mutations = 0;
		await expect(
			createEditV2Tool().execute(
				"id",
				{ operations: [{ kind: "create", path: "a.txt", content: "new" }] },
				undefined,
				undefined,
				{ env },
			),
		).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
		expect(env.mutations).toBe(0);
	});

	it("rejects stale observations before performing any planned mutation", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "original"));
		env.mutations = 0;
		const backend = new StaleBeforeCommitBackend(env, "a.txt");
		await expect(
			createEditV2Tool({ backend }).execute(
				"id",
				{ operations: [{ kind: "update", path: "a.txt", oldText: "original", newText: "planned" }] },
				undefined,
				undefined,
				{ env },
			),
		).rejects.toMatchObject({ code: "STALE_FILE" });
		expect(env.mutations).toBe(0);
		expect(getOrThrow(await env.readTextFile("a.txt"))).toBe("external change");
	});

	it("enforces plan limits before writes", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		env.mutations = 0;
		await expect(
			createEditV2Tool({ limits: { maxOperations: 1 } }).execute(
				"id",
				{
					operations: [
						{ kind: "create", path: "a.txt", content: "a" },
						{ kind: "create", path: "b.txt", content: "b" },
					],
				},
				undefined,
				undefined,
				{ env },
			),
		).rejects.toMatchObject({ code: "EDIT_PLAN_TOO_LARGE" });
		expect(env.mutations).toBe(0);
	});

	it("preserves UTF-8 BOM, CRLF, and executable mode for updates", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("script.txt", "\uFEFFone\r\ntwo\r\n"));
		await chmod(`${env.cwd}/script.txt`, 0o755);
		env.mutations = 0;
		await createEditV2Tool().execute(
			"id",
			{ operations: [{ kind: "update", path: "script.txt", oldText: "one\ntwo", newText: "ONE\nTWO" }] },
			undefined,
			undefined,
			{ env },
		);
		expect(getOrThrow(await env.readTextFile("script.txt"))).toBe("\uFEFFONE\r\nTWO\r\n");
		expect((await stat(`${env.cwd}/script.txt`)).mode & 0o777).toBe(0o755);
	});

	it("normalizes replacement and versioned patch dialects into canonical operations", async () => {
		const replacementEnv = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await replacementEnv.writeFile("a.txt", "alpha beta gamma"));
		const replacement = await createEditV2Tool({ dialect: "replacement" }).execute(
			"replacement",
			{
				path: "a.txt",
				edits: [
					{ oldText: "alpha", newText: "A" },
					{ oldText: "gamma", newText: "G" },
				],
			},
			undefined,
			undefined,
			{ env: replacementEnv },
		);
		expect(getOrThrow(await replacementEnv.readTextFile("a.txt"))).toBe("A beta G");
		expect(replacement.details).toMatchObject({ dialect: "replacement", operations: [{ kind: "update" }] });

		const patchEnv = new TrackingEnv({ cwd: createTempDir() });
		const path = "line\nbreak -> file.txt";
		const content = "content with\n*** End Pi Edit Patch\ninside";
		const patch = [
			"*** Pi Edit Patch v1",
			JSON.stringify({ kind: "create", path, content }),
			"*** End Pi Edit Patch",
		].join("\n");
		const patched = await createEditV2Tool({ dialect: "patch" }).execute("patch", { patch }, undefined, undefined, {
			env: patchEnv,
		});
		expect(getOrThrow(await patchEnv.readTextFile(path))).toBe(content);
		expect(patched.details).toMatchObject({ dialect: "patch", operations: [{ kind: "create" }] });
	});

	it("produces the same update through operations, replacement, and patch dialects", async () => {
		const cases = [
			{
				dialect: "operations" as const,
				input: { operations: [{ kind: "update" as const, path: "a.txt", oldText: "two", newText: "TWO" }] },
			},
			{
				dialect: "replacement" as const,
				input: { path: "a.txt", edits: [{ oldText: "two", newText: "TWO" }] },
			},
			{
				dialect: "patch" as const,
				input: {
					patch: [
						"*** Pi Edit Patch v1",
						JSON.stringify({ kind: "update", path: "a.txt", oldText: "two", newText: "TWO" }),
						"*** End Pi Edit Patch",
					].join("\n"),
				},
			},
		];
		for (const candidate of cases) {
			const env = new TrackingEnv({ cwd: createTempDir() });
			getOrThrow(await env.writeFile("a.txt", "one\ntwo\nthree\n"));
			await createEditV2Tool({ dialect: candidate.dialect }).execute(
				candidate.dialect,
				candidate.input,
				undefined,
				undefined,
				{ env },
			);
			expect(getOrThrow(await env.readTextFile("a.txt"))).toBe("one\nTWO\nthree\n");
		}
	});

	it("rejects malformed patches and non-UTF-8 files before mutation", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("binary.bin", Uint8Array.from([0xff, 0xfe, 0xfd])));
		env.mutations = 0;
		await expect(
			createEditV2Tool({ dialect: "patch" }).execute(
				"patch",
				{ patch: "*** Pi Edit Patch v2\n*** End Pi Edit Patch" },
				undefined,
				undefined,
				{ env },
			),
		).rejects.toMatchObject({ code: "PATCH_PARSE_ERROR" });
		getOrThrow(await env.writeExternal("text.txt", "current"));
		const missingContextPatch = [
			"*** Pi Edit Patch v1",
			JSON.stringify({ kind: "update", path: "text.txt", oldText: "missing", newText: "new" }),
			"*** End Pi Edit Patch",
		].join("\n");
		await expect(
			createEditV2Tool({ dialect: "patch" }).execute(
				"patch-context",
				{ patch: missingContextPatch },
				undefined,
				undefined,
				{ env },
			),
		).rejects.toMatchObject({ code: "PATCH_CONTEXT_NOT_FOUND" });
		getOrThrow(await env.writeExternal("mixed.txt", "one\r\ntwo\n"));
		await expect(
			createEditV2Tool().execute(
				"mixed",
				{ operations: [{ kind: "update", path: "mixed.txt", oldText: "one", newText: "ONE" }] },
				undefined,
				undefined,
				{ env },
			),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			createEditV2Tool().execute(
				"binary",
				{ operations: [{ kind: "update", path: "binary.bin", oldText: "x", newText: "y" }] },
				undefined,
				undefined,
				{ env },
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_BINARY_FILE" });
		expect(env.mutations).toBe(0);
	});

	it("reports the failed operation and remaining work after a commit failure", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		env.failContent = "fail";
		try {
			await createEditV2Tool().execute(
				"id",
				{
					operations: [
						{ kind: "create", path: "ok.txt", content: "ok" },
						{ kind: "create", path: "partial/parent/fail.txt", content: "fail" },
						{ kind: "create", path: "later.txt", content: "later" },
					],
				},
				undefined,
				undefined,
				{ env },
			);
			expect.unreachable("expected partial commit failure");
		} catch (error) {
			expect(error).toMatchObject({
				code: "EDIT_PARTIAL_COMMIT",
				details: {
					completedOperationIndexes: [0],
					failedOperationIndex: 1,
					pendingOperationIndexes: [2],
					createdDirectories: expect.arrayContaining([
						expect.stringMatching(/partial$/),
						expect.stringMatching(/parent$/),
					]),
				},
			});
		}
	});
});
