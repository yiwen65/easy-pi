import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectControlledSdk, loadControlledSdk } from "../loader.ts";

test("P03 inspection rejects relative paths and drift before running upstream code", (t) => {
	assert.throws(() => inspectControlledSdk("relative"), /must be absolute/);
	const directory = mkdtempSync(join(tmpdir(), "computer-controlled-loader-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(join(directory, "dist/native"), { recursive: true });
	writeFileSync(join(directory, "package.json"), '{"type":"module"}');
	writeFileSync(join(directory, "dist/index.js"), 'throw new Error("UNAPPROVED_JS_EXECUTED")');
	writeFileSync(join(directory, "dist/index.d.ts"), "export {};");
	assert.throws(() => inspectControlledSdk(directory), /integrity mismatch/);
});

test("P03 platform guard rejects before SDK resolution", (t) => {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	t.after(() => Object.defineProperty(process, "platform", descriptor));
	Object.defineProperty(process, "platform", { value: "unsupported", configurable: true });
	assert.throws(() => loadControlledSdk("not-absolute"), /requires Node .* on darwin\/arm64/);
});

test(
	"opt-in P03 generated API loads and exits naturally without a host",
	{
		skip: process.env.ALLOW_NATIVE_LOAD_TESTS !== "true",
	},
	(t) => {
		assert.equal(process.env.ALLOW_GUI_TESTS, "false");
		assert.equal(process.env.ALLOW_REAL_APIS, "false");
		const sdkDirectory = process.env.CUA_DRIVER_TYPESCRIPT_DIR;
		assert.ok(sdkDirectory, "CUA_DRIVER_TYPESCRIPT_DIR must identify the reviewed P03 SDK");
		const directory = mkdtempSync(join(tmpdir(), "computer-controlled-load-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		mkdirSync(join(directory, "home"));
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("../probe-load.mjs", import.meta.url)), sdkDirectory],
			{
				cwd: directory,
				encoding: "utf8",
				timeout: 30_000,
				env: {
					PATH: dirname(process.execPath),
					HOME: join(directory, "home"),
					TMPDIR: directory,
					ALLOW_NATIVE_LOAD_TESTS: "true",
					ALLOW_GUI_TESTS: "false",
					ALLOW_REAL_APIS: "false",
				},
			},
		);
		// A timed-out diagnostic fails; process death is never a native drain receipt.
		assert.equal(result.error, undefined);
		assert.equal(result.signal, null);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /controlled-sdk-loaded; event-loop-turn; no-host-or-permission-call/);
	},
);
