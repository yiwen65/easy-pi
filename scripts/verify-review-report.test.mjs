import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./verify-review-report.mjs", import.meta.url));

function run(reportText, extraArgs = []) {
	const directory = mkdtempSync(join(tmpdir(), "epi-verify-report-"));
	try {
		const reportPath = join(directory, "report.md");
		writeFileSync(reportPath, reportText);
		return spawnSync(process.execPath, [script, reportPath, ...extraArgs], { encoding: "utf8", timeout: 120_000 });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const REAL_FILE = "packages/agent/src/harness/env/background-task-manager.ts";

test("real symbols and line references verify cleanly", () => {
	const result = run(
		[
			"### Background task manager exists",
			`- Location: ${REAL_FILE}:100`,
			"- The class `BackgroundTaskManager` owns background tasks.",
		].join("\n"),
		["--strict"],
	);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.match(result.stdout, /SYMBOL_OK\s+`BackgroundTaskManager`/);
	assert.match(result.stdout, /LINE_OK\s+packages\/agent\/src\/harness\/env\/background-task-manager\.ts:100/);
	assert.match(result.stdout, /2 verified, 0 suspect/);
});

test("confabulated symbol is flagged NEVER_EXISTED and fails --strict", () => {
	// A fixed fixture enters Git history when this test is committed. Use a
	// fresh identifier so the negative case remains valid after publication.
	const symbol = `missing_${randomUUID().replaceAll("-", "")}`;
	const result = run(
		["### Fabricated finding", `- Location: ${REAL_FILE}:10`, `- \`${symbol}\` skips draining.`].join("\n"),
		["--strict"],
	);
	assert.equal(result.status, 1, result.stdout);
	assert.match(result.stdout, new RegExp("NEVER_EXISTED\\s+`" + symbol + "`"));
});

test("prose camelCase symbols are checked against the finding's files", () => {
	const result = run(
		[
			"### Mixed finding",
			`- Location: ${REAL_FILE}:10`,
			"- manageForRun skips draining; BackgroundTaskManager still works.",
		].join("\n"),
	);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /PROSE_NOT_FOUND manageForRun/);
	assert.match(result.stdout, /PROSE_OK\s+BackgroundTaskManager/);
});

test("missing files and out-of-range lines are flagged", () => {
	const result = run(
		[
			"### Bad references",
			"- Location: packages/agent/src/no-such-file.ts:5",
			`- Location: ${REAL_FILE}:999999`,
		].join("\n"),
	);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /FILE_MISSING\s+packages\/agent\/src\/no-such-file\.ts:5/);
	assert.match(result.stdout, /LINE_RANGE\s+packages\/agent\/src\/harness\/env\/background-task-manager\.ts:999999/);
	assert.match(result.stdout, /0 verified, 2 suspect/);
});
