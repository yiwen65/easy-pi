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
		["libcua_driver_sdk.dylib", "574acada8fd701ca5351e61abc7548ae515400dbedbc81d602afaeb3bcd675c1"],
		["cua_driver_node_runtime.node", "2e13bfdb600b24dca7a03d9cdd295aedd857ea2f72a48ebab10f2e4954b8e423"],
	] as const)
		assert.equal(
			createHash("sha256")
				.update(readFileSync(join(directory, "node_modules/@trycua/cua-driver-darwin-arm64", name)))
				.digest("hex"),
			hash,
		);
	return createRequire(import.meta.url)(join(directory, "dist/computer.js")) as typeof CuaSdk;
}
