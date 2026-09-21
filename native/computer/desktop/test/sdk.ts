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
		["libcua_driver_sdk.dylib", "795a398efe6e53a840ffde74e39ac83b196efa5c53302632b479eb9ec0294524"],
		["cua_driver_node_runtime.node", "7c6940def595178b219371a341712d1d5346a2ffad195c11489879e08b2f6167"],
	] as const)
		assert.equal(
			createHash("sha256")
				.update(readFileSync(join(directory, "node_modules/@trycua/cua-driver-darwin-arm64", name)))
				.digest("hex"),
			hash,
		);
	return createRequire(import.meta.url)(join(directory, "dist/computer.js")) as typeof CuaSdk;
}
