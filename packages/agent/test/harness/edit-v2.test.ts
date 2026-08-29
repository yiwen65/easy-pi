import { chmod, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createEditV2Tool } from "../../src/harness/tools/edit-v2.ts";
import {
	type EditPlan,
	ExecutionEnvMutationBackend,
	HookedMutationBackend,
	type MutationBackend,
} from "../../src/harness/tools/mutation-core.ts";
import { createReadV2Tool } from "../../src/harness/tools/read-v2.ts";
import { ToolStateLedger } from "../../src/harness/tools/tool-state.ts";
import { V2ToolError } from "../../src/harness/tools/v2-errors.ts";
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
	it("orders mutation hooks and preserves backend outcomes when notifications fail", async () => {
		const events: string[] = [];
		const plan: EditPlan = {
			observations: [],
			operations: [{ kind: "create", path: "/a.txt", content: "a" }],
			limits: { maxOperations: 1, maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 10 },
		};
		const backend: MutationBackend = {
			id: "hook-test",
			capabilities: {
				atomicRenameSameFilesystem: false,
				fsyncFile: false,
				fsyncDirectory: false,
				preserveMode: false,
				detectCrossFilesystem: false,
				durableJournal: false,
			},
			commit: async () => {
				events.push("commit");
				return { completedOperationIndexes: [0], changedPaths: ["/a.txt"], createdDirectories: [] };
			},
			close: async () => {},
		};
		const hooked = new HookedMutationBackend(backend, {
			beforeCommit: () => {
				events.push("before");
			},
			afterCommit: () => {
				events.push("after");
				throw new Error("notification failed");
			},
			onHookError: (stage) => {
				events.push(`error:${stage}`);
				throw new Error("observer failed");
			},
		});

		await expect(hooked.commit(plan)).resolves.toMatchObject({ changedPaths: ["/a.txt"] });
		expect(events).toEqual(["before", "commit", "after", "error:afterCommit"]);
	});

	it("rejects before commit without calling the backend and reports confirmed rollbacks", async () => {
		const plan: EditPlan = {
			observations: [{ path: "/a.txt", exists: true, size: 1 }],
			operations: [{ kind: "update", path: "/a.txt", content: "b" }],
			limits: { maxOperations: 1, maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 10 },
		};
		let commits = 0;
		const rollbackError = new V2ToolError("EDIT_ROLLED_BACK", "rolled back");
		const backend: MutationBackend = {
			id: "hook-test",
			capabilities: {
				atomicRenameSameFilesystem: false,
				fsyncFile: false,
				fsyncDirectory: false,
				preserveMode: false,
				detectCrossFilesystem: false,
				durableJournal: false,
			},
			commit: async () => {
				commits++;
				throw rollbackError;
			},
			close: async () => {},
		};
		const denied = new HookedMutationBackend(backend, {
			beforeCommit: () => {
				throw new Error("denied");
			},
		});
		await expect(denied.commit(plan)).rejects.toMatchObject({ code: "EDIT_ROLLED_BACK" });
		expect(commits).toBe(0);

		const rollbacks: string[] = [];
		const notified = new HookedMutationBackend(backend, {
			afterRollback: (_plan, error) => {
				rollbacks.push(error.message);
				throw new Error("rollback notification failed");
			},
			onHookError: (stage) => rollbacks.push(stage),
		});
		await expect(notified.commit(plan)).rejects.toBe(rollbackError);
		expect(commits).toBe(1);
		expect(rollbacks).toEqual([rollbackError.message, "afterRollback"]);
	});

	it("applies ordered create, update, move, update, and delete operations", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("first.txt", "one"));
		getOrThrow(await env.writeFile("second.txt", "two"));
		getOrThrow(await env.writeFile("delete.txt", "remove"));
		const toolState = new ToolStateLedger();
		const context = { env, toolState };
		const read = createReadV2Tool();
		const first = await read.execute("first", { path: "first.txt", maxLines: 1 }, undefined, undefined, context);
		const second = await read.execute("second", { path: "second.txt", maxLines: 1 }, undefined, undefined, context);
		env.mutations = 0;
		const result = await createEditV2Tool().execute(
			"id",
			{
				operations: [
					{ kind: "create", path: "created.txt", content: "created" },
					{
						kind: "update",
						path: "first.txt",
						oldText: "one",
						newText: "ONE",
						viewId: first.details.viewId,
						range: { startLine: 1, endLine: 1 },
					},
					{ kind: "move", path: "first.txt", to: "moved.txt" },
					{
						kind: "update",
						path: "second.txt",
						oldText: "two",
						newText: "TWO",
						viewId: second.details.viewId,
						range: { startLine: 1, endLine: 1 },
					},
					{ kind: "delete", path: "delete.txt" },
				],
			},
			undefined,
			undefined,
			context,
		);
		expect(getOrThrow(await env.readTextFile("created.txt"))).toBe("created");
		expect(getOrThrow(await env.readTextFile("moved.txt"))).toBe("ONE");
		expect(getOrThrow(await env.readTextFile("second.txt"))).toBe("TWO");
		expect(getOrThrow(await env.exists("first.txt"))).toBe(false);
		expect(getOrThrow(await env.exists("delete.txt"))).toBe(false);
		expect(result.details.operations).toHaveLength(5);
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

	it("prepares and commits a view-bound range without changing another identical line", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "same\nmiddle\nsame\n"));
		const toolState = new ToolStateLedger();
		const context = { env, toolState };
		const view = await createReadV2Tool().execute(
			"read",
			{ path: "a.txt", startLine: 3, maxLines: 1 },
			undefined,
			undefined,
			context,
		);
		const edit = createEditV2Tool();
		env.mutations = 0;
		const prepared = await edit.execute(
			"prepare",
			{
				action: "prepare",
				operations: [
					{
						kind: "update",
						path: "a.txt",
						oldText: "same",
						newText: "changed",
						viewId: view.details.viewId,
						expectedFileHash: view.details.fileHash,
						range: { startLine: 3, endLine: 3 },
						matchPolicy: "exactly_one_in_range",
						replaceAll: false,
					},
				],
			},
			undefined,
			undefined,
			context,
		);
		expect(env.mutations).toBe(0);
		expect(getOrThrow(await env.readTextFile("a.txt"))).toBe("same\nmiddle\nsame\n");
		expect(prepared.details).toMatchObject({
			status: "prepared",
			patchId: expect.stringMatching(/^patch_/),
			files: [{ status: "updated", firstChangedLine: 3 }],
		});
		expect((prepared.content[0] as { text: string }).text).toContain("-3 same\n+3 changed");

		const committed = await edit.execute(
			"commit",
			{ action: "commit", patchId: prepared.details.patchId },
			undefined,
			undefined,
			context,
		);
		expect(committed.details.status).toBe("applied");
		expect(getOrThrow(await env.readTextFile("a.txt"))).toBe("same\nmiddle\nchanged\n");
		expect(toolState.getView(view.details.viewId ?? "", env.cwd)).toBeUndefined();
		expect(toolState.getEvidence()).toEqual({ locators: [], views: [], patches: [] });
	});

	it("rejects ambiguous, mismatched, and out-of-view preimages before mutation", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "same same\nother\n"));
		const toolState = new ToolStateLedger();
		const context = { env, toolState };
		const view = await createReadV2Tool().execute(
			"read",
			{ path: "a.txt", startLine: 1, maxLines: 1 },
			undefined,
			undefined,
			context,
		);
		const edit = createEditV2Tool();
		const operation = {
			kind: "update" as const,
			path: "a.txt",
			oldText: "same",
			newText: "changed",
			viewId: view.details.viewId,
			expectedFileHash: view.details.fileHash,
			range: { startLine: 1, endLine: 1 },
			matchPolicy: "exactly_one_in_range" as const,
		};
		env.mutations = 0;
		await expect(
			edit.execute("ambiguous", { action: "prepare", operations: [operation] }, undefined, undefined, context),
		).rejects.toMatchObject({ code: "AMBIGUOUS_MATCH", details: { matchCount: 2 } });
		await expect(
			edit.execute(
				"preimage",
				{ action: "prepare", operations: [{ ...operation, oldText: "missing" }] },
				undefined,
				undefined,
				context,
			),
		).rejects.toMatchObject({ code: "PREIMAGE_MISMATCH" });
		await expect(
			edit.execute(
				"range",
				{ action: "prepare", operations: [{ ...operation, range: { startLine: 2, endLine: 2 } }] },
				undefined,
				undefined,
				context,
			),
		).rejects.toMatchObject({ code: "RANGE_MISMATCH" });
		await expect(
			edit.execute(
				"unbound-range",
				{
					action: "prepare",
					operations: [{ ...operation, viewId: undefined, expectedFileHash: undefined }],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(env.mutations).toBe(0);
	});

	it("rejects changed views and changed prepared preimages without mutation", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "old\n"));
		const toolState = new ToolStateLedger();
		const context = { env, toolState };
		const read = async () =>
			createReadV2Tool().execute(
				"read",
				{ path: "a.txt", startLine: 1, maxLines: 1 },
				undefined,
				undefined,
				context,
			);
		const edit = createEditV2Tool();
		const staleView = await read();
		getOrThrow(await env.writeExternal("a.txt", "external before prepare\n"));
		env.mutations = 0;
		await expect(
			edit.execute(
				"stale-view",
				{
					action: "prepare",
					operations: [
						{
							kind: "update",
							path: "a.txt",
							oldText: "old",
							newText: "new",
							viewId: staleView.details.viewId,
							range: { startLine: 1, endLine: 1 },
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toMatchObject({ code: "STALE_VIEW" });
		expect(env.mutations).toBe(0);

		getOrThrow(await env.writeExternal("a.txt", "old\n"));
		const freshView = await read();
		const prepared = await edit.execute(
			"prepare",
			{
				action: "prepare",
				operations: [
					{
						kind: "update",
						path: "a.txt",
						oldText: "old",
						newText: "new",
						viewId: freshView.details.viewId,
						range: { startLine: 1, endLine: 1 },
					},
				],
			},
			undefined,
			undefined,
			context,
		);
		getOrThrow(await env.writeExternal("a.txt", "external before commit\n"));
		env.mutations = 0;
		await expect(
			edit.execute("commit", { action: "commit", patchId: prepared.details.patchId }, undefined, undefined, context),
		).rejects.toMatchObject({ code: "STALE_PATCH" });
		expect(env.mutations).toBe(0);
		expect(getOrThrow(await env.readTextFile("a.txt"))).toBe("external before commit\n");
		await expect(
			edit.execute("replay", { action: "commit", patchId: prepared.details.patchId }, undefined, undefined, context),
		).rejects.toMatchObject({ code: "STALE_PATCH" });
	});

	it("prevalidates every prepared file before a multi-file commit", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "a-old\n"));
		getOrThrow(await env.writeFile("b.txt", "b-old\n"));
		const toolState = new ToolStateLedger();
		const context = { env, toolState };
		const read = createReadV2Tool();
		const a = await read.execute("a", { path: "a.txt", maxLines: 1 }, undefined, undefined, context);
		const b = await read.execute("b", { path: "b.txt", maxLines: 1 }, undefined, undefined, context);
		const edit = createEditV2Tool();
		const prepared = await edit.execute(
			"prepare",
			{
				action: "prepare",
				operations: [
					{
						kind: "update",
						path: "a.txt",
						oldText: "a-old",
						newText: "a-new",
						viewId: a.details.viewId,
						range: { startLine: 1, endLine: 1 },
					},
					{
						kind: "update",
						path: "b.txt",
						oldText: "b-old",
						newText: "b-new",
						viewId: b.details.viewId,
						range: { startLine: 1, endLine: 1 },
					},
				],
			},
			undefined,
			undefined,
			context,
		);
		getOrThrow(await env.writeExternal("b.txt", "b-external\n"));
		env.mutations = 0;
		await expect(
			edit.execute("commit", { action: "commit", patchId: prepared.details.patchId }, undefined, undefined, context),
		).rejects.toMatchObject({ code: "STALE_PATCH" });
		expect(env.mutations).toBe(0);
		expect(getOrThrow(await env.readTextFile("a.txt"))).toBe("a-old\n");
		expect(getOrThrow(await env.readTextFile("b.txt"))).toBe("b-external\n");
	});

	it("rejects every unversioned update dialect and same-batch update before mutation", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "unique old value\n"));
		env.mutations = 0;
		const attempts = [
			createEditV2Tool().execute(
				"operations-unversioned",
				{
					operations: [{ kind: "update", path: "a.txt", oldText: "unique old value", newText: "unsafe" }],
				},
				undefined,
				undefined,
				{ env },
			),
			createEditV2Tool({ dialect: "replacement" }).execute(
				"replacement-unversioned",
				{ path: "a.txt", edits: [{ oldText: "unique old value", newText: "unsafe" }] },
				undefined,
				undefined,
				{ env },
			),
			createEditV2Tool({ dialect: "patch" }).execute(
				"patch-unversioned",
				{
					patch: [
						"*** Pi Edit Patch v1",
						JSON.stringify({
							kind: "update",
							path: "a.txt",
							oldText: "unique old value",
							newText: "unsafe",
						}),
						"*** End Pi Edit Patch",
					].join("\n"),
				},
				undefined,
				undefined,
				{ env },
			),
			createEditV2Tool().execute(
				"same-batch-unversioned",
				{
					operations: [
						{ kind: "create", path: "created.txt", content: "before" },
						{
							kind: "update",
							path: "created.txt",
							oldText: "before",
							newText: "unsafe",
							range: { startLine: 1, endLine: 1 },
						},
					],
				},
				undefined,
				undefined,
				{ env },
			),
		];
		for (const attempt of attempts) await expect(attempt).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(env.mutations).toBe(0);
		expect(getOrThrow(await env.readTextFile("a.txt"))).toBe("unique old value\n");
		expect(getOrThrow(await env.exists("created.txt"))).toBe(false);
	});

	it("performs zero mutations when prevalidation fails", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "same same"));
		const toolState = new ToolStateLedger();
		const context = { env, toolState };
		const view = await createReadV2Tool().execute(
			"read",
			{ path: "a.txt", maxLines: 1 },
			undefined,
			undefined,
			context,
		);
		env.mutations = 0;
		await expect(
			createEditV2Tool().execute(
				"id",
				{
					operations: [
						{ kind: "create", path: "new/parent/file.txt", content: "new" },
						{
							kind: "update",
							path: "a.txt",
							oldText: "same",
							newText: "x",
							viewId: view.details.viewId,
							range: { startLine: 1, endLine: 1 },
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toMatchObject({ code: "AMBIGUOUS_MATCH" });
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
		const toolState = new ToolStateLedger();
		const context = { env, toolState };
		const view = await createReadV2Tool().execute(
			"read",
			{ path: "a.txt", maxLines: 1 },
			undefined,
			undefined,
			context,
		);
		env.mutations = 0;
		const backend = new StaleBeforeCommitBackend(env, "a.txt");
		await expect(
			createEditV2Tool({ backend }).execute(
				"id",
				{
					operations: [
						{
							kind: "update",
							path: "a.txt",
							oldText: "original",
							newText: "planned",
							viewId: view.details.viewId,
							range: { startLine: 1, endLine: 1 },
						},
					],
				},
				undefined,
				undefined,
				context,
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
		const toolState = new ToolStateLedger();
		const context = { env, toolState };
		const view = await createReadV2Tool().execute(
			"read",
			{ path: "script.txt", maxLines: 2 },
			undefined,
			undefined,
			context,
		);
		env.mutations = 0;
		await createEditV2Tool().execute(
			"id",
			{
				operations: [
					{
						kind: "update",
						path: "script.txt",
						oldText: "one\ntwo",
						newText: "ONE\nTWO",
						viewId: view.details.viewId,
						range: { startLine: 1, endLine: 2 },
					},
				],
			},
			undefined,
			undefined,
			context,
		);
		expect(getOrThrow(await env.readTextFile("script.txt"))).toBe("\uFEFFONE\r\nTWO\r\n");
		expect((await stat(`${env.cwd}/script.txt`)).mode & 0o777).toBe(0o755);
	});

	it("normalizes replacement and versioned patch dialects into canonical operations", async () => {
		const replacementEnv = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await replacementEnv.writeFile("a.txt", "alpha beta gamma"));
		const toolState = new ToolStateLedger();
		const context = { env: replacementEnv, toolState };
		const view = await createReadV2Tool().execute(
			"read",
			{ path: "a.txt", maxLines: 1 },
			undefined,
			undefined,
			context,
		);
		const replacement = await createEditV2Tool({ dialect: "replacement" }).execute(
			"replacement",
			{
				path: "a.txt",
				edits: [
					{ oldText: "alpha", newText: "A" },
					{ oldText: "gamma", newText: "G" },
				],
				viewId: view.details.viewId,
				range: { startLine: 1, endLine: 1 },
			},
			undefined,
			undefined,
			context,
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
		for (const dialect of ["operations", "replacement", "patch"] as const) {
			const env = new TrackingEnv({ cwd: createTempDir() });
			getOrThrow(await env.writeFile("a.txt", "one\ntwo\nthree\n"));
			const toolState = new ToolStateLedger();
			const context = { env, toolState };
			const view = await createReadV2Tool().execute(
				"read",
				{ path: "a.txt", startLine: 2, maxLines: 1 },
				undefined,
				undefined,
				context,
			);
			const binding = {
				viewId: view.details.viewId,
				expectedFileHash: view.details.fileHash,
				range: { startLine: 2, endLine: 2 },
				matchPolicy: "exactly_one_in_range" as const,
			};
			const input =
				dialect === "operations"
					? {
							operations: [
								{ kind: "update" as const, path: "a.txt", oldText: "two", newText: "TWO", ...binding },
							],
						}
					: dialect === "replacement"
						? { path: "a.txt", edits: [{ oldText: "two", newText: "TWO" }], ...binding }
						: {
								patch: [
									"*** Pi Edit Patch v1",
									JSON.stringify({
										kind: "update",
										path: "a.txt",
										oldText: "two",
										newText: "TWO",
										...binding,
									}),
									"*** End Pi Edit Patch",
								].join("\n"),
							};
			await createEditV2Tool({ dialect }).execute(dialect, input, undefined, undefined, context);
			expect(getOrThrow(await env.readTextFile("a.txt"))).toBe("one\nTWO\nthree\n");
		}
	});

	it("rejects malformed patches and non-UTF-8 files before mutation", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("binary.bin", Uint8Array.from([0xff, 0xfe, 0xfd])));
		const toolState = new ToolStateLedger();
		const context = { env, toolState };
		env.mutations = 0;
		await expect(
			createEditV2Tool({ dialect: "patch" }).execute(
				"patch",
				{ patch: "*** Pi Edit Patch v2\n*** End Pi Edit Patch" },
				undefined,
				undefined,
				context,
			),
		).rejects.toMatchObject({ code: "PATCH_PARSE_ERROR" });
		getOrThrow(await env.writeExternal("text.txt", "current"));
		const textView = await createReadV2Tool().execute(
			"text-read",
			{ path: "text.txt", maxLines: 1 },
			undefined,
			undefined,
			context,
		);
		const missingContextPatch = [
			"*** Pi Edit Patch v1",
			JSON.stringify({
				kind: "update",
				path: "text.txt",
				oldText: "missing",
				newText: "new",
				viewId: textView.details.viewId,
				range: { startLine: 1, endLine: 1 },
			}),
			"*** End Pi Edit Patch",
		].join("\n");
		await expect(
			createEditV2Tool({ dialect: "patch" }).execute(
				"patch-context",
				{ patch: missingContextPatch },
				undefined,
				undefined,
				context,
			),
		).rejects.toMatchObject({ code: "PATCH_CONTEXT_NOT_FOUND" });
		getOrThrow(await env.writeExternal("mixed.txt", "one\r\ntwo\n"));
		const mixedView = await createReadV2Tool().execute(
			"mixed-read",
			{ path: "mixed.txt", maxLines: 1 },
			undefined,
			undefined,
			context,
		);
		await expect(
			createEditV2Tool().execute(
				"mixed",
				{
					operations: [
						{
							kind: "update",
							path: "mixed.txt",
							oldText: "one",
							newText: "ONE",
							viewId: mixedView.details.viewId,
							range: { startLine: 1, endLine: 1 },
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			createEditV2Tool().execute(
				"binary",
				{ operations: [{ kind: "update", path: "binary.bin", oldText: "x", newText: "y" }] },
				undefined,
				undefined,
				context,
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
