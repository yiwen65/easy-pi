import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = mkdtempSync(join(tmpdir(), "easy-pi-product-build-"));
try {
	// Compile the product modules together: their type-only extension API cycle
	// must not depend on declarations left over from an earlier coding-agent build.
	execFileSync(process.execPath, [
		resolve(root, "node_modules/@typescript/native-preview/bin/tsgo.js"),
		"-p", resolve(root, "packages/coding-agent/tsconfig.product-build.json"),
		"--outDir", output,
	], { cwd: root, stdio: "inherit" });
	// Fail before touching installed artifacts if a legacy dependency re-enters
	// the compiler's transitive graph. Package exports alone cannot stop bundling.
	const nativeModules = new Set([
		"index", "collaboration-contract", "collaboration-controller",
		"collaboration-mailbox", "collaboration-store", "context-fork", "session-host",
	]);
	for (const file of readdirSync(join(output, "subagent/src"))) {
		if (!nativeModules.has(file.replace(/\.(?:js|d\.ts)(?:\.map)?$/, ""))) {
			throw new Error(`Unexpected Subagent product artifact: ${file}`);
		}
	}
	for (const name of ["permissions", "subagent", "coding-agent"]) {
		const destination = join(root, "packages", name, "dist");
		rmSync(destination, { recursive: true, force: true });
		cpSync(join(output, name, "src"), destination, { recursive: true });
	}
	// npm pack omits hoisted workspace symlinks, even for bundleDependencies.
	// Materialize only these private, compiled packages under the product.
	for (const name of ["permissions", "subagent"]) {
		const destination = join(root, "packages/coding-agent/node_modules/@easy-pi", name);
		rmSync(destination, { recursive: true, force: true });
		mkdirSync(destination, { recursive: true });
		cpSync(join(root, "packages", name, "package.json"), join(destination, "package.json"));
		cpSync(join(root, "packages", name, "dist"), join(destination, "dist"), { recursive: true });
	}
} finally {
	rmSync(output, { recursive: true, force: true });
}
