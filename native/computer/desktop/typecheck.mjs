import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDesktopSdk } from "./loader.ts";

const sdk = process.argv[2];
if (!sdk) throw new Error("An absolute, verified P06 SDK directory is required");
inspectDesktopSdk(sdk); // Integrity checks only; no native import, host or TCC.
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const repository = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
const paths = Object.fromEntries(
	Object.entries(repository.compilerOptions.paths).map(([key, values]) => [
		key,
		values.map((value) => resolve(root, value)),
	]),
);
paths["@trycua/cua-driver"] = [join(sdk, "dist/computer.d.ts")];
const temporary = mkdtempSync(join(tmpdir(), "desktop-boundary-types-"));
try {
	const configurations = [
		{
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				noEmit: true,
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
				paths: { "@trycua/cua-driver": [join(sdk, "dist/computer.d.ts")] },
			},
			include: [join(directory, "**/*.ts")],
			exclude: [
				join(directory, "binding.ts"),
				join(directory, "entry.ts"),
				join(directory, "test/entry.test.ts"),
				// Real AgentSession tests use repository-wide compiler settings below.
				join(directory, "test/segment-agent.test.ts"),
				join(directory, "integration/**"),
			],
		},
		{
			extends: join(root, "tsconfig.json"),
			compilerOptions: { paths, typeRoots: [join(root, "node_modules/@types")] },
			include: [
				...repository.include.map((path) => resolve(root, path)),
				join(directory, "**/*.ts"),
				join(directory, "../browser/test/context-binding.test.ts"),
			],
			exclude: repository.exclude.map((path) => resolve(root, path)),
		},
	];
	for (const [index, config] of configurations.entries()) {
		const output = join(temporary, `${index}.json`);
		writeFileSync(output, JSON.stringify(config));
		const result = spawnSync(join(root, "node_modules/.bin/tsgo"), ["-p", output], { stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) {
			process.exitCode = result.status ?? 1;
			break;
		}
	}
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
