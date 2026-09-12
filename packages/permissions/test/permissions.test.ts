import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createExternalMutationJournal } from "../src/external-mutation-journal.ts";
import {
	assessBash,
	canonicalizeProspectivePath,
	createChildHarnessContext,
	decidePermission,
	validateChildHarnessContext,
} from "../src/permissions.ts";

const cwd = "/tmp/wj-workspace";

function decision(toolName: string, input: Record<string, unknown>) {
	return decidePermission({ mode: "full-access", toolName, input, cwd, sessionGrants: new Set() });
}

test("Full Access allows routine writes, edits and non-write tools without prompts", () => {
	assert.equal(decision("write", { path: "a.ts" }).decision, "allow");
	assert.equal(decision("edit", { path: "a.ts" }).decision, "allow");
	assert.equal(decision("write", { path: join(homedir(), "wj-outside.txt"), content: "x" }).decision, "allow");
	assert.equal(decision("bash", { command: "git push origin main" }).decision, "allow");
	assert.equal(decision("deploy_widget", { target: "staging" }).decision, "allow");
	assert.equal(decision("subagent", { tasks: [{ id: "write", objective: "Implement" }] }).decision, "allow");
	assert.equal(decision("subagent", { operation: "inspect", runId: "run-1" }).decision, "allow");
});

test("catastrophic deletion refusals remain active in Full Access", () => {
	assert.equal(decision("bash", { command: "rm -rf /" }).decision, "deny");
	assert.equal(decision("bash", { command: "rm -rf ./*" }).decision, "deny");
	assert.equal(decision("bash", { command: "rm -rf *" }).decision, "deny");
	assert.equal(decision("bash", { command: "rm -rf $PWD/*" }).decision, "deny");
	assert.equal(decision("bash", { command: "rm -rf .." }).decision, "deny");
	assert.equal(decision("bash", { command: "find . -delete" }).decision, "deny");
	assert.equal(
		decision("bash", { command: 'find "$PWD" -depth -exec rmdir {} \\; -o -exec rm -f {} \\;' }).decision,
		"deny",
	);
	assert.equal(decision("bash", { command: "cd .. && rm -rf wj-workspace" }).decision, "deny");
	assert.equal(decision("bash", { command: "bash -c 'rm -rf $PWD'" }).decision, "deny");
	assert.equal(decision("bash", { command: "git clean -fdx" }).decision, "deny");
	assert.equal(decision("bash", { command: "git clean -fd -- ." }).decision, "deny");
	assert.equal(decision("bash", { command: "git -C . clean -fdx" }).decision, "deny");
	assert.equal(decision("bash", { command: "git clean -fdx -- ':(top)'" }).decision, "deny");
	assert.equal(decision("bash", { command: "git clean -fd -- generated" }).decision, "allow");
	assert.equal(decision("bash", { command: "git clean -ndx" }).decision, "allow");
	assert.equal(decision("bash", { command: "printenv" }).decision, "allow");
	assert.equal(decision("read", { path: ".env" }).decision, "allow");
	assert.equal(decision("read", { path: ".env.example" }).decision, "allow");
});

test("catastrophic deletion breaker ignores unresolved targets and non-executable shell text", () => {
	const allowed = [
		'find "$d" -type f -delete',
		'find "$d" -type f -exec rm -f {} +',
		"find / -type f -exec grep -l TODO {} +",
		"find / -name -delete -print",
		"find / -newermt -delete -print",
		"find -P ./cache -delete",
		"find -- ./cache -delete",
		"find '$PWD' -delete",
		"echo find / -delete",
		'echo "rm -rf /"',
		"printf '%s\\n' 'rm -rf /'",
		"cat <<'EOF'\nfind / -delete\nrm -rf /\nEOF",
		'rm -rf "$target"',
		"rm -rf '$PWD'",
		'git clean -fdx -- "$pathspec"',
	];
	for (const command of allowed) {
		assert.equal(decision("bash", { command }).decision, "allow", command);
	}

	const denied = [
		"command rm -rf /",
		"env rm -rf /",
		"sudo rm -rf /",
		">/tmp/wj-delete.log rm -rf /",
		"find / -type f -exec rm -f {} +",
		"git clean -fdx -- :/",
	];
	for (const command of denied) {
		assert.equal(decision("bash", { command }).decision, "deny", command);
	}
});

test("catastrophic deletion variable tracking cannot be poisoned by ordinary arguments or prefix assignments", () => {
	const commands = ['d=/; echo d=./generated; find "$d" -delete', 'd=/; d=./generated find "$d" -delete'];
	for (const command of commands) {
		assert.equal(decision("bash", { command }).decision, "deny", command);
	}
});

test("Full Access permits env-file consumption and direct environment reads", () => {
	const allowed = [
		"cd packages/app && node --env-file=../../.env ./run.mjs",
		"node --env-file=.env test/run.mjs",
		"node --env-file .env test/run.mjs",
		"node --env-file=.env test/run.mjs -p",
		"node --env-file=.env -- ./-p",
		"node --env-file=.env -- ./node_modules/vitest/dist/cli.js --run test/example.test.ts",
	];
	for (const command of allowed) {
		assert.equal(decision("bash", { command }).decision, "allow", command);
	}

	const directReads = [
		"cat .env",
		"source .env",
		"python --env-file=../.env task.py",
		"node --env-file=.env",
		"node --env-file=.env -p process.env.API_KEY",
		"node --env-file=.env --print process.env.API_KEY",
		"node --env-file=.env -e 'console.log(process.env.API_KEY)'",
		"node --env-file=.env --interactive",
	];
	for (const command of directReads) {
		assert.equal(decision("bash", { command }).decision, "allow", command);
	}
});

test("Full Access permits credential paths in direct, shell, and custom tools", () => {
	const credentialPaths = [
		join(homedir(), ".pi", "agent", "auth.json"),
		join(homedir(), ".easy-pi", "agent", "auth.json"),
		join(homedir(), ".kube", "config"),
		join(homedir(), ".docker", "config.json"),
	];
	for (const path of credentialPaths) {
		assert.equal(decision("read", { path }).decision, "allow");
		assert.equal(decision("bash", { command: `cat ${path}` }).decision, "allow");
	}
	assert.equal(decision("bash", { command: 'AUTH=$HOME/.pi/agent/auth.json; cat "$AUTH"' }).decision, "allow");
	assert.equal(decision("fetch_file", { target: join(homedir(), ".pi", "agent", "auth.json") }).decision, "allow");
	assert.equal(decision("fetch_file", { target: join(homedir(), ".aws", "credentials") }).decision, "allow");
	assert.equal(decision("write", { path: "notes.txt", content: "Mention .env safely" }).decision, "allow");
});

test("Full Access permits sensitive path reads and edits", () => {
	assert.equal(decision("read", { path: ".env" }).decision, "allow");
	assert.equal(
		decision("edit", { path: ".env", edits: [{ oldText: "PORT=3000", newText: "PORT=4000" }] }).decision,
		"allow",
	);
	assert.equal(decision("write", { path: ".env", content: "PORT=3000" }).decision, "allow");
});

test("Child WJ context preserves Parent decisions", () => {
	const childContext = createChildHarnessContext({
		cwd,
		permissionMode: "full-access",
		sessionGrants: ["existing-grant"],
		protectedRoots: [],
	});
	for (const [toolName, input] of [
		["bash", { command: "pwd" }],
		["subagent", { operation: "inspect", runId: "nested" }],
		["read", { path: "/tmp/shared/reference.ts" }],
		["write", { path: "/tmp/shared/output.ts", content: "x" }],
		["deploy_widget", { target: "staging" }],
	] as const) {
		const common = {
			mode: childContext.permissionMode,
			toolName,
			input,
			cwd: childContext.cwd,
			sessionGrants: new Set(childContext.sessionGrants),
		};
		const parent = decidePermission(common);
		const child = decidePermission({
			...common,
			protectedRoots: childContext.protectedRoots,
			inheritedWriteRoots: childContext.inheritedWriteRoots,
		});
		assert.deepEqual(child, parent, `${toolName} diverged between Parent and Child`);
	}
});

test("protected roots deny catastrophic deletion", () => {
	const sourceWorkspace = "/tmp/wj-source-workspace";
	const protectedDelete = decidePermission({
		mode: "full-access",
		toolName: "bash",
		input: { command: `rm -rf ${sourceWorkspace}` },
		cwd,
		sessionGrants: new Set(),
		protectedRoots: [sourceWorkspace],
	} as Parameters<typeof decidePermission>[0]);
	assert.equal(protectedDelete.decision, "deny");
});

test("Child Harness context validates the inherited WJ snapshot without delegated role or path policy", () => {
	const context = validateChildHarnessContext({
		schemaVersion: 2,
		cwd,
		permissionMode: "full-access",
		sessionGrants: ["grant-a", "grant-a"],
		protectedRoots: ["/tmp/wj-source"],
		inheritedWriteRoots: [],
	});
	assert.deepEqual(context, {
		schemaVersion: 2,
		cwd: canonicalizeProspectivePath(cwd, cwd),
		permissionMode: "full-access",
		sessionGrants: ["grant-a"],
		protectedRoots: [canonicalizeProspectivePath("/tmp/wj-source", cwd)],
		inheritedWriteRoots: [],
	});
	assert.equal("role" in context, false);
	assert.equal("readablePaths" in context, false);
	assert.equal("writablePaths" in context, false);
	assert.equal("externalWritablePaths" in context, false);
});

test("Child Harness external write grants require a non-overlapping private journal", async () => {
	assert.throws(
		() =>
			validateChildHarnessContext({
				schemaVersion: 2,
				cwd,
				permissionMode: "full-access",
				sessionGrants: [],
				protectedRoots: [],
				inheritedWriteRoots: ["/tmp/wj-external-output"],
			}),
		/require a private mutation journal/,
	);

	const journal = await createExternalMutationJournal({
		runId: "run-1",
		taskId: "publish",
		attemptId: "attempt-1",
		attemptNumber: 1,
	});
	try {
		assert.throws(
			() =>
				validateChildHarnessContext({
					schemaVersion: 2,
					cwd,
					permissionMode: "full-access",
					sessionGrants: [],
					protectedRoots: [],
					inheritedWriteRoots: [dirname(journal.policy.path)],
					mutationJournal: journal.policy,
				}),
			/overlap the private mutation journal/,
		);
	} finally {
		await journal.cleanup();
	}
});

test("catastrophic deletion resolves symlink and parent coverage", async () => {
	const root = await mkdtemp(join(tmpdir(), "wj-delete-"));
	try {
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		await symlink(workspace, join(root, "workspace-link"));
		assert.equal(
			assessBash(`rm -rf ${join(root, "workspace-link")}/*`, workspace).hardDenyReason !== undefined,
			true,
		);
		assert.equal(assessBash("rm -rf ../*", workspace).hardDenyReason !== undefined, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("prospective path canonicalization detects symlink escapes", async () => {
	const root = await mkdtemp(join(tmpdir(), "wj-path-"));
	try {
		await mkdir(join(root, "workspace"));
		await mkdir(join(root, "outside"));
		await mkdir(join(root, "other"));
		await symlink(join(root, "outside"), join(root, "workspace", "link"));
		await symlink(join(root, "other"), join(root, "outside", "escape"));
		const canonicalOutside = await realpath(join(root, "outside"));
		assert.equal(
			canonicalizeProspectivePath("link/new.ts", join(root, "workspace")),
			join(canonicalOutside, "new.ts"),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
