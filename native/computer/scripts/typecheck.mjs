import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPinnedSdk } from "../loader.ts";

const sdkDirectory = process.argv[2];
if (!sdkDirectory) throw new Error("Usage: node native/computer/scripts/typecheck.mjs /absolute/sdk/typescript");
inspectPinnedSdk(sdkDirectory); // Static verification only; do not load the SDK for type checking.
const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(directory, "../..");
const temp = mkdtempSync(join(tmpdir(), "computer-typecheck-"));
try {
	const config = join(temp, "tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				noEmit: true,
				allowJs: true,
				checkJs: true,
				strict: true,
				noUncheckedIndexedAccess: true,
				exactOptionalPropertyTypes: true,
				skipLibCheck: true,
				resolveJsonModule: true,
				allowImportingTsExtensions: true,
				verbatimModuleSyntax: true,
				erasableSyntaxOnly: true,
				types: ["node"],
				typeRoots: [join(root, "node_modules/@types")],
				paths: { "@trycua/cua-driver": [join(sdkDirectory, "dist/index.d.ts")] },
			},
			include: [
				join(directory, "*.ts"),
				join(directory, "test/*.ts"),
				join(directory, "scripts/*.ts"),
				join(directory, "scripts/probe-load.mjs"),
			],
		}),
	);
	const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", config], {
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(temp, { recursive: true, force: true });
}
