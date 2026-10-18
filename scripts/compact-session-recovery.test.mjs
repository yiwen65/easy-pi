import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const resolver = fileURLToPath(new URL("./source-resolver.mjs", import.meta.url));
const cli = fileURLToPath(new URL("./compact-session-recovery.mjs", import.meta.url));
function run(...args) {
	return spawnSync(process.execPath, ["--import", resolver, cli, ...args], {
		cwd: root, encoding: "utf8", timeout: 30000,
	});
}
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "epi-recovery-copy-cli-"));
	const source = join(dir, "source.jsonl");
	const header = { type: "session", version: 3, id: "same-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir };
	const entries = [header];
	for (let index = 0; index < 8; index++) {
		entries.push({
			type: "custom", customType: "pi-task-recovery", id: `r${index}`,
			parentId: index ? `r${index - 1}` : null, timestamp: header.timestamp,
			data: {
				version: 2, id: "task", status: "interrupted", sourceLeafId: null,
				prompt: [{ role: "user", content: "private-fixture".repeat(3000), timestamp: 1 }],
				promptEntryIds: ["input"], queued: [], systemPrompt: "system".repeat(3000),
				retryAttempt: index, tools: [], suspendedTasks: [],
			},
		});
	}
	const bytes = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
	writeFileSync(source, bytes);
	return { dir, source, bytes, entries };
}

test("copies compact history only after logical verification, preserves the source and refuses overwrite", () => {
	const f = fixture();
	try {
		const output = join(f.dir, "copied", "compact.jsonl");
		const first = run(f.source, output);
		assert.equal(first.status, 0, first.stderr);
		const report = JSON.parse(first.stdout);
		assert.equal(report.verified, true);
		assert.equal(report.entries, 8);
		assert.ok(report.outputBytes < report.sourceBytes / 4);
		assert.equal(readFileSync(f.source, "utf8"), f.bytes);
		const copy = readFileSync(output, "utf8");
		assert.deepEqual(JSON.parse(copy.split("\n")[0]), f.entries[0]);
		assert.match(copy, /"recoveryStorage"/);
		assert.equal(first.stdout.includes("private-fixture"), false);
		assert.deepEqual(readdirSync(dirname(output)), ["compact.jsonl"]);
		const repeated = run(f.source, output);
		assert.equal(repeated.status, 1);
		assert.match(repeated.stderr, /already exists/);
		assert.equal(readFileSync(output, "utf8"), copy);
		const secondOutput = join(f.dir, "second.jsonl");
		const second = run(output, secondOutput);
		assert.equal(second.status, 0, second.stderr);
		assert.equal(JSON.parse(second.stdout).verified, true);
		assert.equal(readFileSync(secondOutput, "utf8"), copy);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("refuses in-place compaction and dangling output links", () => {
	const f = fixture();
	try {
		const same = run(f.source, f.source);
		assert.equal(same.status, 1);
		assert.match(same.stderr, /in-place/);
		const output = join(f.dir, "link.jsonl");
		symlinkSync(join(f.dir, "absent.jsonl"), output);
		const linked = run(f.source, output);
		assert.equal(linked.status, 1);
		assert.match(linked.stderr, /already exists/);
		assert.equal(readFileSync(f.source, "utf8"), f.bytes);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("rejects damaged history without publishing output or leaking content", () => {
	const f = fixture();
	try {
		const damaged = `${f.bytes}{"private-fixture":`;
		writeFileSync(f.source, damaged);
		const output = join(f.dir, "output.jsonl");
		const result = run(f.source, output);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /damaged tail/);
		assert.equal(result.stderr.includes("private-fixture"), false);
		assert.deepEqual(readdirSync(f.dir), ["source.jsonl"]);
		assert.equal(readFileSync(f.source, "utf8"), damaged);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("syncs final publication after removing the staging hard link", () => {
	const f = fixture();
	try {
		const probe = join(f.dir, "publication.mjs");
		writeFileSync(probe, [
			'import assert from "node:assert/strict";',
			'import fs from "node:fs";',
			'import { syncBuiltinESMExports } from "node:module";',
			`import { compactSessionRecovery } from ${JSON.stringify(new URL("./compact-session-recovery.mjs", import.meta.url).href)};`,
			'const events = []; const sync = fs.fsyncSync; const unlink = fs.unlinkSync;',
			'fs.fsyncSync = (fd) => { if (fs.fstatSync(fd).isDirectory()) events.push("directory-sync"); return sync(fd); };',
			'fs.unlinkSync = (path) => { if (String(path).endsWith(".recovery-copy")) events.push("staging-unlink"); return unlink(path); };',
			'syncBuiltinESMExports();',
			`compactSessionRecovery(${JSON.stringify(f.source)}, ${JSON.stringify(join(f.dir, "output.jsonl"))});`,
			'assert.ok(events.indexOf("staging-unlink") >= 0);',
			'assert.ok(events.lastIndexOf("directory-sync") > events.indexOf("staging-unlink"), JSON.stringify(events));',
		].join("\n"));
		const result = spawnSync(process.execPath, ["--import", resolver, probe], { cwd: root, encoding: "utf8", timeout: 30000 });
		assert.equal(result.status, 0, result.stderr);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("help and invalid usage do not create files", () => {
	const help = run("--help");
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /never replaces the source/);
	const invalid = run();
	assert.equal(invalid.status, 2);
	assert.match(invalid.stderr, /Usage:/);
});
