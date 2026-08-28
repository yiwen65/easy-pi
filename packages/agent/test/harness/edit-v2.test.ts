import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createEditV2Tool } from "../../src/harness/tools/edit-v2.ts";
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
	override async renameFile(source: string, destination: string, signal?: AbortSignal) {
		this.mutations++;
		return super.renameFile(source, destination, signal);
	}
	override async remove(path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }) {
		this.mutations++;
		return super.remove(path, options);
	}
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

	it("performs zero mutations when prevalidation fails", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("a.txt", "same same"));
		env.mutations = 0;
		await expect(
			createEditV2Tool().execute(
				"id",
				{ operations: [{ kind: "update", path: "a.txt", oldText: "same", newText: "x" }] },
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

	it("reports the failed operation and remaining work after a commit failure", async () => {
		const env = new TrackingEnv({ cwd: createTempDir() });
		env.failContent = "fail";
		try {
			await createEditV2Tool().execute(
				"id",
				{
					operations: [
						{ kind: "create", path: "ok.txt", content: "ok" },
						{ kind: "create", path: "fail.txt", content: "fail" },
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
				},
			});
		}
	});
});
