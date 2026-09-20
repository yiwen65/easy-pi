import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CuaSdk from "@trycua/cua-driver";
import { verifyInputTree } from "../integrity.ts";
import pins from "./pinned-inputs.json" with { type: "json" };

/** Static provenance checks only; accepted AppKit pins and loader are unchanged. */
export function inspectBrowserSdk(sdkDirectory: string): { entry: string } {
	if (!isAbsolute(sdkDirectory)) throw new Error("Browser SDK directory must be absolute");
	const root = realpathSync(sdkDirectory);
	verifyInputTree(root, pins.sdk);
	const entry = join(root, "dist/index.js");
	const require = createRequire(pathToFileURL(join(root, "dist/native/node-runtime.js")));
	const coreEntry = realpathSync(require.resolve("@ubjs/core"));
	const coreRoot = dirname(dirname(dirname(coreEntry)));
	if (coreEntry !== join(coreRoot, "dist/cjs/index.js")) throw new Error("Unexpected @ubjs/core layout");
	verifyInputTree(coreRoot, pins.core);
	const nodeEntry = realpathSync(require.resolve("@ubjs/node/typescript/dist/resolve-lib.js"));
	verifyInputTree(dirname(dirname(dirname(nodeEntry))), pins.node);
	const platform = realpathSync(require.resolve("@trycua/cua-driver-darwin-arm64/package.json"));
	verifyInputTree(dirname(platform), pins.platformFiles);
	return { entry };
}

/** Explicit experimental load-only boundary. Does not create a host, profile or GUI. */
export function loadBrowserSdk(sdkDirectory: string): typeof CuaSdk {
	if (
		process.platform !== pins.platform ||
		process.arch !== pins.arch ||
		process.versions.node !== pins.nodeVersion ||
		process.versions.bun !== undefined
	)
		throw new Error(`Browser SDK requires Node ${pins.nodeVersion} on ${pins.platform}/${pins.arch}`);
	const { entry } = inspectBrowserSdk(sdkDirectory);
	const sdk = createRequire(pathToFileURL(entry))(entry) as typeof CuaSdk;
	if (
		typeof sdk.ComputerHost?.create !== "function" ||
		typeof sdk.ComputerHost.prototype.openBrowserSession !== "function" ||
		sdk.ComputerHost.prototype.openBrowserSession.length !== 3 ||
		typeof sdk.ComputerOperation?.prototype.startPrepare !== "function" ||
		typeof sdk.ComputerOperation.prototype.startNavigate !== "function" ||
		typeof sdk.ComputerOperation.prototype.startPlan !== "function" ||
		typeof sdk.ComputerOperation.prototype.terminal !== "function" ||
		typeof sdk.ComputerResult?.BrowserPrepared !== "function"
	)
		throw new Error("Browser SDK ownership API mismatch");
	return sdk;
}
