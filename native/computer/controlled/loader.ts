import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CuaSdk from "@trycua/cua-driver";
import { verifyInputTree } from "../integrity.ts";
import pins from "./pinned-inputs.json" with { type: "json" };

type Sdk = typeof CuaSdk;

/** Independently rebuilt controlled inputs; historical P02/P03 evidence is immutable. Static checks only. */
export function inspectControlledSdk(sdkDirectory: string): { entry: string } {
	if (!isAbsolute(sdkDirectory)) throw new Error("Controlled SDK directory must be absolute");
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
	const platformPackage = realpathSync(require.resolve("@trycua/cua-driver-darwin-arm64/package.json"));
	verifyInputTree(dirname(platformPackage), pins.platformFiles);
	return { entry };
}

/**
 * Load-only boundary. No host constructor, desktop lease, TCC request or driver operation.
 * Requires stable trusted inputs and a fresh process without loader hooks, as in P02.
 */
export function loadControlledSdk(sdkDirectory: string): Sdk {
	if (
		process.platform !== pins.platform ||
		process.arch !== pins.arch ||
		process.versions.node !== pins.nodeVersion ||
		process.versions.bun !== undefined
	) {
		throw new Error(`Controlled SDK requires Node ${pins.nodeVersion} on ${pins.platform}/${pins.arch}`);
	}
	const { entry } = inspectControlledSdk(sdkDirectory);
	const sdk = createRequire(pathToFileURL(entry))(entry) as Sdk;
	if (
		typeof sdk.ComputerHost?.create !== "function" ||
		typeof sdk.ComputerHost.instanceOf !== "function" ||
		typeof sdk.ComputerHost.prototype.close !== "function" ||
		typeof sdk.ComputerHost.prototype.uniffiDestroy !== "function" ||
		typeof sdk.ComputerSession?.prototype.newOperation !== "function" ||
		typeof sdk.ComputerSession.prototype.revoke !== "function" ||
		typeof sdk.ComputerOperation?.prototype.startObserve !== "function" ||
		typeof sdk.ComputerOperation.prototype.startClick !== "function" ||
		typeof sdk.ComputerOperation.prototype.startPlan !== "function" ||
		typeof sdk.ComputerAddress?.Ref !== "function" ||
		typeof sdk.ComputerStep?.Fill !== "function" ||
		typeof sdk.ComputerResult?.Plan !== "function" ||
		typeof sdk.ComputerOperation.prototype.terminal !== "function"
	) {
		throw new Error("Controlled SDK ownership API mismatch");
	}
	return sdk;
}
