import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const internal = {
	ai: "@earendil-works/pi-ai", agent: "@earendil-works/pi-agent-core", mcp: "@earendil-works/pi-mcp",
	codemode: "@earendil-works/pi-codemode", client: "@earendil-works/pi-client", "grok-tui": "@easy-pi/grok-tui",
	protocol: "@earendil-works/pi-protocol", server: "@earendil-works/pi-server", tui: "@earendil-works/pi-tui",
	telemetry: "@earendil-works/pi-telemetry", permissions: "@easy-pi/permissions", subagent: "@easy-pi/subagent",
	"pi-web-search": "@easy-pi/web-search",
};

function json(path, value) { writeFileSync(path, `${JSON.stringify(value)}\n`); }

for (const globalInstall of [false, true]) {
	test(`${globalInstall ? "global" : "local"} registry installation resolves bundled dependencies and runs install scripts`, { timeout: 60000 }, async () => {
		const directory = mkdtempSync(join(tmpdir(), "epi-registry-install-"));
		const fixture = join(directory, "repo");
		const output = join(directory, "packed");
		const consumer = join(directory, "consumer");
		const dependency = "epi-registry-fixture-dep";
		let server;
		try {
			mkdirSync(join(fixture, "scripts"), { recursive: true });
			copyFileSync(join(repository, "scripts/pack-easy-pi.mjs"), join(fixture, "scripts/pack-easy-pi.mjs"));
			copyFileSync(join(repository, "LICENSE"), join(fixture, "LICENSE"));
			const dependencies = { [dependency]: "1.0.0" };
			const packages = {};
			for (const [folder, name] of Object.entries(internal)) {
				const target = join(fixture, "packages", folder);
				mkdirSync(join(target, "dist"), { recursive: true });
				const manifest = { name, version: "0.84.2", type: "module", main: "dist/index.js", dependencies: folder === "subagent" ? { [dependency]: "1.0.0" } : {} };
				json(join(target, "package.json"), manifest);
				writeFileSync(join(target, "dist/index.js"), folder === "subagent" ? `export { default } from "${dependency}";\n` : "export default true;\n");
				dependencies[name] = "^0.84.2";
				packages[`node_modules/${name}`] = { ...manifest, inBundle: true };
			}
			const product = join(fixture, "packages/coding-agent");
			mkdirSync(join(product, "dist"), { recursive: true });
			for (const name of ["docs", "examples"]) mkdirSync(join(product, name));
			for (const name of ["README.md", "CHANGELOG.md"]) writeFileSync(join(product, name), "Fixture\n");
			const manifest = { name: "@earendil-works/pi-coding-agent", version: "0.84.2", type: "module", dependencies, bundleDependencies: ["@easy-pi/subagent"], files: ["dist", "npm-shrinkwrap.json"] };
			json(join(product, "package.json"), manifest);
			writeFileSync(join(product, "dist/cli.js"), `#!/usr/bin/env node\nimport dep from "${dependency}";\nimport bundled from "@easy-pi/subagent";\nif (dep !== "resolved" || bundled !== dep) throw Error("unresolved dependency");\nconsole.log("registry-install-ok");\n`);
			packages[`node_modules/${dependency}`] = { version: "1.0.0", resolved: `https://registry.npmjs.org/${dependency}/-/${dependency}-1.0.0.tgz` };
			json(join(product, "npm-shrinkwrap.json"), { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: { "": manifest, ...packages } });

			const external = join(directory, "external");
			mkdirSync(join(external, "package/scripts"), { recursive: true });
			const externalManifest = { name: dependency, version: "1.0.0", type: "module", main: "index.js", scripts: { postinstall: "node scripts/postinstall.js" } };
			json(join(external, "package/package.json"), externalManifest);
			writeFileSync(join(external, "package/index.js"), 'export default "resolved";\n');
			writeFileSync(join(external, "package/scripts/postinstall.js"), 'import { writeFileSync } from "node:fs"; writeFileSync(new URL("./ran", import.meta.url), "ok");\n');
			execFileSync("tar", ["-czf", join(external, "dep.tgz"), "-C", external, "package"]);
			const externalTarball = readFileSync(join(external, "dep.tgz"));
			let tarball;
			let packedManifest;
			let entries;
			server = createServer((request, response) => {
				const origin = `http://127.0.0.1:${server.address().port}`;
				response.setHeader("Content-Type", "application/json");
				if (request.url === "/easy-pi.tgz" && tarball) return response.end(tarball);
				if (request.url === "/dep.tgz") return response.end(externalTarball);
				if (request.url === "/easy-pi" && packedManifest) return response.end(JSON.stringify({ name: "easy-pi", "dist-tags": { beta: packedManifest.version }, versions: { [packedManifest.version]: { ...packedManifest, _hasShrinkwrap: entries.includes("package/npm-shrinkwrap.json"), dist: { tarball: `${origin}/easy-pi.tgz` } } } }));
				if (request.url === `/${dependency}`) return response.end(JSON.stringify({ name: dependency, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { ...externalManifest, dist: { tarball: `${origin}/dep.tgz` } } } }));
				response.statusCode = 404;
				response.end(JSON.stringify({ error: `Unexpected registry request: ${request.url}` }));
			});
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			const registry = `http://127.0.0.1:${server.address().port}`;
			const userconfig = join(directory, "npmrc");
			writeFileSync(userconfig, "");
			const env = { ...process.env, NODE_PATH: "", npm_config_userconfig: userconfig, npm_config_cache: join(directory, "cache"), npm_config_registry: registry, EASY_PI_VERSION: "0.1.0-beta.3" };
			await execute(process.execPath, [join(fixture, "scripts/pack-easy-pi.mjs"), output], { cwd: directory, env, maxBuffer: 1024 * 1024 });
			tarball = readFileSync(join(output, readdirSync(output).find((name) => name.endsWith(".tgz"))));
			packedManifest = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
			entries = execFileSync("tar", ["-tf", join(output, `easy-pi-${packedManifest.version}.tgz`)], { encoding: "utf8" });
			for (const name of Object.values(internal)) assert.equal(packedManifest.dependencies[name], "0.84.2");
			assert.ok(entries.includes(`package/node_modules/${dependency}/scripts/postinstall.js`));
			// Packaging must not run third-party lifecycle scripts.
			assert.ok(!entries.includes(`package/node_modules/${dependency}/scripts/ran`));
			mkdirSync(consumer);
			json(join(consumer, "package.json"), { name: "registry-consumer", version: "1.0.0", private: true });
			// Only our loopback fixture's script runs, writing a marker in this private temp directory.
			await execute("npm", ["install", "easy-pi@beta", ...(globalInstall ? ["--global", "--prefix", consumer] : []), "--no-audit", "--no-fund", "--registry", registry], { cwd: consumer, env: { ...env, npm_config_ignore_scripts: "false" } });
			const installed = join(consumer, globalInstall ? "lib/node_modules/easy-pi" : "node_modules/easy-pi");
			const result = await execute(process.execPath, [join(installed, "dist/cli.js")], { cwd: consumer, env });
			assert.equal(result.stdout.trim(), "registry-install-ok");
			const dependencyManifest = createRequire(join(installed, "package.json")).resolve(`${dependency}/package.json`);
			assert.equal(readFileSync(join(dirname(dependencyManifest), "scripts/ran"), "utf8"), "ok");
			assert.ok(!entries.includes("package/npm-shrinkwrap.json"));
			assert.ok(!packedManifest.files.includes("npm-shrinkwrap.json"));
		} finally {
			if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
