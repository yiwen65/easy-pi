import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectBrowserSdk } from "../loader.ts";

const sdk = process.argv[2];
if (!sdk) throw new Error("An absolute, verified SDK directory is required");
inspectBrowserSdk(sdk);
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../../..");
const config = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "computer-sdk-integration-types-"));
try {
	// Apply the existing repository compiler contract to its entire graph plus optional native composition.
	// The adapter, model schema and projection also retain the separate stricter generated-boundary gate.
	const paths = Object.fromEntries(
		Object.entries(config.compilerOptions.paths).map(([key, values]) => [
			key,
			values.map((value) => resolve(root, value)),
		]),
	);
	paths["@trycua/cua-driver"] = [join(sdk, "dist/index.d.ts")];
	const output = join(temporary, "tsconfig.json");
	writeFileSync(
		output,
		JSON.stringify({
			extends: join(root, "tsconfig.json"),
			compilerOptions: { paths, typeRoots: [join(root, "node_modules/@types")] },
			include: [
				...config.include.map((value) => resolve(root, value)),
				join(directory, "*.ts"),
				join(directory, "../binding.ts"),
			],
			exclude: config.exclude.map((value) => resolve(root, value)),
		}),
	);
	const result = spawnSync(join(root, "node_modules/.bin/tsgo"), ["--noEmit", "-p", output], { stdio: "inherit" });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
