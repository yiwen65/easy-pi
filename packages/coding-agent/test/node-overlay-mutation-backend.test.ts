import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createEditV2Tool,
	createReadV2Tool,
	type EditPlan,
	type MutationBackend,
	type MutationCapabilities,
	ToolStateLedger,
	V2ToolError,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeOverlayMutationBackend } from "../src/core/tools/node-overlay-mutation-backend.ts";

class PartialAcceptBackend implements MutationBackend {
	readonly id = "partial-accept";
	readonly capabilities: MutationCapabilities = {
		atomicRenameSameFilesystem: false,
		fsyncFile: false,
		fsyncDirectory: false,
		preserveMode: false,
		detectCrossFilesystem: false,
		durableJournal: false,
	};

	async commit(_plan: EditPlan): Promise<never> {
		throw new V2ToolError("EDIT_PARTIAL_COMMIT", "injected partial accept");
	}

	async close(): Promise<void> {}
}

describe("NodeOverlayMutationBackend", () => {
	let root: string;
	let workspace: string;
	let overlayRoot: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		root = path.join(tmpdir(), `pi-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspace = path.join(root, "workspace");
		overlayRoot = path.join(root, "overlays");
		await mkdir(workspace, { recursive: true });
		env = new NodeExecutionEnv({ cwd: workspace });
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(root, { recursive: true, force: true });
	});

	async function prepare(backend: NodeOverlayMutationBackend, content = "new") {
		const toolState = new ToolStateLedger();
		const context = { env, mutationBackend: backend, toolState };
		const view = await createReadV2Tool().execute(
			"overlay-read",
			{ path: "a.txt", maxLines: 1 },
			undefined,
			undefined,
			context,
		);
		return createEditV2Tool().execute(
			"overlay-edit",
			{
				operations: [
					{
						kind: "update",
						path: "a.txt",
						oldText: "old",
						newText: content,
						viewId: view.details.viewId,
						range: { startLine: 1, endLine: 1 },
					},
				],
			},
			undefined,
			undefined,
			context,
		);
	}

	it("keeps the base unchanged until explicit accept", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		let validatedPath = "";
		const backend = new NodeOverlayMutationBackend({
			workspaceRoot: workspace,
			overlayRoot,
			validate: async ({ workspacePath }) => {
				validatedPath = workspacePath;
				expect(await readFile(path.join(workspacePath, "a.txt"), "utf8")).toBe("new");
			},
		});
		const prepared = await prepare(backend);
		const pending = prepared.details.pendingAcceptance;
		if (!pending) throw new Error("expected pending overlay");
		expect(prepared.content[0]).toMatchObject({ text: expect.stringContaining("base workspace is unchanged") });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");
		expect(pending.workspacePath).toBe(validatedPath);
		expect(await readFile(path.join(pending.workspacePath, "a.txt"), "utf8")).toBe("new");
		expect(await backend.list()).toMatchObject([{ id: pending.id, state: "pending" }]);
		expect((await stat(overlayRoot)).mode & 0o777).toBe(0o700);

		await backend.accept(pending.id);
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("new");
		expect(await backend.list()).toEqual([]);
	});

	it("discards a pending overlay without touching the base", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const backend = new NodeOverlayMutationBackend({ workspaceRoot: workspace, overlayRoot });
		const prepared = await prepare(backend);
		const id = prepared.details.pendingAcceptance?.id;
		if (!id) throw new Error("expected pending overlay");
		await backend.discard(id);
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");
		expect(await backend.list()).toEqual([]);
	});

	it("discards validation failures and honors cancellation and copy quotas", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const validationBackend = new NodeOverlayMutationBackend({
			workspaceRoot: workspace,
			overlayRoot,
			validate: () => {
				throw new Error("validation failed");
			},
		});
		await expect(prepare(validationBackend)).rejects.toMatchObject({ code: "EDIT_ROLLED_BACK" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");
		expect(await validationBackend.list()).toEqual([]);

		const quotaBackend = new NodeOverlayMutationBackend({ workspaceRoot: workspace, overlayRoot, maxBytes: 1 });
		await expect(prepare(quotaBackend)).rejects.toMatchObject({ code: "EDIT_ROLLED_BACK" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");

		const cancelledBackend = new NodeOverlayMutationBackend({ workspaceRoot: workspace, overlayRoot });
		const toolState = new ToolStateLedger();
		const context = { env, mutationBackend: cancelledBackend, toolState };
		const view = await createReadV2Tool().execute(
			"cancel-read",
			{ path: "a.txt", maxLines: 1 },
			undefined,
			undefined,
			context,
		);
		const controller = new AbortController();
		controller.abort();
		const cancelled = createEditV2Tool().execute(
			"cancel-overlay",
			{
				operations: [
					{
						kind: "update",
						path: "a.txt",
						oldText: "old",
						newText: "new",
						viewId: view.details.viewId,
						range: { startLine: 1, endLine: 1 },
					},
				],
			},
			controller.signal,
			undefined,
			context,
		);
		await expect(cancelled).rejects.toMatchObject({ code: "ABORTED" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");
	});

	it("keeps a stale overlay pending when the base changes before accept", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const backend = new NodeOverlayMutationBackend({ workspaceRoot: workspace, overlayRoot });
		const prepared = await prepare(backend);
		const id = prepared.details.pendingAcceptance?.id;
		if (!id) throw new Error("expected pending overlay");
		await writeFile(path.join(workspace, "a.txt"), "external");
		await expect(backend.accept(id)).rejects.toMatchObject({ code: "STALE_FILE" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("external");
		expect(await backend.list()).toMatchObject([{ id, state: "pending" }]);
		await backend.discard(id);
	});

	it("enforces pending overlay quotas", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const backend = new NodeOverlayMutationBackend({ workspaceRoot: workspace, overlayRoot, maxOverlays: 1 });
		const first = await prepare(backend);
		await expect(prepare(backend, "newer")).rejects.toMatchObject({ code: "EDIT_PLAN_TOO_LARGE" });
		const id = first.details.pendingAcceptance?.id;
		if (id) await backend.discard(id);
	});

	it("cleans interrupted preparation but preserves an interrupted accept as indeterminate", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const backend = new NodeOverlayMutationBackend({ workspaceRoot: workspace, overlayRoot });
		const prepared = await prepare(backend);
		const pending = prepared.details.pendingAcceptance;
		if (!pending) throw new Error("expected pending overlay");
		const pendingRoot = path.dirname(pending.workspacePath);
		const manifestPath = path.join(pendingRoot, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { state: string; ownerPid: number };
		manifest.state = "copying";
		manifest.ownerPid = 999_999_999;
		await writeFile(manifestPath, JSON.stringify(manifest));
		expect(await backend.list()).toEqual([]);
		expect(await readdir(overlayRoot)).toEqual([]);

		const partialBackend = new NodeOverlayMutationBackend({
			workspaceRoot: workspace,
			overlayRoot,
			acceptBackend: new PartialAcceptBackend(),
		});
		const second = await prepare(partialBackend);
		const id = second.details.pendingAcceptance?.id;
		if (!id) throw new Error("expected pending overlay");
		await expect(partialBackend.accept(id)).rejects.toMatchObject({ code: "EDIT_PARTIAL_COMMIT" });
		expect(await partialBackend.list()).toMatchObject([{ id, state: "indeterminate" }]);
		await expect(prepare(partialBackend)).rejects.toMatchObject({ code: "EDIT_INDETERMINATE" });
		await expect(partialBackend.discard(id)).rejects.toMatchObject({ code: "EDIT_INDETERMINATE" });
	});
});
