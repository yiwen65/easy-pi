import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectControlledSdk } from "./loader.ts";

const sdkDirectory = process.argv[2];
if (!sdkDirectory)
	throw new Error("Usage: node native/computer/controlled/typecheck.mjs /absolute/controlled/sdk/typescript");
inspectControlledSdk(sdkDirectory); // Never load native code to check generated declarations.
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const temporary = mkdtempSync(join(tmpdir(), "computer-controlled-types-"));
try {
	const config = join(temporary, "tsconfig.json");
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
			include: [join(directory, "**/*.ts"), join(directory, "**/*.mjs")],
			// SDK composition pulls the whole coding-agent graph, whose compiler contract is tsconfig.json.
			// Check that integration separately; keep stricter generated-boundary checks on the adapter/tool.
			exclude: [join(directory, "binding.ts"), join(directory, "integration/**")],
		}),
	);
	const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", config], {
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
