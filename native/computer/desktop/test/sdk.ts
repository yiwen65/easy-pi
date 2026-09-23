import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import type * as CuaSdk from "@trycua/cua-driver";

/** Explicit no-host candidate value tests. This is never the production loader. */
export function candidateSdk(): typeof CuaSdk {
	assert.equal(process.env.ALLOW_NATIVE_LOAD_TESTS, "true");
	assert.equal(process.env.ALLOW_GUI_TESTS, "false");
	assert.equal(process.env.ALLOW_REAL_APIS, "false");
	const directory = process.env.CUA_DRIVER_TYPESCRIPT_DIR;
	assert.ok(directory && isAbsolute(directory));
	for (const [name, hash] of [
		["libcua_driver_sdk.dylib", "5e9e117fd3c51d9b6a9f5f13dd15f53335c158dd59e8f1d211a043ac221e5877"],
		["cua_driver_node_runtime.node", "faef6d22de08075ca345939f495d24561e27d633bfc674c09ca9a2c20e53c8f4"],
	] as const)
		assert.equal(
			createHash("sha256")
				.update(readFileSync(join(directory, "node_modules/@trycua/cua-driver-darwin-arm64", name)))
				.digest("hex"),
			hash,
		);
	return createRequire(import.meta.url)(join(directory, "dist/computer.js")) as typeof CuaSdk;
}
