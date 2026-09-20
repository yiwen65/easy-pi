import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CuaSdk from "@trycua/cua-driver";
import { NativeComputerAdapter } from "./adapter.ts";
import { verifyInputTree } from "./integrity.ts";
import pins from "./pinned-inputs.json" with { type: "json" };

type Sdk = typeof CuaSdk;
export type NativeHostConfiguration = Parameters<Sdk["CuaDriver"]["createConfiguredWithHostIntegrations"]>;

/** Static file verification only: no require/import of upstream JavaScript or native libraries. */
export function inspectPinnedSdk(sdkDirectory: string): { entry: string } {
	if (!isAbsolute(sdkDirectory)) throw new Error("Native SDK directory must be absolute");
	const root = realpathSync(sdkDirectory);
	verifyInputTree(root, pins.sdk);
	const entry = join(root, "dist/index.js");
	// Match the generated FFI modules' resolution context, not the embedding application's.
	const require = createRequire(pathToFileURL(join(root, "dist/native/node-runtime.js")));
	const coreEntry = realpathSync(require.resolve("@ubjs/core"));
	const coreRoot = dirname(dirname(dirname(coreEntry)));
	if (coreEntry !== join(coreRoot, "dist/cjs/index.js")) throw new Error("Unexpected @ubjs/core layout");
	verifyInputTree(coreRoot, pins.core);
	const nodeEntry = realpathSync(require.resolve("@ubjs/node/typescript/dist/resolve-lib.js"));
	verifyInputTree(dirname(dirname(dirname(nodeEntry))), pins.node);
	const platformPackage = realpathSync(require.resolve("@trycua/cua-driver-darwin-arm64/package.json"));
	verifyInputTree(dirname(platformPackage), pins.platformFiles);
	return { entry };
}

/**
 * Explicit native-load boundary. Imports initialize UniFFI checksums and callback vtables,
 * but this function never creates a driver or probes TCC. Use a fresh, trusted process.
 * Hash checks detect drift; they are not protection against loader hooks or concurrent writes.
 */
export function loadPinnedSdk(sdkDirectory: string): Sdk {
	if (
		process.platform !== pins.platform ||
		process.arch !== pins.arch ||
		process.versions.node !== pins.nodeVersion ||
		process.versions.bun !== undefined
	) {
		throw new Error(`Native baseline requires Node ${pins.nodeVersion} on ${pins.platform}/${pins.arch}`);
	}
	const { entry } = inspectPinnedSdk(sdkDirectory);
	// The pinned SDK has no package "require" export. Node 24 loads its absolute ESM entry.
	const sdk = createRequire(pathToFileURL(entry))(entry) as Sdk;
	if (
		typeof sdk.CuaDriver?.createConfiguredWithHostIntegrations !== "function" ||
		typeof sdk.CuaDriver.instanceOf !== "function" ||
		typeof sdk.CuaDriver.prototype.shutdown !== "function" ||
		typeof sdk.CuaDriver.prototype.uniffiDestroy !== "function"
	) {
		throw new Error("Native SDK owner API mismatch");
	}
	return sdk;
}

/**
 * Trusted-host-only construction. No defaults, auto-approval callback, TCC probing or fallback.
 * Constructing the adapter does not load native code. open/observe/click do create a desktop
 * driver and therefore require a separately qualified GUI host (not authorized by load tests).
 */
export function createPinnedNativeComputer(
	sdkDirectory: string,
	...configuration: NativeHostConfiguration
): NativeComputerAdapter {
	return new NativeComputerAdapter(() => {
		const sdk = loadPinnedSdk(sdkDirectory);
		const driver = sdk.CuaDriver.createConfiguredWithHostIntegrations(...configuration);
		return {
			driver,
			destroy: () => {
				if (!sdk.CuaDriver.instanceOf(driver)) throw new Error("Native SDK returned a non-owned driver");
				driver.uniffiDestroy();
			},
		};
	});
}
