import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./pack-easy-pi.mjs", import.meta.url));

for (const useLink of [false, true]) {
	test(`refuses existing output ${useLink ? "symlink" : "directory"} without deleting contents`, () => {
		const directory = mkdtempSync(join(tmpdir(), "epi-pack-safety-"));
		try {
			const sentinel = join(directory, "keep.txt");
			writeFileSync(sentinel, "caller-owned");
			const output = useLink ? join(directory, "link") : directory;
			if (useLink) symlinkSync(directory, output, "dir");
			const result = spawnSync(process.execPath, [script, output], { encoding: "utf8" });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /EEXIST/);
			assert.equal(readFileSync(sentinel, "utf8"), "caller-owned");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("standalone package includes the built-in web-search package without source or user extensions", () => {
	const directory = mkdtempSync(join(tmpdir(), "epi-pack-web-"));
	const repository = fileURLToPath(new URL("../", import.meta.url));
	const fixture = join(directory, "repo");
	const home = join(directory, "home");
	const internal = ["ai", "agent", "client", "grok-tui", "protocol", "server", "tui", "telemetry", "permissions", "subagent", "pi-web-search"];
	const env = { PATH: process.env.PATH, HOME: home, npm_config_offline: "true", npm_config_ignore_scripts: "true" };
	try {
		mkdirSync(home);
		mkdirSync(join(fixture, "scripts"), { recursive: true });
		copyFileSync(script, join(fixture, "scripts/pack-easy-pi.mjs"));
		copyFileSync(join(repository, "LICENSE"), join(fixture, "LICENSE"));
		for (const name of [...internal, "coding-agent"]) {
			const target = join(fixture, "packages", name);
			mkdirSync(join(target, "dist"), { recursive: true });
			copyFileSync(join(repository, "packages", name, "package.json"), join(target, "package.json"));
			writeFileSync(join(target, "dist/index.js"), "export default function fixture() {}\n");
		}
		const product = join(fixture, "packages/coding-agent");
		for (const name of ["docs", "examples"]) mkdirSync(join(product, name));
		for (const name of ["README.md", "CHANGELOG.md"]) writeFileSync(join(product, name), "Fixture\n");
		copyFileSync(join(repository, "packages/coding-agent/npm-shrinkwrap.json"), join(product, "npm-shrinkwrap.json"));
		writeFileSync(join(product, "dist/cli.js"), "// fixture CLI\n");
		const web = join(fixture, "packages/pi-web-search");
		for (const name of ["browser", "network"]) writeFileSync(join(web, "dist", `${name}.js`), "// compiled fixture\n");
		mkdirSync(join(web, "src"));
		writeFileSync(join(web, "src/index.ts"), "// source must not ship\n");
		const output = join(directory, "output");
		const result = spawnSync(process.execPath, [join(fixture, "scripts/pack-easy-pi.mjs"), output], {
			cwd: directory, env, encoding: "utf8", timeout: 30000,
		});
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
		const webManifest = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
		assert.equal(manifest.dependencies["@easy-pi/web-search"], webManifest.version);
		assert.ok(manifest.bundleDependencies.includes("@easy-pi/web-search"));
		const tarball = readdirSync(output).find(name => name.endsWith(".tgz"));
		assert.ok(tarball);
		const archive = spawnSync("tar", ["-tf", join(output, tarball)], { encoding: "utf8", env });
		assert.equal(archive.status, 0, archive.stderr);
		for (const name of ["index", "browser", "network"]) {
			assert.ok(archive.stdout.includes(`package/node_modules/@easy-pi/web-search/dist/${name}.js`));
		}
		assert.ok(archive.stdout.includes("package/node_modules/@easy-pi/web-search/package.json"));
		assert.doesNotMatch(archive.stdout, /web-search\/src\/|\.epi\/|extensions\/web-search/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
