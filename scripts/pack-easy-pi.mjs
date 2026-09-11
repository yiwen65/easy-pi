#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const output = resolve(process.argv[2] ?? join(tmpdir(), "easy-pi-pack-"));
const product = join(root, "packages/coding-agent");
const internal = [
	["packages/ai", "@earendil-works/pi-ai"],
	["packages/agent", "@earendil-works/pi-agent-core"],
	["packages/client", "@earendil-works/pi-client"],
	["packages/grok-tui", "@earendil-works/pi-grok-tui"],
	["packages/protocol", "@earendil-works/pi-protocol"],
	["packages/server", "@earendil-works/pi-server"],
	["packages/tui", "@earendil-works/pi-tui"],
	["packages/telemetry", "@earendil-works/pi-telemetry"],
	["packages/permissions", "@easy-pi/permissions"],
	["packages/subagent", "@easy-pi/subagent"],
];

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.status !== 0) throw new Error(`${command} failed`);
}
function destinationFor(name) {
	return join(output, "node_modules", ...name.split("/"));
}

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "node_modules"), { recursive: true });
cpSync(product, output, { recursive: true, filter: (source) => !source.includes("/node_modules/") && !source.endsWith("/dist") });
// The product build is intentionally run separately; this script only packages its output.
if (!existsSync(join(product, "dist/cli.js"))) throw new Error("coding-agent/dist is missing; run npm run build first");
rmSync(join(output, "dist"), { recursive: true, force: true });
cpSync(join(product, "dist"), join(output, "dist"), { recursive: true });

const bundleNames = [];
for (const [directory, name] of internal) {
	const source = join(root, directory);
	const target = destinationFor(name);
	if (!existsSync(join(source, "dist"))) throw new Error(`${directory}/dist is missing`);
	mkdirSync(target, { recursive: true });
	const manifest = readJson(join(source, "package.json"));
	writeFileSync(join(target, "package.json"), `${JSON.stringify({ ...manifest, private: undefined }, null, "\t").replace(/,\n\t\t"private": undefined/, "")}\n`);
	cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
	bundleNames.push(name);
}

const manifestPath = join(output, "package.json");
const manifest = readJson(manifestPath);
manifest.name = "easy-pi";
manifest.version = "0.1.0-beta.1";
manifest.bin = { epi: "dist/cli.js" };
manifest.repository = { type: "git", url: "git+https://github.com/yiwen65/easy-pi.git" };
manifest.bugs = { url: "https://github.com/yiwen65/easy-pi/issues" };
manifest.homepage = "https://github.com/yiwen65/easy-pi";
manifest.bundleDependencies = bundleNames;
delete manifest.devDependencies;
delete manifest.scripts;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
run("npm", ["pack", "--ignore-scripts", "--pack-destination", output], output);
console.log(`Packed easy-pi in ${output}`);
