import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// These child invocations must reject before optional SDK lookup, TCC or AppKit.
for (const flags of [
	{},
	{ ALLOW_GUI_TESTS: "false", ALLOW_REAL_APIS: "false" },
	{ ALLOW_GUI_TESTS: "true", ALLOW_REAL_APIS: "true" },
	{ ALLOW_GUI_TESTS: "true" },
]) {
	test(`GUI probe rejects missing/unsafe opt-in before SDK lookup: ${JSON.stringify(flags)}`, (t) => {
		const temp = mkdtempSync(join(tmpdir(), "computer-gui-gate-"));
		t.after(() => rmSync(temp, { recursive: true, force: true }));
		const result = spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("../scripts/probe-gui.ts", import.meta.url)),
				join(temp, "absent-sdk"),
				join(temp, "absent-manifest"),
				"raw",
				"1",
				"1",
				"guard",
			],
			{ cwd: temp, env: { HOME: temp, TMPDIR: temp, ...flags }, encoding: "utf8", timeout: 10_000 },
		);
		assert.equal(result.error, undefined);
		assert.equal(result.signal, null);
		assert.equal(result.status, 1, result.stderr);
		const lines = result.stdout.trim().split("\n");
		assert.equal(lines.length, 1);
		const record: unknown = JSON.parse(lines[0]!);
		assert.ok(typeof record === "object" && record !== null);
		assert.equal(Reflect.get(record, "event"), "failed");
		assert.equal(Reflect.get(record, "category"), "opt_in_required");
		assert.equal(Reflect.get(record, "osTerminalProven"), false);
	});
}
