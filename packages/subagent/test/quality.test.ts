import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { captureExternalMutationPostState } from "@easy-pi/permissions/journal";
import { afterEach, describe, expect, it } from "vitest";
import {
	createExternalWriterArtifact,
	runValidationCommands,
	ValidationRegistry,
	validateAndCommitWriterTask,
	WriterQualityError,
} from "../src/quality.ts";
import type {
	ExternalMutationRecord,
	ExternalWriterHandoff,
	ExternalWriterTaskContract,
	ValidationCommand,
	WriterHandoff,
	WriterTaskContract,
} from "../src/types.ts";
import { createFrozenBaseline, createTaskWorktree } from "../src/worktree.ts";

const temporaryPaths: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
	return await new Promise((resolvePromise, rejectPromise) => {
		execFile("git", args, { cwd, encoding: "utf8", shell: false }, (error, stdout, stderr) => {
			if (error) rejectPromise(new Error(String(stderr).trim() || error.message));
			else resolvePromise(String(stdout).trim());
		});
	});
}

async function managedWorktree() {
	const root = await mkdtemp(join(tmpdir(), "subagent-quality-test-"));
	temporaryPaths.push(root);
	await git(root, "init", "-q", "-b", "main");
	await git(root, "config", "user.email", "quality@example.test");
	await git(root, "config", "user.name", "Quality Test");
	await mkdir(join(root, "owned"));
	await writeFile(join(root, ".gitignore"), "target/\nnode_modules/\ndist/\n");
	await writeFile(join(root, "owned", "existing.txt"), "existing\n");
	await writeFile(join(root, "outside.txt"), "baseline\n");
	await git(root, "add", ".");
	await git(root, "commit", "-q", "-m", "initial");
	const baseline = await createFrozenBaseline(root);
	const handle = await createTaskWorktree({
		repositoryPath: root,
		baselineCommit: baseline.baselineCommit,
		runId: "quality",
		taskId: `writer-${cleanups.length}`,
	});
	cleanups.push(async () => {
		await handle.cleanup().catch(() => {});
		await baseline.cleanup().catch(() => {});
	});
	return { root, handle };
}

function command(id: string, script: string, overrides: Partial<ValidationCommand> = {}): ValidationCommand {
	return {
		id,
		command: process.execPath,
		args: ["-e", script],
		timeoutMs: 2_000,
		maxOutputBytes: 4_096,
		...overrides,
	};
}

function writerTask(validationCommandIds: string[] = []): WriterTaskContract {
	return {
		id: "writer",
		role: "writer",
		objective: "Update owned files",
		nonGoals: [],
		readPaths: [],
		acceptance: [],
		dependsOn: [],
		maxAttempts: 1,
		contractHash: "c".repeat(64),
		ownedPaths: ["owned"],
		validationCommandIds,
	};
}

function handoff(changedPaths: string[]): WriterHandoff {
	return {
		taskId: "writer",
		summary: "Updated owned files",
		outcome: "accepted",
		evidence: [],
		verification: [],
		assumptions: [],
		risks: [],
		nextActions: [],
		verificationLevel: "unverified",
		artifactVersion: 2,
		changedPaths,
	};
}

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ValidationRegistry and runValidationCommands", () => {
	it("stores unique immutable trusted definitions and rejects unknown IDs or unresolved executables", () => {
		const definition = command("unit", "process.exit(0)");
		const registry = new ValidationRegistry([definition]);
		definition.args = ["untrusted"];
		expect(registry.lookup("unit").args).toEqual(["-e", "process.exit(0)"]);
		expect(Object.isFrozen(registry.lookup("unit"))).toBe(true);
		expect(() => registry.lookup("unknown")).toThrow("Unknown validation command");
		expect(() => new ValidationRegistry([definition, definition])).toThrow("Duplicate validation command id");
		expect(() => new ValidationRegistry([command("unit:test", "process.exit(0)")])).not.toThrow();
		expect(() => new ValidationRegistry([command("unit/test", "process.exit(0)")])).toThrow(
			"Validation command id must be 1-64 characters",
		);
		expect(() => new ValidationRegistry([command("relative", "", { command: "node" })])).toThrow(
			"absolute, controller-resolved executable",
		);
	});

	it("passes argv literally with shell disabled", async () => {
		const { handle } = await managedWorktree();
		const malicious = "; process.exit(77); #";
		const registry = new ValidationRegistry([
			command("argv", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", {
				args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", malicious],
			}),
		]);
		const [result] = await runValidationCommands({ handle, commandIds: ["argv"], registry });
		expect(result.status).toBe("passed");
		expect(JSON.parse(result.stdout)).toEqual([malicious]);
	});

	it("uses one private HOME/TMP per batch while preserving only PATH/locale system inputs", async () => {
		const { handle } = await managedWorktree();
		const inherited = {
			GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
			NODE_OPTIONS: process.env.NODE_OPTIONS,
			AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
			PI_VALIDATION_SECRET: process.env.PI_VALIDATION_SECRET,
		};
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.NODE_OPTIONS = "--trace-warnings";
		process.env.AWS_SECRET_ACCESS_KEY = "credential";
		process.env.PI_VALIDATION_SECRET = "secret";
		try {
			const probe =
				"const fs=require('node:fs'); const e=process.env; process.stdout.write(JSON.stringify({env:e,homeMode:fs.statSync(e.HOME).mode&0o777,tmpMode:fs.statSync(e.TMPDIR).mode&0o777}))";
			const registry = new ValidationRegistry([command("env-a", probe), command("env-b", probe)]);
			const results = await runValidationCommands({ handle, commandIds: ["env-a", "env-b"], registry });
			const observations = results.map(
				(result) => JSON.parse(result.stdout) as { env: Record<string, string>; homeMode: number; tmpMode: number },
			);
			expect(results.map((result) => result.status)).toEqual(["passed", "passed"]);
			expect(observations[1]?.env.HOME).toBe(observations[0]?.env.HOME);
			const env = observations[0]!.env;
			expect(env.HOME).not.toBe(process.env.HOME);
			expect(env.TMPDIR).not.toBe(process.env.TMPDIR);
			expect(env.TMP).toBe(env.TMPDIR);
			expect(env.TEMP).toBe(env.TMPDIR);
			expect(dirname(env.HOME)).toBe(dirname(env.TMPDIR));
			if (process.platform !== "win32") {
				expect(observations[0]).toMatchObject({ homeMode: 0o700, tmpMode: 0o700 });
			}
			expect(env.GIT_CONFIG_COUNT).toBeUndefined();
			expect(env.NODE_OPTIONS).toBeUndefined();
			expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
			expect(env.PI_VALIDATION_SECRET).toBeUndefined();
			expect(env.PATH).toBe(process.env.PATH);
			for (const key of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
				expect(env[key]).toBe(process.env[key]);
			}
			await expect(access(dirname(env.HOME))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			for (const [key, value] of Object.entries(inherited)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("bounds pipe drain by terminating descendants after the registered parent exits", async () => {
		const { handle } = await managedWorktree();
		const registry = new ValidationRegistry([
			command(
				"descendant",
				"const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}); child.unref();",
			),
		]);
		const startedAt = Date.now();
		const [result] = await runValidationCommands({ handle, commandIds: ["descendant"], registry });
		expect(result.status).toBe("passed");
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	it("returns structured failure, timeout, cancellation, and combined output-limit results", async () => {
		const { handle } = await managedWorktree();
		const registry = new ValidationRegistry([
			command("failed", "process.stderr.write('failed'); process.exit(3)"),
			command("timeout", "setInterval(() => {}, 1000)", { timeoutMs: 20 }),
			command("output", "process.stdout.write('x'.repeat(100)); process.stderr.write('y'.repeat(100))", {
				maxOutputBytes: 32,
			}),
			command("cancel", "setInterval(() => {}, 1000)"),
		]);
		const results = await runValidationCommands({
			handle,
			commandIds: ["failed", "timeout", "output"],
			registry,
		});
		expect(results.map((result) => result.status)).toEqual(["failed", "timeout", "failed"]);
		expect(results[0].exitCode).toBe(3);
		expect(Buffer.byteLength(results[2].stdout) + Buffer.byteLength(results[2].stderr)).toBeLessThanOrEqual(32);

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const [cancelled] = await runValidationCommands({
			handle,
			commandIds: ["cancel"],
			registry,
			signal: controller.signal,
		});
		expect(cancelled.status).toBe("cancelled");
	});

	it("cleans the private validation runtime after failure, timeout, and cancellation", async () => {
		const { handle } = await managedWorktree();
		const runtimeParent = await mkdtemp(join(tmpdir(), "subagent-validation-cleanup-test-"));
		temporaryPaths.push(runtimeParent);
		const inheritedTemp = Object.fromEntries(
			["TMPDIR", "TMP", "TEMP"].map((key) => [key, process.env[key]]),
		) as Record<string, string | undefined>;
		for (const key of Object.keys(inheritedTemp)) process.env[key] = runtimeParent;
		try {
			expect(tmpdir()).toBe(runtimeParent);
			const cases = [
				{
					id: "failed-cleanup",
					script: "process.exit(3)",
					expected: "failed" as const,
				},
				{
					id: "timeout-cleanup",
					script: "setInterval(()=>{},1000)",
					expected: "timeout" as const,
					timeoutMs: 20,
				},
			];
			for (const testCase of cases) {
				const registry = new ValidationRegistry([
					command(testCase.id, testCase.script, { timeoutMs: testCase.timeoutMs ?? 2_000 }),
				]);
				const [result] = await runValidationCommands({ handle, commandIds: [testCase.id], registry });
				expect(result.status).toBe(testCase.expected);
				expect(await readdir(runtimeParent)).toEqual([]);
			}

			const registry = new ValidationRegistry([command("cancelled-cleanup", "setInterval(()=>{},1000)")]);
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			const [cancelled] = await runValidationCommands({
				handle,
				commandIds: ["cancelled-cleanup"],
				registry,
				signal: controller.signal,
			});
			expect(cancelled.status).toBe("cancelled");
			expect(await readdir(runtimeParent)).toEqual([]);
		} finally {
			for (const [key, value] of Object.entries(inheritedTemp)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("wraps registered validation argv with an optional trusted launcher without a shell", async () => {
		const { handle } = await managedWorktree();
		const launcherRoot = await mkdtemp(join(tmpdir(), "subagent-validation-launcher-"));
		temporaryPaths.push(launcherRoot);
		const launcherPath = join(launcherRoot, "launcher.mjs");
		const logPath = join(launcherRoot, "argv.json");
		await writeFile(
			launcherPath,
			[
				'import { spawnSync } from "node:child_process";',
				'import { writeFileSync } from "node:fs";',
				"const [logPath, command, ...args] = process.argv.slice(2);",
				"writeFileSync(logPath, JSON.stringify({command,args}));",
				"const result=spawnSync(command,args,{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});",
				"if(result.stdout) process.stdout.write(result.stdout);",
				"if(result.stderr) process.stderr.write(result.stderr);",
				"process.exit(result.status ?? 1);",
			].join("\n"),
		);
		const registry = new ValidationRegistry([command("launched", "process.stdout.write('validated')")]);
		const [result] = await runValidationCommands({
			handle,
			commandIds: ["launched"],
			registry,
			sandboxLauncher: { command: process.execPath, prefixArgs: [launcherPath, logPath] },
		});
		expect(result).toMatchObject({ status: "passed", stdout: "validated" });
		expect(JSON.parse(await readFile(logPath, "utf8"))).toEqual({
			command: process.execPath,
			args: ["-e", "process.stdout.write('validated')"],
		});
	});

	it("rejects unsafe and escaping validation cwd values", async () => {
		const { handle } = await managedWorktree();
		const traversal = new ValidationRegistry([command("unsafe", "process.exit(0)", { cwd: "../" })]);
		await expect(runValidationCommands({ handle, commandIds: ["unsafe"], registry: traversal })).rejects.toThrow(
			"Unsafe validation cwd",
		);
		const absolute = new ValidationRegistry([command("absolute", "process.exit(0)", { cwd: tmpdir() })]);
		await expect(runValidationCommands({ handle, commandIds: ["absolute"], registry: absolute })).rejects.toThrow(
			"Unsafe validation cwd",
		);
	});
});

async function confirmedExternalMutation(path: string): Promise<ExternalMutationRecord> {
	return {
		mutationId: "attempt-1:1",
		runId: "run-1",
		taskId: "publish",
		attemptId: "attempt-1",
		attemptNumber: 1,
		authorizationSequence: 1,
		toolCallId: "write-1",
		operation: "write",
		path,
		authorizationStatus: "authorized",
		authorizedAt: 1,
		toolResult: "succeeded",
		observedAt: 2,
		postState: await captureExternalMutationPostState(path),
	};
}

describe("createExternalWriterArtifact", () => {
	it("records existing changed paths within the exact external roots", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-external-quality-"));
		temporaryPaths.push(root);
		const changedPath = join(root, "published.txt");
		await writeFile(changedPath, "published\n");
		const task: ExternalWriterTaskContract = {
			id: "publish",
			role: "external-writer",
			objective: "Publish",
			nonGoals: [],
			readPaths: [],
			acceptance: [],
			dependsOn: [],
			maxAttempts: 1,
			contractHash: "c".repeat(64),
			externalOwnedPaths: [root],
		};
		const handoff: ExternalWriterHandoff = {
			taskId: "publish",
			summary: "Published",
			outcome: "accepted",
			evidence: [],
			verification: [],
			assumptions: [],
			risks: ["Live side effect"],
			nextActions: [],
			verificationLevel: "unverified",
			artifactVersion: 2,
			externalChangedPaths: [],
		};
		const externalMutations = [await confirmedExternalMutation(changedPath)];
		const artifact = await createExternalWriterArtifact({ task, handoff, externalMutations });
		expect(artifact).toMatchObject({
			changedPaths: [],
			externalChangedPaths: [changedPath],
			handoff: { externalChangedPaths: [changedPath] },
			externalMutations,
		});
		expect(artifact.commit).toBeUndefined();
		for (const childClaim of [[join(root, "..", "outside.txt")], []]) {
			await expect(
				createExternalWriterArtifact({
					task,
					handoff: { ...handoff, externalChangedPaths: childClaim },
					externalMutations,
				}),
			).resolves.toMatchObject({ externalChangedPaths: [changedPath] });
		}

		await writeFile(changedPath, "replaced after journal observation\n");
		await expect(createExternalWriterArtifact({ task, handoff, externalMutations })).rejects.toThrow(
			"current post-state does not match the latest Controller observation",
		);
		await expect(createExternalWriterArtifact({ task, handoff, externalMutations: [] })).rejects.toThrow(
			"no Controller-authorized mutation journal",
		);
		await expect(
			createExternalWriterArtifact({
				task,
				handoff,
				externalMutations: [{ ...externalMutations[0]!, toolResult: "failed" }],
			}),
		).rejects.toThrow("lacks a successful confirmed post-state");
	});
});

describe("validateAndCommitWriterTask", () => {
	it("refuses to commit a writer handoff with a negative semantic outcome", async () => {
		const { handle } = await managedWorktree();
		await writeFile(join(handle.path, "owned", "result.txt"), "result\n");
		await expect(
			validateAndCommitWriterTask({
				handle,
				task: writerTask(),
				handoff: { ...handoff(["owned/result.txt"]), outcome: "rejected" },
				registry: new ValidationRegistry([]),
			}),
		).rejects.toMatchObject({ terminalReason: "task_rejected" });
		expect(await git(handle.path, "rev-parse", "HEAD")).toBe(handle.baselineCommit);
	});

	it("uses audited paths while still rejecting empty diffs and out-of-scope writer changes", async () => {
		const empty = await managedWorktree();
		await expect(
			validateAndCommitWriterTask({
				handle: empty.handle,
				task: writerTask(),
				handoff: handoff([]),
				registry: new ValidationRegistry([]),
			}),
		).rejects.toMatchObject({ terminalReason: "path_violation" });

		const mismatch = await managedWorktree();
		await writeFile(join(mismatch.handle.path, "owned", "changed.txt"), "changed\n");
		await expect(
			validateAndCommitWriterTask({
				handle: mismatch.handle,
				task: writerTask(),
				handoff: handoff(["owned/other.txt"]),
				registry: new ValidationRegistry([]),
			}),
		).resolves.toMatchObject({
			changedPaths: ["owned/changed.txt"],
			handoff: { changedPaths: ["owned/changed.txt"] },
		});

		const outside = await managedWorktree();
		await writeFile(join(outside.handle.path, "outside-change.txt"), "outside\n");
		await expect(
			validateAndCommitWriterTask({
				handle: outside.handle,
				task: writerTask(),
				handoff: handoff(["outside-change.txt"]),
				registry: new ValidationRegistry([]),
			}),
		).rejects.toBeInstanceOf(WriterQualityError);
	});

	it("reports failed validation results and catches validation changes outside ownership", async () => {
		const failed = await managedWorktree();
		await writeFile(join(failed.handle.path, "owned", "changed.txt"), "changed\n");
		await expect(
			validateAndCommitWriterTask({
				handle: failed.handle,
				task: writerTask(["fail"]),
				handoff: handoff(["owned/changed.txt"]),
				registry: new ValidationRegistry([command("fail", "process.exit(9)")]),
			}),
		).rejects.toMatchObject({ terminalReason: "validation_failed", validations: [{ status: "failed" }] });

		const mutated = await managedWorktree();
		await writeFile(join(mutated.handle.path, "owned", "changed.txt"), "changed\n");
		await expect(
			validateAndCommitWriterTask({
				handle: mutated.handle,
				task: writerTask(["mutate"]),
				handoff: handoff(["owned/changed.txt"]),
				registry: new ValidationRegistry([
					command("mutate", "require('node:fs').writeFileSync('validation-outside.txt', 'bad')"),
				]),
			}),
		).rejects.toMatchObject({ terminalReason: "path_violation" });
	});

	it("validates an exact clean commit without child ignored output and excludes all ignored output", async () => {
		const { handle } = await managedWorktree();
		await writeFile(join(handle.path, "owned", "result.txt"), "result\n");
		for (const path of ["target/.rustc_info.json", "node_modules/poison.js", "dist/asset.js"]) {
			await mkdir(dirname(join(handle.path, path)), { recursive: true });
			await writeFile(join(handle.path, path), "child-only output\n");
		}
		const registry = new ValidationRegistry([
			command(
				"clean",
				[
					"const fs=require('node:fs');",
					"for(const p of ['target/.rustc_info.json','node_modules/poison.js','dist/asset.js']) if(fs.existsSync(p)) process.exit(2);",
					"if(fs.readFileSync('owned/result.txt','utf8')!=='result\\n') process.exit(3);",
					"fs.mkdirSync('target',{recursive:true}); fs.writeFileSync('target/validation-output','ok');",
				].join(" "),
			),
		]);
		const artifact = await validateAndCommitWriterTask({
			handle,
			task: writerTask(["clean"]),
			handoff: handoff(["owned/result.txt"]),
			registry,
		});

		expect(artifact.validations).toMatchObject([{ commandId: "clean", status: "passed" }]);
		for (const path of [
			"target/.rustc_info.json",
			"target/validation-output",
			"node_modules/poison.js",
			"dist/asset.js",
		]) {
			expect(
				await git(handle.path, "cat-file", "-e", `${artifact.commit}:${path}`).then(
					() => 0,
					() => 1,
				),
			).toBe(1);
		}
	});

	it.each(["core.excludesFile", "info/exclude"])(
		"does not let shared Git ignore policy from %s hide validation mutations",
		async (source) => {
			const { handle } = await managedWorktree();
			await writeFile(join(handle.path, "owned", "result.txt"), "child bytes\n");
			if (source === "core.excludesFile") {
				const excludesRoot = await mkdtemp(join(tmpdir(), "subagent-quality-excludes-"));
				temporaryPaths.push(excludesRoot);
				const excludesFile = join(excludesRoot, "excludes");
				await writeFile(excludesFile, "validation-outside.txt\n");
				await git(handle.path, "config", "--local", "core.excludesFile", excludesFile);
			} else {
				const output = await git(handle.path, "rev-parse", "--git-path", "info/exclude");
				const excludesFile = resolve(handle.path, output);
				await writeFile(excludesFile, `${await readFile(excludesFile, "utf8")}validation-outside.txt\n`);
			}
			await expect(
				validateAndCommitWriterTask({
					handle,
					task: writerTask(["hidden-mutation"]),
					handoff: handoff(["owned/result.txt"]),
					registry: new ValidationRegistry([
						command(
							"hidden-mutation",
							"require('node:fs').writeFileSync('validation-outside.txt','must be detected\\n')",
						),
					]),
				}),
			).rejects.toMatchObject({ terminalReason: "path_violation" });
		},
	);

	it("rejects a validation command that mutates bytes in the exact committed source", async () => {
		const { handle } = await managedWorktree();
		await writeFile(join(handle.path, "owned", "result.txt"), "child bytes\n");
		await expect(
			validateAndCommitWriterTask({
				handle,
				task: writerTask(["rewrite"]),
				handoff: handoff(["owned/result.txt"]),
				registry: new ValidationRegistry([
					command("rewrite", "require('node:fs').writeFileSync('owned/result.txt','validator bytes\\n')"),
				]),
			}),
		).rejects.toMatchObject({ terminalReason: "path_violation" });
	});

	it("rejects validation that commits its mutation and moves the exact input ref", async () => {
		const { handle } = await managedWorktree();
		await writeFile(join(handle.path, "owned", "result.txt"), "child bytes\n");
		const script = [
			"const fs=require('node:fs'),{spawnSync}=require('node:child_process');",
			"fs.writeFileSync('owned/result.txt','validator commit\\n');",
			"for(const args of [['add','owned/result.txt'],['commit','-m','validator mutation']]) { const r=spawnSync('git',args); if(r.status!==0) process.exit(r.status??1); }",
		].join(" ");
		await expect(
			validateAndCommitWriterTask({
				handle,
				task: writerTask(["commit-mutation"]),
				handoff: handoff(["owned/result.txt"]),
				registry: new ValidationRegistry([command("commit-mutation", script)]),
			}),
		).rejects.toMatchObject({ terminalReason: "path_violation" });
	});

	it("commits a nonempty exact owned diff and returns a content-addressed artifact", async () => {
		const { handle } = await managedWorktree();
		await writeFile(join(handle.path, "owned", "result.txt"), "result\n");
		const registry = new ValidationRegistry([
			command(
				"check",
				"const fs=require('node:fs'); if(fs.readFileSync('owned/result.txt','utf8')!=='result\\n') process.exit(2)",
			),
		]);
		const stages: string[] = [];
		const artifact = await validateAndCommitWriterTask({
			handle,
			task: writerTask(["check"]),
			handoff: handoff(["owned/result.txt"]),
			registry,
			onPerformance: (stage) => stages.push(stage),
		});

		expect(stages).toEqual(["writer_audit", "commit", "validation"]);
		expect(artifact).toMatchObject({
			artifactVersion: 2,
			taskId: "writer",
			contractHash: "c".repeat(64),
			changedPaths: ["owned/result.txt"],
			validations: [{ commandId: "check", status: "passed" }],
			quality: {
				semanticOutcome: "accepted",
				pathAudit: "passed",
				validation: { status: "passed", passedCommandIds: ["check"] },
				review: { status: "not_applicable" },
			},
		});
		expect(artifact.handoff).toMatchObject({ changedPaths: ["owned/result.txt"] });
		expect(artifact.commit).toMatch(/^[a-f0-9]{40,64}$/);
		expect(await git(handle.path, "rev-parse", "HEAD")).toBe(artifact.commit);
		expect(await readFile(join(handle.path, "owned", "result.txt"), "utf8")).toBe("result\n");
		expect(artifact.artifactId).toMatch(/^[a-f0-9]{64}$/);
	});

	it("marks a committed writer artifact without trusted validation as unvalidated", async () => {
		const { handle } = await managedWorktree();
		await writeFile(join(handle.path, "owned", "result.txt"), "result\n");
		const artifact = await validateAndCommitWriterTask({
			handle,
			task: writerTask(),
			handoff: handoff(["owned/result.txt"]),
			registry: new ValidationRegistry([]),
		});

		expect(artifact.quality).toEqual({
			semanticOutcome: "accepted",
			pathAudit: "passed",
			validation: { status: "not_run", passedCommandIds: [] },
			review: { status: "not_applicable" },
		});
	});
});
