import { spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createEditV2Tool,
	DEFAULT_MUTATION_LIMITS,
	type EditPlan,
	observeMutationPath,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeJournaledMutationBackend } from "../src/core/tools/node-journaled-mutation-backend.ts";

async function updatePlan(env: NodeExecutionEnv, updates: Array<{ path: string; content: string }>): Promise<EditPlan> {
	const observations = [];
	for (const update of updates) {
		observations.push(
			(await observeMutationPath(env, update.path, DEFAULT_MUTATION_LIMITS.maxFileBytes)).observation,
		);
	}
	return {
		observations,
		operations: updates.map((update) => ({ kind: "update" as const, path: update.path, content: update.content })),
		limits: DEFAULT_MUTATION_LIMITS,
	};
}

async function journalDirectories(journalRoot: string): Promise<string[]> {
	return (await readdir(journalRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

describe.skipIf(process.platform === "win32")("NodeJournaledMutationBackend", () => {
	let root: string;
	let workspace: string;
	let journalRoot: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		root = path.join(tmpdir(), `pi-journal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspace = path.join(root, "workspace");
		journalRoot = path.join(workspace, ".journal");
		await mkdir(workspace, { recursive: true });
		env = new NodeExecutionEnv({ cwd: workspace });
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(root, { recursive: true, force: true });
	});

	it("runs as an opt-in backend behind the unchanged v2 edit schema", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const backend = new NodeJournaledMutationBackend({ workspaceRoot: workspace, journalRoot });
		const result = await createEditV2Tool().execute(
			"journal-edit",
			{ operations: [{ kind: "update", path: "a.txt", oldText: "old", newText: "new" }] },
			undefined,
			undefined,
			{ env, mutationBackend: backend },
		);
		expect(result.details).toMatchObject({ dialect: "operations", files: [{ status: "updated" }] });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("new");
		expect(await journalDirectories(journalRoot)).toEqual([]);
	});

	it("commits staged final states durably while preserving mode and cleaning the journal", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old-a");
		await writeFile(path.join(workspace, "b.txt"), "old-b");
		await chmod(path.join(workspace, "a.txt"), 0o755);
		const missing = (
			await observeMutationPath(env, path.join(workspace, "c.txt"), DEFAULT_MUTATION_LIMITS.maxFileBytes)
		).observation;
		const plan = await updatePlan(env, [
			{ path: path.join(workspace, "a.txt"), content: "new-a" },
			{ path: path.join(workspace, "b.txt"), content: "new-b" },
		]);
		plan.observations.push(missing);
		plan.operations.push(
			{ kind: "move", path: path.join(workspace, "b.txt"), to: path.join(workspace, "c.txt") },
			{ kind: "update", path: path.join(workspace, "c.txt"), content: "final-c" },
		);
		const backend = new NodeJournaledMutationBackend({ workspaceRoot: workspace, journalRoot });
		const result = await backend.commit(plan);
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("new-a");
		expect((await stat(path.join(workspace, "a.txt"))).mode & 0o777).toBe(0o755);
		expect(await readFile(path.join(workspace, "c.txt"), "utf8")).toBe("final-c");
		await expect(stat(path.join(workspace, "b.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(result.completedOperationIndexes).toEqual([0, 1, 2, 3]);
		expect(await readdir(journalRoot)).toEqual([]);
		expect(backend.capabilities).toMatchObject({ durableJournal: true, fsyncDirectory: true, preserveMode: true });
	});

	for (const state of ["planned", "staged", "originals_secured", "installing"] as const) {
		it(`rolls back a failure injected after the ${state} transition`, async () => {
			await writeFile(path.join(workspace, "a.txt"), "old");
			const plan = await updatePlan(env, [{ path: path.join(workspace, "a.txt"), content: "new" }]);
			const backend = new NodeJournaledMutationBackend({
				workspaceRoot: workspace,
				journalRoot,
				failureInjector: (point) => {
					if (point === `after_state:${state}`) throw new Error(`injected ${state}`);
				},
			});
			await expect(backend.commit(plan)).rejects.toMatchObject({ code: "EDIT_ROLLED_BACK" });
			expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");
			expect(await journalDirectories(journalRoot)).toEqual([]);
		});
	}

	for (const state of ["committed", "cleanup_complete"] as const) {
		it(`returns committed success when cleanup fails after ${state}`, async () => {
			await writeFile(path.join(workspace, "a.txt"), "old");
			const plan = await updatePlan(env, [{ path: path.join(workspace, "a.txt"), content: "new" }]);
			const backend = new NodeJournaledMutationBackend({
				workspaceRoot: workspace,
				journalRoot,
				failureInjector: (point) => {
					if (point === `after_state:${state}`) throw new Error(`injected ${state}`);
				},
			});
			await expect(backend.commit(plan)).resolves.toMatchObject({ completedOperationIndexes: [0] });
			expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("new");
			expect(await journalDirectories(journalRoot)).toEqual([]);
		});
	}

	it("rolls back injected payload write, fsync, directory-fsync, and rename failures", async () => {
		for (const point of [
			"before_payload_write",
			"before_install_fsync",
			"before_install_directory_fsync",
			"before_install_rename",
		] as const) {
			const caseRoot = path.join(workspace, point);
			const caseJournal = path.join(caseRoot, ".journal");
			await mkdir(caseRoot, { recursive: true });
			await writeFile(path.join(caseRoot, "a.txt"), "old");
			const caseEnv = new NodeExecutionEnv({ cwd: caseRoot });
			const plan = await updatePlan(caseEnv, [{ path: path.join(caseRoot, "a.txt"), content: "new" }]);
			let failed = false;
			const backend = new NodeJournaledMutationBackend({
				workspaceRoot: caseRoot,
				journalRoot: caseJournal,
				failureInjector: (candidate) => {
					if (candidate === point && !failed) {
						failed = true;
						throw new Error(`injected ${point}`);
					}
				},
			});
			await expect(backend.commit(plan)).rejects.toMatchObject({ code: "EDIT_ROLLED_BACK" });
			expect(await readFile(path.join(caseRoot, "a.txt"), "utf8")).toBe("old");
			expect(await journalDirectories(caseJournal)).toEqual([]);
			await caseEnv.cleanup();
		}
	});

	it("leaves a committed cleanup failure for the recovery scanner", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const plan = await updatePlan(env, [{ path: path.join(workspace, "a.txt"), content: "new" }]);
		const backend = new NodeJournaledMutationBackend({
			workspaceRoot: workspace,
			journalRoot,
			failureInjector: (point) => {
				if (point === "before_cleanup") throw new Error("injected cleanup failure");
			},
		});
		await expect(backend.commit(plan)).resolves.toMatchObject({ completedOperationIndexes: [0] });
		const [transactionId] = await journalDirectories(journalRoot);
		if (!transactionId) throw new Error("expected retained transaction");
		expect((await stat(journalRoot)).mode & 0o777).toBe(0o700);
		expect((await stat(path.join(journalRoot, transactionId, "manifest.json"))).mode & 0o777).toBe(0o600);
		expect((await stat(path.join(journalRoot, transactionId, "stages"))).mode & 0o777).toBe(0o700);
		const recovery = await new NodeJournaledMutationBackend({ workspaceRoot: workspace, journalRoot }).recover();
		expect(recovery.cleaned).toHaveLength(1);
		expect(await journalDirectories(journalRoot)).toEqual([]);
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("new");
	});

	it("recovers a failure injected after rollback_started", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const plan = await updatePlan(env, [{ path: path.join(workspace, "a.txt"), content: "new" }]);
		let installFailed = false;
		const backend = new NodeJournaledMutationBackend({
			workspaceRoot: workspace,
			journalRoot,
			failureInjector: (point) => {
				if (point === "after_install:0" && !installFailed) {
					installFailed = true;
					throw new Error("start rollback");
				}
				if (point === "after_state:rollback_started") throw new Error("interrupt rollback");
			},
		});
		await expect(backend.commit(plan)).rejects.toMatchObject({ code: "EDIT_INDETERMINATE" });
		const recoveryBackend = new NodeJournaledMutationBackend({ workspaceRoot: workspace, journalRoot });
		const recovery = await recoveryBackend.recover();
		expect(recovery.recovered).toHaveLength(1);
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");
		expect(await journalDirectories(journalRoot)).toEqual([]);
	});

	it("treats a post-rollback_complete failure as a confirmed rollback", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const plan = await updatePlan(env, [{ path: path.join(workspace, "a.txt"), content: "new" }]);
		let installFailed = false;
		const backend = new NodeJournaledMutationBackend({
			workspaceRoot: workspace,
			journalRoot,
			failureInjector: (point) => {
				if (point === "after_install:0" && !installFailed) {
					installFailed = true;
					throw new Error("start rollback");
				}
				if (point === "after_state:rollback_complete") throw new Error("after durable rollback");
			},
		});
		await expect(backend.commit(plan)).rejects.toMatchObject({ code: "EDIT_ROLLED_BACK" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");
		expect(await journalDirectories(journalRoot)).toEqual([]);
	});

	it("fails closed without overwriting an external modification", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const plan = await updatePlan(env, [{ path: path.join(workspace, "a.txt"), content: "new" }]);
		const backend = new NodeJournaledMutationBackend({
			workspaceRoot: workspace,
			journalRoot,
			failureInjector: async (point) => {
				if (point === "after_state:installing") await writeFile(path.join(workspace, "a.txt"), "external");
			},
		});
		await expect(backend.commit(plan)).rejects.toMatchObject({ code: "EDIT_INDETERMINATE" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("external");
		const recovery = await new NodeJournaledMutationBackend({ workspaceRoot: workspace, journalRoot }).recover();
		expect(recovery.indeterminate).toHaveLength(1);
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("external");
	});

	it("enforces byte quotas and active-process recovery locks before mutation", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old");
		const plan = await updatePlan(env, [{ path: path.join(workspace, "a.txt"), content: "new" }]);
		const quotaBackend = new NodeJournaledMutationBackend({
			workspaceRoot: workspace,
			journalRoot,
			maxJournalBytes: 1,
		});
		await expect(quotaBackend.commit(plan)).rejects.toMatchObject({ code: "EDIT_PLAN_TOO_LARGE" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");

		await mkdir(journalRoot, { recursive: true });
		await writeFile(
			path.join(journalRoot, "mutation.lock"),
			JSON.stringify({ pid: process.pid, token: "other", createdAt: Date.now() }),
		);
		await expect(
			new NodeJournaledMutationBackend({ workspaceRoot: workspace, journalRoot }).recover(),
		).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
	});

	it("rejects a tampered manifest path without touching files outside the workspace", async () => {
		const outside = path.join(root, "outside.txt");
		await writeFile(outside, "outside");
		const transactionId = "tampered";
		const transactionRoot = path.join(journalRoot, transactionId);
		await mkdir(path.join(transactionRoot, "stages"), { recursive: true });
		await mkdir(path.join(transactionRoot, "backups"), { recursive: true });
		const now = Date.now();
		await writeFile(
			path.join(transactionRoot, "manifest.json"),
			JSON.stringify({
				version: 1,
				id: transactionId,
				state: "installing",
				createdAt: now,
				updatedAt: now,
				expiresAt: now + 1000,
				entries: [{ path: outside, initial: { exists: true, size: 7 }, final: { exists: false, size: 0 } }],
				parentDirectories: [],
			}),
		);
		const recovery = await new NodeJournaledMutationBackend({ workspaceRoot: workspace, journalRoot }).recover();
		expect(recovery.indeterminate).toEqual([transactionId]);
		expect(await readFile(outside, "utf8")).toBe("outside");
	});

	it("recovers a real child-process crash after the first installed file", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old-a");
		await writeFile(path.join(workspace, "b.txt"), "old-b");
		const backendModule = pathToFileURL(
			path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				"../src/core/tools/node-journaled-mutation-backend.ts",
			),
		).href;
		const script = path.join(root, "crash-child.mts");
		await writeFile(
			script,
			`import { DEFAULT_MUTATION_LIMITS, observeMutationPath } from "@earendil-works/pi-agent-core";\n` +
				`import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";\n` +
				`import { NodeJournaledMutationBackend } from ${JSON.stringify(backendModule)};\n` +
				`const workspace = ${JSON.stringify(workspace)};\n` +
				`const journalRoot = ${JSON.stringify(journalRoot)};\n` +
				`const env = new NodeExecutionEnv({ cwd: workspace });\n` +
				`const paths = [workspace + "/a.txt", workspace + "/b.txt"];\n` +
				`const observations = []; for (const file of paths) observations.push((await observeMutationPath(env, file, DEFAULT_MUTATION_LIMITS.maxFileBytes)).observation);\n` +
				`const plan = { observations, operations: paths.map((file, index) => ({ kind: "update", path: file, content: "new-" + index })), limits: DEFAULT_MUTATION_LIMITS };\n` +
				`const backend = new NodeJournaledMutationBackend({ workspaceRoot: workspace, journalRoot, failureInjector: (point) => { if (point === "after_install:0") process.exit(86); } });\n` +
				`await backend.commit(plan);\n`,
		);
		const child = spawnSync(process.execPath, ["--import", "tsx", script], {
			cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(child.status, child.stderr).toBe(86);
		const recovery = await new NodeJournaledMutationBackend({ workspaceRoot: workspace, journalRoot }).recover();
		expect(recovery.recovered).toHaveLength(1);
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old-a");
		expect(await readFile(path.join(workspace, "b.txt"), "utf8")).toBe("old-b");
		expect(await journalDirectories(journalRoot)).toEqual([]);
	});
});
