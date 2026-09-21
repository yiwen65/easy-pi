import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CuaSdk from "@trycua/cua-driver";
import { verifyInputTree } from "../integrity.ts";
import pins from "./pinned-inputs.json" with { type: "json" };

/** Qualified P06 fast profile, still optional; historical P04 loaders/pins remain separate. */
export function inspectDesktopSdk(sdkDirectory: string): { entry: string } {
	if (!isAbsolute(sdkDirectory)) throw new Error("Desktop SDK directory must be absolute");
	const root = realpathSync(sdkDirectory);
	verifyInputTree(root, pins.sdk);
	const entry = join(root, "dist/computer.js");
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

export function loadDesktopSdk(sdkDirectory: string): typeof CuaSdk {
	if (
		process.platform !== pins.platform ||
		process.arch !== pins.arch ||
		process.versions.node !== pins.nodeVersion ||
		process.versions.bun !== undefined
	)
		throw new Error(`Desktop SDK requires Node ${pins.nodeVersion} on ${pins.platform}/${pins.arch}`);
	const { entry } = inspectDesktopSdk(sdkDirectory);
	const sdk = createRequire(pathToFileURL(entry))(entry) as typeof CuaSdk;
	if (
		typeof sdk.ComputerHost?.createWithRenderer !== "function" ||
		typeof sdk.ComputerHost.prototype.rendererStatus !== "function" ||
		typeof sdk.ComputerRendererConfig?.Required !== "function" ||
		typeof sdk.ComputerRendererStatus?.EmergencyStopped !== "function" ||
		typeof sdk.ComputerHost.prototype.openDiscoverySession !== "function" ||
		typeof sdk.ComputerOperation?.prototype.startListWindows !== "function" ||
		typeof sdk.ComputerOperation.prototype.startSelectWindow !== "function" ||
		typeof sdk.ComputerOperation.prototype.startCapture !== "function" ||
		typeof sdk.ComputerOperation.prototype.startImageClick !== "function" ||
		typeof sdk.ComputerOperation.prototype.startImageScroll !== "function" ||
		typeof sdk.ComputerOperation.prototype.startImageKey !== "function" ||
		typeof sdk.ComputerOperation.prototype.terminal !== "function" ||
		typeof sdk.ComputerResult?.WindowSelected !== "function"
	)
		throw new Error("Desktop SDK ownership API mismatch");
	return sdk;
}
