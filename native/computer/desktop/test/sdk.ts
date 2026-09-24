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
		["libcua_driver_sdk.dylib", "6d5cec7ecd18a5729d61a7571ba7919ce2969ac233e68750c65d33e5c6c5f9f9"],
		["cua_driver_node_runtime.node", "da7c4a8ef6b666518c6ca9278e8065334872817750611c9337c553291aee48f4"],
	] as const)
		assert.equal(
			createHash("sha256")
				.update(readFileSync(join(directory, "node_modules/@trycua/cua-driver-darwin-arm64", name)))
				.digest("hex"),
			hash,
		);
	return createRequire(import.meta.url)(join(directory, "dist/computer.js")) as typeof CuaSdk;
}
