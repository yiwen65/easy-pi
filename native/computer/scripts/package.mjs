import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, version as esbuildVersion } from "esbuild";
import { inspectDesktopSdk } from "../desktop/loader.ts";
import pins from "../desktop/pinned-inputs.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const safeRelative = (path) => {
	if (
		typeof path !== "string" ||
		isAbsolute(path) ||
		path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
	) {
		throw new Error("Invalid Computer asset path");
	}
	return path;
};
const materialPath = (directory, path) => {
	let current = directory;
	for (const part of safeRelative(path).split("/")) {
		current = join(current, part);
		if (lstatSync(current).isSymbolicLink()) throw new Error("Computer materials must not contain symlinks");
	}
	return current;
};

/** Reviewed build materials, not a runtime/model-selected helper path. */
export function inspectRendererMaterials(materials, manifest) {
	const renderer = manifest.renderer;
	if (
		!renderer ||
		renderer.lifetimeProtocol !== 2 ||
		renderer.datagramProtocol !== 1 ||
		manifest.computerFeatureVersion !== 2 ||
		typeof renderer.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(renderer.sha256) ||
		!Array.isArray(renderer.sourcePaths) ||
		renderer.sourcePaths.length === 0 ||
		typeof renderer.compiler !== "string" ||
		!renderer.compiler.trim()
	)
		throw new Error("Missing matched renderer v2 build materials");
	for (const path of [renderer.helperPath, renderer.buildPath, renderer.licensePath, ...renderer.sourcePaths]) {
		const file = materialPath(materials, path);
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || sha(file) !== manifest.files?.[path])
			throw new Error(`Computer renderer material drift: ${path}`);
	}
	const helper = materialPath(materials, renderer.helperPath);
	if (sha(helper) !== renderer.sha256 || !(lstatSync(helper).mode & 0o111))
		throw new Error("Computer renderer helper hash/executable mismatch");
	return { ...renderer, helper };
}

/** Build-time only. No native import, Rust compilation, network, npm scripts or installation hooks. */
export async function packageComputer({ sdkDirectory, materialsDirectory, outputDirectory }) {
	for (const path of [sdkDirectory, materialsDirectory, outputDirectory]) {
		if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Computer packaging paths must be absolute");
	}
	if (existsSync(outputDirectory)) throw new Error("Computer output must be new; refusing to overwrite");
	const sdk = realpathSync(sdkDirectory);
	inspectDesktopSdk(sdk);
	const require = createRequire(pathToFileURL(join(sdk, "dist/native/node-runtime.js")));
	const core = dirname(dirname(dirname(realpathSync(require.resolve("@ubjs/core")))));
	const node = dirname(dirname(dirname(realpathSync(require.resolve("@ubjs/node/typescript/dist/resolve-lib.js")))));
	const platformName = `@trycua/cua-driver-${pins.platform}-${pins.arch}`;
	const platform = dirname(realpathSync(require.resolve(`${platformName}/package.json`)));
	const materials = realpathSync(materialsDirectory);
	const sourceManifest = JSON.parse(readFileSync(join(materials, "manifest.json"), "utf8"));
	if (
		sourceManifest.patchSha256 !== pins.patchSha256 ||
		sourceManifest.librarySha256 !== sha(join(platform, "libcua_driver_sdk.dylib")) ||
		sourceManifest.nodeRuntimeSha256 !== sha(join(platform, "cua_driver_node_runtime.node"))
	)
		throw new Error("Computer source materials do not describe the selected native build");
	for (const required of [
		"licenses/Cua-MIT.md",
		"licenses/MPL-2.0.txt",
		"NOTICE.md",
		"sources/ubrn/runtime/napi/src/call/mod.rs",
		"sources/ubrn/runtime/napi/src/register/mod.rs",
	]) {
		if (typeof sourceManifest.files?.[required] !== "string")
			throw new Error(`Missing Computer source/license: ${required}`);
	}
	for (const [path, digest] of Object.entries(sourceManifest.files)) {
		const file = materialPath(materials, path);
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Invalid Computer material file");
		if (sha(file) !== digest) throw new Error(`Computer material drift: ${path}`);
	}
	const renderer = inspectRendererMaterials(materials, sourceManifest);

	mkdirSync(dirname(outputDirectory), { recursive: true });
	mkdirSync(outputDirectory);
	const files = {};
	let bytes = 0;
	const copy = (source, destination) => {
		safeRelative(destination);
		const stat = lstatSync(source);
		if (stat.isSymbolicLink()) throw new Error(`Computer asset symlink is not allowed: ${source}`);
		if (stat.isDirectory()) {
			for (const name of readdirSync(source).sort()) copy(join(source, name), `${destination}/${name}`);
			return;
		}
		if (!stat.isFile()) throw new Error("Computer assets must be regular files");
		bytes += stat.size;
		if (bytes > 512 * 1024 * 1024 || Object.keys(files).length >= 16384)
			throw new Error("Computer asset budget exceeded");
		const path = join(outputDirectory, destination);
		mkdirSync(dirname(path), { recursive: true });
		copyFileSync(source, path);
		files[destination] = sha(path);
	};
	for (const path of pins.sdk.paths) copy(join(sdk, path), `sdk/${path}`);
	// CJS is retained for Node's require.resolve branch; generated SDK execution uses ESM.
	for (const path of ["package.json", "dist", "src", "README.md"])
		copy(join(core, path), `sdk/node_modules/@ubjs/core/${path}`);
	for (const path of pins.node.paths) copy(join(node, path), `sdk/node_modules/@ubjs/node/${path}`);
	for (const path of pins.platformFiles.paths) copy(join(platform, path), `sdk/node_modules/${platformName}/${path}`);
	for (const [path, digest] of Object.entries(sourceManifest.files)) {
		copy(materialPath(materials, path), `materials/${path}`);
		if (files[`materials/${path}`] !== digest) throw new Error(`Computer material changed during copying: ${path}`);
	}
	copy(join(materials, "manifest.json"), "materials/manifest.json");
	copy(join(root, "LICENSE"), "LICENSE.easy-pi");
	copy(renderer.helper, "renderer/computer-renderer");
	chmodSync(join(outputDirectory, "renderer/computer-renderer"), 0o755);
	if (files["renderer/computer-renderer"] !== renderer.sha256)
		throw new Error("Computer renderer changed during copy");
	const hostModules = new Map([
		[join(root, "packages/coding-agent/src/core/computer/host.ts"), "../dist/core/computer/host.js"],
		[join(root, "packages/coding-agent/src/core/computer/binding.ts"), "../dist/core/computer/binding.js"],
	]);
	const result = await build({
		absWorkingDir: root,
		entryPoints: ["native/computer/desktop/entry.ts"],
		outfile: join(outputDirectory, "bridge.js"),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		packages: "external",
		metafile: true,
		define: { COMPUTER_RENDERER_SHA256: JSON.stringify(renderer.sha256) },
		plugins: [
			{
				name: "computer-installed-host-identity",
				setup(builder) {
					builder.onResolve({ filter: /^(?:@earendil-works\/|typebox(?:\/|$))/ }, (args) => ({
						path: args.path,
						external: true,
					}));
					builder.onResolve({ filter: /^\./ }, (args) => {
						const target = hostModules.get(resolve(args.resolveDir, args.path));
						return target ? { path: target, external: true } : undefined;
					});
				},
			},
		],
	});
	if (result.warnings.length) throw new Error("Computer bundle has unreviewed warnings");
	for (const path of Object.keys(result.metafile.inputs)) {
		if (!path.startsWith("native/computer/"))
			throw new Error(`Computer bundle duplicated host/runtime code: ${path}`);
	}
	const allowedImports = new Set([
		...hostModules.values(),
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"typebox",
		"typebox/value",
	]);
	for (const output of Object.values(result.metafile.outputs)) {
		for (const item of output.imports) {
			if (!item.path.startsWith("node:") && !allowedImports.has(item.path))
				throw new Error(`Unexpected Computer runtime dependency: ${item.path}`);
		}
	}
	const product = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));
	writeFileSync(
		join(outputDirectory, "package.json"),
		`${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
	);
	for (const path of ["bridge.js", "package.json"]) files[path] = sha(join(outputDirectory, path));
	const manifest = {
		computerFeatureVersion: 2,
		renderer: { ...sourceManifest.renderer, installedPath: "renderer/computer-renderer" },
		productVersion: product.version,
		productRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
		workingTreeSources: true,
		buildTools: { esbuild: esbuildVersion, node: process.versions.node, rust: sourceManifest.compiler },
		builderSha256: sha(fileURLToPath(import.meta.url)),
		hostSourceInputs: Object.fromEntries(
			[...hostModules.keys()].map((path) => [path.slice(root.length + 1), sha(path)]),
		),
		native: pins,
		placement: "<installed coding-agent package>/computer",
		sourceInputs: Object.fromEntries(
			Object.keys(result.metafile.inputs)
				.sort()
				.map((path) => [path, sha(join(root, path))]),
		),
		externalHostModules: [...hostModules.values()],
		files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
	};
	writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	// Verify the assembled SDK itself, not only the original source directory.
	inspectDesktopSdk(join(outputDirectory, "sdk"));
	return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const values = new Map();
	for (let i = 2; i < process.argv.length; i += 2) {
		const name = process.argv[i];
		if (!["--sdk", "--materials", "--out"].includes(name) || values.has(name) || !process.argv[i + 1])
			throw new Error("Usage: package.mjs --sdk <absolute> --materials <absolute> --out <new absolute directory>");
		values.set(name, process.argv[i + 1]);
	}
	const manifest = await packageComputer({
		sdkDirectory: values.get("--sdk"),
		materialsDirectory: values.get("--materials"),
		outputDirectory: values.get("--out"),
	});
	console.log(
		JSON.stringify({
			files: Object.keys(manifest.files).length,
			platform: manifest.native.platform,
			arch: manifest.native.arch,
			node: manifest.native.nodeVersion,
			nativeLoaded: false,
		}),
	);
}
