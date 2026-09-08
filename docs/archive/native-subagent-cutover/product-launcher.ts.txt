import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChildPiInvocation } from "@easy-pi/subagent/process-runner";
import { isBunBinary, isBunRuntime } from "../config.ts";

/** Launch this product, never an embedding application's argv[1] or a PATH-installed Pi. */
export function resolveEasyPiInvocation(): ChildPiInvocation {
	if (isBunBinary) return { command: process.execPath, args: [] };
	const source = import.meta.url.endsWith(".ts");
	const entry = fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url));
	if (!existsSync(entry)) throw new Error(`easy-pi child entrypoint is missing: ${entry}`);
	const prefix = source && !isBunRuntime ? ["--import", import.meta.resolve("tsx")] : [];
	return { command: process.execPath, args: [...prefix, entry] };
}
