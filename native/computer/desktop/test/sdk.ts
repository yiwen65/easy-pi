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
		["libcua_driver_sdk.dylib", "8f5fd2b42d02f7ab8f3ecf987216561dddfa684a54615293f01f6aedc4370a83"],
		["cua_driver_node_runtime.node", "20ffed5caccef6c44eff6ef9d39c127d49d9783b16e4aa9f0be0dfa3ba887056"],
	] as const)
		assert.equal(
			createHash("sha256")
				.update(readFileSync(join(directory, "node_modules/@trycua/cua-driver-darwin-arm64", name)))
				.digest("hex"),
			hash,
		);
	return createRequire(import.meta.url)(join(directory, "dist/computer.js")) as typeof CuaSdk;
}
