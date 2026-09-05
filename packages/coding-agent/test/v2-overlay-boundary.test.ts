import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeOverlayMutationBackend } from "../src/core/tools/node-overlay-mutation-backend.ts";
import { createV2ToolRuntime } from "../src/core/tools/tool-profile.ts";

describe("V2 runtime overlay symlink isolation", () => {
	let root: string;
	let workspace: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "pi-v2-overlay-boundary-"));
		workspace = path.join(root, "base-workspace");
		await mkdir(path.join(workspace, "real"), { recursive: true });
		await writeFile(path.join(workspace, "real/sample.txt"), "old\n");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("leaves the base unchanged when validation rejects an edit through an absolute link", async () => {
		await symlink(path.join(workspace, "real"), path.join(workspace, "linked"));
		let validatedContent: string | undefined;
		const backend = new NodeOverlayMutationBackend({
			workspaceRoot: workspace,
			overlayRoot: path.join(root, "overlays"),
			validate: async ({ workspacePath }) => {
				validatedContent = await readFile(path.join(workspacePath, "real/sample.txt"), "utf8");
				throw new Error("injected validation failure");
			},
		});
		const runtime = createV2ToolRuntime(workspace, {
			mutationBackend: backend,
			workspacePolicy: {
				roots: [workspace],
				followSymlinks: true,
				allowOutsideWorkspaceRead: false,
				allowOutsideWorkspaceWrite: false,
			},
		});
		try {
			const { read, edit } = runtime.definitions;
			const context = {} as Parameters<typeof read.execute>[4];
			const view = await read.execute("read", { path: "linked/sample.txt" }, undefined, undefined, context);
			await expect(
				edit.execute(
					"edit",
					{
						operations: [
							{
								kind: "update",
								path: "linked/sample.txt",
								oldText: "old",
								newText: "new",
								viewId: view.details.viewId,
							},
						],
					},
					undefined,
					undefined,
					context,
				),
			).rejects.toMatchObject({
				code: "EDIT_ROLLED_BACK",
				cause: expect.objectContaining({ message: "injected validation failure" }),
			});
			expect(await readFile(path.join(workspace, "real/sample.txt"), "utf8")).toBe("old\n");
			expect(validatedContent).toBe("new\n");
			expect(await backend.list()).toEqual([]);
		} finally {
			await runtime.close();
		}
	});

	it.each(["absolute", "relative", "relative-via-parent"] as const)(
		"isolates %s internal directory links through apply, discard, and accept",
		async (kind) => {
			const target =
				kind === "absolute"
					? path.join(workspace, "real")
					: kind === "relative"
						? "real"
						: "../base-workspace/real";
			await symlink(target, path.join(workspace, "linked"));
			const backend = new NodeOverlayMutationBackend({
				workspaceRoot: workspace,
				overlayRoot: path.join(root, "overlays"),
			});
			const runtime = createV2ToolRuntime(workspace, {
				mutationBackend: backend,
				workspacePolicy: {
					roots: [workspace],
					followSymlinks: true,
					allowOutsideWorkspaceRead: false,
					allowOutsideWorkspaceWrite: false,
				},
			});
			try {
				const { read, edit } = runtime.definitions;
				const context = {} as Parameters<typeof read.execute>[4];
				for (const decision of ["discard", "accept"] as const) {
					const view = await read.execute("read", { path: "linked/sample.txt" }, undefined, undefined, context);
					const result = await edit.execute(
						"edit",
						{
							operations: [
								{
									kind: "update",
									path: "linked/sample.txt",
									oldText: "old",
									newText: "new",
									viewId: view.details.viewId,
								},
							],
						},
						undefined,
						undefined,
						context,
					);
					expect(result.details).toMatchObject({ status: "pending_acceptance" });
					expect(result.content[0]).toMatchObject({
						text: expect.stringContaining("base workspace is unchanged"),
					});
					const pending = result.details.pendingAcceptance as { id: string; workspacePath: string };
					expect(await readFile(path.join(workspace, "real/sample.txt"), "utf8")).toBe("old\n");
					expect(await readFile(path.join(pending.workspacePath, "real/sample.txt"), "utf8")).toBe("new\n");
					expect(await readFile(path.join(pending.workspacePath, "linked/sample.txt"), "utf8")).toBe("new\n");
					await backend[decision](pending.id);
					expect(await readFile(path.join(workspace, "real/sample.txt"), "utf8")).toBe(
						decision === "accept" ? "new\n" : "old\n",
					);
					expect(await backend.list()).toEqual([]);
				}
			} finally {
				await runtime.close();
			}
		},
	);
});
