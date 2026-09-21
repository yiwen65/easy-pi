import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Substituted only by the packager after verifying matched qualified materials.
declare const COMPUTER_RENDERER_SHA256: string;
export const installedRendererSha256 =
	typeof COMPUTER_RENDERER_SHA256 === "undefined" ? undefined : COMPUTER_RENDERER_SHA256;

export function inspectRendererHelper(installation: string, expected: string | undefined): string {
	if (!isAbsolute(installation) || !expected || !/^[a-f0-9]{64}$/.test(expected))
		throw new Error("Computer renderer has no verified installed helper hash");
	// Canonicalize the installation ancestor (/tmp -> /private/tmp), then reject every internal link.
	const root = realpathSync(installation);
	const directory = join(root, "renderer");
	const helper = join(directory, "computer-renderer");
	try {
		if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
			throw new Error("unsafe directory");
		const stat = lstatSync(helper);
		if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111) || stat.size > 64 * 1024 * 1024)
			throw new Error("unsafe executable");
		if (createHash("sha256").update(readFileSync(helper)).digest("hex") !== expected)
			throw new Error("hash mismatch");
		return helper;
	} catch (cause) {
		throw new Error("Computer renderer helper is missing, unsafe or mismatched; refusing native ownership", {
			cause,
		});
	}
}
