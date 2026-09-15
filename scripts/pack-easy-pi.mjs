#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
if (process.argv.length > 3) throw new Error("Usage: node scripts/pack-easy-pi.mjs [new-output-directory]");
// Never replace caller-owned paths, including existing directories or symlinks.
const output = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "easy-pi-pack-"));
if (process.argv[2]) mkdirSync(output);
const product = join(root, "packages/coding-agent");
const internal = [
	["packages/ai", "@earendil-works/pi-ai"],
	["packages/agent", "@earendil-works/pi-agent-core"],
	["packages/client", "@earendil-works/pi-client"],
	["packages/grok-tui", "@easy-pi/grok-tui"],
	["packages/protocol", "@earendil-works/pi-protocol"],
	["packages/server", "@earendil-works/pi-server"],
	["packages/tui", "@earendil-works/pi-tui"],
	["packages/telemetry", "@earendil-works/pi-telemetry"],
	["packages/permissions", "@easy-pi/permissions"],
	["packages/subagent", "@easy-pi/subagent"],
	["packages/pi-web-search", "@easy-pi/web-search"],
];

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.status !== 0) throw new Error(`${command} failed`);
}
function destinationFor(name) {
	return join(output, "node_modules", ...name.split("/"));
}

mkdirSync(join(output, "node_modules"), { recursive: true });
// The product build is intentionally run separately; this script only packages its output.
if (!existsSync(join(product, "dist/cli.js"))) throw new Error("coding-agent/dist is missing; run npm run build first");
// Do not traverse source, tests, credentials, or workspace node_modules.
for (const name of ["package.json", "dist", "docs", "examples", "README.md", "CHANGELOG.md", "npm-shrinkwrap.json"]) {
	cpSync(join(product, name), join(output, name), { recursive: true });
}
cpSync(join(root, "LICENSE"), join(output, "LICENSE"));

const bundleNames = [];
const bundledExternalDependencies = {};
for (const [directory, name] of internal) {
	const source = join(root, directory);
	const target = destinationFor(name);
	if (!existsSync(join(source, "dist"))) throw new Error(`${directory}/dist is missing`);
	mkdirSync(target, { recursive: true });
	const manifest = readJson(join(source, "package.json"));
	writeFileSync(join(target, "package.json"), `${JSON.stringify({ ...manifest, private: undefined }, null, "\t")}\n`);
	cpSync(join(root, "LICENSE"), join(target, "LICENSE"));
	cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
	bundleNames.push(name);
	for (const [dependency, version] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
		if (!internal.some(([, internalName]) => internalName === dependency)) {
			bundledExternalDependencies[dependency] ??= version;
		}
	}
}

const manifestPath = join(output, "package.json");
const manifest = readJson(manifestPath);
manifest.name = "easy-pi";
const version = process.env.EASY_PI_VERSION ?? "0.1.0-beta.1";
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid EASY_PI_VERSION: ${version}`);
manifest.version = version;
manifest.bin = { epi: "dist/cli.js" };
manifest.repository = { type: "git", url: "git+https://github.com/yiwen65/easy-pi.git" };
manifest.bugs = { url: "https://github.com/yiwen65/easy-pi/issues" };
manifest.homepage = "https://github.com/yiwen65/easy-pi";
manifest.bundleDependencies = bundleNames;
writeFileSync(join(output, "README.md"), "# easy-pi\n\nNative AI coding agent CLI.\n\n```bash\nnpm install -g easy-pi\nepi\n```\n");
manifest.dependencies = { ...manifest.dependencies, ...bundledExternalDependencies };
delete manifest.devDependencies;
delete manifest.scripts;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
run("npm", ["pack", "--ignore-scripts", "--pack-destination", output], output);
console.log(`Packed easy-pi in ${output}`);
