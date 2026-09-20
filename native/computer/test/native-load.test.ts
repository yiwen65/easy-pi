import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";

test("opt-in pinned SDK import, event-loop turn and natural process exit (no driver)", { skip: !enabled }, (t) => {
	assert.equal(process.env.ALLOW_GUI_TESTS, "false");
	assert.equal(process.env.ALLOW_REAL_APIS, "false");
	const sdkDirectory = process.env.CUA_DRIVER_TYPESCRIPT_DIR;
	assert.ok(sdkDirectory, "CUA_DRIVER_TYPESCRIPT_DIR must point to the reviewed emitted SDK");
	const temp = mkdtempSync(join(tmpdir(), "computer-native-load-"));
	t.after(() => rmSync(temp, { recursive: true, force: true }));
	mkdirSync(join(temp, "home"));
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("../scripts/probe-load.mjs", import.meta.url)), sdkDirectory],
		{
			cwd: temp,
			encoding: "utf8",
			timeout: 30_000,
			env: {
				PATH: dirname(process.execPath),
				HOME: join(temp, "home"),
				TMPDIR: temp,
				ALLOW_NATIVE_LOAD_TESTS: "true",
				ALLOW_GUI_TESTS: "false",
				ALLOW_REAL_APIS: "false",
			},
		},
	);
	// Killing a timed-out diagnostic is a failed test, never native cancellation evidence.
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /pinned-sdk-initialized; event-loop-responsive; no-driver-method-invoked/);
});
